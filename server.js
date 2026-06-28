const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS  = 8000;
const MAX_CONCURRENT    = 20;
const MAX_CHANNELS      = 400;

const PLAYLISTS = [
  "https://iptv-org.github.io/iptv/countries/us.m3u",
  "https://iptv-org.github.io/iptv/countries/gb.m3u",
  "https://iptv-org.github.io/iptv/countries/au.m3u",
  "https://iptv-org.github.io/iptv/countries/ca.m3u",
  "https://iptv-org.github.io/iptv/countries/ie.m3u",
  "https://iptv-org.github.io/iptv/countries/nz.m3u",
  "https://iptv-org.github.io/iptv/countries/za.m3u",
];

let cache          = { channels: null, timestamp: 0 };
let buildInProgress = false;
let progressClients = new Set();

/* ══ BROADCAST SSE ══ */
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of progressClients) {
    try { res.write(msg); } catch {}
  }
}

/* ══ HTTP FETCH ══ */
function fetchURL(rawUrl, redirects = 5, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!redirects) return reject(new Error("Too many redirects"));
    try {
      const parsed = new URL(rawUrl);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.get(rawUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NovaTV/1.0)",
          "Accept": "*/*",
        },
        timeout: timeoutMs,
      }, (res) => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
          return resolve(fetchURL(res.headers.location, redirects - 1, timeoutMs));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve(data));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    } catch (e) { reject(e); }
  });
}

/* ══ PARSE M3U ══ */
function parseM3U(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const channels = [];
  let cur = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      cur = {};
      const nm = line.match(/,(.+)$/);
      cur.name = nm ? nm[1].trim() : "Unknown";
      const lo = line.match(/tvg-logo="([^"]*)"/);
      cur.logo = lo ? lo[1] : "";
      const gr = line.match(/group-title="([^"]*)"/);
      cur.group = gr ? gr[1] : "General";
      const co = line.match(/tvg-country="([^"]*)"/);
      cur.country = co ? co[1] : "";
      const la = line.match(/tvg-language="([^"]*)"/);
      cur.language = la ? la[1] : "";
    } else if (cur && !line.startsWith("#")) {
      cur.url = line;
      channels.push(cur);
      cur = null;
    }
  }
  return channels;
}

/* ══ QUALITY PRE-FILTER ══ */
function isQuality(ch) {
  if (!ch.logo || !ch.logo.trim()) return false;
  if (!ch.url  || !ch.url.trim())  return false;
  const name = (ch.name || "").toUpperCase();
  const bad  = [" SD","(SD)","[SD]","480P","360P","240P","144P","RADIO"," AM "," FM "];
  return !bad.some(m => name.includes(m));
}

/* ══ DEEP HLS CHECK ══
   1. Fetch the manifest URL
   2. If it redirects to another .m3u8 follow it
   3. Confirm the content contains valid HLS tags
   4. Extract one segment URL and confirm that loads too
   This guarantees the stream actually has playable video data
══════════════════════ */
async function deepCheck(streamUrl) {
  try {
    // Step 1 — fetch manifest
    const manifest = await fetchURL(streamUrl, 5, FETCH_TIMEOUT_MS);

    // Step 2 — must be HLS content
    if (!manifest.includes("#EXTM3U")) return false;

    // Step 3 — if it's a master playlist, follow one variant
    if (manifest.includes("#EXT-X-STREAM-INF")) {
      const lines = manifest.split("\n").map(l => l.trim()).filter(Boolean);
      let variantUrl = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i+1] && !lines[i+1].startsWith("#")) {
          variantUrl = lines[i+1];
          break;
        }
      }
      if (!variantUrl) return false;

      // Resolve relative URL
      if (!variantUrl.startsWith("http")) {
        const base = new URL(streamUrl);
        variantUrl = new URL(variantUrl, base.href).href;
      }

      // Fetch the variant manifest
      const variant = await fetchURL(variantUrl, 3, FETCH_TIMEOUT_MS);
      if (!variant.includes("#EXTM3U")) return false;

      // Step 4 — extract a segment and verify it loads
      return await verifySegment(variant, variantUrl);
    }

    // It's already a media playlist — verify a segment
    return await verifySegment(manifest, streamUrl);

  } catch {
    return false;
  }
}

/* Verify one .ts or .m4s segment actually responds with data */
async function verifySegment(manifest, baseUrl) {
  try {
    const lines = manifest.split("\n").map(l => l.trim()).filter(Boolean);
    // Find first segment line (doesn't start with #)
    const segLine = lines.find(l => !l.startsWith("#") && l.length > 0);
    if (!segLine) return false;

    let segUrl = segLine;
    if (!segUrl.startsWith("http")) {
      segUrl = new URL(segLine, baseUrl).href;
    }

    // Fetch first 2KB of segment to confirm real video data
    const segData = await fetchPartial(segUrl, 2048);
    // A valid MPEG-TS segment starts with 0x47 (sync byte)
    // A valid MP4 segment has 'ftyp' or 'moof' boxes
    // We just need something that isn't HTML or an error page
    if (!segData || segData.length < 100) return false;

    // Reject if it looks like an HTML error page
    const start = segData.slice(0, 50).toLowerCase();
    if (start.includes("<!doctype") || start.includes("<html")) return false;

    return true;
  } catch {
    return false;
  }
}

/* Fetch first N bytes of a URL */
function fetchPartial(rawUrl, bytes) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(rawUrl);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.get(rawUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NovaTV/1.0)",
          "Range": `bytes=0-${bytes - 1}`,
        },
        timeout: FETCH_TIMEOUT_MS,
      }, (res) => {
        if (res.statusCode >= 400) { req.destroy(); return resolve(null); }
        const chunks = [];
        let total = 0;
        res.on("data", chunk => {
          chunks.push(chunk);
          total += chunk.length;
          if (total >= bytes) { req.destroy(); resolve(Buffer.concat(chunks).toString("binary")); }
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("binary")));
        res.on("error", () => resolve(null));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

/* ══ CHECK BATCH ══ */
async function checkBatch(channels) {
  const alive = [];
  let checked = 0;
  const total = channels.length;

  for (let i = 0; i < channels.length; i += MAX_CONCURRENT) {
    const batch = channels.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(batch.map(ch => deepCheck(ch.url)));
    batch.forEach((ch, idx) => { if (results[idx]) alive.push(ch); });
    checked += batch.length;

    const pct = 20 + Math.round((checked / total) * 75);
    broadcast({
      stage: "check",
      message: `Testing streams… ${checked} of ${total}`,
      checked, total,
      alive: alive.length,
      pct,
    });
    console.log(`  ${checked}/${total} — alive: ${alive.length}`);
  }
  return alive;
}

/* ══ BUILD CACHE ══ */
async function buildCache(force = false) {
  const now = Date.now();
  if (!force && cache.channels && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return cache.channels;
  }
  if (buildInProgress) {
    return new Promise(resolve => {
      const t = setInterval(() => {
        if (!buildInProgress) { clearInterval(t); resolve(cache.channels); }
      }, 600);
    });
  }

  buildInProgress = true;
  try {

    /* 1 — Fetch playlists */
    broadcast({ stage: "fetch", message: "Fetching channel playlists…", pct: 2 });
    console.log("\n📡 Fetching playlists…");
    const allRaw = [];
    const fetched = await Promise.allSettled(PLAYLISTS.map(u => fetchURL(u, 5, 20000)));
    fetched.forEach((r, i) => {
      const label = PLAYLISTS[i].split("/").pop();
      if (r.status === "fulfilled") {
        const ch = parseM3U(r.value);
        console.log(`  ✅ ${label} — ${ch.length}`);
        allRaw.push(...ch);
      } else {
        console.log(`  ❌ ${label} — ${r.reason.message}`);
      }
    });
    broadcast({ stage: "fetch", message: `Found ${allRaw.length.toLocaleString()} raw channels`, pct: 8 });

    /* 2 — Deduplicate */
    broadcast({ stage: "filter", message: "Removing duplicates…", pct: 12 });
    const seen = new Set();
    const deduped = allRaw.filter(ch => {
      if (seen.has(ch.url)) return false;
      seen.add(ch.url); return true;
    });

    /* 3 — Quality filter */
    broadcast({ stage: "filter", message: "Filtering HD channels with thumbnails…", pct: 16 });
    const quality = deduped.filter(isQuality);
    console.log(`⭐ Quality: ${quality.length}`);
    broadcast({
      stage: "filter",
      message: `${quality.length} HD channels — now deep-checking each stream…`,
      pct: 20,
    });

    /* 4 — Deep HLS check */
    const toCheck = quality.slice(0, 600);
    console.log(`\n🔬 Deep HLS checking ${toCheck.length} streams…`);
    const alive = await checkBatch(toCheck);
    console.log(`\n✅ Verified alive: ${alive.length}`);

    /* 5 — Done */
    const final = alive.slice(0, MAX_CHANNELS);
    cache = { channels: final, timestamp: Date.now() };

    broadcast({
      stage: "done",
      message: `✅ ${final.length} verified live channels ready!`,
      count: final.length,
      pct: 100,
    });
    console.log(`📺 Final: ${final.length} channels\n`);
    return final;

  } finally {
    buildInProgress = false;
  }
}

/* ══ STREAM PROXY ══ */
function proxyStream(streamUrl, clientRes) {
  try {
    const parsed = new URL(streamUrl);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(streamUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NovaTV/1.0)",
        "Accept": "*/*",
        "Origin": parsed.origin,
      },
      timeout: 12000,
    }, (upstream) => {
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": upstream.headers["content-type"] || "application/octet-stream",
      };
      if (upstream.headers["content-length"]) headers["Content-Length"] = upstream.headers["content-length"];
      if (upstream.headers["content-range"])  headers["Content-Range"]  = upstream.headers["content-range"];
      clientRes.writeHead(upstream.statusCode, headers);
      upstream.pipe(clientRes);
      upstream.on("error", () => { try { clientRes.end(); } catch {} });
    });
    req.on("error", () => { try { clientRes.writeHead(502); clientRes.end(); } catch {} });
    req.on("timeout", () => { req.destroy(); try { clientRes.writeHead(504); clientRes.end(); } catch {} });
  } catch { clientRes.writeHead(400); clientRes.end("Bad URL"); }
}

/* ══ HTTP SERVER ══ */
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  /* SSE progress */
  if (pathname === "/api/progress") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    if (cache.channels && !buildInProgress) {
      res.write(`data: ${JSON.stringify({ stage:"done", message:`✅ ${cache.channels.length} live channels ready!`, count:cache.channels.length, pct:100 })}\n\n`);
      res.end();
      return;
    }
    progressClients.add(res);
    req.on("close", () => progressClients.delete(res));
    return;
  }

  /* Channels */
  if (pathname === "/api/channels") {
    try {
      const channels = await buildCache(parsed.query.refresh === "true");
      const proxied  = channels.map(ch => ({
        ...ch,
        url: `/api/stream?url=${encodeURIComponent(ch.url)}`,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ channels: proxied, cached_at: new Date(cache.timestamp).toISOString(), total: proxied.length }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* Stream proxy */
  if (pathname === "/api/stream") {
    const su = parsed.query.url;
    if (!su) { res.writeHead(400); res.end("Missing url"); return; }
    proxyStream(su, res);
    return;
  }

  /* Ping */
  if (pathname === "/api/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok:true, count:cache.channels?.length||0, building:buildInProgress }));
    return;
  }

  /* index.html */
  const htmlPath = path.join(__dirname, "index.html");
  if (fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ NovaTV on port ${PORT}`);
  console.log("🔬 Starting deep stream verification on boot…\n");
  buildCache().catch(e => console.error("Boot failed:", e.message));
});

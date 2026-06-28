const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5000;
const MAX_CONCURRENT = 30;
const MAX_CHANNELS = 500;

const PLAYLISTS = [
  "https://iptv-org.github.io/iptv/countries/us.m3u",
  "https://iptv-org.github.io/iptv/countries/gb.m3u",
  "https://iptv-org.github.io/iptv/countries/au.m3u",
  "https://iptv-org.github.io/iptv/countries/ca.m3u",
  "https://iptv-org.github.io/iptv/countries/ie.m3u",
  "https://iptv-org.github.io/iptv/countries/nz.m3u",
  "https://iptv-org.github.io/iptv/countries/za.m3u",
];

/* ══ STATE ══ */
let cache = { channels: null, timestamp: 0 };
let buildInProgress = false;
let progressClients = new Set(); // SSE clients listening for progress

/* ══ SSE BROADCAST ══ */
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of progressClients) {
    try { res.write(msg); } catch {}
  }
}

/* ══ FETCH URL ══ */
function fetchURL(rawUrl, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (!redirects) return reject(new Error("Too many redirects"));
    try {
      const parsed = new URL(rawUrl);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.get(rawUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NovaTV/1.0)", "Accept": "*/*" },
        timeout: 14000,
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          return resolve(fetchURL(res.headers.location, redirects - 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = "";
        res.on("data", chunk => data += chunk);
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
      const nameM = line.match(/,(.+)$/);
      cur.name = nameM ? nameM[1].trim() : "Unknown";
      const logoM = line.match(/tvg-logo="([^"]*)"/);
      cur.logo = logoM ? logoM[1] : "";
      const groupM = line.match(/group-title="([^"]*)"/);
      cur.group = groupM ? groupM[1] : "General";
      const countryM = line.match(/tvg-country="([^"]*)"/);
      cur.country = countryM ? countryM[1] : "";
      const langM = line.match(/tvg-language="([^"]*)"/);
      cur.language = langM ? langM[1] : "";
    } else if (cur && !line.startsWith("#")) {
      cur.url = line;
      channels.push(cur);
      cur = null;
    }
  }
  return channels;
}

/* ══ QUALITY FILTER ══ */
function isQuality(ch) {
  if (!ch.logo || !ch.logo.trim()) return false;
  if (!ch.url || !ch.url.trim()) return false;
  const name = (ch.name || "").toUpperCase();
  const bad = [" SD", "(SD)", "[SD]", "480P", "360P", "240P", "144P", "RADIO", " AM ", " FM "];
  if (bad.some(m => name.includes(m))) return false;
  return true;
}

/* ══ SINGLE STREAM CHECK ══ */
function checkStream(streamUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(streamUrl);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request({
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NovaTV/1.0)",
          "Range": "bytes=0-1023",
        },
        timeout: CHECK_TIMEOUT_MS,
      }, (res) => {
        req.destroy();
        resolve(res.statusCode < 400 || res.statusCode === 206);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

/* ══ BUILD CACHE WITH PROGRESS ══ */
async function buildCache(force = false) {
  const now = Date.now();
  if (!force && cache.channels && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return cache.channels;
  }
  if (buildInProgress) {
    // Wait for existing build to finish
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!buildInProgress) { clearInterval(check); resolve(cache.channels); }
      }, 500);
    });
  }

  buildInProgress = true;

  try {
    // ── STEP 1: Fetching playlists ──
    broadcast({ stage: "fetch", message: "Fetching channel playlists…", pct: 2 });
    console.log("\n📡 Fetching playlists…");

    const allRaw = [];
    const results = await Promise.allSettled(PLAYLISTS.map(u => fetchURL(u)));
    results.forEach((r, i) => {
      const label = PLAYLISTS[i].split("/").pop();
      if (r.status === "fulfilled") {
        const parsed = parseM3U(r.value);
        console.log(`  ✅ ${label} — ${parsed.length} channels`);
        allRaw.push(...parsed);
      } else {
        console.log(`  ❌ ${label} — ${r.reason.message}`);
      }
    });

    broadcast({ stage: "fetch", message: `Found ${allRaw.length.toLocaleString()} raw channels`, pct: 8 });

    // ── STEP 2: Deduplicate ──
    broadcast({ stage: "filter", message: "Removing duplicates…", pct: 12 });
    const seen = new Set();
    const deduped = allRaw.filter(ch => {
      if (seen.has(ch.url)) return false;
      seen.add(ch.url); return true;
    });

    // ── STEP 3: Quality filter ──
    broadcast({ stage: "filter", message: "Filtering HD channels with thumbnails…", pct: 16 });
    const quality = deduped.filter(isQuality);
    console.log(`⭐ After quality filter: ${quality.length}`);

    broadcast({
      stage: "filter",
      message: `${quality.length} HD channels found — checking which ones are live…`,
      pct: 20,
    });

    // ── STEP 4: Health check ──
    const toCheck = quality.slice(0, 800);
    const total = toCheck.length;
    const alive = [];
    let checked = 0;

    console.log(`\n🏥 Health checking ${total} streams…`);

    for (let i = 0; i < toCheck.length; i += MAX_CONCURRENT) {
      const batch = toCheck.slice(i, i + MAX_CONCURRENT);
      const res = await Promise.all(batch.map(ch => checkStream(ch.url)));
      batch.forEach((ch, idx) => { if (res[idx]) alive.push(ch); });
      checked += batch.length;

      const pct = 20 + Math.round((checked / total) * 75);
      broadcast({
        stage: "check",
        message: `Checking streams… ${checked} of ${total} done`,
        checked,
        total,
        alive: alive.length,
        pct,
      });

      console.log(`  ${checked}/${total} checked — ${alive.length} alive`);
    }

    // ── STEP 5: Done ──
    const final = alive.slice(0, MAX_CHANNELS);
    cache = { channels: final, timestamp: Date.now() };
    console.log(`\n✅ Done — ${final.length} live channels ready\n`);

    broadcast({
      stage: "done",
      message: `✅ ${final.length} live channels ready!`,
      count: final.length,
      pct: 100,
    });

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
      },
      timeout: 10000,
    }, (upstream) => {
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": upstream.headers["content-type"] || "application/octet-stream",
      };
      if (upstream.headers["content-length"]) headers["Content-Length"] = upstream.headers["content-length"];
      if (upstream.headers["content-range"]) headers["Content-Range"] = upstream.headers["content-range"];
      clientRes.writeHead(upstream.statusCode, headers);
      upstream.pipe(clientRes);
      upstream.on("error", () => clientRes.end());
    });
    req.on("error", () => { try { clientRes.writeHead(502); clientRes.end(); } catch {} });
    req.on("timeout", () => { req.destroy(); try { clientRes.writeHead(504); clientRes.end(); } catch {} });
  } catch { clientRes.writeHead(400); clientRes.end("Bad URL"); }
}

/* ══ SERVER ══ */
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  /* ── SSE progress endpoint ── */
  if (pathname === "/api/progress") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 1000\n\n");

    // If already cached, immediately tell client we're done
    if (cache.channels && !buildInProgress) {
      res.write(`data: ${JSON.stringify({
        stage: "done",
        message: `✅ ${cache.channels.length} live channels ready!`,
        count: cache.channels.length,
        pct: 100,
      })}\n\n`);
      res.end();
      return;
    }

    // Otherwise subscribe to live progress
    progressClients.add(res);
    req.on("close", () => progressClients.delete(res));
    return;
  }

  /* ── Channels API ── */
  if (pathname === "/api/channels") {
    try {
      const force = parsed.query.refresh === "true";
      const channels = await buildCache(force);
      const proxied = channels.map(ch => ({
        ...ch,
        url: `/api/stream?url=${encodeURIComponent(ch.url)}`,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        channels: proxied,
        cached_at: new Date(cache.timestamp).toISOString(),
        total: proxied.length,
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* ── Stream proxy ── */
  if (pathname === "/api/stream") {
    const su = parsed.query.url;
    if (!su) { res.writeHead(400); res.end("Missing url"); return; }
    proxyStream(su, res);
    return;
  }

  /* ── Ping ── */
  if (pathname === "/api/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: cache.channels?.length || 0, building: buildInProgress }));
    return;
  }

  /* ── Serve index.html ── */
  const htmlPath = path.join(__dirname, "index.html");
  if (fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
  } else {
    res.writeHead(404); res.end("Not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ NovaTV running on port ${PORT}`);
  console.log("🚀 Starting channel scan on boot…\n");
  buildCache().catch(e => console.error("Boot build failed:", e.message));
});

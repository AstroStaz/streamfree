const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

// Replit uses PORT env variable
const PORT = process.env.PORT || 3000;
const PLAYLIST_URL = "https://iptv-org.github.io/iptv/index.m3u";
const CACHE_DURATION_MS = 30 * 60 * 1000;

let cache = { data: null, timestamp: 0 };

function fetchM3U() {
  return new Promise((resolve, reject) => {
    console.log("Fetching playlist from", PLAYLIST_URL);
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
      }
    };
    https.get(PLAYLIST_URL, options, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, options, (res2) => {
          let data = "";
          res2.on("data", chunk => data += chunk);
          res2.on("end", () => resolve(data));
          res2.on("error", reject);
        }).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function parseM3U(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const channels = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      current = {};
      const nameMatch = line.match(/,(.+)$/);
      current.name = nameMatch ? nameMatch[1].trim() : "Unknown";
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      current.logo = logoMatch ? logoMatch[1] : "";
      const groupMatch = line.match(/group-title="([^"]*)"/);
      current.group = groupMatch ? groupMatch[1] : "General";
      const countryMatch = line.match(/tvg-country="([^"]*)"/);
      current.country = countryMatch ? countryMatch[1] : "";
      const langMatch = line.match(/tvg-language="([^"]*)"/);
      current.language = langMatch ? langMatch[1] : "";
    } else if (current && !line.startsWith("#")) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

async function getChannels(force = false) {
  const now = Date.now();
  if (!force && cache.data && (now - cache.timestamp) < CACHE_DURATION_MS) {
    console.log(`Serving ${cache.data.length} channels from cache`);
    return cache.data;
  }
  const raw = await fetchM3U();
  const channels = parseM3U(raw);
  cache = { data: channels, timestamp: now };
  console.log(`Parsed and cached ${channels.length} channels`);
  return channels;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS — allow all origins so the browser page can call the API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/channels
  if (pathname === "/api/channels") {
    try {
      const force = parsed.query.refresh === "true";
      const channels = await getChannels(force);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        channels,
        cached_at: new Date(cache.timestamp).toISOString(),
        total: channels.length
      }));
    } catch (e) {
      console.error("Error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/check?url=... — stream health check
  if (pathname === "/api/check") {
    const streamUrl = parsed.query.url;
    if (!streamUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing url param" }));
      return;
    }
    try {
      const checkUrl = new URL(streamUrl);
      const mod = checkUrl.protocol === "https:" ? https : http;
      const checkReq = mod.request(
        {
          host: checkUrl.hostname,
          path: checkUrl.pathname + checkUrl.search,
          method: "HEAD",
          timeout: 5000,
          headers: { "User-Agent": "Mozilla/5.0" }
        },
        (checkRes) => {
          const alive = checkRes.statusCode < 500;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ alive, status: checkRes.statusCode }));
        }
      );
      checkReq.on("error", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ alive: false }));
      });
      checkReq.on("timeout", () => {
        checkReq.destroy();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ alive: false }));
      });
      checkReq.end();
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ alive: false }));
    }
    return;
  }

  // Serve index.html for all other routes
  const htmlPath = path.join(__dirname, "index.html");
  if (fs.existsSync(htmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end("index.html not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ StreamFree running on port ${PORT}`);
  console.log(`📡 Open the Replit webview to use the app`);
  console.log(`\nPress Ctrl+C to stop.\n`);
  // Pre-warm cache on startup
  getChannels().catch(e => console.error("Pre-warm failed:", e.message));
});

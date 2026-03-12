import puppeteer from "puppeteer";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import pg from "pg";

const { Client } = pg;

// Load .env manually (no extra dependency)
try {
  const env = readFileSync(new URL(".env", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim();
  }
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 7654;

const EXTENSIONS = [
  {
    id: "GitusAI.gitusai",
    label: "GitusAI",
    umamiId: "a2ea768f-d1e9-4d94-9eb0-75a572733b77",
    dbEnv: "GITUS_NEON_DB",
  },
  {
    id: "WatchAPI.watchapi-client",
    label: "WatchAPI",
    umamiId: "c58cef91-30db-49c2-9824-ba40df71c696",
    dbEnv: "WATCHAPI_DB",
  },
];

// --- Umami auth token cache ---
let umamiToken = null;
let umamiTokenExpiry = 0;

async function getUmamiToken() {
  if (umamiToken && Date.now() < umamiTokenExpiry) return umamiToken;

  const res = await fetch(`${process.env.UMAMI_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.UMAMI_USER,
      password: process.env.UMAMI_PASS,
    }),
  });
  if (!res.ok) throw new Error(`Umami login failed: ${res.status}`);
  const data = await res.json();
  umamiToken = data.token;
  umamiTokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
  return umamiToken;
}

async function fetchUmamiStats(websiteId) {
  const token = await getUmamiToken();
  const endAt = Date.now();
  const startAt = endAt - 30 * 24 * 60 * 60 * 1000; // last 30 days

  const [statsRes, sessionsRes] = await Promise.all([
    fetch(`${process.env.UMAMI_URL}/api/websites/${websiteId}/stats?startAt=${startAt}&endAt=${endAt}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`${process.env.UMAMI_URL}/api/websites/${websiteId}/sessions?startAt=${startAt}&endAt=${endAt}&pageSize=500`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (!statsRes.ok) throw new Error(`Umami stats failed: ${statsRes.status}`);
  if (!sessionsRes.ok) throw new Error(`Umami sessions failed: ${sessionsRes.status}`);

  const stats = await statsRes.json();
  const sessions = await sessionsRes.json();

  const returning = sessions.data.filter((s) => s.visits > 1).length;

  return {
    visitors: stats.visitors ?? 0,
    returning,
  };
}

// --- Postgres user count ---
async function fetchUserCount(label, connectionString) {
  if (!connectionString) return null;
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM users");
    return rows[0].count;
  } catch (err) {
    console.error(`[${label}] fetchUserCount error:`, err.message);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

// --- VS Code Marketplace ---
async function fetchMarketplaceStats() {
  const criteria = EXTENSIONS.map((e) => ({ filterType: 7, value: e.id }));
  const res = await fetch(
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json;api-version=7.2-preview.1",
      },
      body: JSON.stringify({
        filters: [{ criteria }],
        flags: 768,
      }),
    }
  );
  if (!res.ok) throw new Error(`Marketplace API error: ${res.status}`);
  const data = await res.json();

  const result = {};
  for (const ext of data.results[0].extensions) {
    const id = `${ext.publisher.publisherName}.${ext.extensionName}`;
    const stats = Object.fromEntries(
      (ext.statistics ?? []).map((s) => [s.statisticName, s.value])
    );
    result[id] = { installs: stats.install ?? 0 };
  }
  return result;
}

// --- Open VSX ---
async function fetchOpenVsxStats(extensionId) {
  const [namespace, name] = extensionId.split(".");
  const res = await fetch(`https://open-vsx.org/api/${namespace}/${name}`);
  if (!res.ok) {
    if (res.status === 404) return { downloads: 0, notFound: true };
    throw new Error(`Open VSX API error: ${res.status}`);
  }
  const data = await res.json();
  return { downloads: data.downloadCount ?? 0 };
}

// --- API route ---
app.get("/api/stats", async (req, res) => {
  try {
    const [marketplaceStats, ...rest] = await Promise.all([
      fetchMarketplaceStats(),
      ...EXTENSIONS.map((e) => fetchOpenVsxStats(e.id)),
      ...EXTENSIONS.map((e) => fetchUmamiStats(e.umamiId)),
      ...EXTENSIONS.map((e) => fetchUserCount(e.label, process.env[e.dbEnv])),
    ]);

    const vsxStats      = rest.slice(0, EXTENSIONS.length);
    const umamiVisitors = rest.slice(EXTENSIONS.length, EXTENSIONS.length * 2);
    const userCounts    = rest.slice(EXTENSIONS.length * 2);

    const stats = EXTENSIONS.map((ext, i) => ({
      id: ext.id,
      label: ext.label,
      marketplace: marketplaceStats[ext.id] ?? { installs: 0 },
      openVsx: vsxStats[i],
      visitors: umamiVisitors[i].visitors,
      returning: umamiVisitors[i].returning,
      users: userCounts[i],
    }));

    res.json({ stats, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Social profile fetchers ---
async function fetchGitHub() {
  const username = process.env.GITHUB_USERNAME;
  if (!username) return null;
  const res = await fetch(`https://api.github.com/users/${username}`, {
    headers: { "User-Agent": "dashboard" },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  return data.followers;
}

async function fetchReddit() {
  const username = process.env.REDDIT_USERNAME;
  if (!username) return null;
  const res = await fetch(`https://www.reddit.com/user/${username}/about.json`, {
    headers: { "User-Agent": "dashboard/1.0" },
  });
  if (!res.ok) throw new Error(`Reddit API error: ${res.status}`);
  const data = await res.json();
  return data.data.total_karma;
}

async function fetchFacebook() {
  const token = process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token || !pageId) return null;
  const res = await fetch(
    `https://graph.facebook.com/${pageId}?fields=followers_count&access_token=${token}`
  );
  if (!res.ok) throw new Error(`Facebook API error: ${res.status}`);
  const data = await res.json();
  return data.followers_count;
}

async function fetchYouTube() {
  const key = process.env.YOUTUBE_API_KEY;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;
  if (!key || !channelId) return null;
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${key}`
  );
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
  const data = await res.json();
  return parseInt(data.items?.[0]?.statistics?.subscriberCount ?? null);
}

// --- Shared browser instance ---
let browser = null;
async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

function parseFormattedCount(str) {
  if (!str) return null;
  const s = str.trim().replace(/,/g, "");
  if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
  if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
  return parseInt(s) || null;
}

async function fetchX() {
  const username = process.env.X_USERNAME;
  if (!username) return null;
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(`https://x.com/${username}`, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(`a[href="/${username}/verified_followers"]`, { timeout: 15000 });
    const text = await page.$eval(
      `a[href="/${username}/verified_followers"]`,
      (el) => el.textContent.trim().split(/\s+/)[0]
    );
    return parseFormattedCount(text);
  } finally {
    await page.close();
  }
}

app.get("/api/x-followers", async (req, res) => {
  try {
    const x = await fetchX();
    res.json({ x });
  } catch (err) {
    console.error("[X]", err.message);
    res.json({ x: null });
  }
});

app.get("/api/profile", async (req, res) => {
  const safe = (fn, label) =>
    fn().catch((err) => { console.error(`[${label}]`, err.message); return null; });

  const [github, reddit, facebook, youtube] = await Promise.all([
    safe(fetchGitHub, "GitHub"),
    safe(fetchReddit, "Reddit"),
    safe(fetchFacebook, "Facebook"),
    safe(fetchYouTube, "YouTube"),
  ]);

  res.json({ github, reddit, facebook, youtube, updatedAt: new Date().toISOString() });
});

app.use(express.static(join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

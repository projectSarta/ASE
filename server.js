// ASE Live — mobile prices proxy
// Holds an aselive.jo guest session (empty-credentials login), fetches the
// JSONP market endpoints, parses them into clean JSON, and serves a mobile UI.
//
// Zero external dependencies. Requires Node 18+ (global fetch).
//   node server.js          -> http://localhost:3000
//   PORT=8080 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'https://aselive.jo/v3';
const PORT = process.env.PORT || 3000;
const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
let cookies = {}; // name -> value
let loginInFlight = null;

function cookieHeader() {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function storeSetCookies(res) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = [raw];
  }
  for (const c of list) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) cookies[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
}

// Perform the empty-credentials guest login and capture PHPSESSID.
async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    cookies = {};
    // 1) GET the login page: grab cookiesession1 + the per-session token.
    const g = await fetch(`${BASE}/Wlogin.php`, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
    });
    storeSetCookies(g);
    const html = await g.text();
    // The EN form's token is the last __ncforminfo on the page.
    const tokens = [...html.matchAll(/__ncforminfo"\s+value="([^"]*)"/g)].map((m) => m[1]);
    const token = tokens.length ? tokens[tokens.length - 1] : '';

    // 2) POST empty user/password.
    const body = new URLSearchParams({
      language: 'EN',
      user: '',
      password: '',
      Submit: 'Login',
      __ncforminfo: token,
    }).toString();
    const p = await fetch(`${BASE}/Wlogin.php`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(),
      },
      body,
      redirect: 'manual',
    });
    storeSetCookies(p);
    if (!cookies.PHPSESSID) {
      throw new Error('login failed: no PHPSESSID returned');
    }
    console.log(`[session] guest login OK (PHPSESSID=${cookies.PHPSESSID.slice(0, 8)}…)`);
  })().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

// A response signals a dead/expired session if it redirects (302 -> logout)
// or the body is the login page instead of the data payload.
function looksLoggedOut(res, text) {
  if (res.status >= 300 && res.status < 400) return true;
  return /not\s+loged|please login|logout\.php|Wlogin/i.test((text || '').slice(0, 500));
}

// Fetch a data endpoint, transparently re-logging in if the session is dead.
async function fetchEndpoint(ep) {
  if (!cookies.PHPSESSID) await login();
  const url = `${BASE}/${ep}`;
  const get = () =>
    fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader() }, redirect: 'manual' });

  let res = await get();
  let text = res.status >= 300 && res.status < 400 ? '' : await res.text();

  if (looksLoggedOut(res, text)) {
    console.log(`[session] logged out — re-authenticating (triggered by ${ep})`);
    await login(); // login() resets cookies and grabs a fresh PHPSESSID
    res = await get();
    text = res.status >= 300 && res.status < 400 ? '' : await res.text();
    if (looksLoggedOut(res, text)) {
      throw new Error('session re-login failed: still logged out after retry');
    }
    console.log('[session] re-authenticated, request recovered');
  }
  return text;
}

// ---------------------------------------------------------------------------
// JSONP parsing — endpoints return e.g.  fn(new Array('a','b'), new Array(...))
// ---------------------------------------------------------------------------
function parseArrays(text) {
  const out = [];
  const re = /new Array\(([\s\S]*?)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    if (!inner) {
      out.push([]);
      continue;
    }
    const items = inner.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || [];
    out.push(items.map((s) => s.slice(1, -1)));
  }
  return out;
}

const num = (s) => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Symbol -> company name dictionary. The ticker has no names, so we build the
// map from the gainers/losers/unchanged lists (together they cover the whole
// market) and seed the handful of index rows that never appear in those lists.
const names = {
  ASE20: 'ASE20 Index',
  ASETR: 'ASE Total Return Index',
  PX1: 'ASE Price Index',
};
function learnNames(syms, nms) {
  if (!syms || !nms) return;
  for (let i = 0; i < syms.length; i++) if (nms[i]) names[syms[i]] = nms[i];
}

// Proactively populate the full name map (refreshed on an interval).
let namesReady = null;
async function refreshNames() {
  for (const ep of ['Gainers.php', 'losers.php', 'not_changed.php']) {
    try {
      const a = parseArrays(await fetchEndpoint(ep));
      learnNames(a[0], a[1]);
    } catch (e) {
      console.error('[names]', ep, e.message);
    }
  }
  return names;
}
function ensureNames() {
  if (!namesReady) namesReady = refreshNames();
  return namesReady;
}

// ---------------------------------------------------------------------------
// Tiny response cache (per endpoint, short TTL) to avoid hammering the source.
// ---------------------------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = await producer();
  cache.set(key, { t: now, v });
  return v;
}

// ---------------------------------------------------------------------------
// API shapers
// ---------------------------------------------------------------------------
async function apiTicker() {
  await ensureNames();
  const a = parseArrays(await fetchEndpoint('ticker.php'));
  const [syms = [], last = [], chg = []] = a;
  const rows = syms.map((sym, i) => ({
    sym,
    name: names[sym] || null,
    last: num(last[i]),
    chg: num(chg[i]),
  }));
  return { ts: Date.now(), count: rows.length, rows };
}

async function apiIndex() {
  const a = parseArrays(await fetchEndpoint('index.php'));
  const v = a[0] || [];
  return {
    ts: Date.now(),
    value: num(v[0]),
    changePct: num(v[1]),
    changePts: num(v[2]),
    open: num(v[3]),
    high: num(v[4]),
    low: num(v[5]),
    prevClose: num(v[6]),
    volume: num(v[7]),
    turnover: num(v[8]),
    trades: num(v[9]),
  };
}

async function namedList(ep) {
  const a = parseArrays(await fetchEndpoint(ep));
  const [syms = [], nms = [], price = [], chg = []] = a;
  learnNames(syms, nms);
  return syms.map((sym, i) => ({
    sym,
    name: nms[i] || names[sym] || null,
    price: num(price[i]),
    chg: num(chg[i]),
  }));
}

// Per-symbol OHLC. Open/High/Low/Current come from today's trade tape;
// Prev-Close is derived from the ticker's last price + change% (matches the
// official market_watch figures to the cent). Works for every symbol.
async function apiQuote(symbol) {
  const [tick, intra] = await Promise.all([
    cached('ticker', 2500, apiTicker),
    apiIntraday(symbol),
  ]);
  const row = tick.rows.find((r) => r.sym === symbol) || {};
  const prices = intra.trades.map((t) => t.price).filter((p) => Number.isFinite(p));
  const current = row.last != null ? row.last : prices.length ? prices[0] : null;
  const chg = row.chg;
  const prevClose =
    current != null && chg != null ? +(current / (1 + chg / 100)).toFixed(3) : null;
  return {
    symbol,
    name: row.name || null,
    current,
    open: prices.length ? prices[prices.length - 1] : null,
    high: prices.length ? Math.max(...prices) : null,
    low: prices.length ? Math.min(...prices) : null,
    prevClose,
    changePct: chg != null ? chg : null,
    change: current != null && prevClose != null ? +(current - prevClose).toFixed(3) : null,
    trades: prices.length,
  };
}

async function apiDepth(symbol) {
  const a = parseArrays(await fetchEndpoint(`depth.php?symbol=${encodeURIComponent(symbol)}`));
  const [askPx = [], askQty = [], askOrd = [], bidPx = [], bidQty = [], bidOrd = []] = a;
  const level = (px, qty, ord) =>
    px.map((p, i) => ({ price: num(p), qty: num(qty[i]), orders: num(ord[i]) }))
      .filter((l) => l.price);
  return { symbol, ask: level(askPx, askQty, askOrd), bid: level(bidPx, bidQty, bidOrd) };
}

async function apiIntraday(symbol) {
  const a = parseArrays(await fetchEndpoint(`intraday.php?symbol=${encodeURIComponent(symbol)}`));
  const [time = [], qty = [], price = [], value = []] = a;
  return {
    symbol,
    trades: time.map((t, i) => ({
      time: t,
      qty: num(qty[i]),
      price: num(price[i]),
      value: num(value[i]),
    })),
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const STATIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    if (p === '/api/ticker') return sendJson(res, 200, await cached('ticker', 2500, apiTicker));
    if (p === '/api/index') return sendJson(res, 200, await cached('index', 2500, apiIndex));
    if (p === '/api/gainers')
      return sendJson(res, 200, await cached('gainers', 5000, () => namedList('Gainers.php')));
    if (p === '/api/losers')
      return sendJson(res, 200, await cached('losers', 5000, () => namedList('losers.php')));
    if (p === '/api/active')
      return sendJson(res, 200, await cached('active', 5000, () => namedList('activeByValue.php')));
    if (p === '/api/quote') {
      const s = u.searchParams.get('symbol');
      if (!s) return sendJson(res, 400, { error: 'symbol required' });
      return sendJson(res, 200, await cached('quote:' + s, 2000, () => apiQuote(s)));
    }
    if (p === '/api/depth') {
      const s = u.searchParams.get('symbol');
      if (!s) return sendJson(res, 400, { error: 'symbol required' });
      return sendJson(res, 200, await cached('depth:' + s, 2000, () => apiDepth(s)));
    }
    if (p === '/api/intraday') {
      const s = u.searchParams.get('symbol');
      if (!s) return sendJson(res, 400, { error: 'symbol required' });
      return sendJson(res, 200, await cached('intra:' + s, 2000, () => apiIntraday(s)));
    }

    // static
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(STATIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (full.startsWith(STATIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404).end('Not found');
  } catch (e) {
    console.error('[error]', p, e.message);
    sendJson(res, 502, { error: e.message });
  }
});

function start() {
  server.listen(PORT, () => {
    console.log(`ASE Live mobile  →  http://localhost:${PORT}`);
    login()
      .then(() => ensureNames())
      .catch((e) => console.error('[session] initial login failed:', e.message));
    // Refresh the company-name map periodically (names rarely change).
    setInterval(() => {
      namesReady = refreshNames();
    }, 10 * 60 * 1000);
    // Keep-alive: poke the auth-gated page every 3 min. mwv2.php is the only
    // endpoint that enforces login (the data endpoints are public), so it's
    // the canary — a 302->logout here triggers fetchEndpoint's auto re-login.
    setInterval(() => {
      fetchEndpoint('mwv2.php').catch((e) => console.error('[keepalive]', e.message));
    }, 3 * 60 * 1000);
  });
}

if (require.main === module) start();

// Exposed for tests (e.g. simulating an expired session).
module.exports = {
  start,
  login,
  fetchEndpoint,
  parseArrays,
  _killSession: () => { cookies.PHPSESSID = 'expired_invalid_session'; },
};

// ASE Live — Cloudflare Worker
// Serves the mobile UI (static asset) and proxies the public ASELive
// market-watch endpoints, parsing their JSONP into clean JSON.
//
// The ASE data endpoints (ticker/index/gainers/losers/depth/intraday) are
// public — no login required — so the Worker just fetches and parses them.

const BASE = 'https://aselive.jo/v3';
const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

async function fetchText(ep) {
  const r = await fetch(`${BASE}/${ep}`, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    cf: { cacheTtl: 2, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`upstream ${ep} -> HTTP ${r.status}`);
  return r.text();
}

// JSONP parsing — fn(new Array('a','b'), new Array(...))
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

// Symbol -> company name map (built from the named lists; cached per isolate).
let names = { ASE20: 'ASE20 Index', ASETR: 'ASE Total Return Index', PX1: 'ASE Price Index' };
let namesAt = 0;
function learnNames(syms, nms) {
  if (!syms || !nms) return;
  for (let i = 0; i < syms.length; i++) if (nms[i]) names[syms[i]] = nms[i];
}
async function ensureNames(now) {
  if (now - namesAt < 600000 && Object.keys(names).length > 5) return;
  for (const ep of ['Gainers.php', 'losers.php', 'not_changed.php']) {
    try {
      const a = parseArrays(await fetchText(ep));
      learnNames(a[0], a[1]);
    } catch (e) {
      /* ignore one list failing */
    }
  }
  namesAt = now;
}

// Tiny per-isolate cache.
const cache = new Map();
async function cached(key, ttlMs, now, producer) {
  const hit = cache.get(key);
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = await producer();
  cache.set(key, { t: now, v });
  return v;
}

// --- API shapers -----------------------------------------------------------
async function apiTicker(now) {
  await ensureNames(now);
  const [syms = [], last = [], chg = []] = parseArrays(await fetchText('ticker.php'));
  const rows = syms.map((sym, i) => ({
    sym,
    name: names[sym] || null,
    last: num(last[i]),
    chg: num(chg[i]),
  }));
  return { ts: now, count: rows.length, rows };
}

async function apiIndex(now) {
  const v = parseArrays(await fetchText('index.php'))[0] || [];
  return {
    ts: now,
    value: num(v[0]), changePct: num(v[1]), changePts: num(v[2]),
    open: num(v[3]), high: num(v[4]), low: num(v[5]), prevClose: num(v[6]),
    volume: num(v[7]), turnover: num(v[8]), trades: num(v[9]),
  };
}

async function namedList(ep) {
  const [syms = [], nms = [], price = [], chg = []] = parseArrays(await fetchText(ep));
  learnNames(syms, nms);
  return syms.map((sym, i) => ({
    sym,
    name: nms[i] || names[sym] || null,
    price: num(price[i]),
    chg: num(chg[i]),
  }));
}

async function apiIntraday(symbol) {
  const [time = [], qty = [], price = [], value = []] = parseArrays(
    await fetchText(`intraday.php?symbol=${encodeURIComponent(symbol)}`)
  );
  return {
    symbol,
    trades: time.map((t, i) => ({ time: t, qty: num(qty[i]), price: num(price[i]), value: num(value[i]) })),
  };
}

async function apiQuote(symbol, now) {
  const [tick, intra] = await Promise.all([
    cached('ticker', 2500, now, () => apiTicker(now)),
    apiIntraday(symbol),
  ]);
  const row = tick.rows.find((r) => r.sym === symbol) || {};
  const prices = intra.trades.map((t) => t.price).filter((p) => Number.isFinite(p));
  const current = row.last != null ? row.last : prices.length ? prices[0] : null;
  const chg = row.chg;
  const prevClose = current != null && chg != null ? +(current / (1 + chg / 100)).toFixed(3) : null;
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
  const [askPx = [], askQty = [], askOrd = [], bidPx = [], bidQty = [], bidOrd = []] = parseArrays(
    await fetchText(`depth.php?symbol=${encodeURIComponent(symbol)}`)
  );
  const level = (px, qty, ord) =>
    px.map((p, i) => ({ price: num(p), qty: num(qty[i]), orders: num(ord[i]) })).filter((l) => l.price);
  return { symbol, ask: level(askPx, askQty, askOrd), bid: level(bidPx, bidQty, bidOrd) };
}

// --- Worker entry ----------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const now = Date.now();
    const json = (obj, code = 200) =>
      new Response(JSON.stringify(obj), {
        status: code,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });

    try {
      if (p === '/api/ticker') return json(await cached('ticker', 2500, now, () => apiTicker(now)));
      if (p === '/api/index') return json(await cached('index', 2500, now, () => apiIndex(now)));
      if (p === '/api/gainers')
        return json(await cached('gainers', 5000, now, () => namedList('Gainers.php')));
      if (p === '/api/losers')
        return json(await cached('losers', 5000, now, () => namedList('losers.php')));
      if (p === '/api/active')
        return json(await cached('active', 5000, now, () => namedList('activeByValue.php')));
      if (p === '/api/quote') {
        const s = url.searchParams.get('symbol');
        if (!s) return json({ error: 'symbol required' }, 400);
        return json(await cached('quote:' + s, 2000, now, () => apiQuote(s, now)));
      }
      if (p === '/api/depth') {
        const s = url.searchParams.get('symbol');
        if (!s) return json({ error: 'symbol required' }, 400);
        return json(await cached('depth:' + s, 2000, now, () => apiDepth(s)));
      }
      if (p === '/api/intraday') {
        const s = url.searchParams.get('symbol');
        if (!s) return json({ error: 'symbol required' }, 400);
        return json(await cached('intra:' + s, 2000, now, () => apiIntraday(s)));
      }

      // Anything else -> static asset (index.html etc.)
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  },
};

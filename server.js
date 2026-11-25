'use strict';
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const FALLBACK_RATE = parseFloat(process.env.RATE_CNY_USD || '0.14');
const DEBUG_RAW = process.env.DEBUG_RAW === '1';
const HOSTS = ['taobao.com', 'tmall.com', 'tb.cn', 'weidian.com', 'youshop10.com', 'koudai.com'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const hostOk = (h) => HOSTS.some((d) => h === d || h.endsWith('.' + d));

/* ---------------- app, CORS, rate limit ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

// CORS: reflect the request origin if the list is '*', otherwise check against the allowlist.
// We allow no-origin requests (curl, server-to-server) but let the browser see that it's allowed.
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // no Origin header: curl, same-origin, etc.
    if (ALLOWED.includes('*')) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false); // not allowed
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  maxAge: 86400
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // explicit preflight for all paths

// Rate limit per IP. Returns a 429 with the standard shape.
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const rec = hits.get(req.ip);
  if (!rec || now > rec.reset) hits.set(req.ip, { n: 1, reset: now + 60000 });
  else if (++rec.n > 30) {
    res.set('retry-after', '60');
    return res.status(429).json({ ok: false, error: 'Too many requests. Wait a minute.' });
  }
  next();
});
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 60000).unref();

/* ---------------- helpers ---------------- */
function unwrap(raw, depth = 0) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (depth < 3) {
    for (const k of ['url', 'itemUrl', 'link', 'goodsUrl']) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v)) return unwrap(v, depth + 1) || v;
    }
  }
  return u.href;
}

function identify(u) {
  const h = u.hostname;
  const q = (...keys) => { for (const k of keys) { const v = u.searchParams.get(k); if (v && /^\d+$/.test(v)) return v; } return null; };
  if (/(^|\.)(weidian|youshop10|koudai)\.com$/.test(h)) {
    const id = q('itemID', 'itemId', 'item_id');
    return id ? { platform: 'weidian', id } : null;
  }
  if (/(^|\.)(taobao|tmall)\.com$/.test(h)) {
    const id = q('id', 'itemId', 'item_id', 'num_iid');
    return id ? { platform: 'taobao', id } : null;
  }
  return null;
}

async function resolveLink(href) {
  let cur = href;
  for (let i = 0; i < 6; i++) {
    const u = new URL(cur);
    if (!['http:', 'https:'].includes(u.protocol) || !hostOk(u.hostname)) {
      throw new HttpError(400, 'Only Weidian and Taobao links are supported.');
    }
    const found = identify(u);
    if (found) return found;
    const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA } });
    const loc = r.headers.get('location');
    if (loc) { cur = new URL(loc, u).href; continue; }
    const body = await r.text();
    const m = body.match(/var url = '([^']+)'/) || body.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/);
    if (m) { cur = new URL(m[1].replace(/\\\//g, '/'), u).href; continue; }
    break;
  }
  throw new HttpError(422, 'Could not find a product in that link.');
}

function findKey(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  for (const v of Object.values(obj)) {
    const f = findKey(v, keys, depth + 1);
    if (f !== undefined) return f;
  }
  return undefined;
}
const fixUrl = (u) => (typeof u === 'string' && u ? (u.startsWith('//') ? 'https:' + u : u.replace(/^http:/, 'https:')) : '');

function parsePrice(v) {
  if (v === undefined || v === null) return null;
  const nums = String(v).replace(/,/g, '').match(/\d+(\.\d+)?/g);
  if (!nums) return null;
  const vals = nums.map(Number);
  return { low: Math.min(...vals), high: Math.max(...vals) };
}

function metaTag(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'))
    || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i'));
  return m ? m[1] : '';
}

/* ---------------- currency ---------------- */
let rateCache = { rate: FALLBACK_RATE, at: 0, live: false };
async function cnyToUsd() {
  if (Date.now() - rateCache.at < 6 * 3600 * 1000) return rateCache;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/CNY');
    const j = await r.json();
    if (j && j.rates && j.rates.USD) rateCache = { rate: j.rates.USD, at: Date.now(), live: true };
    else throw new Error('no rate');
  } catch {
    rateCache = { rate: FALLBACK_RATE, at: Date.now() - 5 * 3600 * 1000, live: false };
  }
  return rateCache;
}

/* ---------------- Weidian ---------------- */
async function weidian(id) {
  const out = { name: '', image: '', images: [], price: null, raw: null };
  try {
    const param = encodeURIComponent(JSON.stringify({ itemId: String(id) }));
    const r = await fetch('https://thor.weidian.com/detail/getItemSkuInfo/1.0?param=' + param, {
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        origin: 'https://weidian.com',
        referer: 'https://weidian.com/item.html?itemID=' + id
      },
    });
    const j = await r.json();
    const res = j && j.result;
    out.raw = j;
    if (res) {
      out.name = String(findKey(res, ['itemTitle', 'itemName', 'title']) || '');
      const imgs = findKey(res, ['itemImages', 'itemImgs', 'imgs', 'images']);
      if (Array.isArray(imgs)) out.images = imgs.map((x) => fixUrl(typeof x === 'string' ? x : (x && (x.url || x.img || x.imgUrl)))).filter(Boolean);
      out.image = fixUrl(findKey(res, ['itemMainPic', 'mainPic', 'itemImg', 'itemImage', 'imgUrl', 'imageUrl', 'img'])) || out.images[0] || '';
      out.price = parsePrice(findKey(res, ['itemDiscountLowPrice', 'itemLowPrice', 'itemPrice', 'discountPrice', 'lowPrice', 'price']));
    }
  } catch (e) {
    if (DEBUG_RAW) console.error('weidian api failed:', e.message);
  }

  if (!out.name || !out.price) {
    try {
      const r = await fetch('https://weidian.com/item.html?itemID=' + id, { headers: { 'user-agent': UA } });
      const html = await r.text();
      out.name = out.name || metaTag(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      out.image = out.image || fixUrl(metaTag(html, 'og:image'));
      out.price = out.price || parsePrice(metaTag(html, 'og:price:amount') || metaTag(html, 'product:price:amount'));
    } catch (e) {
      if (DEBUG_RAW) console.error('weidian html failed:', e.message);
    }
  }
  return out;
}

/* ---------------- Taobao / Tmall (mtop h5, best effort) ---------------- */
async function taobao(id) {
  const appKey = '12574478';
  const data = JSON.stringify({ id: String(id), itemNumId: String(id), detail_v: '3.3.2', exParams: JSON.stringify({ id: String(id) }) });
  const base = 'https://h5api.m.taobao.com/h5/mtop.taobao.detail.getdetail/6.0/';
  const jar = {};
  if (process.env.TAOBAO_COOKIE) {
    process.env.TAOBAO_COOKIE.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  }
  const cookieStr = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  let json = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = Date.now();
    const token = (jar._m_h5_tk || '').split('_')[0];
    const sign = crypto.createHash('md5').update(token + '&' + t + '&' + appKey + '&' + data).digest('hex');
    const url = base + '?jsv=2.7.4&appKey=' + appKey + '&t=' + t + '&sign=' + sign +
      '&api=mtop.taobao.detail.getdetail&v=6.0&type=originaljson&dataType=json&data=' + encodeURIComponent(data);
    const r = await fetch(url, { headers: { 'user-agent': UA, cookie: cookieStr(), referer: 'https://item.taobao.com/', accept: 'application/json' } });
    const sc = (r.headers.getSetCookie && r.headers.getSetCookie()) || [];
    sc.forEach((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
    const text = await r.text();
    try { json = JSON.parse(text.replace(/^[^({]*\(/, '').replace(/\)\s*;?\s*$/, '') || text); } catch { try { json = JSON.parse(text); } catch { json = null; } }
    const ret = json && json.ret ? json.ret.join(',') : '';
    if (/SUCCESS/.test(ret)) break;
    if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/.test(ret)) continue;
    break;
  }
  const ret = json && json.ret ? json.ret.join(',') : '';
  if (!/SUCCESS/.test(ret)) {
    throw new HttpError(502, 'Taobao refused the request (' + (ret || 'no response') + '). Set TAOBAO_COOKIE or use a data provider API.');
  }
  const d = json.data || {};
  const item = d.item || {};
  const images = (item.images || []).map(fixUrl).filter(Boolean);
  return {
    name: String(item.title || findKey(d, ['title']) || ''),
    image: images[0] || '',
    images,
    price: parsePrice(findKey(d, ['priceText'])),
    raw: json,
  };
}

/* ---------------- product lookup ---------------- */
const cache = new Map();
async function getProduct(rawUrl) {
  const href = unwrap(rawUrl);
  if (!href) throw new HttpError(400, 'Enter a valid product link.');
  const { platform, id } = await resolveLink(href);
  const key = platform + ':' + id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;

  const info = platform === 'weidian' ? await weidian(id) : await taobao(id);
  if (!info.name && !info.price) throw new HttpError(404, 'No product data found. The item may be removed or the source blocked the request.');

  const fx = await cnyToUsd();
  const usd = (n) => (n == null ? null : Math.round(n * fx.rate * 100) / 100);
  const data = {
    ok: true,
    platform,
    itemId: id,
    name: info.name.trim(),
    image: info.image,
    images: info.images.length ? info.images : (info.image ? [info.image] : []),
    priceUSD: info.price ? usd(info.price.low) : null,
    priceMaxUSD: info.price && info.price.high !== info.price.low ? usd(info.price.high) : null,
    priceCNY: info.price ? info.price.low : null,
    currency: 'USD',
    rate: fx.rate,
    rateIsLive: fx.live,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  if (DEBUG_RAW) data._raw = info.raw;
  return data;
}

/* ---------------- routes ---------------- */

// Fast connectivity check. Use this from the frontend on page load.
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/', (req, res) => res.json({
  name: 'larplocks-product-api',
  usage: 'GET /api/product?url=<weidian-or-taobao-link>',
  health: '/health'
}));

async function handle(req, res) {
  const url = (req.body && req.body.url) || req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing url.' });
  try {
    res.json(await getProduct(url));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[lookup] unhandled:', e);
    res.status(status).json({ ok: false, error: status === 500 ? 'Server error. Try again.' : e.message });
  }
}
app.get('/api/product', handle);
app.post('/api/product', handle);

// 404 for anything else under /api so the frontend gets JSON, not HTML
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Unknown API route.' }));

// Final error handler: always JSON, always with CORS headers already applied by middleware.
app.use((err, req, res, next) => {
  console.error('[express] unhandled:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Server error. Try again.' });
});

app.listen(PORT, '0.0.0.0', () => console.log('Product API listening on ' + PORT));

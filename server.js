/**
 * 股市儀表板雲端 Proxy Server
 * 完全免費，不需要任何 API Key
 * 新聞來源：Google News RSS 繁體中文
 */

const http   = require('http');
const https  = require('https');
const urlMod = require('url');

const PORT = process.env.PORT || 3001;

// FinMind 快取（server 端，所有使用者共用，減少 API 呼叫）
const finmindCache = {};
// FinMind Token（免費版，600次/小時上限）
const FINMIND_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNi0wMy0xNiAxNjowNjowOCIsInVzZXJfaWQiOiJKYW1lcyIsImVtYWlsIjoiamFtZXNAc3AzYy5jb20udHciLCJpcCI6IjM2LjIzOS4xLjE4MiJ9.AeaPaksif3unSJs4h83WVDJ41pdI60bSlCPKuwrvxFQ';

// FinMind 用量追蹤（600次/小時）
const finmindUsage = { count: 0, resetAt: Date.now() + 3600000 };
function trackFinMind() {
  if (Date.now() > finmindUsage.resetAt) {
    finmindUsage.count = 0;
    finmindUsage.resetAt = Date.now() + 3600000;
  }
  finmindUsage.count++;
  if (finmindUsage.count % 20 === 0)
    console.log(`[FinMind] 本小時已用 ${finmindUsage.count}/600 次`);
  return finmindUsage.count <= 590;
}

// FinMind TTL：財務季報快取6小時，比率1小時，其他10分鐘
function getFinMindTTL(dataset) {
  if (!dataset) return 3 * 60 * 1000;
  // 季報/資產負債：6小時快取
  if (/FinancialStatements|BalanceSheet|IncomeStatement|CashFlow/.test(dataset))
    return 6 * 60 * 60 * 1000;
  // 年度指標/月營收：1小時快取
  if (/FinancialRatios|Dividend|MonthRevenue|TaiwanStockPER/.test(dataset))
    return 60 * 60 * 1000;
  // 期貨日資料：3分鐘快取（配合 block05 刷新週期）
  if (/TaiwanFuturesDaily|TaiwanOptionDaily/.test(dataset))
    return 3 * 60 * 1000;
  // 其他資料：3分鐘快取（預設）
  return 3 * 60 * 1000;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// 市場新聞來源
const MARKET_NEWS_SOURCES = [
  { label:'tw_stock',  tags:['tw'],           url:'https://news.google.com/rss/search?q=%E5%8F%B0%E8%82%A1+%E8%82%A1%E5%B8%82&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'tw_tsmc',   tags:['tw'],           url:'https://news.google.com/rss/search?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB+%E9%9B%BB%E5%AD%90%E8%82%A1&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'tw_semi',   tags:['tw'],           url:'https://news.google.com/rss/search?q=%E5%8F%B0%E8%82%A1+%E5%8D%8A%E5%B0%8E%E9%AB%94+%E8%82%A1%E5%83%B9&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'us_stock',  tags:['us'],           url:'https://news.google.com/rss/search?q=%E7%BE%8E%E8%82%A1+%E7%B4%8D%E6%96%AF%E9%81%94%E5%85%8B+%E8%82%A1%E5%B8%82&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'us_fed',    tags:['us','macro'],   url:'https://news.google.com/rss/search?q=%E7%BE%8E%E8%81%AF%E6%BA%96+%E5%88%A9%E7%8E%87+%E9%81%93%E7%93%8A&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'global',    tags:['global'],       url:'https://news.google.com/rss/search?q=%E5%9C%8B%E9%9A%9B+%E8%82%A1%E5%B8%82+%E9%87%91%E8%9E%8D&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'global_oil',tags:['global','macro'],url:'https://news.google.com/rss/search?q=%E6%B2%B9%E5%83%B9+%E5%8E%9F%E6%B2%B9+%E9%87%91%E5%83%B9&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'macro',     tags:['macro'],        url:'https://news.google.com/rss/search?q=%E9%80%9A%E8%B2%A8%E8%86%A8%E8%84%B9+%E7%B6%93%E6%BF%9F+%E5%8D%87%E6%81%AF&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { label:'macro_trade',tags:['macro'],       url:'https://news.google.com/rss/search?q=%E8%B2%BF%E6%98%93%E6%88%B0+%E9%97%9C%E7%A8%85+%E7%B8%BD%E7%B5%8C&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
];

function fetchUrl(targetUrl, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 3) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    const p = urlMod.parse(targetUrl);
    const req = https.request({
      hostname: p.hostname, port: 443, path: p.path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
        'Accept': 'application/rss+xml, text/xml, */*'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// FinMind 專用：帶 Authorization: Bearer token
function fetchUrlWithAuth(targetUrl, token) {
  return new Promise((resolve, reject) => {
    const p = urlMod.parse(targetUrl);
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = https.request({
      hostname: p.hostname, port: 443, path: p.path, method: 'GET', headers
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('FinMind timeout')); });
    req.end();
  });
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'")
    .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(parseInt(n)));
}

function getTag(xml, tag) {
  const raw = (
    xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || ''
  ).replace(/<[^>]+>/g,'').trim();
  // decodeHtml 後再 strip 一次（避免 &lt;li&gt; 轉成 <li> 破壞前端排版）
  return decodeHtml(raw).replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
}

function parseRSS(xml, source) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw     = m[1];
    const title   = getTag(raw,'title');
    const desc    = getTag(raw,'description') || getTag(raw,'summary');
    const pubDate = getTag(raw,'pubDate') || getTag(raw,'dc:date');
    const link    = getTag(raw,'link') ||
                    raw.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)/)?.[1] || '';
    if (title && title.length > 4)
      items.push({ title, description: desc, pubDate, link, source });
  }
  return items;
}

function relTime(pubDate) {
  if (!pubDate) return '';
  try {
    const mins = Math.floor((Date.now() - new Date(pubDate)) / 60000);
    if (mins < 1)  return '剛剛';
    if (mins < 60) return `${mins} 分鐘前`;
    const h = Math.floor(mins / 60);
    if (h < 24)    return `${h} 小時前`;
    return `${Math.floor(h/24)} 天前`;
  } catch { return ''; }
}

// 市場新聞（快取5分鐘）
let marketCache = null, marketCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchMarketNews() {
  if (marketCache && Date.now() - marketCacheTime < CACHE_TTL) return marketCache;
  console.log(`[${new Date().toLocaleTimeString()}] 更新市場新聞...`);

  const results = await Promise.allSettled(
    MARKET_NEWS_SOURCES.map(s => fetchUrl(s.url).then(r => ({ ...r, source: s })))
  );
  let all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.status === 200)
      all = all.concat(parseRSS(r.value.body, r.value.source));
    else console.warn(`  [${MARKET_NEWS_SOURCES[i].label}] 失敗`);
  });

  const seen = new Set();
  marketCache = all
    .filter(item => { const k=item.title.slice(0,20); if(seen.has(k)) return false; seen.add(k); return true; })
    .sort((a,b) => (new Date(b.pubDate)||0)-(new Date(a.pubDate)||0))
    .slice(0,60)
    .map(item => ({
      headline: item.title.slice(0,80),
      summary:  (item.description||item.title).slice(0,150),
      source:   'Google 新聞',
      time:     relTime(item.pubDate),
      pubDate:  item.pubDate,
      link:     item.link,
      tags:     item.source.tags,
      sentiment:'neu'
    }));
  marketCacheTime = Date.now();
  console.log(`  完成：${marketCache.length} 則`);
  return marketCache;
}

// 個股相關新聞（依關鍵字搜尋，快取2分鐘）
const stockNewsCache = {};
async function fetchStockNews(query) {
  const key = query.slice(0,20);
  if (stockNewsCache[key] && Date.now() - stockNewsCache[key].time < 2*60*1000)
    return stockNewsCache[key].news;

  const encoded = encodeURIComponent(query + ' 股票 投資');
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const r = await fetchUrl(url);
    if (r.status !== 200) return [];
    const items = parseRSS(r.body, { tags:['tw'] });
    const news = items.slice(0,8).map(item => ({
      headline: item.title.slice(0,80),
      summary:  (item.description||item.title).slice(0,150),
      source:   'Google 新聞',
      time:     relTime(item.pubDate),
      link:     item.link,
    }));
    stockNewsCache[key] = { news, time: Date.now() };
    return news;
  } catch { return []; }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = urlMod.parse(req.url, true);
  const path   = parsed.pathname;

  if (path === '/news' && req.method === 'GET') {
    try {
      const news = await fetchMarketNews();
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok:true, news, total:news.length, updated:new Date().toISOString() }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }

  } else if (path === '/stock-news' && req.method === 'GET') {
    try {
      const q    = parsed.query.q || '';
      const news = await fetchStockNews(q);
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok:true, news }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ ok:false, error:e.message }));
    }

  } else if (path === '/twse' && req.method === 'GET') {
    // TWSE OpenAPI 專用路由：模擬完整瀏覽器 Header，繞過 WAF
    const twseTarget = parsed.query.url || '';
    if (!twseTarget || !twseTarget.includes('twse.com.tw')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid url' }));
      return;
    }
    const twseKey = twseTarget;
    const nowT = Date.now();
    // 盤中資料快取3分鐘，靜態資料快取10分鐘
    const twseTTL = twseTarget.includes('STOCK_DAY_ALL') ? 5*60*1000 : 3*60*1000;
    if (finmindCache[twseKey] && nowT - finmindCache[twseKey].time < twseTTL) {
      res.writeHead(finmindCache[twseKey].status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
      res.end(finmindCache[twseKey].body);
      return;
    }
    try {
      const p = urlMod.parse(twseTarget);
      const twseReq = https.request({
        hostname: p.hostname, port: 443, path: p.path, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://www.twse.com.tw/',
          'Origin': 'https://www.twse.com.tw',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
        }
      }, twseR => {
        const chunks = [];
        // 處理 gzip/deflate 壓縮
        let stream = twseR;
        const enc = twseR.headers['content-encoding'];
        if (enc === 'gzip' || enc === 'deflate') {
          const zlib = require('zlib');
          stream = twseR.pipe(enc === 'gzip' ? zlib.createGunzip() : zlib.createInflate());
        }
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => {
          const d = Buffer.concat(chunks).toString('utf-8');
          // 檢查是否為 HTML 錯誤頁（TWSE WAF 攔截）
          if (d.trim().startsWith('<')) {
            console.warn('[TWSE] WAF 攔截！回傳 HTML');
            res.writeHead(403, { 'Content-Type': 'application/json', ...CORS });
            res.end(JSON.stringify({ error: 'TWSE_BLOCKED', status: 403 }));
            return;
          }
          if (twseR.statusCode === 200) {
            finmindCache[twseKey] = { body: d, status: 200, time: nowT };
          }
          res.writeHead(twseR.statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
          res.end(d);
          try {
            const j = JSON.parse(d);
            const rows = Array.isArray(j) ? j.length : '?';
            console.log(`[TWSE] ${p.path.split('/').pop().split('?')[0]} → ${twseR.statusCode} (${rows} rows)`);
          } catch { console.log(`[TWSE] ${p.path.split('/').pop()} → ${twseR.statusCode}`); }
        });
      });
      twseReq.on('error', e => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      twseReq.setTimeout(8000, () => {
        twseReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'TWSE timeout' }));
      });
      twseReq.end();
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (path === '/yahoo' && req.method === 'GET') {
    // Yahoo Finance / TWSE OpenAPI 轉發（解決 CORS 問題）
    const targetUrl = parsed.query.url || '';
    if (!targetUrl || (!targetUrl.includes('yahoo.com') && !targetUrl.includes('twse.com.tw'))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid url' }));
      return;
    }
    // Yahoo Finance / TWSE 轉發，5分鐘快取
    const yahooKey = targetUrl;
    const nowY = Date.now();
    if (finmindCache[yahooKey] && nowY - finmindCache[yahooKey].time < 5 * 60 * 1000) {
      res.writeHead(finmindCache[yahooKey].status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
      res.end(finmindCache[yahooKey].body);
      return;
    }
    try {
      const r = await fetchUrl(targetUrl);
      if (r.status === 200) finmindCache[yahooKey] = { body: r.body, status: r.status, time: nowY };
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
      res.end(r.body);
    } catch(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (path === '/finmind' && req.method === 'GET') {
    // FinMind API 轉發 + Server 端快取（3分鐘）
    // FinMind v4 需要 Authorization: Bearer {token}，不接受 query string token
    const rawQuery = req.url.includes('?') ? req.url.split('?')[1] : '';
    if (!rawQuery) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 400, msg: 'missing query' }));
      return;
    }
    // 從 query string 取出 token，其餘參數送給 FinMind
    const qp    = new urlMod.URLSearchParams(rawQuery);
    const token = qp.get('token') || qp.get('api_token') || FINMIND_TOKEN;
    qp.delete('token');
    qp.delete('api_token');
    const cleanQuery = qp.toString();
    const cacheKey   = cleanQuery;
    const now = Date.now();

    const dataset = qp.get('dataset') || '';
    if (!trackFinMind()) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 429, msg: 'FinMind 每小時 600 次上限已達，請稍後再試' }));
      return;
    }
    if (!finmindCache[cacheKey] || now - finmindCache[cacheKey].time > getFinMindTTL(dataset)) {
      const targetUrl = 'https://api.finmindtrade.com/api/v4/data?' + cleanQuery;
      try {
        const r = await fetchUrlWithAuth(targetUrl, token);
        try {
          const j = JSON.parse(r.body);
          const rows = j.data?.length ?? 0;
          console.log(`[FinMind] status=${j.status} rows=${rows} dataset=${qp.get('dataset')} id=${qp.get('data_id')}`);
          if (j.status === 402) {
            // 超過配額：快取 5 分鐘，避免持續打 FinMind
            console.warn('[FinMind] 402 超過配額，等到下個整點重置');
            finmindCache[cacheKey] = { body: r.body, status: 200, time: now - getFinMindTTL(dataset) + 300000 };
          } else if (rows > 0) {
            // 有資料：正常 TTL 快取
            finmindCache[cacheKey] = { body: r.body, status: r.status, time: now };
          } else {
            // 空資料：快取 30 秒後重試
            finmindCache[cacheKey] = { body: r.body, status: r.status, time: now - getFinMindTTL(dataset) + 30000 };
          }
        } catch {
          // JSON 解析失敗：短暫快取
          finmindCache[cacheKey] = { body: r.body, status: r.status, time: now };
        }
      } catch(e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 502, error: e.message }));
        return;
      }
    }
    const cached = finmindCache[cacheKey];
    res.writeHead(cached.status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(cached.body);

  } else if (path === '/health') {
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ ok:true, time:new Date().toISOString() }));

  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ Stock Proxy 已啟動 port ${PORT}`);
  console.log(`   完全免費，不需要任何 API Key`);
  console.log(`   /news        市場新聞（繁體中文）`);
  console.log(`   /stock-news  個股相關新聞\n`);
});

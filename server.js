/**
 * 股市儀表板雲端 Proxy Server
 * 完全免費，不需要任何 API Key
 * 新聞來源：Google News RSS 繁體中文
 */

const http   = require('http');
const https  = require('https');
const urlMod = require('url');

const PORT = process.env.PORT || 3001;

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

function decodeHtml(str) {
  return str
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'")
    .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(parseInt(n)));
}

function getTag(xml, tag) {
  const val = (
    xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || ''
  ).replace(/<[^>]+>/g,'').trim();
  return decodeHtml(val);
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

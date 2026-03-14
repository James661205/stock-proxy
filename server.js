/**
 * 股市儀表板雲端 Proxy Server
 * 新聞來源：Yahoo Finance RSS（全球可存取）
 * 台股新聞透過關鍵字自動分類
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

// Yahoo Finance RSS — 全球均可存取，不擋海外 IP
const NEWS_SOURCES = [
  // 台股相關個股/ETF（Yahoo Finance 國際版，有台股新聞）
  { label:'tsm',    url:'https://finance.yahoo.com/rss/headline?s=TSM' },
  { label:'amd',    url:'https://finance.yahoo.com/rss/headline?s=AMD' },
  { label:'nvda',   url:'https://finance.yahoo.com/rss/headline?s=NVDA' },
  { label:'twii',   url:'https://finance.yahoo.com/rss/headline?s=%5ETWII' },
  { label:'0050',   url:'https://finance.yahoo.com/rss/headline?s=0050.TW' },
  // 美股指數
  { label:'nasdaq', url:'https://finance.yahoo.com/rss/headline?s=%5EIXIC' },
  { label:'sp500',  url:'https://finance.yahoo.com/rss/headline?s=%5EGSPC' },
  { label:'dji',    url:'https://finance.yahoo.com/rss/headline?s=%5EDJI' },
  // 國際財經總覽
  { label:'top',    url:'https://finance.yahoo.com/news/rssindex' },
];

// 台股關鍵字：出現在標題/摘要中自動標記 tw
const TW_KEYWORDS = [
  'taiwan','tsmc','台積電','台股','加權','taiex','twii',
  '鴻海','聯發科','mediatek','asml','fox','ase','auo','delta',
  '0050','0056','etf tw','taiwan semiconductor','foxconn'
];
// 美股關鍵字
const US_KEYWORDS = [
  'nasdaq','s&p','dow jones','fed','federal reserve','wall street',
  'apple','google','microsoft','amazon','meta','nvidia','amd','intel',
  'stock market','nyse','earnings','ipo','rate hike'
];
// 總經關鍵字
const MACRO_KEYWORDS = [
  'inflation','cpi','gdp','interest rate','central bank','recession',
  'fed','ecb','boj','monetary','fiscal','tariff','trade war','油價',
  'bond yield','treasury'
];

function classifyTags(headline, summary) {
  const text = (headline + ' ' + summary).toLowerCase();
  const tags = [];
  if (TW_KEYWORDS.some(k => text.includes(k)))    tags.push('tw');
  if (US_KEYWORDS.some(k => text.includes(k)))    tags.push('us');
  if (MACRO_KEYWORDS.some(k => text.includes(k))) tags.push('macro');
  if (!tags.length) tags.push('global');
  return tags;
}

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const p = urlMod.parse(targetUrl);
    const req = https.request({
      hostname: p.hostname, port: 443,
      path: p.path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'application/rss+xml, text/xml, */*'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function getTag(xml, tag) {
  return (
    xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || ''
  ).replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    const title   = getTag(raw, 'title');
    const desc    = getTag(raw, 'description') || getTag(raw, 'summary');
    const pubDate = getTag(raw, 'pubDate');
    const link    = getTag(raw, 'link') ||
                    raw.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)/)?.[1] || '';
    if (title) items.push({ title, description: desc, pubDate, link });
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
    return `${Math.floor(h / 24)} 天前`;
  } catch { return ''; }
}

async function fetchAllNews() {
  const results = await Promise.allSettled(
    NEWS_SOURCES.map(s => fetchUrl(s.url).then(r => ({ ...r, label: s.label })))
  );

  let all = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.status === 200) {
      const items = parseRSS(r.value.body);
      all = all.concat(items);
    } else if (r.status === 'rejected') {
      console.warn(`[RSS] fetch failed:`, r.reason?.message);
    }
  });

  // 去重（標題前 30 字）
  const seen = new Set();
  const unique = all.filter(item => {
    const k = item.title.slice(0, 30).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // 依時間排序
  unique.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  return unique.slice(0, 60).map(item => {
    const tags = classifyTags(item.title, item.description);
    return {
      headline:  item.title.slice(0, 80),
      summary:   (item.description || item.title).slice(0, 150),
      source:    'Yahoo Finance',
      time:      relTime(item.pubDate),
      pubDate:   item.pubDate,
      link:      item.link,
      tags,
      sentiment: 'neu'
    };
  });
}

// 新聞快取（每 5 分鐘更新一次，避免頻繁呼叫 RSS）
let newsCache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedNews() {
  if (newsCache && Date.now() - cacheTime < CACHE_TTL) return newsCache;
  newsCache = await fetchAllNews();
  cacheTime = Date.now();
  return newsCache;
}

const server = http.createServer(async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = urlMod.parse(req.url).pathname;

  if (path === '/news' && req.method === 'GET') {
    try {
      const news = await getCachedNews();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, news, total: news.length, updated: new Date().toISOString() }));
      console.log(`[${new Date().toLocaleTimeString()}] /news → ${news.length} 則，tw:${news.filter(n=>n.tags.includes('tw')).length} us:${news.filter(n=>n.tags.includes('us')).length}`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  } else if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`✅ Stock Proxy 已啟動 port ${PORT}`);
  console.log(`   新聞端點: /news`);
  console.log(`   台股分類: 關鍵字自動判斷（TSM/TSMC/台積電等）`);
});

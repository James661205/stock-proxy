/**
 * 股市儀表板雲端 Proxy Server
 * 部署到 Render.com（免費）
 * 功能：轉發 Yahoo/鉅亨/MoneyDJ 新聞 RSS，解決 CORS
 */

const http  = require('http');
const https = require('https');
const urlMod = require('url');

const PORT = process.env.PORT || 3001;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const NEWS_SOURCES = [
  { label:'cnyes_tw',    tags:['tw'],    url:'https://news.cnyes.com/rss/tw_stock' },
  { label:'cnyes_us',    tags:['us'],    url:'https://news.cnyes.com/rss/us_stock' },
  { label:'cnyes_macro', tags:['macro'], url:'https://news.cnyes.com/rss/macro' },
  { label:'yahoo_top',   tags:['global'],url:'https://finance.yahoo.com/news/rssindex' },
  { label:'yahoo_nasdaq',tags:['us'],    url:'https://finance.yahoo.com/rss/headline?s=^IXIC' },
  { label:'yahoo_twii',  tags:['tw'],    url:'https://finance.yahoo.com/rss/headline?s=^TWII' },
  { label:'moneydj_tw',  tags:['tw'],    url:'https://www.moneydj.com/KMDJ/RssNew/RssFeed.aspx?svc=NW&SID=MB010201' },
];

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const p = urlMod.parse(targetUrl);
    const req = https.request({
      hostname: p.hostname, port: 443, path: p.path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml,text/xml,*/*' }
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

function get(xml, tag) {
  return (
    xml.match(new RegExp(`<${tag}><\\!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1] ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || ''
  ).replace(/<[^>]+>/g, '').trim();
}

function parseRSS(xml, source) {
  const items = [];
  let m;
  const re = /<item>([\s\S]*?)<\/item>/g;
  while ((m = re.exec(xml)) !== null) {
    const item = m[1];
    const title   = get(item, 'title');
    const desc    = get(item, 'description') || get(item, 'summary');
    const pubDate = get(item, 'pubDate') || get(item, 'dc:date');
    const link    = get(item, 'link') ||
                    item.match(/<link\s*\/?>\s*(https?:\/\/[^\s<]+)/)?.[1] || '';
    if (title) items.push({ title, description: desc, pubDate, link, source });
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
    NEWS_SOURCES.map(s => fetchUrl(s.url).then(r => ({ ...r, source: s })))
  );
  let all = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.status === 200)
      all = all.concat(parseRSS(r.value.body, r.value.source));
  });
  const seen = new Set();
  return all
    .filter(item => { const k = item.title.slice(0,25); if(seen.has(k)) return false; seen.add(k); return true; })
    .sort((a,b) => (new Date(b.pubDate)||0) - (new Date(a.pubDate)||0))
    .slice(0, 50)
    .map(item => ({
      headline:  item.title.slice(0, 60),
      summary:   (item.description || item.title).slice(0, 150),
      source:    item.source.label.startsWith('cnyes') ? '鉅亨網'
               : item.source.label.startsWith('moneydj') ? 'MoneyDJ'
               : 'Yahoo Finance',
      time:      relTime(item.pubDate),
      pubDate:   item.pubDate,
      link:      item.link,
      tags:      item.source.tags,
      sentiment: 'neu'
    }));
}

const server = http.createServer(async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = urlMod.parse(req.url).pathname;

  if (path === '/news' && req.method === 'GET') {
    try {
      const news = await fetchAllNews();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, news, total: news.length, updated: new Date().toISOString() }));
      console.log(`[${new Date().toLocaleTimeString()}] /news → ${news.length} 則`);
    } catch(e) {
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

server.listen(PORT, () => console.log(`✅ Proxy 已啟動 port ${PORT}`));

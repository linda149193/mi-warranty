// 從小米台灣官網抓取售後政策,輸出 public/data.json
const fs = require('fs'), path = require('path'), cheerio = require('cheerio');
const BASE = 'https://www.mi.com';
const INDEX = BASE + '/tw/service/exchange/';
const OUT = path.join(__dirname, 'public', 'data.json');
const txt = s => (s || '').replace(/\s+/g, ' ').trim();

async function get(url, tries = 3) {
  let err;
  for (let n = 1; n <= tries; n++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 mi-warranty-app', 'accept-language': 'zh-TW' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (/You are in line|There are too many people/i.test(t) && !/<table/i.test(t)) throw new Error('官網排隊頁');
      return t;
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 1500 * n)); }
  }
  throw new Error(url + ' -> ' + err.message);
}
const monthsOf = w => {
  if (/無保|不保/.test(w)) return 0;
  let m = w.match(/(\d+)\s*年/); if (m) return +m[1] * 12;
  m = w.match(/(\d+)\s*個?月/); if (m) return +m[1];
  if (/半年/.test(w)) return 6;
  return null;
};

// 一列寫了多個型號(以 / 分隔)時拆成多筆;只處理 Xiaomi / Redmi / POCO 型號,省略品牌的後段補上 Xiaomi
function splitModels(name) {
  if (!/^(Xiaomi|XIAOMI|Redmi|REDMI|POCO)/.test(name) || !name.includes('/')) return [name];
  return name.split(/\s*\/\s*/).map(txt).filter(Boolean).map(p => /^\d/.test(p) ? 'Xiaomi ' + p : p);
}
function parsePage(html, slug, url, prev) {
  const $ = cheerio.load(html);
  const category = txt($('h1').first().text()).replace(/售[後后]政策$/, '') || slug;
  const items = [];
  $('table').each((_, t) => {
    const heads = $(t).find('tr').first().find('th,td').map((_, c) => txt($(c).text())).get();
    if (!heads.some(h => /保固|保修/.test(h))) return;           // 只取保固表
    const wi = heads.findIndex(h => /保固期限|保修期限/.test(h)), ei = heads.findIndex(h => /以換代修/.test(h));
    $(t).find('tr').slice(1).each((_, tr) => {
      const c = $(tr).find('td').map((_, x) => txt($(x).text())).get();
      if (!c.length || c.every(x => !x)) return;
      const name = c[0], warranty = c[wi >= 0 ? wi : 1] || '';
      const img = $(tr).find('img').attr('src') || '';
      if (!name && warranty && items.length) { items[items.length - 1].note += (items[items.length - 1].note ? ';' : '') + warranty; return; }
      if (!name) return;
      for (const nm of splitModels(name)) items.push({ name: nm, warranty, months: monthsOf(warranty), exchange: ei >= 0 ? /[√✓V是]/.test(c[ei] || '') : null,
        note: '', image: img ? new URL(img, BASE).href : (prev.get(nm)?.image || '') });
    });
  });
  const lis = sel => $(sel).map((_, e) => txt($(e).text())).get().filter(Boolean);
  const body = $('body').text().split(/\n/).map(txt).filter(Boolean);
  const grab = re => body.filter(l => /^\d+[\.、]/.test(l)).filter(l => re.test(l)).slice(0, 8);
  return { category, slug, url, items, returnPolicy: grab(/退|換|修|保固/), exclusions: grab(/不在保固|未經|非原廠|天災|人為|序號/) };
}

async function crawlPages(links, prev) {
  const out = [], errors = [];
  for (const [url, label] of links) {
    const o = prev.get(url);
    try {
      const $p = cheerio.load(await get(url));
      const lines = [...new Set($p('li,p,td').map((_, e) => txt($p(e).text())).get().filter(l => l.length > 6 && l.length < 400))].slice(0, 80);
      const title = label || txt($p('h1').first().text());
      if (lines.length < 3) throw new Error('頁面內容過少');
      out.push({ ...(o || {}), url, title: o?.title || title, models: o?.models?.length ? o.models : modelsOf(title), lines, ok: o ? o.ok : true });
    } catch (e) { errors.push('政策頁 ' + url + ': ' + e.message); out.push(o || { url, title: label, models: modelsOf(label), ok: false, services: [] }); }
  }
  return { out, errors };
}

const VIP_INDEX = BASE + '/tw/support/terms/vipservice/';
const modelsOf = t => t.replace(/(VIP\s*)?(尊享服務|服務權益|差異化服務|服務條款|延長保固條款).*$/i, '').split(/\s*[\/&、]\s*|\s+and\s+/i).map(txt).filter(Boolean);
// 讀取尊享服務目錄與各機型頁。頁面結構不明時只存原文行,並保留舊的整理資料。
// 國際聯保:連結列在手機售後頁「國際聯保服務」標題之後
async function crawlIws(oldIws) {
  const html = await get(BASE + '/tw/service/exchange/phone.html');
  const at = html.lastIndexOf('國際聯保服務');
  if (at < 0) throw new Error('手機頁找不到國際聯保區塊');
  const $ = cheerio.load(html.slice(at)), links = new Map();
  $('a[href]').each((_, a) => { const u = new URL($(a).attr('href'), BASE).href.replace(/\/$/, ''); if (/\/tw\/(support|service\/support)\//.test(u)) links.set(u, txt($(a).text())); });
  const prev = new Map((oldIws || []).map(v => [v.url.replace(/\/$/, ''), v]));
  const r = await crawlPages(links, prev);
  return { iws: r.out, errors: r.errors };
}
async function crawlVip(oldVip) {
  const prev = new Map((oldVip || []).map(v => [v.url.replace(/\/$/, ''), v]));
  const $ = cheerio.load(await get(VIP_INDEX));
  const links = new Map();
  $('a[href]').each((_, a) => {
    const h = $(a).attr('href'); if (!h) return;
    const u = new URL(h, BASE).href.replace(/\/$/, '');
    if (/\/tw\/(support\/(terms|policy)|service\/support)\//.test(u) && !/vipservice$/.test(u)) links.set(u, txt($(a).text()));
  });
  const r = await crawlPages(links, prev);
  return { vip: r.out, errors: r.errors };
}


async function run() {
  let old = { categories: [] };
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'images.json'), 'utf8')); } catch {}
  const prev = new Map(old.categories.flatMap(c => c.items.map(i => [i.name, i])));
  const oldBySlug = new Map(old.categories.map(c => [c.slug, c]));
  const $ = cheerio.load(await get(INDEX));
  const links = new Map();
  $('a[href*="/service/exchange/"]').each((_, a) => {
    const h = decodeURI($(a).attr('href'));
    const m = h.match(/\/service\/exchange\/([^\/]+)\.html$/);
    if (m && !/xiazai/.test(m[1])) links.set(m[1], new URL(h, BASE).href);
  });
  const categories = [], errors = [];
  for (const [slug, url] of links) {
    try {
      const c = parsePage(await get(url), slug, url, prev);
      const o = oldBySlug.get(slug);
      if (o) { c.icon = o.icon; if (!c.returnPolicy.length) c.returnPolicy = o.returnPolicy; if (!c.exclusions.length) c.exclusions = o.exclusions; if (c.category === slug) c.category = o.category; }
      if (!c.items.length || (o && c.items.length < o.items.length * 0.5)) {
        if (o) { c.items = o.items; errors.push(slug + ': 解析結果異常(筆數過少),沿用舊資料'); } else errors.push(slug + ': 新類別解析不到表格');
      }
      categories.push(c);
    } catch (e) { errors.push(slug + ': ' + e.message); if (oldBySlug.has(slug)) categories.push(oldBySlug.get(slug)); }
  }
  for (const c of categories) for (const i of c.items) if (overrides[i.name]) i.image = overrides[i.name];
  const count = cs => cs.reduce((n, c) => n + c.items.length, 0);
  const oldN = count(old.categories), newN = count(categories);
  if (!categories.length || (oldN && newN < oldN * 0.7)) throw new Error(`抓到 ${newN} 筆,遠少於舊資料 ${oldN} 筆,疑似官網改版或被擋,保留舊資料`);
  const oldNames = new Set([...prev.keys()]), newNames = new Set(categories.flatMap(c => c.items.map(i => i.name)));
  const addedItems = [...newNames].filter(n => !oldNames.has(n)), removedItems = [...oldNames].filter(n => !newNames.has(n));
  const known = new Set(old.categories.map(c => c.slug));
  let vip = old.vip || [];
  try { const r = await crawlVip(old.vip); if (r.vip.length >= (old.vip || []).length * 0.7) vip = r.vip; else errors.push('尊享服務目錄筆數異常,沿用舊資料'); errors.push(...r.errors); }
  catch (e) { errors.push('尊享服務目錄: ' + e.message); }
  let iws = old.iws || [];
  try { const r = await crawlIws(old.iws); if (r.iws.length >= (old.iws || []).length * 0.7) iws = r.iws; else errors.push('國際聯保筆數異常,沿用舊資料'); errors.push(...r.errors); }
  catch (e) { errors.push('國際聯保: ' + e.message); }
  const addedVip = vip.filter(v => !(old.vip || []).some(o => o.url.replace(/\/$/, '') === v.url.replace(/\/$/, ''))).map(v => v.title);
  const out = { ...old, vip, iws, updatedAt: new Date().toISOString(), source: INDEX, categories };
  const changed = JSON.stringify(old.categories) !== JSON.stringify(categories) || JSON.stringify(old.vip) !== JSON.stringify(vip) || JSON.stringify(old.iws) !== JSON.stringify(iws);
  if (changed) { out.changelog = [{ at: out.updatedAt, added: addedItems, removed: removedItems }, ...(old.changelog || [])].slice(0, 30); fs.writeFileSync(OUT, JSON.stringify(out)); }
  return { addedVip, changed, categories: categories.length, items: newN, addedItems, removedItems, newCategories: categories.filter(c => !known.has(c.slug)).map(c => c.category), errors };
}
module.exports = { run, parsePage, splitModels };
if (require.main === module) run().then(r => console.log(r)).catch(e => { console.error(e.message); process.exit(1); });

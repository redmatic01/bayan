// bayan — карманная коллекция анекдотов. Worker: API + статика (assets binding).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, url, env);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  // Ежедневный крон 04:00 UTC (07:00 МСК, см. wrangler.toml). Тихо добирает
  // очередь до QUEUE_CAP — без уведомлений, результат виден бейджем в «Разборе».
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyTopUp(env));
  },
};

const QUEUE_CAP = 40;

async function queuedCount(env) {
  return env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status='queued'").first('n');
}

async function dailyTopUp(env) {
  if ((await queuedCount(env)) >= QUEUE_CAP) return; // уже полно — источники не трогаем
  const sources = await getSources(env);
  const status = (await getConfig(env, 'filter_enabled')) === '1' ? 'raw' : 'queued';
  for (const src of sources) {
    if (!PARSERS[src.type]) continue; // архивные тег-источники крон не трогает
    try {
      const texts = await PARSERS[src.type](src.url);
      for (const t of texts) await insertItem(env, t, src.name, status);
    } catch {
      // источник недоступен этой ночью — идём дальше, как и ручная кнопка
    }
    if ((await queuedCount(env)) >= QUEUE_CAP) break; // без обрезки — берём источник целиком
  }
}

async function route(request, url, env) {
  const p = url.pathname;
  const m = request.method;

  if (p === '/api/bank' && m === 'GET') {
    const { results } = await env.DB.prepare(
      "SELECT id, text, tags, source, decided_at FROM items WHERE status='bank' ORDER BY decided_at DESC, id DESC"
    ).all();
    return json({ items: results });
  }

  if (p === '/api/queue' && m === 'GET') {
    // Фильтр по кластеру: кластер лежит первым тегом в items.tags (ставится при загрузке тег-источника).
    // «прочее» — всё, где ни одного известного кластера (старые источники, ручные добавления).
    const clusters = await knownClusters(env);
    const want = url.searchParams.get('cluster') || '';
    const hasCl = (c) => `(',' || tags || ',') LIKE '%,' || ? || ',%'`;
    let where = "status='queued'", binds = [];
    if (want === 'прочее') {
      where += clusters.map(() => ` AND NOT ${hasCl()}`).join('');
      binds = [...clusters];
    } else if (want) {
      where += ` AND ${hasCl()}`;
      binds = [want];
    }
    const { results } = await env.DB.prepare(
      `SELECT id, text, source, tags, created_at FROM items WHERE ${where} ORDER BY id LIMIT 200`
    ).bind(...binds).all();
    const matching = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${where}`).bind(...binds).first('n');
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status='queued'").first('n');
    // счётчики по кластерам для чипов — по одному дешёвому GROUP BY
    const { results: grp } = await env.DB.prepare("SELECT tags, COUNT(*) AS n FROM items WHERE status='queued' GROUP BY tags").all();
    const counts = Object.fromEntries(clusters.map((c) => [c, 0]));
    let other = 0;
    for (const g of grp) {
      const set = (g.tags || '').split(',').map((s) => s.trim());
      const hit = clusters.filter((c) => set.includes(c));
      if (hit.length) for (const c of hit) counts[c] += g.n;
      else other += g.n;
    }
    return json({ items: results, total, matching, clusters: counts, other });
  }

  if (p === '/api/decide' && m === 'POST') {
    const body = await request.json();
    const action = body.action === 'approve' ? 'bank' : body.action === 'reject' ? 'rejected' : null;
    if (!action || !body.id) return json({ error: 'bad request' }, 400);
    const r = await env.DB.prepare(
      "UPDATE items SET status=?, decided_at=datetime('now') WHERE id=? AND status='queued'"
    ).bind(action, body.id).run();
    return json({ ok: true, changed: r.meta.changes });
  }

  if (p === '/api/add' && m === 'POST') {
    const body = await request.json();
    const text = String(body.text || '').trim();
    if (text.length < 5) return json({ error: 'text too short' }, 400);
    const status = (await getConfig(env, 'filter_enabled')) === '1' ? 'raw' : 'queued';
    const added = await insertItem(env, text, String(body.source || 'user/manual'), status);
    return json({ ok: true, added });
  }

  if (p === '/api/sources' && m === 'GET') {
    return json({ sources: await getSources(env) });
  }

  if (p === '/api/ingest' && m === 'POST') {
    const body = await request.json().catch(() => ({}));
    const sources = await getSources(env);
    const idx = Number(body.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= sources.length) return json({ error: 'bad index' }, 400);
    const src = sources[idx];
    // тег-источники — конечные топы, живут только под «Архивом»; «свежих» у них не бывает
    if (!PARSERS[src.type]) return json({ source: src.name, found: 0, added: 0, skipped: true });
    const status = (await getConfig(env, 'filter_enabled')) === '1' ? 'raw' : 'queued';
    let texts = [];
    try {
      texts = await PARSERS[src.type](src.url);
    } catch (e) {
      return json({ source: src.name, error: String(e && e.message || e), found: 0, added: 0 });
    }
    let added = 0;
    for (const t of texts) if (await insertItem(env, t, src.name, status)) added++;
    return json({ source: src.name, found: texts.length, added });
  }

  // Ручная догрузка архива — отдельно от «принести свежих» и от ночного крона,
  // никак не завязана на QUEUE_CAP: жмёт пользователь, когда сам решит.
  if (p === '/api/archive' && m === 'POST') {
    const body = await request.json().catch(() => ({}));
    const sources = await getSources(env);
    const idx = Number(body.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= sources.length) return json({ error: 'bad index' }, 400);
    const src = sources[idx];
    const walker = ARCHIVE_PARSERS[src.type];
    if (!walker) return json({ source: src.name, error: 'no archive for this source', added: 0 });
    try {
      const { added, done } = await walker(env, src);
      return json({ source: src.name, added, done });
    } catch (e) {
      return json({ source: src.name, error: String(e && e.message || e), added: 0 });
    }
  }

  if (p === '/api/stats' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all();
    return json({ stats: Object.fromEntries(results.map((r) => [r.status, r.n])) });
  }

  return json({ error: 'not found' }, 404);
}

// ---------- helpers ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function getConfig(env, key) {
  const v = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind(key).first('value');
  return v == null ? '' : v;
}

async function setConfig(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, value).run();
}

async function getSources(env) {
  try {
    return JSON.parse(await getConfig(env, 'sources')) || [];
  } catch {
    return [];
  }
}

// Кластеры = уникальные cluster у источников (персонажи, отношения, работа…).
async function knownClusters(env) {
  return [...new Set((await getSources(env)).map((s) => s.cluster).filter(Boolean))];
}

// Нормализация для дедупа: только буквы и цифры, нижний регистр, ё=е.
function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function insertItem(env, text, source, status, tags = '') {
  const clean = text.trim();
  if (clean.length < 20 || clean.length > 4000) return false;
  const hash = await sha256hex(normalize(clean));
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO items (text, hash, source, status, tags) VALUES (?,?,?,?,?)'
  ).bind(clean, hash, source, status, tags).run();
  return r.meta.changes > 0;
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (mm, n) => named[n.toLowerCase()] ?? mm);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const UA = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) bayan-pwa/1.0' };

// stihi.ru отдаёт страницы в windows-1251 без charset в заголовке — Response.text()
// всегда декодирует как UTF-8, поэтому тут нужен ручной TextDecoder.
async function fetchWin1251(url) {
  const buf = await (await fetch(url, { headers: UA })).arrayBuffer();
  return new TextDecoder('windows-1251').decode(buf);
}

// Внутри одной публикации авторы иногда склеивают несколько коротких
// стихов через строку-разделитель «---» — режем на отдельные карточки,
// иначе одна карточка растягивается на десяток четверостиший.
function splitOnDashRule(text) {
  return text
    .split(/\n[ \t]*-{3,}[ \t]*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- parsers ----------

const PARSERS = {
  // RSS anekdot.ru: <description><![CDATA[текст с <br>]]></description>
  async anekdotru(url) {
    const xml = await (await fetch(url, { headers: UA })).text();
    const out = [];
    for (const m of xml.matchAll(/<description>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/description>/g)) {
      const raw = m[1] ?? m[2] ?? '';
      const t = htmlToText(raw);
      if (t) out.push(t);
    }
    // первый <description> — описание канала, выкидываем
    return out.slice(1);
  },

  // Веб-зеркало публичного Telegram-канала t.me/s/<name>
  async tme(url) {
    const html = await (await fetch(url, { headers: UA })).text();
    const out = [];
    for (const m of html.matchAll(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
      const t = htmlToText(m[1]);
      // служебные сообщения зеркала ("Channel name was changed…") — не контент
      if (t && !/^Channel (name|photo|was)/i.test(t)) out.push(t);
    }
    return out;
  },

  // stihi.ru: url — страница автора (https://stihi.ru/avtor/<slug>).
  // Обходит список его произведений, из каждого забирает <div class="text">
  // и режет по «---» на отдельные короткие вещи.
  async stihiru(url) {
    const authorHtml = await fetchWin1251(url);
    const links = new Set();
    for (const m of authorHtml.matchAll(/href="(\/\d{4}\/\d{2}\/\d{2}\/\d+)"/g)) links.add(m[1]);

    const out = [];
    for (const path of links) {
      const html = await fetchWin1251(`https://stihi.ru${path}`);
      const m = html.match(/class="text">([\s\S]*?)<\/div>/);
      if (!m) continue;
      const text = htmlToText(m[1]);
      out.push(...splitOnDashRule(text));
    }
    return out;
  },
};

// ---------- обходчики архива (кнопка «Добрать архив», не связаны с PARSERS/крон-топ-апом) ----------
// Курсор «докуда дошли» лежит в config под ключом archive_cursor:<имя источника>,
// чтобы каждое нажатие продолжало с прошлого места, а не перечёсывало то же самое.

const ARCHIVE_DAYS_PER_RUN = 14; // за один заход по кнопке — не упереться в лимит времени воркера
const ARCHIVE_DEPTH_DAYS = 365;  // «последний год», см. договорённость с пользователем
const ARCHIVE_TME_PAGES_PER_RUN = 5; // ~20 сообщений на страницу зеркала → ~100 за заход

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// anekdot.ru: архив по дням — https://www.anekdot.ru/release/anekdot/day/YYYY-MM-DD/.
// Курсор — дата последнего уже обработанного дня, шагаем назад.
async function archiveAnekdotru(env, src) {
  const cursorKey = 'archive_cursor:' + src.name;
  const cur = await getConfig(env, cursorKey);
  const day = cur ? new Date(cur + 'T00:00:00Z') : new Date();
  if (!cur) day.setUTCDate(day.getUTCDate() - 1); // курсора ещё нет — начинаем со вчера (сегодня уже покрыт «Принести свежих»)

  const limit = new Date();
  limit.setUTCDate(limit.getUTCDate() - ARCHIVE_DEPTH_DAYS);

  const status = (await getConfig(env, 'filter_enabled')) === '1' ? 'raw' : 'queued';
  let added = 0, done = false;

  for (let i = 0; i < ARCHIVE_DAYS_PER_RUN; i++) {
    if (day < limit) { done = true; break; }
    const ds = fmtDate(day);
    try {
      const html = await (await fetch(`https://www.anekdot.ru/release/anekdot/day/${ds}/`, { headers: UA })).text();
      for (const m of html.matchAll(/<div class="topicbox"[^>]*data-t="j"[^>]*>\s*<div class="text">([\s\S]*?)<\/div>/g)) {
        const t = htmlToText(m[1]);
        if (t && await insertItem(env, t, src.name, status)) added++;
      }
    } catch {
      // этот день не отдался — идём дальше, курсор всё равно продвинется
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  await setConfig(env, cursorKey, fmtDate(day));
  return { added, done };
}

// Веб-зеркало Telegram: постранично назад через ?before=<id>.
// Курсор — минимальный увиденный id; пустая страница = дошли до начала канала.
async function archiveTme(env, src) {
  const cursorKey = 'archive_cursor:' + src.name;
  let before = await getConfig(env, cursorKey);
  const status = (await getConfig(env, 'filter_enabled')) === '1' ? 'raw' : 'queued';
  let added = 0, done = false;

  for (let i = 0; i < ARCHIVE_TME_PAGES_PER_RUN; i++) {
    const pageUrl = before ? `${src.url}?before=${before}` : src.url;
    let html;
    try {
      html = await (await fetch(pageUrl, { headers: UA })).text();
    } catch {
      break; // сеть подвела — сохраним курсор там, где остановились, попробуем в другой раз
    }
    const ids = [...html.matchAll(/data-post="[^"]+\/(\d+)"/g)].map((mm) => Number(mm[1]));
    if (!ids.length) { done = true; break; } // дальше зеркало ничего не отдаёт — начало канала

    for (const m of html.matchAll(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
      const t = htmlToText(m[1]);
      if (t && !/^Channel (name|photo|was)/i.test(t) && await insertItem(env, t, src.name, status)) added++;
    }
    before = String(Math.min(...ids));
  }
  if (before) await setConfig(env, cursorKey, before);
  return { added, done };
}

// Тег anekdot.ru: src.url = https://www.anekdot.ru/tags/<slug>/, src.pages — сколько страниц
// топа брать (≈50 анекдотов на страницу), src.cluster — пишется первым тегом в items.tags.
// ?type=anekdots отсекает истории/афоризмы с того же тега, ?sort=sum — по сумме голосов.
// Курсор — номер следующей страницы; done, когда страницы кончились.
async function archiveAnekdotruTag(env, src) {
  const cursorKey = 'archive_cursor:' + src.name;
  const maxPages = Math.max(1, Number(src.pages) || 1);
  let page = Number(await getConfig(env, cursorKey)) || 1;
  if (page > maxPages) return { added: 0, done: true };

  const status = (await getConfig(env, 'filter_enabled')) === '1' ? 'raw' : 'queued';
  const tags = src.cluster || '';
  let added = 0;
  const pageUrl = `${src.url}${page > 1 ? page + '/' : ''}?type=anekdots&sort=sum`;
  const html = await (await fetch(pageUrl, { headers: UA })).text();
  for (const m of html.matchAll(/<div class="topicbox"[^>]*data-t="j"[^>]*>\s*<div class="text">([\s\S]*?)<\/div>/g)) {
    const t = htmlToText(m[1]);
    if (t && await insertItem(env, t, src.name, status, tags)) added++;
  }
  page++;
  await setConfig(env, cursorKey, String(page));
  return { added, done: page > maxPages };
}

const ARCHIVE_PARSERS = {
  anekdotru: archiveAnekdotru,
  tme: archiveTme,
  anekdotru_tag: archiveAnekdotruTag,
  // stihiru сознательно нет — у автора конечный список произведений, уже весь разобран целиком.
};

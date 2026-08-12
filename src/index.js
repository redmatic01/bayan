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
};

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
    const { results } = await env.DB.prepare(
      "SELECT id, text, source, created_at FROM items WHERE status='queued' ORDER BY id LIMIT 200"
    ).all();
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status='queued'").first('n');
    return json({ items: results, total });
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

async function getSources(env) {
  try {
    return JSON.parse(await getConfig(env, 'sources')) || [];
  } catch {
    return [];
  }
}

// Нормализация для дедупа: только буквы и цифры, нижний регистр, ё=е.
function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function insertItem(env, text, source, status) {
  const clean = text.trim();
  if (clean.length < 20 || clean.length > 4000) return false;
  const hash = await sha256hex(normalize(clean));
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO items (text, hash, source, status) VALUES (?,?,?,?)'
  ).bind(clean, hash, source, status).run();
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

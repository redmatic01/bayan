-- Схема идемпотентна: выполняется при каждом деплое.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT '',
  -- raw -> queued -> bank | rejected; filtered_out — отсев будущего семантического фильтра
  status TEXT NOT NULL DEFAULT 'queued',
  tags TEXT NOT NULL DEFAULT '',
  score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO config (key, value) VALUES ('filter_enabled', '0');
INSERT OR IGNORE INTO config (key, value) VALUES ('filter_prompt', '');
INSERT OR IGNORE INTO config (key, value) VALUES ('sources', '[{"type": "anekdotru", "name": "anekdot.ru", "url": "https://www.anekdot.ru/rss/export_j.xml"}, {"type": "tme", "name": "t.me/baneks", "url": "https://t.me/s/baneks"}, {"type": "tme", "name": "t.me/anekdotiki", "url": "https://t.me/s/anekdotiki"}, {"type": "stihiru", "name": "stihi.ru/danila08", "url": "https://stihi.ru/avtor/danila08"}]');

-- Первый анекдот коллекции — через очередь, как договаривались.
INSERT OR IGNORE INTO items (text, hash, source, status) VALUES (
  'В лагере с подругой всем зачем-то по приколу сказали, что мы брат с сестрой и очень убедительно отыгрывали, все умилялись. День на третий стало скучно и решили устроить дружеский секс. В процессе прелюдий вошла соседка и с криком «О, ГОСПОДИ» и психологической травмой убежала.',
  'a7f45a2871ed1f8f01b3cd9206b83c33c96e5bb9ad1777a7ed736ff33bf0a20f',
  'user/telegram',
  'queued'
);

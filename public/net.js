/**
 * Sunucu ile iletisim: REST istekleri + olay akisi.
 *
 * Netlify'da kalici WebSocket yoktur; bunun yerine "bekleyen yoklama" kullanilir:
 * istek olay gelene kadar (en cok 6 sn) acik tutulur, olay gelince aninda doner.
 * Boylece mesaj gecikmesi yarim saniye civarinda kalir, bos beklemede istek az olur.
 */

let token = localStorage.getItem('edge.token') || null;

export const getToken = () => token;

export function setToken(value) {
  token = value;
  if (value) localStorage.setItem('edge.token', value);
  else localStorage.removeItem('edge.token');
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || 'Beklenmeyen bir hata olustu.');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p)
};

/* ---- olay akisi ---- */

const listeners = new Set();
let cursor = '';
let running = false;
let failures = 0;
let urgent = false;      // gorusme sirasinda sinyaller icin daha sik yoklama

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error(err); }
  }
}

export function setUrgent(value) {
  urgent = Boolean(value);
}

async function loop() {
  while (running && token) {
    try {
      const wait = document.hidden && !urgent ? 8 : 6;
      const res = await api.get(`/api/events?wait=${wait}&cursor=${encodeURIComponent(cursor)}`);
      cursor = res.cursor || cursor;
      failures = 0;
      for (const event of res.events) emit(event);
      if (!res.events.length && !urgent) await sleep(200);
    } catch (err) {
      if (err.status === 401) { emit({ type: 'session:invalid' }); return; }
      failures = Math.min(failures + 1, 5);
      await sleep(500 * 2 ** failures);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startEvents() {
  if (running) return;
  running = true;
  loop();
}

export function stopEvents() {
  running = false;
  cursor = '';
}

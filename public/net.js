/** REST istekleri ve gercek zamanli baglanti. */

let token = localStorage.getItem('edge.token') || null;

export function getToken() {
  return token;
}

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

/* ---- WebSocket ---------------------------------------------------- */

let socket = null;
let retry = 0;
const listeners = new Set();

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error(err); }
  }
}

export function connect() {
  if (!token || (socket && socket.readyState <= 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.addEventListener('open', () => { retry = 0; emit({ type: 'socket:open' }); });
  socket.addEventListener('message', (e) => {
    try { emit(JSON.parse(e.data)); } catch { /* yoksay */ }
  });
  socket.addEventListener('close', () => {
    socket = null;
    emit({ type: 'socket:close' });
    if (!token) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** (retry - 1));
  });
}

export function disconnect() {
  if (socket) {
    const s = socket;
    socket = null;
    s.close();
  }
}

export function socketSend(payload) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
}

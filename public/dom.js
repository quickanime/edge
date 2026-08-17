/** Kucuk DOM yardimcilari — metin her zaman textContent ile basilir. */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(path, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

export const ICONS = {
  send: 'M4 12l16-8-6 16-3-6-7-2z',
  lock: 'M6 11V8a6 6 0 0112 0v3M5 11h14v10H5z',
  check: 'M5 12l4 4 10-10',
  plus: 'M12 5v14M5 12h14',
  users: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 7.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M17 11a3 3 0 100-6M21 19v-1a4 4 0 00-3-3.9',
  chat: 'M4 5h16v11H8l-4 4V5z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  pencil: 'M4 20h4l11-11-4-4L4 16v4z',
  gear: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  back: 'M15 6l-6 6 6 6'
};

export function initials(text) {
  const clean = String(text || '?').trim();
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
  return clean.slice(0, 2);
}

export function avatar(name, { size = '', accent = false } = {}) {
  const cls = ['avatar', size, accent ? 'avatar-accent' : ''].filter(Boolean).join(' ');
  return h('span', { class: cls, text: initials(name) });
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/* ---- tarih / saat ---- */

const pad = (n) => String(n).padStart(2, '0');

export function timeShort(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Bugun';
  if (same(d, yesterday)) return 'Dun';
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'simdi';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} dk`;
  if (diff < 86400000) return timeShort(ts);
  if (diff < 7 * 86400000) return new Date(ts).toLocaleDateString('tr-TR', { weekday: 'short' });
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

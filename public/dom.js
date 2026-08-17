/** Kucuk DOM yardimcilari — metin her zaman textContent ile basilir. */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
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
  for (const d of [].concat(path)) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  send: 'M4 12l16-8-6 16-3-6-7-2z',
  lock: 'M6 11V8a6 6 0 0112 0v3M5 11h14v10H5z',
  check: 'M5 12l4 4 10-10',
  checks: ['M2 12l4 4 8-9', 'M11 16l1.5 1.5L22 8'],
  plus: 'M12 5v14M5 12h14',
  users: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 7.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M17 11a3 3 0 100-6M21 19v-1a4 4 0 00-3-3.9',
  chat: 'M4 5h16v11H8l-4 4V5z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  pencil: 'M4 20h4l11-11-4-4L4 16v4z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  back: 'M15 6l-6 6 6 6',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z',
  video: 'M3 7h11v10H3zM14 11l7-4v10l-7-4z',
  hangup: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1zM19 3L3 19',
  mic: 'M12 4a3 3 0 013 3v4a3 3 0 01-6 0V7a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4',
  micOff: ['M12 4a3 3 0 013 3v3M9 9v2a3 3 0 004.5 2.6M6 11a6 6 0 009 5.2M12 17v4', 'M4 3l16 18'],
  cam: 'M3 7h11v10H3zM14 11l7-4v10l-7-4z',
  camOff: ['M3 7h8v10H3zM21 7v10l-6-4', 'M3 3l18 18'],
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4M9 11l3-3 3 3',
  image: 'M4 5h16v14H4zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3M5 17l5-5 3 3 2-2 4 4',
  timer: 'M12 8v5l3 2M4 12a8 8 0 1016 0 8 8 0 10-16 0M9 2h6',
  link: 'M9 15l6-6M8 8H6a4 4 0 000 8h2M16 16h2a4 4 0 000-8h-2',
  calendar: 'M4 6h16v14H4zM8 3v4M16 3v4M4 11h16',
  pulse: 'M3 12h4l2-6 3 12 2-6h5',
  friends: 'M15 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M8.5 6.5a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M18 8v6M15 11h6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7M12 15a3 3 0 100-6 3 3 0 000 6',
  camera: 'M4 8h3l2-2h6l2 2h3v11H4zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7'
};

export function initials(text) {
  const clean = String(text || '?').trim();
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
  return clean.slice(0, 2);
}

/** Profil fotosu varsa gorseli, yoksa bas harfleri gosterir. */
export function avatarNode(name, image, { size = '', accent = false, online = null } = {}) {
  const cls = ['avatar', size, accent && !image ? 'avatar-accent' : ''].filter(Boolean).join(' ');
  const node = h('span', { class: cls }, [
    image ? h('img', { src: image, alt: '', loading: 'lazy' }) : h('span', { text: initials(name) })
  ]);
  if (online !== null) {
    node.classList.add('has-presence');
    node.append(h('i', { class: `presence${online ? ' is-online' : ''}` }));
  }
  return node;
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

export function dateTimeLabel(ts) {
  return new Date(ts).toLocaleString('tr-TR', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

export function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function durationLabel(seconds) {
  if (!seconds) return 'kapali';
  if (seconds < 60) return `${seconds} sn`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} saat`;
  return `${Math.round(seconds / 86400)} gun`;
}

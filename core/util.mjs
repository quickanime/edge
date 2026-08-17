import crypto from 'node:crypto';

export const now = () => Date.now();
export const id = () => crypto.randomBytes(16).toString('hex');
export const token = () => crypto.randomBytes(32).toString('base64url');
export const seq = () => `${String(now()).padStart(14, '0')}-${crypto.randomBytes(3).toString('hex')}`;

export function hashAuth(authHash, salt) {
  return crypto.scryptSync(authHash, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export const NICK_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
export const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function longText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

export function isB64(value, maxLen = 300000) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen &&
    /^[A-Za-z0-9+/_=-]+$/.test(value);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (m) => new HttpError(400, m);
export const denied = (m) => new HttpError(403, m);
export const missing = (m) => new HttpError(404, m);

/* Davet linkleri icin okunabilir kisa kimlikler: edgeishere.netlify.app/vertex */
const WORDS = [
  'vertex', 'orbit', 'delta', 'nova', 'prism', 'quartz', 'zenit', 'kobalt', 'atlas', 'lumen',
  'ember', 'flux', 'onyx', 'pulsar', 'raven', 'solstis', 'tundra', 'vektor', 'zefir', 'kuvars',
  'aurora', 'basalt', 'sinyal', 'kestrel', 'meridyen', 'nebula', 'obsidyen', 'pergel', 'radyan', 'safir'
];

export function slugCandidate(index = 0) {
  const word = WORDS[crypto.randomInt(WORDS.length)];
  return index === 0 ? word : `${word}-${crypto.randomInt(100, 999)}`;
}

export const PERMS = ['members', 'groups', 'tasks', 'meetings', 'invites'];

export function normalizePerms(input, fallback = false) {
  const out = {};
  for (const key of PERMS) {
    out[key] = input && typeof input === 'object' ? Boolean(input[key]) : fallback;
  }
  return out;
}

/** Sirket sahibi her seyi yapar; yoneticinin izinleri tek tek ayarlanir. */
export function can(company, userId, perm) {
  const member = company.members.find((m) => m.userId === userId);
  if (!member) return false;
  if (member.role === 'owner') return true;
  if (member.role !== 'admin') return false;
  return Boolean(member.perms && member.perms[perm]);
}

export function memberOf(company, userId) {
  return company.members.find((m) => m.userId === userId) || null;
}

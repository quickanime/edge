/**
 * Guvenlik yardimcilari: girdi dogrulama, hiz sinirlama, kimlik sizdirmama.
 *
 * Ilke: sunucuya gelen her kimlik ve her sayac denetlenir; hicbir kullanici
 * girdisi dogrudan depo anahtarina ya da yanit govdesine gecmez.
 */

import crypto from 'node:crypto';
import { HttpError, bad } from './util.mjs';

export const HEX32 = /^[0-9a-f]{32}$/;
export const SLUG = /^[a-z0-9-]{3,32}$/;

/** Depo anahtarina girecek her kimlik bu suzgecten gecer. */
export function assertId(value, label = 'kimlik') {
  const text = String(value == null ? '' : value);
  if (!HEX32.test(text)) throw bad(`Gecersiz ${label}.`);
  return text;
}

export function assertSlug(value) {
  const text = String(value == null ? '' : value).toLowerCase();
  if (!SLUG.test(text)) throw bad('Gecersiz link kimligi.');
  return text;
}

export function assertRoom(value) {
  const text = String(value == null ? '' : value);
  const match = /^(conv|meet):([0-9a-f]{32})$/.exec(text);
  if (!match) throw bad('Gecersiz gorusme odasi.');
  return { kind: match[1], id: match[2], roomId: text };
}

/** Nick bicimi ve uzunluk denetimi (arama/parametre girdileri icin). */
export function assertNickish(value, max = 24) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max) throw bad('Gecersiz kullanici adi.');
  return text;
}

/* ------------------------------------------------------------------ */
/* hiz sinirlama                                                       */
/* ------------------------------------------------------------------ */

/**
 * Kayan pencere. Sayaclar depoda tutulur; boylece sunucusuz ortamda
 * ornekler arasinda da gecerli olur.
 */
export function createLimiter(store) {
  return async function limit(bucket, { max, windowMs, message }) {
    if (!bucket) return;
    const key = `rl/${bucket}`;
    const stamp = Date.now();
    const record = (await store.get(key)) || { hits: [] };
    const hits = (record.hits || []).filter((t) => stamp - t < windowMs).slice(-max);

    if (hits.length >= max) {
      const retry = Math.ceil((windowMs - (stamp - hits[0])) / 1000);
      throw new HttpError(429, message || `Cok fazla istek. ${retry} saniye sonra tekrar dene.`);
    }
    hits.push(stamp);
    await store.set(key, { hits });
  };
}

export const LIMITS = {
  login:      { max: 8,   windowMs: 300000, message: 'Cok fazla hatali giris. Birkac dakika sonra tekrar dene.' },
  loginIp:    { max: 40,  windowMs: 300000, message: 'Cok fazla giris denemesi.' },
  register:   { max: 6,   windowMs: 900000, message: 'Cok fazla kayit denemesi.' },
  search:     { max: 90,  windowMs: 60000 },
  friend:     { max: 40,  windowMs: 3600000, message: 'Cok fazla arkadaslik istegi.' },
  join:       { max: 30,  windowMs: 3600000, message: 'Cok fazla katilma denemesi.' },
  message:    { max: 240, windowMs: 60000, message: 'Cok hizli mesaj gonderiyorsun.' },
  upload:     { max: 40,  windowMs: 300000, message: 'Cok fazla dosya yukleme.' },
  company:    { max: 12,  windowMs: 86400000, message: 'Gunluk sirket olusturma sinirina ulastin.' },
  invite:     { max: 60,  windowMs: 3600000 },
  call:       { max: 400, windowMs: 60000 },
  avatar:     { max: 30,  windowMs: 3600000, message: 'Cok fazla gorsel yukleme.' },
  notice:     { max: 30,  windowMs: 60000 }
};

/* ------------------------------------------------------------------ */
/* kimlik sizdirmama                                                   */
/* ------------------------------------------------------------------ */

/**
 * Sunucu sirri: bilinmeyen nickler icin de tutarli KDF tuzu uretmek icin
 * kullanilir. Boylece "bu nick var mi" sorusu yanit farkindan anlasilmaz.
 */
export async function serverSecret(store) {
  const existing = await store.get('cfg/secret');
  if (existing && existing.value) return existing.value;
  const value = crypto.randomBytes(32).toString('base64');
  await store.set('cfg/secret', { value, createdAt: Date.now() });
  return value;
}

/** Var olmayan kullanici icin sahte ama sabit KDF tuzu. */
export function decoySalt(secret, nick) {
  return crypto.createHmac('sha256', secret).update(`salt|${nick.toLowerCase()}`)
    .digest('base64').slice(0, 24);
}

/** Zamanlama farkini azaltmak icin sabit maliyetli sahte dogrulama. */
export function burnCompare(secret) {
  crypto.scryptSync(secret, 'decoy', 64, { N: 16384, r: 8, p: 1 });
}

/**
 * Edge uctan uca sifreleme katmani.
 *
 * - Kimlik anahtari: ECDH P-256. Acik anahtar sunucuda, gizli anahtar yalnizca
 *   parolayla acilabilen bir zarf icinde saklanir.
 * - Parola sunucuya hic gitmez: kimlik dogrulama icin PBKDF2 turevi gonderilir.
 * - Her mesaj rastgele bir AES-GCM anahtariyla sifrelenir; bu anahtar her alici
 *   icin ECDH + HKDF ile turetilen ortak sirla sarilir.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = crypto.subtle;

const AUTH_ITERS = 250000;
const KDF_ITERS = 250000;

export function b64(bytes) {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let s = '';
  for (const byte of arr) s += String.fromCharCode(byte);
  return btoa(s);
}

export function unb64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function pbkdf2(password, salt, iters, bits = 256) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, bits);
}

/** Sunucuya gonderilen dogrulama turevi — parolanin kendisi degil. */
export async function deriveAuthHash(password, nick) {
  const salt = enc.encode(`edge-auth|${nick.toLowerCase()}`);
  return b64(await pbkdf2(password, salt, AUTH_ITERS));
}

/** Gizli anahtar zarfini acan/kapatan yerel anahtar. */
export async function deriveKek(password, kdfSaltB64, iters = KDF_ITERS) {
  const bits = await pbkdf2(password, unb64(kdfSaltB64), iters);
  return subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function newKdfSalt() {
  return b64(randomBytes(16));
}

export const kdfIters = KDF_ITERS;

export async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const spki = await subtle.exportKey('spki', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64(spki) };
}

export async function sealPrivateKey(privateKey, kek) {
  const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);
  return { iv: b64(iv), ciphertext: b64(ct) };
}

export async function openPrivateKey(blob, kek) {
  const pkcs8 = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.iv) }, kek, unb64(blob.ciphertext)
  );
  return subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/* ---- oturum ici anahtar durumu ---------------------------------- */

let myPrivateKey = null;
const sharedCache = new Map();

export function setPrivateKey(key) {
  myPrivateKey = key;
  sharedCache.clear();
}

export function hasPrivateKey() {
  return myPrivateKey !== null;
}

export function clearKeys() {
  myPrivateKey = null;
  sharedCache.clear();
}

async function sharedKey(peerPublicKeyB64) {
  if (!myPrivateKey) throw new Error('Anahtarlar kilitli.');
  const cached = sharedCache.get(peerPublicKeyB64);
  if (cached) return cached;

  const peer = await subtle.importKey(
    'spki', unb64(peerPublicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, myPrivateKey, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('edge-msg-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  sharedCache.set(peerPublicKeyB64, key);
  return key;
}

/**
 * Metni sifreler ve mesaj anahtarini her uye icin ayri sarar.
 * members: [{ id, publicKey }] — gonderenin kendisi de listede olmali.
 */
export async function encryptMessage(text, members) {
  const raw = randomBytes(32);
  const messageKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, enc.encode(text));

  const keys = [];
  for (const member of members) {
    const sk = await sharedKey(member.publicKey);
    const wrapIv = randomBytes(12);
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, sk, raw);
    keys.push({ userId: member.id, iv: b64(wrapIv), wrapped: b64(wrapped) });
  }

  return { iv: b64(iv), ciphertext: b64(ciphertext), keys };
}

/** message: { iv, ciphertext, key:{iv,wrapped} } — senderPublicKey ile acilir. */
export async function decryptMessage(message, senderPublicKey) {
  if (!message.key) throw new Error('Bu mesaj icin anahtar zarfi yok.');
  const sk = await sharedKey(senderPublicKey);
  const raw = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(message.key.iv) }, sk, unb64(message.key.wrapped)
  );
  const messageKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(message.iv) }, messageKey, unb64(message.ciphertext)
  );
  return dec.decode(plain);
}

/** Acik anahtarin kisa parmak izi — kimlik dogrulamasi icin gosterilir. */
export async function fingerprint(publicKeyB64) {
  const digest = await subtle.digest('SHA-256', unb64(publicKeyB64));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
    .replace(/(.{4})/g, '$1 ').trim();
}

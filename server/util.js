'use strict';

const crypto = require('crypto');

function id() {
  return crypto.randomBytes(16).toString('hex');
}

function token() {
  return crypto.randomBytes(32).toString('base64url');
}

function now() {
  return Date.now();
}

/**
 * Istemci parolayi asla gondermez; PBKDF2 ile turetilmis "auth hash"
 * gonderir. Sunucu onu bir kez daha tuzlayip scrypt ile saklar.
 */
function hashAuth(authHash, salt) {
  return crypto.scryptSync(authHash, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const NICK_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isB64(value, maxLen = 200000) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen &&
    /^[A-Za-z0-9+/_=-]+$/.test(value);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bad(message) {
  return new HttpError(400, message);
}

module.exports = { id, token, now, hashAuth, safeEqual, NICK_RE, cleanText, isB64, HttpError, bad };

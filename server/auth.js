'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { id, token, now, hashAuth, safeEqual, NICK_RE, cleanText, isB64, bad } = require('./util');

const router = express.Router();

const KDF_ITERS = 250000;

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    nick: row.nick,
    displayName: row.display_name,
    publicKey: row.public_key,
    lastSeenAt: row.last_seen_at
  };
}

/**
 * Kayit: sunucu parolayi gormez. Istemci
 *   authHash    = PBKDF2(parola, "edge-auth|nick")
 *   encPrivKey  = AES-GCM(PBKDF2(parola, kdfSalt), pkcs8(privateKey))
 * gonderir. Sunucuda yalnizca acik anahtar ve sifreli gizli anahtar durur.
 */
router.post('/register', (req, res, next) => {
  try {
    const nick = cleanText(req.body.nick, 24);
    const displayName = cleanText(req.body.displayName, 40) || nick;
    const { authHash, kdfSalt, publicKey, encPrivKey } = req.body;

    if (!NICK_RE.test(nick)) {
      throw bad('Nick 3-24 karakter olmali ve yalnizca harf, rakam, _ . - icerebilir.');
    }
    if (!isB64(authHash, 500) || !isB64(kdfSalt, 500) || !isB64(publicKey, 4000)) {
      throw bad('Anahtar bilgileri eksik.');
    }
    if (!encPrivKey || !isB64(encPrivKey.iv, 500) || !isB64(encPrivKey.ciphertext, 20000)) {
      throw bad('Sifreli gizli anahtar eksik.');
    }

    const exists = db.prepare('SELECT 1 FROM users WHERE nick_lower = ?').get(nick.toLowerCase());
    if (exists) throw bad('Bu nick alinmis.');

    const authSalt = crypto.randomBytes(16).toString('base64');
    const userId = id();
    db.prepare(`
      INSERT INTO users (id, nick, nick_lower, display_name, auth_hash, auth_salt,
                         kdf_salt, kdf_iters, public_key, enc_priv_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, nick, nick.toLowerCase(), displayName,
      hashAuth(authHash, authSalt), authSalt,
      kdfSalt, KDF_ITERS, publicKey, JSON.stringify(encPrivKey), now()
    );

    const sessionToken = token();
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(sessionToken, userId, now());

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    res.json({ token: sessionToken, user: publicUser(row), encPrivKey, kdfIters: KDF_ITERS });
  } catch (err) {
    next(err);
  }
});

/** Giris oncesi istemcinin authHash'i uretebilmesi icin KDF parametreleri. */
router.get('/params/:nick', (req, res, next) => {
  try {
    const row = db.prepare('SELECT kdf_salt, kdf_iters FROM users WHERE nick_lower = ?')
      .get(String(req.params.nick || '').toLowerCase());
    if (!row) throw bad('Kullanici bulunamadi.');
    res.json({ kdfSalt: row.kdf_salt, kdfIters: row.kdf_iters });
  } catch (err) {
    next(err);
  }
});

router.post('/login', (req, res, next) => {
  try {
    const nick = String(req.body.nick || '').toLowerCase();
    const { authHash } = req.body;
    const row = db.prepare('SELECT * FROM users WHERE nick_lower = ?').get(nick);
    if (!row || !isB64(authHash, 500) || !safeEqual(hashAuth(authHash, row.auth_salt), row.auth_hash)) {
      throw bad('Nick veya parola hatali.');
    }

    const sessionToken = token();
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
      .run(sessionToken, row.id, now());
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);

    res.json({
      token: sessionToken,
      user: publicUser(row),
      encPrivKey: JSON.parse(row.enc_priv_key),
      kdfSalt: row.kdf_salt,
      kdfIters: row.kdf_iters
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const auth = req.get('authorization') || '';
  db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

/** Route'lar icin oturum kontrolu. */
function authenticate(req, res, next) {
  const auth = req.get('authorization') || '';
  const t = auth.replace(/^Bearer\s+/i, '');
  const row = t && db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(t);
  if (!row) return res.status(401).json({ error: 'Oturum gecersiz.' });
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
  req.user = row;
  next();
}

function userForToken(t) {
  if (!t) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(t) || null;
}

module.exports = { router, authenticate, userForToken, publicUser };

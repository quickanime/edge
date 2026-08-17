/** Istemci kripto akisini Node'da taklit edip tum uc noktalari dener. */
const { subtle } = globalThis.crypto;
const BASE = process.env.EDGE_URL || 'http://127.0.0.1:3000';
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (b) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function pbkdf2(pw, salt, iters = 250000) {
  const base = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, 256);
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || text}`);
  return data;
}

async function makeUser(nick, password) {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = b64(await subtle.exportKey('spki', pair.publicKey));
  const kdfSalt = b64(rand(16));
  const kek = await subtle.importKey('raw', await pbkdf2(password, unb64(kdfSalt)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = rand(12);
  const encPrivKey = {
    iv: b64(iv),
    ciphertext: b64(await subtle.encrypt({ name: 'AES-GCM', iv }, kek, await subtle.exportKey('pkcs8', pair.privateKey)))
  };
  const authHash = b64(await pbkdf2(password, enc.encode(`edge-auth|${nick.toLowerCase()}`)));
  const res = await call('POST', '/auth/register', { nick, authHash, kdfSalt, publicKey, encPrivKey });
  return { nick, password, token: res.token, id: res.user.id, publicKey, privateKey: pair.privateKey };
}

async function shared(priv, peerPub) {
  const peer = await subtle.importKey('spki', unb64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('edge-msg-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptFor(text, members, sender) {
  const raw = rand(32);
  const mk = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = rand(12);
  const ciphertext = b64(await subtle.encrypt({ name: 'AES-GCM', iv }, mk, enc.encode(text)));
  const keys = [];
  for (const m of members) {
    const sk = await shared(sender.privateKey, m.publicKey);
    const wiv = rand(12);
    keys.push({ userId: m.id, iv: b64(wiv), wrapped: b64(await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, sk, raw)) });
  }
  return { iv: b64(iv), ciphertext, keys };
}

async function decryptAs(message, senderPub, me) {
  const sk = await shared(me.privateKey, senderPub);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(message.key.iv) }, sk, unb64(message.key.wrapped));
  const mk = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(message.iv) }, mk, unb64(message.ciphertext)));
}

const ok = (label) => console.log(`  ok  ${label}`);

(async () => {
  const stamp = Date.now().toString(36);
  const ada = await makeUser(`ada_${stamp}`, 'parola12345');
  const kaan = await makeUser(`kaan_${stamp}`, 'parola12345');
  const mert = await makeUser(`mert_${stamp}`, 'parola12345');
  ok('uc kullanici kaydi');

  // giris: parola sunucuya gitmeden authHash ile
  const params = await call('GET', `/auth/params/${ada.nick}`);
  const authHash = b64(await pbkdf2('parola12345', enc.encode(`edge-auth|${ada.nick}`), params.kdfIters));
  const login = await call('POST', '/auth/login', { nick: ada.nick, authHash });
  if (!login.token) throw new Error('giris tokeni yok');
  ok('giris + gizli anahtar zarfi dondu');

  try {
    await call('POST', '/auth/login', { nick: ada.nick, authHash: b64(rand(32)) });
    throw new Error('yanlis parola kabul edildi!');
  } catch (e) { if (!/400/.test(e.message)) throw e; }
  ok('yanlis parola reddedildi');

  // DM
  const dm = (await call('POST', '/api/conversations/dm', { userId: kaan.id }, ada.token)).conversation;
  const payload = await encryptFor('selam kaan, bu mesaj uctan uca sifreli', dm.members, ada);
  await call('POST', `/api/conversations/${dm.id}/messages`, payload, ada.token);
  const inbox = await call('GET', `/api/conversations/${dm.id}/messages`, null, kaan.token);
  const text = await decryptAs(inbox.messages[0], ada.publicKey, kaan);
  if (text !== 'selam kaan, bu mesaj uctan uca sifreli') throw new Error('DM cozulemedi: ' + text);
  ok('DM sifreleme/cozme dogru');

  // sunucu icerigi goremiyor mu?
  if (inbox.messages[0].ciphertext.includes('selam')) throw new Error('duz metin sizdi');
  const outsider = await call('GET', `/api/conversations/${dm.id}/messages`, null, mert.token).catch((e) => e);
  if (!(outsider instanceof Error) || !/403/.test(outsider.message)) throw new Error('yabanci sohbete girdi!');
  ok('yetkisiz erisim engellendi');

  // sirket + grup + gorev
  const company = (await call('POST', '/api/companies', { name: `Edge Studio ${stamp}` }, ada.token)).company;
  await call('POST', `/api/companies/${company.id}/members`, { nick: kaan.nick, role: 'admin' }, ada.token);
  await call('POST', `/api/companies/${company.id}/members`, { nick: mert.nick }, ada.token);
  const group = (await call('POST', `/api/companies/${company.id}/groups`,
    { name: 'Tasarim', description: 'arayuz ekibi', memberIds: [kaan.id, mert.id] }, ada.token)).group;
  ok(`sirket + grup (${group.members.length} uye, kanal ${group.conversationId ? 'acildi' : 'YOK'})`);
  if (!group.conversationId) throw new Error('grup kanali olusmadi');

  // grup mesaji: uc uye de cozebilmeli
  const gconv = (await call('GET', '/api/conversations', null, mert.token)).conversations
    .find((c) => c.id === group.conversationId);
  const gpayload = await encryptFor('ekip, tasarim toplantisi 15:00', gconv.members, ada);
  await call('POST', `/api/conversations/${gconv.id}/messages`, gpayload, ada.token);
  for (const u of [kaan, mert]) {
    const box = await call('GET', `/api/conversations/${gconv.id}/messages`, null, u.token);
    const t = await decryptAs(box.messages[0], ada.publicKey, u);
    if (t !== 'ekip, tasarim toplantisi 15:00') throw new Error(`${u.nick} grup mesajini cozemedi`);
  }
  ok('grup mesajini tum uyeler cozdu');

  // gorevler
  const t1 = (await call('POST', `/api/companies/${company.id}/tasks`,
    { title: 'Logoyu uygula', assigneeGroupId: group.id, priority: 'high', dueDate: '2026-09-01' }, ada.token)).task;
  await call('POST', `/api/companies/${company.id}/tasks`,
    { title: 'Fatura kes', assigneeUserId: mert.id }, ada.token);
  const mine = await call('GET', '/api/tasks/mine', null, mert.token);
  if (mine.tasks.length !== 2) throw new Error('grup+kisi gorevleri gelmedi: ' + mine.tasks.length);
  ok('gruba ve kisiye gorev atama (mert: 2 gorev)');

  await call('PATCH', `/api/tasks/${t1.id}`, { status: 'done' }, mert.token);
  const after = (await call('GET', '/api/tasks/mine', null, mert.token)).tasks.find((t) => t.id === t1.id);
  if (after.status !== 'done') throw new Error('durum guncellenmedi');
  ok('atanan kisi durumu guncelledi');

  const denied = await call('POST', `/api/companies/${company.id}/tasks`, { title: 'yetkisiz' }, mert.token).catch((e) => e);
  if (!(denied instanceof Error)) throw new Error('normal uye gorev olusturdu!');
  ok('yetki kurallari calisiyor');

  console.log('\nTUM TESTLER GECTI');
})().catch((err) => { console.error('\nHATA:', err.message); process.exit(1); });

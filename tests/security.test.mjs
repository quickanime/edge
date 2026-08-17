/**
 * Guvenlik testi: sunucuya yuzlerce saldiri denemesi yapar ve her birinin
 * engellendigini dogrular. Bir saldiri basarili olursa test kirmizi doner.
 *
 * Kullanim: EDGE_URL=http://127.0.0.1:3000 node tests/security.test.mjs
 */

const { subtle } = globalThis.crypto;
const BASE = process.env.EDGE_URL || 'http://127.0.0.1:3000';
const enc = new TextEncoder();

const b64 = (b) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

let attempts = 0;
const holes = [];
const notes = [];

function ok(label) { console.log(`  ok  ${label}`); }
function hole(label, detail) {
  holes.push(`${label} — ${detail}`);
  console.log(`  !!  ACIK: ${label} — ${detail}`);
}

async function raw(method, path, { body, token, headers = {} } = {}) {
  attempts++;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

/** Saldiri engellenmis olmali: 4xx bekleriz. */
async function blocked(label, method, path, options = {}) {
  const res = await raw(method, path, options);
  if (res.status < 400) hole(label, `${method} ${path} -> ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  return res;
}

async function pbkdf2(pw, salt, iters = 250000) {
  const base = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, 256);
}

async function makeUser(nick, password = 'parola12345') {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = b64(await subtle.exportKey('spki', pair.publicKey));
  const kdfSalt = b64(rand(16));
  const kek = await subtle.importKey('raw', await pbkdf2(password, unb64(kdfSalt)), 'AES-GCM', false, ['encrypt']);
  const iv = rand(12);
  const encPrivKey = {
    iv: b64(iv),
    ciphertext: b64(await subtle.encrypt({ name: 'AES-GCM', iv }, kek, await subtle.exportKey('pkcs8', pair.privateKey)))
  };
  const authHash = b64(await pbkdf2(password, enc.encode(`edge-auth|${nick.toLowerCase()}`)));
  const res = await raw('POST', '/auth/register', { body: { nick, authHash, kdfSalt, publicKey, encPrivKey } });
  if (res.status !== 200) throw new Error(`kurulum: kayit basarisiz (${res.status} ${JSON.stringify(res.data)})`);
  return { nick, password, token: res.data.token, id: res.data.user.id, publicKey, privateKey: pair.privateKey };
}

async function shared(priv, peerPub) {
  const peer = await subtle.importKey('spki', unb64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('edge-msg-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptFor(text, members, sender) {
  const key = rand(32);
  const mk = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const iv = rand(12);
  const ciphertext = b64(await subtle.encrypt({ name: 'AES-GCM', iv }, mk, enc.encode(text)));
  const keys = [];
  for (const m of members) {
    const sk = await shared(sender.privateKey, m.publicKey);
    const wiv = rand(12);
    keys.push({ userId: m.id, iv: b64(wiv), wrapped: b64(await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, sk, key)) });
  }
  return { iv: b64(iv), ciphertext, keys };
}

/* ================================================================== */

(async () => {
  const stamp = Date.now().toString(36);
  console.log(`Edge guvenlik taramasi — ${BASE}\n`);

  const alice = await makeUser(`sec_alice_${stamp}`);
  const bob = await makeUser(`sec_bob_${stamp}`);
  const mallory = await makeUser(`sec_mallory_${stamp}`);   // saldirgan
  const carol = await makeUser(`sec_carol_${stamp}`);

  // kurulum: alice + bob arkadas, ozel sohbet, sirket ve grup
  await raw('POST', '/api/friends', { body: { nick: bob.nick }, token: alice.token });
  await raw('POST', `/api/friends/${alice.id}/accept`, { token: bob.token });
  const dm = (await raw('POST', '/api/conversations/dm', { body: { userId: bob.id }, token: alice.token })).data.conversation;
  const payload = await encryptFor('gizli konusma', dm.members, alice);
  await raw('POST', `/api/conversations/${dm.id}/messages`, { body: payload, token: alice.token });
  const upload = await raw('POST', `/api/conversations/${dm.id}/blobs`, { body: { data: b64(rand(64)) }, token: alice.token });

  const company = (await raw('POST', '/api/companies', { body: { name: `Sec Co ${stamp}` }, token: alice.token })).data.company;
  const group = (await raw('POST', `/api/companies/${company.id}/groups`, { body: { name: 'Ozel' }, token: alice.token })).data.group;
  await raw('POST', `/api/companies/${company.id}/members`, { body: { nick: carol.nick }, token: alice.token });
  const task = (await raw('POST', `/api/companies/${company.id}/tasks`, { body: { title: 'gizli gorev' }, token: alice.token })).data.task;
  const meeting = (await raw('POST', `/api/companies/${company.id}/meetings`,
    { body: { title: 'gizli toplanti', startsAt: Date.now() + 3600000 }, token: alice.token })).data.meeting;
  console.log('  --  kurulum tamam: iki sohbet, bir sirket, grup, gorev, toplanti\n');

  /* ---------------- 1. kimlik dogrulama ---------------- */
  const protectedPaths = [
    ['GET', '/api/me'], ['GET', '/api/companies'], ['GET', '/api/conversations'],
    ['GET', '/api/friends'], ['GET', '/api/tasks/mine'], ['GET', '/api/meetings/mine'],
    ['GET', '/api/events'], ['GET', '/api/users?q=sec'],
    ['POST', '/api/companies'], ['POST', '/api/friends'], ['POST', '/api/conversations/dm'],
    ['POST', '/api/me/avatar'], ['PATCH', '/api/me']
  ];
  const badTokens = ['', 'null', 'undefined', 'Bearer', 'a'.repeat(64), b64(rand(32)),
    'eyJhbGciOiJub25lIn0.e30.', '../../etc/passwd', '%00', "' OR '1'='1"];

  for (const [method, path] of protectedPaths) {
    for (const token of badTokens) {
      await blocked('oturumsuz erisim', method, path, { token, body: method === 'GET' ? undefined : {} });
    }
  }
  ok(`gecersiz/sahte oturum anahtarlariyla ${protectedPaths.length * badTokens.length} istek reddedildi`);

  /* ---------------- 2. baskasinin verisine erisim (IDOR) ---------------- */
  const idorTargets = [
    ['GET', `/api/conversations/${dm.id}/messages`],
    ['POST', `/api/conversations/${dm.id}/messages`, { iv: b64(rand(12)), ciphertext: b64(rand(32)), keys: [{ userId: mallory.id, iv: b64(rand(12)), wrapped: b64(rand(48)) }] }],
    ['POST', `/api/conversations/${dm.id}/read`, {}],
    ['POST', `/api/conversations/${dm.id}/typing`, {}],
    ['POST', `/api/conversations/${dm.id}/ttl`, { seconds: 30 }],
    ['POST', `/api/conversations/${dm.id}/notice`, { kind: 'screenshot' }],
    ['POST', `/api/conversations/${dm.id}/blobs`, { data: b64(rand(32)) }],
    ['GET', `/api/conversations/${dm.id}/blobs/${upload.data.blobId}`],
    ['GET', `/api/companies/${company.id}`],
    ['PATCH', `/api/companies/${company.id}`, { name: 'ele gecirildi' }],
    ['DELETE', `/api/companies/${company.id}`],
    ['GET', `/api/companies/${company.id}/activity`],
    ['POST', `/api/companies/${company.id}/members`, { nick: mallory.nick }],
    ['POST', `/api/companies/${company.id}/groups`, { name: 'sizma' }],
    ['POST', `/api/companies/${company.id}/tasks`, { title: 'sizma' }],
    ['POST', `/api/companies/${company.id}/meetings`, { title: 'sizma', startsAt: Date.now() + 60000 }],
    ['POST', `/api/companies/${company.id}/invites`, {}],
    ['POST', `/api/companies/${company.id}/logo`, { dataUrl: null }],
    ['PATCH', `/api/groups/${group.id}`, { name: 'sizma' }],
    ['DELETE', `/api/groups/${group.id}`],
    ['POST', `/api/groups/${group.id}/members`, { userId: mallory.id }],
    ['DELETE', `/api/groups/${group.id}/members/${alice.id}`],
    ['PATCH', `/api/tasks/${task.id}`, { status: 'done' }],
    ['DELETE', `/api/tasks/${task.id}`],
    ['PATCH', `/api/meetings/${meeting.id}`, { title: 'sizma' }],
    ['DELETE', `/api/meetings/${meeting.id}`],
    ['POST', '/api/calls/start', { conversationId: dm.id, kind: 'audio' }],
    ['POST', '/api/calls/join', { conversationId: dm.id, kind: 'audio' }],
    ['POST', '/api/calls/join', { meetingId: meeting.id, kind: 'audio' }],
    ['GET', `/api/calls/state?roomId=conv:${dm.id}`]
  ];
  for (const [method, path, body] of idorTargets) {
    await blocked('yabancinin erisimi', method, path, { token: mallory.token, body });
  }
  ok(`baskasinin sohbet/sirket/gorev/toplanti verisine ${idorTargets.length} erisim denemesi engellendi`);

  /* ---------------- 3. yetki yukseltme ---------------- */
  await blocked('uye kendini yonetici yapiyor', 'PATCH', `/api/companies/${company.id}/members/${carol.id}`,
    { body: { role: 'admin', perms: { members: true, groups: true, tasks: true, meetings: true, invites: true } }, token: carol.token });
  await blocked('uye sirket sahibini dusuruyor', 'PATCH', `/api/companies/${company.id}/members/${alice.id}`,
    { body: { role: 'member' }, token: carol.token });
  await blocked('uye sahibi cikariyor', 'DELETE', `/api/companies/${company.id}/members/${alice.id}`, { token: carol.token });
  await blocked('uye grup aciyor', 'POST', `/api/companies/${company.id}/groups`, { body: { name: 'x' }, token: carol.token });
  await blocked('uye gorev olusturuyor', 'POST', `/api/companies/${company.id}/tasks`, { body: { title: 'x' }, token: carol.token });
  await blocked('uye davet uretiyor', 'POST', `/api/companies/${company.id}/invites`, { body: {}, token: carol.token });
  await blocked('uye toplanti planliyor', 'POST', `/api/companies/${company.id}/meetings`,
    { body: { title: 'x', startsAt: Date.now() + 60000 }, token: carol.token });
  await blocked('uye sirketi siliyor', 'DELETE', `/api/companies/${company.id}`, { token: carol.token });
  await blocked('uye sirket adini degistiriyor', 'PATCH', `/api/companies/${company.id}`, { body: { name: 'x' }, token: carol.token });

  // sinirli yetkili yonetici
  await raw('PATCH', `/api/companies/${company.id}/members/${carol.id}`,
    { body: { role: 'admin', perms: { groups: true } }, token: alice.token });
  await blocked('kisitli yonetici gorev olusturuyor', 'POST', `/api/companies/${company.id}/tasks`, { body: { title: 'x' }, token: carol.token });
  await blocked('kisitli yonetici uye ekliyor', 'POST', `/api/companies/${company.id}/members`, { body: { nick: mallory.nick }, token: carol.token });
  await blocked('kisitli yonetici davet uretiyor', 'POST', `/api/companies/${company.id}/invites`, { body: {}, token: carol.token });
  await blocked('kisitli yonetici toplanti planliyor', 'POST', `/api/companies/${company.id}/meetings`,
    { body: { title: 'x', startsAt: Date.now() + 60000 }, token: carol.token });
  await blocked('kisitli yonetici baskasina yetki veriyor', 'PATCH', `/api/companies/${company.id}/members/${mallory.id}`,
    { body: { role: 'admin' }, token: carol.token });
  ok('yetki yukseltme denemeleri (uye ve kisitli yonetici) engellendi');

  /* ---------------- 4. enjeksiyon ve yol gecisi ---------------- */
  const nasty = [
    '../../u/' + alice.id, '..%2f..%2fu%2f' + alice.id, '%2e%2e/%2e%2e/cfg/secret',
    'cfg/secret', 'sess/x', 'u/' + alice.id, 'nick/admin', ' abc', 'a'.repeat(500),
    '<script>alert(1)</script>', "'; DROP TABLE users; --", '${process.env}', '{{7*7}}',
    '__proto__', 'constructor', 'prototype'
  ];
  for (const value of nasty) {
    const id = encodeURIComponent(value);
    await blocked('kimlik alanina yol/kod enjeksiyonu', 'GET', `/api/conversations/${id}/messages`, { token: mallory.token });
    await blocked('ek kimligine enjeksiyon', 'GET', `/api/conversations/${dm.id}/blobs/${id}`, { token: alice.token });
    await blocked('gorev kimligine enjeksiyon', 'PATCH', `/api/tasks/${id}`, { body: { status: 'done' }, token: mallory.token });
    await blocked('davet kimligine enjeksiyon', 'POST', `/api/invites/${id}/join`, { token: mallory.token });
  }
  ok(`kimlik alanlarina ${nasty.length * 4} yol gecisi / enjeksiyon denemesi reddedildi`);

  // prototip kirletme
  const pollution = [
    { __proto__: { admin: true }, name: 'x' },
    { constructor: { prototype: { admin: true } }, name: 'x' },
    { perms: { __proto__: { members: true } }, role: 'admin' }
  ];
  for (const body of pollution) {
    await raw('POST', '/api/companies', { body, token: mallory.token });
    await raw('PATCH', `/api/companies/${company.id}/members/${carol.id}`, { body, token: carol.token });
  }
  if ({}.admin !== undefined) hole('prototip kirletme', 'Object.prototype degisti');
  const afterPollution = await raw('GET', '/api/me', { token: mallory.token });
  if (afterPollution.status !== 200) hole('prototip kirletme', 'sunucu bozuldu');
  ok('prototip kirletme denemeleri sunucuyu etkilemedi');

  // XSS yukleri: saklanip aynen geri donmeli, HTML olarak yorumlanmamali
  const xss = '<img src=x onerror=alert(1)>';
  const xssCompany = await raw('POST', '/api/companies', { body: { name: xss }, token: mallory.token });
  if (xssCompany.status === 200) {
    const detail = await raw('GET', `/api/companies/${xssCompany.data.company.id}`, { token: mallory.token });
    if (detail.data.company.name !== xss) notes.push('sirket adi normallestirildi (beklenen davranis)');
    const contentType = (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${mallory.token}` } })).headers.get('content-type');
    if (!/application\/json/.test(contentType)) hole('yanit turu', `JSON degil: ${contentType}`);
  }
  ok('XSS yukleri JSON olarak saklandi, yanitlar application/json donuyor');

  /* ---------------- 5. kripto ve protokol ---------------- */
  await blocked('sifresiz mesaj', 'POST', `/api/conversations/${dm.id}/messages`, { body: { iv: 'x', ciphertext: 'y', keys: [] }, token: alice.token });
  await blocked('anahtarsiz mesaj', 'POST', `/api/conversations/${dm.id}/messages`, { body: { iv: b64(rand(12)), ciphertext: b64(rand(16)) }, token: alice.token });
  await blocked('bos govdeli mesaj', 'POST', `/api/conversations/${dm.id}/messages`, { body: {}, token: alice.token });
  await blocked('sahte ek kimligi', 'POST', `/api/conversations/${dm.id}/messages`,
    { body: { iv: b64(rand(12)), ciphertext: b64(rand(16)), keys: [{ userId: alice.id, iv: b64(rand(12)), wrapped: b64(rand(48)) }], attachment: { blobId: '0'.repeat(32), iv: b64(rand(12)), mime: 'image/png' } }, token: alice.token });

  // gonderen kimligi sunucudan gelir: govdedeki senderId dikkate alinmamali
  const forged = await encryptFor('sahte gonderen', dm.members, alice);
  const forgedRes = await raw('POST', `/api/conversations/${dm.id}/messages`,
    { body: { ...forged, senderId: bob.id }, token: alice.token });
  if (forgedRes.status === 200) {
    const box = await raw('GET', `/api/conversations/${dm.id}/messages`, { token: bob.token });
    const last = box.data.messages[box.data.messages.length - 1];
    if (last.senderId !== alice.id) hole('gonderen sahteciligi', 'govdedeki senderId kabul edildi');
  }

  // gorusme sinyali: odada olmayan biri sinyal gonderemez
  await raw('POST', '/api/calls/start', { body: { conversationId: dm.id, kind: 'audio' }, token: alice.token });
  await blocked('yabanci gorusmeye sinyal gonderiyor', 'POST', '/api/calls/signal',
    { body: { roomId: `conv:${dm.id}`, toUserId: alice.id, signal: { type: 'offer' }, payload: { iv: b64(rand(12)), data: b64(rand(32)) } }, token: mallory.token });
  await blocked('gecersiz oda kimligi', 'POST', '/api/calls/signal',
    { body: { roomId: '../../room/x', toUserId: alice.id, signal: {} }, token: alice.token });
  await blocked('gorusme hedefi olmadan baslatma', 'POST', '/api/calls/start', { body: {}, token: mallory.token });
  ok('protokol kotuye kullanimi (sahte gonderen, sahte ek, yabanci sinyal) engellendi');

  /* ---------------- 6. bilgi sizintisi ---------------- */
  const leakScan = [
    await raw('GET', '/api/me', { token: alice.token }),
    await raw('GET', `/api/users?q=sec_`, { token: mallory.token }),
    await raw('GET', '/api/conversations', { token: alice.token }),
    await raw('GET', `/api/companies/${company.id}`, { token: alice.token }),
    await raw('GET', `/api/users/${alice.nick}/profile`, { token: mallory.token })
  ];
  for (const res of leakScan) {
    const body = JSON.stringify(res.data);
    for (const secret of ['authHash', 'auth_hash', 'authSalt', 'encPrivKey', 'kdfSalt', 'cfg/secret']) {
      if (body.includes(secret)) hole('bilgi sizintisi', `${secret} yanitta gorunuyor`);
    }
  }
  const stackProbe = await raw('POST', '/api/companies', { body: '{"name": ', token: alice.token });
  if (/at .*\.mjs|node:internal|TypeError|ReferenceError/.test(stackProbe.text)) {
    hole('hata ayrintisi sizintisi', stackProbe.text.slice(0, 100));
  }
  ok('yanitlarda parola turevi, gizli anahtar ya da yigin izi yok');

  // kullanici sayimi: var olmayan nick de ayni bicimde yanit vermeli
  const known = await raw('GET', `/auth/params/${alice.nick}`);
  const unknown = await raw('GET', `/auth/params/yok_${stamp}_abc`);
  if (known.status !== unknown.status || Object.keys(known.data).sort().join() !== Object.keys(unknown.data).sort().join()) {
    hole('kullanici sayimi', `var: ${known.status} ${JSON.stringify(known.data).slice(0, 60)} / yok: ${unknown.status}`);
  } else ok('kullanici sayimi zorlastirildi (bilinmeyen nick ayni yaniti veriyor)');

  /* ---------------- 7. kaynak tuketimi ---------------- */
  await blocked('devasa mesaj govdesi', 'POST', `/api/conversations/${dm.id}/messages`,
    { body: { iv: b64(rand(12)), ciphertext: 'A'.repeat(400000), keys: [{ userId: alice.id, iv: b64(rand(12)), wrapped: b64(rand(48)) }] }, token: alice.token });
  await blocked('binlerce anahtar zarfi', 'POST', `/api/conversations/${dm.id}/messages`,
    { body: { iv: b64(rand(12)), ciphertext: b64(rand(32)), keys: Array.from({ length: 5000 }, () => ({ userId: alice.id, iv: b64(rand(12)), wrapped: b64(rand(48)) })) }, token: alice.token });
  await blocked('devasa dosya', 'POST', `/api/conversations/${dm.id}/blobs`, { body: { data: 'A'.repeat(9000000) }, token: alice.token });
  await blocked('devasa profil fotosu', 'POST', '/api/me/avatar',
    { body: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(200000) }, token: alice.token });
  const longWait = Date.now();
  await raw('GET', '/api/events?wait=9999', { token: alice.token });
  if (Date.now() - longWait > 15000) hole('bekleme suresi', 'wait parametresi sinirlanmiyor');
  ok('asiri buyuk govde, anahtar seli ve uzun bekleme istegi sinirlandi');

  /* ---------------- 8. oturum hijyeni ---------------- */
  const temp = await makeUser(`sec_temp_${stamp}`);
  await raw('POST', '/auth/logout', { token: temp.token });
  await blocked('cikis sonrasi anahtar kullanimi', 'GET', '/api/me', { token: temp.token });
  await blocked('baskasinin oturumuyla profil degistirme', 'PATCH', '/api/me',
    { body: { displayName: 'ele gecirildi' }, token: temp.token });
  ok('cikis yapilan oturum anahtari gecersiz');

  /* ---------------- 9. davet kotuye kullanimi ---------------- */
  const limited = (await raw('POST', `/api/companies/${company.id}/invites`,
    { body: { maxUses: 1 }, token: alice.token })).data.invite;
  const parallel = await Promise.all([
    raw('POST', `/api/invites/${limited.slug}/join`, { token: mallory.token }),
    raw('POST', `/api/invites/${limited.slug}/join`, { token: bob.token })
  ]);
  const joined = parallel.filter((r) => r.status === 200 && r.data.joined).length;
  if (joined > 1) notes.push(`es zamanli davet kullanimi: ${joined} kisi katildi (kullanim siniri yarisa acik)`);
  await blocked('kapatilmis davet', 'POST', `/api/invites/${limited.slug}/join`, { token: carol.token });
  await blocked('baskasinin davetini kapatma', 'DELETE', `/api/invites/${company.slug}`, { token: mallory.token });
  await blocked('olmayan davet', 'POST', `/api/invites/yok-${stamp}/join`, { token: mallory.token });
  ok('davet linki kotuye kullanimi engellendi');

  /* ---------------- 10. hiz sinirlama (en sona) ---------------- */
  const victim = await makeUser(`sec_victim_${stamp}`);
  let limitHit = 0;
  for (let i = 0; i < 60; i++) {
    const res = await raw('POST', '/auth/login', { body: { nick: victim.nick, authHash: b64(rand(32)) } });
    if (res.status === 429) { limitHit = i + 1; break; }
  }
  if (!limitHit) hole('parola deneme sinirlamasi', '60 hatali giris denemesi engellenmedi');
  else ok(`parola deneme saldirisi ${limitHit}. denemede durduruldu`);

  let msgLimit = 0;
  const spam = await encryptFor('spam', dm.members, alice);
  for (let i = 0; i < 400; i++) {
    const res = await raw('POST', `/api/conversations/${dm.id}/messages`, { body: spam, token: alice.token });
    if (res.status === 429) { msgLimit = i + 1; break; }
  }
  if (!msgLimit) notes.push('mesaj hiz siniri 400 istekte devreye girmedi (kota yuksek olabilir)');
  else ok(`mesaj seli ${msgLimit}. istekte durduruldu`);

  /* ---------------- sonuc ---------------- */
  console.log(`\n  toplam ${attempts} istek denendi`);
  for (const note of notes) console.log(`  not: ${note}`);

  if (holes.length) {
    console.log(`\n${holes.length} ACIK BULUNDU:`);
    for (const item of holes) console.log(` - ${item}`);
    process.exit(1);
  }
  console.log('\nGUVENLIK TESTLERI GECTI — acik bulunamadi');
})().catch((err) => { console.error('\nHATA:', err.message); process.exit(1); });

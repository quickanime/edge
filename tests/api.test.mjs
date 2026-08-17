/**
 * Cekirdek testleri: istemci kripto akisini Node'da taklit edip tum uc noktalari
 * ve yetki kurallarini dener. Sunucunun calisiyor olmasi gerekir (npm start).
 */

const { subtle } = globalThis.crypto;
const BASE = process.env.EDGE_URL || 'http://127.0.0.1:3000';
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (b) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const ok = (label) => console.log(`  ok  ${label}`);

async function pbkdf2(pw, salt, iters = 250000) {
  const base = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, 256);
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || text}`);
  return data;
}

const fails = async (promise, code) => {
  try { await promise; return false; } catch (e) { return code ? e.message.includes(String(code)) : true; }
};

async function makeUser(nick, password = 'parola12345') {
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

/** Mesaji (ve istege bagli eki) sifreler. */
async function encryptFor(text, members, sender, bytes = null) {
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
  const out = { iv: b64(iv), ciphertext, keys };
  if (bytes) {
    const fiv = rand(12);
    out.file = { iv: b64(fiv), data: b64(await subtle.encrypt({ name: 'AES-GCM', iv: fiv }, mk, bytes)) };
  }
  return out;
}

async function decryptAs(message, senderPub, me) {
  const sk = await shared(me.privateKey, senderPub);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(message.key.iv) }, sk, unb64(message.key.wrapped));
  const mk = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(message.iv) }, mk, unb64(message.ciphertext)));
}

async function decryptFileAs(message, senderPub, me, dataB64) {
  const sk = await shared(me.privateKey, senderPub);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(message.key.iv) }, sk, unb64(message.key.wrapped));
  const mk = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(message.attachment.iv) }, mk, unb64(dataB64)));
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/* ================================================================== */

(async () => {
  const stamp = Date.now().toString(36);
  const ada = await makeUser(`ada_${stamp}`);
  const kaan = await makeUser(`kaan_${stamp}`);
  const mert = await makeUser(`mert_${stamp}`);
  const zeynep = await makeUser(`zeynep_${stamp}`);
  ok('dort kullanici kaydi');

  // giris: parola sunucuya gitmeden
  const params = await call('GET', `/auth/params/${ada.nick}`);
  const authHash = b64(await pbkdf2(ada.password, enc.encode(`edge-auth|${ada.nick}`), params.kdfIters));
  const login = await call('POST', '/auth/login', { nick: ada.nick, authHash });
  if (!login.token || !login.encPrivKey) throw new Error('giris eksik dondu');
  ok('giris + sifreli gizli anahtar zarfi');

  if (!await fails(call('POST', '/auth/login', { nick: ada.nick, authHash: b64(rand(32)) }), 400)) {
    throw new Error('yanlis parola kabul edildi');
  }
  ok('yanlis parola reddedildi');

  /* ---- profil fotosu ---- */
  await call('POST', '/api/me/avatar', { dataUrl: PIXEL }, ada.token);
  const me = await call('GET', '/api/me', null, ada.token);
  if (!me.user.avatar) throw new Error('profil fotosu kaydedilmedi');
  if (!await fails(call('POST', '/api/me/avatar', { dataUrl: 'javascript:alert(1)' }, ada.token), 400)) {
    throw new Error('gecersiz gorsel kabul edildi');
  }
  ok('profil fotosu yuklendi, gecersiz bicim reddedildi');

  /* ---- arkadaslik ---- */
  if (!await fails(call('POST', '/api/conversations/dm', { userId: kaan.id }, ada.token), 403)) {
    throw new Error('arkadas olmadan DM acildi');
  }
  await call('POST', '/api/friends', { nick: kaan.nick }, ada.token);
  const pending = await call('GET', '/api/friends', null, kaan.token);
  if (pending.incoming.length !== 1) throw new Error('istek karsi tarafa dusmedi');
  await call('POST', `/api/friends/${ada.id}/accept`, null, kaan.token);
  const accepted = await call('GET', '/api/friends', null, ada.token);
  if (accepted.friends.length !== 1) throw new Error('arkadaslik kurulmadi');
  ok('arkadaslik istegi: gonder / kabul et (once DM engellendi)');

  /* ---- DM, foto, gorulduc ---- */
  const dm = (await call('POST', '/api/conversations/dm', { userId: kaan.id }, ada.token)).conversation;
  const bytes = rand(512);
  const payload = await encryptFor('selam kaan, bu mesaj uctan uca sifreli', dm.members, ada, bytes);
  const upload = await call('POST', `/api/conversations/${dm.id}/blobs`, { data: payload.file.data }, ada.token);
  await call('POST', `/api/conversations/${dm.id}/messages`, {
    iv: payload.iv, ciphertext: payload.ciphertext, keys: payload.keys,
    attachment: { blobId: upload.blobId, iv: payload.file.iv, mime: 'image/jpeg', name: 'foto.jpg', size: bytes.length, width: 4, height: 4 }
  }, ada.token);

  const inbox = await call('GET', `/api/conversations/${dm.id}/messages`, null, kaan.token);
  const text = await decryptAs(inbox.messages[0], ada.publicKey, kaan);
  if (text !== 'selam kaan, bu mesaj uctan uca sifreli') throw new Error('DM cozulemedi: ' + text);
  if (inbox.messages[0].ciphertext.includes('selam')) throw new Error('duz metin sizdi');
  ok('DM sifreleme/cozme dogru, duz metin sizmiyor');

  const blob = await call('GET', `/api/conversations/${dm.id}/blobs/${upload.blobId}`, null, kaan.token);
  const decrypted = await decryptFileAs(inbox.messages[0], ada.publicKey, kaan, blob.data);
  if (Buffer.compare(Buffer.from(decrypted), Buffer.from(bytes)) !== 0) throw new Error('foto coz uyusmadi');
  ok('sifreli foto eki indirildi ve birebir cozuldu');

  // her tur dosya eki (gorsel olmayan)
  const doc = Buffer.from('gizli rapor icerigi'.repeat(20));
  const filePayload = await encryptFor('rapor ektedir', dm.members, ada, doc);
  const fileUpload = await call('POST', `/api/conversations/${dm.id}/blobs`, { data: filePayload.file.data }, ada.token);
  await call('POST', `/api/conversations/${dm.id}/messages`, {
    iv: filePayload.iv, ciphertext: filePayload.ciphertext, keys: filePayload.keys,
    attachment: { blobId: fileUpload.blobId, iv: filePayload.file.iv, mime: 'application/pdf',
                  kind: 'file', name: 'rapor.pdf', size: doc.length }
  }, ada.token);
  const fileBox = await call('GET', `/api/conversations/${dm.id}/messages`, null, kaan.token);
  const fileMsg = fileBox.messages[fileBox.messages.length - 1];
  if (fileMsg.attachment.kind !== 'file' || fileMsg.attachment.mime !== 'application/octet-stream') {
    throw new Error('dosya eki turu yanlis: ' + JSON.stringify(fileMsg.attachment));
  }
  const fileBlob = await call('GET', `/api/conversations/${dm.id}/blobs/${fileUpload.blobId}`, null, kaan.token);
  const fileBytes = await decryptFileAs(fileMsg, ada.publicKey, kaan, fileBlob.data);
  if (Buffer.compare(Buffer.from(fileBytes), doc) !== 0) throw new Error('dosya cozulemedi');
  ok('sifreli dosya eki (pdf) gonderildi ve birebir cozuldu');

  await call('POST', `/api/conversations/${dm.id}/read`, null, kaan.token);
  const convs = await call('GET', '/api/conversations', null, ada.token);
  const dmView = convs.conversations.find((c) => c.id === dm.id);
  if (!dmView.reads || !(dmView.reads[kaan.id] > 0)) throw new Error('gorulduc bilgisi gelmedi');
  ok('gorulduc bilgisi (okuma zamani) donuyor');

  await call('POST', `/api/conversations/${dm.id}/notice`, { kind: 'screenshot' }, kaan.token);
  const withNotice = await call('GET', `/api/conversations/${dm.id}/messages`, null, ada.token);
  if (!withNotice.messages.some((m) => m.system === 'screenshot')) throw new Error('ss bildirimi dusmedi');
  ok('ekran goruntusu bildirimi sohbete dustu');

  /* ---- gecici mesaj ---- */
  await call('POST', `/api/conversations/${dm.id}/ttl`, { seconds: 1 }, ada.token);
  const temp = await encryptFor('bu mesaj kaybolacak', dm.members, ada);
  await call('POST', `/api/conversations/${dm.id}/messages`, temp, ada.token);
  await new Promise((r) => setTimeout(r, 1300));
  const after = await call('GET', `/api/conversations/${dm.id}/messages`, null, kaan.token);
  for (const m of after.messages) {
    if (m.system) continue;
    if (m.ciphertext === temp.ciphertext) throw new Error('gecici mesaj silinmedi');
  }
  await call('POST', `/api/conversations/${dm.id}/ttl`, { seconds: 0 }, ada.token);
  ok('gecici mesaj suresi dolunca silindi');

  if (!await fails(call('GET', `/api/conversations/${dm.id}/messages`, null, mert.token), 403)) {
    throw new Error('yabanci sohbeti okudu');
  }
  ok('yetkisiz sohbet erisimi engellendi');

  /* ---- sirket, grup, davet linki ---- */
  const company = (await call('POST', '/api/companies', { name: `Edge Studio ${stamp}` }, ada.token)).company;
  if (!company.slug) throw new Error('sirket davet kimligi uretilmedi');
  await call('POST', `/api/companies/${company.id}/logo`, { dataUrl: PIXEL }, ada.token);

  const group = (await call('POST', `/api/companies/${company.id}/groups`,
    { name: 'Tasarim', description: 'arayuz ekibi', slug: `tasarim-${stamp.slice(-4)}` }, ada.token)).group;
  if (!group.convId || !group.slug) throw new Error('grup kanali/linki eksik');
  ok(`sirket + grup olustu (link: /${company.slug}, /${group.slug})`);

  // davet linkiyle katilma: tek tek eklemeye gerek yok
  const preview = await call('GET', `/api/invites/${group.slug}`);
  if (!preview.invite.valid || preview.invite.groupName !== 'Tasarim') throw new Error('davet onizlemesi hatali');
  const joined = await call('POST', `/api/invites/${group.slug}/join`, null, kaan.token);
  if (!joined.joined || joined.groupName !== 'Tasarim') throw new Error('davet linkiyle katilinamadi');
  await call('POST', `/api/invites/${company.slug}/join`, null, mert.token);
  ok('davet linkiyle sirkete ve gruba katilma');

  const limited = (await call('POST', `/api/companies/${company.id}/invites`,
    { slug: `vertex-${stamp.slice(-4)}`, role: 'member', maxUses: 1 }, ada.token)).invite;
  await call('POST', `/api/invites/${limited.slug}/join`, null, zeynep.token);
  if (!await fails(call('POST', `/api/invites/${limited.slug}/join`, null, kaan.token), 400)) {
    throw new Error('kullanim siniri asildi');
  }
  ok('kullanim sinirli davet linki (1 kez) dolunca kapandi');

  /* ---- yetki kisitlama ---- */
  await call('PATCH', `/api/companies/${company.id}/members/${kaan.id}`,
    { role: 'admin', perms: { groups: true, tasks: false, members: false, meetings: false, invites: false } }, ada.token);

  await call('POST', `/api/companies/${company.id}/groups`, { name: 'Yazilim' }, kaan.token);
  if (!await fails(call('POST', `/api/companies/${company.id}/tasks`, { title: 'yetkisiz gorev' }, kaan.token), 403)) {
    throw new Error('gorev yetkisi olmayan yonetici gorev olusturdu');
  }
  if (!await fails(call('POST', `/api/companies/${company.id}/members`, { nick: zeynep.nick }, kaan.token), 403)) {
    throw new Error('uye yetkisi olmayan yonetici uye ekledi');
  }
  ok('yonetici yetkileri tek tek kisitlanabiliyor');

  if (!await fails(call('PATCH', `/api/companies/${company.id}/members/${mert.id}`, { role: 'admin' }, kaan.token), 403)) {
    throw new Error('yonetici baskasina rol verdi');
  }
  ok('rol/yetki degistirme yalnizca sirket sahibinde');

  /* ---- grup sohbeti ---- */
  const detail = await call('GET', `/api/companies/${company.id}`, null, ada.token);
  const tasarim = detail.groups.find((g) => g.id === group.id);
  await call('POST', `/api/groups/${tasarim.id}/members`, { userId: mert.id }, ada.token);

  const gconv = (await call('GET', '/api/conversations', null, mert.token)).conversations
    .find((c) => c.groupId === tasarim.id);
  if (!gconv) throw new Error('grup kanali uyeye gorunmedi');
  const gpayload = await encryptFor('ekip, toplanti 15:00', gconv.members, ada);
  await call('POST', `/api/conversations/${gconv.id}/messages`, gpayload, ada.token);
  for (const u of [kaan, mert]) {
    const box = await call('GET', `/api/conversations/${gconv.id}/messages`, null, u.token);
    const t = await decryptAs(box.messages[box.messages.length - 1], ada.publicKey, u);
    if (t !== 'ekip, toplanti 15:00') throw new Error(`${u.nick} grup mesajini cozemedi`);
  }
  ok('grup mesajini tum uyeler cozdu');

  /* ---- gorevler ---- */
  const task = (await call('POST', `/api/companies/${company.id}/tasks`,
    { title: 'Logoyu uygula', assigneeGroupId: tasarim.id, priority: 'high', dueDate: '2026-09-01' }, ada.token)).task;
  await call('POST', `/api/companies/${company.id}/tasks`, { title: 'Fatura kes', assigneeUserId: mert.id }, ada.token);
  const mine = await call('GET', '/api/tasks/mine', null, mert.token);
  if (mine.tasks.length !== 2) throw new Error('grup+kisi gorevleri gelmedi: ' + mine.tasks.length);
  await call('PATCH', `/api/tasks/${task.id}`, { status: 'done' }, mert.token);
  ok('gruba/kisiye gorev atama ve atanan kisinin durumu degistirmesi');

  /* ---- toplantilar ---- */
  const meeting = (await call('POST', `/api/companies/${company.id}/meetings`, {
    title: 'Haftalik degerlendirme', groupId: tasarim.id,
    startsAt: Date.now() + 3600000, kind: 'video', durationMin: 45
  }, ada.token)).meeting;
  const mineMeetings = await call('GET', '/api/meetings/mine', null, mert.token);
  if (!mineMeetings.meetings.some((m) => m.id === meeting.id)) throw new Error('toplanti katilimciya gorunmedi');
  ok('toplanti planlandi ve grup uyelerine dustu');

  /* ---- gorusme sinyallesmesi ---- */
  const room = (await call('POST', '/api/calls/start', { meetingId: meeting.id, kind: 'video' }, ada.token)).room;
  const join = await call('POST', '/api/calls/join', { meetingId: meeting.id, kind: 'video' }, mert.token);
  if (!join.peers.some((p) => p.id === ada.id)) throw new Error('katilimci listesi hatali');
  await call('POST', '/api/calls/signal', {
    roomId: room.roomId, toUserId: mert.id, signal: { type: 'offer' }, payload: { iv: b64(rand(12)), data: b64(rand(64)) }
  }, ada.token);
  const events = await call('GET', '/api/events?wait=1', null, mert.token);
  if (!events.events.some((e) => e.type === 'call:signal')) throw new Error('sinyal karsi tarafa gitmedi');
  await call('POST', '/api/calls/leave', { meetingId: meeting.id }, mert.token);
  ok('gorusme odasi: baslat / katil / sifreli sinyal / ayril');

  /* ---- son aktiviteler ---- */
  const activity = await call('GET', `/api/companies/${company.id}/activity`, null, ada.token);
  const actions = activity.activity.map((a) => a.action);
  for (const expected of ['group:create', 'task:create', 'meeting:create', 'member:join', 'member:access']) {
    if (!actions.includes(expected)) throw new Error(`aktivite kaydi eksik: ${expected}`);
  }
  ok(`yonetim panelinde son aktiviteler (${activity.activity.length} kayit)`);

  /* ---- olay akisi ---- */
  const stream = await call('GET', '/api/events?wait=0', null, kaan.token);
  if (!Array.isArray(stream.events)) throw new Error('olay akisi bozuk');
  ok('olay akisi (bekleyen yoklama) calisiyor');

  console.log('\nTUM TESTLER GECTI');
})().catch((err) => { console.error('\nHATA:', err.message); process.exit(1); });

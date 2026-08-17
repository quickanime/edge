/**
 * Edge cekirdegi: tum is mantigi. Hicbir sunucu cercevesine bagli degil —
 * hem Netlify Function hem yerel gelistirme sunucusu ayni fonksiyonu cagirir.
 *
 * handle(method, path, body, headers) -> { status, body }
 */

import crypto from 'node:crypto';
import {
  now, id, token, seq, hashAuth, safeEqual, NICK_RE, SLUG_RE, cleanText, longText, isB64,
  HttpError, bad, denied, missing, slugCandidate, PERMS, normalizePerms, can, memberOf
} from './util.mjs';
import {
  assertId, assertSlug, assertRoom, assertNickish, createLimiter, LIMITS,
  serverSecret, decoySalt, burnCompare
} from './security.mjs';

const KDF_ITERS = 250000;
const EVENT_TTL = 120000;        // olaylar iki dakika saklanir
const CALL_TTL = 3600000;        // oda kayitlari bir saat sonra anlamsiz
const SESSION_TTL = 2592000000;  // oturum 30 gun sonra duser
const MAX_KEY_ENVELOPES = 256;   // bir mesajdaki anahtar zarfi siniri
const MAX_CIPHERTEXT = 200000;   // sifreli govde siniri (yaklasik 150 KB metin)
const MAX_BLOB_B64 = 6000000;    // sifreli ek siniri (yaklasik 4.4 MB dosya)

export function createApi(store) {
  const limit = createLimiter(store);

  /* ---------------- depo yardimcilari ---------------- */

  const getUser = (userId) => store.get(`u/${userId}`);
  const saveUser = (user) => store.set(`u/${user.id}`, user);
  const getCompany = (companyId) => store.get(`co/${companyId}`);
  const saveCompany = (company) => store.set(`co/${company.id}`, company);
  const getConv = (convId) => store.get(`conv/${convId}`);
  const saveConv = (conv) => store.set(`conv/${conv.id}`, conv);

  async function userIndex(userId) {
    return (await store.get(`ui/${userId}`)) || { companyIds: [], convIds: [] };
  }

  async function indexAdd(userId, field, value) {
    const index = await userIndex(userId);
    if (!index[field].includes(value)) {
      index[field].push(value);
      await store.set(`ui/${userId}`, index);
    }
  }

  async function indexRemove(userId, field, value) {
    const index = await userIndex(userId);
    const next = index[field].filter((v) => v !== value);
    if (next.length !== index[field].length) {
      index[field] = next;
      await store.set(`ui/${userId}`, index);
    }
  }

  async function emit(userIds, event) {
    const payload = { ...event, at: now() };
    await Promise.all([...new Set(userIds)].map((userId) =>
      store.set(`ev/${userId}/${seq()}`, payload)));
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      nick: user.nick,
      displayName: user.displayName,
      publicKey: user.publicKey,
      avatar: user.avatar || null,
      lastSeenAt: user.lastSeenAt || 0
    };
  }

  /* ---- yonetim paneli: son aktiviteler ---- */

  async function logAction(companyId, actorId, action, detail = '') {
    await store.set(`log/${companyId}/${seq()}`, {
      actorId, action, detail: cleanText(detail, 160), at: now()
    });
  }

  async function companyActivity(companyId, limit = 60) {
    const keys = await store.list(`log/${companyId}/`);
    const slice = keys.slice(-limit).reverse();
    const rows = (await Promise.all(slice.map((k) => store.get(k)))).filter(Boolean);
    return Promise.all(rows.map(async (row) => {
      const actor = await getUser(row.actorId);
      return { ...row, actorNick: actor ? actor.nick : 'deleted', actorAvatar: actor ? actor.avatar || null : null };
    }));
  }

  /* ---- arkadaslik ---- */

  const friendKey = (a, b) => `fr/${a}/${b}`;

  async function friendState(userId, otherId) {
    const row = await store.get(friendKey(userId, otherId));
    return row ? row.state : null;
  }

  async function areFriends(a, b) {
    return (await friendState(a, b)) === 'accepted';
  }

  /** Iki kullanici ortak bir sirkette mi? */
  async function shareCompany(a, b) {
    const indexA = await userIndex(a);
    for (const companyId of indexA.companyIds) {
      const company = await getCompany(companyId);
      if (company && memberOf(company, b)) return true;
    }
    return false;
  }

  /* ---- gorsel (profil fotosu / sirket logosu) ---- */

  const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_AVATAR = 60000;

  function checkImage(dataUrl) {
    if (dataUrl === null || dataUrl === '') return null;
    if (typeof dataUrl !== 'string' || !IMAGE_RE.test(dataUrl)) throw bad('Unsupported image format.');
    if (dataUrl.length > MAX_AVATAR) throw bad('Image is too large; pick a smaller file.');
    return dataUrl;
  }

  async function publicUsers(userIds) {
    const users = await Promise.all(userIds.map(getUser));
    return users.filter(Boolean).map(publicUser);
  }

  /* ---------------- oturum ---------------- */

  async function authUser(headers) {
    const raw = headers.authorization || headers.Authorization || '';
    const t = raw.replace(/^Bearer\s+/i, '').trim();
    if (!t) throw new HttpError(401, 'Session required.');
    const session = await store.get(`sess/${t}`);
    if (!session) throw new HttpError(401, 'Session is invalid.');
    if (now() - session.createdAt > SESSION_TTL) {
      await store.del(`sess/${t}`);
      throw new HttpError(401, 'Session expired, please sign in again.');
    }
    const user = await getUser(session.userId);
    if (!user) throw new HttpError(401, 'Session is invalid.');
    return user;
  }

  async function touch(user) {
    const stamp = now();
    if (stamp - (user.lastSeenAt || 0) > 25000) {
      user.lastSeenAt = stamp;
      await saveUser(user);
    }
  }

  /** Son 45 saniyede istek atan kullanicilar cevrimici sayilir. */
  const isOnline = (user) => user && now() - (user.lastSeenAt || 0) < 45000;

  /* ---------------- sirket / grup ---------------- */

  async function requireCompany(companyId, userId, perm) {
    const company = await getCompany(companyId);
    if (!company) throw missing('Company not found.');
    const member = memberOf(company, userId);
    if (!member) throw denied('You are not a member of this company.');
    if (perm && !can(company, userId, perm)) throw denied('You do not have permission for this action.');
    return { company, member };
  }

  async function companyByGroup(groupId, userId, perm) {
    const companyId = await store.get(`gidx/${groupId}`);
    if (!companyId) throw missing('Group not found.');
    const { company, member } = await requireCompany(companyId, userId, perm);
    const group = company.groups.find((g) => g.id === groupId);
    if (!group) throw missing('Group not found.');
    return { company, member, group };
  }

  async function uniqueSlug(preferred) {
    if (preferred) {
      const slug = String(preferred).toLowerCase();
      if (!SLUG_RE.test(slug)) throw bad('Link ids are 3-32 characters: lowercase letters, numbers and hyphens.');
      if (await store.get(`inv/${slug}`)) throw bad('That link id is already in use.');
      return slug;
    }
    for (let i = 0; i < 12; i++) {
      const slug = slugCandidate(i);
      if (!(await store.get(`inv/${slug}`))) return slug;
    }
    return `edge-${crypto.randomBytes(3).toString('hex')}`;
  }

  /** Grubun sohbet kanalini olustur/uyeleri esitle. */
  async function syncGroupConv(company, group) {
    let conv = group.convId ? await getConv(group.convId) : null;
    if (!conv) {
      conv = {
        id: id(), kind: 'group', companyId: company.id, groupId: group.id,
        members: [], createdAt: now()
      };
      group.convId = conv.id;
    }
    const before = conv.members;
    conv.members = [...group.members];
    conv.companyId = company.id;
    await saveConv(conv);

    for (const userId of conv.members) await indexAdd(userId, 'convIds', conv.id);
    for (const userId of before.filter((u) => !conv.members.includes(u))) {
      await indexRemove(userId, 'convIds', conv.id);
    }
    return conv;
  }

  function groupPayload(company, group, userId) {
    return {
      id: group.id,
      companyId: company.id,
      name: group.name,
      slug: group.slug,
      description: group.description,
      convId: group.convId || null,
      memberIds: group.members,
      isMember: group.members.includes(userId),
      createdAt: group.createdAt
    };
  }

  function companyPayload(company, userId) {
    const member = memberOf(company, userId);
    return {
      id: company.id,
      name: company.name,
      slug: company.slug,
      logo: company.logo || null,
      ownerId: company.ownerId,
      role: member ? member.role : null,
      perms: member ? (member.role === 'owner' ? normalizePerms({}, true) : member.perms) : null,
      memberCount: company.members.length,
      createdAt: company.createdAt
    };
  }

  /* ---------------- sohbet ---------------- */

  async function convPayload(conv, userId) {
    const members = await publicUsers(conv.members);
    const online = {};
    for (const memberId of conv.members) {
      const user = await getUser(memberId);
      online[memberId] = isOnline(user);
    }
    const keys = await store.list(`m/${conv.id}/`);
    const lastKey = keys[keys.length - 1];
    const lastMessageAt = lastKey ? Number(lastKey.split('/')[2].split('-')[0]) : 0;
    const lastReadAt = (await store.get(`read/${conv.id}/${userId}`)) || 0;
    const unread = keys.filter((k) => Number(k.split('/')[2].split('-')[0]) > lastReadAt).length;

    let title = 'Sohbet';
    let subtitle = null;
    let groupId = conv.groupId || null;
    let companyId = conv.companyId || null;

    if (conv.kind === 'group' && companyId) {
      const company = await getCompany(companyId);
      const group = company && company.groups.find((g) => g.id === groupId);
      title = group ? group.name : 'Grup';
      subtitle = company ? company.name : null;
    } else {
      const other = members.find((m) => m.id !== userId);
      title = other ? other.nick : 'Sohbet';
    }

    // "Gorulduc" bilgisi: her uyenin son okuma zamani
    const reads = {};
    for (const memberId of conv.members) {
      reads[memberId] = (await store.get(`read/${conv.id}/${memberId}`)) || 0;
    }

    return {
      id: conv.id, kind: conv.kind, groupId, companyId, title, subtitle,
      members, online, reads, lastMessageAt, unread: Math.max(0, unread),
      ttlSeconds: conv.ttlSeconds || 0
    };
  }

  async function requireConv(convId, userId) {
    const conv = await getConv(convId);
    if (!conv) throw missing('Conversation not found.');
    if (!conv.members.includes(userId)) throw denied('You do not have access to this conversation.');
    return conv;
  }

  /* ---------------- gorev / toplanti ---------------- */

  const STATUSES = ['todo', 'doing', 'done'];
  const PRIORITIES = ['low', 'normal', 'high'];

  async function taskPayload(company, task) {
    const assignee = task.assigneeUserId ? await getUser(task.assigneeUserId) : null;
    const group = task.assigneeGroupId ? company.groups.find((g) => g.id === task.assigneeGroupId) : null;
    const creator = await getUser(task.createdBy);
    return {
      ...task,
      companyName: company.name,
      assigneeNick: assignee ? assignee.nick : null,
      assigneeGroupName: group ? group.name : null,
      createdByNick: creator ? creator.nick : null
    };
  }

  async function companyTasks(company) {
    const keys = await store.list(`task/${company.id}/`);
    const tasks = (await Promise.all(keys.map((k) => store.get(k)))).filter(Boolean);
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(tasks.map((t) => taskPayload(company, t)));
  }

  async function meetingPayload(company, meeting) {
    const group = meeting.groupId ? company.groups.find((g) => g.id === meeting.groupId) : null;
    const host = await getUser(meeting.createdBy);
    return {
      ...meeting,
      companyName: company.name,
      groupName: group ? group.name : null,
      hostNick: host ? host.nick : null
    };
  }

  async function companyMeetings(company) {
    const keys = await store.list(`meet/${company.id}/`);
    const list = (await Promise.all(keys.map((k) => store.get(k)))).filter(Boolean);
    list.sort((a, b) => a.startsAt - b.startsAt);
    return Promise.all(list.map((m) => meetingPayload(company, m)));
  }

  /** Toplantiya kimler katilabilir: grup uyeleri, grup yoksa tum sirket. */
  function meetingAudience(company, meeting) {
    if (!meeting.groupId) return company.members.map((m) => m.userId);
    const group = company.groups.find((g) => g.id === meeting.groupId);
    return group ? [...group.members] : [];
  }

  /* ================================================================ */
  /* rotalar                                                          */
  /* ================================================================ */

  const routes = [];
  const route = (method, pattern, handler, options = {}) =>
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, ...options });

  /* ---- saglik kontrolu ---- */

  route('GET', '/api/health', async () => {
    const probe = `health/${seq()}`;
    await store.set(probe, { ok: true });
    const back = await store.get(probe);
    await store.del(probe);
    return { ok: Boolean(back && back.ok), store: 'ready' };
  }, { open: true });

  /* ---- kimlik ---- */

  route('POST', '/auth/register', async ({ body, ip }) => {
    await limit(`reg:${ip}`, LIMITS.register);
    const nick = cleanText(body.nick, 24);
    const displayName = cleanText(body.displayName, 40) || nick;
    const { authHash, kdfSalt, publicKey, encPrivKey } = body;

    if (!NICK_RE.test(nick)) throw bad('Nicknames are 3-24 characters: letters, numbers, _ . - are allowed.');
    if (!isB64(authHash, 500) || !isB64(kdfSalt, 500) || !isB64(publicKey, 4000)) throw bad('Key material is missing.');
    if (!encPrivKey || !isB64(encPrivKey.iv, 500) || !isB64(encPrivKey.ciphertext, 20000)) throw bad('Encrypted private key is missing.');
    if (await store.get(`nick/${nick.toLowerCase()}`)) throw bad('That nickname is taken.');

    const authSalt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: id(), nick, nickLower: nick.toLowerCase(), displayName,
      authHash: hashAuth(authHash, authSalt), authSalt,
      kdfSalt, kdfIters: KDF_ITERS, publicKey, encPrivKey,
      createdAt: now(), lastSeenAt: now()
    };
    await saveUser(user);
    await store.set(`nick/${user.nickLower}`, user.id);

    const sessionToken = token();
    await store.set(`sess/${sessionToken}`, { userId: user.id, createdAt: now() });
    return { token: sessionToken, user: publicUser(user), encPrivKey, kdfIters: KDF_ITERS };
  }, { open: true });

  route('GET', '/auth/params/:nick', async ({ params, ip }) => {
    await limit(`params:${ip}`, LIMITS.loginIp);
    const nick = assertNickish(params.nick);
    const userId = await store.get(`nick/${nick.toLowerCase()}`);
    const user = userId && await getUser(userId);
    // Kullanici yoksa da tutarli bir tuz doner: "bu nick var mi" anlasilmaz.
    if (!user) {
      const secret = await serverSecret(store);
      return { kdfSalt: decoySalt(secret, nick), kdfIters: KDF_ITERS };
    }
    return { kdfSalt: user.kdfSalt, kdfIters: user.kdfIters };
  }, { open: true });

  route('POST', '/auth/login', async ({ body, ip }) => {
    const nickLower = String(body.nick || '').toLowerCase().slice(0, 24);
    await limit(`loginip:${ip}`, LIMITS.loginIp);
    await limit(`login:${nickLower}`, LIMITS.login);

    const userId = nickLower && await store.get(`nick/${nickLower}`);
    const user = userId && await getUser(userId);
    if (!user) {
      // Var olmayan kullanicida da ayni islem maliyeti odenir.
      burnCompare(await serverSecret(store));
      throw bad('Wrong nickname or password.');
    }
    if (!isB64(body.authHash, 500) || !safeEqual(hashAuth(body.authHash, user.authSalt), user.authHash)) {
      throw bad('Wrong nickname or password.');
    }
    const sessionToken = token();
    await store.set(`sess/${sessionToken}`, { userId: user.id, createdAt: now() });
    user.lastSeenAt = now();
    await saveUser(user);
    return {
      token: sessionToken, user: publicUser(user), encPrivKey: user.encPrivKey,
      kdfSalt: user.kdfSalt, kdfIters: user.kdfIters
    };
  }, { open: true });

  route('POST', '/auth/logout', async ({ headers }) => {
    const raw = (headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (raw) await store.del(`sess/${raw}`);
    return { ok: true };
  }, { open: true });

  /* ---- profil ve arama ---- */

  route('GET', '/api/me', async ({ user }) => ({ user: publicUser(user) }));

  route('PATCH', '/api/me', async ({ user, body }) => {
    const displayName = cleanText(body.displayName, 40);
    if (!displayName) throw bad('Display name cannot be empty.');
    user.displayName = displayName;
    await saveUser(user);
    return { user: publicUser(user) };
  });

  route('GET', '/api/users', async ({ user, query }) => {
    await limit(`search:${user.id}`, LIMITS.search);
    const q = cleanText(query.q, 32).toLowerCase();
    if (q.length < 2) return { users: [] };
    const keys = await store.list('nick/');
    const hits = keys.filter((k) => k.slice(5).includes(q)).slice(0, 20);
    const ids = (await Promise.all(hits.map((k) => store.get(k)))).filter((v) => v && v !== user.id);
    return { users: await publicUsers(ids) };
  });

  route('GET', '/api/users/:nick/profile', async ({ user, params }) => {
    await limit(`search:${user.id}`, LIMITS.search);
    const targetId = await store.get(`nick/${assertNickish(params.nick).toLowerCase()}`);
    const target = targetId && await getUser(targetId);
    if (!target) throw missing('User not found.');
    return {
      profile: {
        ...publicUser(target),
        online: isOnline(target),
        friendState: target.id === user.id ? 'self' : await friendState(user.id, target.id),
        sharesCompany: target.id === user.id ? false : await shareCompany(user.id, target.id)
      }
    };
  });

  /* ---- profil fotosu / sirket logosu ---- */

  route('POST', '/api/me/avatar', async ({ user, body }) => {
    await limit(`avatar:${user.id}`, LIMITS.avatar);
    user.avatar = checkImage(body.dataUrl);
    await saveUser(user);
    const index = await userIndex(user.id);
    const peers = new Set();
    for (const convId of index.convIds) {
      const conv = await getConv(convId);
      if (conv) for (const memberId of conv.members) peers.add(memberId);
    }
    await emit([...peers], { type: 'conversations:refresh' });
    return { user: publicUser(user) };
  });

  route('POST', '/api/companies/:id/logo', async ({ user, params, body }) => {
    await limit(`avatar:${user.id}`, LIMITS.avatar);
    const { company } = await requireCompany(params.id, user.id);
    if (company.ownerId !== user.id && !can(company, user.id, 'members')) {
      throw denied('Logoyu degistirme yetkin yok.');
    }
    company.logo = checkImage(body.dataUrl);
    await saveCompany(company);
    await logAction(company.id, user.id, 'company:logo', company.name);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { company: companyPayload(company, user.id) };
  });

  /* ---- arkadaslik ---- */

  route('GET', '/api/friends', async ({ user }) => {
    const keys = await store.list(`fr/${user.id}/`);
    const rows = await Promise.all(keys.map(async (key) => {
      const otherId = key.split('/')[2];
      const row = await store.get(key);
      const other = await getUser(otherId);
      if (!row || !other) return null;
      return { state: row.state, at: row.at, user: { ...publicUser(other), online: isOnline(other) } };
    }));
    const list = rows.filter(Boolean);
    return {
      friends: list.filter((r) => r.state === 'accepted'),
      incoming: list.filter((r) => r.state === 'pending-in'),
      outgoing: list.filter((r) => r.state === 'pending-out')
    };
  });

  route('POST', '/api/friends', async ({ user, body }) => {
    await limit(`friend:${user.id}`, LIMITS.friend);
    const nick = cleanText(body.nick, 24).toLowerCase();
    const targetId = await store.get(`nick/${nick}`);
    const target = targetId && await getUser(targetId);
    if (!target) throw bad('User not found.');
    if (target.id === user.id) throw bad('You cannot send a request to yourself.');

    const existing = await friendState(user.id, target.id);
    if (existing === 'accepted') throw bad('You are already friends.');
    if (existing === 'pending-out') throw bad('A request was already sent.');

    if (existing === 'pending-in') {
      // Karsi taraf zaten istek gondermis: dogrudan kabul et.
      await store.set(friendKey(user.id, target.id), { state: 'accepted', at: now() });
      await store.set(friendKey(target.id, user.id), { state: 'accepted', at: now() });
      await emit([target.id], { type: 'friend:accepted', userId: user.id, nick: user.nick });
      return { state: 'accepted' };
    }

    await store.set(friendKey(user.id, target.id), { state: 'pending-out', at: now() });
    await store.set(friendKey(target.id, user.id), { state: 'pending-in', at: now() });
    await emit([target.id], { type: 'friend:request', userId: user.id, nick: user.nick });
    return { state: 'pending-out' };
  });

  route('POST', '/api/friends/:userId/accept', async ({ user, params }) => {
    const state = await friendState(user.id, params.userId);
    if (state !== 'pending-in') throw bad('There is no pending request.');
    await store.set(friendKey(user.id, params.userId), { state: 'accepted', at: now() });
    await store.set(friendKey(params.userId, user.id), { state: 'accepted', at: now() });
    await emit([params.userId], { type: 'friend:accepted', userId: user.id, nick: user.nick });
    return { state: 'accepted' };
  });

  route('DELETE', '/api/friends/:userId', async ({ user, params }) => {
    await store.del(friendKey(user.id, params.userId));
    await store.del(friendKey(params.userId, user.id));
    await emit([params.userId], { type: 'friend:changed', userId: user.id });
    return { ok: true };
  });

  /* ---- olay akisi (WebSocket yerine yoklama) ---- */

  route('GET', '/api/events', async ({ user, query }) => {
    const cursor = String(query.cursor || '');
    // wait=saniye verilirse olay gelene kadar istek acik tutulur (bekleyen yoklama):
    // mesaj gecikmesi yarim saniyeye duser, bos beklemede istek sayisi dusuk kalir.
    const waitMs = Math.min(Math.max(Number(query.wait) || 0, 0), 8) * 1000;
    const deadline = now() + waitMs;

    let keys = await store.list(`ev/${user.id}/`);
    while (waitMs && !keys.some((k) => k > cursor) && now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      keys = await store.list(`ev/${user.id}/`);
    }

    const fresh = keys.filter((k) => k > cursor);
    const events = (await Promise.all(fresh.map((k) => store.get(k)))).filter(Boolean);

    // eskiyen olaylari temizle
    const cutoff = now() - EVENT_TTL;
    await Promise.all(keys
      .filter((k) => Number(k.split('/')[2].split('-')[0]) < cutoff)
      .map((k) => store.del(k)));

    return {
      events,
      cursor: fresh.length ? fresh[fresh.length - 1] : cursor,
      serverTime: now()
    };
  });

  /* ---- sirketler ---- */

  route('GET', '/api/companies', async ({ user }) => {
    const index = await userIndex(user.id);
    const companies = (await Promise.all(index.companyIds.map(getCompany))).filter(Boolean);
    companies.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return { companies: companies.map((c) => companyPayload(c, user.id)) };
  });

  route('POST', '/api/companies', async ({ user, body }) => {
    await limit(`company:${user.id}`, LIMITS.company);
    const name = cleanText(body.name, 60);
    if (name.length < 2) throw bad('Company name must be at least 2 characters.');
    const slug = await uniqueSlug(body.slug || null);
    const company = {
      id: id(), name, slug, ownerId: user.id, createdAt: now(),
      members: [{ userId: user.id, role: 'owner', perms: normalizePerms({}, true), joinedAt: now() }],
      groups: [], invites: [slug]
    };
    await saveCompany(company);
    await indexAdd(user.id, 'companyIds', company.id);

    // Sirketin kendi davet linki: edgeishere.netlify.app/<slug>
    await store.set(`inv/${slug}`, {
      companyId: company.id, groupId: null, role: 'member', perms: normalizePerms({}),
      maxUses: 0, uses: 0, disabled: false, createdBy: user.id, createdAt: now()
    });
    await logAction(company.id, user.id, 'company:create', `${name} (/${slug})`);
    return { company: companyPayload(company, user.id) };
  });

  route('GET', '/api/companies/:id', async ({ user, params }) => {
    const { company } = await requireCompany(params.id, user.id);
    const members = await Promise.all(company.members.map(async (m) => {
      const memberUser = await getUser(m.userId);
      return {
        ...publicUser(memberUser),
        role: m.role,
        perms: m.role === 'owner' ? normalizePerms({}, true) : normalizePerms(m.perms),
        joinedAt: m.joinedAt,
        online: isOnline(memberUser)
      };
    }));
    const invites = [];
    for (const slug of company.invites || []) {
      const invite = await store.get(`inv/${slug}`);
      if (invite) invites.push({ ...invite, slug });
    }
    return {
      company: companyPayload(company, user.id),
      members: members.filter((m) => m.id),
      groups: company.groups.map((g) => groupPayload(company, g, user.id)),
      tasks: await companyTasks(company),
      meetings: await companyMeetings(company),
      invites,
      activity: await companyActivity(company.id, 40)
    };
  });

  route('GET', '/api/companies/:id/activity', async ({ user, params }) => {
    const { company } = await requireCompany(params.id, user.id);
    return { activity: await companyActivity(company.id, 80) };
  });

  route('PATCH', '/api/companies/:id', async ({ user, params, body }) => {
    const { company } = await requireCompany(params.id, user.id);
    if (company.ownerId !== user.id) throw denied('Only the company owner can change this.');
    const name = cleanText(body.name, 60);
    if (name.length < 2) throw bad('Company name must be at least 2 characters.');
    company.name = name;
    await saveCompany(company);
    await logAction(company.id, user.id, 'company:rename', name);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { company: companyPayload(company, user.id) };
  });

  route('DELETE', '/api/companies/:id', async ({ user, params }) => {
    const { company } = await requireCompany(params.id, user.id);
    if (company.ownerId !== user.id) throw denied('Only the company owner can delete this.');

    for (const group of company.groups) {
      if (!group.convId) continue;
      for (const memberId of group.members) await indexRemove(memberId, 'convIds', group.convId);
      await store.del(`conv/${group.convId}`);
      await store.del(`gidx/${group.id}`);
    }
    for (const key of await store.list(`task/${company.id}/`)) await store.del(key);
    for (const key of await store.list(`meet/${company.id}/`)) await store.del(key);
    for (const slug of company.invites || []) await store.del(`inv/${slug}`);
    for (const member of company.members) await indexRemove(member.userId, 'companyIds', company.id);
    await store.del(`co/${company.id}`);

    await emit(company.members.map((m) => m.userId), { type: 'company:delete', companyId: company.id });
    return { ok: true };
  });

  /* ---- uyeler ve yetkiler ---- */

  route('POST', '/api/companies/:id/members', async ({ user, params, body }) => {
    const { company } = await requireCompany(params.id, user.id, 'members');
    const nick = cleanText(body.nick, 24).toLowerCase();
    const targetId = await store.get(`nick/${nick}`);
    const target = targetId && await getUser(targetId);
    if (!target) throw bad('User not found.');
    if (memberOf(company, target.id)) throw bad('That user is already a member.');

    const role = body.role === 'admin' ? 'admin' : 'member';
    company.members.push({
      userId: target.id, role, joinedAt: now(),
      perms: role === 'admin' ? normalizePerms(body.perms) : normalizePerms({})
    });
    await saveCompany(company);
    await indexAdd(target.id, 'companyIds', company.id);
    await logAction(company.id, user.id, 'member:add', `${target.nick} (${role})`);

    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    await emit([target.id], { type: 'company:joined', companyId: company.id, companyName: company.name });
    return { ok: true };
  });

  route('PATCH', '/api/companies/:id/members/:userId', async ({ user, params, body }) => {
    const { company } = await requireCompany(params.id, user.id);
    if (company.ownerId !== user.id) throw denied('Only the company owner can change roles and permissions.');
    const member = memberOf(company, params.userId);
    if (!member) throw missing('Member not found.');
    if (member.role === 'owner') throw bad('The owner\u2019s permissions cannot be changed.');

    if (body.role !== undefined) {
      if (!['admin', 'member'].includes(body.role)) throw bad('Invalid role.');
      member.role = body.role;
    }
    if (body.perms !== undefined || body.role === 'member') {
      member.perms = member.role === 'admin' ? normalizePerms(body.perms) : normalizePerms({});
    }
    await saveCompany(company);
    const changed = await getUser(params.userId);
    await logAction(company.id, user.id, 'member:access',
      `${changed ? changed.nick : params.userId} → ${member.role}`);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { ok: true };
  });

  route('DELETE', '/api/companies/:id/members/:userId', async ({ user, params }) => {
    const { company } = await requireCompany(params.id, user.id);
    const isSelf = params.userId === user.id;
    if (!isSelf && !can(company, user.id, 'members')) throw denied('You do not have permission for this action.');
    if (params.userId === company.ownerId) throw bad('The owner cannot be removed.');
    if (!memberOf(company, params.userId)) throw missing('Member not found.');

    for (const group of company.groups) {
      if (!group.members.includes(params.userId)) continue;
      group.members = group.members.filter((u) => u !== params.userId);
      await syncGroupConv(company, group);
    }
    const removed = await getUser(params.userId);
    company.members = company.members.filter((m) => m.userId !== params.userId);
    await saveCompany(company);
    await indexRemove(params.userId, 'companyIds', company.id);
    await logAction(company.id, user.id, isSelf ? 'member:leave' : 'member:remove',
      removed ? removed.nick : params.userId);

    await emit([...company.members.map((m) => m.userId), params.userId],
      { type: 'company:update', companyId: company.id });
    return { ok: true };
  });

  /* ---- gruplar ---- */

  route('POST', '/api/companies/:id/groups', async ({ user, params, body }) => {
    const { company } = await requireCompany(params.id, user.id, 'groups');
    const name = cleanText(body.name, 60);
    if (name.length < 2) throw bad('Group name must be at least 2 characters.');

    const requested = Array.isArray(body.memberIds) ? body.memberIds : [];
    const members = [...new Set([user.id, ...requested])]
      .filter((uid) => memberOf(company, uid));

    const group = {
      id: id(), name, slug: await uniqueSlug(body.slug || null),
      description: cleanText(body.description, 200),
      members, createdBy: user.id, createdAt: now(), convId: null
    };
    company.groups.push(group);
    await store.set(`gidx/${group.id}`, company.id);
    await syncGroupConv(company, group);
    await saveCompany(company);

    // grup daveti icin link kimligi
    await store.set(`inv/${group.slug}`, {
      companyId: company.id, groupId: group.id, role: 'member',
      perms: normalizePerms({}), createdBy: user.id, createdAt: now(), uses: 0, disabled: false
    });
    company.invites = [...(company.invites || []), group.slug];
    await saveCompany(company);
    await logAction(company.id, user.id, 'group:create', `${group.name} (/${group.slug})`);

    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { group: groupPayload(company, group, user.id) };
  });

  route('PATCH', '/api/groups/:groupId', async ({ user, params, body }) => {
    const { company, group } = await companyByGroup(params.groupId, user.id, 'groups');
    if (body.name !== undefined) {
      const name = cleanText(body.name, 60);
      if (name.length < 2) throw bad('Group name must be at least 2 characters.');
      group.name = name;
    }
    if (body.description !== undefined) group.description = cleanText(body.description, 200);
    await saveCompany(company);
    await logAction(company.id, user.id, 'group:update', group.name);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { group: groupPayload(company, group, user.id) };
  });

  route('DELETE', '/api/groups/:groupId', async ({ user, params }) => {
    const { company, group } = await companyByGroup(params.groupId, user.id, 'groups');
    if (group.convId) {
      for (const memberId of group.members) await indexRemove(memberId, 'convIds', group.convId);
      for (const key of await store.list(`m/${group.convId}/`)) await store.del(key);
      await store.del(`conv/${group.convId}`);
    }
    await store.del(`gidx/${group.id}`);
    if (group.slug) {
      await store.del(`inv/${group.slug}`);
      company.invites = (company.invites || []).filter((s) => s !== group.slug);
    }
    company.groups = company.groups.filter((g) => g.id !== group.id);
    await saveCompany(company);
    await logAction(company.id, user.id, 'group:delete', group.name);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { ok: true };
  });

  route('POST', '/api/groups/:groupId/members', async ({ user, params, body }) => {
    const { company, group } = await companyByGroup(params.groupId, user.id, 'groups');
    const targetId = String(body.userId || '');
    if (!memberOf(company, targetId)) throw bad('That user is not a member of this company.');
    if (!group.members.includes(targetId)) {
      group.members.push(targetId);
      await syncGroupConv(company, group);
      await saveCompany(company);
      const added = await getUser(targetId);
      await logAction(company.id, user.id, 'group:member:add',
        `${added ? added.nick : targetId} → ${group.name}`);
    }
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    await emit([targetId], { type: 'conversations:refresh' });
    return { ok: true };
  });

  route('DELETE', '/api/groups/:groupId/members/:userId', async ({ user, params }) => {
    const companyId = await store.get(`gidx/${params.groupId}`);
    if (!companyId) throw missing('Group not found.');
    const isSelf = params.userId === user.id;
    const { company, group } = await companyByGroup(params.groupId, user.id, isSelf ? null : 'groups');
    const left = await getUser(params.userId);
    group.members = group.members.filter((u) => u !== params.userId);
    await syncGroupConv(company, group);
    await saveCompany(company);
    await logAction(company.id, user.id, 'group:member:remove',
      `${left ? left.nick : params.userId} ← ${group.name}`);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    await emit([params.userId], { type: 'conversations:refresh' });
    return { ok: true };
  });

  /* ---- davet linkleri ---- */

  route('POST', '/api/companies/:id/invites', async ({ user, params, body }) => {
    await limit(`invite:${user.id}`, LIMITS.invite);
    const { company } = await requireCompany(params.id, user.id, 'invites');
    if (body.groupId && !company.groups.some((g) => g.id === body.groupId)) throw bad('That group does not belong to this company.');
    const slug = await uniqueSlug(body.slug || null);
    const role = body.role === 'admin' ? 'admin' : 'member';
    const invite = {
      companyId: company.id,
      groupId: body.groupId || null,
      role,
      perms: role === 'admin' ? normalizePerms(body.perms) : normalizePerms({}),
      maxUses: Number.isInteger(body.maxUses) && body.maxUses > 0 ? body.maxUses : 0,
      uses: 0, disabled: false, createdBy: user.id, createdAt: now()
    };
    await store.set(`inv/${slug}`, invite);
    company.invites = [...(company.invites || []), slug];
    await saveCompany(company);
    await logAction(company.id, user.id, 'invite:create', `/${slug}`);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { invite: { ...invite, slug } };
  });

  route('DELETE', '/api/invites/:slug', async ({ user, params }) => {
    const slug = assertSlug(params.slug);
    const invite = await store.get(`inv/${slug}`);
    if (!invite) throw missing('Invite not found.');
    const { company } = await requireCompany(invite.companyId, user.id, 'invites');
    if (company.groups.some((g) => g.slug === slug)) throw bad('A group link closes when the group is deleted.');
    await store.del(`inv/${slug}`);
    company.invites = (company.invites || []).filter((s) => s !== slug);
    await saveCompany(company);
    await logAction(company.id, user.id, 'invite:delete', `/${slug}`);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });
    return { ok: true };
  });

  /** Davet onizlemesi — giris yapmadan da gorunur. */
  route('GET', '/api/invites/:slug', async ({ params, ip }) => {
    await limit(`invpeek:${ip}`, LIMITS.search);
    const slug = assertSlug(params.slug);
    const invite = await store.get(`inv/${slug}`);
    if (!invite) throw missing('Invite not found or revoked.');
    const company = await getCompany(invite.companyId);
    if (!company) throw missing('This invite is no longer valid.');
    const group = invite.groupId ? company.groups.find((g) => g.id === invite.groupId) : null;
    const host = await getUser(invite.createdBy);
    const exhausted = invite.disabled || (invite.maxUses > 0 && invite.uses >= invite.maxUses);
    return {
      invite: {
        slug, companyName: company.name, groupName: group ? group.name : null,
        role: invite.role, hostNick: host ? host.nick : null,
        memberCount: company.members.length, valid: !exhausted
      }
    };
  }, { open: true });

  route('POST', '/api/invites/:slug/join', async ({ user, params }) => {
    await limit(`join:${user.id}`, LIMITS.join);
    const slug = assertSlug(params.slug);
    const invite = await store.get(`inv/${slug}`);
    if (!invite) throw missing('Invite not found.');
    if (invite.disabled || (invite.maxUses > 0 && invite.uses >= invite.maxUses)) throw bad('This invite link has been used up.');
    const company = await getCompany(invite.companyId);
    if (!company) throw missing('This invite is no longer valid.');

    let joined = false;
    if (!memberOf(company, user.id)) {
      company.members.push({
        userId: user.id, role: invite.role, joinedAt: now(),
        perms: invite.role === 'admin' ? normalizePerms(invite.perms) : normalizePerms({})
      });
      await indexAdd(user.id, 'companyIds', company.id);
      joined = true;
    }
    const group = invite.groupId ? company.groups.find((g) => g.id === invite.groupId) : null;
    if (group && !group.members.includes(user.id)) {
      group.members.push(user.id);
      await syncGroupConv(company, group);
      joined = true;
    }
    if (joined) {
      invite.uses += 1;
      await store.set(`inv/${slug}`, invite);
    }
    await saveCompany(company);
    if (joined) await logAction(company.id, user.id, 'member:join', `/${slug}`);
    await emit(company.members.map((m) => m.userId), { type: 'company:update', companyId: company.id });

    return {
      companyId: company.id, companyName: company.name,
      groupId: group ? group.id : null, groupName: group ? group.name : null, joined
    };
  });

  /* ---- sohbetler ---- */

  route('GET', '/api/conversations', async ({ user }) => {
    const index = await userIndex(user.id);
    const convs = (await Promise.all(index.convIds.map(getConv))).filter(Boolean);
    const list = await Promise.all(convs.map((c) => convPayload(c, user.id)));
    list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return { conversations: list };
  });

  route('POST', '/api/conversations/dm', async ({ user, body }) => {
    const otherId = String(body.userId || '');
    if (otherId === user.id) throw bad('You cannot start a conversation with yourself.');
    const other = await getUser(otherId);
    if (!other) throw bad('User not found.');

    // Sohbet icin arkadas olmak ya da ayni sirkette bulunmak gerekir.
    if (!(await areFriends(user.id, otherId)) && !(await shareCompany(user.id, otherId))) {
      throw denied('Send a friend request first, or join the same company.');
    }

    const dmKey = [user.id, otherId].sort().join(':');
    let convId = await store.get(`dm/${dmKey}`);
    let conv = convId && await getConv(convId);
    if (!conv) {
      conv = { id: id(), kind: 'dm', dmKey, members: [user.id, otherId], createdAt: now() };
      await saveConv(conv);
      await store.set(`dm/${dmKey}`, conv.id);
      await indexAdd(user.id, 'convIds', conv.id);
      await indexAdd(otherId, 'convIds', conv.id);
      await emit([otherId], { type: 'conversations:refresh' });
    }
    return { conversation: await convPayload(conv, user.id) };
  });

  function messageView(message, sender, userId, convId) {
    return {
      id: message.id,
      conversationId: convId,
      senderId: message.senderId,
      senderNick: sender ? sender.nick : 'deleted',
      senderAvatar: sender ? sender.avatar || null : null,
      system: message.system || null,
      iv: message.iv || null,
      ciphertext: message.ciphertext || null,
      attachment: message.attachment || null,
      key: (message.keys && message.keys[userId]) || null,
      expiresAt: message.expiresAt || 0,
      createdAt: message.createdAt
    };
  }

  route('GET', '/api/conversations/:id/messages', async ({ user, params, query }) => {
    const conv = await requireConv(params.id, user.id);
    const limit = Math.min(Number(query.limit) || 60, 200);
    const keys = await store.list(`m/${conv.id}/`);
    const slice = keys.slice(-limit);
    const docs = await Promise.all(slice.map(async (k) => [k, await store.get(k)]));

    // Suresi gecen gecici mesajlari sil.
    const stamp = now();
    const alive = [];
    for (const [key, doc] of docs) {
      if (!doc) continue;
      if (doc.expiresAt && doc.expiresAt <= stamp) {
        await store.del(key);
        if (doc.attachment && doc.attachment.blobId) await store.del(`blob/${conv.id}/${doc.attachment.blobId}`);
        continue;
      }
      alive.push(doc);
    }

    const messages = await Promise.all(alive.map(async (m) =>
      messageView(m, await getUser(m.senderId), user.id, conv.id)));
    return { messages, hasMore: keys.length > slice.length, ttlSeconds: conv.ttlSeconds || 0 };
  });

  route('POST', '/api/conversations/:id/messages', async ({ user, params, body }) => {
    await limit(`msg:${user.id}`, LIMITS.message);
    const conv = await requireConv(params.id, user.id);

    const system = body.system === 'screenshot' ? 'screenshot' : null;
    if (!system) {
      if (!isB64(body.iv, 200) || !isB64(body.ciphertext, MAX_CIPHERTEXT)) throw bad('Encrypted body is invalid.');
      if (!Array.isArray(body.keys) || !body.keys.length) throw bad('Key envelopes are missing.');
    }
    if (Array.isArray(body.keys) && body.keys.length > MAX_KEY_ENVELOPES) {
      throw bad('Too many key envelopes.');
    }

    const keys = {};
    for (const k of (Array.isArray(body.keys) ? body.keys : [])) {
      if (!k || typeof k !== 'object' || typeof k.userId !== 'string') continue;
      if (!conv.members.includes(k.userId)) continue;
      if (!isB64(k.iv, 200) || !isB64(k.wrapped, 4000)) throw bad('A key envelope is invalid.');
      keys[k.userId] = { iv: k.iv, wrapped: k.wrapped };
    }

    let attachment = null;
    if (body.attachment) {
      const a = body.attachment;
      if (!a || typeof a !== 'object') throw bad('Attachment metadata is invalid.');
      const blobId = assertId(a.blobId, 'attachment id');
      if (!(await store.get(`blob/${conv.id}/${blobId}`))) throw bad('Attachment not found.');
      if (!isB64(a.iv, 200)) throw bad('Ek anahtar bilgisi gecersiz.');
      const mime = typeof a.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime)
        ? a.mime.slice(0, 100)
        : 'application/octet-stream';
      const isImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime);
      attachment = {
        blobId,
        iv: a.iv,
        // Gorseller tarayicida gosterilir; digerleri yalnizca indirilebilir dosya olarak durur.
        mime: isImage ? mime : 'application/octet-stream',
        kind: isImage && a.kind !== 'file' ? 'image' : 'file',
        name: cleanText(a.name, 120) || 'file',
        size: Number(a.size) || 0,
        width: Number(a.width) || 0,
        height: Number(a.height) || 0
      };
    }

    const ttl = Number(body.ttl);
    const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 604800) : (conv.ttlSeconds || 0);
    const createdAt = now();
    const message = {
      id: id(), senderId: user.id, system,
      iv: body.iv || null, ciphertext: body.ciphertext || null,
      attachment, keys, createdAt,
      expiresAt: ttlSeconds ? createdAt + ttlSeconds * 1000 : 0
    };

    await store.set(`m/${conv.id}/${String(createdAt).padStart(14, '0')}-${message.id.slice(0, 6)}`, message);
    await store.set(`read/${conv.id}/${user.id}`, createdAt);

    for (const memberId of conv.members) {
      await emit([memberId], {
        type: 'message:new',
        message: messageView(message, user, memberId, conv.id)
      });
    }
    return { id: message.id, createdAt, expiresAt: message.expiresAt };
  });

  /** Sifreli gorsel yukleme: sunucu icerigi acamaz, yalnizca saklar. */
  route('POST', '/api/conversations/:id/blobs', async ({ user, params, body }) => {
    await limit(`upload:${user.id}`, LIMITS.upload);
    const conv = await requireConv(params.id, user.id);
    if (!isB64(body.data, MAX_BLOB_B64)) throw bad('File is invalid or too large (about 4 MB max).');
    const blobId = id();
    await store.set(`blob/${conv.id}/${blobId}`, { data: body.data, uploadedBy: user.id, at: now() });
    return { blobId };
  });

  route('GET', '/api/conversations/:id/blobs/:blobId', async ({ user, params }) => {
    const conv = await requireConv(params.id, user.id);
    const blob = await store.get(`blob/${conv.id}/${params.blobId}`);
    if (!blob) throw missing('Attachment not found.');
    return { data: blob.data };
  });

  /** Gecici mesaj suresi (0 = kapali). */
  route('POST', '/api/conversations/:id/ttl', async ({ user, params, body }) => {
    const conv = await requireConv(params.id, user.id);
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 604800) throw bad('Invalid duration.');
    conv.ttlSeconds = Math.floor(seconds);
    await saveConv(conv);
    await emit(conv.members, {
      type: 'conversation:ttl', conversationId: conv.id,
      ttlSeconds: conv.ttlSeconds, byNick: user.nick
    });
    return { ttlSeconds: conv.ttlSeconds };
  });

  /**
   * Ekran goruntusu bildirimi. Tarayicilar ekran goruntusu almayi guvenilir
   * bicimde algilayamaz; istemci yakalayabildigi durumda (PrintScreen tusu,
   * macOS kisayollari, sayfanin paylasima alinmasi) bunu bildirir.
   */
  route('POST', '/api/conversations/:id/notice', async ({ user, params, body }) => {
    await limit(`notice:${user.id}`, LIMITS.notice);
    const conv = await requireConv(params.id, user.id);
    if (body.kind !== 'screenshot') throw bad('Unknown notice.');
    const createdAt = now();
    const message = { id: id(), senderId: user.id, system: 'screenshot', keys: {}, createdAt, expiresAt: 0 };
    await store.set(`m/${conv.id}/${String(createdAt).padStart(14, '0')}-${message.id.slice(0, 6)}`, message);
    for (const memberId of conv.members) {
      await emit([memberId], { type: 'message:new', message: messageView(message, user, memberId, conv.id) });
    }
    return { ok: true };
  });

  route('POST', '/api/conversations/:id/read', async ({ user, params }) => {
    const conv = await requireConv(params.id, user.id);
    await store.set(`read/${conv.id}/${user.id}`, now());
    return { ok: true };
  });

  route('POST', '/api/conversations/:id/typing', async ({ user, params }) => {
    const conv = await requireConv(params.id, user.id);
    await emit(conv.members.filter((m) => m !== user.id), {
      type: 'typing', conversationId: conv.id, userId: user.id, nick: user.nick
    });
    return { ok: true };
  });

  /* ---- gorevler ---- */

  route('POST', '/api/companies/:id/tasks', async ({ user, params, body }) => {
    const { company } = await requireCompany(params.id, user.id, 'tasks');
    const title = cleanText(body.title, 120);
    if (title.length < 2) throw bad('Task title must be at least 2 characters.');
    if (body.assigneeUserId && body.assigneeGroupId) throw bad('A task is assigned to either a person or a group.');
    if (body.assigneeUserId && !memberOf(company, body.assigneeUserId)) throw bad('The assignee is not in this company.');
    if (body.assigneeGroupId && !company.groups.some((g) => g.id === body.assigneeGroupId)) throw bad('That group does not belong to this company.');

    const task = {
      id: id(), companyId: company.id, title,
      description: longText(body.description, 2000),
      status: STATUSES.includes(body.status) ? body.status : 'todo',
      priority: PRIORITIES.includes(body.priority) ? body.priority : 'normal',
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : null,
      assigneeUserId: body.assigneeUserId || null,
      assigneeGroupId: body.assigneeGroupId || null,
      createdBy: user.id, createdAt: now(), updatedAt: now()
    };
    await store.set(`task/${company.id}/${task.id}`, task);
    await store.set(`tidx/${task.id}`, company.id);
    await logAction(company.id, user.id, 'task:create', task.title);

    const audience = task.assigneeGroupId
      ? (company.groups.find((g) => g.id === task.assigneeGroupId) || { members: [] }).members
      : task.assigneeUserId ? [task.assigneeUserId] : [];
    await emit(company.members.map((m) => m.userId), { type: 'task:changed', companyId: company.id });
    await emit(audience.filter((uid) => uid !== user.id), {
      type: 'task:assigned', companyId: company.id, title: task.title, companyName: company.name
    });

    return { task: await taskPayload(company, task) };
  });

  route('GET', '/api/tasks/mine', async ({ user }) => {
    const index = await userIndex(user.id);
    const out = [];
    for (const companyId of index.companyIds) {
      const company = await getCompany(companyId);
      if (!company) continue;
      const myGroups = company.groups.filter((g) => g.members.includes(user.id)).map((g) => g.id);
      for (const task of await companyTasks(company)) {
        if (task.assigneeUserId === user.id || myGroups.includes(task.assigneeGroupId)) out.push(task);
      }
    }
    const rank = { doing: 0, todo: 1, done: 2 };
    out.sort((a, b) => (rank[a.status] - rank[b.status]) || b.updatedAt - a.updatedAt);
    return { tasks: out };
  });

  route('PATCH', '/api/tasks/:taskId', async ({ user, params, body }) => {
    const companyId = await store.get(`tidx/${params.taskId}`);
    if (!companyId) throw missing('Task not found.');
    const { company } = await requireCompany(companyId, user.id);
    const task = await store.get(`task/${companyId}/${params.taskId}`);
    if (!task) throw missing('Task not found.');

    const group = task.assigneeGroupId ? company.groups.find((g) => g.id === task.assigneeGroupId) : null;
    const isAssignee = task.assigneeUserId === user.id || (group && group.members.includes(user.id));
    const manages = can(company, user.id, 'tasks');
    if (!manages && !isAssignee) throw denied('You cannot change this task.');

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw bad('Invalid status.');
      task.status = body.status;
    }
    if (manages) {
      if (body.title !== undefined) {
        const title = cleanText(body.title, 120);
        if (title.length < 2) throw bad('Task title must be at least 2 characters.');
        task.title = title;
      }
      if (body.description !== undefined) task.description = longText(body.description, 2000);
      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) throw bad('Invalid priority.');
        task.priority = body.priority;
      }
      if (body.dueDate !== undefined) {
        task.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : null;
      }
      if (body.assigneeUserId !== undefined) {
        if (body.assigneeUserId && !memberOf(company, body.assigneeUserId)) throw bad('The assignee is not in this company.');
        task.assigneeUserId = body.assigneeUserId || null;
        if (task.assigneeUserId) task.assigneeGroupId = null;
      }
      if (body.assigneeGroupId !== undefined) {
        if (body.assigneeGroupId && !company.groups.some((g) => g.id === body.assigneeGroupId)) throw bad('That group does not belong to this company.');
        task.assigneeGroupId = body.assigneeGroupId || null;
        if (task.assigneeGroupId) task.assigneeUserId = null;
      }
    }
    task.updatedAt = now();
    await store.set(`task/${companyId}/${task.id}`, task);
    await logAction(companyId, user.id, 'task:update', `${task.title} → ${task.status}`);
    await emit(company.members.map((m) => m.userId), { type: 'task:changed', companyId });
    return { task: await taskPayload(company, task) };
  });

  route('DELETE', '/api/tasks/:taskId', async ({ user, params }) => {
    const companyId = await store.get(`tidx/${params.taskId}`);
    if (!companyId) throw missing('Task not found.');
    const { company } = await requireCompany(companyId, user.id, 'tasks');
    const removedTask = await store.get(`task/${companyId}/${params.taskId}`);
    await store.del(`task/${companyId}/${params.taskId}`);
    await store.del(`tidx/${params.taskId}`);
    await logAction(companyId, user.id, 'task:delete', removedTask ? removedTask.title : params.taskId);
    await emit(company.members.map((m) => m.userId), { type: 'task:changed', companyId });
    return { ok: true };
  });

  /* ---- toplantilar ---- */

  route('POST', '/api/companies/:id/meetings', async ({ user, params, body }) => {
    const { company } = await requireCompany(params.id, user.id, 'meetings');
    const title = cleanText(body.title, 120);
    if (title.length < 2) throw bad('Meeting title must be at least 2 characters.');
    if (body.groupId && !company.groups.some((g) => g.id === body.groupId)) throw bad('That group does not belong to this company.');
    const startsAt = Number(body.startsAt);
    if (!Number.isFinite(startsAt) || startsAt < now() - 86400000) throw bad('Pick a valid start time.');

    const meeting = {
      id: id(), companyId: company.id, title,
      description: longText(body.description, 1000),
      groupId: body.groupId || null,
      kind: body.kind === 'video' ? 'video' : 'audio',
      startsAt,
      durationMin: Number.isInteger(body.durationMin) ? Math.min(Math.max(body.durationMin, 10), 480) : 30,
      status: 'scheduled',
      createdBy: user.id, createdAt: now(), updatedAt: now()
    };
    await store.set(`meet/${company.id}/${meeting.id}`, meeting);
    await store.set(`midx/${meeting.id}`, company.id);
    await logAction(company.id, user.id, 'meeting:create', meeting.title);

    await emit(company.members.map((m) => m.userId), { type: 'meeting:changed', companyId: company.id });
    await emit(meetingAudience(company, meeting).filter((uid) => uid !== user.id), {
      type: 'meeting:invited', companyId: company.id, meetingId: meeting.id,
      title: meeting.title, startsAt: meeting.startsAt
    });
    return { meeting: await meetingPayload(company, meeting) };
  });

  route('GET', '/api/meetings/mine', async ({ user }) => {
    const index = await userIndex(user.id);
    const out = [];
    for (const companyId of index.companyIds) {
      const company = await getCompany(companyId);
      if (!company) continue;
      for (const meeting of await companyMeetings(company)) {
        if (meetingAudience(company, meeting).includes(user.id)) out.push(meeting);
      }
    }
    out.sort((a, b) => a.startsAt - b.startsAt);
    return { meetings: out };
  });

  route('PATCH', '/api/meetings/:meetingId', async ({ user, params, body }) => {
    const companyId = await store.get(`midx/${params.meetingId}`);
    if (!companyId) throw missing('Meeting not found.');
    const { company } = await requireCompany(companyId, user.id, 'meetings');
    const meeting = await store.get(`meet/${companyId}/${params.meetingId}`);
    if (!meeting) throw missing('Meeting not found.');

    if (body.title !== undefined) {
      const title = cleanText(body.title, 120);
      if (title.length < 2) throw bad('Meeting title must be at least 2 characters.');
      meeting.title = title;
    }
    if (body.description !== undefined) meeting.description = longText(body.description, 1000);
    if (body.startsAt !== undefined) {
      const startsAt = Number(body.startsAt);
      if (!Number.isFinite(startsAt)) throw bad('Pick a valid start time.');
      meeting.startsAt = startsAt;
    }
    if (body.status !== undefined) {
      if (!['scheduled', 'live', 'ended', 'cancelled'].includes(body.status)) throw bad('Invalid status.');
      meeting.status = body.status;
    }
    if (body.kind !== undefined) meeting.kind = body.kind === 'video' ? 'video' : 'audio';
    meeting.updatedAt = now();

    await store.set(`meet/${companyId}/${meeting.id}`, meeting);
    await emit(company.members.map((m) => m.userId), { type: 'meeting:changed', companyId });
    return { meeting: await meetingPayload(company, meeting) };
  });

  route('DELETE', '/api/meetings/:meetingId', async ({ user, params }) => {
    const companyId = await store.get(`midx/${params.meetingId}`);
    if (!companyId) throw missing('Meeting not found.');
    const { company } = await requireCompany(companyId, user.id, 'meetings');
    const removedMeeting = await store.get(`meet/${companyId}/${params.meetingId}`);
    await store.del(`meet/${companyId}/${params.meetingId}`);
    await store.del(`midx/${params.meetingId}`);
    await logAction(companyId, user.id, 'meeting:cancel',
      removedMeeting ? removedMeeting.title : params.meetingId);
    await emit(company.members.map((m) => m.userId), { type: 'meeting:changed', companyId });
    return { ok: true };
  });

  /* ---- sesli / goruntulu gorusme sinyallesmesi ----
     Medya tarayicilar arasinda dogrudan akar (WebRTC, DTLS-SRTP).
     Sunucu yalnizca sifreli teklif/yanit paketlerini tasir.            */

  async function roomFor(user, body) {
    if (body && body.conversationId) {
      const conv = await requireConv(body.conversationId, user.id);
      return {
        roomId: `conv:${conv.id}`,
        audience: conv.members,
        title: conv.kind === 'group' ? 'Grup gorusmesi' : null
      };
    }
    if (body && body.meetingId) {
      assertId(body.meetingId, 'meeting id');
      const companyId = await store.get(`midx/${body.meetingId}`);
      if (!companyId) throw missing('Meeting not found.');
      const { company } = await requireCompany(companyId, user.id);
      const meeting = await store.get(`meet/${companyId}/${body.meetingId}`);
      if (!meeting) throw missing('Meeting not found.');
      const audience = meetingAudience(company, meeting);
      if (!audience.includes(user.id)) throw denied('You cannot join this meeting.');
      return { roomId: `meet:${meeting.id}`, audience, title: meeting.title, meeting, company };
    }
    throw bad('No call target was given.');
  }

  route('POST', '/api/calls/start', async ({ user, body }) => {
    const { roomId, audience, title, meeting, company } = await roomFor(user, body);
    const kind = body.kind === 'video' ? 'video' : 'audio';
    const room = {
      roomId, kind, title: title || null,
      startedBy: user.id, startedAt: now(),
      participants: [{ userId: user.id, joinedAt: now() }]
    };
    await store.set(`room/${roomId}`, room);

    if (meeting) await logAction(meeting.companyId, user.id, 'call:start', meeting.title);
    if (meeting && meeting.status === 'scheduled') {
      meeting.status = 'live';
      meeting.updatedAt = now();
      await store.set(`meet/${meeting.companyId}/${meeting.id}`, meeting);
      await emit(company.members.map((m) => m.userId), { type: 'meeting:changed', companyId: meeting.companyId });
    }

    await emit(audience.filter((uid) => uid !== user.id), {
      type: 'call:ring',
      roomId, kind, fromUserId: user.id, fromNick: user.nick,
      title: room.title, conversationId: body.conversationId || null, meetingId: body.meetingId || null
    });
    return { room };
  });

  route('POST', '/api/calls/join', async ({ user, body }) => {
    const { roomId, audience } = await roomFor(user, body);
    const room = (await store.get(`room/${roomId}`)) || {
      roomId, kind: body.kind === 'video' ? 'video' : 'audio',
      startedBy: user.id, startedAt: now(), participants: []
    };
    if (now() - room.startedAt > CALL_TTL) {
      room.startedAt = now();
      room.participants = [];
    }
    const peers = room.participants.filter((p) => p.userId !== user.id).map((p) => p.userId);
    if (!room.participants.some((p) => p.userId === user.id)) {
      room.participants.push({ userId: user.id, joinedAt: now() });
    }
    await store.set(`room/${roomId}`, room);

    await emit(peers, { type: 'call:joined', roomId, userId: user.id, nick: user.nick });
    await emit(audience.filter((uid) => uid !== user.id && !peers.includes(uid)),
      { type: 'call:state', roomId, userId: user.id, state: 'joined' });

    return { room, peers: await publicUsers(peers) };
  });

  route('POST', '/api/calls/leave', async ({ user, body }) => {
    const { roomId, audience } = await roomFor(user, body);
    const room = await store.get(`room/${roomId}`);
    if (room) {
      room.participants = room.participants.filter((p) => p.userId !== user.id);
      if (room.participants.length) await store.set(`room/${roomId}`, room);
      else await store.del(`room/${roomId}`);
    }
    await emit(audience.filter((uid) => uid !== user.id),
      { type: 'call:state', roomId, userId: user.id, nick: user.nick, state: 'left' });
    return { ok: true };
  });

  route('POST', '/api/calls/decline', async ({ user, body }) => {
    const { roomId, audience } = await roomFor(user, body);
    await emit(audience.filter((uid) => uid !== user.id),
      { type: 'call:state', roomId, userId: user.id, nick: user.nick, state: 'declined' });
    return { ok: true };
  });

  /** Teklif/yanit/ICE paketleri: icerik istemcide sifrelenir, sunucu tasiyicidir. */
  route('POST', '/api/calls/signal', async ({ user, body }) => {
    await limit(`call:${user.id}`, LIMITS.call);
    const { roomId } = assertRoom(body.roomId);
    const toUserId = assertId(body.toUserId, 'target');
    const room = await store.get(`room/${roomId}`);
    if (!room) throw missing('Call not found.');
    if (!room.participants.some((p) => p.userId === user.id)) throw denied('You are not in this call.');

    await emit([toUserId], {
      type: 'call:signal', roomId, fromUserId: user.id, fromNick: user.nick,
      signal: body.signal, payload: body.payload || null
    });
    return { ok: true };
  });

  route('GET', '/api/calls/state', async ({ user, query }) => {
    const parsed = assertRoom(query.roomId);
    if (parsed.kind === 'conv') await requireConv(parsed.id, user.id);
    else {
      const companyId = await store.get(`midx/${parsed.id}`);
      if (!companyId) throw missing('Meeting not found.');
      await requireCompany(companyId, user.id);
    }
    const room = await store.get(`room/${parsed.roomId}`);
    if (!room) return { room: null };
    return { room, participants: await publicUsers(room.participants.map((p) => p.userId)) };
  });

  /* ================================================================ */
  /* yonlendirici                                                     */
  /* ================================================================ */

  const ID_PARAMS = new Set(['id', 'userId', 'groupId', 'taskId', 'meetingId', 'blobId']);

  function match(method, pathParts) {
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== pathParts.length) continue;
      const params = {};
      let hit = true;
      for (let i = 0; i < r.parts.length; i++) {
        const part = r.parts[i];
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(pathParts[i]);
        else if (part !== pathParts[i]) { hit = false; break; }
      }
      if (hit) return { route: r, params };
    }
    return null;
  }

  return async function handle(method, url, body = {}, headers = {}) {
    const parsed = new URL(url, 'http://edge.local');
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const query = Object.fromEntries(parsed.searchParams.entries());

    const found = match(method.toUpperCase(), pathParts);
    if (!found) return { status: 404, body: { error: 'Not found.' } };

    const ip = String(
      headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || headers['x-real-ip'] || 'local'
    ).split(',')[0].trim().slice(0, 45);

    try {
      // Depo anahtarina girecek her kimlik once bicim denetiminden gecer.
      for (const [key, value] of Object.entries(found.params)) {
        if (ID_PARAMS.has(key)) assertId(value, key);
        else if (key === 'slug') found.params.slug = assertSlug(value);
        else if (key === 'nick') found.params.nick = assertNickish(value);
      }

      let user = null;
      if (!found.route.open) {
        user = await authUser(headers);
        await touch(user);
      }
      const result = await found.route.handler({
        user, params: found.params, query,
        body: body && typeof body === 'object' ? body : {},
        headers, ip
      });
      return { status: 200, body: result };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('edge:', err);
      return { status, body: { error: status >= 500 ? 'Server error.' : err.message } };
    }
  };
}

export { PERMS };

/** Uygulama kabugu: giris ekrani, sol serit, listeler ve olay dagitimi. */

import * as E2E from './crypto.js';
import { api, setToken, getToken, startEvents, stopEvents, onEvent } from './net.js';
import { h, icon, ICONS, avatarNode, clear, relTime, dateTimeLabel } from './dom.js';
import { toast, guard, openModal, closeModal, form, field, actions, emptyState, iconBtn, copyText } from './ui.js';
import * as store from './store.js';
import { state } from './store.js';
import { chatPane, renderTyping } from './chat.js';
import { companyPane, meetingCard, meetingModal } from './panel.js';
import { taskBoard } from './tasks.js';
import { friendsPane, addFriendModal } from './friends.js';
import * as call from './call.js';
import { pickFile, toAvatarDataUrl, watchScreenshots } from './media.js';

const $ = (sel) => document.querySelector(sel);
const gate = $('#gate');
const app = $('#app');

const VAULT = 'edge.vault';
const loadVault = () => { try { return JSON.parse(localStorage.getItem(VAULT)); } catch { return null; } };
const saveVault = (v) => localStorage.setItem(VAULT, JSON.stringify(v));
const dropVault = () => localStorage.removeItem(VAULT);

/* ================================================================== */
/* giris ekrani                                                        */
/* ================================================================== */

const gateError = (message) => { $('#gate-error').textContent = message || ''; };

function showGate(mode) {
  app.classList.add('is-hidden');
  gate.classList.remove('is-hidden');
  gateError('');
  const isUnlock = mode === 'unlock';
  $('#unlock-form').classList.toggle('is-hidden', !isUnlock);
  $('#gate-tabs').classList.toggle('is-hidden', isUnlock);
  $('#login-form').classList.toggle('is-hidden', isUnlock || mode !== 'login');
  $('#register-form').classList.toggle('is-hidden', isUnlock || mode !== 'register');
  document.querySelectorAll('[data-gate-tab]').forEach((tab) =>
    tab.classList.toggle('is-active', tab.dataset.gateTab === mode));
  const focusable = $(`#${isUnlock ? 'unlock' : mode}-form`).querySelector('input');
  if (focusable) focusable.focus();
}

document.querySelectorAll('[data-gate-tab]').forEach((tab) =>
  tab.addEventListener('click', () => showGate(tab.dataset.gateTab)));

function busy(formEl, on, label) {
  const btn = formEl.querySelector('button[type=submit]');
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const nick = f.nick.value.trim();
  const password = f.password.value;
  gateError('');
  if (password.length < 8) return gateError('Parola en az 8 karakter olmali.');

  busy(f, true, 'Anahtarlar uretiliyor...');
  try {
    const identity = await E2E.generateIdentity();
    const kdfSalt = E2E.newKdfSalt();
    const kek = await E2E.deriveKek(password, kdfSalt);
    const encPrivKey = await E2E.sealPrivateKey(identity.privateKey, kek);
    const authHash = await E2E.deriveAuthHash(password, nick);

    const res = await api.post('/auth/register', {
      nick, displayName: f.displayName.value.trim(), authHash, kdfSalt,
      publicKey: identity.publicKey, encPrivKey
    });

    setToken(res.token);
    saveVault({ nick: res.user.nick, encPrivKey, kdfSalt, kdfIters: res.kdfIters });
    E2E.setPrivateKey(identity.privateKey);
    state.user = res.user;
    await startApp();
  } catch (err) {
    gateError(err.message);
  } finally {
    busy(f, false);
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const nick = f.nick.value.trim();
  const password = f.password.value;
  gateError('');

  busy(f, true, 'Giris yapiliyor...');
  try {
    const params = await api.get(`/auth/params/${encodeURIComponent(nick)}`);
    const authHash = await E2E.deriveAuthHash(password, nick);
    const res = await api.post('/auth/login', { nick, authHash });
    const kek = await E2E.deriveKek(password, res.kdfSalt, res.kdfIters || params.kdfIters);
    const privateKey = await E2E.openPrivateKey(res.encPrivKey, kek);

    setToken(res.token);
    saveVault({ nick: res.user.nick, encPrivKey: res.encPrivKey, kdfSalt: res.kdfSalt, kdfIters: res.kdfIters });
    E2E.setPrivateKey(privateKey);
    state.user = res.user;
    await startApp();
  } catch (err) {
    gateError(err.name === 'OperationError' ? 'Parola hatali.' : err.message);
  } finally {
    busy(f, false);
  }
});

$('#unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const vault = loadVault();
  if (!vault) return signOut();
  gateError('');
  busy(f, true, 'Aciliyor...');
  try {
    const kek = await E2E.deriveKek(f.password.value, vault.kdfSalt, vault.kdfIters);
    E2E.setPrivateKey(await E2E.openPrivateKey(vault.encPrivKey, kek));
    state.user = (await api.get('/api/me')).user;
    f.reset();
    await startApp();
  } catch (err) {
    gateError(err.name === 'OperationError' ? 'Parola hatali.' : err.message);
  } finally {
    busy(f, false);
  }
});

document.querySelectorAll('[data-action="sign-out"]').forEach((b) => b.addEventListener('click', signOut));

function signOut() {
  api.post('/auth/logout').catch(() => {});
  if (call.isActive()) call.endCall();
  stopEvents();
  setToken(null);
  dropVault();
  E2E.clearKeys();
  state.user = null;
  state.messages.clear();
  state.seen.clear();
  closeModal();
  showGate('login');
}

/* ================================================================== */
/* davet ve profil linkleri                                            */
/* ================================================================== */

function parseLink() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'u' && parts[1]) return { kind: 'profile', nick: parts[1] };
  if (parts.length === 1) return { kind: 'invite', slug: parts[0].toLowerCase() };
  return null;
}

async function showInviteBanner(link) {
  const box = $('#gate-invite');
  try {
    if (link.kind === 'invite') {
      const { invite } = await api.get(`/api/invites/${encodeURIComponent(link.slug)}`);
      state.pendingInvite = invite.valid ? link.slug : null;
      box.replaceChildren(
        h('span', { class: 'pill pill-accent', text: 'davet' }),
        h('div', { class: 'grow' }, [
          h('strong', { text: invite.companyName }),
          h('div', { class: 'muted', text: invite.valid
            ? `${invite.groupName ? `${invite.groupName} grubuna` : 'sirkete'} katilmak icin giris yap · ${invite.memberCount} uye`
            : 'Bu davet linki artik gecerli degil.' })
        ])
      );
      box.classList.remove('is-hidden');
    } else {
      const { profile } = await api.get(`/api/users/${encodeURIComponent(link.nick)}/profile`);
      state.pendingProfile = profile.nick;
      box.replaceChildren(
        avatarNode(profile.nick, profile.avatar, { size: 'avatar-sm' }),
        h('div', { class: 'grow' }, [
          h('strong', { text: `@${profile.nick}` }),
          h('div', { class: 'muted', text: 'Giris yaptiktan sonra arkadaslik istegi gonderebilirsin.' })
        ])
      );
      box.classList.remove('is-hidden');
    }
  } catch {
    box.classList.add('is-hidden');
  }
}

async function consumePendingLink() {
  const slug = state.pendingInvite;
  const nick = state.pendingProfile;
  state.pendingInvite = null;
  state.pendingProfile = null;
  history.replaceState({}, '', '/');

  if (slug) {
    await guard(async () => {
      const res = await api.post(`/api/invites/${encodeURIComponent(slug)}/join`);
      await store.refreshAll();
      state.nav = res.companyId;
      await store.loadCompany(res.companyId);
      store.notify();
      toast(res.joined
        ? `${res.companyName} sirketine katildin${res.groupName ? ` · ${res.groupName}` : ''}.`
        : `${res.companyName} sirketinde zaten uyesin.`);
    });
  } else if (nick && nick !== state.user.nick) {
    addFriendModal(nick);
  }
}

/* ================================================================== */
/* baslatma                                                           */
/* ================================================================== */

async function startApp() {
  gate.classList.add('is-hidden');
  app.classList.remove('is-hidden');
  call.setMe(state.user);
  await store.refreshAll();
  render();
  startEvents();
  watchScreenshots(onScreenshot);
  await consumePendingLink();
}

async function boot() {
  const link = parseLink();
  if (link) await showInviteBanner(link);

  if (!getToken()) return showGate('login');
  try {
    state.user = (await api.get('/api/me')).user;
    if (!E2E.hasPrivateKey()) return showGate('unlock');
    await startApp();
  } catch {
    setToken(null);
    showGate('login');
  }
}

/* ================================================================== */
/* olaylar                                                            */
/* ================================================================== */

onEvent(async (event) => {
  if (event.type.startsWith('call:')) {
    await call.handleEvent(event, store.lookupUser);
    if (event.type === 'call:ring') return;
  }

  switch (event.type) {
    case 'session:invalid':
      toast('Oturum sona erdi, tekrar giris yap.', true);
      signOut();
      break;

    case 'message:new':
      await onIncomingMessage(event.message);
      break;

    case 'typing': {
      state.typing.set(event.conversationId, { nick: event.nick, at: Date.now() });
      renderTyping();
      setTimeout(renderTyping, 3300);
      break;
    }

    case 'conversation:ttl': {
      const conv = store.conversationById(event.conversationId);
      if (conv) conv.ttlSeconds = event.ttlSeconds;
      if (event.byNick !== state.user.nick) {
        toast(event.ttlSeconds
          ? `${event.byNick} gecici mesajlari acti.`
          : `${event.byNick} gecici mesajlari kapatti.`);
      }
      render();
      break;
    }

    case 'company:update':
    case 'company:joined':
    case 'company:delete':
    case 'conversations:refresh':
      await guard(async () => {
        await store.refreshAll();
        if (state.companies.some((c) => c.id === state.nav)) await store.loadCompany(state.nav);
        else if (!['dm', 'friends', 'tasks', 'meetings'].includes(state.nav)) {
          state.nav = 'dm';
          state.companyDetail = null;
        }
        render();
      });
      if (event.type === 'company:joined') toast(`${event.companyName || 'Bir sirkete'} eklendin.`);
      break;

    case 'task:changed':
      await guard(async () => {
        await store.refreshTasks();
        if (state.companyDetail && state.companyDetail.company.id === event.companyId) {
          await store.loadCompany(event.companyId);
        }
        render();
      });
      break;

    case 'task:assigned':
      toast(`Yeni gorev: ${event.title}`);
      break;

    case 'meeting:changed':
      await guard(async () => {
        await store.refreshMeetings();
        if (state.companyDetail && state.companyDetail.company.id === event.companyId) {
          await store.loadCompany(event.companyId);
        }
        render();
      });
      break;

    case 'meeting:invited':
      toast(`Toplanti daveti: ${event.title} · ${dateTimeLabel(event.startsAt)}`);
      break;

    case 'friend:request':
      await guard(async () => { await store.refreshFriends(); render(); });
      toast(`${event.nick} arkadaslik istegi gonderdi.`);
      break;

    case 'friend:accepted':
      await guard(async () => { await store.refreshAll(); render(); });
      toast(`${event.nick} istegini kabul etti.`);
      break;

    case 'friend:changed':
      await guard(async () => { await store.refreshFriends(); render(); });
      break;
  }
});

async function onIncomingMessage(message) {
  let conv = store.conversationById(message.conversationId);
  if (!conv) {
    await guard(store.refreshAll);
    conv = store.conversationById(message.conversationId);
    if (!conv) return;
  }
  conv.lastMessageAt = message.createdAt;

  const list = state.messages.get(conv.id);
  const seen = state.seen.get(conv.id);
  const active = store.activeConversation();
  const isActive = active && active.id === conv.id;

  if (list && seen && !seen.has(message.id)) {
    seen.add(message.id);
    list.push(await store.decryptOne(conv, message));
  }

  if (isActive) {
    state.typing.delete(conv.id);
    conv.unread = 0;
    api.post(`/api/conversations/${conv.id}/read`).catch(() => {});
    await guard(store.refreshConversations);
  } else if (message.senderId !== state.user.id) {
    conv.unread = (conv.unread || 0) + 1;
  }
  render();
}

/** Ekran goruntusu sezildiginde sohbete bildir. */
let lastShot = 0;
function onScreenshot() {
  const conv = store.activeConversation();
  if (!conv || Date.now() - lastShot < 4000) return;
  lastShot = Date.now();
  store.reportScreenshot(conv).catch(() => {});
}

/* ---- gelen cagri ---- */

call.onRing((ring) => {
  const box = $('#ring');
  if (!ring) return box.classList.add('is-hidden');

  box.replaceChildren(h('div', { class: 'ring-card' }, [
    h('div', { class: 'ring-pulse' }, [icon(ring.kind === 'video' ? ICONS.video : ICONS.phone, 24)]),
    h('div', { class: 'grow' }, [
      h('strong', { text: ring.title || ring.fromNick }),
      h('div', { class: 'muted', text: `${ring.fromNick} ${ring.kind === 'video' ? 'goruntulu' : 'sesli'} ariyor` })
    ]),
    h('button', {
      class: 'btn btn-primary', text: 'Katil',
      onClick: () => guard(async () => {
        box.classList.add('is-hidden');
        call.setMe(state.user);
        const conv = ring.target.conversationId ? store.conversationById(ring.target.conversationId) : null;
        await call.acceptCall({
          target: ring.target, roomId: ring.roomId, kind: ring.kind, title: ring.title,
          multi: Boolean(ring.target.meetingId) || (conv ? conv.kind === 'group' : false)
        });
      })
    }),
    h('button', {
      class: 'btn btn-danger-solid', text: 'Reddet',
      onClick: () => { box.classList.add('is-hidden'); call.declineCall(); }
    })
  ]));
  box.classList.remove('is-hidden');
});

/* ================================================================== */
/* cizim                                                              */
/* ================================================================== */

store.subscribe(() => render());

function render() {
  if (!state.user) return;
  renderRail();
  renderSide();
  renderMain();
}

function renderRail() {
  const dmUnread = store.unreadFor((c) => c.kind === 'dm');
  const badges = {
    dm: dmUnread,
    friends: state.friends.incoming.length,
    tasks: state.myTasks.filter((t) => t.status !== 'done').length,
    meetings: state.myMeetings.filter((m) => m.status !== 'cancelled' && m.startsAt > Date.now() - 3600000).length
  };

  document.querySelectorAll('[data-nav]').forEach((btn) => {
    const key = btn.dataset.nav;
    btn.classList.toggle('is-active', key === state.nav);
    btn.querySelectorAll('.badge-dot').forEach((b) => b.remove());
    const count = badges[key] || 0;
    if (count && key !== 'tasks') {
      btn.append(h('span', { class: 'badge-dot', text: count > 99 ? '99+' : String(count) }));
    }
  });

  const wrap = clear($('#rail-companies'));
  for (const company of state.companies) {
    const unread = store.unreadFor((c) => c.companyId === company.id);
    wrap.append(h('button', {
      class: `rail-btn${state.nav === company.id ? ' is-active' : ''}`,
      title: company.name, 'aria-label': company.name,
      onClick: () => selectCompany(company.id)
    }, [
      avatarNode(company.name, company.logo, { size: 'avatar-sm', accent: state.nav === company.id }),
      unread ? h('span', { class: 'badge-dot', text: unread > 99 ? '99+' : String(unread) }) : null
    ]));
  }

  const me = clear($('#rail-me'));
  me.append(avatarNode(state.user.nick, state.user.avatar, { size: 'avatar-sm' }));
}

async function selectCompany(companyId) {
  state.nav = companyId;
  state.filter = '';
  state.companyTab = 'groups';
  render();
  await guard(async () => { await store.loadCompany(companyId); render(); });
}

function renderSide() {
  const list = clear($('#side-list'));
  const filter = state.filter.toLowerCase();
  const title = $('#side-title');
  const newBtn = $('[data-action="new-dm"]');
  newBtn.classList.add('is-hidden');

  if (state.nav === 'dm') {
    title.textContent = 'Mesajlar';
    newBtn.classList.remove('is-hidden');
    const dms = state.conversations
      .filter((c) => c.kind === 'dm')
      .filter((c) => !filter || c.title.toLowerCase().includes(filter))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    if (!dms.length) {
      list.append(h('p', { class: 'muted note-pad', text: 'Henuz sohbet yok. Arkadas ekleyip sohbet baslatabilirsin.' }));
      return;
    }
    dms.forEach((conv) => list.append(conversationRow(conv)));
    return;
  }

  if (state.nav === 'friends') {
    title.textContent = 'Arkadaslar';
    const rows = [...state.friends.incoming, ...state.friends.friends];
    if (!rows.length) {
      list.append(h('p', { class: 'muted note-pad', text: 'Arkadas listesi bos.' }));
      return;
    }
    for (const row of rows) {
      list.append(h('button', {
        class: 'row', onClick: () => guard(() => store.startDm(row.user.id))
      }, [
        avatarNode(row.user.nick, row.user.avatar, { online: row.user.online }),
        h('div', { class: 'row-body' }, [
          h('div', { class: 'row-title' }, [h('strong', { text: row.user.nick })]),
          h('div', { class: 'row-sub', text: row.state === 'pending-in' ? 'istek bekliyor' : row.user.displayName })
        ]),
        row.state === 'pending-in' ? h('span', { class: 'count', text: '1' }) : null
      ]));
    }
    return;
  }

  if (state.nav === 'tasks') {
    title.textContent = 'Gorevlerim';
    const counts = {
      open: state.myTasks.filter((t) => t.status !== 'done').length,
      todo: state.myTasks.filter((t) => t.status === 'todo').length,
      doing: state.myTasks.filter((t) => t.status === 'doing').length,
      done: state.myTasks.filter((t) => t.status === 'done').length,
      all: state.myTasks.length
    };
    for (const [key, label] of [['open', 'Acik gorevler'], ['todo', 'Yapilacak'], ['doing', 'Devam eden'], ['done', 'Bitenler'], ['all', 'Tumu']]) {
      list.append(h('button', {
        class: `row${state.taskFilter === key ? ' is-active' : ''}`,
        onClick: () => { state.taskFilter = key; render(); }
      }, [
        h('div', { class: 'row-body' }, [h('div', { class: 'row-title' }, [h('strong', { text: label })])]),
        h('span', { class: 'pill', text: String(counts[key]) })
      ]));
    }
    return;
  }

  if (state.nav === 'meetings') {
    title.textContent = 'Toplantilar';
    const list2 = state.myMeetings.filter((m) => m.status !== 'cancelled');
    if (!list2.length) {
      list.append(h('p', { class: 'muted note-pad', text: 'Planli toplanti yok.' }));
      return;
    }
    for (const meeting of list2) {
      list.append(h('button', { class: 'row', onClick: () => { state.nav = 'meetings'; render(); } }, [
        h('span', { class: 'avatar avatar-sm' }, [icon(meeting.kind === 'video' ? ICONS.video : ICONS.phone, 14)]),
        h('div', { class: 'row-body' }, [
          h('div', { class: 'row-title' }, [h('strong', { text: meeting.title })]),
          h('div', { class: 'row-sub', text: `${dateTimeLabel(meeting.startsAt)} · ${meeting.companyName}` })
        ]),
        meeting.status === 'live' ? h('span', { class: 'pill pill-danger', text: 'canli' }) : null
      ]));
    }
    return;
  }

  // sirket
  const detail = state.companyDetail;
  title.textContent = detail ? detail.company.name : 'Yukleniyor...';
  if (!detail) return;

  list.append(h('button', {
    class: `row${!store.activeConversation() ? ' is-active' : ''}`,
    onClick: () => { state.activeConv.delete(store.navKey()); app.classList.remove('show-list'); render(); }
  }, [
    avatarNode(detail.company.name, detail.company.logo, { accent: true }),
    h('div', { class: 'row-body' }, [
      h('div', { class: 'row-title' }, [h('strong', { text: 'Yonetim paneli' })]),
      h('div', { class: 'row-sub', text: `${detail.members.length} uye · ${detail.groups.length} grup` })
    ])
  ]));

  const mine = detail.groups.filter((g) => g.isMember && g.convId)
    .filter((g) => !filter || g.name.toLowerCase().includes(filter));
  list.append(h('div', { class: 'side-group-label', text: 'Kanallar' }));
  if (!mine.length) list.append(h('p', { class: 'muted note-pad-sm', text: 'Uye oldugun grup yok.' }));
  for (const group of mine) {
    const conv = store.conversationById(group.convId);
    if (conv) list.append(conversationRow(conv, group.name));
  }
}

function conversationRow(conv, overrideTitle) {
  const active = store.activeConversation();
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m.id !== state.user.id) : null;
  const online = peer ? Boolean(conv.online && conv.online[peer.id]) : false;
  const typing = state.typing.get(conv.id);
  const isTyping = typing && Date.now() - typing.at < 3200;

  return h('button', {
    class: `row${active && active.id === conv.id ? ' is-active' : ''}`,
    onClick: () => guard(() => store.openConversation(conv))
  }, [
    avatarNode(overrideTitle || conv.title, peer ? peer.avatar : null, {
      accent: conv.kind === 'group', online: peer ? online : null
    }),
    h('div', { class: 'row-body' }, [
      h('div', { class: 'row-title' }, [h('strong', { text: overrideTitle || conv.title })]),
      h('div', {
        class: `row-sub${isTyping ? ' is-typing' : ''}`,
        text: isTyping ? 'yaziyor...'
          : conv.kind === 'group' ? `${conv.members.length} uye`
            : (online ? 'cevrimici' : 'cevrimdisi')
      })
    ]),
    h('div', { class: 'row-meta' }, [
      conv.lastMessageAt ? h('span', { class: 'row-time', text: relTime(conv.lastMessageAt) }) : null,
      conv.unread ? h('span', { class: 'count', text: String(conv.unread) }) : null
    ])
  ]);
}

function renderMain() {
  const main = clear($('#main'));
  const conv = store.activeConversation();

  if (state.nav === 'friends') return main.append(friendsPane());
  if (state.nav === 'tasks') return main.append(myTasksPane());
  if (state.nav === 'meetings') return main.append(myMeetingsPane());
  if (conv) return main.append(chatPane(conv));
  if (state.nav === 'dm') {
    return main.append(emptyState(
      'Uctan uca sifreli sohbet',
      'Soldan bir sohbet sec, ya da arkadas ekleyip yeni bir sohbet baslat.',
      h('button', { class: 'btn btn-primary', onClick: () => { state.nav = 'friends'; render(); } }, [
        icon(ICONS.friends, 15), 'Arkadas ekle'
      ])
    ));
  }
  if (!state.companyDetail) return main.append(emptyState('Yukleniyor', 'Sirket bilgileri getiriliyor.'));
  return main.append(companyPane(state.companyDetail));
}

function myTasksPane() {
  const labels = { open: 'Acik gorevler', todo: 'Yapilacak', doing: 'Devam eden', done: 'Bitenler', all: 'Tum gorevler' };
  const tasks = state.myTasks.filter((t) => {
    if (state.taskFilter === 'all') return true;
    if (state.taskFilter === 'open') return t.status !== 'done';
    return t.status === state.taskFilter;
  });

  return h('div', { class: 'pane' }, [
    h('header', { class: 'pane-head' }, [
      iconBtn(ICONS.back, 'Liste', () => app.classList.add('show-list'), 'only-narrow'),
      h('div', { class: 'grow' }, [
        h('h3', { text: labels[state.taskFilter] }),
        h('p', { class: 'muted', text: 'Sana ve uyesi oldugun gruplara atanan gorevler' })
      ])
    ]),
    h('div', { class: 'pane-body' }, [taskBoard(tasks, null)])
  ]);
}

function myMeetingsPane() {
  const list = state.myMeetings.filter((m) => m.status !== 'cancelled');
  const manageable = state.companies.filter((c) => c.role === 'owner' || (c.perms && c.perms.meetings));

  return h('div', { class: 'pane' }, [
    h('header', { class: 'pane-head' }, [
      iconBtn(ICONS.back, 'Liste', () => app.classList.add('show-list'), 'only-narrow'),
      h('div', { class: 'grow' }, [
        h('h3', { text: 'Toplantilar' }),
        h('p', { class: 'muted', text: `${list.length} planli toplanti` })
      ]),
      manageable.length ? h('button', {
        class: 'btn btn-sm btn-primary',
        onClick: () => guard(async () => {
          const detail = await store.loadCompany(manageable[0].id);
          meetingModal(detail);
        })
      }, [icon(ICONS.plus, 15), 'Toplanti planla']) : null
    ]),
    h('div', { class: 'pane-body' }, [
      list.length
        ? h('div', { class: 'cards' }, list.map((meeting) => meetingCard(meeting, null, false)))
        : emptyState('Toplanti yok', 'Bir sirkette toplanti planlandiginda burada gorunur.')
    ])
  ]);
}

/* ================================================================== */
/* diyaloglar ve baglama                                              */
/* ================================================================== */

function companyModal() {
  openModal('Sirket olustur', (close) => {
    const name = h('input', { placeholder: 'Sirket adi', required: true, maxlength: 60 });
    return form(() => guard(async () => {
      const res = await api.post('/api/companies', { name: name.value });
      close();
      await store.refreshAll();
      await selectCompany(res.company.id);
      toast('Sirket olusturuldu. Davet linki: /' + res.company.slug);
    }), [
      field('Sirket adi', name),
      h('p', { class: 'muted', text: 'Sahibi sen olursun: uye ekler, grup acar, gorev atar, yetkileri belirlersin. Sirket icin otomatik bir davet linki uretilir.' }),
      actions(close, 'Olustur')
    ]);
  });
}

function dmModal() {
  openModal('Yeni sohbet', (close) => {
    const results = h('div', { class: 'check-list' });
    const input = h('input', { placeholder: 'nick ara', autocomplete: 'off', onInput: (e) => search(e.target.value) });
    let timer;

    function search(q) {
      clearTimeout(timer);
      timer = setTimeout(() => guard(async () => {
        clear(results);
        if (q.trim().length < 2) return results.append(h('p', { class: 'muted', text: 'En az 2 karakter yaz.' }));
        const res = await api.get(`/api/users?q=${encodeURIComponent(q.trim())}`);
        if (!res.users.length) return results.append(h('p', { class: 'muted', text: 'Kullanici bulunamadi.' }));
        for (const user of res.users) {
          results.append(h('button', {
            class: 'check-row', type: 'button',
            onClick: () => guard(async () => {
              try {
                close();
                await store.startDm(user.id);
              } catch (err) {
                addFriendModal(user.nick);
                throw err;
              }
            })
          }, [
            avatarNode(user.nick, user.avatar, { size: 'avatar-sm' }),
            h('div', { class: 'grow text-left' }, [
              h('strong', { text: user.nick }),
              h('div', { class: 'row-sub', text: user.displayName })
            ])
          ]));
        }
      }), 220);
    }

    search('');
    return [
      field('Kullanici', input, 'Sohbet icin arkadas olmaniz ya da ayni sirkette olmaniz gerekir.'),
      results,
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
    ];
  });
}

async function profileModal() {
  const fingerprint = await E2E.fingerprint(state.user.publicKey);
  openModal('Profil', (close) => {
    const displayName = h('input', { value: state.user.displayName, maxlength: 40 });
    const avatarBox = h('div', { class: 'avatar-edit' }, [
      avatarNode(state.user.nick, state.user.avatar, { size: 'avatar-xl', accent: true }),
      h('div', { class: 'stack' }, [
        h('button', {
          class: 'btn btn-sm', type: 'button', text: 'Foto sec',
          onClick: () => guard(async () => {
            const file = await pickFile('image/*');
            if (!file) return;
            const dataUrl = await toAvatarDataUrl(file);
            const res = await api.post('/api/me/avatar', { dataUrl });
            state.user = res.user;
            close();
            render();
            toast('Profil fotosu guncellendi.');
          })
        }),
        state.user.avatar ? h('button', {
          class: 'btn btn-sm btn-ghost', type: 'button', text: 'Kaldir',
          onClick: () => guard(async () => {
            const res = await api.post('/api/me/avatar', { dataUrl: null });
            state.user = res.user;
            close();
            render();
          })
        }) : null
      ])
    ]);

    return form(() => guard(async () => {
      const res = await api.patch('/api/me', { displayName: displayName.value });
      state.user = res.user;
      close();
      render();
      toast('Profil guncellendi.');
    }), [
      avatarBox,
      h('div', { class: 'card-head' }, [
        h('div', { class: 'grow' }, [
          h('div', { class: 'card-title', text: `@${state.user.nick}` }),
          h('div', { class: 'muted', text: 'Nick degistirilemez.' })
        ]),
        h('button', {
          class: 'btn btn-sm', type: 'button', text: 'Profil linki',
          onClick: () => copyText(`${location.origin}/u/${state.user.nick}`, 'Profil linkin kopyalandi.')
        })
      ]),
      field('Gorunen ad', displayName),
      field('Anahtar parmak izin', h('div', { class: 'fp', text: fingerprint }),
        'Karsi tarafla ayni goruyorsaniz sohbet dogrulanmis demektir.'),
      actions(close, 'Kaydet', h('button', {
        class: 'btn btn-danger', type: 'button', text: 'Cikis yap',
        onClick: () => { close(); signOut(); }
      }))
    ]);
  });
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], [data-nav]');
  if (!target) return;
  if (target.dataset.nav) {
    state.nav = target.dataset.nav;
    state.filter = '';
    $('#side-filter').value = '';
    if (state.nav === 'friends') guard(async () => { await store.refreshFriends(); render(); });
    render();
    return;
  }
  switch (target.dataset.action) {
    case 'new-company': companyModal(); break;
    case 'new-dm': dmModal(); break;
    case 'profile': profileModal(); break;
    case 'close-modal': closeModal(); break;
  }
});

$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('is-hidden')) closeModal();
});
$('#side-filter').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderSide();
});

boot();

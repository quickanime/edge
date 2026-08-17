import * as E2E from './crypto.js';
import { api, setToken, getToken, connect, disconnect, onEvent, socketSend } from './net.js';
import { h, icon, ICONS, avatar, clear, timeShort, dayLabel, relTime } from './dom.js';

/* ================================================================== */
/* durum                                                               */
/* ================================================================== */

const state = {
  user: null,
  companies: [],
  conversations: [],
  companyDetail: null,
  myTasks: [],
  messages: new Map(),   // conversationId -> [mesaj]
  seen: new Map(),        // conversationId -> Set(id)
  drafts: new Map(),
  online: new Set(),
  typing: new Map(),      // conversationId -> { nick, at }
  nav: 'dm',              // 'dm' | 'tasks' | sirket id
  activeConv: new Map(),  // nav -> conversationId
  companyTab: 'groups',
  taskFilter: 'open',
  filter: '',
  stickToBottom: true
};

const $ = (sel) => document.querySelector(sel);
const gate = $('#gate');
const app = $('#app');

const VAULT = 'edge.vault';
const loadVault = () => { try { return JSON.parse(localStorage.getItem(VAULT)); } catch { return null; } };
const saveVault = (v) => localStorage.setItem(VAULT, JSON.stringify(v));
const dropVault = () => localStorage.removeItem(VAULT);

/* ================================================================== */
/* kucuk arayuz yardimcilari                                           */
/* ================================================================== */

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('is-hidden'), 3200);
}

function openModal(title, buildBody) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  const body = clear($('#modal-body'));
  body.append(...[].concat(buildBody(closeModal)));
  modal.classList.remove('is-hidden');
  const first = body.querySelector('input, textarea, select, button');
  if (first) first.focus();
}

function closeModal() {
  $('#modal').classList.add('is-hidden');
  clear($('#modal-body'));
}

function actions(closeFn, submitLabel, onSubmit, extra) {
  return h('div', { class: 'modal-actions' }, [
    extra || null,
    h('button', { class: 'btn btn-ghost', type: 'button', onClick: closeFn, text: 'Vazgec' }),
    h('button', { class: 'btn btn-primary', type: 'submit', onClick: onSubmit, text: submitLabel })
  ]);
}

function form(onSubmit, children) {
  return h('form', {
    class: 'form',
    onSubmit: (e) => { e.preventDefault(); onSubmit(e); }
  }, children);
}

async function guard(fn) {
  try { await fn(); } catch (err) { toast(err.message || 'Hata', true); }
}

/* ================================================================== */
/* giris / kayit / kilit                                               */
/* ================================================================== */

function gateError(message) {
  $('#gate-error').textContent = message || '';
}

function showGate(mode) {
  app.classList.add('is-hidden');
  gate.classList.remove('is-hidden');
  gateError('');
  const isUnlock = mode === 'unlock';
  $('#unlock-form').classList.toggle('is-hidden', !isUnlock);
  $('.tabs').classList.toggle('is-hidden', isUnlock);
  $('#login-form').classList.toggle('is-hidden', isUnlock || mode !== 'login');
  $('#register-form').classList.toggle('is-hidden', isUnlock || mode !== 'register');
  if (isUnlock) $('#unlock-form input[name=password]').focus();
}

document.querySelectorAll('[data-gate-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    showGate(tab.dataset.gateTab);
    document.querySelectorAll('[data-gate-tab]').forEach((t) => t.classList.toggle('is-active', t === tab));
  });
});

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
  const displayName = f.displayName.value.trim();
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
      nick, displayName, authHash, kdfSalt, publicKey: identity.publicKey, encPrivKey
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
    saveVault({
      nick: res.user.nick, encPrivKey: res.encPrivKey,
      kdfSalt: res.kdfSalt, kdfIters: res.kdfIters
    });
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
    const me = await api.get('/api/me');
    state.user = me.user;
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
  disconnect();
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
/* baslatma                                                            */
/* ================================================================== */

async function startApp() {
  gate.classList.add('is-hidden');
  app.classList.remove('is-hidden');
  await refreshAll();
  connect();
  render();
}

async function refreshAll() {
  const [companies, conversations, tasks] = await Promise.all([
    api.get('/api/companies'),
    api.get('/api/conversations'),
    api.get('/api/tasks/mine')
  ]);
  state.companies = companies.companies;
  state.conversations = conversations.conversations;
  state.myTasks = tasks.tasks;
}

async function boot() {
  if (!getToken()) return showGate('login');
  try {
    const me = await api.get('/api/me');
    state.user = me.user;
    if (!E2E.hasPrivateKey()) return showGate('unlock');
    await startApp();
  } catch {
    setToken(null);
    showGate('login');
  }
}

/* ================================================================== */
/* olaylar                                                             */
/* ================================================================== */

onEvent(async (event) => {
  switch (event.type) {
    case 'ready':
      state.online = new Set(event.online);
      renderSide();
      break;
    case 'presence':
      if (event.online) state.online.add(event.userId); else state.online.delete(event.userId);
      renderSide();
      if (activeConversation()) renderMain();
      break;
    case 'message:new':
      await onIncoming(event.message);
      break;
    case 'typing': {
      const conv = state.conversations.find((c) => c.id === event.conversationId);
      const who = conv && conv.members.find((m) => m.id === event.userId);
      state.typing.set(event.conversationId, { nick: who ? who.nick : 'biri', at: Date.now() });
      renderTyping();
      setTimeout(renderTyping, 3200);
      break;
    }
    case 'task:new':
    case 'task:update':
    case 'task:delete':
      await guard(async () => {
        state.myTasks = (await api.get('/api/tasks/mine')).tasks;
        if (state.companyDetail && (event.task ? event.task.companyId === state.companyDetail.company.id
          : event.companyId === state.companyDetail.company.id)) {
          await loadCompany(state.companyDetail.company.id);
        }
        render();
      });
      break;
    case 'company:update':
    case 'company:joined':
    case 'company:delete':
    case 'conversations:refresh':
      await guard(async () => {
        await refreshAll();
        if (typeof state.nav === 'string' && state.companies.some((c) => c.id === state.nav)) {
          await loadCompany(state.nav);
        } else if (state.nav !== 'dm' && state.nav !== 'tasks') {
          state.nav = 'dm';
          state.companyDetail = null;
        }
        render();
      });
      break;
  }
});

async function onIncoming(message) {
  let conv = state.conversations.find((c) => c.id === message.conversationId);
  if (!conv) {
    await guard(refreshAll);
    conv = state.conversations.find((c) => c.id === message.conversationId);
    if (!conv) return;
  }
  conv.lastMessageAt = message.createdAt;

  const list = state.messages.get(conv.id);
  const seen = state.seen.get(conv.id);
  const isActive = activeConversation() && activeConversation().id === conv.id;

  if (list && seen && !seen.has(message.id)) {
    seen.add(message.id);
    list.push(await decryptOne(conv, message));
  }

  if (isActive) {
    state.typing.delete(conv.id);
    api.post(`/api/conversations/${conv.id}/read`).catch(() => {});
    conv.unread = 0;
    renderMain();
  } else if (message.senderId !== state.user.id) {
    conv.unread = (conv.unread || 0) + 1;
  }
  renderSide();
  renderRail();
}

/* ================================================================== */
/* sohbet verisi                                                       */
/* ================================================================== */

function activeConversation() {
  const id = state.activeConv.get(navKey());
  return id ? state.conversations.find((c) => c.id === id) || null : null;
}

function navKey() {
  return String(state.nav);
}

async function decryptOne(conv, message) {
  const sender = conv.members.find((m) => m.id === message.senderId);
  const base = {
    id: message.id, senderId: message.senderId, senderNick: message.senderNick,
    createdAt: message.createdAt, text: null
  };
  if (!sender || !message.key) return base;
  try {
    base.text = await E2E.decryptMessage(message, sender.publicKey);
  } catch {
    base.text = null;
  }
  return base;
}

async function loadMessages(conv) {
  const res = await api.get(`/api/conversations/${conv.id}/messages?limit=60`);
  const list = [];
  for (const m of res.messages) list.push(await decryptOne(conv, m));
  state.messages.set(conv.id, list);
  state.seen.set(conv.id, new Set(res.messages.map((m) => m.id)));
}

async function openConversation(conv) {
  state.activeConv.set(navKey(), conv.id);
  state.stickToBottom = true;
  app.classList.remove('show-list');
  render();
  await guard(async () => {
    if (!state.messages.has(conv.id)) await loadMessages(conv);
    conv.unread = 0;
    await api.post(`/api/conversations/${conv.id}/read`);
    renderSide();
    renderRail();
    renderMain();
  });
}

async function sendMessage(conv, text) {
  const payload = await E2E.encryptMessage(text, conv.members);
  const res = await api.post(`/api/conversations/${conv.id}/messages`, payload);

  const seen = state.seen.get(conv.id);
  if (seen && !seen.has(res.id)) {
    seen.add(res.id);
    state.messages.get(conv.id).push({
      id: res.id, senderId: state.user.id, senderNick: state.user.nick,
      createdAt: res.createdAt, text
    });
  }
  conv.lastMessageAt = res.createdAt;
  state.stickToBottom = true;
  renderMain();
  renderSide();
}

async function loadCompany(companyId) {
  state.companyDetail = await api.get(`/api/companies/${companyId}`);
}

async function startDm(userId) {
  const res = await api.post('/api/conversations/dm', { userId });
  const conv = res.conversation;
  const existing = state.conversations.find((c) => c.id === conv.id);
  if (existing) Object.assign(existing, conv); else state.conversations.push(conv);
  state.nav = 'dm';
  await openConversation(state.conversations.find((c) => c.id === conv.id));
}

/* ================================================================== */
/* cizim: sol serit                                                    */
/* ================================================================== */

function unreadFor(filterFn) {
  return state.conversations.filter(filterFn).reduce((n, c) => n + (c.unread || 0), 0);
}

function renderRail() {
  const dmUnread = unreadFor((c) => c.kind === 'dm');
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === state.nav);
    btn.querySelectorAll('.badge-dot').forEach((b) => b.remove());
    if (btn.dataset.nav === 'dm' && dmUnread) {
      btn.append(h('span', { class: 'badge-dot', text: dmUnread > 99 ? '99+' : String(dmUnread) }));
    }
  });

  const wrap = clear($('#rail-companies'));
  for (const company of state.companies) {
    const unread = unreadFor((c) => c.companyId === company.id);
    const btn = h('button', {
      class: `rail-btn${state.nav === company.id ? ' is-active' : ''}`,
      title: company.name,
      'aria-label': company.name,
      onClick: () => selectCompany(company.id)
    }, [
      avatar(company.name, { size: 'avatar-sm', accent: state.nav === company.id }),
      unread ? h('span', { class: 'badge-dot', text: unread > 99 ? '99+' : String(unread) }) : null
    ]);
    wrap.append(btn);
  }

  const me = clear($('#rail-avatar'));
  me.textContent = state.user ? state.user.nick.slice(0, 2).toUpperCase() : '';
}

async function selectCompany(companyId) {
  state.nav = companyId;
  state.filter = '';
  render();
  await guard(async () => { await loadCompany(companyId); render(); });
}

/* ================================================================== */
/* cizim: orta liste                                                   */
/* ================================================================== */

function renderSide() {
  const list = clear($('#side-list'));
  const filter = state.filter.toLowerCase();
  const title = $('#side-title');
  const newBtn = $('[data-action="new-dm"]');

  if (state.nav === 'dm') {
    title.textContent = 'Mesajlar';
    newBtn.classList.remove('is-hidden');
    const dms = state.conversations
      .filter((c) => c.kind === 'dm')
      .filter((c) => !filter || c.title.toLowerCase().includes(filter))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    if (!dms.length) {
      list.append(h('p', { class: 'muted note-pad', text: 'Henuz sohbet yok. Sag ustteki + ile birini bul.' }));
      return;
    }
    for (const conv of dms) list.append(conversationRow(conv));
    return;
  }

  if (state.nav === 'tasks') {
    title.textContent = 'Gorevlerim';
    newBtn.classList.add('is-hidden');
    const counts = {
      open: state.myTasks.filter((t) => t.status !== 'done').length,
      todo: state.myTasks.filter((t) => t.status === 'todo').length,
      doing: state.myTasks.filter((t) => t.status === 'doing').length,
      done: state.myTasks.filter((t) => t.status === 'done').length,
      all: state.myTasks.length
    };
    const filters = [
      ['open', 'Acik gorevler'], ['todo', 'Yapilacak'],
      ['doing', 'Devam eden'], ['done', 'Bitenler'], ['all', 'Tumu']
    ];
    for (const [key, label] of filters) {
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

  // sirket gorunumu
  const detail = state.companyDetail;
  title.textContent = detail ? detail.company.name : 'Yukleniyor...';
  newBtn.classList.add('is-hidden');
  if (!detail) return;

  list.append(h('button', {
    class: `row${!activeConversation() ? ' is-active' : ''}`,
    onClick: () => { state.activeConv.delete(navKey()); app.classList.remove('show-list'); render(); }
  }, [
    avatar(detail.company.name, { accent: true }),
    h('div', { class: 'row-body' }, [
      h('div', { class: 'row-title' }, [h('strong', { text: 'Sirket paneli' })]),
      h('div', { class: 'row-sub', text: `${detail.members.length} uye · ${detail.groups.length} grup` })
    ])
  ]));

  const mine = detail.groups.filter((g) => g.isMember && g.conversationId)
    .filter((g) => !filter || g.name.toLowerCase().includes(filter));
  list.append(h('div', { class: 'side-group-label', text: 'Kanallar' }));
  if (!mine.length) {
    list.append(h('p', { class: 'muted note-pad-sm', text: 'Uye oldugun grup yok.' }));
  }
  for (const group of mine) {
    const conv = state.conversations.find((c) => c.id === group.conversationId);
    if (conv) list.append(conversationRow(conv, group.name));
    else list.append(h('button', {
      class: 'row', onClick: () => guard(refreshAll)
    }, [avatar(group.name), h('div', { class: 'row-body' }, [h('strong', { text: group.name })])]));
  }

  if (['owner', 'admin'].includes(detail.company.role)) {
    list.append(h('div', { class: 'side-group-label', text: 'Yonetim' }));
    list.append(sideAction('Grup olustur', ICONS.plus, () => groupModal(detail)));
    list.append(sideAction('Uye ekle', ICONS.users, () => memberModal(detail)));
    list.append(sideAction('Gorev olustur', ICONS.check, () => taskModal(detail)));
  }
}

function sideAction(label, path, onClick) {
  return h('button', { class: 'row', onClick }, [
    h('span', { class: 'avatar avatar-sm' }, [icon(path, 15)]),
    h('div', { class: 'row-body' }, [h('div', { class: 'row-title' }, [h('strong', { text: label })])])
  ]);
}

function conversationRow(conv, overrideTitle) {
  const active = activeConversation() && activeConversation().id === conv.id;
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m.id !== state.user.id) : null;
  const online = peer && state.online.has(peer.id);
  const typing = state.typing.get(conv.id);
  const isTyping = typing && Date.now() - typing.at < 3000;

  return h('button', {
    class: `row${active ? ' is-active' : ''}`,
    onClick: () => openConversation(conv)
  }, [
    avatar(overrideTitle || conv.title, { accent: conv.kind === 'group' }),
    h('div', { class: 'row-body' }, [
      h('div', { class: 'row-title' }, [
        peer ? h('span', { class: `dot${online ? ' is-online' : ''}` }) : null,
        h('strong', { text: overrideTitle || conv.title })
      ]),
      h('div', {
        class: 'row-sub',
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

/* ================================================================== */
/* cizim: ana panel                                                    */
/* ================================================================== */

function renderMain() {
  const main = clear($('#main'));

  if (state.nav === 'tasks') return main.append(tasksPane());

  const conv = activeConversation();
  if (conv) return main.append(chatPane(conv));

  if (state.nav === 'dm') return main.append(emptyPane(
    'Uctan uca sifreli sohbet',
    'Soldaki listeden bir sohbet sec ya da + ile yeni bir kisiyle konusmaya basla.'
  ));

  if (!state.companyDetail) return main.append(emptyPane('Yukleniyor', 'Sirket bilgileri getiriliyor.'));
  return main.append(companyPane(state.companyDetail));
}

function emptyPane(title, text) {
  return h('div', { class: 'empty' }, [
    h('img', { src: '/logo.svg', alt: '', width: 46, height: 46 }),
    h('h3', { text: title }),
    h('p', { text })
  ]);
}

/* ---- sohbet ---- */

function chatPane(conv) {
  const messages = state.messages.get(conv.id) || [];
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m.id !== state.user.id) : null;

  const head = h('header', { class: 'pane-head' }, [
    h('button', {
      class: 'icon-btn', title: 'Liste', 'aria-label': 'Liste',
      onClick: () => app.classList.add('show-list')
    }, [icon(ICONS.back)]),
    avatar(conv.title, { accent: conv.kind === 'group' }),
    h('div', { class: 'grow' }, [
      h('h3', { text: conv.title }),
      h('p', {
        class: 'muted',
        text: conv.kind === 'group'
          ? `${conv.subtitle ? conv.subtitle + ' · ' : ''}${conv.members.length} uye`
          : (peer && state.online.has(peer.id) ? 'cevrimici' : 'cevrimdisi')
      })
    ]),
    peer ? h('button', {
      class: 'icon-btn', title: 'Guvenlik', 'aria-label': 'Guvenlik',
      onClick: () => securityModal(peer)
    }, [icon(ICONS.lock)]) : h('button', {
      class: 'icon-btn', title: 'Uyeler', 'aria-label': 'Uyeler',
      onClick: () => membersModal(conv)
    }, [icon(ICONS.users)])
  ]);

  const listEl = h('div', { class: 'msgs' });
  let lastDay = '';
  let prev = null;
  for (const msg of messages) {
    const day = dayLabel(msg.createdAt);
    if (day !== lastDay) {
      listEl.append(h('div', { class: 'day-sep', text: day }));
      lastDay = day;
      prev = null;
    }
    const tail = prev && prev.senderId === msg.senderId && msg.createdAt - prev.createdAt < 300000;
    listEl.append(messageEl(msg, tail));
    prev = msg;
  }
  if (!messages.length) {
    listEl.append(h('div', { class: 'empty' }, [
      h('h3', { text: 'Ilk mesaji sen yaz' }),
      h('p', { text: 'Bu sohbetteki her mesaj cihazinda sifrelenir.' })
    ]));
  }

  listEl.addEventListener('scroll', () => {
    state.stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
  });

  const typingEl = h('div', { class: 'typing', id: 'typing-line' });

  const textarea = h('textarea', {
    placeholder: `${conv.title} icin mesaj yaz`,
    rows: 1,
    value: state.drafts.get(conv.id) || '',
    onInput: (e) => {
      state.drafts.set(conv.id, e.target.value);
      autoGrow(e.target);
      sendBtn.disabled = !e.target.value.trim();
      pingTyping(conv.id);
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    }
  });

  const sendBtn = h('button', {
    class: 'send', type: 'button', title: 'Gonder', 'aria-label': 'Gonder',
    disabled: !(state.drafts.get(conv.id) || '').trim(),
    onClick: () => submit()
  }, [icon(ICONS.send)]);

  function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    state.drafts.delete(conv.id);
    autoGrow(textarea);
    sendBtn.disabled = true;
    guard(() => sendMessage(conv, text));
  }

  const pane = h('div', { class: 'chat' }, [
    head,
    listEl,
    h('div', {}, [
      typingEl,
      h('div', { class: 'composer' }, [textarea, sendBtn]),
      h('div', { class: 'e2e-note' }, [icon(ICONS.lock, 13), 'Mesajlar uctan uca sifreli. Sunucu icerigi okuyamaz.'])
    ])
  ]);

  requestAnimationFrame(() => {
    if (state.stickToBottom) listEl.scrollTop = listEl.scrollHeight;
    autoGrow(textarea);
    renderTyping();
  });

  return pane;
}

function messageEl(msg, tail) {
  const mine = msg.senderId === state.user.id;
  return h('div', { class: `msg${tail ? ' is-tail' : ''}` }, [
    avatar(msg.senderNick, { accent: mine }),
    h('div', {}, [
      h('div', { class: 'msg-head' }, [
        h('strong', { text: mine ? 'Sen' : msg.senderNick }),
        h('time', { text: timeShort(msg.createdAt) })
      ]),
      msg.text === null
        ? h('div', { class: 'msg-text is-locked', text: 'Bu mesaj bu cihazda cozulemedi.' })
        : h('div', { class: 'msg-text', text: msg.text })
    ])
  ]);
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
}

let typingSentAt = 0;
function pingTyping(conversationId) {
  if (Date.now() - typingSentAt < 2000) return;
  typingSentAt = Date.now();
  socketSend({ type: 'typing', conversationId });
}

function renderTyping() {
  const line = $('#typing-line');
  if (!line) return;
  const conv = activeConversation();
  const t = conv && state.typing.get(conv.id);
  line.textContent = t && Date.now() - t.at < 3000 ? `${t.nick} yaziyor...` : '';
}

/* ---- gorevlerim ---- */

function tasksPane() {
  const labels = { open: 'Acik gorevler', todo: 'Yapilacak', doing: 'Devam eden', done: 'Bitenler', all: 'Tum gorevler' };
  const tasks = state.myTasks.filter((t) => {
    if (state.taskFilter === 'all') return true;
    if (state.taskFilter === 'open') return t.status !== 'done';
    return t.status === state.taskFilter;
  });

  const body = h('div', { class: 'pane-body' }, [
    tasks.length
      ? h('div', { class: 'cards' }, tasks.map((t) => taskCard(t, null)))
      : emptyPane('Gorev yok', 'Bu filtreye uyan bir gorev bulunmuyor.')
  ]);

  return h('div', { class: 'pane' }, [
    h('header', { class: 'pane-head' }, [
      h('button', {
        class: 'icon-btn', title: 'Liste', 'aria-label': 'Liste',
        onClick: () => app.classList.add('show-list')
      }, [icon(ICONS.back)]),
      h('div', { class: 'grow' }, [
        h('h3', { text: labels[state.taskFilter] }),
        h('p', { class: 'muted', text: `${tasks.length} gorev · sana veya grubuna atanan` })
      ])
    ]),
    body
  ]);
}

/* ---- sirket paneli ---- */

function companyPane(detail) {
  const { company, members, groups, tasks } = detail;
  const isManager = ['owner', 'admin'].includes(company.role);

  const tabs = h('div', { class: 'tabs-line' }, [
    ['groups', `Gruplar (${groups.length})`],
    ['members', `Uyeler (${members.length})`],
    ['tasks', `Gorevler (${tasks.filter((t) => t.status !== 'done').length})`]
  ].map(([key, label]) => h('button', {
    class: state.companyTab === key ? 'is-active' : '',
    onClick: () => { state.companyTab = key; renderMain(); },
    text: label
  })));

  let content;
  if (state.companyTab === 'members') content = membersSection(detail, isManager);
  else if (state.companyTab === 'tasks') content = tasksSection(detail, isManager);
  else content = groupsSection(detail, isManager);

  return h('div', { class: 'pane' }, [
    h('header', { class: 'pane-head' }, [
      h('button', {
        class: 'icon-btn', title: 'Liste', 'aria-label': 'Liste',
        onClick: () => app.classList.add('show-list')
      }, [icon(ICONS.back)]),
      avatar(company.name, { accent: true, size: 'avatar-lg' }),
      h('div', { class: 'grow' }, [
        h('h3', { text: company.name }),
        h('p', { class: 'muted', text: `${roleLabel(company.role)} · ${members.length} uye` })
      ]),
      company.role === 'owner' ? h('button', {
        class: 'icon-btn', title: 'Sirket ayarlari', 'aria-label': 'Sirket ayarlari',
        onClick: () => companySettingsModal(detail)
      }, [icon(ICONS.gear)]) : null
    ]),
    h('div', { class: 'pane-body' }, [h('div', { class: 'sheet' }, [tabs, content])])
  ]);
}

function roleLabel(role) {
  return { owner: 'Sirket sahibi', admin: 'Yonetici', member: 'Uye' }[role] || role;
}

function groupsSection(detail, isManager) {
  const { groups } = detail;
  return h('section', { class: 'sheet-section' }, [
    h('header', {}, [
      h('h4', { text: 'Gruplar' }),
      isManager ? h('button', { class: 'btn btn-sm', onClick: () => groupModal(detail) }, [icon(ICONS.plus, 15), 'Grup olustur']) : null
    ]),
    groups.length ? h('div', { class: 'cards' }, groups.map((g) => groupCard(g, detail, isManager)))
      : h('p', { class: 'muted', text: 'Henuz grup yok. Ekipleri gruplara bolerek ayri kanallar ac.' })
  ]);
}

function groupCard(group, detail, isManager) {
  const conv = state.conversations.find((c) => c.id === group.conversationId);
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      avatar(group.name),
      h('div', { class: 'grow' }, [
        h('div', { class: 'card-title', text: group.name }),
        h('div', { class: 'muted', text: `${group.members.length} uye` })
      ]),
      group.isMember ? h('span', { class: 'pill pill-accent', text: 'uyesin' }) : null
    ]),
    group.description ? h('p', { class: 'task-desc', text: group.description }) : null,
    h('div', { class: 'card-actions' }, [
      group.isMember && conv ? h('button', {
        class: 'btn btn-sm', onClick: () => openConversation(conv)
      }, [icon(ICONS.chat, 15), 'Sohbet']) : null,
      isManager ? h('button', {
        class: 'btn btn-sm', onClick: () => groupMembersModal(group, detail), text: 'Uyeler'
      }) : null,
      isManager ? h('button', {
        class: 'btn btn-sm', onClick: () => taskModal(detail, { assigneeGroupId: group.id }), text: 'Gorev ata'
      }) : null,
      isManager ? h('button', {
        class: 'btn btn-sm', onClick: () => groupModal(detail, group), text: 'Duzenle'
      }) : null,
      isManager ? h('button', {
        class: 'btn btn-sm btn-danger',
        onClick: () => confirmModal(`"${group.name}" grubu silinsin mi?`, 'Grup ve sohbeti kalici olarak silinir.',
          async () => {
            await api.del(`/api/groups/${group.id}`);
            state.activeConv.delete(navKey());
            await refreshAll();
            await loadCompany(detail.company.id);
            render();
            toast('Grup silindi.');
          }),
        text: 'Sil'
      }) : null
    ])
  ]);
}

function membersSection(detail, isManager) {
  const { company, members } = detail;
  return h('section', { class: 'sheet-section' }, [
    h('header', {}, [
      h('h4', { text: 'Uyeler' }),
      isManager ? h('button', { class: 'btn btn-sm', onClick: () => memberModal(detail) }, [icon(ICONS.plus, 15), 'Uye ekle']) : null
    ]),
    h('div', { class: 'list' }, members.map((m) => h('div', { class: 'list-item' }, [
      avatar(m.nick),
      h('div', { class: 'grow' }, [
        h('div', { class: 'row-title' }, [
          h('span', { class: `dot${state.online.has(m.id) ? ' is-online' : ''}` }),
          h('strong', { text: m.nick })
        ]),
        h('div', { class: 'row-sub', text: m.displayName })
      ]),
      h('span', { class: `pill${m.role === 'owner' ? ' pill-accent' : ''}`, text: roleLabel(m.role) }),
      m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm', text: 'Mesaj', onClick: () => guard(() => startDm(m.id))
      }) : null,
      company.role === 'owner' && m.role !== 'owner' ? h('select', {
        class: 'status-select',
        onChange: (e) => guard(async () => {
          await api.patch(`/api/companies/${company.id}/members/${m.id}`, { role: e.target.value });
          await loadCompany(company.id);
          render();
        })
      }, [
        h('option', { value: 'member', text: 'Uye', selected: m.role === 'member' }),
        h('option', { value: 'admin', text: 'Yonetici', selected: m.role === 'admin' })
      ]) : null,
      isManager && m.role !== 'owner' && m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm btn-danger', text: 'Cikar',
        onClick: () => confirmModal(`${m.nick} sirketten cikarilsin mi?`, 'Tum gruplardan da cikarilir.', async () => {
          await api.del(`/api/companies/${company.id}/members/${m.id}`);
          await refreshAll();
          await loadCompany(company.id);
          render();
          toast('Uye cikarildi.');
        })
      }) : null
    ])))
  ]);
}

function tasksSection(detail, isManager) {
  const { tasks } = detail;
  const filters = [['all', 'Tumu'], ['todo', 'Yapilacak'], ['doing', 'Devam'], ['done', 'Biten']];
  if (!state._companyTaskFilter) state._companyTaskFilter = 'all';
  const shown = tasks.filter((t) => state._companyTaskFilter === 'all' || t.status === state._companyTaskFilter);

  return h('section', { class: 'sheet-section' }, [
    h('header', {}, [
      h('h4', { text: 'Gorevler' }),
      h('div', { class: 'card-actions' }, [
        ...filters.map(([key, label]) => h('button', {
          class: `btn btn-sm${state._companyTaskFilter === key ? ' btn-primary' : ''}`,
          text: label,
          onClick: () => { state._companyTaskFilter = key; renderMain(); }
        })),
        isManager ? h('button', { class: 'btn btn-sm', onClick: () => taskModal(detail) }, [icon(ICONS.plus, 15), 'Gorev']) : null
      ])
    ]),
    shown.length
      ? h('div', { class: 'cards' }, shown.map((t) => taskCard(t, detail)))
      : h('p', { class: 'muted', text: 'Bu filtrede gorev yok.' })
  ]);
}

const STATUS_LABEL = { todo: 'Yapilacak', doing: 'Devam', done: 'Bitti' };
const PRIORITY = { low: ['pill', 'Dusuk'], normal: ['pill', 'Normal'], high: ['pill pill-danger', 'Yuksek'] };

function taskCard(task, detail) {
  const isManager = detail && ['owner', 'admin'].includes(detail.company.role);
  const company = state.companies.find((c) => c.id === task.companyId);

  const setStatus = (status) => guard(async () => {
    await api.patch(`/api/tasks/${task.id}`, { status });
    state.myTasks = (await api.get('/api/tasks/mine')).tasks;
    if (state.companyDetail && state.companyDetail.company.id === task.companyId) {
      await loadCompany(task.companyId);
    }
    render();
  });

  return h('div', { class: `card task${task.status === 'done' ? ' is-done' : ''}` }, [
    h('div', { class: 'task-title' }, [
      h('button', {
        class: `task-check${task.status === 'done' ? ' is-done' : ''}`,
        title: task.status === 'done' ? 'Geri al' : 'Bitti isaretle',
        'aria-label': 'Durumu degistir',
        onClick: () => setStatus(task.status === 'done' ? 'todo' : 'done')
      }, [icon(ICONS.check, 12)]),
      h('div', { class: 'grow' }, [
        h('div', { class: 'card-title', text: task.title }),
        h('div', { class: 'task-meta' }, [
          task.assigneeGroupName
            ? h('span', { class: 'pill pill-accent', text: `grup: ${task.assigneeGroupName}` })
            : task.assigneeNick
              ? h('span', { class: 'pill', text: `@${task.assigneeNick}` })
              : h('span', { class: 'pill', text: 'atanmadi' }),
          h('span', { class: PRIORITY[task.priority][0], text: PRIORITY[task.priority][1] }),
          task.dueDate ? h('span', { text: `son: ${task.dueDate}` }) : null,
          !detail && company ? h('span', { text: company.name }) : null
        ])
      ])
    ]),
    task.description ? h('p', { class: 'task-desc', text: task.description }) : null,
    h('div', { class: 'card-row' }, [
      h('select', {
        class: 'status-select',
        onChange: (e) => setStatus(e.target.value)
      }, Object.entries(STATUS_LABEL).map(([value, label]) =>
        h('option', { value, text: label, selected: task.status === value }))),
      h('div', { class: 'card-actions' }, [
        isManager ? h('button', {
          class: 'btn btn-sm', text: 'Duzenle', onClick: () => taskModal(detail, task)
        }) : null,
        isManager ? h('button', {
          class: 'btn btn-sm btn-danger', text: 'Sil',
          onClick: () => confirmModal('Gorev silinsin mi?', task.title, async () => {
            await api.del(`/api/tasks/${task.id}`);
            state.myTasks = (await api.get('/api/tasks/mine')).tasks;
            await loadCompany(task.companyId);
            render();
            toast('Gorev silindi.');
          })
        }) : null
      ])
    ])
  ]);
}

/* ================================================================== */
/* diyaloglar                                                          */
/* ================================================================== */

function confirmModal(title, text, onConfirm) {
  openModal(title, (close) => form(() => guard(async () => { await onConfirm(); close(); }), [
    h('p', { class: 'muted', text }),
    actions(close, 'Onayla', null)
  ]));
}

function companyModal() {
  openModal('Sirket olustur', (close) => {
    const input = h('input', { name: 'name', placeholder: 'Sirket adi', required: true, maxlength: 60 });
    return form(() => guard(async () => {
      const res = await api.post('/api/companies', { name: input.value });
      close();
      await refreshAll();
      await selectCompany(res.company.id);
      toast('Sirket olusturuldu. Artik uye ve grup ekleyebilirsin.');
    }), [
      h('label', { class: 'field' }, [h('span', { text: 'Sirket adi' }), input]),
      h('p', { class: 'muted', text: 'Sahibi sen olursun; uye ekleyebilir, grup acabilir ve gorev atayabilirsin.' }),
      actions(close, 'Olustur', null)
    ]);
  });
}

function memberModal(detail) {
  openModal('Uye ekle', (close) => {
    const nick = h('input', { placeholder: 'nick', required: true, maxlength: 24 });
    const role = h('select', {}, [
      h('option', { value: 'member', text: 'Uye' }),
      h('option', { value: 'admin', text: 'Yonetici' })
    ]);
    return form(() => guard(async () => {
      await api.post(`/api/companies/${detail.company.id}/members`, { nick: nick.value.trim(), role: role.value });
      close();
      await loadCompany(detail.company.id);
      render();
      toast('Uye eklendi.');
    }), [
      h('label', { class: 'field' }, [h('span', { text: 'Kullanici nicki' }), nick]),
      h('label', { class: 'field' }, [h('span', { text: 'Rol' }), role]),
      h('p', { class: 'muted', text: 'Yoneticiler grup acabilir, uye ekleyebilir ve gorev atayabilir.' }),
      actions(close, 'Ekle', null)
    ]);
  });
}

function groupModal(detail, group) {
  const editing = Boolean(group);
  openModal(editing ? 'Grubu duzenle' : 'Grup olustur', (close) => {
    const name = h('input', { value: group ? group.name : '', placeholder: 'orn. Tasarim', required: true, maxlength: 60 });
    const desc = h('input', { value: group ? group.description : '', placeholder: 'kisa aciklama', maxlength: 200 });
    const picks = new Set(group ? group.members.map((m) => m.id) : [state.user.id]);

    const list = editing ? null : h('div', { class: 'check-list' }, detail.members.map((m) => h('label', { class: 'check-row' }, [
      h('input', {
        type: 'checkbox', checked: picks.has(m.id), disabled: m.id === state.user.id,
        onChange: (e) => e.target.checked ? picks.add(m.id) : picks.delete(m.id)
      }),
      avatar(m.nick, { size: 'avatar-sm' }),
      h('div', { class: 'grow' }, [h('strong', { text: m.nick }), h('div', { class: 'row-sub', text: roleLabel(m.role) })])
    ])));

    return form(() => guard(async () => {
      if (editing) {
        await api.patch(`/api/groups/${group.id}`, { name: name.value, description: desc.value });
      } else {
        await api.post(`/api/companies/${detail.company.id}/groups`, {
          name: name.value, description: desc.value, memberIds: [...picks]
        });
      }
      close();
      await refreshAll();
      await loadCompany(detail.company.id);
      render();
      toast(editing ? 'Grup guncellendi.' : 'Grup olusturuldu.');
    }), [
      h('label', { class: 'field' }, [h('span', { text: 'Grup adi' }), name]),
      h('label', { class: 'field' }, [h('span', { text: 'Aciklama' }), desc]),
      list ? h('div', { class: 'field' }, [h('span', { text: 'Uyeler' }), list]) : null,
      actions(close, editing ? 'Kaydet' : 'Olustur', null)
    ]);
  });
}

function groupMembersModal(group, detail) {
  openModal(`${group.name} uyeleri`, (close) => {
    const outside = detail.members.filter((m) => !group.members.some((g) => g.id === m.id));
    const select = h('select', {}, [
      h('option', { value: '', text: outside.length ? 'Uye sec' : 'Eklenecek uye yok' }),
      ...outside.map((m) => h('option', { value: m.id, text: `${m.nick} — ${roleLabel(m.role)}` }))
    ]);

    const refresh = async () => {
      await refreshAll();
      await loadCompany(detail.company.id);
      const fresh = state.companyDetail.groups.find((g) => g.id === group.id);
      render();
      close();
      if (fresh) groupMembersModal(fresh, state.companyDetail);
    };

    return [
      h('div', { class: 'list' }, group.members.map((m) => h('div', { class: 'list-item' }, [
        avatar(m.nick, { size: 'avatar-sm' }),
        h('div', { class: 'grow' }, [h('strong', { text: m.nick }), h('div', { class: 'row-sub', text: m.displayName })]),
        h('button', {
          class: 'btn btn-sm btn-danger', text: 'Cikar',
          onClick: () => guard(async () => {
            await api.del(`/api/groups/${group.id}/members/${m.id}`);
            await refresh();
            toast('Uye gruptan cikarildi.');
          })
        })
      ]))),
      h('div', { class: 'field' }, [
        h('span', { text: 'Uye ekle' }),
        h('div', { class: 'card-actions' }, [
          select,
          h('button', {
            class: 'btn btn-sm btn-primary', text: 'Ekle',
            onClick: () => guard(async () => {
              if (!select.value) return;
              await api.post(`/api/groups/${group.id}/members`, { userId: select.value });
              await refresh();
              toast('Uye gruba eklendi.');
            })
          })
        ])
      ]),
      h('div', { class: 'modal-actions' }, [
        h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })
      ])
    ];
  });
}

function taskModal(detail, task) {
  const editing = Boolean(task && task.id);
  openModal(editing ? 'Gorevi duzenle' : 'Gorev olustur', (close) => {
    const title = h('input', { value: task && task.title ? task.title : '', placeholder: 'Ne yapilacak?', required: true, maxlength: 120 });
    const desc = h('textarea', { placeholder: 'Detay (istege bagli)', maxlength: 2000 });
    desc.value = task && task.description ? task.description : '';

    const current = task
      ? (task.assigneeGroupId ? `g:${task.assigneeGroupId}` : task.assigneeUserId ? `u:${task.assigneeUserId}` : '')
      : '';
    const assignee = h('select', {}, [
      h('option', { value: '', text: 'Atanmadi', selected: !current }),
      ...detail.groups.map((g) => h('option', { value: `g:${g.id}`, text: `Grup — ${g.name}`, selected: current === `g:${g.id}` })),
      ...detail.members.map((m) => h('option', { value: `u:${m.id}`, text: `Kisi — ${m.nick}`, selected: current === `u:${m.id}` }))
    ]);
    const priority = h('select', {}, ['low', 'normal', 'high'].map((p) => h('option', {
      value: p, text: PRIORITY[p][1], selected: (task ? task.priority : 'normal') === p
    })));
    const status = h('select', {}, Object.entries(STATUS_LABEL).map(([value, label]) => h('option', {
      value, text: label, selected: (task ? task.status : 'todo') === value
    })));
    const due = h('input', { type: 'date', value: task && task.dueDate ? task.dueDate : '' });

    return form(() => guard(async () => {
      const [kind, id] = assignee.value ? assignee.value.split(':') : ['', ''];
      const payload = {
        title: title.value,
        description: desc.value,
        priority: priority.value,
        status: status.value,
        dueDate: due.value || null,
        assigneeUserId: kind === 'u' ? id : null,
        assigneeGroupId: kind === 'g' ? id : null
      };
      if (editing) await api.patch(`/api/tasks/${task.id}`, payload);
      else await api.post(`/api/companies/${detail.company.id}/tasks`, payload);
      close();
      state.myTasks = (await api.get('/api/tasks/mine')).tasks;
      await loadCompany(detail.company.id);
      state.companyTab = 'tasks';
      render();
      toast(editing ? 'Gorev guncellendi.' : 'Gorev olusturuldu.');
    }), [
      h('label', { class: 'field' }, [h('span', { text: 'Baslik' }), title]),
      h('label', { class: 'field' }, [h('span', { text: 'Aciklama' }), desc]),
      h('label', { class: 'field' }, [h('span', { text: 'Atanan' }), assignee]),
      h('label', { class: 'field' }, [h('span', { text: 'Oncelik' }), priority]),
      h('label', { class: 'field' }, [h('span', { text: 'Durum' }), status]),
      h('label', { class: 'field' }, [h('span', { text: 'Son tarih' }), due]),
      actions(close, editing ? 'Kaydet' : 'Olustur', null)
    ]);
  });
}

function companySettingsModal(detail) {
  openModal('Sirket ayarlari', (close) => {
    const name = h('input', { value: detail.company.name, required: true, maxlength: 60 });
    return form(() => guard(async () => {
      await api.patch(`/api/companies/${detail.company.id}`, { name: name.value });
      close();
      await refreshAll();
      await loadCompany(detail.company.id);
      render();
      toast('Sirket guncellendi.');
    }), [
      h('label', { class: 'field' }, [h('span', { text: 'Sirket adi' }), name]),
      actions(close, 'Kaydet', null, h('button', {
        class: 'btn btn-danger', type: 'button', text: 'Sirketi sil',
        onClick: () => {
          close();
          confirmModal('Sirket silinsin mi?', 'Gruplar, sohbetler ve gorevler kalici olarak silinir.', async () => {
            await api.del(`/api/companies/${detail.company.id}`);
            state.nav = 'dm';
            state.companyDetail = null;
            await refreshAll();
            render();
            toast('Sirket silindi.');
          });
        }
      }))
    ]);
  });
}

function dmModal() {
  openModal('Yeni sohbet', (close) => {
    const results = h('div', { class: 'check-list' });
    const input = h('input', {
      placeholder: 'nick ara', autocomplete: 'off',
      onInput: (e) => search(e.target.value)
    });

    let timer;
    function search(q) {
      clearTimeout(timer);
      timer = setTimeout(() => guard(async () => {
        clear(results);
        if (q.trim().length < 2) {
          results.append(h('p', { class: 'muted', text: 'En az 2 karakter yaz.' }));
          return;
        }
        const res = await api.get(`/api/users?q=${encodeURIComponent(q.trim())}`);
        if (!res.users.length) {
          results.append(h('p', { class: 'muted', text: 'Kullanici bulunamadi.' }));
          return;
        }
        for (const user of res.users) {
          results.append(h('button', {
            class: 'check-row', type: 'button',
            onClick: () => guard(async () => { close(); await startDm(user.id); })
          }, [
            avatar(user.nick, { size: 'avatar-sm' }),
            h('div', { class: 'grow text-left' }, [
              h('strong', { text: user.nick }),
              h('div', { class: 'row-sub', text: user.displayName })
            ]),
            h('span', { class: `dot${state.online.has(user.id) ? ' is-online' : ''}` })
          ]));
        }
      }), 220);
    }

    search('');
    return [
      h('label', { class: 'field' }, [h('span', { text: 'Kullanici' }), input]),
      results,
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
    ];
  });
}

async function profileModal() {
  const fp = await E2E.fingerprint(state.user.publicKey);
  openModal('Profil', (close) => {
    const displayName = h('input', { value: state.user.displayName, maxlength: 40 });
    return form(() => guard(async () => {
      const res = await api.patch('/api/me', { displayName: displayName.value });
      state.user = res.user;
      close();
      render();
      toast('Profil guncellendi.');
    }), [
      h('div', { class: 'card-head' }, [
        avatar(state.user.nick, { size: 'avatar-lg', accent: true }),
        h('div', { class: 'grow' }, [
          h('div', { class: 'card-title', text: `@${state.user.nick}` }),
          h('div', { class: 'muted', text: 'Nick degistirilemez.' })
        ])
      ]),
      h('label', { class: 'field' }, [h('span', { text: 'Gorunen ad' }), displayName]),
      h('div', { class: 'field' }, [
        h('span', { text: 'Anahtar parmak izin' }),
        h('div', { class: 'fp', text: fp }),
        h('small', { class: 'muted', text: 'Karsi tarafla ayni goruyorsaniz sohbet dogrulanmis demektir.' })
      ]),
      actions(close, 'Kaydet', null, h('button', {
        class: 'btn btn-danger', type: 'button', text: 'Cikis yap',
        onClick: () => { close(); signOut(); }
      }))
    ]);
  });
}

function securityModal(peer) {
  openModal('Guvenlik', (close) => {
    const box = h('div', { class: 'field' }, [h('p', { class: 'muted', text: 'Yukleniyor...' })]);
    Promise.all([E2E.fingerprint(state.user.publicKey), E2E.fingerprint(peer.publicKey)]).then(([mine, theirs]) => {
      clear(box).append(
        h('div', { class: 'field' }, [h('span', { text: 'Senin parmak izin' }), h('div', { class: 'fp', text: mine })]),
        h('div', { class: 'field' }, [h('span', { text: `@${peer.nick} parmak izi` }), h('div', { class: 'fp', text: theirs })])
      );
    });
    return [
      h('p', { class: 'muted', text: 'Bu sohbetteki mesajlar cihazlarda sifrelenir; anahtarlar sunucuda tutulmaz. Parmak izlerini baska bir kanaldan karsilastirarak dogrulayabilirsin.' }),
      box,
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
    ];
  });
}

function membersModal(conv) {
  openModal(`${conv.title} uyeleri`, (close) => [
    h('div', { class: 'list' }, conv.members.map((m) => h('div', { class: 'list-item' }, [
      avatar(m.nick, { size: 'avatar-sm' }),
      h('div', { class: 'grow' }, [
        h('div', { class: 'row-title' }, [
          h('span', { class: `dot${state.online.has(m.id) ? ' is-online' : ''}` }),
          h('strong', { text: m.nick })
        ]),
        h('div', { class: 'row-sub', text: m.displayName })
      ]),
      m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm', text: 'Mesaj',
        onClick: () => guard(async () => { close(); await startDm(m.id); })
      }) : h('span', { class: 'pill', text: 'sen' })
    ]))),
    h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
  ]);
}

/* ================================================================== */
/* baglama                                                             */
/* ================================================================== */

function render() {
  renderRail();
  renderSide();
  renderMain();
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], [data-nav]');
  if (!target) return;
  if (target.dataset.nav) {
    state.nav = target.dataset.nav;
    state.filter = '';
    $('#side-filter').value = '';
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

window.addEventListener('online', connect);

boot();

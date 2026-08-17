/** Uygulama durumu ve sunucu islemleri. Cizim katmani buraya abone olur. */

import { api } from './net.js';
import * as E2E from './crypto.js';
import { base64ToBytes, bytesToBase64, bytesToObjectUrl } from './media.js';

export const state = {
  user: null,
  companies: [],
  conversations: [],
  friends: { friends: [], incoming: [], outgoing: [] },
  myTasks: [],
  myMeetings: [],
  companyDetail: null,

  messages: new Map(),   // convId -> [mesaj]
  seen: new Map(),       // convId -> Set(id)
  drafts: new Map(),
  typing: new Map(),     // convId -> { nick, at }
  images: new Map(),     // messageId -> objectUrl

  nav: 'dm',             // 'dm' | 'friends' | 'tasks' | 'meetings' | sirket id
  activeConv: new Map(),
  companyTab: 'groups',
  taskFilter: 'open',
  filter: '',
  stickToBottom: true,
  pendingInvite: null,
  pendingProfile: null
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify() { for (const fn of listeners) fn(); }

export const navKey = () => String(state.nav);

export function activeConversation() {
  const id = state.activeConv.get(navKey());
  return id ? state.conversations.find((c) => c.id === id) || null : null;
}

export function conversationById(id) {
  return state.conversations.find((c) => c.id === id) || null;
}

export function companyById(id) {
  return state.companies.find((c) => c.id === id) || null;
}

export function unreadFor(filterFn) {
  return state.conversations.filter(filterFn).reduce((n, c) => n + (c.unread || 0), 0);
}

/* ---------------- yukleme ---------------- */

export async function refreshAll() {
  const [companies, conversations, tasks, friends, meetings] = await Promise.all([
    api.get('/api/companies'),
    api.get('/api/conversations'),
    api.get('/api/tasks/mine'),
    api.get('/api/friends'),
    api.get('/api/meetings/mine')
  ]);
  state.companies = companies.companies;
  state.conversations = conversations.conversations;
  state.myTasks = tasks.tasks;
  state.friends = friends;
  state.myMeetings = meetings.meetings;
}

export async function refreshTasks() {
  state.myTasks = (await api.get('/api/tasks/mine')).tasks;
}

export async function refreshMeetings() {
  state.myMeetings = (await api.get('/api/meetings/mine')).meetings;
}

export async function refreshFriends() {
  state.friends = await api.get('/api/friends');
}

export async function refreshConversations() {
  const res = await api.get('/api/conversations');
  state.conversations = res.conversations;
}

export async function loadCompany(companyId) {
  state.companyDetail = await api.get(`/api/companies/${companyId}`);
  return state.companyDetail;
}

/* ---------------- mesajlar ---------------- */

function senderKeyFor(conv, senderId) {
  const member = conv.members.find((m) => m.id === senderId);
  return member ? member.publicKey : null;
}

export async function decryptOne(conv, message) {
  const view = {
    id: message.id,
    senderId: message.senderId,
    senderNick: message.senderNick,
    senderAvatar: message.senderAvatar || null,
    system: message.system || null,
    attachment: message.attachment || null,
    expiresAt: message.expiresAt || 0,
    createdAt: message.createdAt,
    text: null,
    raw: message
  };
  if (message.system) return view;

  const publicKey = senderKeyFor(conv, message.senderId);
  if (!publicKey || !message.key) return view;
  try {
    view.text = await E2E.decryptMessage(message, publicKey);
  } catch {
    view.text = null;
  }
  return view;
}

/** Sifreli foto ekini indirip cozer, tarayici icin gecici bir adres uretir. */
export async function loadAttachment(conv, message) {
  if (state.images.has(message.id)) return state.images.get(message.id);
  const attachment = message.attachment;
  const publicKey = senderKeyFor(conv, message.senderId);
  if (!attachment || !publicKey) return null;

  const res = await api.get(`/api/conversations/${conv.id}/blobs/${attachment.blobId}`);
  const bytes = await E2E.decryptFile(message.raw, publicKey, res.data, attachment.iv);
  const url = bytesToObjectUrl(bytes, attachment.mime);
  state.images.set(message.id, url);
  return url;
}

export async function loadMessages(conv) {
  const res = await api.get(`/api/conversations/${conv.id}/messages?limit=60`);
  const list = [];
  for (const message of res.messages) list.push(await decryptOne(conv, message));
  state.messages.set(conv.id, list);
  state.seen.set(conv.id, new Set(res.messages.map((m) => m.id)));
  conv.ttlSeconds = res.ttlSeconds || 0;
}

export async function openConversation(conv) {
  state.activeConv.set(navKey(), conv.id);
  state.stickToBottom = true;
  document.getElementById('app').classList.remove('show-list');
  notify();
  if (!state.messages.has(conv.id)) await loadMessages(conv);
  conv.unread = 0;
  await api.post(`/api/conversations/${conv.id}/read`);
  await refreshConversations();
  notify();
}

export async function sendMessage(conv, text, image = null) {
  const payload = await E2E.encryptMessage(text, conv.members, image ? image.bytes : null);
  const body = { iv: payload.iv, ciphertext: payload.ciphertext, keys: payload.keys };

  if (image) {
    const upload = await api.post(`/api/conversations/${conv.id}/blobs`, { data: payload.file.data });
    body.attachment = {
      blobId: upload.blobId, iv: payload.file.iv, mime: image.mime,
      name: image.name, size: image.size, width: image.width, height: image.height
    };
  }

  const res = await api.post(`/api/conversations/${conv.id}/messages`, body);
  const seen = state.seen.get(conv.id);
  if (seen && !seen.has(res.id)) {
    seen.add(res.id);
    const view = {
      id: res.id, senderId: state.user.id, senderNick: state.user.nick,
      senderAvatar: state.user.avatar, system: null, text,
      attachment: body.attachment || null, expiresAt: res.expiresAt || 0,
      createdAt: res.createdAt,
      raw: { id: res.id, iv: body.iv, ciphertext: body.ciphertext, key: payload.keys.find((k) => k.userId === state.user.id) }
    };
    if (image) state.images.set(res.id, bytesToObjectUrl(image.bytes, image.mime));
    state.messages.get(conv.id).push(view);
  }
  conv.lastMessageAt = res.createdAt;
  state.stickToBottom = true;
  notify();
}

export async function setTtl(conv, seconds) {
  const res = await api.post(`/api/conversations/${conv.id}/ttl`, { seconds });
  conv.ttlSeconds = res.ttlSeconds;
  notify();
}

export function sendTypingPing(conv) {
  api.post(`/api/conversations/${conv.id}/typing`).catch(() => {});
}

export function reportScreenshot(conv) {
  return api.post(`/api/conversations/${conv.id}/notice`, { kind: 'screenshot' });
}

/* ---------------- kisiler ---------------- */

export async function startDm(userId) {
  const res = await api.post('/api/conversations/dm', { userId });
  const conv = res.conversation;
  const existing = conversationById(conv.id);
  if (existing) Object.assign(existing, conv);
  else state.conversations.push(conv);
  state.nav = 'dm';
  await openConversation(conversationById(conv.id));
}

export async function lookupUser(userId) {
  for (const conv of state.conversations) {
    const member = conv.members.find((m) => m.id === userId);
    if (member) return member;
  }
  for (const row of [...state.friends.friends, ...state.friends.incoming, ...state.friends.outgoing]) {
    if (row.user.id === userId) return row.user;
  }
  if (state.companyDetail) {
    const member = state.companyDetail.members.find((m) => m.id === userId);
    if (member) return member;
  }
  return null;
}

/* ---------------- gorevler ---------------- */

export async function updateTask(task, patch) {
  await api.patch(`/api/tasks/${task.id}`, patch);
  await refreshTasks();
  if (state.companyDetail && state.companyDetail.company.id === task.companyId) {
    await loadCompany(task.companyId);
  }
  notify();
}

export { bytesToBase64, base64ToBytes };

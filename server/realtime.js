'use strict';

const { WebSocketServer } = require('ws');
const db = require('./db');
const { userForToken } = require('./auth');
const { now } = require('./util');

/** userId -> Set<WebSocket> */
const sockets = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function toUsers(userIds, payload) {
  for (const userId of new Set(userIds)) {
    const set = sockets.get(userId);
    if (!set) continue;
    for (const ws of set) send(ws, payload);
  }
}

function conversationMembers(conversationId) {
  return db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
    .all(conversationId).map((r) => r.user_id);
}

function companyMembers(companyId) {
  return db.prepare('SELECT user_id FROM company_members WHERE company_id = ?')
    .all(companyId).map((r) => r.user_id);
}

function toConversation(conversationId, payload) {
  toUsers(conversationMembers(conversationId), payload);
}

function toCompany(companyId, payload) {
  toUsers(companyMembers(companyId), payload);
}

function onlineUsers() {
  return [...sockets.keys()];
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const user = userForToken(url.searchParams.get('token'));
    if (!user) {
      send(ws, { type: 'error', error: 'Oturum gecersiz.' });
      ws.close();
      return;
    }

    ws.userId = user.id;
    ws.isAlive = true;
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    sockets.get(user.id).add(ws);

    send(ws, { type: 'ready', userId: user.id, online: onlineUsers() });
    broadcastPresence(user.id, true);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'typing' && typeof msg.conversationId === 'string') {
        const members = conversationMembers(msg.conversationId);
        if (!members.includes(user.id)) return;
        toUsers(members.filter((m) => m !== user.id), {
          type: 'typing',
          conversationId: msg.conversationId,
          userId: user.id
        });
      }
    });

    ws.on('close', () => {
      const set = sockets.get(user.id);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(user.id);
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
        broadcastPresence(user.id, false);
      }
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

/** Kullanicinin cevrimici durumunu paylastigi kisilere bildir. */
function broadcastPresence(userId, online) {
  const peers = db.prepare(`
    SELECT DISTINCT cm2.user_id AS user_id
      FROM conversation_members cm1
      JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
     WHERE cm1.user_id = ? AND cm2.user_id != ?
    UNION
    SELECT DISTINCT c2.user_id AS user_id
      FROM company_members c1
      JOIN company_members c2 ON c2.company_id = c1.company_id
     WHERE c1.user_id = ? AND c2.user_id != ?
  `).all(userId, userId, userId, userId).map((r) => r.user_id);
  toUsers(peers, { type: 'presence', userId, online });
}

module.exports = { attach, toUsers, toConversation, toCompany, onlineUsers };

'use strict';

const express = require('express');
const db = require('./db');
const rt = require('./realtime');
const { publicUser } = require('./auth');
const { id, now, cleanText, isB64, HttpError, bad } = require('./util');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* yardimcilar                                                         */
/* ------------------------------------------------------------------ */

const forbidden = (m) => new HttpError(403, m);
const notFound = (m) => new HttpError(404, m);

function membership(companyId, userId) {
  return db.prepare('SELECT role FROM company_members WHERE company_id = ? AND user_id = ?')
    .get(companyId, userId);
}

function requireCompany(companyId, userId, roles) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) throw notFound('Sirket bulunamadi.');
  const member = membership(companyId, userId);
  if (!member) throw forbidden('Bu sirkete uye degilsin.');
  if (roles && !roles.includes(member.role)) throw forbidden('Bu islem icin yetkin yok.');
  return { company, role: member.role };
}

function requireGroup(groupId, userId, roles) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw notFound('Grup bulunamadi.');
  const { role } = requireCompany(group.company_id, userId, roles);
  return { group, role };
}

function companyMemberRows(companyId) {
  return db.prepare(`
    SELECT u.*, cm.role, cm.joined_at
      FROM company_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.company_id = ?
     ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.nick
  `).all(companyId).map((r) => ({ ...publicUser(r), role: r.role, joinedAt: r.joined_at }));
}

function groupRows(companyId, userId) {
  const groups = db.prepare('SELECT * FROM groups WHERE company_id = ? ORDER BY name').all(companyId);
  return groups.map((g) => {
    const members = db.prepare(`
      SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? ORDER BY u.nick
    `).all(g.id).map(publicUser);
    const conv = db.prepare('SELECT id FROM conversations WHERE group_id = ?').get(g.id);
    return {
      id: g.id,
      companyId: g.company_id,
      name: g.name,
      description: g.description,
      conversationId: conv ? conv.id : null,
      members,
      isMember: members.some((m) => m.id === userId)
    };
  });
}

function taskRow(t) {
  return {
    id: t.id,
    companyId: t.company_id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    dueDate: t.due_date,
    assigneeUserId: t.assignee_user_id,
    assigneeGroupId: t.assignee_group_id,
    assigneeNick: t.assignee_nick || null,
    assigneeGroupName: t.assignee_group_name || null,
    createdBy: t.created_by,
    createdByNick: t.created_by_nick || null,
    createdAt: t.created_at,
    updatedAt: t.updated_at
  };
}

const TASK_SELECT = `
  SELECT t.*, au.nick AS assignee_nick, ag.name AS assignee_group_name, cu.nick AS created_by_nick
    FROM tasks t
    LEFT JOIN users  au ON au.id = t.assignee_user_id
    LEFT JOIN groups ag ON ag.id = t.assignee_group_id
    LEFT JOIN users  cu ON cu.id = t.created_by
`;

function ensureGroupConversation(groupId) {
  let conv = db.prepare('SELECT * FROM conversations WHERE group_id = ?').get(groupId);
  if (!conv) {
    const convId = id();
    db.prepare('INSERT INTO conversations (id, kind, group_id, created_at) VALUES (?, ?, ?, ?)')
      .run(convId, 'group', groupId, now());
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  }
  return conv;
}

function syncGroupConversation(groupId) {
  const conv = ensureGroupConversation(groupId);
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id NOT IN (SELECT user_id FROM group_members WHERE group_id = ?)')
    .run(conv.id, groupId);
  const insert = db.prepare(`
    INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
    VALUES (?, ?, 0) ON CONFLICT DO NOTHING
  `);
  for (const row of db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId)) {
    insert.run(conv.id, row.user_id);
  }
  return conv;
}

function conversationPayload(convId, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv) return null;
  const members = db.prepare(`
    SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? ORDER BY u.nick
  `).all(convId).map(publicUser);
  const me = db.prepare('SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(convId, userId);
  const last = db.prepare('SELECT created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(convId);
  const unread = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
     WHERE conversation_id = ? AND sender_id != ? AND created_at > ?
  `).get(convId, userId, me ? me.last_read_at : 0).n;

  const group = conv.group_id ? db.prepare('SELECT g.*, c.name AS company_name FROM groups g JOIN companies c ON c.id = g.company_id WHERE g.id = ?').get(conv.group_id) : null;

  return {
    id: conv.id,
    kind: conv.kind,
    groupId: conv.group_id,
    companyId: group ? group.company_id : null,
    title: group ? group.name : (members.find((m) => m.id !== userId) || {}).nick || 'Sohbet',
    subtitle: group ? group.company_name : null,
    members,
    lastMessageAt: last ? last.created_at : 0,
    unread
  };
}

/* ------------------------------------------------------------------ */
/* kullanicilar                                                        */
/* ------------------------------------------------------------------ */

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.patch('/me', (req, res, next) => {
  try {
    const displayName = cleanText(req.body.displayName, 40);
    if (!displayName) throw bad('Gorunen ad bos olamaz.');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  } catch (err) { next(err); }
});

router.get('/users', (req, res) => {
  const q = cleanText(req.query.q, 32).toLowerCase();
  if (!q) return res.json({ users: [] });
  const rows = db.prepare(`
    SELECT * FROM users WHERE nick_lower LIKE ? AND id != ? ORDER BY nick LIMIT 20
  `).all(`%${q}%`, req.user.id);
  res.json({ users: rows.map(publicUser) });
});

/* ------------------------------------------------------------------ */
/* sirketler                                                           */
/* ------------------------------------------------------------------ */

router.get('/companies', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, cm.role FROM company_members cm JOIN companies c ON c.id = cm.company_id
     WHERE cm.user_id = ? ORDER BY c.name
  `).all(req.user.id);
  res.json({
    companies: rows.map((c) => ({
      id: c.id,
      name: c.name,
      ownerId: c.owner_id,
      role: c.role,
      memberCount: db.prepare('SELECT COUNT(*) AS n FROM company_members WHERE company_id = ?').get(c.id).n
    }))
  });
});

router.post('/companies', (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Sirket adi en az 2 karakter olmali.');
    const companyId = id();
    db.transaction(() => {
      db.prepare('INSERT INTO companies (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
        .run(companyId, name, req.user.id, now());
      db.prepare('INSERT INTO company_members (company_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(companyId, req.user.id, 'owner', now());
    })();
    res.json({ company: { id: companyId, name, ownerId: req.user.id, role: 'owner', memberCount: 1 } });
  } catch (err) { next(err); }
});

router.get('/companies/:id', (req, res, next) => {
  try {
    const { company, role } = requireCompany(req.params.id, req.user.id);
    res.json({
      company: { id: company.id, name: company.name, ownerId: company.owner_id, role },
      members: companyMemberRows(company.id),
      groups: groupRows(company.id, req.user.id),
      tasks: db.prepare(`${TASK_SELECT} WHERE t.company_id = ? ORDER BY t.created_at DESC`)
        .all(company.id).map(taskRow)
    });
  } catch (err) { next(err); }
});

router.patch('/companies/:id', (req, res, next) => {
  try {
    requireCompany(req.params.id, req.user.id, ['owner']);
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Sirket adi en az 2 karakter olmali.');
    db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, req.params.id);
    rt.toCompany(req.params.id, { type: 'company:update', companyId: req.params.id });
    res.json({ ok: true, name });
  } catch (err) { next(err); }
});

router.delete('/companies/:id', (req, res, next) => {
  try {
    requireCompany(req.params.id, req.user.id, ['owner']);
    const members = companyMemberRows(req.params.id).map((m) => m.id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
    rt.toUsers(members, { type: 'company:delete', companyId: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/companies/:id/members', (req, res, next) => {
  try {
    requireCompany(req.params.id, req.user.id, ['owner', 'admin']);
    const nick = cleanText(req.body.nick, 24).toLowerCase();
    const role = ['admin', 'member'].includes(req.body.role) ? req.body.role : 'member';
    const target = db.prepare('SELECT * FROM users WHERE nick_lower = ?').get(nick);
    if (!target) throw bad('Kullanici bulunamadi.');
    if (membership(req.params.id, target.id)) throw bad('Bu kullanici zaten uye.');
    db.prepare('INSERT INTO company_members (company_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(req.params.id, target.id, role, now());
    rt.toCompany(req.params.id, { type: 'company:update', companyId: req.params.id });
    rt.toUsers([target.id], { type: 'company:joined', companyId: req.params.id });
    res.json({ member: { ...publicUser(target), role } });
  } catch (err) { next(err); }
});

router.patch('/companies/:id/members/:userId', (req, res, next) => {
  try {
    const { company } = requireCompany(req.params.id, req.user.id, ['owner']);
    const role = req.body.role;
    if (!['admin', 'member'].includes(role)) throw bad('Gecersiz rol.');
    if (req.params.userId === company.owner_id) throw bad('Sirket sahibinin rolu degistirilemez.');
    db.prepare('UPDATE company_members SET role = ? WHERE company_id = ? AND user_id = ?')
      .run(role, req.params.id, req.params.userId);
    rt.toCompany(req.params.id, { type: 'company:update', companyId: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/companies/:id/members/:userId', (req, res, next) => {
  try {
    const { company, role } = requireCompany(req.params.id, req.user.id);
    const isSelf = req.params.userId === req.user.id;
    if (!isSelf && !['owner', 'admin'].includes(role)) throw forbidden('Bu islem icin yetkin yok.');
    if (req.params.userId === company.owner_id) throw bad('Sirket sahibi cikarilamaz.');

    db.transaction(() => {
      const groups = db.prepare('SELECT id FROM groups WHERE company_id = ?').all(company.id);
      for (const g of groups) {
        db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, req.params.userId);
        syncGroupConversation(g.id);
      }
      db.prepare('DELETE FROM company_members WHERE company_id = ? AND user_id = ?')
        .run(company.id, req.params.userId);
    })();

    rt.toCompany(company.id, { type: 'company:update', companyId: company.id });
    rt.toUsers([req.params.userId], { type: 'company:delete', companyId: company.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* gruplar                                                             */
/* ------------------------------------------------------------------ */

router.post('/companies/:id/groups', (req, res, next) => {
  try {
    requireCompany(req.params.id, req.user.id, ['owner', 'admin']);
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Grup adi en az 2 karakter olmali.');
    const description = cleanText(req.body.description, 200);
    const requested = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];

    const groupId = id();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO groups (id, company_id, name, description, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(groupId, req.params.id, name, description, req.user.id, now());

      const ids = new Set([req.user.id, ...requested]);
      for (const uid of ids) {
        if (!membership(req.params.id, uid)) continue;
        db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(groupId, uid, now());
      }
      syncGroupConversation(groupId);
    })();

    rt.toCompany(req.params.id, { type: 'company:update', companyId: req.params.id });
    res.json({ group: groupRows(req.params.id, req.user.id).find((g) => g.id === groupId) });
  } catch (err) { next(err); }
});

router.patch('/groups/:id', (req, res, next) => {
  try {
    const { group } = requireGroup(req.params.id, req.user.id, ['owner', 'admin']);
    const name = cleanText(req.body.name, 60) || group.name;
    const description = cleanText(req.body.description, 200);
    db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?')
      .run(name, description, group.id);
    rt.toCompany(group.company_id, { type: 'company:update', companyId: group.company_id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/groups/:id', (req, res, next) => {
  try {
    const { group } = requireGroup(req.params.id, req.user.id, ['owner', 'admin']);
    db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
    rt.toCompany(group.company_id, { type: 'company:update', companyId: group.company_id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/groups/:id/members', (req, res, next) => {
  try {
    const { group } = requireGroup(req.params.id, req.user.id, ['owner', 'admin']);
    const userId = String(req.body.userId || '');
    if (!membership(group.company_id, userId)) throw bad('Kullanici bu sirkete uye degil.');
    db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(group.id, userId, now());
    syncGroupConversation(group.id);
    rt.toCompany(group.company_id, { type: 'company:update', companyId: group.company_id });
    rt.toUsers([userId], { type: 'conversations:refresh' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/groups/:id/members/:userId', (req, res, next) => {
  try {
    const { group, role } = requireGroup(req.params.id, req.user.id);
    const isSelf = req.params.userId === req.user.id;
    if (!isSelf && !['owner', 'admin'].includes(role)) throw forbidden('Bu islem icin yetkin yok.');
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(group.id, req.params.userId);
    syncGroupConversation(group.id);
    rt.toCompany(group.company_id, { type: 'company:update', companyId: group.company_id });
    rt.toUsers([req.params.userId], { type: 'conversations:refresh' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* sohbetler ve mesajlar                                               */
/* ------------------------------------------------------------------ */

router.get('/conversations', (req, res) => {
  const rows = db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?')
    .all(req.user.id);
  const list = rows
    .map((r) => conversationPayload(r.conversation_id, req.user.id))
    .filter(Boolean)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  res.json({ conversations: list });
});

router.post('/conversations/dm', (req, res, next) => {
  try {
    const otherId = String(req.body.userId || '');
    if (otherId === req.user.id) throw bad('Kendinle sohbet baslatamazsin.');
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    if (!other) throw bad('Kullanici bulunamadi.');

    const dmKey = [req.user.id, otherId].sort().join(':');
    let conv = db.prepare('SELECT * FROM conversations WHERE dm_key = ?').get(dmKey);
    if (!conv) {
      const convId = id();
      db.transaction(() => {
        db.prepare('INSERT INTO conversations (id, kind, dm_key, created_at) VALUES (?, ?, ?, ?)')
          .run(convId, 'dm', dmKey, now());
        for (const uid of [req.user.id, otherId]) {
          db.prepare('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, 0)')
            .run(convId, uid);
        }
      })();
      conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
      rt.toUsers([otherId], { type: 'conversations:refresh' });
    }
    res.json({ conversation: conversationPayload(conv.id, req.user.id) });
  } catch (err) { next(err); }
});

function requireConversation(convId, userId) {
  const member = db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(convId, userId);
  if (!member) throw forbidden('Bu sohbete erisimin yok.');
}

router.get('/conversations/:id/messages', (req, res, next) => {
  try {
    requireConversation(req.params.id, req.user.id);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare(`
      SELECT m.*, u.nick AS sender_nick, mk.iv AS key_iv, mk.wrapped AS key_wrapped
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        LEFT JOIN message_keys mk ON mk.message_id = m.id AND mk.user_id = ?
       WHERE m.conversation_id = ? AND m.created_at < ?
       ORDER BY m.created_at DESC LIMIT ?
    `).all(req.user.id, req.params.id, before, limit);

    res.json({
      messages: rows.reverse().map((m) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        senderNick: m.sender_nick,
        iv: m.iv,
        ciphertext: m.ciphertext,
        key: m.key_wrapped ? { iv: m.key_iv, wrapped: m.key_wrapped } : null,
        createdAt: m.created_at
      })),
      hasMore: rows.length === limit
    });
  } catch (err) { next(err); }
});

router.post('/conversations/:id/messages', (req, res, next) => {
  try {
    requireConversation(req.params.id, req.user.id);
    const { iv, ciphertext, keys } = req.body;
    if (!isB64(iv, 200) || !isB64(ciphertext, 200000)) throw bad('Sifreli govde gecersiz.');
    if (!Array.isArray(keys) || keys.length === 0) throw bad('Anahtar zarflari eksik.');

    const members = new Set(db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
      .all(req.params.id).map((r) => r.user_id));

    const messageId = id();
    const createdAt = now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, iv, ciphertext, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(messageId, req.params.id, req.user.id, iv, ciphertext, createdAt);

      const insert = db.prepare(`
        INSERT INTO message_keys (message_id, user_id, iv, wrapped) VALUES (?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `);
      for (const k of keys) {
        if (!members.has(k.userId)) continue;
        if (!isB64(k.iv, 200) || !isB64(k.wrapped, 4000)) throw bad('Anahtar zarfi gecersiz.');
        insert.run(messageId, k.userId, k.iv, k.wrapped);
      }
      db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?')
        .run(createdAt, req.params.id, req.user.id);
    })();

    // Her aliciya yalnizca kendi zarfi gonderilir.
    for (const userId of members) {
      const k = db.prepare('SELECT iv, wrapped FROM message_keys WHERE message_id = ? AND user_id = ?')
        .get(messageId, userId);
      rt.toUsers([userId], {
        type: 'message:new',
        message: {
          id: messageId,
          conversationId: req.params.id,
          senderId: req.user.id,
          senderNick: req.user.nick,
          iv,
          ciphertext,
          key: k ? { iv: k.iv, wrapped: k.wrapped } : null,
          createdAt
        }
      });
    }

    res.json({ id: messageId, createdAt });
  } catch (err) { next(err); }
});

router.post('/conversations/:id/read', (req, res, next) => {
  try {
    requireConversation(req.params.id, req.user.id);
    db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?')
      .run(now(), req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* gorevler                                                            */
/* ------------------------------------------------------------------ */

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];

router.get('/tasks/mine', (req, res) => {
  const rows = db.prepare(`
    ${TASK_SELECT}
     WHERE t.assignee_user_id = ?
        OR t.assignee_group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
     ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, t.updated_at DESC
  `).all(req.user.id, req.user.id);
  res.json({ tasks: rows.map(taskRow) });
});

router.post('/companies/:id/tasks', (req, res, next) => {
  try {
    requireCompany(req.params.id, req.user.id, ['owner', 'admin']);
    const title = cleanText(req.body.title, 120);
    if (title.length < 2) throw bad('Gorev basligi en az 2 karakter olmali.');

    const description = String(req.body.description || '').trim().slice(0, 2000);
    const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal';
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate || '') ? req.body.dueDate : null;

    let assigneeUserId = req.body.assigneeUserId || null;
    let assigneeGroupId = req.body.assigneeGroupId || null;
    if (assigneeUserId && assigneeGroupId) throw bad('Gorev ya kisiye ya gruba atanir.');
    if (assigneeUserId && !membership(req.params.id, assigneeUserId)) throw bad('Atanan kisi bu sirkette degil.');
    if (assigneeGroupId) {
      const g = db.prepare('SELECT company_id FROM groups WHERE id = ?').get(assigneeGroupId);
      if (!g || g.company_id !== req.params.id) throw bad('Grup bu sirkete ait degil.');
    }

    const taskId = id();
    db.prepare(`
      INSERT INTO tasks (id, company_id, title, description, status, priority, due_date,
                         assignee_user_id, assignee_group_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, req.params.id, title, description, status, priority, dueDate,
      assigneeUserId, assigneeGroupId, req.user.id, now(), now());

    const task = taskRow(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId));
    rt.toCompany(req.params.id, { type: 'task:new', task });
    res.json({ task });
  } catch (err) { next(err); }
});

router.patch('/tasks/:id', (req, res, next) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Gorev bulunamadi.');
    const { role } = requireCompany(task.company_id, req.user.id);

    const isAssignee = task.assignee_user_id === req.user.id ||
      (task.assignee_group_id && db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(task.assignee_group_id, req.user.id));
    const isManager = ['owner', 'admin'].includes(role);
    if (!isManager && !isAssignee) throw forbidden('Bu gorevi degistiremezsin.');

    const fields = {};
    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) throw bad('Gecersiz durum.');
      fields.status = req.body.status;
    }
    // Baslik, atama ve oncelik yalnizca yoneticiler tarafindan degistirilir.
    if (isManager) {
      if (req.body.title !== undefined) {
        const title = cleanText(req.body.title, 120);
        if (title.length < 2) throw bad('Gorev basligi en az 2 karakter olmali.');
        fields.title = title;
      }
      if (req.body.description !== undefined) fields.description = String(req.body.description).trim().slice(0, 2000);
      if (req.body.priority !== undefined) {
        if (!PRIORITIES.includes(req.body.priority)) throw bad('Gecersiz oncelik.');
        fields.priority = req.body.priority;
      }
      if (req.body.dueDate !== undefined) {
        fields.due_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate || '') ? req.body.dueDate : null;
      }
      if (req.body.assigneeUserId !== undefined) {
        const uid = req.body.assigneeUserId || null;
        if (uid && !membership(task.company_id, uid)) throw bad('Atanan kisi bu sirkette degil.');
        fields.assignee_user_id = uid;
        if (uid) fields.assignee_group_id = null;
      }
      if (req.body.assigneeGroupId !== undefined) {
        const gid = req.body.assigneeGroupId || null;
        if (gid) {
          const g = db.prepare('SELECT company_id FROM groups WHERE id = ?').get(gid);
          if (!g || g.company_id !== task.company_id) throw bad('Grup bu sirkete ait degil.');
        }
        fields.assignee_group_id = gid;
        if (gid) fields.assignee_user_id = null;
      }
    }

    const keys = Object.keys(fields);
    if (keys.length) {
      db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), now(), task.id);
    }

    const updated = taskRow(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(task.id));
    rt.toCompany(task.company_id, { type: 'task:update', task: updated });
    res.json({ task: updated });
  } catch (err) { next(err); }
});

router.delete('/tasks/:id', (req, res, next) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) throw notFound('Gorev bulunamadi.');
    requireCompany(task.company_id, req.user.id, ['owner', 'admin']);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    rt.toCompany(task.company_id, { type: 'task:delete', taskId: task.id, companyId: task.company_id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

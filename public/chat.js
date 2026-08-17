/** Sohbet ekrani: baloncuklar, foto ekleri, gorulduc bilgisi, gecici mesajlar. */

import { h, icon, ICONS, avatarNode, timeShort, dayLabel, durationLabel } from './dom.js';
import { toast, guard, openModal, form, field, actions, copyText, emptyState, iconBtn } from './ui.js';
import { t } from './i18n.js';
import * as store from './store.js';
import { state } from './store.js';
import * as call from './call.js';
import { pickFile, toChatImage, toAttachment, humanSize } from './media.js';

const TTL_OPTIONS = [
  [0, 'ttl_off'], [30, 'ttl_30s'], [300, 'ttl_5m'],
  [3600, 'ttl_1h'], [86400, 'ttl_1d'], [604800, 'ttl_7d']
];

let typingSentAt = 0;

/**
 * Sohbet yeniden cizildiginde (gelen mesaj, "yaziyor" bildirimi, okundu bilgisi)
 * yazma alanindaki odak ve imlec konumu korunur; yoksa kullanici yazarken
 * yazdigi kesilir.
 */
const composerFocus = { convId: null, start: 0, end: 0 };

/** Yeniden cizimden hemen once cagrilir: odak yazma alanindaysa kaydet. */
export function captureComposer() {
  const active = document.activeElement;
  if (!active || active.tagName !== 'TEXTAREA' || !active.dataset.conv) return;
  composerFocus.convId = active.dataset.conv;
  composerFocus.start = active.selectionStart;
  composerFocus.end = active.selectionEnd;
}

function rememberCaret(conv, textarea) {
  composerFocus.convId = conv.id;
  composerFocus.start = textarea.selectionStart;
  composerFocus.end = textarea.selectionEnd;
}

/**
 * Sohbet paneli sohbet basina bir kez kurulur; sonraki cizimlerde yalnizca
 * baslik ve mesaj listesi yenilenir. Boylece yazma alani (metin, imlec, odak,
 * secili dosya) gelen olaylardan etkilenmez.
 */
function buildHead(conv) {
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m.id !== state.user.id) : null;
  const online = peer ? Boolean(conv.online && conv.online[peer.id]) : false;
  return h('header', { class: 'pane-head' }, [
    iconBtn(ICONS.back, t('list'), () => document.getElementById('app').classList.add('show-list'), 'only-narrow'),
    avatarNode(conv.title, peer ? peer.avatar : null, {
      accent: conv.kind === 'group',
      online: peer ? online : null
    }),
    h('div', { class: 'grow' }, [
      h('h3', { text: conv.title }),
      h('p', { class: 'muted', text: conv.kind === 'group'
        ? `${conv.subtitle ? conv.subtitle + ' · ' : ''}${t('members_n', { n: conv.members.length })}`
        : t(online ? 'online' : 'offline') })
    ]),
    conv.ttlSeconds ? h('span', {
      class: 'pill pill-warn', title: t('ephemeral'),
      text: t('ephemeral_badge', { duration: durationLabel(conv.ttlSeconds) })
    }) : null,
    iconBtn(ICONS.phone, t('call_voice'), () => beginCall(conv, 'audio')),
    iconBtn(ICONS.video, t('call_video'), () => beginCall(conv, 'video')),
    iconBtn(ICONS.timer, t('ephemeral'), () => ttlModal(conv)),
    conv.kind === 'group'
      ? iconBtn(ICONS.link, t('share_chat'), () => shareModal(conv))
      : iconBtn(ICONS.lock, t('security'), () => securityModal(conv, peer)),
    iconBtn(ICONS.users, t('members'), () => membersModal(conv))
  ]);
}

const pane = { convId: null, node: null, listEl: null, headEl: null, renderList: null };

export function chatPane(conv) {
  if (pane.convId === conv.id && pane.node) {
    pane.headEl.replaceWith(buildHead(conv));
    pane.headEl = pane.node.firstElementChild;
    pane.renderList(conv);
    return pane.node;
  }
  return buildPane(conv);
}

function buildPane(conv) {
  let pendingImage = null;

  const head = buildHead(conv);

  /* ---- mesaj listesi ---- */
  const listEl = h('div', { class: 'msgs' });

  function renderList(current) {
    const messages = state.messages.get(current.id) || [];
    const rows = [];
    let lastDay = '';
    let prev = null;

    for (const message of messages) {
      const day = dayLabel(message.createdAt);
      if (day !== lastDay) {
        rows.push(h('div', { class: 'day-sep', text: day }));
        lastDay = day;
        prev = null;
      }
      if (message.system) {
        rows.push(systemLine(message));
        prev = null;
        continue;
      }
      const tail = prev && prev.senderId === message.senderId && message.createdAt - prev.createdAt < 300000;
      rows.push(bubble(current, message, tail, messages));
      prev = message;
    }

    if (!messages.length) rows.push(emptyState(t('first_message'), t('first_message_sub')));
    listEl.replaceChildren(...rows);
    if (state.stickToBottom) requestAnimationFrame(() => { listEl.scrollTop = listEl.scrollHeight; });
    renderTyping();
  }

  renderList(conv);

  listEl.addEventListener('scroll', () => {
    state.stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 90;
  });

  /* ---- yazma alani ---- */
  const preview = h('div', { class: 'composer-preview is-hidden' });

  const textarea = h('textarea', {
    placeholder: t('message_placeholder', { name: conv.title }),
    rows: 1,
    value: state.drafts.get(conv.id) || '',
    onInput: (e) => {
      state.drafts.set(conv.id, e.target.value);
      rememberCaret(conv, e.target);
      autoGrow(e.target);
      refreshSendState();
      if (Date.now() - typingSentAt > 2200) {
        typingSentAt = Date.now();
        store.sendTypingPing(conv);
      }
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    },
    dataset: { conv: conv.id },
    onFocus: (e) => rememberCaret(conv, e.target),
    onClick: (e) => rememberCaret(conv, e.target),
    onKeyup: (e) => rememberCaret(conv, e.target),
    onPaste: (e) => {
      const file = [...(e.clipboardData ? e.clipboardData.files : [])][0];
      if (file) { e.preventDefault(); attach(file, file.type.startsWith('image/') ? 'image' : 'file'); }
    }
  });

  const sendBtn = h('button', {
    class: 'send', type: 'button', title: t('send'), 'aria-label': t('send'),
    onClick: () => submit()
  }, [icon(ICONS.send, 19)]);

  const photoBtn = iconBtn(ICONS.image, t('send_photo'), async () => {
    const file = await pickFile('image/*');
    if (file) attach(file, 'image');
  }, 'composer-icon');

  const fileBtn = iconBtn(ICONS.clip, t('send_file'), async () => {
    const file = await pickFile('*/*');
    if (file) attach(file, 'file');
  }, 'composer-icon');

  function refreshSendState() {
    sendBtn.disabled = !textarea.value.trim() && !pendingImage;
  }

  async function attach(file, mode) {
    await guard(async () => {
      const isImage = mode === 'image' && file.type.startsWith('image/');
      const item = isImage ? await toChatImage(file) : await toAttachment(file);
      pendingImage = item;
      preview.classList.remove('is-hidden');
      preview.replaceChildren(
        isImage
          ? h('img', { src: URL.createObjectURL(new Blob([item.bytes], { type: item.mime })), alt: '' })
          : h('span', { class: 'file-icon' }, [icon(ICONS.file, 20)]),
        h('div', { class: 'grow' }, [
          h('strong', { text: isImage ? t('photo_ready') : t('file_ready') }),
          h('div', { class: 'muted', text: isImage
            ? t('photo_meta', { kb: Math.round(item.size / 1024), w: item.width, h: item.height })
            : `${item.name} · ${t('file_meta', { size: humanSize(item.size) })}` })
        ]),
        h('button', {
          class: 'btn btn-sm btn-ghost', type: 'button', text: t('remove'),
          onClick: () => { pendingImage = null; preview.classList.add('is-hidden'); refreshSendState(); }
        })
      );
      refreshSendState();
    });
  }

  function submit() {
    const text = textarea.value.trim();
    if (!text && !pendingImage) return;
    const image = pendingImage;
    textarea.value = '';
    pendingImage = null;
    preview.classList.add('is-hidden');
    state.drafts.delete(conv.id);
    composerFocus.convId = conv.id;
    composerFocus.start = composerFocus.end = 0;
    autoGrow(textarea);
    sendBtn.disabled = true;
    guard(() => store.sendMessage(conv, text, image));
  }

  const node = h('div', { class: 'chat' }, [
    head,
    listEl,
    h('div', { class: 'composer-wrap' }, [
      h('div', { class: 'typing', id: 'typing-line' }),
      preview,
      h('div', { class: 'composer' }, [photoBtn, fileBtn, textarea, sendBtn]),
      h('div', { class: 'e2e-note' }, [
        icon(ICONS.lock, 13),
        h('span', { text: t('e2e_note') })
      ])
    ])
  ]);

  requestAnimationFrame(() => {
    if (state.stickToBottom) listEl.scrollTop = listEl.scrollHeight;
    autoGrow(textarea);
    refreshSendState();
    renderTyping();
    // Sohbet degistiginde yazma alanina odaklan.
    if (composerFocus.convId === conv.id) {
      textarea.focus();
      const at = Math.min(composerFocus.start, textarea.value.length);
      const to = Math.min(composerFocus.end, textarea.value.length);
      try { textarea.setSelectionRange(at, to); } catch { /* desteklemiyorsa gec */ }
    }
  });

  pane.convId = conv.id;
  pane.node = node;
  pane.listEl = listEl;
  pane.headEl = head;
  pane.renderList = renderList;
  return node;
}

/* ------------------------------------------------------------------ */
/* mesaj parcalari                                                     */
/* ------------------------------------------------------------------ */

function bubble(conv, message, tail, all) {
  const mine = message.senderId === state.user.id;
  const wrap = h('div', { class: `msg${mine ? ' is-mine' : ''}${tail ? ' is-tail' : ''}` });

  if (!mine) {
    wrap.append(tail
      ? h('span', { class: 'msg-gap' })
      : avatarNode(message.senderNick, message.senderAvatar, { size: 'avatar-sm' }));
  }

  const body = h('div', { class: 'msg-body' });
  if (!tail && !mine && conv.kind === 'group') {
    body.append(h('div', { class: 'msg-who', text: message.senderNick }));
  }

  const bubbleEl = h('div', { class: 'bubble' });

  if (message.attachment && message.attachment.kind !== 'file') {
    const frame = h('div', { class: 'bubble-image' }, [h('div', { class: 'img-skeleton' })]);
    bubbleEl.append(frame);
    store.loadAttachment(conv, message).then((url) => {
      if (!url) return;
      frame.replaceChildren(h('img', {
        src: url, alt: message.attachment.name || t('photo'), loading: 'lazy',
        onClick: () => openImage(url)
      }));
    }).catch(() => frame.replaceChildren(h('div', { class: 'muted', text: t('photo_failed') })));
  } else if (message.attachment) {
    bubbleEl.append(fileCard(conv, message));
  }

  if (message.text) bubbleEl.append(h('div', { class: 'bubble-text', text: message.text }));
  else if (!message.attachment) {
    bubbleEl.append(h('div', { class: 'bubble-text is-locked', text: t('cannot_decrypt') }));
  }

  const meta = h('div', { class: 'bubble-meta' }, [
    message.expiresAt ? h('span', { class: 'ttl-badge', title: t('ephemeral') }, [icon(ICONS.timer, 11)]) : null,
    h('time', { text: timeShort(message.createdAt) }),
    mine ? receiptNode(conv, message) : null
  ]);
  bubbleEl.append(meta);

  body.append(bubbleEl);
  wrap.append(body);
  return wrap;
}

/** Gorulduc: karsi tarafin okuma zamani mesajdan sonraysa mesaj gorulmus. */
function receiptNode(conv, message) {
  const others = conv.members.filter((m) => m.id !== state.user.id);
  const reads = conv.reads || {};
  const seenBy = others.filter((m) => (reads[m.id] || 0) >= message.createdAt);
  const all = seenBy.length === others.length && others.length > 0;

  const node = h('span', {
    class: `receipt${all ? ' is-seen' : seenBy.length ? ' is-partial' : ''}`,
    title: seenBy.length
      ? t('seen_by', { names: seenBy.map((m) => m.nick).join(', ') })
      : t('delivered')
  }, [icon(ICONS.checks, 14)]);

  if (conv.kind === 'group' && seenBy.length) {
    node.append(h('small', { text: String(seenBy.length) }));
  }
  return node;
}

function systemLine(message) {
  const mine = message.senderId === state.user.id;
  const text = message.system === 'screenshot'
    ? t('screenshot_taken', { name: mine ? t('you') : message.senderNick })
    : '';
  return h('div', { class: 'sys-line' }, [icon(ICONS.camera, 13), h('span', { text })]);
}

/** Sifreli dosya: indirme aninda cozulur, duz hali sunucuda hic bulunmaz. */
function fileCard(conv, message) {
  const { name, size } = message.attachment;
  const button = h('button', {
    class: 'btn btn-xs', type: 'button', text: t('download'),
    onClick: () => guard(async () => {
      button.disabled = true;
      try {
        const bytes = await store.attachmentBytes(conv, message);
        if (!bytes) throw new Error(t('file_failed'));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const link = h('a', { href: url, download: name || 'file' });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } finally {
        button.disabled = false;
      }
    })
  });

  return h('div', { class: 'file-card' }, [
    h('span', { class: 'file-icon' }, [icon(ICONS.file, 18)]),
    h('div', { class: 'grow' }, [
      h('strong', { class: 'file-name', text: name || 'file' }),
      h('div', { class: 'file-size', text: humanSize(size) })
    ]),
    button
  ]);
}

function openImage(url) {
  openModal(t('photo'), (close) => [
    h('div', { class: 'image-view' }, [h('img', { src: url, alt: '' })]),
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', text: t('close'), onClick: close })
    ])
  ], { wide: true });
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 170)}px`;
}

export function renderTyping() {
  const line = document.getElementById('typing-line');
  if (!line) return;
  const conv = store.activeConversation();
  const entry = conv && state.typing.get(conv.id);
  const live = entry && Date.now() - entry.at < 3200;
  line.textContent = live ? t('typing', { name: entry.nick }) : '';
  line.classList.toggle('is-live', Boolean(live));
}

/* ------------------------------------------------------------------ */
/* diyaloglar                                                          */
/* ------------------------------------------------------------------ */

async function beginCall(conv, kind) {
  await guard(async () => {
    call.setMe(state.user);
    await call.startCall({
      target: { conversationId: conv.id },
      kind,
      title: conv.kind === 'group' ? t('group_call', { name: conv.title }) : conv.title,
      multi: conv.kind === 'group'
    });
  });
}

function ttlModal(conv) {
  openModal(t('ephemeral_title'), (close) => {
    const select = h('select', {}, TTL_OPTIONS.map(([value, key]) =>
      h('option', { value: String(value), text: t(key), selected: (conv.ttlSeconds || 0) === value })));
    return form(() => guard(async () => {
      await store.setTtl(conv, Number(select.value));
      close();
      toast(t(Number(select.value) ? 'ephemeral_on' : 'ephemeral_off'));
    }), [
      h('p', { class: 'muted', text: t('ephemeral_note') }),
      field(t('duration'), select),
      actions(close, t('save'))
    ]);
  });
}

function shareModal(conv) {
  const group = state.companyDetail && state.companyDetail.groups.find((g) => g.id === conv.groupId);
  const slug = group ? group.slug : null;
  const link = slug ? `${location.origin}/${slug}` : null;

  openModal(t('share_chat'), (close) => [
    h('p', { class: 'muted', text: t(link ? 'share_chat_note' : 'share_chat_none') }),
    link ? h('div', { class: 'link-box' }, [
      h('code', { text: link }),
      h('button', { class: 'btn btn-sm', text: t('copy'), onClick: () => copyText(link, t('link_copied')) })
    ]) : null,
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', text: t('close'), onClick: close })
    ])
  ]);
}

function securityModal(conv, peer) {
  openModal(t('security'), (close) => {
    const box = h('div', { class: 'stack' }, [h('p', { class: 'muted', text: `${t('loading')}…` })]);
    import('./crypto.js').then(async (E2E) => {
      const mine = await E2E.fingerprint(state.user.publicKey);
      const theirs = peer ? await E2E.fingerprint(peer.publicKey) : null;
      box.replaceChildren(
        field(t('your_fingerprint'), h('div', { class: 'fp', text: mine })),
        theirs ? field(t('their_fingerprint', { nick: peer.nick }), h('div', { class: 'fp', text: theirs })) : null
      );
    });
    return [
      h('p', { class: 'muted', text: t('security_note') }),
      box,
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: t('close'), onClick: close })])
    ];
  });
}

function membersModal(conv) {
  openModal(`${conv.title} · ${t('members')}`, (close) => [
    h('div', { class: 'list' }, conv.members.map((m) => h('div', { class: 'list-item' }, [
      avatarNode(m.nick, m.avatar, { size: 'avatar-sm', online: Boolean(conv.online && conv.online[m.id]) }),
      h('div', { class: 'grow' }, [
        h('strong', { text: m.nick }),
        h('div', { class: 'row-sub', text: m.displayName })
      ]),
      m.id === state.user.id
        ? h('span', { class: 'pill', text: t('you') })
        : h('button', {
          class: 'btn btn-sm', text: t('message'),
          onClick: () => guard(async () => { close(); await store.startDm(m.id); })
        })
    ]))),
    h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: t('close'), onClick: close })])
  ]);
}

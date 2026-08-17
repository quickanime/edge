/** Sohbet ekrani: baloncuklar, foto ekleri, gorulduc bilgisi, gecici mesajlar. */

import { h, icon, ICONS, avatarNode, timeShort, dayLabel, durationLabel } from './dom.js';
import { toast, guard, openModal, form, field, actions, copyText, emptyState, iconBtn } from './ui.js';
import * as store from './store.js';
import { state } from './store.js';
import * as call from './call.js';
import { pickFile, toChatImage } from './media.js';

const TTL_OPTIONS = [
  [0, 'Kapali'], [30, '30 saniye'], [300, '5 dakika'],
  [3600, '1 saat'], [86400, '1 gun'], [604800, '7 gun']
];

let typingSentAt = 0;

export function chatPane(conv) {
  const messages = state.messages.get(conv.id) || [];
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m.id !== state.user.id) : null;
  const online = peer ? Boolean(conv.online && conv.online[peer.id]) : false;
  let pendingImage = null;

  /* ---- baslik ---- */
  const head = h('header', { class: 'pane-head' }, [
    iconBtn(ICONS.back, 'Liste', () => document.getElementById('app').classList.add('show-list'), 'only-narrow'),
    avatarNode(conv.title, peer ? peer.avatar : null, {
      accent: conv.kind === 'group',
      online: peer ? online : null
    }),
    h('div', { class: 'grow' }, [
      h('h3', { text: conv.title }),
      h('p', { class: 'muted', text: conv.kind === 'group'
        ? `${conv.subtitle ? conv.subtitle + ' · ' : ''}${conv.members.length} uye`
        : (online ? 'cevrimici' : 'cevrimdisi') })
    ]),
    conv.ttlSeconds ? h('span', {
      class: 'pill pill-warn', title: 'Gecici mesaj suresi',
      text: `gecici · ${durationLabel(conv.ttlSeconds)}`
    }) : null,
    iconBtn(ICONS.phone, 'Sesli ara', () => beginCall(conv, 'audio')),
    iconBtn(ICONS.video, 'Goruntulu ara', () => beginCall(conv, 'video')),
    iconBtn(ICONS.timer, 'Gecici mesaj', () => ttlModal(conv)),
    conv.kind === 'group'
      ? iconBtn(ICONS.link, 'Sohbeti paylas', () => shareModal(conv))
      : iconBtn(ICONS.lock, 'Guvenlik', () => securityModal(conv, peer)),
    iconBtn(ICONS.users, 'Uyeler', () => membersModal(conv))
  ]);

  /* ---- mesaj listesi ---- */
  const listEl = h('div', { class: 'msgs' });
  let lastDay = '';
  let prev = null;

  for (const message of messages) {
    const day = dayLabel(message.createdAt);
    if (day !== lastDay) {
      listEl.append(h('div', { class: 'day-sep', text: day }));
      lastDay = day;
      prev = null;
    }
    if (message.system) {
      listEl.append(systemLine(message));
      prev = null;
      continue;
    }
    const tail = prev && prev.senderId === message.senderId && message.createdAt - prev.createdAt < 300000;
    listEl.append(bubble(conv, message, tail, messages));
    prev = message;
  }

  if (!messages.length) {
    listEl.append(emptyState('Ilk mesaji sen yaz', 'Bu sohbetteki her sey cihazinda sifrelenir.'));
  }

  listEl.addEventListener('scroll', () => {
    state.stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 90;
  });

  /* ---- yazma alani ---- */
  const preview = h('div', { class: 'composer-preview is-hidden' });

  const textarea = h('textarea', {
    placeholder: `${conv.title} icin mesaj yaz`,
    rows: 1,
    value: state.drafts.get(conv.id) || '',
    onInput: (e) => {
      state.drafts.set(conv.id, e.target.value);
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
    onPaste: (e) => {
      const file = [...(e.clipboardData ? e.clipboardData.files : [])][0];
      if (file && file.type.startsWith('image/')) { e.preventDefault(); attach(file); }
    }
  });

  const sendBtn = h('button', {
    class: 'send', type: 'button', title: 'Gonder', 'aria-label': 'Gonder',
    onClick: () => submit()
  }, [icon(ICONS.send, 19)]);

  const photoBtn = iconBtn(ICONS.image, 'Foto gonder', async () => {
    const file = await pickFile('image/*');
    if (file) attach(file);
  }, 'composer-icon');

  function refreshSendState() {
    sendBtn.disabled = !textarea.value.trim() && !pendingImage;
  }

  async function attach(file) {
    await guard(async () => {
      const image = await toChatImage(file);
      pendingImage = image;
      preview.classList.remove('is-hidden');
      preview.replaceChildren(
        h('img', { src: URL.createObjectURL(new Blob([image.bytes], { type: image.mime })), alt: '' }),
        h('div', { class: 'grow' }, [
          h('strong', { text: 'Foto hazir' }),
          h('div', { class: 'muted', text: `${Math.round(image.size / 1024)} KB · ${image.width}x${image.height} · sifreli gonderilecek` })
        ]),
        h('button', {
          class: 'btn btn-sm btn-ghost', type: 'button', text: 'Kaldir',
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
    autoGrow(textarea);
    sendBtn.disabled = true;
    guard(() => store.sendMessage(conv, text, image));
  }

  const pane = h('div', { class: 'chat' }, [
    head,
    listEl,
    h('div', { class: 'composer-wrap' }, [
      h('div', { class: 'typing', id: 'typing-line' }),
      preview,
      h('div', { class: 'composer' }, [photoBtn, textarea, sendBtn]),
      h('div', { class: 'e2e-note' }, [
        icon(ICONS.lock, 13),
        h('span', { text: 'Mesajlar ve fotolar uctan uca sifreli. Sunucu icerigi okuyamaz.' })
      ])
    ])
  ]);

  requestAnimationFrame(() => {
    if (state.stickToBottom) listEl.scrollTop = listEl.scrollHeight;
    autoGrow(textarea);
    refreshSendState();
    renderTyping();
  });

  return pane;
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

  if (message.attachment) {
    const frame = h('div', { class: 'bubble-image' }, [h('div', { class: 'img-skeleton' })]);
    bubbleEl.append(frame);
    store.loadAttachment(conv, message).then((url) => {
      if (!url) return;
      frame.replaceChildren(h('img', {
        src: url, alt: message.attachment.name || 'foto', loading: 'lazy',
        onClick: () => openImage(url)
      }));
    }).catch(() => frame.replaceChildren(h('div', { class: 'muted', text: 'Foto cozulemedi.' })));
  }

  if (message.text) bubbleEl.append(h('div', { class: 'bubble-text', text: message.text }));
  else if (!message.attachment) {
    bubbleEl.append(h('div', { class: 'bubble-text is-locked', text: 'Bu mesaj bu cihazda cozulemedi.' }));
  }

  const meta = h('div', { class: 'bubble-meta' }, [
    message.expiresAt ? h('span', { class: 'ttl-badge', title: 'Gecici mesaj' }, [icon(ICONS.timer, 11)]) : null,
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
      ? `Goruldu: ${seenBy.map((m) => m.nick).join(', ')}`
      : 'Gonderildi'
  }, [icon(ICONS.checks, 14)]);

  if (conv.kind === 'group' && seenBy.length) {
    node.append(h('small', { text: String(seenBy.length) }));
  }
  return node;
}

function systemLine(message) {
  const mine = message.senderId === state.user.id;
  const text = message.system === 'screenshot'
    ? `${mine ? 'Sen' : message.senderNick} ekran goruntusu aldi`
    : 'Sistem bildirimi';
  return h('div', { class: 'sys-line' }, [icon(ICONS.camera, 13), h('span', { text })]);
}

function openImage(url) {
  openModal('Foto', (close) => [
    h('div', { class: 'image-view' }, [h('img', { src: url, alt: '' })]),
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })
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
  line.textContent = live ? `${entry.nick} yaziyor...` : '';
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
      title: conv.kind === 'group' ? `${conv.title} · grup gorusmesi` : conv.title,
      multi: conv.kind === 'group'
    });
  });
}

function ttlModal(conv) {
  openModal('Gecici mesajlar', (close) => {
    const select = h('select', {}, TTL_OPTIONS.map(([value, label]) =>
      h('option', { value: String(value), text: label, selected: (conv.ttlSeconds || 0) === value })));
    return form(() => guard(async () => {
      await store.setTtl(conv, Number(select.value));
      close();
      toast(Number(select.value) ? 'Gecici mesaj suresi ayarlandi.' : 'Gecici mesaj kapatildi.');
    }), [
      h('p', { class: 'muted', text: 'Yeni mesajlar bu sure sonunda hem sunucudan hem ekrandan silinir. Ayar sohbetin tum uyeleri icin gecerlidir.' }),
      field('Sure', select),
      actions(close, 'Kaydet')
    ]);
  });
}

function shareModal(conv) {
  const group = state.companyDetail && state.companyDetail.groups.find((g) => g.id === conv.groupId);
  const slug = group ? group.slug : null;
  const link = slug ? `${location.origin}/${slug}` : null;

  openModal('Sohbeti paylas', (close) => [
    h('p', { class: 'muted', text: link
      ? 'Bu link ile gelen kisi sirkete ve bu gruba katilir, sohbete dogrudan erisir.'
      : 'Bu sohbet icin paylasim linki bulunamadi. Sirket panelinden davet olusturabilirsin.' }),
    link ? h('div', { class: 'link-box' }, [
      h('code', { text: link }),
      h('button', { class: 'btn btn-sm', text: 'Kopyala', onClick: () => copyText(link, 'Link kopyalandi.') })
    ]) : null,
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })
    ])
  ]);
}

function securityModal(conv, peer) {
  openModal('Guvenlik', (close) => {
    const box = h('div', { class: 'stack' }, [h('p', { class: 'muted', text: 'Yukleniyor...' })]);
    import('./crypto.js').then(async (E2E) => {
      const mine = await E2E.fingerprint(state.user.publicKey);
      const theirs = peer ? await E2E.fingerprint(peer.publicKey) : null;
      box.replaceChildren(
        field('Senin parmak izin', h('div', { class: 'fp', text: mine })),
        theirs ? field(`@${peer.nick} parmak izi`, h('div', { class: 'fp', text: theirs })) : null
      );
    });
    return [
      h('p', { class: 'muted', text: 'Mesajlar, fotolar ve gorusme sinyalleri cihazlarda sifrelenir; anahtarlar sunucuda tutulmaz. Parmak izlerini baska bir kanaldan karsilastirarak dogrulayabilirsin.' }),
      box,
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
    ];
  });
}

function membersModal(conv) {
  openModal(`${conv.title} uyeleri`, (close) => [
    h('div', { class: 'list' }, conv.members.map((m) => h('div', { class: 'list-item' }, [
      avatarNode(m.nick, m.avatar, { size: 'avatar-sm', online: Boolean(conv.online && conv.online[m.id]) }),
      h('div', { class: 'grow' }, [
        h('strong', { text: m.nick }),
        h('div', { class: 'row-sub', text: m.displayName })
      ]),
      m.id === state.user.id
        ? h('span', { class: 'pill', text: 'sen' })
        : h('button', {
          class: 'btn btn-sm', text: 'Mesaj',
          onClick: () => guard(async () => { close(); await store.startDm(m.id); })
        })
    ]))),
    h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
  ]);
}

/** Arkadaslar: nickle istek gonder, gelen istekleri yanitla, dogrudan sohbet ac. */

import { h, icon, ICONS, avatarNode, relTime } from './dom.js';
import { toast, guard, openModal, form, field, actions, emptyState, copyText, sectionHead } from './ui.js';
import * as store from './store.js';
import { state } from './store.js';
import { api } from './net.js';
import * as call from './call.js';

export function friendsPane() {
  const { friends, incoming, outgoing } = state.friends;
  const filter = state.filter.toLowerCase();
  const match = (row) => !filter || row.user.nick.toLowerCase().includes(filter);

  return h('div', { class: 'pane' }, [
    h('header', { class: 'pane-head' }, [
      h('div', { class: 'grow' }, [
        h('h3', { text: 'Arkadaslar' }),
        h('p', { class: 'muted', text: `${friends.length} arkadas · ${incoming.length} bekleyen istek` })
      ]),
      h('button', { class: 'btn btn-sm', onClick: shareProfile }, [icon(ICONS.link, 15), 'Profilimi paylas']),
      h('button', { class: 'btn btn-sm btn-primary', onClick: addFriendModal }, [icon(ICONS.plus, 15), 'Arkadas ekle'])
    ]),
    h('div', { class: 'pane-body' }, [h('div', { class: 'sheet' }, [
      incoming.length ? h('section', { class: 'sheet-section' }, [
        sectionHead(`Gelen istekler (${incoming.length})`),
        h('div', { class: 'list' }, incoming.filter(match).map((row) => h('div', { class: 'list-item' }, [
          avatarNode(row.user.nick, row.user.avatar, { online: row.user.online }),
          h('div', { class: 'grow' }, [
            h('strong', { text: row.user.nick }),
            h('div', { class: 'row-sub', text: `${row.user.displayName} · ${relTime(row.at)} once` })
          ]),
          h('button', {
            class: 'btn btn-sm btn-primary', text: 'Kabul et',
            onClick: () => guard(async () => {
              await api.post(`/api/friends/${row.user.id}/accept`);
              await store.refreshFriends();
              store.notify();
              toast(`${row.user.nick} artik arkadasin.`);
            })
          }),
          h('button', {
            class: 'btn btn-sm btn-danger', text: 'Reddet',
            onClick: () => guard(async () => {
              await api.del(`/api/friends/${row.user.id}`);
              await store.refreshFriends();
              store.notify();
            })
          })
        ])))
      ]) : null,

      h('section', { class: 'sheet-section' }, [
        sectionHead('Arkadaslar'),
        friends.length
          ? h('div', { class: 'cards' }, friends.filter(match).map((row) => friendCard(row)))
          : emptyState('Arkadas listesi bos', 'Nick ile arkadas ekle; kabul edildiginde dogrudan sohbet edebilirsin.')
      ]),

      outgoing.length ? h('section', { class: 'sheet-section' }, [
        sectionHead(`Gonderilen istekler (${outgoing.length})`),
        h('div', { class: 'list' }, outgoing.filter(match).map((row) => h('div', { class: 'list-item' }, [
          avatarNode(row.user.nick, row.user.avatar, { size: 'avatar-sm' }),
          h('div', { class: 'grow' }, [
            h('strong', { text: row.user.nick }),
            h('div', { class: 'row-sub', text: 'yanit bekleniyor' })
          ]),
          h('button', {
            class: 'btn btn-sm btn-ghost', text: 'Geri al',
            onClick: () => guard(async () => {
              await api.del(`/api/friends/${row.user.id}`);
              await store.refreshFriends();
              store.notify();
            })
          })
        ])))
      ]) : null
    ])])
  ]);
}

function friendCard(row) {
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      avatarNode(row.user.nick, row.user.avatar, { size: 'avatar-lg', online: row.user.online }),
      h('div', { class: 'grow' }, [
        h('div', { class: 'card-title', text: row.user.nick }),
        h('div', { class: 'muted', text: row.user.online ? 'cevrimici' : `son gorulme ${relTime(row.user.lastSeenAt) || 'bilinmiyor'}` })
      ])
    ]),
    h('div', { class: 'card-actions' }, [
      h('button', {
        class: 'btn btn-sm btn-primary', onClick: () => guard(() => store.startDm(row.user.id))
      }, [icon(ICONS.chat, 15), 'Mesaj']),
      h('button', {
        class: 'btn btn-sm', onClick: () => startFriendCall(row.user, 'audio')
      }, [icon(ICONS.phone, 15), 'Ara']),
      h('button', {
        class: 'btn btn-sm', onClick: () => startFriendCall(row.user, 'video')
      }, [icon(ICONS.video, 15), 'Goruntulu']),
      h('button', {
        class: 'btn btn-sm btn-danger', text: 'Cikar',
        onClick: () => guard(async () => {
          await api.del(`/api/friends/${row.user.id}`);
          await store.refreshFriends();
          store.notify();
          toast('Arkadas listesinden cikarildi.');
        })
      })
    ])
  ]);
}

async function startFriendCall(user, kind) {
  await guard(async () => {
    const res = await api.post('/api/conversations/dm', { userId: user.id });
    await store.refreshConversations();
    call.setMe(state.user);
    await call.startCall({ target: { conversationId: res.conversation.id }, kind, title: user.nick });
  });
}

export function addFriendModal(prefill = '') {
  openModal('Arkadas ekle', (close) => {
    const nick = h('input', { placeholder: 'nick', required: true, maxlength: 24, value: prefill });
    return form(() => guard(async () => {
      const res = await api.post('/api/friends', { nick: nick.value.trim() });
      close();
      await store.refreshFriends();
      store.notify();
      toast(res.state === 'accepted' ? 'Arkadas oldunuz.' : 'Istek gonderildi.');
    }), [
      field('Kullanici nicki', nick, 'Kabul edildiginde birbirinizle dogrudan mesajlasabilirsiniz.'),
      actions(close, 'Istek gonder')
    ]);
  });
}

function shareProfile() {
  const link = `${location.origin}/u/${state.user.nick}`;
  copyText(link, 'Profil linkin kopyalandi.');
}

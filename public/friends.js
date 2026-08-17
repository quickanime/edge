/** Arkadaslar: nickle istek gonder, gelen istekleri yanitla, dogrudan sohbet ac. */

import { h, icon, ICONS, avatarNode, relTime } from './dom.js';
import { toast, guard, openModal, form, field, actions, emptyState, copyText, sectionHead } from './ui.js';
import { t } from './i18n.js';
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
        h('h3', { text: t('friends_title') }),
        h('p', { class: 'muted', text: t('friends_sub', { friends: friends.length, pending: incoming.length }) })
      ]),
      h('button', { class: 'btn btn-sm', onClick: shareProfile }, [icon(ICONS.link, 15), t('share_profile')]),
      h('button', { class: 'btn btn-sm btn-primary', onClick: () => addFriendModal() }, [icon(ICONS.plus, 15), t('add_friend')])
    ]),
    h('div', { class: 'pane-body' }, [h('div', { class: 'sheet' }, [
      incoming.length ? h('section', { class: 'sheet-section' }, [
        sectionHead(t('incoming_requests', { n: incoming.length })),
        h('div', { class: 'list' }, incoming.filter(match).map((row) => h('div', { class: 'list-item' }, [
          avatarNode(row.user.nick, row.user.avatar, { online: row.user.online }),
          h('div', { class: 'grow' }, [
            h('strong', { text: row.user.nick }),
            h('div', { class: 'row-sub', text: `${row.user.displayName} · ${relTime(row.at)}` })
          ]),
          h('button', {
            class: 'btn btn-sm btn-primary', text: t('accept'),
            onClick: () => guard(async () => {
              await api.post(`/api/friends/${row.user.id}/accept`);
              await store.refreshFriends();
              store.notify();
              toast(t('now_friends', { nick: row.user.nick }));
            })
          }),
          h('button', {
            class: 'btn btn-sm btn-danger', text: t('decline'),
            onClick: () => guard(async () => {
              await api.del(`/api/friends/${row.user.id}`);
              await store.refreshFriends();
              store.notify();
            })
          })
        ])))
      ]) : null,

      h('section', { class: 'sheet-section' }, [
        sectionHead(t('friends_title')),
        friends.length
          ? h('div', { class: 'cards' }, friends.filter(match).map((row) => friendCard(row)))
          : emptyState(t('friends_empty'), t('friends_empty_sub'))
      ]),

      outgoing.length ? h('section', { class: 'sheet-section' }, [
        sectionHead(t('outgoing_requests', { n: outgoing.length })),
        h('div', { class: 'list' }, outgoing.filter(match).map((row) => h('div', { class: 'list-item' }, [
          avatarNode(row.user.nick, row.user.avatar, { size: 'avatar-sm' }),
          h('div', { class: 'grow' }, [
            h('strong', { text: row.user.nick }),
            h('div', { class: 'row-sub', text: t('awaiting_reply') })
          ]),
          h('button', {
            class: 'btn btn-sm btn-ghost', text: t('cancel_request'),
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
        h('div', { class: 'muted', text: row.user.online ? t('online') : t('last_seen', { when: relTime(row.user.lastSeenAt) || t('unknown') }) })
      ])
    ]),
    h('div', { class: 'card-actions' }, [
      h('button', {
        class: 'btn btn-sm btn-primary', onClick: () => guard(() => store.startDm(row.user.id))
      }, [icon(ICONS.chat, 15), t('message')]),
      h('button', {
        class: 'btn btn-sm', onClick: () => startFriendCall(row.user, 'audio')
      }, [icon(ICONS.phone, 15), t('call')]),
      h('button', {
        class: 'btn btn-sm', onClick: () => startFriendCall(row.user, 'video')
      }, [icon(ICONS.video, 15), t('video')]),
      h('button', {
        class: 'btn btn-sm btn-danger', text: t('remove_friend'),
        onClick: () => guard(async () => {
          await api.del(`/api/friends/${row.user.id}`);
          await store.refreshFriends();
          store.notify();
          toast(t('friend_removed'));
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
  openModal(t('add_friend'), (close) => {
    const nick = h('input', { placeholder: t('nick').toLowerCase(), required: true, maxlength: 24, value: prefill });
    return form(() => guard(async () => {
      const res = await api.post('/api/friends', { nick: nick.value.trim() });
      close();
      await store.refreshFriends();
      store.notify();
      toast(res.state === 'accepted' ? t('you_are_friends') : t('request_sent'));
    }), [
      field(t('member_nick'), nick, t('add_friend_hint')),
      actions(close, t('send_request'))
    ]);
  });
}

function shareProfile() {
  const link = `${location.origin}/u/${state.user.nick}`;
  copyText(link, t('profile_link_copied'));
}

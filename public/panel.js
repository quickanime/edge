/** Sirket yonetim paneli: gruplar, uyeler ve yetkiler, gorevler, toplantilar, davetler, son aktiviteler. */

import { h, icon, ICONS, avatarNode, relTime, dateTimeLabel, toLocalInput } from './dom.js';
import {
  toast, guard, openModal, form, field, actions, confirmModal, copyText, emptyState, iconBtn, sectionHead
} from './ui.js';
import { t } from './i18n.js';
import * as store from './store.js';
import { state } from './store.js';
import { api } from './net.js';
import { taskBoard } from './tasks.js';
import * as call from './call.js';
import { pickFile, toAvatarDataUrl } from './media.js';

const PERM_KEYS = ['members', 'groups', 'tasks', 'meetings', 'invites'];
const roleLabel = (role) => t(`role_${role}`);

const ACTION_KEYS = {
  'company:create': 'act_company_create',
  'company:rename': 'act_company_rename',
  'company:logo': 'act_company_logo',
  'member:add': 'act_member_add',
  'member:join': 'act_member_join',
  'member:remove': 'act_member_remove',
  'member:leave': 'act_member_leave',
  'member:access': 'act_member_access',
  'group:create': 'act_group_create',
  'group:update': 'act_group_update',
  'group:delete': 'act_group_delete',
  'group:member:add': 'act_group_member_add',
  'group:member:remove': 'act_group_member_remove',
  'invite:create': 'act_invite_create',
  'invite:delete': 'act_invite_delete',
  'task:create': 'act_task_create',
  'task:update': 'act_task_update',
  'task:delete': 'act_task_delete',
  'meeting:create': 'act_meeting_create',
  'meeting:cancel': 'act_meeting_cancel',
  'call:start': 'act_call_start'
};

const allowed = (detail, perm) =>
  detail.company.role === 'owner' || Boolean(detail.company.perms && detail.company.perms[perm]);

export function companyPane(detail) {
  const { company, members, groups, tasks, meetings } = detail;
  const isOwner = company.role === 'owner';
  const upcoming = meetings.filter((m) => m.status !== 'cancelled').length;

  const tabs = [
    ['groups', `${t('tab_groups')} ${groups.length}`],
    ['members', `${t('tab_members')} ${members.length}`],
    ['tasks', `${t('tab_tasks')} ${tasks.filter((task) => task.status !== 'done').length}`],
    ['meetings', `${t('tab_meetings')} ${upcoming}`],
    ['invites', `${t('tab_invites')} ${(detail.invites || []).length}`],
    ['activity', t('tab_activity')]
  ];

  const body = h('div', { class: 'pane-body' }, [h('div', { class: 'sheet' }, [
    h('div', { class: 'tabs-line' }, tabs.map(([key, label]) => h('button', {
      class: state.companyTab === key ? 'is-active' : '',
      text: label,
      onClick: () => { state.companyTab = key; store.notify(); }
    }))),
    sectionFor(detail)
  ])]);

  return h('div', { class: 'pane' }, [
    h('header', { class: 'pane-head' }, [
      iconBtn(ICONS.back, t('list'), () => document.getElementById('app').classList.add('show-list'), 'only-narrow'),
      h('button', {
        class: 'logo-btn', title: isOwner || allowed(detail, 'members') ? t('change_logo') : company.name,
        onClick: () => (isOwner || allowed(detail, 'members')) ? changeLogo(detail) : null
      }, [avatarNode(company.name, company.logo, { size: 'avatar-lg', accent: true })]),
      h('div', { class: 'grow' }, [
        h('h3', { text: company.name }),
        h('p', { class: 'muted', text: `${roleLabel(company.role)} · ${t('members_n', { n: members.length })} · /${company.slug}` })
      ]),
      isOwner ? iconBtn(ICONS.sliders, t('company_settings'), () => companySettings(detail)) : null
    ]),
    body
  ]);
}

function sectionFor(detail) {
  switch (state.companyTab) {
    case 'members': return membersSection(detail);
    case 'tasks': return taskBoard(detail.tasks, detail);
    case 'meetings': return meetingsSection(detail);
    case 'invites': return invitesSection(detail);
    case 'activity': return activitySection(detail);
    default: return groupsSection(detail);
  }
}

/* ------------------------------------------------------------------ */
/* gruplar                                                             */
/* ------------------------------------------------------------------ */

function groupsSection(detail) {
  const canManage = allowed(detail, 'groups');
  return h('section', { class: 'sheet-section' }, [
    sectionHead(t('groups'), canManage ? h('button', {
      class: 'btn btn-sm btn-primary', onClick: () => groupModal(detail)
    }, [icon(ICONS.plus, 15), t('create_group')]) : null),
    detail.groups.length
      ? h('div', { class: 'cards' }, detail.groups.map((group) => groupCard(group, detail, canManage)))
      : emptyState(t('groups_empty'), t('groups_empty_sub'))
  ]);
}

function groupCard(group, detail, canManage) {
  const conv = store.conversationById(group.convId);
  const link = `${location.origin}/${group.slug}`;
  return h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      avatarNode(group.name, null, {}),
      h('div', { class: 'grow' }, [
        h('div', { class: 'card-title', text: group.name }),
        h('div', { class: 'muted', text: t('members_n', { n: group.memberIds.length }) })
      ]),
      group.isMember ? h('span', { class: 'pill pill-accent', text: t('member_of') }) : null
    ]),
    group.description ? h('p', { class: 'card-desc', text: group.description }) : null,
    h('div', { class: 'link-row' }, [
      h('code', { text: `/${group.slug}` }),
      iconBtn(ICONS.copy, t('copy'), () => copyText(link, t('link_copied')))
    ]),
    h('div', { class: 'card-actions' }, [
      group.isMember && conv ? h('button', {
        class: 'btn btn-sm', onClick: () => store.openConversation(conv)
      }, [icon(ICONS.chat, 15), t('chat')]) : null,
      group.isMember && conv ? h('button', {
        class: 'btn btn-sm', onClick: () => guard(async () => {
          call.setMe(state.user);
          await call.startCall({
            target: { conversationId: conv.id }, kind: 'audio',
            title: t('group_call', { name: group.name }), multi: true
          });
        })
      }, [icon(ICONS.phone, 15), t('call')]) : null,
      canManage ? h('button', { class: 'btn btn-sm', text: t('members'), onClick: () => groupMembersModal(group, detail) }) : null,
      canManage ? h('button', { class: 'btn btn-sm', text: t('edit'), onClick: () => groupModal(detail, group) }) : null,
      canManage ? h('button', {
        class: 'btn btn-sm btn-danger', text: t('delete'),
        onClick: () => confirmModal(t('delete_group_q', { name: group.name }), t('delete_group_note'), async () => {
          await api.del(`/api/groups/${group.id}`);
          state.activeConv.delete(store.navKey());
          await store.refreshAll();
          await store.loadCompany(detail.company.id);
          store.notify();
          toast(t('group_deleted'));
        })
      }) : null
    ])
  ]);
}

export function groupModal(detail, group) {
  const editing = Boolean(group);
  openModal(t(editing ? 'edit' : 'create_group'), (close) => {
    const name = h('input', { value: group ? group.name : '', placeholder: t('group_name_ph'), required: true, maxlength: 60 });
    const desc = h('input', { value: group ? group.description : '', placeholder: t('description_ph'), maxlength: 200 });
    const slug = h('input', { placeholder: '', maxlength: 32 });
    const picks = new Set(group ? group.memberIds : [state.user.id]);

    const list = editing ? null : h('div', { class: 'check-list' }, detail.members.map((m) => h('label', { class: 'check-row' }, [
      h('input', {
        type: 'checkbox', checked: picks.has(m.id), disabled: m.id === state.user.id,
        onChange: (e) => e.target.checked ? picks.add(m.id) : picks.delete(m.id)
      }),
      avatarNode(m.nick, m.avatar, { size: 'avatar-sm' }),
      h('div', { class: 'grow' }, [h('strong', { text: m.nick }), h('div', { class: 'row-sub', text: roleLabel(m.role) })])
    ])));

    return form(() => guard(async () => {
      if (editing) await api.patch(`/api/groups/${group.id}`, { name: name.value, description: desc.value });
      else await api.post(`/api/companies/${detail.company.id}/groups`, {
        name: name.value, description: desc.value,
        slug: slug.value.trim().toLowerCase() || null, memberIds: [...picks]
      });
      close();
      await store.refreshAll();
      await store.loadCompany(detail.company.id);
      store.notify();
      toast(t(editing ? 'group_updated' : 'group_created'));
    }), [
      field(t('group_name'), name),
      field(t('description'), desc),
      editing ? null : field(t('invite_slug'), slug, t('invite_slug_hint', { host: location.host })),
      list ? field(t('group_members'), list) : null,
      actions(close, t(editing ? 'save' : 'create'))
    ]);
  });
}

function groupMembersModal(group, detail) {
  openModal(`${group.name} · ${t('members')}`, (close) => {
    const inside = detail.members.filter((m) => group.memberIds.includes(m.id));
    const outside = detail.members.filter((m) => !group.memberIds.includes(m.id));
    const select = h('select', {}, [
      h('option', { value: '', text: t(outside.length ? 'pick_member' : 'no_member_to_add') }),
      ...outside.map((m) => h('option', { value: m.id, text: `${m.nick} — ${roleLabel(m.role)}` }))
    ]);

    const reopen = async () => {
      await store.refreshAll();
      await store.loadCompany(detail.company.id);
      store.notify();
      close();
      const fresh = state.companyDetail.groups.find((g) => g.id === group.id);
      if (fresh) groupMembersModal(fresh, state.companyDetail);
    };

    return [
      h('div', { class: 'list' }, inside.map((m) => h('div', { class: 'list-item' }, [
        avatarNode(m.nick, m.avatar, { size: 'avatar-sm' }),
        h('div', { class: 'grow' }, [h('strong', { text: m.nick }), h('div', { class: 'row-sub', text: m.displayName })]),
        h('button', {
          class: 'btn btn-sm btn-danger', text: t('remove_member'),
          onClick: () => guard(async () => {
            await api.del(`/api/groups/${group.id}/members/${m.id}`);
            await reopen();
            toast(t('member_removed_group'));
          })
        })
      ]))),
      field(t('add_member'), h('div', { class: 'inline-row' }, [
        select,
        h('button', {
          class: 'btn btn-sm btn-primary', text: t('add'),
          onClick: () => guard(async () => {
            if (!select.value) return;
            await api.post(`/api/groups/${group.id}/members`, { userId: select.value });
            await reopen();
            toast(t('member_added_group'));
          })
        })
      ])),
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: t('close'), onClick: close })])
    ];
  });
}

/* ------------------------------------------------------------------ */
/* uyeler ve yetkiler                                                  */
/* ------------------------------------------------------------------ */

function membersSection(detail) {
  const isOwner = detail.company.role === 'owner';
  const canManage = allowed(detail, 'members');

  return h('section', { class: 'sheet-section' }, [
    sectionHead(t('members'),
      canManage ? h('button', {
        class: 'btn btn-sm', onClick: () => memberModal(detail)
      }, [icon(ICONS.plus, 15), t('add_by_nick')]) : null,
      allowed(detail, 'invites') ? h('button', {
        class: 'btn btn-sm btn-primary', onClick: () => inviteModal(detail)
      }, [icon(ICONS.link, 15), t('create_link')]) : null),

    h('div', { class: 'list' }, detail.members.map((m) => h('div', { class: 'list-item' }, [
      avatarNode(m.nick, m.avatar, { online: m.online }),
      h('div', { class: 'grow' }, [
        h('strong', { text: m.nick }),
        h('div', { class: 'row-sub', text: `${m.displayName} · ${m.online ? t('online') : t('last_seen', { when: relTime(m.lastSeenAt) || t('unknown') })}` })
      ]),
      h('span', {
        class: `pill${m.role === 'owner' ? ' pill-accent' : m.role === 'admin' ? ' pill-ok' : ''}`,
        text: roleLabel(m.role)
      }),
      m.role === 'admin' ? h('span', {
        class: 'pill pill-dim',
        text: t('perms_n', { n: Object.values(m.perms || {}).filter(Boolean).length })
      }) : null,
      m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm', text: t('message'), onClick: () => guard(() => store.startDm(m.id))
      }) : null,
      isOwner && m.role !== 'owner' ? h('button', {
        class: 'btn btn-sm', text: t('access'), onClick: () => accessModal(detail, m)
      }) : null,
      canManage && m.role !== 'owner' && m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm btn-danger', text: t('remove_member'),
        onClick: () => confirmModal(t('remove_member_q', { nick: m.nick }), t('remove_member_note'), async () => {
          await api.del(`/api/companies/${detail.company.id}/members/${m.id}`);
          await store.refreshAll();
          await store.loadCompany(detail.company.id);
          store.notify();
          toast(t('member_removed'));
        })
      }) : null
    ])))
  ]);
}

/** Yonetim paneline erisim ve tek tek yetkiler. */
function accessModal(detail, member) {
  openModal(t('access_title', { nick: member.nick }), (close) => {
    const perms = { ...(member.perms || {}) };
    let role = member.role;

    const permList = h('div', { class: 'perm-list' }, PERM_KEYS.map((key) =>
      h('label', { class: 'perm-row' }, [
        h('input', {
          type: 'checkbox', checked: Boolean(perms[key]),
          onChange: (e) => { perms[key] = e.target.checked; }
        }),
        h('div', { class: 'grow' }, [
          h('strong', { text: t(`perm_${key}`) }),
          h('div', { class: 'row-sub', text: t(`perm_${key}_sub`) })
        ])
      ])));

    const roleBox = h('div', { class: 'radio-cards' }, [
      ['member', t('role_member'), t('role_member_sub')],
      ['admin', t('role_admin'), t('role_admin_sub')]
    ].map(([value, label, hint]) => {
      const input = h('input', {
        type: 'radio', name: 'role', value, checked: role === value,
        onChange: () => { role = value; permList.classList.toggle('is-off', role !== 'admin'); }
      });
      return h('label', { class: 'radio-card' }, [
        input,
        h('div', {}, [h('strong', { text: label }), h('div', { class: 'row-sub', text: hint })])
      ]);
    }));

    if (role !== 'admin') permList.classList.add('is-off');

    return form(() => guard(async () => {
      await api.patch(`/api/companies/${detail.company.id}/members/${member.id}`, { role, perms });
      close();
      await store.loadCompany(detail.company.id);
      store.notify();
      toast(t('access_saved'));
    }), [
      field(t('role'), roleBox),
      field(t('perms'), permList),
      actions(close, t('save'))
    ]);
  });
}

function memberModal(detail) {
  openModal(t('add_member'), (close) => {
    const nick = h('input', { placeholder: t('nick').toLowerCase(), required: true, maxlength: 24 });
    const role = h('select', {}, [
      h('option', { value: 'member', text: t('role_member') }),
      h('option', { value: 'admin', text: t('role_admin') })
    ]);
    return form(() => guard(async () => {
      await api.post(`/api/companies/${detail.company.id}/members`, { nick: nick.value.trim(), role: role.value });
      close();
      await store.loadCompany(detail.company.id);
      store.notify();
      toast(t('member_added'));
    }), [
      field(t('member_nick'), nick),
      field(t('role'), role, t('role_hint')),
      actions(close, t('add'))
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* davet linkleri                                                      */
/* ------------------------------------------------------------------ */

function invitesSection(detail) {
  const canManage = allowed(detail, 'invites');
  const invites = detail.invites || [];

  return h('section', { class: 'sheet-section' }, [
    sectionHead(t('invites'), canManage ? h('button', {
      class: 'btn btn-sm btn-primary', onClick: () => inviteModal(detail)
    }, [icon(ICONS.plus, 15), t('create_link')]) : null),
    h('p', { class: 'muted', text: t('invites_note', { host: location.host, slug: detail.company.slug }) }),
    invites.length ? h('div', { class: 'list' }, invites.map((invite) => {
      const group = detail.groups.find((g) => g.id === invite.groupId);
      const link = `${location.origin}/${invite.slug}`;
      return h('div', { class: 'list-item' }, [
        h('span', { class: 'avatar avatar-sm' }, [icon(ICONS.link, 15)]),
        h('div', { class: 'grow' }, [
          h('strong', { text: `/${invite.slug}` }),
          h('div', { class: 'row-sub', text: [
            group ? t('group_prefix', { name: group.name }) : t('whole_company'),
            roleLabel(invite.role),
            invite.maxUses ? t('uses_limited', { used: invite.uses, max: invite.maxUses }) : t('uses', { used: invite.uses })
          ].join(' · ') })
        ]),
        h('button', { class: 'btn btn-sm', text: t('copy'), onClick: () => copyText(link, t('link_copied')) }),
        canManage && !group ? h('button', {
          class: 'btn btn-sm btn-danger', text: t('revoke'),
          onClick: () => confirmModal(t('revoke_q'), t('revoke_note', { slug: invite.slug }), async () => {
            await api.del(`/api/invites/${invite.slug}`);
            await store.loadCompany(detail.company.id);
            store.notify();
            toast(t('invite_revoked'));
          })
        }) : null
      ]);
    })) : emptyState(t('invites_empty'), t('invites_empty_sub'))
  ]);
}

function inviteModal(detail) {
  openModal(t('create_link'), (close) => {
    const slug = h('input', { placeholder: 'vertex', maxlength: 32 });
    const group = h('select', {}, [
      h('option', { value: '', text: t('whole_company') }),
      ...detail.groups.map((g) => h('option', { value: g.id, text: t('group_prefix', { name: g.name }) }))
    ]);
    const role = h('select', {}, [
      h('option', { value: 'member', text: t('role_member') }),
      h('option', { value: 'admin', text: t('role_admin') })
    ]);
    const maxUses = h('input', { type: 'number', min: '0', placeholder: t('max_uses_ph') });

    return form(() => guard(async () => {
      const res = await api.post(`/api/companies/${detail.company.id}/invites`, {
        slug: slug.value.trim().toLowerCase() || null,
        groupId: group.value || null,
        role: role.value,
        maxUses: Number(maxUses.value) || 0
      });
      close();
      await store.loadCompany(detail.company.id);
      state.companyTab = 'invites';
      store.notify();
      copyText(`${location.origin}/${res.invite.slug}`, t('invite_ready', { slug: res.invite.slug }));
    }), [
      field(t('invite_slug'), slug, t('invite_slug_hint', { host: location.host })),
      h('div', { class: 'grid-2' }, [field(t('invite_target'), group), field(t('role'), role)]),
      field(t('max_uses'), maxUses),
      actions(close, t('create'))
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* toplantilar                                                         */
/* ------------------------------------------------------------------ */

function meetingsSection(detail) {
  const canManage = allowed(detail, 'meetings');
  const list = detail.meetings.filter((m) => m.status !== 'cancelled');

  return h('section', { class: 'sheet-section' }, [
    sectionHead(t('tab_meetings'), canManage ? h('button', {
      class: 'btn btn-sm btn-primary', onClick: () => meetingModal(detail)
    }, [icon(ICONS.plus, 15), t('schedule_meeting')]) : null),
    list.length
      ? h('div', { class: 'cards' }, list.map((meeting) => meetingCard(meeting, detail, canManage)))
      : emptyState(t('meetings_empty'), t('meetings_empty_sub'))
  ]);
}

export function meetingCard(meeting, detail, canManage) {
  const soon = meeting.startsAt - Date.now();
  const live = meeting.status === 'live' || (soon < 300000 && soon > -3600000);

  return h('div', { class: `card meeting${live ? ' is-live' : ''}` }, [
    h('div', { class: 'card-head' }, [
      h('span', { class: 'avatar' }, [icon(meeting.kind === 'video' ? ICONS.video : ICONS.phone, 16)]),
      h('div', { class: 'grow' }, [
        h('div', { class: 'card-title', text: meeting.title }),
        h('div', { class: 'muted', text: [
          dateTimeLabel(meeting.startsAt),
          t('minutes', { n: meeting.durationMin }),
          meeting.groupName ? t('group_prefix', { name: meeting.groupName }) : t('whole_company')
        ].join(' · ') })
      ]),
      meeting.status === 'live' ? h('span', { class: 'pill pill-danger', text: t('live') })
        : live ? h('span', { class: 'pill pill-warn', text: t('soon') }) : null
    ]),
    meeting.description ? h('p', { class: 'card-desc', text: meeting.description }) : null,
    h('div', { class: 'card-actions' }, [
      h('button', {
        class: 'btn btn-sm btn-primary',
        onClick: () => guard(async () => {
          call.setMe(state.user);
          await call.startCall({
            target: { meetingId: meeting.id },
            kind: meeting.kind,
            title: meeting.title,
            quality: meeting.kind === 'video' ? 'fhd' : 'hd',
            multi: true
          });
        })
      }, [icon(meeting.kind === 'video' ? ICONS.video : ICONS.phone, 15), t('join')]),
      canManage ? h('button', {
        class: 'btn btn-sm btn-danger', text: t('delete'),
        onClick: () => confirmModal(t('cancel_meeting_q'), meeting.title, async () => {
          await api.del(`/api/meetings/${meeting.id}`);
          await store.refreshMeetings();
          if (detail) await store.loadCompany(detail.company.id);
          store.notify();
          toast(t('meeting_cancelled'));
        })
      }) : null
    ])
  ]);
}

export function meetingModal(detail) {
  openModal(t('schedule_meeting'), (close) => {
    const title = h('input', { placeholder: t('meeting_title_ph'), required: true, maxlength: 120 });
    const desc = h('input', { placeholder: t('meeting_desc_ph'), maxlength: 300 });
    const when = h('input', { type: 'datetime-local', value: toLocalInput(Date.now() + 3600000), required: true });
    const group = h('select', {}, [
      h('option', { value: '', text: t('whole_company') }),
      ...detail.groups.map((g) => h('option', { value: g.id, text: t('group_prefix', { name: g.name }) }))
    ]);
    const kind = h('select', {}, [
      h('option', { value: 'audio', text: t('voice') }),
      h('option', { value: 'video', text: t('video') })
    ]);
    const duration = h('select', {}, [15, 30, 45, 60, 90].map((min) => h('option', {
      value: String(min), text: t('minutes', { n: min }), selected: min === 30
    })));

    return form(() => guard(async () => {
      await api.post(`/api/companies/${detail.company.id}/meetings`, {
        title: title.value,
        description: desc.value,
        startsAt: new Date(when.value).getTime(),
        groupId: group.value || null,
        kind: kind.value,
        durationMin: Number(duration.value)
      });
      close();
      await store.refreshMeetings();
      await store.loadCompany(detail.company.id);
      state.companyTab = 'meetings';
      store.notify();
      toast(t('meeting_scheduled'));
    }), [
      field(t('task_title'), title),
      field(t('description'), desc),
      h('div', { class: 'grid-2' }, [field(t('when'), when), field(t('duration'), duration)]),
      h('div', { class: 'grid-2' }, [field(t('attendees'), group), field(t('kind'), kind)]),
      actions(close, t('schedule_meeting'))
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* son aktiviteler                                                     */
/* ------------------------------------------------------------------ */

function activitySection(detail) {
  const rows = detail.activity || [];
  return h('section', { class: 'sheet-section' }, [
    sectionHead(t('activity_title')),
    h('p', { class: 'muted', text: t('activity_note') }),
    rows.length ? h('div', { class: 'feed' }, rows.map((row) => h('div', { class: 'feed-row' }, [
      avatarNode(row.actorNick, row.actorAvatar, { size: 'avatar-sm' }),
      h('div', { class: 'grow' }, [
        h('div', {}, [
          h('strong', { text: row.actorNick }),
          h('span', { text: ` ${ACTION_KEYS[row.action] ? t(ACTION_KEYS[row.action]) : row.action}` }),
          row.detail ? h('span', { class: 'feed-detail', text: ` ${row.detail}` }) : null
        ]),
        h('div', { class: 'row-sub', text: dateTimeLabel(row.at) })
      ]),
      h('span', { class: 'row-time', text: relTime(row.at) })
    ]))) : emptyState(t('activity_empty'), t('activity_empty_sub'))
  ]);
}

/* ------------------------------------------------------------------ */
/* sirket ayarlari                                                     */
/* ------------------------------------------------------------------ */

async function changeLogo(detail) {
  const file = await pickFile('image/*');
  if (!file) return;
  await guard(async () => {
    const dataUrl = await toAvatarDataUrl(file);
    await api.post(`/api/companies/${detail.company.id}/logo`, { dataUrl });
    await store.refreshAll();
    await store.loadCompany(detail.company.id);
    store.notify();
    toast(t('logo_updated'));
  });
}

function companySettings(detail) {
  openModal(t('company_settings'), (close) => {
    const name = h('input', { value: detail.company.name, required: true, maxlength: 60 });
    return form(() => guard(async () => {
      await api.patch(`/api/companies/${detail.company.id}`, { name: name.value });
      close();
      await store.refreshAll();
      await store.loadCompany(detail.company.id);
      store.notify();
      toast(t('company_updated'));
    }), [
      field(t('company_name'), name),
      h('div', { class: 'inline-row' }, [
        h('button', { class: 'btn btn-sm', type: 'button', text: t('upload_logo'), onClick: () => { close(); changeLogo(detail); } })
      ]),
      actions(close, t('save'), h('button', {
        class: 'btn btn-danger', type: 'button', text: t('delete_company'),
        onClick: () => {
          close();
          confirmModal(t('delete_company_q'), t('delete_company_note'), async () => {
            await api.del(`/api/companies/${detail.company.id}`);
            state.nav = 'dm';
            state.companyDetail = null;
            await store.refreshAll();
            store.notify();
            toast(t('company_deleted'));
          });
        }
      }))
    ]);
  });
}

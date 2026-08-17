/** Sirket yonetim paneli: gruplar, uyeler ve yetkiler, gorevler, toplantilar, davetler, son aktiviteler. */

import { h, icon, ICONS, avatarNode, relTime, dateTimeLabel, toLocalInput } from './dom.js';
import {
  toast, guard, openModal, form, field, actions, confirmModal, copyText, emptyState, iconBtn, sectionHead
} from './ui.js';
import * as store from './store.js';
import { state } from './store.js';
import { api } from './net.js';
import { taskBoard } from './tasks.js';
import * as call from './call.js';
import { pickFile, toAvatarDataUrl } from './media.js';

const PERM_LABELS = {
  members: ['Uye yonetimi', 'Uye ekleyip cikarabilir'],
  groups: ['Gruplar', 'Grup acabilir, duzenleyebilir, silebilir'],
  tasks: ['Gorevler', 'Gorev olusturup atayabilir'],
  meetings: ['Toplantilar', 'Toplanti planlayip iptal edebilir'],
  invites: ['Davet linkleri', 'Davet linki uretebilir ve kapatabilir']
};

const ROLE_LABEL = { owner: 'Sirket sahibi', admin: 'Yonetici', member: 'Uye' };

const ACTIONS = {
  'company:create': 'sirketi olusturdu',
  'company:rename': 'sirket adini degistirdi',
  'company:logo': 'sirket logosunu guncelledi',
  'member:add': 'uye ekledi',
  'member:join': 'davet linkiyle katildi',
  'member:remove': 'uyeyi cikardi',
  'member:leave': 'sirketten ayrildi',
  'member:access': 'yetkileri degistirdi',
  'group:create': 'grup olusturdu',
  'group:update': 'grubu duzenledi',
  'group:delete': 'grubu sildi',
  'group:member:add': 'gruba uye ekledi',
  'group:member:remove': 'gruptan uye cikardi',
  'invite:create': 'davet linki olusturdu',
  'invite:delete': 'davet linkini kapatti',
  'task:create': 'gorev olusturdu',
  'task:update': 'gorevi guncelledi',
  'task:delete': 'gorevi sildi',
  'meeting:create': 'toplanti planladi',
  'meeting:cancel': 'toplantiyi iptal etti',
  'call:start': 'gorusme baslatti'
};

const allowed = (detail, perm) =>
  detail.company.role === 'owner' || Boolean(detail.company.perms && detail.company.perms[perm]);

export function companyPane(detail) {
  const { company, members, groups, tasks, meetings } = detail;
  const isOwner = company.role === 'owner';
  const upcoming = meetings.filter((m) => m.status !== 'cancelled').length;

  const tabs = [
    ['groups', `Gruplar ${groups.length}`],
    ['members', `Uyeler ${members.length}`],
    ['tasks', `Gorevler ${tasks.filter((t) => t.status !== 'done').length}`],
    ['meetings', `Toplantilar ${upcoming}`],
    ['invites', `Davetler ${(detail.invites || []).length}`],
    ['activity', 'Aktivite']
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
      iconBtn(ICONS.back, 'Liste', () => document.getElementById('app').classList.add('show-list'), 'only-narrow'),
      h('button', {
        class: 'logo-btn', title: isOwner || allowed(detail, 'members') ? 'Logoyu degistir' : company.name,
        onClick: () => (isOwner || allowed(detail, 'members')) ? changeLogo(detail) : null
      }, [avatarNode(company.name, company.logo, { size: 'avatar-lg', accent: true })]),
      h('div', { class: 'grow' }, [
        h('h3', { text: company.name }),
        h('p', { class: 'muted', text: `${ROLE_LABEL[company.role]} · ${members.length} uye · /${company.slug}` })
      ]),
      isOwner ? iconBtn(ICONS.sliders, 'Sirket ayarlari', () => companySettings(detail)) : null
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
    sectionHead('Gruplar', canManage ? h('button', {
      class: 'btn btn-sm btn-primary', onClick: () => groupModal(detail)
    }, [icon(ICONS.plus, 15), 'Grup olustur']) : null),
    detail.groups.length
      ? h('div', { class: 'cards' }, detail.groups.map((group) => groupCard(group, detail, canManage)))
      : emptyState('Grup yok', 'Ekipleri gruplara bol; her grup kendi sifreli kanalini ve davet linkini alir.')
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
        h('div', { class: 'muted', text: `${group.memberIds.length} uye` })
      ]),
      group.isMember ? h('span', { class: 'pill pill-accent', text: 'uyesin' }) : null
    ]),
    group.description ? h('p', { class: 'card-desc', text: group.description }) : null,
    h('div', { class: 'link-row' }, [
      h('code', { text: `/${group.slug}` }),
      iconBtn(ICONS.copy, 'Davet linkini kopyala', () => copyText(link, 'Grup davet linki kopyalandi.'))
    ]),
    h('div', { class: 'card-actions' }, [
      group.isMember && conv ? h('button', {
        class: 'btn btn-sm', onClick: () => store.openConversation(conv)
      }, [icon(ICONS.chat, 15), 'Sohbet']) : null,
      group.isMember && conv ? h('button', {
        class: 'btn btn-sm', onClick: () => guard(async () => {
          call.setMe(state.user);
          await call.startCall({
            target: { conversationId: conv.id }, kind: 'audio',
            title: `${group.name} · grup gorusmesi`, multi: true
          });
        })
      }, [icon(ICONS.phone, 15), 'Ara']) : null,
      canManage ? h('button', { class: 'btn btn-sm', text: 'Uyeler', onClick: () => groupMembersModal(group, detail) }) : null,
      canManage ? h('button', { class: 'btn btn-sm', text: 'Duzenle', onClick: () => groupModal(detail, group) }) : null,
      canManage ? h('button', {
        class: 'btn btn-sm btn-danger', text: 'Sil',
        onClick: () => confirmModal(`"${group.name}" silinsin mi?`, 'Grup, sohbeti ve davet linki kalici olarak silinir.', async () => {
          await api.del(`/api/groups/${group.id}`);
          state.activeConv.delete(store.navKey());
          await store.refreshAll();
          await store.loadCompany(detail.company.id);
          store.notify();
          toast('Grup silindi.');
        })
      }) : null
    ])
  ]);
}

export function groupModal(detail, group) {
  const editing = Boolean(group);
  openModal(editing ? 'Grubu duzenle' : 'Grup olustur', (close) => {
    const name = h('input', { value: group ? group.name : '', placeholder: 'orn. Tasarim', required: true, maxlength: 60 });
    const desc = h('input', { value: group ? group.description : '', placeholder: 'kisa aciklama', maxlength: 200 });
    const slug = h('input', { placeholder: 'otomatik uretilir', maxlength: 32 });
    const picks = new Set(group ? group.memberIds : [state.user.id]);

    const list = editing ? null : h('div', { class: 'check-list' }, detail.members.map((m) => h('label', { class: 'check-row' }, [
      h('input', {
        type: 'checkbox', checked: picks.has(m.id), disabled: m.id === state.user.id,
        onChange: (e) => e.target.checked ? picks.add(m.id) : picks.delete(m.id)
      }),
      avatarNode(m.nick, m.avatar, { size: 'avatar-sm' }),
      h('div', { class: 'grow' }, [h('strong', { text: m.nick }), h('div', { class: 'row-sub', text: ROLE_LABEL[m.role] })])
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
      toast(editing ? 'Grup guncellendi.' : 'Grup olusturuldu; davet linki hazir.');
    }), [
      field('Grup adi', name),
      field('Aciklama', desc),
      editing ? null : field('Davet linki kimligi', slug, `${location.host}/... — bos birakirsan otomatik atanir`),
      list ? field('Uyeler', list) : null,
      actions(close, editing ? 'Kaydet' : 'Olustur')
    ]);
  });
}

function groupMembersModal(group, detail) {
  openModal(`${group.name} uyeleri`, (close) => {
    const inside = detail.members.filter((m) => group.memberIds.includes(m.id));
    const outside = detail.members.filter((m) => !group.memberIds.includes(m.id));
    const select = h('select', {}, [
      h('option', { value: '', text: outside.length ? 'Uye sec' : 'Eklenecek uye yok' }),
      ...outside.map((m) => h('option', { value: m.id, text: `${m.nick} — ${ROLE_LABEL[m.role]}` }))
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
          class: 'btn btn-sm btn-danger', text: 'Cikar',
          onClick: () => guard(async () => {
            await api.del(`/api/groups/${group.id}/members/${m.id}`);
            await reopen();
            toast('Uye gruptan cikarildi.');
          })
        })
      ]))),
      field('Uye ekle', h('div', { class: 'inline-row' }, [
        select,
        h('button', {
          class: 'btn btn-sm btn-primary', text: 'Ekle',
          onClick: () => guard(async () => {
            if (!select.value) return;
            await api.post(`/api/groups/${group.id}/members`, { userId: select.value });
            await reopen();
            toast('Uye gruba eklendi.');
          })
        })
      ])),
      h('div', { class: 'modal-actions' }, [h('button', { class: 'btn btn-ghost', text: 'Kapat', onClick: close })])
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
    sectionHead('Uyeler',
      canManage ? h('button', {
        class: 'btn btn-sm', onClick: () => memberModal(detail)
      }, [icon(ICONS.plus, 15), 'Nickle ekle']) : null,
      allowed(detail, 'invites') ? h('button', {
        class: 'btn btn-sm btn-primary', onClick: () => inviteModal(detail)
      }, [icon(ICONS.link, 15), 'Davet linki']) : null),

    h('div', { class: 'list' }, detail.members.map((m) => h('div', { class: 'list-item' }, [
      avatarNode(m.nick, m.avatar, { online: m.online }),
      h('div', { class: 'grow' }, [
        h('strong', { text: m.nick }),
        h('div', { class: 'row-sub', text: `${m.displayName} · ${m.online ? 'cevrimici' : `son ${relTime(m.lastSeenAt) || 'bilinmiyor'}`}` })
      ]),
      h('span', {
        class: `pill${m.role === 'owner' ? ' pill-accent' : m.role === 'admin' ? ' pill-ok' : ''}`,
        text: ROLE_LABEL[m.role]
      }),
      m.role === 'admin' ? h('span', {
        class: 'pill pill-dim',
        text: `${Object.values(m.perms || {}).filter(Boolean).length}/5 yetki`
      }) : null,
      m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm', text: 'Mesaj', onClick: () => guard(() => store.startDm(m.id))
      }) : null,
      isOwner && m.role !== 'owner' ? h('button', {
        class: 'btn btn-sm', text: 'Erisim', onClick: () => accessModal(detail, m)
      }) : null,
      canManage && m.role !== 'owner' && m.id !== state.user.id ? h('button', {
        class: 'btn btn-sm btn-danger', text: 'Cikar',
        onClick: () => confirmModal(`${m.nick} cikarilsin mi?`, 'Tum gruplardan da cikarilir.', async () => {
          await api.del(`/api/companies/${detail.company.id}/members/${m.id}`);
          await store.refreshAll();
          await store.loadCompany(detail.company.id);
          store.notify();
          toast('Uye cikarildi.');
        })
      }) : null
    ])))
  ]);
}

/** Yonetim paneline erisim ve tek tek yetkiler. */
function accessModal(detail, member) {
  openModal(`${member.nick} · erisim ayarlari`, (close) => {
    const perms = { ...(member.perms || {}) };
    let role = member.role;

    const permList = h('div', { class: 'perm-list' }, Object.entries(PERM_LABELS).map(([key, [label, hint]]) =>
      h('label', { class: 'perm-row' }, [
        h('input', {
          type: 'checkbox', checked: Boolean(perms[key]),
          onChange: (e) => { perms[key] = e.target.checked; }
        }),
        h('div', { class: 'grow' }, [
          h('strong', { text: label }),
          h('div', { class: 'row-sub', text: hint })
        ])
      ])));

    const roleBox = h('div', { class: 'radio-cards' }, [
      ['member', 'Uye', 'Yonetim paneli kapali; yalnizca sohbet ve kendi gorevleri.'],
      ['admin', 'Yonetici', 'Yonetim paneline erisir; asagidaki yetkilerle sinirlanir.']
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
      toast('Erisim ayarlari kaydedildi.');
    }), [
      field('Rol', roleBox),
      field('Yetkiler', permList),
      actions(close, 'Kaydet')
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
      await store.loadCompany(detail.company.id);
      store.notify();
      toast('Uye eklendi.');
    }), [
      field('Kullanici nicki', nick),
      field('Rol', role, 'Yonetici yetkilerini sonra "Erisim" ile sinirlayabilirsin.'),
      actions(close, 'Ekle')
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
    sectionHead('Davet linkleri', canManage ? h('button', {
      class: 'btn btn-sm btn-primary', onClick: () => inviteModal(detail)
    }, [icon(ICONS.plus, 15), 'Link olustur']) : null),
    h('p', { class: 'muted', text: `Link ile gelen kisi tek tek eklenmeye gerek kalmadan katilir. Ornek: ${location.host}/${detail.company.slug}` }),
    invites.length ? h('div', { class: 'list' }, invites.map((invite) => {
      const group = detail.groups.find((g) => g.id === invite.groupId);
      const link = `${location.origin}/${invite.slug}`;
      return h('div', { class: 'list-item' }, [
        h('span', { class: 'avatar avatar-sm' }, [icon(ICONS.link, 15)]),
        h('div', { class: 'grow' }, [
          h('strong', { text: `/${invite.slug}` }),
          h('div', { class: 'row-sub', text: [
            group ? `grup: ${group.name}` : 'tum sirket',
            `rol: ${ROLE_LABEL[invite.role]}`,
            `kullanim: ${invite.uses}${invite.maxUses ? `/${invite.maxUses}` : ''}`
          ].join(' · ') })
        ]),
        h('button', { class: 'btn btn-sm', text: 'Kopyala', onClick: () => copyText(link, 'Link kopyalandi.') }),
        canManage && !group ? h('button', {
          class: 'btn btn-sm btn-danger', text: 'Kapat',
          onClick: () => confirmModal('Link kapatilsin mi?', `/${invite.slug} artik calismaz.`, async () => {
            await api.del(`/api/invites/${invite.slug}`);
            await store.loadCompany(detail.company.id);
            store.notify();
            toast('Davet linki kapatildi.');
          })
        }) : null
      ]);
    })) : emptyState('Link yok', 'Davet linki olusturarak ekibi tek tek eklemeden cagirabilirsin.')
  ]);
}

function inviteModal(detail) {
  openModal('Davet linki olustur', (close) => {
    const slug = h('input', { placeholder: 'vertex veya 12345', maxlength: 32 });
    const group = h('select', {}, [
      h('option', { value: '', text: 'Tum sirket' }),
      ...detail.groups.map((g) => h('option', { value: g.id, text: `Grup — ${g.name}` }))
    ]);
    const role = h('select', {}, [
      h('option', { value: 'member', text: 'Uye' }),
      h('option', { value: 'admin', text: 'Yonetici' })
    ]);
    const maxUses = h('input', { type: 'number', min: '0', placeholder: '0 = sinirsiz' });

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
      copyText(`${location.origin}/${res.invite.slug}`, `Link hazir ve kopyalandi: /${res.invite.slug}`);
    }), [
      field('Link kimligi', slug, `${location.host}/... — bos birakirsan otomatik atanir`),
      h('div', { class: 'grid-2' }, [field('Hedef', group), field('Rol', role)]),
      field('Kullanim siniri', maxUses),
      actions(close, 'Olustur')
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
    sectionHead('Toplantilar', canManage ? h('button', {
      class: 'btn btn-sm btn-primary', onClick: () => meetingModal(detail)
    }, [icon(ICONS.plus, 15), 'Toplanti planla']) : null),
    list.length
      ? h('div', { class: 'cards' }, list.map((meeting) => meetingCard(meeting, detail, canManage)))
      : emptyState('Toplanti yok', 'Sesli veya goruntulu bir toplanti planla; katilimcilar zamaninda katilabilir.')
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
          `${meeting.durationMin} dk`,
          meeting.groupName ? `grup: ${meeting.groupName}` : 'tum sirket'
        ].join(' · ') })
      ]),
      meeting.status === 'live' ? h('span', { class: 'pill pill-danger', text: 'canli' })
        : live ? h('span', { class: 'pill pill-warn', text: 'yaklasiyor' }) : null
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
      }, [icon(meeting.kind === 'video' ? ICONS.video : ICONS.phone, 15), 'Katil']),
      canManage ? h('button', {
        class: 'btn btn-sm btn-danger', text: 'Iptal',
        onClick: () => confirmModal('Toplanti iptal edilsin mi?', meeting.title, async () => {
          await api.del(`/api/meetings/${meeting.id}`);
          await store.refreshMeetings();
          if (detail) await store.loadCompany(detail.company.id);
          store.notify();
          toast('Toplanti iptal edildi.');
        })
      }) : null
    ])
  ]);
}

export function meetingModal(detail) {
  openModal('Toplanti planla', (close) => {
    const title = h('input', { placeholder: 'orn. Haftalik degerlendirme', required: true, maxlength: 120 });
    const desc = h('input', { placeholder: 'aciklama (istege bagli)', maxlength: 300 });
    const when = h('input', { type: 'datetime-local', value: toLocalInput(Date.now() + 3600000), required: true });
    const group = h('select', {}, [
      h('option', { value: '', text: 'Tum sirket' }),
      ...detail.groups.map((g) => h('option', { value: g.id, text: `Grup — ${g.name}` }))
    ]);
    const kind = h('select', {}, [
      h('option', { value: 'audio', text: 'Sesli' }),
      h('option', { value: 'video', text: 'Goruntulu' })
    ]);
    const duration = h('select', {}, [15, 30, 45, 60, 90].map((min) => h('option', {
      value: String(min), text: `${min} dk`, selected: min === 30
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
      toast('Toplanti planlandi; katilimcilara bildirildi.');
    }), [
      field('Baslik', title),
      field('Aciklama', desc),
      h('div', { class: 'grid-2' }, [field('Zaman', when), field('Sure', duration)]),
      h('div', { class: 'grid-2' }, [field('Katilimcilar', group), field('Tur', kind)]),
      actions(close, 'Planla')
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* son aktiviteler                                                     */
/* ------------------------------------------------------------------ */

function activitySection(detail) {
  const rows = detail.activity || [];
  return h('section', { class: 'sheet-section' }, [
    sectionHead('Son aktiviteler'),
    h('p', { class: 'muted', text: 'Sirkette kim ne yapti: uye, grup, gorev, toplanti ve davet islemleri.' }),
    rows.length ? h('div', { class: 'feed' }, rows.map((row) => h('div', { class: 'feed-row' }, [
      avatarNode(row.actorNick, row.actorAvatar, { size: 'avatar-sm' }),
      h('div', { class: 'grow' }, [
        h('div', {}, [
          h('strong', { text: row.actorNick }),
          h('span', { text: ` ${ACTIONS[row.action] || row.action}` }),
          row.detail ? h('span', { class: 'feed-detail', text: ` ${row.detail}` }) : null
        ]),
        h('div', { class: 'row-sub', text: dateTimeLabel(row.at) })
      ]),
      h('span', { class: 'row-time', text: relTime(row.at) })
    ]))) : emptyState('Kayit yok', 'Sirkette bir islem yapildiginda burada gorunur.')
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
    toast('Sirket logosu guncellendi.');
  });
}

function companySettings(detail) {
  openModal('Sirket ayarlari', (close) => {
    const name = h('input', { value: detail.company.name, required: true, maxlength: 60 });
    return form(() => guard(async () => {
      await api.patch(`/api/companies/${detail.company.id}`, { name: name.value });
      close();
      await store.refreshAll();
      await store.loadCompany(detail.company.id);
      store.notify();
      toast('Sirket guncellendi.');
    }), [
      field('Sirket adi', name),
      h('div', { class: 'inline-row' }, [
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Logo yukle', onClick: () => { close(); changeLogo(detail); } })
      ]),
      actions(close, 'Kaydet', h('button', {
        class: 'btn btn-danger', type: 'button', text: 'Sirketi sil',
        onClick: () => {
          close();
          confirmModal('Sirket silinsin mi?', 'Gruplar, sohbetler, gorevler ve toplantilar kalici olarak silinir.', async () => {
            await api.del(`/api/companies/${detail.company.id}`);
            state.nav = 'dm';
            state.companyDetail = null;
            await store.refreshAll();
            store.notify();
            toast('Sirket silindi.');
          });
        }
      }))
    ]);
  });
}

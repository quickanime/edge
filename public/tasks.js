/** Gorev panosu: uc kolon, surukle-birak, oncelik seridi ve ilerleme ozeti. */

import { h, icon, ICONS, avatarNode } from './dom.js';
import { guard, openModal, form, field, actions, confirmModal, emptyState, toast } from './ui.js';
import * as store from './store.js';
import { state } from './store.js';

export const COLUMNS = [
  { key: 'todo', label: 'Yapilacak' },
  { key: 'doing', label: 'Devam eden' },
  { key: 'done', label: 'Biten' }
];

const PRIORITY = {
  low: { label: 'Dusuk', cls: 'prio-low' },
  normal: { label: 'Normal', cls: 'prio-normal' },
  high: { label: 'Yuksek', cls: 'prio-high' }
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * tasks: gorev listesi
 * detail: sirket detayi (yonetim yetkisi ve duzenleme icin) — yoksa salt durum degisimi
 */
export function taskBoard(tasks, detail = null) {
  const canManage = Boolean(detail && ['owner', 'admin'].includes(detail.company.role) &&
    (detail.company.role === 'owner' || (detail.company.perms && detail.company.perms.tasks)));

  const done = tasks.filter((t) => t.status === 'done').length;
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const board = h('div', { class: 'board' }, COLUMNS.map((column) => {
    const items = tasks.filter((t) => t.status === column.key);
    const columnEl = h('section', {
      class: `board-col col-${column.key}`,
      dataset: { status: column.key },
      onDragover: (e) => { e.preventDefault(); columnEl.classList.add('is-drop'); },
      onDragleave: () => columnEl.classList.remove('is-drop'),
      onDrop: (e) => {
        e.preventDefault();
        columnEl.classList.remove('is-drop');
        const taskId = e.dataTransfer.getData('text/plain');
        const task = tasks.find((t) => t.id === taskId);
        if (task && task.status !== column.key) {
          guard(() => store.updateTask(task, { status: column.key }));
        }
      }
    }, [
      h('header', { class: 'board-head' }, [
        h('span', { class: 'board-dot' }),
        h('h5', { text: column.label }),
        h('span', { class: 'pill', text: String(items.length) })
      ]),
      items.length
        ? h('div', { class: 'board-items' }, items.map((task) => taskCard(task, detail, canManage)))
        : h('p', { class: 'board-empty', text: 'Bos' })
    ]);
    return columnEl;
  }));

  return h('div', { class: 'task-view' }, [
    h('div', { class: 'task-summary' }, [
      h('div', { class: 'grow' }, [
        h('strong', { text: `${tasks.length} gorev` }),
        h('div', { class: 'muted', text: `${done} tamamlandi · ${tasks.length - done} acik` })
      ]),
      h('div', { class: 'progress', title: `%${percent}` }, [
        h('i', { class: `progress-fill p${Math.round(percent / 5) * 5}` })
      ]),
      h('span', { class: 'progress-label', text: `%${percent}` }),
      canManage ? h('button', {
        class: 'btn btn-sm btn-primary', onClick: () => taskModal(detail)
      }, [icon(ICONS.plus, 15), 'Gorev']) : null
    ]),
    tasks.length ? board : emptyState('Gorev yok', 'Bu listede gorunecek bir gorev bulunmuyor.')
  ]);
}

export function taskCard(task, detail, canManage) {
  const priority = PRIORITY[task.priority] || PRIORITY.normal;
  const overdue = task.dueDate && task.status !== 'done' && task.dueDate < today();
  const nextStatus = task.status === 'done' ? 'todo' : task.status === 'todo' ? 'doing' : 'done';

  const card = h('article', {
    class: `tcard ${priority.cls}${task.status === 'done' ? ' is-done' : ''}`,
    draggable: 'true',
    onDragstart: (e) => {
      e.dataTransfer.setData('text/plain', task.id);
      card.classList.add('is-dragging');
    },
    onDragend: () => card.classList.remove('is-dragging')
  }, [
    h('div', { class: 'tcard-top' }, [
      h('button', {
        class: `task-check${task.status === 'done' ? ' is-done' : ''}`,
        title: task.status === 'done' ? 'Geri al' : 'Bitti isaretle',
        onClick: () => guard(() => store.updateTask(task, { status: task.status === 'done' ? 'todo' : 'done' }))
      }, [icon(ICONS.check, 12)]),
      h('h6', { class: 'tcard-title', text: task.title })
    ]),

    task.description ? h('p', { class: 'tcard-desc', text: task.description }) : null,

    h('div', { class: 'tcard-chips' }, [
      task.assigneeGroupName
        ? h('span', { class: 'chip chip-accent' }, [icon(ICONS.users, 12), task.assigneeGroupName])
        : task.assigneeNick
          ? h('span', { class: 'chip' }, [
            avatarNode(task.assigneeNick, null, { size: 'avatar-xs' }),
            `@${task.assigneeNick}`
          ])
          : h('span', { class: 'chip chip-dim', text: 'atanmadi' }),
      task.dueDate ? h('span', {
        class: `chip${overdue ? ' chip-danger' : ''}`, title: 'Son tarih'
      }, [icon(ICONS.calendar, 12), task.dueDate]) : null,
      task.priority === 'high' ? h('span', { class: 'chip chip-danger', text: 'yuksek' }) : null,
      !detail && task.companyName ? h('span', { class: 'chip chip-dim', text: task.companyName }) : null
    ]),

    h('div', { class: 'tcard-actions' }, [
      h('button', {
        class: 'btn btn-xs', title: 'Sonraki adima tasi',
        text: task.status === 'done' ? 'Yeniden ac' : task.status === 'todo' ? 'Basla' : 'Bitir',
        onClick: () => guard(() => store.updateTask(task, { status: nextStatus }))
      }),
      canManage ? h('button', {
        class: 'btn btn-xs', text: 'Duzenle', onClick: () => taskModal(detail, task)
      }) : null,
      canManage ? h('button', {
        class: 'btn btn-xs btn-danger', text: 'Sil',
        onClick: () => confirmModal('Gorev silinsin mi?', task.title, async () => {
          const { api } = await import('./net.js');
          await api.del(`/api/tasks/${task.id}`);
          await store.refreshTasks();
          await store.loadCompany(task.companyId);
          store.notify();
          toast('Gorev silindi.');
        })
      }) : null
    ])
  ]);

  return card;
}

export function taskModal(detail, task) {
  const editing = Boolean(task && task.id);
  openModal(editing ? 'Gorevi duzenle' : 'Gorev olustur', (close) => {
    const title = h('input', { value: task ? task.title : '', placeholder: 'Ne yapilacak?', required: true, maxlength: 120 });
    const desc = h('textarea', { placeholder: 'Detay (istege bagli)', maxlength: 2000 });
    desc.value = task && task.description ? task.description : '';

    const current = task
      ? (task.assigneeGroupId ? `g:${task.assigneeGroupId}` : task.assigneeUserId ? `u:${task.assigneeUserId}` : '')
      : '';
    const assignee = h('select', {}, [
      h('option', { value: '', text: 'Atanmadi', selected: !current }),
      ...detail.groups.map((g) => h('option', {
        value: `g:${g.id}`, text: `Grup — ${g.name}`, selected: current === `g:${g.id}`
      })),
      ...detail.members.map((m) => h('option', {
        value: `u:${m.id}`, text: `Kisi — ${m.nick}`, selected: current === `u:${m.id}`
      }))
    ]);
    const priority = h('select', {}, Object.entries(PRIORITY).map(([key, p]) => h('option', {
      value: key, text: p.label, selected: (task ? task.priority : 'normal') === key
    })));
    const status = h('select', {}, COLUMNS.map((c) => h('option', {
      value: c.key, text: c.label, selected: (task ? task.status : 'todo') === c.key
    })));
    const due = h('input', { type: 'date', value: task && task.dueDate ? task.dueDate : '' });

    return form(() => guard(async () => {
      const [kind, ref] = assignee.value ? assignee.value.split(':') : ['', ''];
      const payload = {
        title: title.value,
        description: desc.value,
        priority: priority.value,
        status: status.value,
        dueDate: due.value || null,
        assigneeUserId: kind === 'u' ? ref : null,
        assigneeGroupId: kind === 'g' ? ref : null
      };
      const { api } = await import('./net.js');
      if (editing) await api.patch(`/api/tasks/${task.id}`, payload);
      else await api.post(`/api/companies/${detail.company.id}/tasks`, payload);
      close();
      await store.refreshTasks();
      await store.loadCompany(detail.company.id);
      state.companyTab = 'tasks';
      store.notify();
      toast(editing ? 'Gorev guncellendi.' : 'Gorev olusturuldu.');
    }), [
      field('Baslik', title),
      field('Aciklama', desc),
      h('div', { class: 'grid-2' }, [
        field('Atanan', assignee),
        field('Oncelik', priority)
      ]),
      h('div', { class: 'grid-2' }, [
        field('Durum', status),
        field('Son tarih', due)
      ]),
      actions(close, editing ? 'Kaydet' : 'Olustur')
    ]);
  });
}

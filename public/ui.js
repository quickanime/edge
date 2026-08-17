/** Paylasilan arayuz parcalari: bildirim, diyalog, form kaliplari. */

import { h, icon, ICONS, clear } from './dom.js';
import { t, serverText } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

let toastTimer;
export function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('is-hidden'), 3400);
}

export async function guard(fn) {
  try { return await fn(); } catch (err) { toast(serverText(err.message) || t('error'), true); return null; }
}

export function openModal(title, buildBody, { wide = false } = {}) {
  const modal = $('#modal');
  modal.querySelector('.modal-card').classList.toggle('is-wide', wide);
  $('#modal-title').textContent = title;
  const body = clear($('#modal-body'));
  body.append(...[].concat(buildBody(closeModal)).filter(Boolean));
  modal.classList.remove('is-hidden');
  const first = body.querySelector('input:not([type=hidden]), textarea, select');
  if (first) first.focus();
}

export function closeModal() {
  $('#modal').classList.add('is-hidden');
  clear($('#modal-body'));
}

export function form(onSubmit, children) {
  return h('form', {
    class: 'form',
    onSubmit: (e) => { e.preventDefault(); onSubmit(e); }
  }, children);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, [
    h('span', { text: label }),
    control,
    hint ? h('small', { class: 'muted', text: hint }) : null
  ]);
}

export function actions(closeFn, submitLabel, extra) {
  return h('div', { class: 'modal-actions' }, [
    extra || null,
    h('button', { class: 'btn btn-ghost', type: 'button', onClick: closeFn, text: t('cancel') }),
    h('button', { class: 'btn btn-primary', type: 'submit', text: submitLabel })
  ]);
}

export function confirmModal(title, text, onConfirm, { danger = true } = {}) {
  openModal(title, (close) => form(() => guard(async () => { await onConfirm(); close(); }), [
    h('p', { class: 'muted', text }),
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', type: 'button', onClick: close, text: t('cancel') }),
      h('button', { class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`, type: 'submit', text: t('confirm') })
    ])
  ]));
}

export function copyText(text, label = null) {
  label = label || t('copied');
  const done = () => toast(label);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallback());
  } else fallback();

  function fallback() {
    const area = h('textarea', { value: text, class: 'copy-sink' });
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch { toast(t('copy_failed'), true); }
    area.remove();
  }
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, [
    h('img', { src: '/logo.svg', alt: '', width: 42, height: 42 }),
    h('h3', { text: title }),
    h('p', { text }),
    action || null
  ]);
}

export function sectionHead(title, ...controls) {
  return h('header', { class: 'sheet-head' }, [
    h('h4', { text: title }),
    h('div', { class: 'card-actions' }, controls.filter(Boolean))
  ]);
}

export function iconBtn(path, title, onClick, extraClass = '') {
  return h('button', {
    class: `icon-btn ${extraClass}`.trim(), title, 'aria-label': title, type: 'button', onClick
  }, [icon(path)]);
}

export { ICONS };

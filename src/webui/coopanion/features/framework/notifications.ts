import type { PageContext } from '../../base/page.ts';
import { studioControls, studioText as t } from './controls.ts';

export type NotificationKind = 'success' | 'pending' | 'notice' | 'info' | 'progress';

export function studioNotifications(ctx: PageContext) {
  const c = studioControls(ctx), { root, signal } = ctx;
  const win = c.doc.defaultView!;
  const notice = c.node('aside', '', 'studio-feedback');
  notice.hidden = true;
  notice.setAttribute('popover', 'manual');
  const icon = c.node('span', '', 'studio-feedback-icon');
  icon.setAttribute('aria-hidden', 'true');
  const title = c.status('studio-feedback-title');
  const message = c.node('p', '', 'studio-feedback-message');
  const details = c.button(t('详情', 'Details'), () => setExpanded(!expanded));
  details.setAttribute('aria-expanded', 'false');
  const dismiss = c.button('×', () => notify(''));
  dismiss.classList.add('studio-feedback-dismiss');
  dismiss.setAttribute('aria-label', t('关闭通知', 'Dismiss notification'));
  const heading = c.node('div', '', 'studio-feedback-heading');
  heading.append(icon, title, details, dismiss);
  notice.append(heading, message);

  let timer: number | undefined;
  let expanded = false;
  let restoreFocus: HTMLElement | null = null;
  let current = '';

  function setExpanded(next: boolean) {
    expanded = next;
    notice.dataset.expanded = String(next);
    details.setAttribute('aria-expanded', String(next));
    details.textContent = next ? t('收起', 'Collapse') : t('详情', 'Details');
    message.tabIndex = next ? 0 : -1;
  }
  function clearTimer() {
    win.clearTimeout(timer);
    timer = undefined;
  }
  function scheduleDismiss() {
    clearTimer();
    const transient = notice.dataset.kind === 'success' || notice.dataset.kind === 'info';
    if (!signal.aborted && transient && !notice.hidden && !notice.matches(':hover, :focus-within')) {
      timer = win.setTimeout(() => notify(''), 4200);
    }
  }
  function place() {
    const dialogs = root.querySelectorAll('dialog[open]');
    const dialog = dialogs[dialogs.length - 1];
    const owner = dialog?.querySelector('.studio-dialog-body') ?? dialog ?? root;
    const inline = owner !== root;
    if (notice.parentElement !== owner) {
      if (notice.matches(':popover-open')) notice.hidePopover();
      if (inline) owner.prepend(notice); else owner.append(notice);
    }
    if (inline) {
      notice.removeAttribute('popover');
      return;
    }
    notice.setAttribute('popover', 'manual');
    const rect = (root.querySelector('.studio-surface') ?? root).getBoundingClientRect();
    const scrollTop = root.closest('.panelslot')?.getBoundingClientRect().top ?? 0;
    const headerBottom = root.querySelector('.studio-panel-header')?.getBoundingClientRect().bottom ?? 0;
    const safeTop = Math.max(rect.top, scrollTop, headerBottom) + 12;
    const right = Math.max(12, win.innerWidth - rect.right + 12);
    notice.style.setProperty('--notice-top', Math.max(12, safeTop) + 'px');
    notice.style.setProperty('--notice-right', right + 'px');
    notice.style.setProperty('--notice-width', Math.min(348, Math.max(1, rect.width - 24)) + 'px');
    if (!notice.hidden && typeof notice.showPopover === 'function' && !notice.matches(':popover-open')) notice.showPopover();
  }
  const observer = new win.MutationObserver(records => {
    if (!notice.hidden && records.some(record => record.type === 'attributes' && (record.target as Element).matches('dialog')
      || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && node.matches('dialog')))) place();
  });
  observer.observe(root, { subtree:true, childList:true, attributes:true, attributeFilter:['open'] });
  win.addEventListener('resize', () => { if (!notice.hidden) place(); }, {signal});
  win.addEventListener('scroll', () => { if (!notice.hidden) place(); }, {signal, passive:true, capture:true});
  notice.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || notice.dataset.kind === 'pending' || notice.dataset.kind === 'progress') return;
    event.preventDefault();
    event.stopPropagation();
    if (expanded) {
      setExpanded(false);
      details.focus({preventScroll:true});
    } else notify('');
  }, {signal});
  notice.addEventListener('pointerenter', clearTimer, {signal});
  notice.addEventListener('pointerleave', scheduleDismiss, {signal});
  notice.addEventListener('focusin', clearTimer, {signal});
  notice.addEventListener('focusout', () => queueMicrotask(scheduleDismiss), {signal});
  signal.addEventListener('abort', () => {
    observer.disconnect();
    clearTimer();
    notice.remove();
  }, {once:true});

  function notify(value: string, kind: NotificationKind = 'notice') {
    if (signal.aborted) return;
    if (!value) {
      clearTimer();
      const focused = notice.contains(c.doc.activeElement);
      if (notice.matches(':popover-open')) notice.hidePopover();
      notice.hidden = true;
      current = '';
      if (focused && restoreFocus?.isConnected) restoreFocus.focus({preventScroll:true});
      return;
    }
    if (value === current && notice.dataset.kind === kind && !notice.hidden) return;
    current = value;
    clearTimer();
    const enter = notice.hidden;
    if (notice.hidden) restoreFocus = c.doc.activeElement as HTMLElement | null;
    notice.dataset.kind = kind;
    const compact = kind === 'info' || kind === 'progress';
    title.textContent = kind === 'success' ? t('已保存', 'Saved')
      : kind === 'pending' ? t('正在保存', 'Saving')
      : kind === 'notice' ? t('操作提示', 'Notification') : value;
    icon.textContent = kind === 'success' ? '✓' : kind === 'info' ? 'i' : kind === 'notice' ? '!' : '';
    details.hidden = kind !== 'notice';
    dismiss.hidden = kind === 'pending' || kind === 'progress';
    message.textContent = compact ? '' : value;
    message.hidden = compact || kind !== 'notice' && (/^(已保存。|正在保存…|Saved\.|Saving…)$/).test(value);
    setExpanded(false);
    notice.hidden = false;
    place();
    if (enter && !win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      notice.getAnimations?.().forEach(animation => animation.cancel());
      notice.animate?.([
        { opacity:0, transform:'translateY(-6px) scale(.98)' },
        { opacity:1, transform:'translateY(0) scale(1)' },
      ], { duration:180, easing:'ease-out' });
    }
    scheduleDismiss();
  }

  return { notify, current: () => current };
}


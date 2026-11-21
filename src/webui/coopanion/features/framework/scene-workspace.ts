import type { PageContext } from '../../base/page.ts';
import { studioControls, studioText as t } from './controls.ts';

type ScenePage = {
  title: string;
  body: HTMLElement;
  action?: HTMLElement;
  open?: () => void;
  close?: () => void;
};

export function sceneWorkspace(ctx: PageContext) {
  const c = studioControls(ctx);
  const element = c.node('section', '', 'studio-scene-workspace');
  const header = c.node('header', '', 'studio-scene-bar');
  const heading = c.node('h2');
  heading.id = 'studio-scene-heading';
  heading.tabIndex = -1;
  element.setAttribute('aria-labelledby', heading.id);
  const back = c.button('', goBack);
  back.classList.add('studio-scene-back');
  const viewport = c.node('div', '', 'studio-scene-viewport');
  viewport.tabIndex = -1;
  const grid = c.node('div', '', 'studio-scene-apps');
  const actions = c.node('div', '', 'studio-scene-actions');
  header.append(back, heading, actions);
  element.append(header, viewport);

  const home: ScenePage = {title: t('场景', 'Scenes'), body: grid};
  const stack: { page: ScenePage; opener?: HTMLElement; scroll: number }[] = [{page: home, scroll: 0}];
  function render() {
    const {page, scroll} = stack.at(-1)!;
    const parent = stack.at(-2);
    back.hidden = !parent;
    header.hidden = !parent;
    back.textContent = parent ? '‹ ' + parent.page.title : '';
    if (parent) back.setAttribute('aria-label', t('返回 ', 'Back to ') + parent.page.title);
    heading.textContent = page.title;
    actions.replaceChildren(...(page.action ? [page.action] : []));
    viewport.replaceChildren(page.body);
    viewport.scrollTop = scroll;
    element.dataset.view = parent ? 'app' : 'home';
  }
  function open(page: ScenePage, opener?: HTMLElement, focus = true) {
    const top = stack.at(-1)!;
    if (page === top.page) return;
    top.scroll = viewport.scrollTop;
    stack.push({page, opener, scroll: 0});
    render();
    if (focus) heading.focus({preventScroll: true});
    page.open?.();
  }
  function goBack() {
    if (stack.length === 1) return;
    const {page, opener} = stack.pop()!;
    page.close?.();
    render();
    if (opener?.isConnected && !opener.matches(':disabled')) opener.focus({preventScroll: true});
    else (stack.length === 1 ? viewport : heading).focus({preventScroll: true});
  }
  element.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || stack.length === 1) return;
    event.preventDefault();
    goBack();
  }, {signal: ctx.signal});
  render();
  return { element, grid, viewport, open, showing: (page: ScenePage) => stack.at(-1)?.page === page };
}

export function sceneTile(ctx: PageContext, mode: string, title: string, hint: string, open: () => void) {
  const c = studioControls(ctx);
  const button = c.button('', open);
  button.className = 'studio-mode studio-scene-app';
  button.dataset.mode = mode;
  const art = c.node('span', '', 'studio-mode-art');
  art.setAttribute('aria-hidden', 'true');
  const copy = c.node('span', '', 'studio-mode-copy');
  const name = c.node('span', '', 'studio-mode-name');
  const chip = c.node('span', '', 'studio-mode-status');
  const chevron = c.node('span', '›', 'studio-scene-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  name.append(c.node('strong', title), chip);
  copy.append(name, c.node('small', hint), chevron);
  button.append(art, copy);
  return {button, chip};
}

export function sceneDetails(ctx: PageContext, mode: string, hint: string, ...settings: HTMLElement[]) {
  const c = studioControls(ctx);
  const detail = c.node('div', '', 'studio-scene-detail');
  const cover = c.node('div', '', 'studio-scene-cover');
  cover.dataset.mode = mode;
  const art = c.node('div', '', 'studio-mode-art');
  art.setAttribute('aria-hidden', 'true');
  cover.append(art, c.node('p', hint));
  const content = c.node('div', '', 'studio-scene-content');
  content.append(...settings);
  detail.append(cover, content);
  return {detail, content};
}

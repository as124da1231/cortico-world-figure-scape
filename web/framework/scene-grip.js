import { ICONS } from '../icons.js';

export function createSceneExit(doc, onExit) {
  const element = doc.createElement('div');
  element.className = 'scene-exit';
  const button = doc.createElement('button');
  button.type = 'button';
  button.dataset.sceneExit = '';
  button.innerHTML = ICONS.close;
  button.addEventListener('click', onExit);
  const status = doc.createElement('span');
  status.className = 'scene-exit-status';
  status.setAttribute('role', 'status');
  element.append(button, status);
  function update(busy, message = '') {
    const zh = doc.documentElement.lang.startsWith('zh');
    const label = zh ? '返回桌面' : 'Return to desktop';
    if (button.title !== label) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    button.disabled = busy;
    if (status.textContent !== message) status.textContent = message;
  }
  update(false);
  return { element, update };
}

export function createSceneGrip(doc, kind, label, hint) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'scene-grip scene-grip-' + kind;
  button.dataset.sceneGrip = kind;
  button.setAttribute('aria-label', label);
  button.title = hint;
  return button;
}

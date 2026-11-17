import { ICONS, linked } from '../ui.js';
import { positionPhone } from './phone-layout.js';
import { createSceneChatInput } from './scene-chat-input.js';
import { createSceneGrip } from './scene-grip.js';

const UI_WIDTH = 405;

/** One view of the active pet conversation. The World still accepts messages and owns the session. */
export function createPhoneChat({ doc, bubble, text, send, toggleControls, closePortrait, connectMic, syncMic }) {
  const node = (tag, className) => Object.assign(doc.createElement(tag), { className });
  const frame = node('section', 'pet-phone-chat');
  frame.hidden = true;
  const surface = node('div', 'phone-chat-surface');
  surface.style.width = UI_WIDTH + 'px';
  const header = node('header', 'phone-chat-header');
  const identity = node('div', 'phone-chat-title');
  const move = createSceneGrip(doc, 'move', text('移动手机', 'Move phone'),
    text('拖动或按方向键移动手机', 'Drag or use the arrow keys to move the phone'));
  function iconButton(icon, className, run) {
    const button = node('button', className);
    button.type = 'button';
    button.innerHTML = icon;
    button.addEventListener('click', run);
    return button;
  }
  const controls = iconButton(ICONS.apps, 'phone-chat-controls', () => toggleControls(controls));
  controls.setAttribute('aria-haspopup', 'dialog');
  controls.setAttribute('aria-controls', 'menu');
  controls.setAttribute('aria-expanded', 'false');
  const connection = node('span', 'phone-chat-connection');
  connection.setAttribute('role', 'status');
  const statusLabel = node('span', 'phone-visually-hidden');
  connection.append(statusLabel);
  const close = iconButton(ICONS.close, 'phone-chat-close', closePortrait);
  close.dataset.sceneExit = '';
  const tag = node('div', 'phone-chat-tag');
  tag.append(connection, close);
  header.append(move, identity, controls, tag);
  const log = node('div', 'phone-chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'off'); // The live bubble and submission feedback already announce changes.
  log.tabIndex = 0;
  const history = node('div', 'phone-chat-history');
  const live = node('div', 'phone-chat-live');
  log.append(history, live);
  const dock = node('footer', 'phone-chat-dock');
  const voice = node('div', 'phone-chat-voice');
  const feedback = node('p', 'phone-chat-feedback');
  feedback.setAttribute('role', 'status');

  const form = node('form', 'phone-chat-form');
  const input = node('textarea', 'phone-chat-input');
  input.rows = 1;
  input.maxLength = 500;
  input.autocomplete = 'off';
  const submit = node('button', 'phone-chat-send');
  submit.type = 'submit';
  const mic = node('button', 'phone-chat-mic');
  mic.type = 'button';
  mic.dataset.action = 'voice';
  const micIcon = node('span', 'ic');
  micIcon.setAttribute('aria-hidden', 'true');
  mic.append(micIcon);
  connectMic(mic);
  const resize = createSceneGrip(doc, 'resize', text('缩放手机', 'Resize phone'),
    text('拖动或按方向键缩放手机', 'Drag or use the arrow keys to resize the phone'));
  form.append(input, submit, mic);
  dock.append(voice, feedback, form, resize);

  surface.append(header, log, dock);
  frame.append(surface);
  doc.body.append(frame);

  const original = doc.createComment('pet bubble');
  bubble.before(original);
  const seen = new Map();
  let connected = false, lastGeometry = '', lastLanguage = '';
  let nearEnd = true, historyReady = false, historyRequestedAt = -Infinity;
  let liveKeys = new Set(), liveKey = '';
  log.addEventListener('scroll', () => { nearEnd = log.scrollHeight - log.clientHeight - log.scrollTop < 28; }, { passive: true });
  const follow = () => { if (!frame.hidden && nearEnd) log.scrollTop = log.scrollHeight; };
  const observer = new doc.defaultView.MutationObserver(follow);
  observer.observe(bubble, { subtree: true, characterData: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  const composer = createSceneChatInput({
    doc,text,send,mode:'phone',form,input,submit,feedback,
    delivered(value, cursor, id) {
      if (cursor == null) message('user',value,id);
      nearEnd = true;
      follow();
    },
  });
  function remove(key) {
    seen.get(key)?.remove();
    seen.delete(key);
  }
  function message(side, value, key) {
    if (!value || key && seen.has(key)) return;
    const row = node('div', 'phone-chat-message');
    row.dataset.side = side;
    row.hidden = liveKeys.has(key);
    const speaker = node('span', 'phone-visually-hidden');
    speaker.textContent = side === 'user' ? text('我：', 'You: ') : text('角色：', 'Character: ');
    row.append(speaker, linked(value, value.length, doc));
    history.append(row);
    if (key) seen.set(key, row);
    if (history.childElementCount > 80) {
      const oldest = history.querySelector('.phone-chat-message');
      oldest.remove();
      for (const [id, item] of seen) if (item === oldest) seen.delete(id);
    }
    follow();
  }
  return {
    frame, input, log,
    chromeBounds: () => ({ top: header.getBoundingClientRect().bottom, bottom: dock.getBoundingClientRect().top }),
    render({ active, area, name, online, controlsOpen, switching, speaking = [] }) {
      if (active !== !frame.hidden) {
        frame.hidden = !active;
        if (active) { live.append(bubble); follow(); }
        else {
          historyReady = false;
          historyRequestedAt = -Infinity;
          original.after(bubble);
          for (const element of [...voice.children]) doc.body.append(element);
        }
      }
      if (!active) return;
      const geometry = JSON.stringify(area);
      if (geometry !== lastGeometry) {
        lastGeometry = geometry;
        positionPhone(frame, area);
        surface.style.transform = 'scale(' + area.w / UI_WIDTH + ')';
        follow();
      }
      if (identity.textContent !== name) identity.textContent = name;
      const key = speaking.join(',');
      if (liveKey !== key) {
        const next = new Set(speaking.map(cursor => 'event-' + cursor));
        for (const id of liveKeys) if (!next.has(id) && seen.has(id)) seen.get(id).hidden = false;
        for (const id of next) if (seen.has(id)) seen.get(id).hidden = true;
        liveKeys = next;
        liveKey = key;
        follow();
      }
      syncMic(mic);
      const status = online ? text('已连线', 'Connected') : text('连接中', 'Connecting');
      if (statusLabel.textContent !== status) {
        statusLabel.textContent = status;
        connection.title = status;
      }
      connection.dataset.state = online ? 'ready' : 'connecting';
      const controlLabel = controlsOpen ? text('收起操作台', 'Dismiss controls') : text('打开操作台', 'Open controls');
      if (controls.title !== controlLabel) {
        controls.title = controlLabel;
        controls.setAttribute('aria-label', controlLabel);
      }
      if (controls.getAttribute('aria-expanded') !== String(controlsOpen)) controls.setAttribute('aria-expanded', String(controlsOpen));
      close.disabled = switching;
      composer.setBlocked(switching);
      if (online !== connected) {
        connected = online;
        if (!online) { historyReady = false; historyRequestedAt = -Infinity; }
        composer.setOnline(online);
      }
      if (online && !switching && !historyReady && Date.now() - historyRequestedAt >= 1000) {
        historyRequestedAt = Date.now();
        send({ t: 'phone-history' });
      }
      const locale = doc.documentElement.lang;
      if (locale !== lastLanguage) {
        lastLanguage = locale;
        close.title = text('返回桌面', 'Return to desktop');
        close.setAttribute('aria-label', close.title);
        input.placeholder = text('发消息…', 'Message…');
        input.setAttribute('aria-label', text('输入消息', 'Enter a message'));
        log.setAttribute('aria-label', text('当前对话消息', 'Current conversation'));
        composer.sync();
      }

    },
    message, remove, failed:composer.failed, feedback:composer.note,
    history({ messages, withdrawn, replace }) {
      if (replace) {
        historyReady = true;
        for (const row of history.querySelectorAll('.phone-chat-message')) row.remove();
        seen.clear();
      }
      for (const cursor of withdrawn) remove('event-' + cursor);
      const removed = new Set(withdrawn);
      for (const item of messages) {
        if (removed.has(item.cursor)) continue;
        const images = item.images ? text(`[${item.images} 张图片]`, `[${item.images} image(s)]`) : '';
        message(item.side, [item.text, images].filter(Boolean).join('\n'), 'event-' + item.cursor);
      }
      follow();
    },
    attachListening(element) {
      element.hidden = false;
      if (element.parentElement !== voice) {
        voice.replaceChildren(element);
        follow();
      }
    },
    receipt:composer.receipt,
    focusInput() { input.focus({ preventScroll: true }); },
    focusControls() { controls.focus({ preventScroll: true }); },
  };
}

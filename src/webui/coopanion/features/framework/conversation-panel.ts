import type { ChatItem } from '../../../../chat.ts';
import { workspaceHref } from '../../../../framework/workspace.ts';
import type { PageContext } from '../../base/page.ts';
import { studioControls, studioText as t } from './controls.ts';
import './conversation-panel.css';

type DraftImage = { name: string; mime: string; base64: string };
type Frame = {
  t: string; cursor?: number; before?: number; more?: boolean; id?: string; reason?: string;
  item?: ChatItem; items?: ChatItem[]; phase?: { state: string }; text?: string; images?: DraftImage[];
  refs?: { withdrawn?: number[] }; askId?: string | null; at?: number; cursors?: number[];
};

export function mountConversation(ctx: PageContext): void {
  const c = studioControls(ctx);
  const view = c.node('section', '', 'studio-conversation');
  const header = c.node('header', '', 'studio-conversation-header');
  const back = c.node('a', t('返回工作台', 'Back to workbench')) as HTMLAnchorElement;
  back.href = workspaceHref('framework');
  const connection = c.node('span', t('正在连接…', 'Connecting…'));
  connection.setAttribute('role', 'status');
  header.append(c.node('h2', t('Coo 对话', 'Coo conversation')), connection, back);
  const history = c.node('div', '', 'studio-conversation-history');
  history.tabIndex = 0;
  history.setAttribute('aria-label', t('对话记录', 'Conversation history'));
  const more = c.button(t('较早的消息', 'Earlier messages'), () => write({ t: 'more', before }));
  more.hidden = true;
  const log = c.node('div', '', 'studio-conversation-log');
  const waiting = c.node('p', t('Coo 正在回复…', 'Coo is replying…'), 'studio-conversation-waiting');
  waiting.setAttribute('role', 'status');
  waiting.hidden = true;
  history.append(more, log, waiting);
  const form = c.doc.createElement('form');
  form.className = 'studio-conversation-form';
  const input = c.doc.createElement('textarea');
  input.rows = 2;
  input.maxLength = 4000;
  input.placeholder = t('给 Coo 发消息…', 'Message Coo…');
  input.setAttribute('aria-label', input.placeholder);
  const submit = c.doc.createElement('button');
  submit.type = 'submit';
  submit.className = 'studio-button is-primary';
  submit.textContent = t('发送', 'Send');
  const attach = c.doc.createElement('input');
  attach.type = 'file';
  attach.accept = 'image/png,image/jpeg,image/webp,image/gif';
  attach.multiple = true;
  attach.hidden = true;
  const imageButton = c.button(t('添加图片', 'Add images'), () => attach.click());
  const attachments = c.node('div', '', 'studio-conversation-attachments');
  const status = c.node('p', '', 'studio-conversation-error');
  status.setAttribute('role', 'status');
  form.append(attachments, input, imageButton, submit, attach, status);
  view.append(header, history, form);
  ctx.root.append(view);

  const items = new Map<number, ChatItem>();
  let ready = false, phase = 'idle', before: number | undefined, openAsk: string | null = null;
  let images: DraftImage[] = [], loadingImages = false;
  let pending: { id: string; text: string; images: DraftImage[] } | undefined;
  let inFlight = false;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  const updateForm = () => {
    submit.disabled = !ready || inFlight || loadingImages || (!input.value.trim() && !images.length);
    imageButton.disabled = inFlight || loadingImages;
  };
  ctx.signal.addEventListener('abort', () => clearTimeout(sendTimer), { once: true });
  const write = (frame: object) => { if (stream?.open) stream.send(JSON.stringify(frame)); };

  function drawImages() {
    attachments.replaceChildren(...images.map((image) => {
      const remove = c.button((image.name || t('图片', 'Image')) + ' ×', () => {
        images = images.filter(entry => entry !== image);
        drawImages(); updateForm();
      });
      remove.disabled = inFlight;
      return remove;
    }));
    attachments.hidden = !images.length;
  }

  function appendImage(el: HTMLElement, handle: string, name?: string) {
    const image = c.doc.createElement('img');
    image.loading = 'lazy';
    image.alt = name ?? t('对话图片', 'Conversation image');
    image.src = '/api/blob?' + new URLSearchParams({ handle });
    el.append(image);
  }

  function draw(preservePosition = false) {
    const distance = history.scrollHeight - history.scrollTop;
    const atBottom = distance - history.clientHeight < 70;
    const rows = [...items.values()].filter(item => ['user', 'say', 'ask', 'answer'].includes(item.kind))
      .sort((a, b) => (('at' in a && a.at) || a.cursor) - (('at' in b && b.at) || b.cursor));
    log.replaceChildren(...rows.map(item => {
      if (item.kind === 'user' || item.kind === 'say') {
        const text = item.kind === 'user' ? item.text : item.beats.map(beat => beat.text).join('\n');
        const bubble = c.node('div', text, `studio-conversation-bubble ${item.kind === 'user' ? 'from-user' : 'from-coo'}`);
        for (const image of item.images ?? []) appendImage(bubble, image.ref, image.name);
        return bubble;
      }
      if (item.kind === 'ask') {
        const question = c.node('div', item.question, 'studio-conversation-bubble from-coo');
        if (openAsk === item.askId) item.options.forEach((label, index) => {
          question.append(c.button(label, () => write({ t: 'answer', askId: item.askId, index })));
        });
        return question;
      }
      if (item.kind === 'answer') {
        const question = rows.find(row => row.kind === 'ask' && row.askId === item.askId);
        const choice = question?.kind === 'ask' && typeof item.index === 'number' ? question.options[item.index] : '';
        return c.node('div', item.text || choice || t('已关闭提问', 'Question closed'), 'studio-conversation-bubble from-user');
      }
      return c.doc.createTextNode('');
    }));
    waiting.hidden = !ready || phase === 'idle' || !['user', 'answer'].includes(rows.at(-1)?.kind ?? '');
    more.hidden = before === undefined;
    if (preservePosition) history.scrollTop = history.scrollHeight - distance;
    else if (atBottom) history.scrollTop = history.scrollHeight;
  }

  const stream = ctx.stream?.({
    open() { write({ t: 'hello' }); },
    close() {
      clearTimeout(sendTimer);
      ready = inFlight = false;
      connection.textContent = t('正在重新连接…', 'Reconnecting…');
      drawImages(); updateForm(); draw();
    },
    message(raw) {
      let frame: Frame;
      try { frame = JSON.parse(raw); } catch { return; }
      switch (frame.t) {
        case 'init':
        case 'older':
          if (frame.t === 'init') items.clear();
          for (const item of frame.items ?? []) items.set(item.cursor, item);
          for (const cursor of frame.refs?.withdrawn ?? []) items.delete(cursor);
          before = frame.more ? frame.before : undefined;
          if (frame.t === 'init') {
            ready = true;
            connection.textContent = '';
            phase = frame.phase?.state ?? 'idle';
            openAsk = frame.askId ?? null;
            updateForm();
          }
          draw(frame.t === 'older');
          break;
        case 'item': if (frame.item) { items.set(frame.item.cursor, frame.item); draw(); } break;
        case 'settled':
          for (const cursor of frame.cursors ?? []) {
            const item = items.get(cursor);
            if (item?.kind === 'user' && frame.at) items.set(cursor, { ...item, at: frame.at });
          }
          draw();
          break;
        case 'withdrawn': if (frame.cursor !== undefined) { items.delete(frame.cursor); draw(); } break;
        case 'phase': phase = frame.phase?.state ?? 'idle'; draw(); break;
        case 'ask': openAsk = frame.askId ?? null; draw(); break;
        case 'draft':
          if (!input.value && !images.length) { input.value = frame.text ?? ''; images = frame.images ?? []; drawImages(); updateForm(); input.focus(); }
          else status.textContent = t('输入框已有草稿。', 'The composer already has a draft.');
          break;
        case 'sent':
        case 'rejected':
          if (!pending || frame.id !== pending.id) return;
          clearTimeout(sendTimer);
          inFlight = false;
          if (frame.t === 'sent') {
            if (input.value.trim() === pending.text) input.value = '';
            if (images === pending.images) images = [];
          }
          pending = undefined;
          status.textContent = frame.reason ?? '';
          drawImages(); updateForm();
          break;
      }
    },
  });
  if (!stream) connection.textContent = t('对话暂时不可用', 'Conversation is unavailable');

  input.addEventListener('input', updateForm, { signal: ctx.signal });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!submit.disabled) form.requestSubmit(); }
  }, { signal: ctx.signal });
  async function addImages(files: File[]) {
    if (inFlight || loadingImages || !files.length) return;
    if (files.length + images.length > 8 || files.some(file => file.size > 8 * 1024 * 1024)) {
      status.textContent = t('最多添加八张图片，每张不超过 8 MB。', 'Add up to eight images, each up to 8 MB.');
      return;
    }
    loadingImages = true; updateForm();
    try {
      const next = await Promise.all(files.map(file => new Promise<DraftImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ mime: file.type, base64: String(reader.result).split(',')[1] ?? '', name: file.name });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })));
      images = [...images, ...next];
      status.textContent = '';
    } catch { status.textContent = t('图片读取失败。', 'Could not read images.'); }
    finally { loadingImages = false; if (!ctx.signal.aborted) { drawImages(); updateForm(); } }
  }
  attach.addEventListener('change', () => {
    const files = [...(attach.files ?? [])];
    attach.value = '';
    void addImages(files);
  }, { signal: ctx.signal });
  input.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files ?? [])].filter(file => attach.accept.split(',').includes(file.type));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }, { signal: ctx.signal });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!stream?.open || submit.disabled) return;
    const text = input.value.trim();
    if (pending?.text !== text || pending.images !== images) pending = { id: crypto.randomUUID(), text, images };
    inFlight = true;
    status.textContent = t('正在发送…', 'Sending…');
    drawImages(); updateForm();
    write({ t: 'send', ...pending });
    sendTimer = setTimeout(() => {
      inFlight = false;
      status.textContent = t('还没收到确认，可以重试。', 'No confirmation yet. You can retry.');
      drawImages(); updateForm();
    }, 8_000);
  }, { signal: ctx.signal });
  updateForm();
}

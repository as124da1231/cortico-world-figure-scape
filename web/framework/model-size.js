export const SCALE_MIN = .5;
export const SCALE_MAX = 10;
export const SCENE_SIZE_LIMITS = Object.freeze({
  desktop: Object.freeze({ min: SCALE_MIN, max: SCALE_MAX }),
  room: Object.freeze({ min: .5, max: 3 }),
  phone: Object.freeze({ min: .65, max: 1.5 }),
  wallpaper: Object.freeze({ min: .5, max: 3 }),
});

export function sceneScale(mode, value) {
  const {min,max} = SCENE_SIZE_LIMITS[mode];
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 1));
}

export function sceneSizePosition(mode, scale) {
  const {min,max} = SCENE_SIZE_LIMITS[mode];
  return Math.log(sceneScale(mode, scale) / min) / Math.log(max / min);
}

export function sceneScales(desktop, saved, legacy = desktop) {
  return {
    desktop: sceneScale('desktop', desktop),
    room: sceneScale('room', saved?.room ?? legacy),
    phone: sceneScale('phone', saved?.phone ?? Math.max(.8, Math.min(1.2, legacy))),
    wallpaper: sceneScale('wallpaper', saved?.wallpaper ?? legacy),
  };
}

let serial = 0;
export function createModelSizeControl({ doc, text, mode, label, read, preview, save, report, signal }) {
  const row = doc.createElement('div');
  row.className = 'scene-size-control';
  const heading = doc.createElement('div');
  heading.className = 'scene-size-heading';
  const title = doc.createElement('label');
  const slider = doc.createElement('input');
  slider.type = 'range';
  slider.id = 'scene-character-size-' + ++serial;
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.0001';
  title.htmlFor = slider.id;
  const readout = doc.createElement('output');
  readout.htmlFor.add(slider.id);
  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.className = 'scene-size-reset';
  reset.textContent = text('复位', 'Reset');
  const track = doc.createElement('div');
  track.className = 'scene-size-track';
  const smaller = stepButton('−', text('缩小角色', 'Make character smaller'), -1);
  const larger = stepButton('+', text('放大角色', 'Make character larger'), 1);
  heading.append(title, readout, reset);
  track.append(smaller, slider, larger);
  row.append(heading, track);

  let draft = null, inFlight = null;
  const queue = new Map();
  const listen = signal ? {signal} : undefined;
  const scaleAt = (position, {min,max}) => min * (max / min) ** position;
  const currentSize = scene => sceneScale(scene, (draft?.mode === scene ? draft.scale : undefined)
    ?? queue.get(scene) ?? (inFlight?.mode === scene ? inFlight.scale : undefined) ?? read(scene));
  function sync() {
    const scene = mode();
    const limits = SCENE_SIZE_LIMITS[scene];
    const scale = currentSize(scene);
    const labelText = label?.(scene) ?? text('角色大小', 'Character size');
    if (title.textContent !== labelText) title.textContent = labelText;
    const percentage = Math.round(scale * 100) + '%';
    if (readout.textContent !== percentage) readout.textContent = percentage;
    slider.setAttribute('aria-valuetext', percentage);
    reset.setAttribute('aria-label', text('恢复默认大小', 'Reset character size') + ' · ' + labelText);
    slider.value = String(sceneSizePosition(scene, scale));
    slider.style.setProperty('--size-fill', slider.valueAsNumber * 100 + '%');
    reset.disabled = Math.abs(scale - 1) < .0001;
    smaller.disabled = scale <= limits.min;
    larger.disabled = scale >= limits.max;
  }
  function stepButton(symbol, label, direction) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'scene-size-step';
    button.textContent = symbol;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => adjust(direction * .05), signal ? {signal} : undefined);
    return button;
  }
  function show(scene, next) {
    const scale = sceneScale(scene, next);
    draft = {mode:scene,scale};
    preview(scene, scale);
    sync();
  }
  function adjust(amount) {
    const scene = mode();
    show(scene, currentSize(scene) + amount);
    commit();
  }
  function commit() {
    if (!draft) return;
    queue.set(draft.mode, draft.scale);
    draft = null;
    sync();
    void flush();
  }
  async function flush() {
    if (inFlight) return;
    while (queue.size && !signal?.aborted) {
      const [scene,scale] = queue.entries().next().value;
      queue.delete(scene);
      inFlight = {mode:scene,scale};
      try { await save(scene,scale); }
      catch (error) { if (!signal?.aborted) report(error.message, 'error'); }
      finally {
        inFlight = null;
        if (!signal?.aborted && draft?.mode !== scene && !queue.has(scene)) preview(scene, null);
        if (!signal?.aborted) sync();
      }
    }
  }
  function stopPreview() {
    if (!draft) return;
    const {mode:scene} = draft;
    draft = null;
    preview(scene, queue.get(scene) ?? (inFlight?.mode === scene ? inFlight.scale : null));
    sync();
  }

  reset.addEventListener('click', () => { show(mode(),1);commit(); }, listen);
  slider.addEventListener('input', () => {
    const scene = mode();
    const value = slider.valueAsNumber;
    const scale = sceneScale(scene, scaleAt(value,SCENE_SIZE_LIMITS[scene]));
    draft = {mode:scene,scale};
    preview(scene,scale);
    slider.style.setProperty('--size-fill', value * 100 + '%');
    const shown = Math.round(scale * 100) + '%';
    if (shown !== slider.getAttribute('aria-valuetext')) {
      slider.setAttribute('aria-valuetext',shown);
      readout.textContent = shown;
    }
  }, listen);
  slider.addEventListener('change', commit, listen);
  slider.addEventListener('pointercancel', stopPreview, listen);
  slider.addEventListener('keydown', event => {
    const delta = { ArrowLeft:-.01, ArrowDown:-.01, ArrowRight:.01, ArrowUp:.01, PageDown:-.1, PageUp:.1 }[event.key];
    if (delta !== undefined) { event.preventDefault(); adjust(delta); }
  }, listen);
  sync();
  return { element:row, sync, stopPreview };
}


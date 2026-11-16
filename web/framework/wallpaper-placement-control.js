import { sameWallpaperPlacement, wallpaperPlacement, WALLPAPER_PLACEMENT_LIMITS } from './wallpaper-placement.js';

const percent = value => Number((value * 100).toFixed(1));

export function createWallpaperPlacementControl({doc, text, save, read, preview, compact=false}) {
  const node = (tag, cls='', label='') => Object.assign(doc.createElement(tag),{className:cls,textContent:label});
  const root = node('section','wallpaper-placement' + (compact ? ' wallpaper-placement-compact' : ''));
  const heading = node('p','wallpaper-placement-title');
  const frame = node('div','wallpaper-placement-frame');
  const background = node('img','wallpaper-placement-art');
  const cover = node('img','wallpaper-placement-character');
  for (const img of [background,cover]) { img.alt = ''; img.draggable = false; img.hidden = true; }
  const line = node('div','wallpaper-placement-line');
  const lineGrip = node('span','wallpaper-placement-line-grip',text('接地线','Ground line'));
  const marker = node('div','wallpaper-placement-marker');
  const crosshair = node('span','wallpaper-placement-crosshair');
  line.append(lineGrip);
  marker.append(cover,crosshair);
  frame.append(background,line,marker);
  frame.setAttribute('aria-hidden','true');
  const help = node('p','wallpaper-placement-help', compact
    ? text('画面上的横线是松手后角色落到的高度。','The line marks where the character lands after release.')
    : text('拖动立足点安排站位，拖动横线调整落地高度。','Drag the anchor to place the character or the line to set the landing height.'));
  const fields = node('div','wallpaper-placement-fields');
  const inputs = Object.entries(WALLPAPER_PLACEMENT_LIMITS).map(([key, {min,max}]) => {
    const label = key === 'x' ? text('X · 横向站位','X · Horizontal position') : text('Y · 接地线','Y · Ground line');
    const row = node('div','wallpaper-placement-field');
    const range = node('input'), entry = node('input');
    const caption = node('span','',label);
    range.type = 'range'; entry.type = 'number';
    const suffix = node('span','wallpaper-placement-percent','%');
    const number = node('div','wallpaper-placement-number');
    number.append(entry,suffix);
    for (const input of [range,entry]) {
      input.min = String(percent(min)); input.max = String(percent(max)); input.step = '.1';
      input.setAttribute('aria-label',label + ' (%)');
    }
    range.addEventListener('input',() => change({[key]:range.valueAsNumber / 100}));
    entry.addEventListener('change',() => {
      if (Number.isFinite(entry.valueAsNumber)) change({[key]:entry.valueAsNumber / 100});
      else render();
    });
    row.append(caption,range,number);
    fields.append(row);
    return {key,range,entry};
  });
  const status = node('p','wallpaper-placement-status');
  status.setAttribute('role','status');
  const footer = node('div','wallpaper-placement-actions');
  const button = (value,run,primary=false) => {
    const el = node('button', 'wallpaper-placement-button', value);
    el.type = 'button';
    if (primary) el.classList.add('wallpaper-placement-primary');
    el.addEventListener('click',run);
    return el;
  };
  const defaults = button(text('默认位置','Default position'),() => change(wallpaperPlacement()));
  const reload = button(text('读取当前设置','Reload'),() => void reloadSource());
  const apply = button(text('保存构图','Save composition'),() => void commit(),true);
  footer.append(defaults,reload,apply);
  root.append(heading,...(compact ? [] : [frame]),help,fields,status,footer);
  let source, latest, draft, drag, saving = false;
  let session = 0;

  function dirty() { return draft && source && !sameWallpaperPlacement(draft,source.composition.placement); }
  function changedElsewhere() { return source && latest && source.composition.revision < latest.composition.revision; }
  function setStatus(value, kind='') { status.textContent = value; status.dataset.kind = kind; }
  function render(showGuide=false) {
    if (!draft) return;
    heading.textContent = source.title;
    frame.style.setProperty('--wallpaper-guide-x',percent(draft.x) + '%');
    frame.style.setProperty('--wallpaper-guide-y',percent(draft.groundY) + '%');
    for (const {key,range,entry} of inputs) {
      range.value = entry.value = String(percent(draft[key]));
      range.style.setProperty('--value', (range.valueAsNumber - Number(range.min)) / (Number(range.max) - Number(range.min)) * 100 + '%');
      range.disabled = entry.disabled = saving;
    }
    defaults.disabled = saving || sameWallpaperPlacement(draft,wallpaperPlacement());
    apply.disabled = saving || !dirty() || !!changedElsewhere();
    reload.hidden = !changedElsewhere() && status.dataset.kind !== 'conflict';
    reload.disabled = saving;
    if (showGuide) preview?.(draft);
  }
  function change(patch) {
    if (!draft || saving) return;
    draft = wallpaperPlacement({...draft,...patch});
    if (status.dataset.kind !== 'conflict') setStatus('');
    render(true);
  }
  function sync(next, force=false) {
    if (!next?.id || !next.composition) return;
    if (source?.id !== next.id || force) {
      session++;
      drag = null;
      saving = false;
      source = latest = next;
      draft = next.composition.placement;
      setStatus('');
    } else if (next.composition.revision > latest.composition.revision) {
      latest = next;
      if (!saving && dirty()) setStatus(text('构图已在另一处更新。读取当前设置后再编辑。','The composition changed elsewhere. Reload to continue.'),'conflict');
      else if (!saving) { source = next; draft = next.composition.placement; }
    }
    render();
  }
  async function reloadSource() {
    if (!source || saving) return;
    const current = session;
    saving = true;
    render();
    try {
      const value = read ? await read(source.id) : latest;
      if (current !== session) return;
      sync(value,true);
      render(true);
    } catch (error) {
      if (current === session) setStatus(String(error.message ?? error),'conflict');
    } finally {
      if (current === session) { saving = false; render(); }
    }
  }
  async function commit() {
    if (saving || !dirty() || changedElsewhere()) return;
    saving = true;
    const current = session;
    setStatus(text('正在保存…','Saving…'));
    render();
    try {
      const composition = await save(source.id,draft,source.composition.revision);
      if (current !== session) return;
      sync(latest?.composition.revision > composition.revision ? latest : {...source,composition},true);
      setStatus(text('构图已保存。','Composition saved.'),'ok');
      preview?.(null);
    } catch (error) {
      if (current !== session) return;
      const message = String(error.message ?? error);
      if (message === 'wallpaper-placement-conflict') {
        setStatus(text('构图已在另一处更新，请读取当前设置。','The composition changed elsewhere. Reload the current settings.'),'conflict');
      } else if (message === 'presentation-busy') {
        setStatus(text('场景切换完成后可再保存。','Save again once the scene finishes switching.'),'error');
      } else setStatus(message,'error');
    } finally {
      if (current === session) { saving = false; render(); }
    }
  }
  function move(event) {
    if (drag?.id !== event.pointerId) return;
    const rect = frame.getBoundingClientRect();
    const patch = {groundY:(event.clientY - rect.top) / rect.height + drag.offsetY};
    if (drag.target === marker) patch.x = (event.clientX - rect.left) / rect.width + drag.offsetX;
    change(patch);
  }
  for (const target of [line,marker]) {
    target.addEventListener('pointerdown',event => {
      if (!draft || saving || drag || event.button !== 0) return;
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      drag = {
        target,id:event.pointerId,start:draft,
        offsetY:draft.groundY - (event.clientY - rect.top) / rect.height,
        offsetX:draft.x - (event.clientX - rect.left) / rect.width,
      };
      target.setPointerCapture(event.pointerId);
    });
    target.addEventListener('pointermove',move);
    target.addEventListener('pointerup',event => {
      move(event);
      if (drag?.id === event.pointerId) drag = null;
    });
    target.addEventListener('lostpointercapture',event => {
      if (drag?.id === event.pointerId) { draft = drag.start; drag = null; render(true); }
    });
  }
  function setArt({wallpaperURL,figureURL,fit='cover',scale=1,characterScale=1}={}) {
    frame.dataset.hasArt = String(!!wallpaperURL);
    frame.style.setProperty('--wallpaper-preview-fit',fit);
    frame.style.setProperty('--wallpaper-preview-scale',String(scale));
    frame.style.setProperty('--wallpaper-character-height',Math.min(95,52 * characterScale) + '%');
    for (const [img,url] of [[background,wallpaperURL],[cover,figureURL]]) {
      img.hidden = !url;
      if (url) img.src = url; else img.removeAttribute('src');
    }
  }
  return {
    element:root, sync, setArt,
    showGuide() { if (draft) preview?.(draft); },
    deactivate() {
      const changed = dirty();
      if (latest && (changed || changedElsewhere() || saving)) sync(latest,true);
      preview?.(null);
    },
  };
}


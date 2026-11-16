export const CONTROL_SECTIONS = {
  home: { label: ['首页', 'Home'], icon: 'room' },
  apps: { label: ['应用', 'Apps'], icon: 'apps' },
  scene: { label: ['场景', 'Scenes'], icon: 'desktop' },
  window: { label: ['窗口', 'Window'], icon: 'settings' },
};

export const CONTROL_COMPONENTS = {
  chat: { label: ['对话', 'Chat'], icon: 'chat', rail: true },
  voice: { label: ['麦克风', 'Microphone'], icon: 'mic', rail: true },
  size: { label: ['角色大小', 'Character size'], icon: 'scale', rail: true },
  sound: { label: ['音效', 'Sound effects'], icon: 'sound', rail: true },
  actions: { label: ['动作与表情', 'Actions & expressions'], icon: 'play', rail: true },
  dress: { label: ['装扮', 'Outfits'], icon: 'shirt', rail: true },
  interaction: { label: ['互动设置', 'Interaction settings'], icon: 'cursor', rail: true },
  hoverVisibility: { label: ['显示靠近按钮', 'Show hover buttons'], icon: 'eye', rail: true },
  touchRegions: { label: ['显示触碰判定区', 'Show touch regions'], icon: 'eye', rail: false },
  scenes: { label: ['切换场景', 'Switch scene'], icon: 'desktop', rail: true },
  theme: { label: ['主题', 'Theme'], icon: 'sun', rail: true },
  roam: { label: ['桌面漫游', 'Desktop roaming'], icon: 'roam_calm', rail: true },
  workbench: { label: ['打开工作台', 'Open workbench'], icon: 'settings', rail: true },
  through: { label: ['鼠标穿透', 'Click-through'], icon: 'cursor', rail: true },
  hide: { label: ['隐藏桌宠', 'Hide pet'], icon: 'eyeOff', rail: true },
  close: { label: ['关闭 Live2D', 'Close Live2D'], icon: 'power', rail: true },
  menu: { label: ['打开操作台', 'Open controls'], icon: 'apps', rail: true, railOnly: true },
  worlds: { label: ['打开 World', 'Open Worlds'], icon: 'boxes', rail: true, railOnly: true },
};

export const CONTROL_RAIL_LIMIT = 7;
export const CONTROL_PAGE_IDS = Object.keys(CONTROL_SECTIONS);
export const CONTROL_PANEL_DEFAULT = Object.freeze({width:304,height:460});
export const CONTROL_PANEL_LIMITS = Object.freeze({minWidth:230,maxWidth:420,minHeight:300,maxHeight:620});

export function controlPanelSize(value) {
  const {minWidth,maxWidth,minHeight,maxHeight} = CONTROL_PANEL_LIMITS;
  const dimension = (n, fallback, min, max) => Number.isFinite(n) ? Math.round(Math.min(max,Math.max(min,n))) : fallback;
  return {
    width: dimension(value?.width,CONTROL_PANEL_DEFAULT.width,minWidth,maxWidth),
    height: dimension(value?.height,CONTROL_PANEL_DEFAULT.height,minHeight,maxHeight),
  };
}

export function defaultControlLayout() {
  return {
    pages: {
      home: ['chat', 'voice', 'size', 'sound'],
      apps: ['actions', 'dress', 'interaction'],
      scene: ['scenes', 'theme', 'roam'],
      window: ['workbench', 'through', 'hide', 'close'],
    },
    rail: ['chat', 'voice', 'menu'],
    hoverVisible: true,
    panelSize: controlPanelSize(),
  };
}

export function allowsControl(id, target) {
  if (typeof id !== 'string' || !Object.hasOwn(CONTROL_COMPONENTS, id)) return false;
  const spec = CONTROL_COMPONENTS[id];
  return target === 'rail' ? spec.rail === true : CONTROL_PAGE_IDS.includes(target) && !spec.railOnly;
}

export function readControlLayout(pages, rail, hoverVisible, panelSize) {
  const defaults = defaultControlLayout();
  const used = new Set();
  const sections = Object.fromEntries(CONTROL_PAGE_IDS.map(id => {
    const saved = Array.isArray(pages?.[id]) ? pages[id] : defaults.pages[id];
    return [id, saved.filter(item => {
      if (!allowsControl(item, id) || used.has(item)) return false;
      used.add(item);
      return true;
    })];
  }));
  const savedRail = typeof rail === 'string' ? rail.split(',').map(item => item.trim()) : defaults.rail;
  if (!pages && typeof rail === 'string') savedRail.push('menu');
  return {
    pages: sections,
    rail: [...new Set(savedRail.filter(id => allowsControl(id, 'rail')))].slice(0, CONTROL_RAIL_LIMIT),
    hoverVisible: hoverVisible !== false,
    panelSize: controlPanelSize(panelSize),
  };
}

export function validateControlLayout(input, panelSize) {
  if (!input || typeof input !== 'object' || !input.pages || typeof input.hoverVisible !== 'boolean'
    || !Array.isArray(input.rail) || !CONTROL_PAGE_IDS.every(id => Array.isArray(input.pages[id]))) {
    throw Error('操作台布局格式无效 / Invalid control layout');
  }
  if (input.panelSize !== undefined && (!Number.isFinite(input.panelSize?.width) || !Number.isFinite(input.panelSize?.height))) {
    throw Error('操作台尺寸无效 / Invalid control panel size');
  }
  const normalized = readControlLayout(input.pages, input.rail.join(','), input.hoverVisible, input.panelSize ?? panelSize);
  if (normalized.rail.length !== input.rail.length || normalized.rail.some((id, index) => id !== input.rail[index])
    || CONTROL_PAGE_IDS.some(id => normalized.pages[id].length !== input.pages[id].length)) {
    throw Error('布局含有重复、无效或过多的组件 / The layout contains duplicate, invalid, or excess components');
  }
  return normalized;
}

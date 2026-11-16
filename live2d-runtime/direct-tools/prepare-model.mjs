#!/usr/bin/env node
/** Internal model-data preparation, adapted from cortico-world-figure 3.0.0.
 * AGPL-3.0-or-later; source models are read-only. Writes model/profile/texture data
 * to --out only. Does not emit a Coo manifest, runtime, Core, or installable pack.
 */
import { readBongoPackage } from '../tools/bongo-package.mjs';
import { inferRoles } from './parameter-mapping.mjs';
import { inspectModelAdaptation } from './model-adaptation.mjs';
import { insidePath } from './model-source.mjs';
import { createModelAssetResolver, readOptionalModelMetadata } from './model-metadata.mjs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf('--' + n); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d; };
const flag = (n) => ARGS.includes('--' + n);

// ---------------------------------------------------------------- 参数
const MODEL_DIR = arg('model');
if (!MODEL_DIR || !existsSync(MODEL_DIR)) {
  console.error('用法: node tools/prepare-model.mjs --model "<模型目录>" [--model-file <入口>] [--out build/<id>] [--id <id>] [--max-texture 0] [--force] [--dry-run] [--json] [--overrides <json>]');
  process.exit(2);
}
const DRY = flag('dry-run');
const JSON_OUT = flag('json');
const FORCE = flag('force');
const OVERRIDES_PATH = arg('overrides');
const SOURCE_DIGEST = arg('source-digest');
if (SOURCE_DIGEST && !/^[a-f0-9]{64}$/.test(SOURCE_DIGEST)) throw Error('源素材摘要无效');
/**
 * 贴图最长边上限（0 = 不缩）。
 * 桌宠在屏幕上只有 ~180–260 px 高，8192² RGBA 在显存里是 256 MB/张，纯浪费：
 * 6 张就是 1.5 GB，还会拖慢首帧。2048² 仍有 8~10 倍过采样，肉眼无损。
 */
const MAX_TEX = Math.max(0, Number(arg('max-texture', 2048)) || 0);
const CLEAN = flag('clean');
/** 生成器配方版本：写进 build.json；工作台用它判断包是否过期 */
const GENERATOR_VERSION = 'rt-2026-11-01.quality.2';
/** 简易模式：原生表情和动作由独立资源目录管理。 */
const SIMPLE = true;

const readJson = async (p) => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const rows = (value) => Array.isArray(value) ? value.filter(item=>item&&typeof item==='object') : [];
/** 读 PNG 头拿尺寸（只读 24 字节，不解码整图）。非 PNG 返回 null。 */
const pngSize = (file) => {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) !== 24 || head[0] !== 0x89 || head[1] !== 0x50) return null;
    if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

function distinctResourceStem(label, path, used) {
  const stem=slug(label);
  const signature=createHash('sha256').update(relative(modelDir,path).replaceAll('\\','/')).digest('hex').slice(0,16);
  let key=stem&&!used.has(stem)?stem:stem?stem+'-'+signature:signature;
  while(used.has(key))key+='-';
  used.add(key);
  return key;
}

// ---------------------------------------------------------------- 找模型文件
async function findModel3(dir) {
  const direct = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'))
    .map((e) => join(dir, e.name));
  if (direct.length) return direct[0];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = await findModel3(join(dir, e.name));
    if (sub) return sub;
  }
  return null;
}

const explicitModel = arg('model-file');
if (explicitModel && (basename(explicitModel) !== explicitModel || !explicitModel.toLowerCase().endsWith('.model3.json'))) throw new Error('模型入口必须是所选目录内的 .model3.json 文件');
const model3Path = explicitModel ? join(MODEL_DIR, explicitModel) : await findModel3(MODEL_DIR);
if (!model3Path) {
  console.error('没找到 *.model3.json：', MODEL_DIR);
  process.exit(1);
}
const modelDir = realpathSync(dirname(model3Path));
if (!lstatSync(model3Path).isFile() || !insidePath(modelDir,realpathSync(model3Path))) throw Error('模型入口必须在所选素材目录内');
const model3 = await readJson(model3Path);
const ref = model3.FileReferences ?? {};
const files = ref.FileReferences ?? ref;   // VTS 有时多包一层

// 纯中文目录名 slug 后为空：给个短的稳定后缀，免得所有中文模型都装成同一个 "model"
const _rawName = basename(modelDir).replace(/_vts$/i, '');
const _explicitId = arg('id');
const id = (_explicitId ? slug(_explicitId) : '')
  || slug(_rawName)
  || `model-${createHash('sha1').update(_rawName).digest('hex').slice(0, 6)}`;
// Coo 的 axis option id 不能带连字符（scheme 用 '-' 拼多轴），模型/包 id 可以
const optionId = id.replace(/-/g, '').slice(0, 24);
const OUT = resolve(arg('out', join(HERE, '..', 'build', id)));

// ---------------------------------------------------------------- 模型资产
const resolveAsset = createModelAssetResolver(modelDir);

const mocName = files.Moc ?? files.MocFile;
const mocPath = mocName && resolveAsset(mocName);
if (!mocPath) {
  console.error('没找到 moc3（model3.json 的 FileReferences.Moc）：', mocName);
  process.exit(1);
}
const mocBytes = await readFile(mocPath);
if (mocBytes.length < 64 || mocBytes.toString('ascii', 0, 4) !== 'MOC3') throw new Error('模型的 moc3 文件无效或不完整，请重新获取完整素材');

const textureRefs = Array.isArray(files.Textures) ? files.Textures : [];
const textures = textureRefs.map(t => resolveAsset(t));
if (!textures.length || textures.some(p => !p)) throw new Error('模型缺少贴图文件，请导入包含全部配套资源的完整文件夹');

const {physics, physicsPath, pose, posePath, display, cdiPath, vts, mappingWarnings} =
  await readOptionalModelMetadata({modelDir, model3Path, files, mocPath, resolveAsset});
const parameters = rows(display.Parameters).filter(p=>typeof p.Id==='string');
const params = parameters.map(p=>p.Id);
const bongo = await readBongoPackage(modelDir, params, files.Motions, resolveAsset, pngSize);
const groups = new Map(rows(display.ParameterGroups).map((g) => [g.Id, g.Name ?? g.Id]));
const paramMeta = new Map(parameters.map((p) => [
  p.Id,
  { label: p.Name ?? p.Id, group: groups.get(p.GroupId) ?? '' },
]));

const CLEAN_KEYS = ['水印', 'watermark', '版权', '须知', '说明', 'readme', '署名', '公告', 'logo'];
const isCleanKey = (text) => {
  const t = String(text ?? '').toLowerCase();
  return CLEAN_KEYS.some((k) => t.includes(k));
};
const cleanParts = {};
const cleanParams = {};
if (CLEAN) {
  // 1) 部件名命中 → 不透明度 0
  for (const p of rows(display.Parts)) {
    if (p?.Id && isCleanKey(p.Name)) cleanParts[p.Id] = 0;
  }
  // 2) 表情 / 热键命中 → 读作者设好的参数值
  for (const e of await collectExpressions()) {
    if (!isCleanKey(e.name) && !isCleanKey(basename(e.path))) continue;
    const raw = await readJson(e.path).catch(() => null);
    for (const p of rows(raw?.Parameters)) {
      if (typeof p?.Id === 'string' && Number.isFinite(Number(p.Value))) cleanParams[p.Id] = Number(p.Value);
    }
  }
  // 3) VTS 热键名命中 → 读它指向的 exp3
  for (const f of await readdir(modelDir).catch(() => [])) {
    if (!f.toLowerCase().endsWith('.vtube.json')) continue;
    const configPath = resolveAsset(f);
    if (!configPath) continue;
    const vd = await readJson(configPath).catch(() => null);
    for (const hk of rows(vd?.Hotkeys)) {
      if (!isCleanKey(hk?.Name)) continue;
      const file = hk.File ? resolveAsset(hk.File) : null;
      if (!file) continue;
      const raw = await readJson(file).catch(() => null);
      for (const p of rows(raw?.Parameters)) {
        if (typeof p?.Id === 'string' && Number.isFinite(Number(p.Value))) cleanParams[p.Id] = Number(p.Value);
      }
    }
  }
}

// ---------------------------------------------------------------- 动作
async function collectMotions() {
  const out = [];
  const seen = new Set();
  const push = (path, group, item = {}) => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, group, loop: item.Loop ?? true, fadeIn: item.FadeInTime, fadeOut: item.FadeOutTime });
  };
  // 1) model3 里声明的动作组
  for (const [group, list] of Object.entries(files.Motions ?? {})) {
    if(!Array.isArray(list))continue;
    for (const item of list) {
      const p = resolveAsset(item?.File);
      if (p) push(p, group, item);
    }
  }
  // 2) VTS 常见：animations/*.motion3.json
  for (const sub of ['animations', 'motions', 'motion']) {
    const dir = join(modelDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.toLowerCase().endsWith('.motion3.json')) continue;
      const asset=resolveAsset(sub+'/'+f);
      if(asset)push(asset, sub);
    }
  }
  // 3) 直接放在模型根目录的（witchX8 这类导出）
  for (const f of await readdir(modelDir)) {
    if (!f.toLowerCase().endsWith('.motion3.json')) continue;
    const asset=resolveAsset(f);
    if(asset)push(asset, 'root');
  }
  return out;
}

/** 动作里的 Parameter 曲线 id（= 这条动作会独占哪些参数）。 */
const ownsOf = (json) => [...new Set(rows(json?.Curves)
  .filter((c) => c.Target === 'Parameter' && c.Id)
  .map((c) => c.Id))];

/* ---- 资源语义分类（照 Coo 工作台的做法，先看参数/中文名，再看 cdi3 分组） ---- */
const FACE_PARAM_RX = /Eye|Mouth|Brow|Cheek|Tear|Sweat|Blush|Face|Nose|Lip|Tongue/i;
const FACE_TEXT_RX = /眼|瞳|眸|嘴|口|唇|眉|脸|颊|泪|汗|红|晕|心|星|笑|哭|怒|悲|羞|惊|困|眨|闭|舌|牙|表情|情绪/;
const POSE_PARAM_RX = /Hand|Arm|Wrist|Finger|Leg|Foot|Shoulder|Hip|BodyAngle|Rotation/i;
const POSE_TEXT_RX = /手|臂|腕|指|腿|脚|肩|腰|身|姿|抱|拳|剪|挥|伸|抬|坐|站|跳/;
const OUTFIT_PARAM_RX = /Cloth|Dress|Skirt|Shirt|Sleeve|Shoe|Hat|Wing|Tail|Weapon|Accessor/i;
const OUTFIT_TEXT_RX = /衣|裙|袖|鞋|袜|帽|饰|武器|翅膀|尾|耳|机甲|装备|背包|披风|穿脱|服装/;

function classifyResource({ name, label, group, params: list }) {
  const ids = (list ?? []).map((p) => p.id).join(' ');
  const text = `${label ?? ''} ${(list ?? []).map((p) => p.label ?? '').join(' ')}`;
  const romaji = String(name ?? '');
  if (POSE_PARAM_RX.test(ids) || POSE_TEXT_RX.test(text) || /jiantou|shou|tui|jiao|shen|bao/i.test(romaji)) {
    return { cls: 'pose', why: '参数 / 名字指向手、臂或身体' };
  }
  if (FACE_PARAM_RX.test(ids) || FACE_TEXT_RX.test(text) || /eye|yan|zui|lei|han|lian|xie|yun|xing|aixin|kongbai|yuanquan|biaoqing|happy|sad|angry|cry|smile|love|shock|surprise|emotion/i.test(romaji)) {
    return { cls: 'face', why: '参数 / 名字指向五官或情绪' };
  }
  if (/表情|嘴巴|眼|脸|情绪/.test(group ?? '')) return { cls: 'face', why: 'cdi3 分组是表情类' };
  if (/动作|姿势/.test(group ?? '')) return { cls: 'pose', why: 'cdi3 分组是动作类' };
  if (OUTFIT_PARAM_RX.test(ids) || OUTFIT_TEXT_RX.test(text) || /隐藏|穿脱|服装|部件/.test(group ?? '')) {
    return { cls: 'outfit', why: '看起来是服装 / 部件开关' };
  }
  return { cls: 'other', why: '没找到明确语义；仍可手动归类' };
}

/** 原生表情文件（exp3）：model3 声明的 + VTS 常见的 expressions/ 目录。 */
async function collectExpressions() {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(files.Expressions)?files.Expressions:[]) {
    const p = resolveAsset(item?.File);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, name: item.Name ?? basename(p).replace(/\.exp3\.json$/i, '') });
  }
  for (const sub of ['expressions', 'expression']) {
    const dir = join(modelDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.toLowerCase().endsWith('.exp3.json')) continue;
      const p = resolveAsset(sub+'/'+f);
      if (!p||seen.has(p)) continue;
      seen.add(p);
      out.push({ path: p, name: basename(f).replace(/\.exp3\.json$/i, '') });
    }
  }
  // 直接放在模型根目录的 exp3（witchX8 这类导出）
  for (const f of await readdir(modelDir)) {
    if (!f.toLowerCase().endsWith('.exp3.json')) continue;
    const p = resolveAsset(f);
    if (!p||seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, name: basename(f).replace(/\.exp3\.json$/i, '') });
  }
  return out;
}

/**
 * 部件不透明度目标：SDK 不认 PartOpacity 曲线（按参数查索引），必须在运行时自己写。
 * 取曲线数组里最后一个数值——动作末尾的稳态值。
 */
function partTargetsOf(json) {
  const out = Object.create(null);
  for (const c of rows(json?.Curves)) {
    if (c.Target !== 'PartOpacity' || !c.Id) continue;
    const nums = Array.isArray(c.Segments) ? c.Segments.filter(Number.isFinite) : [];
    if (nums.length) out[c.Id] = Math.round(nums[nums.length - 1] * 1000) / 1000;
  }
  return out;
}

// ---------------------------------------------------------------- role 探测
const { roles, unmapped, diagnostics: mappingDiagnostics } = inferRoles(display, physics, vts, model3.Groups);

/** 没映射上的「值得看一眼」的参数，写进 profile.js 的 TODO 注释。 */
const mapped = new Set(Object.values(roles).flatMap((r) => r.targets));
const interesting = params
  .filter((p) => !mapped.has(p) && !/^Param_Angle_Rotation_/.test(p) && /Eye|Brow|Mouth|Arm|Hand|Step|Leg|Cheek/i.test(p))
  .slice(0, 24);

// ---------------------------------------------------------------- 表情配方
// 与 hiyori 相同的语义配方；缺的 role 自动跳过（模型少参数不用改配方）。
const RECIPES = {
  neutral: {},
  happy: { eyeSmile: 1, browY: 0.35, mouthForm: 0.8, cheek: 0.55 },
  wink: { eyeSmile: 0.7, browY: 0.2, mouthForm: 0.4, cheek: 0.25 },
  love: { eyeSmile: 1, browY: 0.3, mouthForm: 0.6, cheek: 0.95 },
  shy: { eyeSmile: 0.35, browY: 0.45, mouthForm: 0.1, cheek: 1 },
  surprised: { browY: 0.8, browAngle: 1, mouthOpen: 0.45, mouthForm: 0.25, cheek: 0.15 },
  angry: { browY: -0.75, browAngle: -1, mouthForm: -0.6, cheek: 0.3 },
  sad: { browY: 0.5, browAngle: -0.4, mouthForm: -0.7, cheek: 0.2 },
  sleepy: { eyeOpen: 0.45, eyeSmile: 0.15, browY: 0.1, mouthForm: 0.05, cheek: 0.2 },
  thinking: { eyeSmile: 0.1, browY: -0.2, mouthForm: -0.15, cheek: 0.1 },
  smug: { eyeSmile: 0.6, browY: -0.25, mouthForm: 0.35, cheek: 0.3 },
  pout: { browY: 0.3, mouthForm: -0.45, cheek: 0.8 },
  worried: { browY: 0.55, browAngle: -0.5, mouthForm: -0.35, cheek: 0.25 },
  determined: { browY: -0.5, browAngle: 0.6, mouthForm: -0.1, cheek: 0.15 },
  flustered: { eyeSmile: 0.2, browY: 0.7, mouthForm: 0.1, cheek: 1 },
  scared: { browY: 0.75, browAngle: 1, mouthOpen: 0.3, mouthForm: -0.5, cheek: 0.2 },
  excited: { eyeSmile: 1, browY: 0.5, mouthForm: 0.6, cheek: 0.6 },
  cry: { browY: 0.6, browAngle: -0.6, mouthForm: -0.75, cheek: 0.5 },
  confused: { eyeSmile: 0.1, browY: 0.25, browAngle: 0.3, mouthForm: -0.2, cheek: 0.15 },
};

const usable = (recipe) => {
  const keys = Object.keys(recipe).filter((k) => roles[k]);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, recipe[k]])) : null;
};
const expressions = {};
for (const [name, recipe] of Object.entries(RECIPES)) {
  const r = usable(recipe);
  if (r) expressions[name] = r;
}

// ---------------------------------------------------------------- 写包
const motions = [],motionStems=new Set();
for (const m of await collectMotions()) {
  let json;
  try { json = await readJson(m.path); }
  catch (e) {
    // 简易模式只借 PartOpacity 做中性部件基线；坏的动作文件不该阻断构建。
    console.warn(`跳过读不出的动作 ${basename(m.path)}：${e.message}`);
    continue;
  }
  if (!Array.isArray(json?.Curves)) continue;
  const title = basename(m.path).replace(/\.motion3\.json$/i, '');
  const stem = distinctResourceStem(title,m.path,motionStems);
  const mid = `m-${stem}`;
  motions.push({
    id: mid,
    stem,
    title,
    group: m.group,
    file: `motions/${stem}.js`,
    source: m.path,
    seconds: Math.round(Number(json.Meta?.Duration ?? 0) * 1000) / 1000,
    loop: json.Meta?.Loop ?? m.loop ?? true,
    partOpacity: partTargetsOf(json),
    owns: ownsOf(json),
    raw: json,
  });
}

const idleMotions = motions.filter((m) => /idle/i.test(String(m.group ?? '')));
const expressionFiles = [],expressionStems=new Set();
if (!SIMPLE) {
  for (const e of await collectExpressions()) {
    const raw = await readJson(e.path).catch(()=>null);
    if(!Array.isArray(raw?.Parameters))continue;
    const stem = distinctResourceStem(e.name || basename(e.path).replace(/\.exp3\.json$/i, ''),e.path,expressionStems);
    const list = raw.Parameters
      .filter((p) => typeof p?.Id === 'string' && Number.isFinite(Number(p.Value)))
      .map((p) => ({
        id: p.Id,
        value: Number(p.Value),
        blend: p.Blend,
        label: paramMeta.get(p.Id)?.label ?? '',
      }));
    const main = list.find((p) => paramMeta.has(p.id));
    const rawLabel = main ? paramMeta.get(main.id).label : '';
    const label = rawLabel && rawLabel !== e.name ? `${e.name} · ${rawLabel}` : e.name;
    const group = main ? paramMeta.get(main.id).group : '';
    const auto = classifyResource({ name: e.name, label: rawLabel, group, params: list });
    expressionFiles.push({
      id: `exp-${stem}`, name: e.name, stem, file: `expressions/${stem}.js`, raw,
      params: list, label, group, cls: auto.cls, autoCls: auto.cls, why: auto.why,
    });
  }
}

// 原生 exp3 表情：名字正好是 happy/sad… 才自动映射；也接受 eyescry / signangry 这种包含词根的命名
const nativeExpressions = {};
const words = Object.keys(RECIPES);
const ALIAS = { shock: 'surprised', startle: 'surprised', surprise: 'surprised', eyeclose: 'cry', tears: 'cry' };
for (const e of expressionFiles) {
  const key = String(e.name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  let word = words.find((w) => w === key || w.replace(/-/g, '') === key);
  if (!word) word = words.find((w) => w.length >= 3 && key.includes(w));
  if (!word) word = Object.entries(ALIAS).find(([k]) => key.includes(k))?.[1];
  if (word && !nativeExpressions[word]) nativeExpressions[word] = e.id;
}

const overrides = OVERRIDES_PATH ? await readJson(OVERRIDES_PATH) : {};
const {privateEmotionMap,report:adaptation} = inspectModelAdaptation({
  metadata:display, physics, roles, diagnostics:mappingDiagnostics, cleanParams,
  resources:overrides.native?.resources ?? [],
});
const nativeMap = SIMPLE ? {} : { ...nativeExpressions, ...(overrides.expressions ?? {}) };
const performance = {
  ...(overrides.performance ?? {}),
  tuning: {
    style: 'natural',
    bodyGain: 1.8,
    gain: 1.15,
    accentGain: 0.75,
    ...(overrides.performance?.tuning ?? {}),
  },
};

/* ---- 名片 / 运动：工作台传进来的构建参数 ---- */
const title = model3.Meta?.Name || basename(modelDir) || id;
const pickText = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const expressionCount = Object.keys(expressions).length;
const identity = {
  nameZh: pickText(overrides.identity?.nameZh, title),
  nameEn: pickText(overrides.identity?.nameEn, pickText(overrides.identity?.nameZh, title)),
  aboutZh: pickText(overrides.identity?.aboutZh, `一个正面立绘的 Live2D 形象，支持 ${expressionCount} 种底脸表情。`),
  aboutEn: pickText(overrides.identity?.aboutEn, `A front-facing Live2D figure with ${expressionCount} base expressions.`),
  author: pickText(overrides.identity?.author, ''),
  version: pickText(overrides.identity?.version, '1.0.0'),
  credit: pickText(overrides.identity?.credit, ''),
};
// roam = 跟随 Coo 的走动偏好；stand = 固定站定（后端强制 roam off）
const motionSpeed = Math.min(2, Math.max(.5, Number(overrides.motion?.speed) || 1));
const motion = { kind: bongo || overrides.motion?.kind === 'stand' ? 'stand' : 'roam', speed: motionSpeed };

/* ---- 资源池：exp3 + 动作，带自动分类和手动覆盖 ---- */
const resources = [
  ...expressionFiles.map((e) => ({
    id: `exp3:${e.file}`, kind: 'exp3', file: e.file, name: e.name,
    label: e.label, group: e.group, params: e.params.length,
    cls: e.cls, autoCls: e.autoCls, why: e.why, custom: false,
  })),
  ...motions.map((m) => ({
    id: `motion:${m.file}`, kind: 'motion', file: m.file, name: m.title,
    label: m.title, group: m.group, seconds: m.seconds,
    cls: 'pose', autoCls: 'pose', why: '动作文件', custom: false,
  })),
];
for (const r of resources) {
  const role = overrides.resourceRoles?.[r.file];
  if (role && ['face', 'pose', 'outfit', 'other'].includes(role)) {
    r.cls = role; r.custom = true; r.why = '你手动改了归类';
  }
}

/* ---- 源指纹：只看模型内容，**不含**生成器版本 ----
 * 混进 GENERATOR_VERSION 会让升级转换器把所有手工校准（role 归类 / 取景 / 绑词）一起作废；
 * 生成器版本由 signatureOf() 单独参与过期判断。 */
let sourceHash=SOURCE_DIGEST;
if(!sourceHash){
 const sha=(buf)=>createHash('sha1').update(buf).digest('hex');
 const hashParts=[`model3:${sha(JSON.stringify(model3))}`,`moc3:${sha(mocBytes)}`];
 if(physicsPath)hashParts.push(`physics:${sha(JSON.stringify(physics))}`);
 if(vts)hashParts.push(`vts:${sha(JSON.stringify(vts.ParameterSettings??[]))}`);
 if(cdiPath)hashParts.push(`cdi3:${sha(JSON.stringify(display))}`);
 if(posePath)hashParts.push(`pose:${sha(JSON.stringify(pose))}`);
 for(const p of textures)hashParts.push(`tex:${basename(p)}:${sha(await readFile(p))}`);
 if(!SIMPLE)for(const e of expressionFiles)hashParts.push(`exp3:${e.file}:${sha(JSON.stringify(e.raw))}`);
 if(!SIMPLE)for(const m of motions)hashParts.push(`motion:${m.file}:${sha(JSON.stringify(m.raw))}`);
 sourceHash=sha(hashParts.join('\n'));
}


const plan = {
  id,
  optionId,
  title,
  identity,
  motion,
  modelDir,
  model3Path,
  mocPath,
  physicsPath,
  posePath,
  cdiPath,
  fit: overrides.fit ?? { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1 },
  textures: textures.map((p) => basename(p)),
  /** 源贴图尺寸 + 缩小后的尺寸（构建后显存估算用） */
  textureSizes: textures.map((p) => {
    const s = pngSize(p);
    if (!s) return null;
    const longest = Math.max(s.w, s.h);
    const k = MAX_TEX > 0 && longest > MAX_TEX ? MAX_TEX / longest : 1;
    return { w: s.w, h: s.h, outW: Math.max(1, Math.round(s.w * k)), outH: Math.max(1, Math.round(s.h * k)) };
  }).filter(Boolean),
  maxTexture: MAX_TEX,
  params: params.length,
  paramsList: params,
  roles: Object.keys(roles),
  roleTable: roles,
  mappingDiagnostics,
  mappingWarnings,
  adaptation,
  unmapped,
  expressions: Object.keys(expressions),
  recipes: expressions,
  expressionFiles: expressionFiles.map((e) => ({ id: e.id, name: e.name, file: e.file, label: e.label })),
  nativeExpressions: nativeMap,
  resources,
  generatorVersion: GENERATOR_VERSION,
  sourceHash,
  idle: idleMotions.length,
  idleIds: idleMotions.map((m) => m.id),
  pose: Boolean(posePath),
  motions: motions.map((m) => ({ id: m.id, group: m.group, seconds: m.seconds, loop: m.loop, file: m.file })),
  overrides,
  out: OUT,
};
// 简易模式：扫描结果里不暴露原生资源，避免 UI 误以为可以绑定
if (SIMPLE) {
  plan.expressionFiles = [];
  plan.nativeExpressions = {};
  plan.resources = [];
  plan.idle = 0;
  plan.idleIds = [];
  plan.motions = [];
}

if (DRY || JSON_OUT) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (existsSync(OUT)) {
  const entries = await readdir(OUT);
  if (entries.length && !FORCE) {
    console.error(`输出目录已存在且非空：${OUT}\n换一个 --out，或加 --force 覆盖。`);
    process.exit(1);
  }
}
if (!SIMPLE) await mkdir(join(OUT, 'models', id, 'motions'), { recursive: true });
await mkdir(join(OUT, 'models', id, 'textures'), { recursive: true });

// 1) moc3 原始文件（供 Coopanion 0.2.14+ 原生 fetch） + base64 模块（旧版本回退）
await writeFile(join(OUT, 'models', id, 'model.moc3'), mocBytes);
await writeFile(
  join(OUT, 'models', id, 'moc3.js'),
  `export default "${mocBytes.toString('base64')}";\n`,
  'utf8',
);

// 2) model3 / physics / cdi3 → JS 模块
await writeFile(join(OUT, 'models', id, 'model3.js'),
  `export default ${JSON.stringify(model3)};\n`, 'utf8');
if (physicsPath) {
  await writeFile(join(OUT, 'models', id, 'physics.js'),
    `export default ${JSON.stringify(physics)};\n`, 'utf8');
}
if (cdiPath) {
  await writeFile(join(OUT, 'models', id, 'cdi3.js'),
    `export default ${JSON.stringify(display)};\n`, 'utf8');
}
if (posePath) {
  await writeFile(join(OUT, 'models', id, 'pose.js'),
    `export default ${JSON.stringify(pose)};\n`, 'utf8');
}
if (!SIMPLE && expressionFiles.length) {
  await mkdir(join(OUT, 'models', id, 'expressions'), { recursive: true });
  for (const e of expressionFiles) {
    await writeFile(join(OUT, 'models', id, e.file),
      `export default ${JSON.stringify(e.raw)};\n`, 'utf8');
  }
}

// 3) 贴图（平铺到 textures/）
const textureFiles = [];
for (const [i, p] of textures.entries()) {
  const name = `texture_${String(i).padStart(2, '0')}${extname(p).toLowerCase() || '.png'}`;
  await copyFile(p, join(OUT, 'models', id, 'textures', name));
  textureFiles.push(`textures/${name}`);
}

for (const { source, file } of bongo?.files ?? []) {
  const destination = join(OUT, 'models', id, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

// 3.5) 贴图降采样：只动 OUT 里的副本，源模型一个字节都不改。
// 没有 Pillow 也不阻断构建——运行时会兜底（backends/live2d.js 里超过 maxTex 再缩）。
let textureShrink = null;
if (MAX_TEX > 0 && textureFiles.some((f) => f.toLowerCase().endsWith('.png'))) {
  const texDir = join(OUT, 'models', id, 'textures');
  const script = join(HERE, 'shrink-textures.py');
  const r = spawnSync('python', [script, '--dir', texDir, '--max', String(MAX_TEX), '--json'], {
    encoding: 'utf8',
    timeout: 180000,
  });
  if (r.status === 0 && r.stdout) {
    try { textureShrink = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { textureShrink = null; }
    if (textureShrink?.files?.length) {
      console.log(`  贴图降采样：${textureShrink.files.length} 张 → 最长边 ${MAX_TEX}（${fmtMB(textureShrink.bytesBefore)} → ${fmtMB(textureShrink.bytesAfter)}）`);
    } else if (textureShrink) {
      console.log(`  贴图：都在 ${MAX_TEX} 以内，未改动`);
    }
  } else {
    const why = String(r.stderr || r.error?.message || 'python 不可用').trim().split('\n').pop();
    console.warn(`  贴图降采样失败，保留原尺寸：${why}`);
    textureShrink = { ok: false, error: why.slice(0, 200) };
  }
}

// 4) 动作
for (const m of (SIMPLE ? [] : motions)) {
  await writeFile(
    join(OUT, 'models', id, 'motions', `${m.stem}.js`),
    `// ${m.stem}.motion3.json（${m.seconds}s）base64\nexport default "${Buffer.from(JSON.stringify(m.raw)).toString('base64')}";\n`,
    'utf8',
  );
}

// 5) profile.js（草稿 + TODO）
const todo = [...mappingWarnings];
for (const d of mappingDiagnostics) if (d.kind === 'physics-output') todo.push(`${d.role}: ${d.target} 由物理计算控制，保留原映射，未猜测独立入口`);
for (const d of mappingDiagnostics) if (d.kind === 'unverified-control') todo.push(`${d.role}: ${d.targets.join(', ')} 未确认连续语义，自动省略，保留其他通用表情通道`);
if (unmapped.length) todo.push(`没映射上的 role：${unmapped.join(', ')}`);
if (interesting.length) todo.push(`值得看一眼的参数：${interesting.join(', ')}`);
if (!textures.length) todo.push('没有找到贴图（model3.json 的 FileReferences.Textures）');
if (!physicsPath) todo.push('这个模型没有 physics（物理通道会自动跳过）');
if (!SIMPLE && !motions.length) todo.push('没有动作：vocab 只有表情 + kit 自带动作');
if (!SIMPLE && expressionFiles.length && !Object.keys(nativeExpressions).length) {
  todo.push(`原生表情未映射：在 profile.expressions 里把词映射到 ${expressionFiles.map((e) => e.id).join(' / ')}`);
}
if (!SIMPLE && idleMotions.length) todo.push(`原生 Idle 动作 ${idleMotions.length} 段：运行时自动循环，不用写词`);
if (posePath) todo.push('有 pose3：已随包加载，用于默认部件组过渡');
todo.push('extent 由运行时自动测量（贴图就绪后读 alpha 包围盒）');

const profileJs = `/**
 * ${id} 的模型数据（tools/convert.mjs 生成的草稿）。
 *
 * 格式与运行时约定见 README「数据驱动」一节：
 *   role = 语义位 → targets 是真实参数；模型没有的参数自动跳过
 *   space/default 是语义输入；真实范围从 moc3 读取，ranges 仅用于已确认输入的校准
 *
 * 自动适配记录（供调试查阅）：
${todo.length ? todo.map((t) => ` *   - ${t.replaceAll('*/','* /').replace(/[\r\n\u2028\u2029]/gu,' ')}`).join('\n') : ' *   - 无'}
 */
export default {
${overrides.fit ? `  fit: ${JSON.stringify(overrides.fit)},` : "  fit: { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1 },"}
  // roam：跟随 Coo 的走动偏好；stand：固定站定（后端强制 roam off）
  motion: ${JSON.stringify(motion)},
${bongo ? `  bongo: ${JSON.stringify(bongo.profile)},` : ''}
  render: ${JSON.stringify(overrides.render ?? {mode:'original',textureLimit:MAX_TEX,canvasLimit:0,strict:true})},
${overrides.extent ? `  extent: ${JSON.stringify(overrides.extent)},` : ''}
${overrides.anchors ? `  anchors: ${JSON.stringify(overrides.anchors)},` : ''}
  // 简易模式不播 motion，但 motion 里的 PartOpacity 是“中性姿势”的一部分：
  // 少了它，hiyori 这类模型会同时显示 PartArmA / PartArmB（四只手）。
  parts: { base: ${JSON.stringify(guessBaseParts(motions))} },
${Object.keys(cleanParts).length || Object.keys(cleanParams).length
    ? `  clean: { parts: ${JSON.stringify(cleanParts)}, params: ${JSON.stringify(cleanParams)} },\n`
    : ''}  roles: {
${Object.entries(roles).map(([n, r]) => `    ${JSON.stringify(n)}: ${JSON.stringify(r)},`).join('\n')}
  },
  expression: {
${Object.entries(expressions).map(([n, r]) => `    ${JSON.stringify(n)}: ${JSON.stringify(r)},`).join('\n')}
  },
${!SIMPLE && Object.keys(nativeMap).length
    ? `  // 原生 exp3 表情：词 → expressions/ 里的文件 id\n  expressions: ${JSON.stringify(nativeMap, null, 2)},\n`
    : ''}  // 表演层（SoulLink）：情绪词 → 连续参数。不写就用通用默认；
  // 换模型先调这里（强度/过渡），不要改 backends/ 里的渲染代码。
  performance: ${JSON.stringify(performance, null, 2)},
  privateEmotionMap: ${JSON.stringify(privateEmotionMap)},
${[1,2].includes(overrides.native?.version) ? `  native: ${JSON.stringify(overrides.native)},` : ''}
};
`;
await writeFile(join(OUT, 'models', id, 'profile.js'), profileJs, 'utf8');

/** 常驻部件基线：动作里出现过几次就用出现最多的那套（全 0/1 时取动作末尾值）。 */
function guessBaseParts(list) {
  const tally = Object.create(null);
  for (const m of list) {
    for (const [part, v] of Object.entries(m.partOpacity ?? {})) {
      tally[part] ??= { 0: 0, 1: 0 };
      tally[part][v >= 0.5 ? 1 : 0] += 1;
    }
  }
  const out = Object.create(null);
  for (const [part, t] of Object.entries(tally)) out[part] = t[1] >= t[0] ? 1 : 0;
  return out;
}

// 6) models/index.js
const registry = {
  [optionId]: {
    id,
    model: 'model3.js',
    moc: 'model.moc3',
    mocFallback: 'moc3.js',
    adaptation,
    ...(cdiPath ? { cdi: 'cdi3.js' } : {}),
    ...(physicsPath ? { physics: 'physics.js' } : {}),
    ...(posePath ? { pose: 'pose.js' } : {}),
    ...(!SIMPLE && idleMotions.length
      ? { idle: idleMotions.map((m) => ({ id: m.id, file: m.file, duration: m.seconds })) }
      : {}),
    ...(!SIMPLE && expressionFiles.length
      ? { expressions: expressionFiles.map((e) => ({ id: e.id, name: e.name, file: e.file })) }
      : {}),
    textures: textureFiles,
    motions: SIMPLE ? [] : motions.map(({ id: mid, file, seconds, loop, partOpacity }) => ({ id: mid, file, duration: seconds, loop, partOpacity })),
  },
};
await writeFile(join(OUT, 'models', 'index.js'),
  `// 由 tools/convert.mjs 生成；换模型只改这里和 models/<id>/profile.js\nexport const models = ${JSON.stringify(registry, null, 2)};\n`,
  'utf8');


await writeFile(join(OUT,"model-data.json"),JSON.stringify({id,title,sourceHash,entry:Object.values(registry)[0],expressions:Object.keys(expressions),walk:motion.kind==='roam'},null,2));

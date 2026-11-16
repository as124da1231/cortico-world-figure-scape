import { ROLE_RULES } from './parameter-roles.js';

// Conservative adaptation of SoulLink profile-generator's private emotion
// vocabulary. Labels propose candidates, and Core must verify binary endpoints.
const effects = [
  ['heartEyes', 'positiveEye', ['爱心眼','心形眼','heart eye','heart eyes','love eyes'], ['affectionate'], 90, 'face-effect'],
  ['starEyes', 'positiveEye', ['星星眼','星星眼睛','star eye','star eyes','sparkle eyes'], ['excited'], 85, 'face-effect'],
  ['confused', 'privateEffect', ['困惑','疑惑','疑问','confused','confusion','question mark'], ['confused'], 95, 'face-effect'],
  ['anger', 'anger', ['生气','愤怒','angry','anger'], ['anger'], 90, 'face-effect'],
  ['shadow', 'shadow', ['黑脸','脸黑','脸部阴影','dark face','face shadow'], ['sad'], 70, 'face-effect'],
  ['tear', 'tear', ['流泪','眼泪','泪光眼','tear','tears','crying'], ['sad'], 85, 'face-effect'],
  ['blush', 'blush', ['脸红','腮红','blush'], ['shy','affectionate'], 80],
  ['surprise', 'surprise', ['惊讶','震惊','surprise','shock'], ['surprised'], 80, 'face-effect'],
];
export const privateEmotionRules = new Map(effects.map(([key, category, , emotions, priority, exclusiveGroup]) =>
  [key, {category, emotions, priority, ...(exclusiveGroup ? {exclusiveGroup} : {})}]));
const emotionTitles = new Map([
  ['happy', ['开心','微笑','smile','happy']],
  ['love', ['喜欢','爱心眼','love','heart eyes']],
  ['shy', ['害羞','脸红','shy','blush']],
  ['angry', ['生气','愤怒','angry','anger']],
  ['sad', ['难过','悲伤','sad']],
  ['cry', ['流泪','眼泪','哭泣','cry','crying']],
  ['surprised', ['惊讶','震惊','surprised','surprise']],
  ['thinking', ['思考','thinking']],
  ['confused', ['疑惑','困惑','confused','confusion']],
]);
const safeId = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
const label = text => typeof text === 'string' ? text.normalize('NFKC').toLowerCase()
  .replace(/^\s*(?:\d+\s*[.、:)\-]+\s*)?(?:表情\s*[-:]\s*)?/u,'').replace(/\s+/gu,' ').trim() : '';

export function inferPrivateEmotionMap(metadata, {mappedIds = new Set(), protectedIds = new Set()} = {}) {
  const byLabel = new Map();
  if (!Array.isArray(metadata?.Parameters)) return {};
  for (const parameter of metadata.Parameters) {
    if (!safeId(parameter?.Id) || mappedIds.has(parameter.Id) || protectedIds.has(parameter.Id)) continue;
    const name = label(parameter.Name).replace(/\s*(?:开关|toggle)$/u,'').trim();
    if (!name) continue;
    const ids = byLabel.get(name) ?? new Set();
    ids.add(parameter.Id);
    byLabel.set(name, ids);
  }
  const result = {};
  const claimed = new Set();
  for (const [key, category, names, emotions, priority, exclusiveGroup] of effects) {
    const ids = new Set(names.flatMap(name => [...(byLabel.get(name) ?? [])]));
    if (ids.size !== 1) continue;
    const [target] = ids;
    if (claimed.has(target)) continue;
    claimed.add(target);
    result[key] = {target, category, emotions, priority, ...(exclusiveGroup ? {exclusiveGroup} : {}),
      source:'heuristic', confidence:.92};
  }
  return result;
}

export function validatePrivateEmotionMap(candidates, coreParameters, protectedIds = new Set()) {
  const map = {}, parameters = Object.create(null);
  for (const [key, category, , emotions, priority, exclusiveGroup] of effects) {
    const target = candidates?.[key]?.target;
    if (!safeId(target) || protectedIds.has(target) || Object.hasOwn(parameters,target)) continue;
    const parameter = coreParameters.get(target);
    if (parameter?.min !== 0 || parameter.max !== 1 || ![0,1].includes(parameter.default)) continue;
    map[key] = {target,category,emotions,priority,...(exclusiveGroup ? {exclusiveGroup} : {}),
      neutralValue:parameter.default,activeValue:1-parameter.default,source:'heuristic',confidence:.92};
    parameters[target] = {...parameter};
  }
  return {map,parameters};
}

export function nativeEmotionSuggestions(resources = []) {
  const suggestions = [];
  for (const [word, names] of emotionTitles) {
    const matches = resources.filter(resource => resource?.kind === 'expression' && resource.classification === 'expression'
      && safeId(resource.id) && names.includes(label(resource.title)));
    if (matches.length === 1) {
      const [{id, title}] = matches;
      suggestions.push({word,id,title:title.slice(0,100)});
    }
  }
  return suggestions;
}

export function describeImportedAdaptation({metadata, roles, diagnostics = [], privateEmotionMap}) {
  return {
    version:1,
    hasMetadata:Array.isArray(metadata?.Parameters) && metadata.Parameters.length > 0,
    roles:ROLE_RULES.map(([name]) => {
      const targets = (roles[name]?.targets ?? []).filter(safeId);
      const evidence = diagnostics.filter(item => item.role === name).map(item => item.kind);
      return {name,targets,evidence:targets.length ? (evidence.length ? evidence : ['standard-id']) : evidence};
    }),
    privateCandidates:Object.entries(privateEmotionMap).map(([key, {target}]) => ({key,target})),
  };
}

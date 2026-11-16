import { declaredModelRoleTargets, ROLE_RULES } from './support/parameter-roles.js';

export { ROLE_RULES };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  eyeSmile: ['EyeSmile', 'EyeLSmile', 'EyeRSmile'],
  cheek: ['Cheek', 'Blush', 'ParamBlush'],
  angleX: ['AngleX'], angleY: ['AngleY'], angleZ: ['AngleZ'],
  bodyX: ['PositionX', 'BodyAngleX'],
};
const inputs = {
  angleX: ['FaceAngleX'], angleY: ['FaceAngleY'], angleZ: ['FaceAngleZ'],
  bodyX: ['FaceAngleX', 'BodyAngleX'], eyeSmile: ['MouthSmile'],
};
const labels = { cheek: /^(脸红|腮红|頬染め|赤面|blush)$/i };
const entries = (value) => Array.isArray(value) ? value.filter(item=>item&&typeof item==='object') : [];

/** Preserve working standard mappings. Reroute only through an unambiguous,
 * same-semantic, full-weight physics chain. VTS tracking axes are not generally
 * equivalent to our semantic axes (notably eyes), so never copy every mapping. */
export function inferRoles(display = {}, physics = {}, vts = {}, groups = []) {
  const parameters = entries(display?.Parameters);
  const have = new Set(parameters.map((p) => p.Id).filter((id) => typeof id === 'string'));
  const byNorm = new Map();
  for (const id of have) {
    const key = norm(id);
    byNorm.set(key, byNorm.has(key) ? null : id); // ambiguous normalized names are unsafe
  }
  const resolve = (id) => have.has(id) ? id : byNorm.get(norm(id));
  const writers = new Map();
  for (const setting of entries(physics?.PhysicsSettings)) {
    for (const out of entries(setting.Output)) {
      if (out.Destination?.Target !== 'Parameter' || !(out.Weight > 0)) continue;
      const id = out.Destination.Id;
      if (!writers.has(id)) writers.set(id, []);
      writers.get(id).push({ setting, out });
    }
  }
  function upstream(id) {
    const seen = new Set([id]); const chain = [];
    while (writers.has(id)) {
      const list = writers.get(id);
      if (list.length !== 1) break;
      const { setting, out } = list[0];
      const active = entries(setting.Input).filter((i) => i.Weight > 0);
      if (out.Weight !== 100 || out.Reflect || !(out.Scale > 0)
          || active.length !== 1 || active[0].Weight !== 100 || active[0].Reflect
          || active[0].Source?.Target !== 'Parameter') break;
      id = active[0].Source.Id;
      if (!have.has(id) || seen.has(id)) return []; // missing input or cycle
      seen.add(id); chain.push(id);
    }
    return chain;
  }
  const settings = entries(vts?.ParameterSettings);
  const roles = {}; const diagnostics = [];
  const standardOwners = new Map();
  for (const [role, ids] of ROLE_RULES) for (const id of ids.map(resolve).filter(Boolean)) standardOwners.set(id, role);
  const inputOwners = new Map(standardOwners);
  for (const [name, candidates, space, def] of ROLE_RULES) {
    const allowed = new Set((aliases[name] ?? []).map(resolve).filter(Boolean));
    const declared = settings.filter((p) => inputs[name]?.includes(p.Input)
      && have.has(p.OutputLive2D) && Number.isFinite(p.OutputRangeLower)
      && Number.isFinite(p.OutputRangeUpper) && p.OutputRangeLower !== p.OutputRangeUpper);
    let targets = [...new Set(candidates.map(resolve).filter(Boolean))];
    if (!targets.length) {
      targets = declaredModelRoleTargets(groups,name,id=>have.has(id)&&!writers.has(id)
        && (!inputOwners.has(id)||inputOwners.get(id)===name));
      if (targets.length) diagnostics.push({ role: name, kind: 'model-group', targets });
    }
    if (!targets.length) {
      // An explicit alias is stronger evidence than a tracker input shared by
      // several model parameters. Do not turn mouth form or squint into smile.
      targets = [...allowed].filter((id) => !writers.has(id));
      if (!targets.length && labels[name]) {
        const suggestions = parameters.filter((p) => labels[name].test(String(p.Name ?? '')
          .replace(/^\s*\d+\s*[.、:：)）-]\s*/, '').trim()) && !writers.has(p.Id)).map((p) => p.Id);
        // A display label does not prove continuous semantics. It may enable
        // a whole-face overlay or an expression switch; report, do not guess.
        if (suggestions.length) diagnostics.push({ role: name, kind: 'unverified-control', targets: suggestions });
      }
      if (targets.length) diagnostics.push({ role: name, kind: 'semantic-alias', targets });
    }
    const ranges = {};
    targets = targets.map((target) => {
      if (!writers.has(target)) return target;
      const chain = upstream(target);
      const choices = chain.filter((id) => !writers.has(id)
        && (!inputOwners.has(id) || inputOwners.get(id) === name)
        && (allowed.has(id) || declared.some((p) => p.OutputLive2D === id)));
      if (choices.length === 1) {
        const input = choices[0];
        const config = declared.filter((p) => p.OutputLive2D === input);
        // Calibrate only newly discovered inputs; established models retain
        // their previous default-anchored ranges and directions.
        if (config.length === 1) ranges[input] = [config[0].OutputRangeLower, config[0].OutputRangeUpper];
        diagnostics.push({ role: name, kind: 'physics-input', from: target, target: input, chain });
        return input;
      }
      diagnostics.push({ role: name, kind: 'physics-output', target });
      return target;
    });
    if (targets.length) {
      roles[name] = { targets: [...new Set(targets)], space, default: def };
      if (Object.keys(ranges).length) roles[name].ranges = ranges;
      for (const id of targets) inputOwners.set(id, name);
    }
  }
  return { roles, unmapped: ROLE_RULES.map(([name]) => name).filter((name) => !roles[name]), diagnostics };
}

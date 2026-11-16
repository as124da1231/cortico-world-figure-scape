// Exact Cubism conventions shared by the offline importer and the live body.
export const ROLE_RULES = [
  ['eyeOpen', ['ParamEyeLOpen', 'ParamEyeROpen'], [0, 1], 1],
  ['eyeSmile', ['ParamEyeLSmile', 'ParamEyeRSmile'], [0, 1], 0],
  ['browY', ['ParamBrowLY', 'ParamBrowRY'], [-1, 1], 0],
  ['browAngle', ['ParamBrowLAngle', 'ParamBrowRAngle'], [-1, 1], 0],
  ['mouthOpen', ['ParamMouthOpenY', 'ParamMouthOpen'], [0, 1], 0],
  ['mouthForm', ['ParamMouthForm'], [-1, 1], 0],
  ['cheek', ['ParamCheek'], [0, 1], 0],
  ['eyeBallX', ['ParamEyeBallX'], [-1, 1], 0],
  ['eyeBallY', ['ParamEyeBallY'], [-1, 1], 0],
  ['angleX', ['ParamAngleX'], [-1, 1], 0],
  ['angleY', ['ParamAngleY'], [-1, 1], 0],
  ['angleZ', ['ParamAngleZ'], [-1, 1], 0],
  ['bodyX', ['ParamBodyAngleX'], [-1, 1], 0],
  ['breath', ['ParamBreath'], [0, 1], 0],
  ['step', ['ParamStep', 'ParamLeg'], [0, 1], 0],
  ['armA', ['ParamArmLA', 'ParamArmRA', 'ParamArmLeftA', 'ParamArmRightA'], [-1, 1], 0],
  ['armB', ['ParamArmLB', 'ParamArmRB', 'ParamArmLeftB', 'ParamArmRightB'], [-1, 1], 0],
];

const modelGroups = {eyeOpen:['EyeBlink'], mouthOpen:['LipSync','MouthOpen']};

export function declaredModelRoleTargets(groups, role, isAvailable) {
  if (!Array.isArray(groups) || !Object.hasOwn(modelGroups,role)) return [];
  const candidates=groups.filter(group=>group?.Target==='Parameter'&&modelGroups[role].includes(group.Name));
  const ids=candidates.length===1?candidates[0].Ids:null;
  return Array.isArray(ids)&&ids.length<=2 ? [...new Set(ids.filter(isAvailable))] : [];
}

export function standardParameterRoles(parameterIds, physicsOutputs, groups) {
  const roles = {};
  const reserved = new Set(ROLE_RULES.flatMap(([, ids])=>ids.filter(id=>parameterIds.has(id))));
  for (const [name, candidates, space, defaultValue] of ROLE_RULES) {
    const writable = id => parameterIds.has(id) && !physicsOutputs.has(id);
    const standard = candidates.filter(writable);
    const targets = standard.length ? standard
      : declaredModelRoleTargets(groups,name,id=>writable(id)&&!reserved.has(id));
    if (targets.length) {
      roles[name] = { targets, space, default: defaultValue };
      for (const id of targets) reserved.add(id);
    }
  }
  return roles;
}

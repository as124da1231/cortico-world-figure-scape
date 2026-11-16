import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { insidePath, portableModelPath } from './model-source.mjs';

// Compile from frozen inputs. Reject paths that leave the selected model, and
// preserve the flat fallback used by model exporters.
export function createModelAssetResolver(modelDir) {
  const safe = file => {
    try {
      const real = realpathSync(file);
      return insidePath(modelDir, real) && lstatSync(file).isFile() ? real : null;
    } catch {
      return null;
    }
  };
  return name => {
    let path;
    try { path = portableModelPath(name); } catch { return null; }
    return safe(join(modelDir, ...path.split('/'))) ?? safe(join(modelDir, basename(path)));
  };
}

export async function readOptionalModelMetadata({modelDir, model3Path, files, mocPath, resolveAsset}) {
  const mappingWarnings = [];
  async function optionalJson(path, valid, label) {
    if (!path) return null;
    try {
      const value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
      if (valid(value)) return value;
    } catch {}
    mappingWarnings.push(label + '配置无法解析，已跳过此可选文件');
    return null;
  }

  const physicsAsset = resolveAsset(files.Physics);
  const physics = await optionalJson(physicsAsset, value=>Array.isArray(value?.PhysicsSettings)&&
    value.PhysicsSettings.every(setting=>setting&&['Input','Output','Vertices'].every(key=>
      Array.isArray(setting[key])&&setting[key].every(item=>item&&typeof item==='object'))), '物理');
  const physicsPath = physics ? physicsAsset : null;
  const poseAsset = resolveAsset(files.Pose);
  const pose = await optionalJson(poseAsset,value=>Array.isArray(value?.Groups)&&value.Groups.length>0&&
    (value.FadeInTime===undefined||Number.isFinite(value.FadeInTime)&&value.FadeInTime>=0)&&
    value.Groups.every(group=>Array.isArray(group)&&group.length>0&&group.every(part=>
      typeof part?.Id==='string'&&part.Id.trim()&&
      (part.Link===undefined||Array.isArray(part.Link)&&part.Link.every(id=>typeof id==='string'&&id.trim())))), '姿态');
  const posePath = pose ? poseAsset : null;
  const cdiAsset = resolveAsset(files.DisplayInfo) ?? resolveAsset(basename(mocPath).replace(/\.moc3$/i, '.cdi3.json'));

  const displayData = await optionalJson(cdiAsset, value=>value&&typeof value==='object'&&!Array.isArray(value)&&
    ['Parameters','ParameterGroups','Parts'].every(key=>value[key]===undefined||Array.isArray(value[key])), '参数说明');
  const cdiPath = displayData ? cdiAsset : null;
  const display = displayData ?? {};

  // Prefer the matching model's VTS config; do not merge unrelated models in the folder.
  const vtsNames = (await readdir(modelDir)).filter((n) => n.toLowerCase().endsWith('.vtube.json')).sort();
  const expectedVts = basename(model3Path).replace(/\.model3\.json$/i, '.vtube.json');
  const vtsName = vtsNames.find((n) => n.toLowerCase() === expectedVts.toLowerCase())
    ?? (vtsNames.length === 1 ? vtsNames[0] : null);
  const vts = await optionalJson(vtsName&&resolveAsset(vtsName),value=>value&&typeof value==='object'&&!Array.isArray(value),'VTS');

  return {physics, physicsPath, pose, posePath, display, cdiPath, vts, mappingWarnings};
}

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const stageName = /^\.figure-scape-[a-z0-9]{6}$/i;

/** @param {string} parent */
export async function createCabinStage(parent) {
  await mkdir(parent,{recursive:true});
  const root = await realpath(parent);
  const stage = await mkdtemp(join(root,'.figure-scape-'));
  try {
    await writeFile(join(stage,'owner.pid'),String(process.pid),{flag:'wx'});
  } catch (error) {
    await removeCabinStage(root,stage);
    throw error;
  }
  return stage;
}

/** @param {string} parent @param {string | undefined} stage */
export async function removeCabinStage(parent,stage) {
  if (!stage || !stageName.test(basename(stage))) return;
  const [root,actual] = await Promise.all([realpath(parent).catch(() => null),realpath(stage).catch(() => null)]);
  if (!root || actual !== stage || dirname(actual) !== root) return;
  await rm(stage,{recursive:true,force:true,maxRetries:6,retryDelay:200}).catch(error => {
    console.warn('Cabin World could not remove its temporary launch directory:',error?.code ?? 'unknown');
  });
}

async function readPid(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 16) return undefined;
    const value = await readFile(path,'utf8');
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 0x7fffffff) return undefined;
    return Number(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return undefined;
  }
}

function running(pid) {
  try { process.kill(pid,0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

/** @param {string} parent */
export async function recoverCabinStages(parent) {
  const root = await realpath(parent).catch(() => null);
  if (!root) return;
  const children = await readdir(root,{withFileTypes:true}).catch(() => []);
  for (const entry of children) {
    if (!entry.isDirectory() || !stageName.test(entry.name)) continue;
    const stage = join(root,entry.name);
    if (await realpath(stage).catch(() => null) !== stage) continue;
    const [owner,bridge] = await Promise.all([readPid(join(stage,'owner.pid')),readPid(join(stage,'bridge.pid'))]);
    // Missing ownership, unreadable metadata and live processes all leave the directory alone.
    if (typeof owner !== 'number' || bridge === undefined || running(owner) || (bridge !== null && running(bridge))) continue;
    await removeCabinStage(root,stage);
  }
}

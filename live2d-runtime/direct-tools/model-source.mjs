import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,open,readFile,readdir,realpath} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join,relative,sep} from 'node:path';

const RESERVED=/^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const MAX_FILE=512*1024*1024;
const MAX_JSON=16*1024*1024;
const MAX_TOTAL=2*1024*1024*1024;
const MAX_ENTRIES=10_000;
const MODEL_METADATA=/\.(?:motion3|exp3|physics3|pose3|cdi3|vtube)\.json$/iu;
const PNG_SIGNATURE=Buffer.from('89504e470d0a1a0a','hex');

export function portableModelPath(name){
 if(typeof name!=='string'||!name||name.length>512||/^[\\/]/u.test(name)||isAbsolute(name))throw Error('素材路径无效');
 const parts=name.split(/[\\/]/u).filter(part=>part&&part!=='.');
 if(!parts.length||parts.some(part=>part==='..'||/[<>:"|?*\u0000-\u001f]/u.test(part)||/[. ]$/u.test(part)||RESERVED.test(part))){
  throw Error('素材路径不能越过模型目录，且须使用有效文件名');
 }
 return parts.join('/');
}

export function insidePath(root,path){
 const part=relative(root,path);
 return Boolean(part)&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);
}

export async function localModelFile(root,name,max=MAX_JSON){
 const clean=portableModelPath(name);
 const base=await realpath(root);
 const file=join(base,...clean.split('/'));
 const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw Error('素材须为大小合规的普通文件');
 const actual=await realpath(file);
 if(!insidePath(base,actual))throw Error('素材链接越过模型目录');
 return {file:actual,info};
}

async function contentHash(file,signal){
 const hash=createHash('sha256');
 for await(const bytes of createReadStream(file,{signal}))hash.update(bytes);
 return hash.digest('hex');
}

async function checkTextureHeader(file,name){
 const handle=await open(file,'r');
 try{
  const {size}=await handle.stat();
  const header=Buffer.alloc(24);
  const {bytesRead}=await handle.read(header,0,header.length,0);
  let valid;
  switch(extname(name).toLowerCase()){
   case '.png':
    valid=size>=45&&bytesRead===24&&header.subarray(0,8).equals(PNG_SIGNATURE)&&
     header.readUInt32BE(8)===13&&header.toString('ascii',12,16)==='IHDR'&&
     header.readUInt32BE(16)>0&&header.readUInt32BE(20)>0;
    break;
   case '.webp':
    valid=bytesRead===24&&header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP'&&
     ['VP8 ','VP8L','VP8X'].includes(header.toString('ascii',12,16))&&
     header.readUInt32LE(4)+8<=size&&header.readUInt32LE(16)+20<=size;
    break;
   default:
    valid=bytesRead>=4&&header[0]===0xff&&header[1]===0xd8&&header[2]===0xff;
  }
  if(!valid)throw Error('模型贴图损坏或文件格式与扩展名不符：'+name);
 }finally{await handle.close();}
}

// Snapshot only material read by the converter. In particular, imported folders
// cannot contribute scripts or link targets outside the selected model.
export async function snapshotModel(model,target,{signal}={}){
 const root=await realpath(model.dir);
 const manifestName=portableModelPath(model.file);
 const manifestFile=await localModelFile(root,manifestName);
 const manifestBytes=await readFile(manifestFile.file,{signal});
 const manifest=JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/u,''));
 const manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
 const references=manifest?.FileReferences?.FileReferences??manifest?.FileReferences;
 if(!references||!Array.isArray(references.Textures)||!references.Textures.length||references.Textures.length>40){
  throw Error('模型清单缺少贴图列表或贴图数量过多');
 }
 const files=new Map();
 function add(name,{required=false,max=MAX_JSON}={}){
  if(name===undefined||name===null||name===''){
   if(required)throw Error('模型缺少必要的素材引用');
   return;
  }
  const path=portableModelPath(name);
  const key=process.platform==='win32'?path.toLowerCase():path;
  const previous=files.get(key);
  if(!previous||required&&!previous.required)files.set(key,{path,required,max});
 }
 add(manifestName,{required:true});
 add(references.Moc??references.MocFile,{required:true,max:MAX_FILE});
 for(const name of references.Textures){
  if(typeof name!=='string'||!/\.(?:png|jpe?g|webp)$/iu.test(name))throw Error('贴图须为 PNG、JPEG 或 WebP 文件');
  add(name,{required:true,max:MAX_FILE});
 }
 // BongoCat models use optional key artwork under these paths.
 for(const name of ['background.png','cover.png'])add('resources/'+name,{max:16*1024*1024});
 for(const side of ['left-keys','right-keys']){
  const art=await readdir(join(root,'resources',side),{withFileTypes:true}).catch(()=>[]);
  for(const entry of art.sort((a,b)=>a.name.localeCompare(b.name)).slice(0,256)){
   if(entry.isFile()&&/^[a-z][a-z0-9]{0,31}\.png$/iu.test(entry.name))add('resources/'+side+'/'+entry.name,{max:16*1024*1024});
  }
 }
 for(const name of [references.Physics,references.Pose,references.DisplayInfo])add(name);
 for(const list of Object.values(references.Motions??{})){
  if(Array.isArray(list))for(const item of list)if(item?.File)add(item.File);
 }
 if(Array.isArray(references.Expressions))for(const item of references.Expressions)if(item?.File)add(item.File);
 let scanned=0;
 async function discover(directory,depth){
  const entries=await readdir(directory,{withFileTypes:true});
  // An explicitly referenced resource can still be shared between models.
  if(depth>0&&entries.some(item=>item.isFile()&&/\.model3\.json$/iu.test(item.name)))return;
  for(const item of entries){
   signal?.throwIfAborted();
   if(++scanned>MAX_ENTRIES)throw Error('模型目录文件过多，请选择独立的模型文件夹');
   const file=join(directory,item.name);
   if(item.isFile()&&MODEL_METADATA.test(item.name))add(relative(root,file));
   else if(item.isDirectory()&&depth<3)await discover(file,depth+1);
  }
 }
 await discover(root,0);
 let size=0;
 const hashes=[];
 const copied=new Set();
 for(const {path,required,max} of [...files.values()].sort((a,b)=>a.path.localeCompare(b.path,'en'))){
  signal?.throwIfAborted();
  let source,outputPath=path;
  try{source=await localModelFile(root,path,max);}
  catch(error){
   // A few exporters flatten references alongside the entry.
   if(error.code==='ENOENT'&&path.includes('/')){
    outputPath=basename(path);
    source=await localModelFile(root,outputPath,max).catch(()=>null);
   }
   if(!source&&required)throw Error('缺少必要模型素材：'+path,{cause:error});
   if(!source&&error.code!=='ENOENT')throw error;
  }
  if(!source)continue;
  const key=process.platform==='win32'?outputPath.toLowerCase():outputPath;
  if(copied.has(key))continue;
  copied.add(key);
  size+=source.info.size;
  if(size>MAX_TOTAL)throw Error('模型素材超过 2 GB，请减少素材后重新导入');
  const destination=join(target,...outputPath.split('/'));
  await mkdir(dirname(destination),{recursive:true});
  await copyFile(source.file,destination);
  const after=await lstat(source.file);
  if(source.info.size!==after.size||source.info.mtimeMs!==after.mtimeMs)throw Error('导入期间源素材发生变化，请重试');
  const checksum=await contentHash(destination,signal);
  if(path===manifestName&&checksum!==manifestHash)throw Error('导入期间模型清单发生变化，请重试');
  hashes.push([outputPath,checksum]);
 }
 for(const name of references.Textures){
  signal?.throwIfAborted();
  const path=portableModelPath(name);
  const key=process.platform==='win32'?path.toLowerCase():path;
  const outputPath=copied.has(key)?path:basename(path);
  await checkTextureHeader(join(target,...outputPath.split('/')),path);
 }
 return {dir:target,file:manifestName,size,fingerprint:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
}

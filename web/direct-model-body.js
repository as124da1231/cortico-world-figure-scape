import {modelConfiguration} from './model-configuration-contract.js';
/** Raw model factory. Uses DSH's direct createLive2DBody pattern with Coo's
 * existing kit and transactional body host; no per-model executable entry. */
export async function createDirectModelBody(resource,base,opts){
 if(resource?.kind!=='live2d-model'||resource.version!==1||resource.entry?.id!==resource.id)throw Error('Invalid direct model resource');
 const runtime=new URL('/model-runtime/',location.href);
 await new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src=new URL('sdk/live2dcubismcore.min.js',runtime);
  const timer=setTimeout(()=>finish(Error('Live2D Core load timed out')),12000);
  const finish=error=>{clearTimeout(timer);script.onload=script.onerror=null;if(error){script.remove();reject(error);}else resolve();};
  script.onload=()=>finish(globalThis.Live2DCubismCore?null:Error('Live2D Core unavailable'));
  script.onerror=()=>finish(Error('Live2D Core could not be loaded'));document.head.append(script);
 });
 const {createLive2DBody}=await import(new URL('backends/live2d.js',runtime));
 const configuration=resource.configuration?modelConfiguration(resource.configuration):undefined;
 return createLive2DBody(base,{...opts,configuration,awaitReady:true},resource.entry,opts.kit);
}

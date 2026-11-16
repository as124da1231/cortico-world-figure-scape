/** Window-local physical keys only. Text entry, IME, blur and hidden windows never feed body input. */
export function attachFocusedInput({ document: doc, window: win }, input) {
 const editable = target => !!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
 const textEvent = event => editable(event.target) || editable(doc.activeElement) || event.composedPath?.().some(editable);
 const removers=[];
 const on=(target,type,fn)=>{target.addEventListener(type,fn,true);removers.push(()=>target.removeEventListener(type,fn,true));};
 on(win,'keydown',event=>{if(event.isComposing||textEvent(event)){input.clear('text-entry');return;}input.key(event.code,true);});
 on(win,'keyup',event=>input.key(event.code,false));
 on(win,'blur',()=>input.clear('blur'));
 on(doc,'focusin',event=>{if(textEvent(event))input.clear('text-entry');});
 on(doc,'visibilitychange',()=>{if(doc.hidden)input.clear('hidden');});
 return ()=>{for(const remove of removers)remove();input.clear('detach');};
}

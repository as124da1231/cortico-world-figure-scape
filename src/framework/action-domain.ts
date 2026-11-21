import { randomUUID } from 'node:crypto';

/** Application boundary for actual body vocabulary. No parallel action configuration or player. */
export function createActionDomain<Word extends {id:string}>(ports: {
  selected:()=>string; available:()=>boolean; busy:()=>boolean;
  vocabulary:()=>Word[]; runtime:()=>unknown;
  send:(command:{t:'act';id:string;figure:string;actions:string[]})=>boolean;
}) {
  return {
    read() { return { figure:ports.selected(),available:ports.available(),busy:ports.busy(),
      vocabulary:structuredClone(ports.vocabulary()),runtime:ports.runtime() }; },
    receipt(requestId: string) {
      const runtime = ports.runtime() as { recent?: unknown } | null;
      if (!Array.isArray(runtime?.recent)) return null;
      const steps = new Map<number, { word: string; status: string; completion?: string }>();
      for (const row of runtime.recent) {
        if (row?.requestId !== requestId || !Number.isSafeInteger(row.id) || typeof row.word !== 'string' || typeof row.status !== 'string') continue;
        const completion = row.completion === 'body-event' || row.completion === 'duration' ? row.completion : undefined;
        const status = row.status === 'completed' && completion === 'duration' ? 'elapsed' : row.status;
        steps.set(row.id,{word:row.word,status,...(completion ? { completion } : {})});
      }
      return steps.size ? {id:requestId,figure:ports.selected(),steps:[...steps.values()]} : null;
    },
    preview(figure:unknown, words:unknown) {
      if (typeof figure!=='string' || figure!==ports.selected() || ports.busy()) throw Error('The active model changed or is loading');
      if (!Array.isArray(words) || !words.length || words.length>16 || words.some(word=>typeof word!=='string')) throw Error('Choose between 1 and 16 supported actions');
      const known=new Set(ports.vocabulary().map(word=>word.id));
      if (words.some(word=>!known.has(word))) throw Error('Action is not supported by the active body');
      if (!ports.available()) throw Error('The main window is not connected');
      const requestId=randomUUID(), actions=[...words] as string[];
      if (!ports.send({t:'act',id:requestId,figure,actions})) throw Error('The main window is not connected');
      return {accepted:true,requestId,words:actions};
    },
  };
}

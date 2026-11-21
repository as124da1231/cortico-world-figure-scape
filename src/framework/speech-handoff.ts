import { randomUUID } from 'node:crypto';
import type { Beat } from '../script.ts';

export type SpeechSurface = 'desktop' | 'cabin';
export type SpeechCheckpoint = { id: string; beat: number; shown: number; fired: number; offset: number; audio: boolean; leading: boolean; displayed?: boolean };
export type SpeechOrder = {
  id: string; figure: string; cursor?: number | null; beats: Beat[]; clips: Array<string | null>;
  cues?: unknown; cueBeat?: number; faces: Array<string | null>; planClips: string[]; resume?: SpeechCheckpoint;
};
type Transfer = {
  from: SpeechSurface; request: string; captured: Promise<void>;
  collect(rows: unknown): void; carry: SpeechOrder[]; waiting: SpeechOrder[];
};

export function speechForFigure(order: SpeechOrder, figure: string): SpeechOrder {
  if (order.figure === figure) return order;
  return {...order,figure,beats:order.beats.map(beat => ({text:beat.text,actions:[],anchors:[]})),cues:undefined,faces:[],planClips:[]};
}

export function createSpeechHandoff(stopClip: (id: string) => void) {
  const known = new Map<string, SpeechOrder>();
  let transfer: Transfer | undefined;
  let expires: ReturnType<typeof setTimeout> | undefined;

  function remember(order: SpeechOrder) {
    known.set(order.id, order);
    if (known.size > 96) known.delete(known.keys().next().value!);
  }
  function clips() {
    return new Set((transfer ? [...transfer.carry, ...transfer.waiting] : []).flatMap(order => order.clips.filter(id => id !== null)));
  }
  function clear() {
    clearTimeout(expires);
    const held = clips();
    const current = transfer;
    transfer = undefined;
    current?.collect([]);
    for (const id of held) stopClip(id);
  }
  function readRows(rows: unknown): SpeechOrder[] {
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>(), result: SpeechOrder[] = [];
    for (const row of rows.slice(0,64) as SpeechCheckpoint[]) {
      if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
      const order = known.get(row.id), beat = order?.beats[row.beat];
      if (!order || !Number.isInteger(row.beat) || !beat) continue;
      const shown = Number.isInteger(row.shown) ? Math.min(beat.text.length, Math.max(0,row.shown)) : 0;
      const fired = Number.isInteger(row.fired) ? Math.min(beat.anchors.length, Math.max(0,row.fired)) : 0;
      const playable = row.audio === true && Boolean(order.clips[row.beat]);
      const offset = playable && Number.isFinite(row.offset) ? Math.min(120, Math.max(0,row.offset)) : 0;
      const start = row.beat + (playable ? 0 : 1);
      const nextClips = order.clips.map((clip,index) => index < start ? null : clip);
      result.push({...order,clips:nextClips,
        resume:{id:row.id,beat:row.beat,shown,fired,offset,audio:playable,leading:row.leading === true,displayed:row.displayed === true}});
      seen.add(row.id);
    }
    return result;
  }
  return {
    remember, clips, clear,
    active: () => !!transfer,
    defer(order: SpeechOrder) {
      if (!transfer || transfer.waiting.length >= 32) return false;
      transfer.waiting.push(order);
      return true;
    },
    capture(from: SpeechSurface, send: (request: string, deadline: number) => boolean, recover?: () => unknown) {
      if (transfer) return transfer.captured;
      const request = randomUUID(), duration = 900;
      let finish!: () => void;
      const captured = new Promise<void>(resolve => {finish = resolve;});
      let settled = false;
      const timer = setTimeout(() => collect(recover?.() ?? []),duration);
      function collect(rows: unknown) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (transfer?.request === request) transfer.carry = readRows(rows);
        finish();
      }
      transfer = {from,request,captured,collect,carry:[],waiting:[]};
      expires = setTimeout(clear,15_000);
      expires.unref();
      try { if (!send(request,Date.now() + duration)) collect(recover?.() ?? []); }
      catch { collect(recover?.() ?? []); }
      return captured;
    },
    receive(from: SpeechSurface, request: unknown, rows: unknown) {
      if (transfer?.from === from && transfer.request === request) transfer.collect(rows);
    },
    resume(figure: string) {
      if (!transfer) return [];
      const current = transfer;
      transfer = undefined;
      current.collect([]);
      clearTimeout(expires);
      return [...current.carry,...current.waiting].map(order => speechForFigure(order,figure));
    },
  };
}

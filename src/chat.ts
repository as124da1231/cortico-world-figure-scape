/**
 * The chat page's side of the pet: what the person said (typed in the bubble or the page, spoken,
 * answered, touches) and what the pet said (`live2d_pet_say` beats, `live2d_pet_ask` questions) and did (tool
 * steps), rebuilt from this World's own events.
 *
 * The person's input is the events delivered to the bot. The pet's side is recorded as
 * `desktop-live2d-pet.self` events that are stored and never delivered: `say`, `ask`, `activity` (the tool
 * steps between two lines), `delivered` (where messages that waited reached the bot) and `withdrawn`
 * (a message taken back before delivery, left out of the history). A touch is stored as its kind and
 * counts, a figure the person switched to (`desktop-live2d-pet.figure`) as the kind of switch and the figure's names;
 * the page tells both in its own language.
 */
import type { EventEnvelope, EventStoreReader, RunPhase, WorldStreamSocket } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';

import { readTouchRegion, type TouchRegion } from '../web/framework/touch-geometry.js';
import { parseScript } from './script.ts';

export const SELF_TYPE = 'desktop-live2d-pet.self';

/** Event types the chat shows. */
const CHAT_TYPES = new Set(['message', 'speech', 'answer', 'touch', 'figure', 'self']);
const chatEvent = (type: string): string => type.replace(/^desktop-(?:live2d-)?pet\./, '');

/** Tools whose work shows as the pet's own lines, not as steps. */
const SPOKEN_TOOLS = new Set(['pet_say', 'pet_ask', 'live2d_pet_say', 'live2d_pet_ask']);

/** One image of a message: `ref` is the attachment handle; the page fetches its bytes from the console's `/api/blob`. */
export interface WireImage { ref: string; mime: string; name?: string }

/** A touch as the chat page tells it: `poke`, `pet`, `throw`, `drop` or `crash`, how many times, and whether it woke the pet or the pet crashed. */
export interface ChatTouch {
  kind: string;
  region?: TouchRegion;
  areaId?: string;
  areaName?: string;
  reaction?: string;
  count: number;
  woke: boolean;
  crashed: boolean;
}

/** A figure switch, an outfit change, or a load failure with its reported reason. */
export interface ChatFigure { kind: 'figure' | 'dress' | 'failed'; name: Record<string, string>; reason?: string }

/** One beat of a `live2d_pet_say`: its text and the first expression played in it, by its id and its name in each language. */
export interface SayBeat { text: string; mood?: Record<string, string> }
export interface PhonePerformance {
  figure: string;
  scheme: string;
  createdAt: number;
  beats: readonly { text: string; actions: string[]; anchors: { at:number; actions:string[] }[] }[];
  cues?: unknown;
}

export type ChatItem =
  | { kind: 'user'; cursor: number; ts: string; via: 'chat' | 'bubble' | 'voice'; text: string; images?: WireImage[]; at?: number }
  | { kind: 'answer'; cursor: number; ts: string; askId: string; index?: number; text?: string; dismissed?: true }
  /** `text` for touches stored before they were stored as `touch`. */
  | { kind: 'touch'; cursor: number; ts: string; touch?: ChatTouch; text?: string }
  | { kind: 'figure'; cursor: number; ts: string; figure: ChatFigure }
  | { kind: 'say'; cursor: number; ts: string; beats: SayBeat[]; images?: WireImage[]; performance?: PhonePerformance }
  | { kind: 'ask'; cursor: number; ts: string; askId: string; question: string; options: string[]; own: boolean }
  | { kind: 'activity'; cursor: number; ts: string; steps: string[]; ms: number };

type Meta = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const wireImages = (e: EventEnvelope): WireImage[] => (e.blobs ?? []).filter((b) => b.mime.startsWith('image/'))
  .map((b) => ({ ref: b.handle, mime: b.mime, ...(b.name ? { name: b.name } : {}) }));

/** A stored event as the chat shows it; null for events the chat leaves out. */
export function chatItem(e: EventEnvelope): ChatItem | null {
  const type = chatEvent(e.type);
  if (type === e.type || !CHAT_TYPES.has(type)) return null;
  const m = (e.meta ?? {}) as Meta;
  const base = { cursor: e.cursor, ts: e.ts };
  switch (type) {
    case 'message':
    case 'speech': {
      const text = str(m.text);
      if (text === undefined || (m.requiresDelivery === true && e.contextDelivery === 'archive-only')) return null;
      const images = wireImages(e);
      const via = type === 'speech' ? 'voice' : m.via === 'chat' ? 'chat' : 'bubble';
      return { kind: 'user', ...base, via, text, ...(images.length ? { images } : {}) };
    }
    case 'answer': {
      const askId = str(m.askId);
      if (!askId) return null;
      return {
        kind: 'answer', ...base, askId,
        ...(typeof m.index === 'number' ? { index: m.index } : {}),
        ...(str(m.text) !== undefined ? { text: str(m.text) } : {}),
        ...(m.dismissed === true ? { dismissed: true as const } : {}),
      };
    }
    case 'touch': {
      const t = (m.touch ?? null) as Meta | null;
      if (t && typeof t.kind === 'string') {
        const region = readTouchRegion(t.region);
        const areaId = str(t.areaId), areaName = str(t.areaName), reaction = str(t.reaction);
        return { kind: 'touch', ...base, touch: { kind: t.kind, ...(region ? { region } : {}),
          ...(areaId ? {areaId} : {}), ...(areaName ? {areaName} : {}), ...(reaction ? {reaction} : {}),
          count: typeof t.count === 'number' ? t.count : 1, woke: t.woke === true, crashed: t.crashed === true } };
      }
      const text = str(m.chat);
      return text ? { kind: 'touch', ...base, text } : null;
    }
    case 'figure': {
      const f = (m.figure ?? null) as Meta | null;
      if (!f || !['figure', 'dress', 'failed'].includes(f.kind as string) || !f.name || typeof f.name !== 'object') return null;
      const reason = f.kind === 'failed' ? str(f.reason) : undefined;
      return { kind: 'figure', ...base, figure: { kind: f.kind as ChatFigure['kind'], name: f.name as Record<string, string>,
        ...(reason ? { reason } : {}) } };
    }
    default: {
      if (m.kind === 'say' && Array.isArray(m.beats)) {
        const beats = (m.beats as Meta[]).flatMap((b) => (typeof b.text === 'string' && b.text ? [{ text: b.text, ...(b.mood && typeof b.mood === 'object' ? { mood: b.mood as Record<string, string> } : {}) }] : []));
        const images = wireImages(e);
        const performance=m.performance as PhonePerformance|undefined;
        return beats.length || images.length ? { kind: 'say', ...base, beats, ...(images.length ? { images } : {}),
          ...(performance && typeof performance.figure==='string' && Array.isArray(performance.beats) ? {performance} : {}) } : null;
      }
      if (m.kind === 'ask' && str(m.askId) && str(m.question)) {
        const options = Array.isArray(m.options) ? m.options.filter((o): o is string => typeof o === 'string') : [];
        return { kind: 'ask', ...base, askId: str(m.askId)!, question: str(m.question)!, options, own: m.own !== false };
      }
      if (m.kind === 'activity' && Array.isArray(m.steps)) {
        const steps = m.steps.filter((s): s is string => typeof s === 'string');
        return steps.length ? { kind: 'activity', ...base, steps, ms: typeof m.ms === 'number' ? m.ms : 0 } : null;
      }
      return null;
    }
  }
}

/** Messages recorded as withdrawn, and where messages that waited were delivered (message cursor → record cursor). */
export interface ChatRefs { withdrawn: number[]; delivered: Array<[number, number]> }

/** The `withdrawn` and `delivered` records among `events`. */
export function chatRefs(events: readonly EventEnvelope[]): ChatRefs {
  const refs: ChatRefs = { withdrawn: [], delivered: [] };
  for (const e of events) {
    const m = (e.meta ?? {}) as Meta;
    if (chatEvent(e.type) !== 'self' || e.type === 'self') continue;
    if (m.kind === 'withdrawn' && typeof m.cursor === 'number') refs.withdrawn.push(m.cursor);
    if (m.kind === 'delivered' && Array.isArray(m.cursors)) for (const c of m.cursors) if (typeof c === 'number') refs.delivered.push([c, e.cursor]);
  }
  return refs;
}

export const DESKTOP_CHAT_SOURCE = 'desktop-pet';

function historyReference(event: EventEnvelope): boolean {
  return event.type === `${event.source}.self` && (event.meta?.kind === 'withdrawn' || event.meta?.kind === 'delivered');
}

function conversationEvent(event: EventEnvelope): boolean {
  if (event.type === `${event.source}.message` || event.type === `${event.source}.speech`) return chatItem(event) !== null;
  return event.type === `${event.source}.self` && event.meta?.kind === 'say' || historyReference(event);
}

// Peer rows share the conversation. Controls for questions and body activity stay with their World.
export function isDesktopChatEvent(event: EventEnvelope): boolean {
  return event.source === DESKTOP_CHAT_SOURCE && conversationEvent(event);
}

function readChatEvents(store: EventStoreReader, source: string, limit: number, end: number, accepts: (event: EventEnvelope) => boolean) {
  const events: EventEnvelope[] = [];
  while (end > 0 && events.length <= limit) {
    const batch = store.range({ source, limit, toCursor: end });
    for (let i = batch.length - 1; i >= 0 && events.length <= limit; i--) {
      const event = batch[i]!;
      if (accepts(event)) events.push(event);
    }
    if (batch.length < limit) break;
    end = batch[0]!.cursor - 1;
  }
  return events;
}

export function chatPage(store: EventStoreReader, source: string, limit: number, before?: number, view: 'timeline' | 'conversation' = 'timeline') {
  const end = before === undefined ? store.latestCursor() : before - 1;
  const own = readChatEvents(store, source, limit, end, event => {
    if (conversationEvent(event)) return true;
    const item = chatItem(event);
    return item !== null && (view === 'timeline' || item.kind === 'ask' || item.kind === 'answer');
  });
  const peer = readChatEvents(store, DESKTOP_CHAT_SOURCE, limit, end, isDesktopChatEvent);
  const merged = [...own, ...peer].sort((a, b) => a.cursor - b.cursor);
  const events = merged.slice(-limit);
  const first = events[0]?.cursor ?? 0;
  const refs = chatRefs(events);
  const more = merged.length > limit;
  return {
    items: chatHistory(events),
    refs: { withdrawn: refs.withdrawn.filter(c => c < first), delivered: refs.delivered.filter(([c]) => c < first) },
    more, before: more ? first : null,
  };
}

/**
 * The chat items among `events`, in the order the bot met them: a message that waited stands where
 * its `delivered` record is, with `at` set to that record's cursor. Messages later recorded as
 * withdrawn are left out.
 */
export function chatHistory(events: readonly EventEnvelope[]): ChatItem[] {
  const refs = chatRefs(events);
  const withdrawn = new Set(refs.withdrawn);
  const deliveredAt = new Map(refs.delivered);
  const waiting = new Map<number, ChatItem[]>();
  const out: ChatItem[] = [];
  for (const e of events) {
    out.push(...waiting.get(e.cursor) ?? []);
    if (withdrawn.has(e.cursor)) continue;
    const item = chatItem(e);
    if (!item) continue;
    const at = deliveredAt.get(e.cursor);
    if (at === undefined || item.kind !== 'user') { out.push(item); continue; }
    waiting.set(at, [...waiting.get(at) ?? [], { ...item, at }]);
  }
  return out;
}

/** Final assistant text is a fallback for a delivered chat turn with no explicit speech. */
export class ChatReplyFallback {
  private after: number | null = null;
  private input = 0;
  private candidate = '';
  private reply = '';

  begin(cursor: number): void {
    this.after = cursor;
    this.input = 0;
    this.abort();
  }

  accept(events: readonly EventEnvelope[]): number | undefined {
    if (this.after === null) return;
    const cursor = Math.max(this.input, ...events.filter(event => chatItem(event)?.kind === 'user').map(event => event.cursor));
    if (cursor === this.input) return;
    this.input = cursor;
    this.abort();
    return cursor;
  }

  turn(): { after: number; input: number } | null {
    return this.after === null ? null : { after: this.after, input: this.input };
  }

  observe(event: StreamEvent): void {
    if (!this.input) return;
    if (event.type === 'response.created') this.candidate = '';
    if (event.type !== 'response.completed') return;
    const output = event.response.output;
    // A model can include its answer in the same response as a scene action.
    this.candidate = output.flatMap(item => item.type === 'message' && item.role === 'assistant'
      && (!('phase' in item) || item.phase !== 'commentary')
      ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : part.type === 'refusal' ? [part.refusal] : []) : [])
      .join('\n').trim();
    if (this.candidate) return;
    this.candidate = output.flatMap(item => {
      if (item.type !== 'function_call' || item.name !== 'pet_say') return [];
      try {
        const args = JSON.parse(item.arguments);
        if (typeof args?.script !== 'string') return [];
        return parseScript(args.script,[]).beats.map(beat => beat.text).filter(Boolean);
      } catch { return []; }
    }).join('').trim();
  }

  endRound(): void {
    if (this.candidate) this.reply = this.candidate;
    this.candidate = '';
  }
  abort(): void { this.candidate = ''; this.reply = ''; }

  finish(store: EventStoreReader, sources: readonly string[]): string {
    const { after, input, reply } = this;
    this.after = null;
    this.input = 0;
    this.abort();
    if (after === null || !input || !reply) return '';
    const events = sources.flatMap(source => store.range({ source, fromCursor: after + 1 }));
    return events.some(event => {
      if (!event.type.endsWith('.self')) return false;
      if (event.meta?.kind === 'conversation-input') {
        return typeof event.meta.cursor === 'number' && event.meta.cursor > input;
      }
      if (event.cursor <= input) return false;
      // The original speech tool can archive an action with an empty caption.
      const item = chatItem(event);
      return item?.kind === 'say' || item?.kind === 'ask';
    }) ? '' : reply;
  }
}

/** The tool steps between two of the pet's lines: names in start order, from the first start. */
export class ActivityGroup {
  steps: string[] = [];
  startedAt = 0;
  private running: string[] = [];

  /** Takes a new phase; returns true when a step was added. */
  observe(phase: RunPhase, now: number): boolean {
    const before = [...this.running];
    this.running = [...phase.running];
    let added = false;
    for (const name of phase.running) {
      const i = before.indexOf(name);
      if (i >= 0) { before.splice(i, 1); continue; }
      if (SPOKEN_TOOLS.has(name)) continue;
      if (this.steps.length === 0) this.startedAt = now;
      this.steps.push(name);
      added = true;
    }
    return added;
  }

  /** The steps so far, and empties the group. */
  take(now: number): { steps: string[]; ms: number } | null {
    if (this.steps.length === 0) return null;
    const out = { steps: this.steps, ms: Math.max(0, now - this.startedAt) };
    this.steps = [];
    return out;
  }
}

/** Open chat pages: frames go to every one. */
export class ChatSockets {
  private readonly sockets = new Set<WorldStreamSocket>();

  get size(): number {
    return [...this.sockets].filter((s) => s.open).length;
  }

  add(socket: WorldStreamSocket, onMessage: (msg: Meta, socket: WorldStreamSocket) => void, waitForHello = false): void {
    if (!waitForHello) this.sockets.add(socket);
    socket.onClose(() => this.sockets.delete(socket));
    socket.onMessage((raw) => {
      let msg: unknown;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (!this.sockets.has(socket)) {
        if ((msg as Meta).t !== 'hello') return;
        this.sockets.add(socket);
      }
      onMessage(msg as Meta, socket);
    });
  }

  send(socket: WorldStreamSocket, frame: Meta): void {
    socket.send(JSON.stringify(frame));
  }

  broadcast(frame: Meta): void {
    const text = JSON.stringify(frame);
    for (const s of this.sockets) if (s.open) s.send(text);
  }

  closeAll(reason: string): void {
    for (const s of this.sockets) s.close(reason);
    this.sockets.clear();
  }
}

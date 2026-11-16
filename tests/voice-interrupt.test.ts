import { afterEach, describe, expect, it } from 'vitest';
import type { Bot } from 'cortico/bot.ts';
import { INTERRUPTED_WHILE_RUNNING, NOT_EXECUTED_INTERRUPTED } from 'cortico/core/markers.ts';
import type { CoreConfig } from 'cortico/core/types.ts';
import type { TranscribeResult } from '../src/asr/result.ts';
import type { Utterance } from '../src/asr/segmenter.ts';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { desktopPetDefinition } from '../src/definition.ts';
import type { DesktopPetWorld } from '../src/world.ts';
import { ScriptedModel, startBot, type Turn } from './helpers/harness.ts';
import type { FakePage } from './helpers/page.ts';
import { openVoiceWindow } from './helpers/voice-window.ts';

function receipt(turn: Turn, name: string): string {
  const call = turn.records.find(({ item }) => item.type === 'function_call' && item.name === name)!.item;
  const result = turn.records.find(({ item }) => item.type === 'function_call_output' && item.call_id === call.call_id)!.item;
  return JSON.stringify(result.output);
}

let bot: Bot<CoreConfig> | null = null;
let page: FakePage | null = null;
afterEach(async () => {
  await page?.close();
  await bot?.stop();
  page = null;
  bot = null;
});

describe('transcribed speech through Core', () => {
  it('Live2D speech stops an active movement and skips the next tool only after transcription is delivered', async () => {
    let world!: DesktopPetWorld;
    let running: readonly string[] = [];
    const definition = desktopPetDefinition({ onCreate: (created) => {
      world = created;
      const onPhase = world.onRunPhase.bind(world);
      world.onRunPhase = (phase) => { running = phase.running; onPhase(phase); };
    } });
    const model = new ScriptedModel((turn) => turn.n === 0 ? { calls: [
      { name: 'live2d_pet_move_to', args: { to: 'right' } },
      { name: 'live2d_pet_say', args: { script: '继续下一步' } },
    ] } : { calls: [{ name: 'end_turn' }] });
    bot = await startBot({
      worlds: [definition as never], model,
      sections: { 'desktop-live2d-pet': {
        port: 0,
        window: { ...DESKTOP_PET_DEFAULTS.window, enabled: false },
        asr: { ...DESKTOP_PET_DEFAULTS.asr, enabled: false, mic: { ...DESKTOP_PET_DEFAULTS.asr.mic, mode: 'hold' } },
        typeKey: { ...DESKTOP_PET_DEFAULTS.typeKey, enabled: false },
      } },
    });
    page = await openVoiceWindow(world);
    page.send({ t: 'text', text: '等待一下' });
    await expect.poll(() => running).toContain('live2d_pet_move_to');

    // Feed the recognizer's result at the segmenter boundary, with Core and the delivery pipeline running.
    let finish!: (result: TranscribeResult) => void;
    const result = new Promise<TranscribeResult>((resolve) => { finish = resolve; });
    (world as unknown as { enqueue(utterance: Utterance): void }).enqueue({
      pcm: new Int16Array(4800), startMs: 0, durationMs: 300, forced: false, result,
    });
    await page.next((message) => message.t === 'listen' && message.phase === 'transcribing');
    expect(running).toContain('live2d_pet_move_to');
    expect(model.turns).toHaveLength(1);

    finish({ text: '请停下', ms: 300, error: null });
    expect((await page.next((message) => message.t === 'listen' && message.phase === 'heard')).text).toBe('请停下');
    const movement = await page.next(message => message.t === 'walk-stop');
    page.send({ t: 'interrupted', walkId: movement.id, x: .5, by: 'abort' });
    await expect.poll(() => model.turns.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const next = model.turns[1];
    expect(receipt(next, 'live2d_pet_move_to')).toContain(INTERRUPTED_WHILE_RUNNING);
    expect(receipt(next, 'live2d_pet_say')).toContain(NOT_EXECUTED_INTERRUPTED);
    expect(JSON.stringify(next.records)).toContain('[voice] 伙伴:请停下');
    expect(page.messages.some((message) => message.t === 'say')).toBe(false);
  });
});

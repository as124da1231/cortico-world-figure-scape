import { FakePage } from './page.ts';
import type { DesktopPetWorld } from '../../src/world.ts';
import { PetServer } from '../../src/server.ts';

export function openVoiceWindow(world: DesktopPetWorld) {
  const { server } = world as unknown as { server: PetServer };
  const url = new URL(server.windowUrl);
  const key = new URLSearchParams(url.hash.slice(1)).get('key')!;
  return FakePage.open(url.origin, new URLSearchParams({ role: 'pet', host: 'window', key }).toString());
}

export function holdSpeech(page: FakePage, frames: Iterable<Int16Array>) {
  page.send({ t: 'speak-hold', down: true });
  for (const frame of frames) page.audio(frame);
  page.send({ t: 'speak-hold', down: false });
}

import type { AsrEngine } from '../config.ts';

type Recognizer<State> = {
  state(): State;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createRecognitionRuntime<State>(ports: {
  enabled: () => boolean;
  engine: () => AsrEngine;
  recognizer: (engine: AsrEngine) => Recognizer<State> | null;
  configurationChanged: (engine: AsrEngine) => boolean;
  releaseInput: () => void;
  changed: () => void;
}) {
  let mounted = false;
  let enabledBefore = false;
  let running: AsrEngine | null = null;
  let generation = 0;
  let stopping: Promise<void> | null = null;
  let starting: { generation: number; engine: AsrEngine; task: Promise<State | null> } | null = null;
  const read = () => ports.recognizer(ports.engine())?.state() ?? null;

  function releaseRunning() {
    if (stopping) return stopping;
    const previous = running;
    running = null;
    if (!previous) return Promise.resolve();
    const task = Promise.resolve().then(() => ports.recognizer(previous)?.stop()).finally(() => {
      if (stopping === task) stopping = null;
    });
    stopping = task;
    return task;
  }

  function start() {
    if (!mounted || !ports.enabled()) return Promise.resolve(read());
    const engine = ports.engine();
    const request = generation;
    if (starting?.generation === request && starting.engine === engine) return starting.task;
    const stillWanted = () => mounted && request === generation && ports.enabled() && ports.engine() === engine;
    const task = Promise.resolve().then(async () => {
      await stopping;
      if (!stillWanted()) return read();
      const recognizer = ports.recognizer(engine);
      if (!recognizer) return null;
      if (running && running !== engine) await releaseRunning();
      if (!stillWanted()) return read();
      running = engine;
      await recognizer.start();
      if (stillWanted()) ports.changed();
      return read();
    }).finally(() => {
      if (starting?.task === task) starting = null;
    });
    starting = { generation: request, engine, task };
    return task;
  }

  async function stop() {
    generation++;
    ports.releaseInput();
    await releaseRunning();
    if (mounted) ports.changed();
  }

  return {
    read, start, stop,
    mount() {
      mounted = true;
      enabledBefore = ports.enabled();
    },
    reconcile() {
      if (!mounted) return;
      const enabled = ports.enabled();
      const turnedOn = enabled && !enabledBefore;
      enabledBefore = enabled;
      if (!enabled && (running || starting)) {
        // Invalidate an in-flight start exactly once while an engine is stopping.
        if (running || starting?.generation === generation) return stop();
      }
      if (enabled && (turnedOn || (running && (running !== ports.engine() || ports.configurationChanged(running))))) {
        return start();
      }
    },
    async shutdown() {
      mounted = false;
      const pending = starting?.task;
      await stop();
      await pending;
    },
  };
}

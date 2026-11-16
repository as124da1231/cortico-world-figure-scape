import { sceneScales, sceneScale } from './model-size.js';
import { createSceneMovement } from './scene-movement.js';
import { defineBodyAssembly, createBodyRuntime } from './body-runtime.js';

/** Composition root: validates all bindings before mounting, owns lifecycle, never a second session/window. */
export function createPetRuntime(definition, registry, ports) {
  const selected = definition.presentations[definition.defaultPresentation];
  const ids = { body: definition.body.implementation, scene: selected.scene ?? definition.scene.implementation, actions: definition.actions.implementation,
    input: definition.input.implementation, speech: definition.speech.implementation, presentation: selected.implementation };
  for (const [domain, id] of Object.entries(ids)) if (typeof registry[domain]?.[id] !== 'function') throw new TypeError(`Unbound ${domain}: ${id}`);
  const cleanups = [], domains = {};
  let disposed = false;
  let framingOwner = null, framingRequest = null, wardrobePreview = null, wardrobeDraft = null, visualPreview = null;
  const framing = {
    command(command, owner, requestId) {
      if (disposed || !body.body?.framing) return;
      if (command.kind === "restore" && framingOwner !== owner) return;
      if (command.kind === "preview") framingOwner = owner;
      framingRequest = requestId; body.body.framing(command);
    },
    restore(owner) {
      if (owner && framingOwner !== owner) return;
      if (framingOwner && body.body?.framing) {
        void Promise.resolve(body.body.framing({ kind: 'restore' })).catch(() => {});
      }
      framingOwner = framingRequest = null;
    },
    snapshot: () => ({...(body.body?.framingStatus ?? {supported:{preview:false,restore:false},status:"unsupported"}),owner:framingOwner,requestId:framingRequest}),
  };
  const diagnostics = [];
  const mount = (name, factory, bindings) => { const value = factory(bindings); if (!value) throw new TypeError(`Empty ${name} runtime`); domains[name] = value; cleanups.push(() => value.dispose?.()); return value; };
  let body, scene, presentation, actions, input, speech;
  let mode = definition.defaultPresentation, switching = false, roam = 'off';
  let scales = sceneScales(1), sizePreview = null, stagingMode = null;
  const scaleFor = target => sizePreview?.mode === target ? sizePreview.scale : scales[target];
  let activeStage;
  const positions = {};
  const framePlacements = {};
  const scenePort = new Proxy({}, { get(_target, key) { return scene[key]?.bind(scene); } });
  const presentationPort = new Proxy({}, { get(_target, key) { return presentation[key]?.bind(presentation); } });
  const movement = createSceneMovement({ current: () => scene, body: { get body() { return body?.body; } }, receipt: message => ports.receipt?.(message) });
  function stage(nextMode, wallpaper) {
    const entry = definition.presentations[nextMode];
    if (!entry) throw Error('presentation-unavailable');
    const framePlacement = framePlacements[nextMode] ??= {};
    const nextScene = registry.scene[entry.scene ?? definition.scene.implementation]({ ...ports.scene, framePlacement, composition:wallpaper?.composition?.placement });
    try {
      const nextView = registry.presentation[entry.implementation]({ body, scene: nextScene, surface: ports.surface, wallpaper });
      return { scene: nextScene, view: nextView, dispose() { nextView.dispose?.(); nextScene.dispose?.(); } };
    } catch (error) { nextScene.dispose?.(); throw error; }
  }
  function restorePosition(nextMode, fallback, useCurrent = true) {
    const point = (useCurrent ? positions[nextMode] : undefined) ?? fallback;
    const position = scene.restore(point?.x, point?.y);
    if (Number.isFinite(position.x)) body.body?.place(position.x, point?.facing, position.y, true);
  }
  try {
    body = mount('body', () => createBodyRuntime(defineBodyAssembly({ createBody: registry.body[ids.body], presentations: definition.presentations, defaultPresentation: definition.defaultPresentation })));
    activeStage = stage(mode);
    ({ scene, view: presentation } = activeStage);
    cleanups.push(() => activeStage.dispose());
    actions = mount('actions', registry.actions[ids.actions], { body, scene: scenePort, receipt: ports.receipt });
    input = mount('input', registry.input[ids.input], { body, scene: scenePort, presentation: presentationPort, events: ports.input });
    speech = mount('speech', registry.speech[ids.speech], { audio: ports.audio,
      onUnit: () => { if (!disposed) { if (body.body?.speech) body.body.speech({ kind: 'pulse' }); else body.body?.talk(); } },
      onRelease: () => { if (!disposed) body.body?.speech?.({ kind: 'release' }); },
      onMediaLevel: level => body.body?.speechLevel?.(level),
      onMediaPlan: command => body.body?.speechPlan?.(command),
      onMediaReport: value => ports.receipt?.({ t: 'speech-media', ...value }),
      bodySpeech: () => body.body?.speechStatus ?? { status: body.body ? 'legacy' : 'unbound', supported: { pulse: typeof body.body?.talk === 'function', release: false } },
    });
  } catch (error) {
    for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} }
    throw error;
  }
  const configuration = {
    // World remains persistent authority. This applies a received revision, not a second store.
    apply(patch) {
      if (disposed) return;
      if (patch.bodyEffects) body.setUserBodyEffects(patch.bodyEffects);
      if (patch.presentationScales) scales = sceneScales(patch.presentationScales.desktop, patch.presentationScales);
      else if (typeof patch.scale === 'number') scales = sceneScales(patch.scale);
      if (typeof patch.roam === 'string') {
        roam = patch.roam;
        body.body?.set({ roam: mode === 'desktop' && !switching ? roam : 'off' });
      }
      const {scale: legacyScale, ...viewPatch} = patch;
      presentation.configure(patch.presentationScales || typeof legacyScale === 'number'
        ? { ...viewPatch, scale:scaleFor(stagingMode ?? mode) } : viewPatch);
      if (patch.wallpaper && !switching && presentation.setComposition?.(patch.wallpaper)) {
        movement.cancel('wallpaper-placement-changed');
        actions.interruptWalks?.('wallpaper-placement-changed');
        input.clear?.('wallpaper-placement-changed');
        delete positions.wallpaper;
        presentation.refresh();
        restorePosition('wallpaper');
      }
    },
    previewScale(target, value) {
      if (mode !== target || switching || disposed) return;
      sizePreview = value === null ? null : {mode:target,scale:sceneScale(target,value)};
      presentation.configure({scale:scaleFor(target)});
    },
    snapshot: () => ({ bodyEffects: body.snapshot().bodyEffects, bodyEffectsStatus: body.snapshot().bodyEffectsStatus }),
  };
  function committed(pack) {
    movement.reset('body-replaced');
    framingOwner = framingRequest = null;
    wardrobePreview = wardrobeDraft = visualPreview = null;
    speech.stop('body-changed');
    // Installation is irreversible: a notification failure cannot pretend the old body survived.
    for (const [domain, notify] of [['actions', () => actions.bodyCommitted(pack)], ['presentation', () => presentation.bodyCommitted()], ['input', () => input.bodyCommitted?.()]]) {
      try { notify(); } catch (error) { diagnostics.push({ phase: 'body-committed', domain, error: String(error) }); if (diagnostics.length > 16) diagnostics.shift(); }
    }
  }
  const api = {
    definition, configuration, actions, input, speech, scene: scenePort, presentation: presentationPort, framing, movement,
    get mode() { return mode; },
    get switching() { return switching; },
    setPositions(saved) { if (saved) Object.assign(positions, saved); },
    refreshPresentation() {
      presentation.refresh();
      if (mode !== 'desktop' && !switching && body.body) {
        movement.cancel('viewport-changed');
        restorePosition(mode);
      }
    },
    transformSceneFrame(change, origin) {
      if (switching || !scene.moveFrame || body.body !== origin.body) return false;
      const previous = scene.rect();
      if (change.kind === 'resize') scene.resizeFrame(change.width);
      else scene.moveFrame(change);
      const next = scene.rect();
      if (next.x === previous.x && next.y === previous.y && next.w === previous.w) return false;
      if (!origin.moved) {
        origin.moved = true;
        movement.cancel('frame-changed');
        actions.interruptWalks?.('frame-changed');
      }
      presentation.refresh();
      if (origin.body && origin.character) {
        const { x, y, facing } = origin.character;
        origin.body.place(next.x + (x - origin.frame.x) * next.w / origin.frame.w, facing,
          typeof y === 'number' ? next.y + (y - origin.frame.y) * next.h / origin.frame.h : y, true);
      }
      return true;
    },
    rememberPosition(point) {
      if (!point || switching) return null;
      return positions[mode] = { ...scene.normalize(point), facing: point.facing };
    },
    async selectPresentation(nextMode, { signal, ready, beforeCommit, confirm, wallpaper, replace } = {}) {
      if (nextMode === mode && !replace) { await confirm?.(); return; }
      if (!body.body || switching || body.snapshot().swappingBody) throw Error('body-busy');
      signal?.throwIfAborted();
      const candidate = stage(nextMode,wallpaper), previous = activeStage, previousMode = mode;
      switching = true;
      const figure = body.body, layout = figure.layout;
      let previousSuspended = false;
      if (layout) positions[mode] = { ...scene.normalize(layout), facing: layout.facing };
      try {
        await candidate.view.ready?.(signal);
        signal?.throwIfAborted();
        previousSuspended = true;
        beforeCommit?.();
        movement.cancel('presentation-changed');
        actions.interruptWalks?.('presentation-changed');
        input.clear?.('presentation-changed');
        api.releasePreview();
        await api.restoreAppearance();
        signal?.throwIfAborted();
        ({ scene, view: presentation } = candidate);
        sizePreview = null;
        stagingMode = nextMode;
        presentation.configure({ scale:scaleFor(nextMode) });
        presentation.activate?.();
        if (nextMode !== 'desktop') figure.setWindows?.(null);
        presentation.refresh();
        const revision = figure.frameRevision;
        if (layout?.mode === 'sit' || layout?.mode === 'sleep') figure.do('stand');
        restorePosition(nextMode, nextMode === 'desktop' ? { x: .7 } : undefined, nextMode !== 'wallpaper');
        figure.set({ roam: nextMode === 'desktop' ? roam : 'off' });
        const scope = figure.markFrameScope?.();
        await ready?.(figure, revision, presentation.bounds(), signal, scope);
        await confirm?.();
        signal?.throwIfAborted();
        if (disposed || body.body !== figure) throw Error('body-changed');
        activeStage = candidate;
        mode = nextMode;
        if (nextMode === 'wallpaper') delete positions.wallpaper;
        movement.reset('presentation-changed');
        try { previous.dispose(); presentation.bodyCommitted(); }
        catch (error) { diagnostics.push({ phase: 'presentation-committed', error: String(error) }); }
      } catch (error) {
        candidate.dispose();
        ({ scene, view: presentation } = previous);
        if (!disposed && previousSuspended) {
          presentation.configure({scale:scaleFor(previousMode)});
          presentation.refresh();
          restorePosition(previousMode);
          figure.set({ roam: previousMode === 'desktop' ? roam : 'off' });
          if (layout?.mode === 'sit' || layout?.mode === 'sleep') figure.do(layout.mode);
          presentation.bodyCommitted();
        }
        throw error;
      } finally { switching = false; stagingMode = null; }
    },
    get body() { return body.body; },
    get modelGeneration() { return body.modelGeneration; },
    previewVisual(figure, owner, value, request) {
      const active = body.body;
      if (switching || !active || active.pack !== figure || body.snapshot().swappingBody) throw Error('The active model changed or is loading');
      if (visualPreview && visualPreview.owner !== owner) throw Error('Visual preview belongs to another editor');
      visualPreview = { owner, request, status: 'pending' };
      active.previewVisual(value, request);
    },
    releasePreview(owner) {
      framing.restore(owner);
      if (visualPreview && (!owner || visualPreview.owner === owner)) {
        body.body?.previewVisual(null, null);
        visualPreview = null;
      }
      body.body?.clearDraftAction?.(owner);
      if (wardrobeDraft && (!owner || wardrobeDraft.owner === owner)) {
        body.body?.draftWardrobe?.({ kind: 'restore', owner: wardrobeDraft.owner });
        wardrobeDraft = null;
      }
    },
    previewDraftWardrobe(command) {
      if (body.body?.pack !== command.figure || body.snapshot().swappingBody) return;
      if (wardrobeDraft && wardrobeDraft.owner !== command.owner) return;
      wardrobeDraft = { owner: command.owner, status: 'pending' };
      body.body.draftWardrobe?.({ kind: 'preview', owner: command.owner, groups: command.groups, bindings: command.bindings, picks: command.picks });
    },
    async previewAppearance(figure, owner, scheme, currentScheme) {
      const active = body.body;
      if (disposed || active?.pack !== figure || body.snapshot().swappingBody) throw Error('The active model changed or is loading');
      if (wardrobePreview && wardrobePreview.owner !== owner) throw Error('Appearance preview belongs to another editor');
      const preview = { owner, figure, scheme, restore: wardrobePreview?.restore ?? currentScheme, status: 'pending' };
      wardrobePreview = preview;
      try {
        await active.setScheme(scheme);
        if (wardrobePreview === preview) preview.status = 'applied';
      } catch (error) {
        if (wardrobePreview === preview) preview.status = 'failed';
        throw error;
      }
    },
    restoreAppearance(owner, currentScheme) {
      if (!wardrobePreview || (owner && wardrobePreview.owner !== owner)) return;
      const preview = wardrobePreview;
      wardrobePreview = null;
      if (body.body?.pack === preview.figure) return body.body.setScheme(currentScheme ?? preview.restore);
    },
    async draftAction(figure, command, requestId) {
      const active = body.body;
      if (disposed || !active || active.pack !== figure || body.snapshot().swappingBody) throw Error('The active model changed or is loading');
      if (!active.draftAction) throw Error('The active body does not support native draft preview');
      const report = await active.draftAction(command, requestId);
      if (disposed || body.body !== active) throw Error('The active model changed while previewing');
      return report;
    },
    async configureModel(figure,configuration) {
      const active=body.body;
      if(disposed||!active||active.pack!==figure||body.snapshot().swappingBody)throw Error('The active model changed; reload the editor');
      const previous=active.modelConfiguration;
      const applied=await active.configureModel(configuration);
      if(disposed||body.body!==active)throw Error('The body changed while applying model settings');
      if(applied.actions)actions.configurationApplied(applied.actions.filter(word=>!active.words||active.words.includes(word.id)),JSON.stringify(previous?.bindings??[])!==JSON.stringify(applied.bindings??[]));
      framingOwner=framingRequest=null;
      return applied;
    },
    async swapBody(options, hooks) {
      let candidate = null;
      const next = await body.swapBody({ ...options, bounds: presentation.bounds(), onEvent(kind, detail) {
        if (!candidate || body.body !== candidate || disposed) return;
        if (kind === 'visual-preview' && visualPreview && visualPreview.request === detail.request) {
          visualPreview.status = detail.ok ? 'applied' : 'failed';
          if (detail.reason) visualPreview.reason = detail.reason;
        }
        if (!movement.event(kind, detail)) actions.event(kind, detail);
        options.onEvent?.(kind, detail);
      } }, { ...hooks, configure(value, previous) { candidate = value; hooks?.configure?.(value, previous); } });
      committed(options.pack);
      return next;
    },
    cancelBodySwap: reason => body.cancelBodySwap(reason),
    removeBody() {
      body.removeBody();
      committed({ vocab: [] });
    },
    setUserBodyEffects: patch => configuration.apply({ bodyEffects: patch }),
    tick(dt, draw) {
      if (disposed) return;
      movement.tick(dt);
      body.body?.tick(dt, draw);
      if (draw) presentation.tick?.();
    },
    snapshot() {
      return { ...body.snapshot(), presentation: mode, definitionId: definition.id, schemaVersion: definition.schemaVersion, diagnostics: diagnostics.map(row => ({ ...row })),
        domains: { body: { configuration: body.body?.modelConfiguration ?? null, draftAction: body.body?.draftActionStatus ?? null, wardrobePreview: wardrobePreview && { ...wardrobePreview }, wardrobeDraft: body.body?.wardrobeDraftStatus ?? null, framing: framing.snapshot(), geometry: body.body?.layout?.box ? { ...body.body.layout.box } : null, modelBehavior: body.body?.modelBehavior ?? null, visualPreview, implementation: ids.body, status: disposed ? 'disposed' : body.body ? 'active' : 'unbound' },
          scene: { ...scene.snapshot(), ...movement.snapshot() }, presentation: { ...presentation.snapshot(), mode, switching }, actions: actions.snapshot(), input: input.snapshot(),
          speech: speech.snapshot?.() ?? { implementation: ids.speech, status: disposed ? 'disposed' : 'mounted' } } };
    },
    dispose() {
      if (disposed) return; disposed = true;
      movement.cancel('disposed');
      for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch (error) { console.warn('[pet-runtime] cleanup failed', error); } }
    },
  };
  return api;
}

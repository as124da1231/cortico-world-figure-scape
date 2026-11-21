import type { TouchProfile } from '../../web/framework/touch-geometry.js';

export type CharacterTask = 'framing' | 'bindings' | 'wardrobe' | 'touch' | 'behavior' | 'mouth' | 'source';
export type CharacterOrigin = 'live2d-model' | 'figure-pack' | 'spriter' | 'cabin-world';
export interface CharacterEditorSource {
  id: string;
  sourceId: string;
  kind: 'live2d-model' | 'figure-pack';
  origin: CharacterOrigin;
  builtin?: boolean;
  tasks: CharacterTask[];
}
/** A Figure pack's user preferences. The empty object uses the author defaults. */
export interface FigureSettings { scheme?: string; touch?: TouchProfile; visual?: ModelProfile['visual'] }
export type FigureSettingsPatch = { scheme?: string | null; touch?: TouchProfile | null; visual?: ModelProfile['visual'] | null };
type Names = Record<string, string>;
export interface FigureEditorState {
  character: CharacterEditorSource & { kind: 'figure-pack' };
  name: string;
  author?: string;
  axes: Array<{ id: string; name: Names; options: Array<{ id: string; name: Names }> }>;
  presets: Array<{ id: string; name: Names; pick?: Record<string, string> }>;
  actions: Array<{ id: string; kind: 'expression' | 'motion'; names: Record<string, string[]>; about?: Record<string, string> }>;
  current: string;
  worn?: string;
  active: boolean;
  settings: FigureSettings;
  revision: string;
}
export interface FigureSaveResult {
  saved: true;
  settings: FigureSettings;
  revision: string;
  applied: boolean;
  worn?: string;
  error?: string;
}

/** Data crossing the model-resource boundary. No filesystem, renderer or Coo dependency. */
export interface NativeBinding {
  word: string; resource: string; overlays?: string[]; release?: string; nativeOnly?: boolean;
  reason?: string; confidence?: number;
}
export interface WardrobeGroup {
  id: string; name: string; slot?: 'outfit' | 'parts' | 'accessories'; custom?: boolean; en?: string;
  options: Array<{ id: string; name: string; resource: string }>;
}
export interface ModelCrop { mode: 'full' | 'upper'; edge: 'flat' | 'round'; line: number; curve: number; feather: number; transition: number }
export interface ModelProfile {
  version: 1;
  crop?: ModelCrop;
  touch?: TouchProfile;
  mouth?: { mode: 'auto' | 'mapped' | 'off'; targets: string[] };
  bindings?: NativeBinding[];
  wardrobe?: WardrobeGroup[];
  gaze?: { enabled: boolean; speed: number };
  motion?: { kind: 'roam' | 'stand' };
  facing?: 'fixed' | 'mirror';
  visual?: { hue: number; brightness: number };
  emotionEffect?: 'native' | 'kaomoji' | 'orb' | 'flow' | 'bubbles' | 'softglow';
  emotionEffectSize?: 'small' | 'medium' | 'large';
  catalogFingerprint?: string;
  fit: { mode: 'contain'; anchor: 'bottom'; padding: [number, number]; offset: [number, number]; zoom: number; autoFit: false };
}
export interface ModelNativeCatalog {
  fingerprint: string;
  words: { expressions: string[]; motions: string[] };
  resources: Array<{ id: string; kind: string; title: string; classification: string; seconds: number; release?: string; parameters?: unknown[]; channels?: string[]; wardrobeError?: string }>;
  warnings: string[]; truncated: boolean;
}
export interface ModelEditorState {
  loadedCatalogFingerprint?: string; catalog?: ModelNativeCatalog; catalogFingerprint?: string;
  sourceId: string; modelFile: string; profile: ModelProfile; saved: boolean; revision: string;
}
export interface PreparedRawModel { id: string; sourceId: string; directory: string }
/** Resource-independent edits supported by the current direct body instance. */
export interface ModelConfiguration {
  version: 1; revision: string; fit: ModelProfile['fit'];
  gaze: { enabled: boolean; speed: number };
  bindings?: NativeBinding[];
  visual?: ModelProfile['visual'];
  actions?: DirectModelResource['actions'];
  touch?: TouchProfile;
}
/** Raw body resources are not installable Figure packages. Host vocabulary/appearance
 * adapters may project this description; loading uses its direct renderer entry. */
export interface DirectModelResource {
  version: 1; kind: 'live2d-model'; id: string; sourceId: string; sourceHash: string;
  title: string; sourceLabel?: string; cover?: boolean; generatedCover?: boolean; entry: {id:string;[key:string]:unknown};
  appearance: Array<{id:string;name:Record<string,string>;options:Array<{id:string;name:Record<string,string>}>}>;
  actions: Array<{id:string;kind:'expression'|'motion';names:Record<string,string[]>;about:Record<string,string>;seconds:number}>;
  walk: boolean;
  effectsReach?: number;
  configuration?: ModelConfiguration;
}
/** A provider owns source files, revision validation and immutable prepared resources. */
export interface ModelResources {
  readonly provider: string;
  readonly modelDirectory: string;
  hasModel?(id: string): boolean;
  directModels?(): DirectModelResource[];
  libraryModels?(selected: string): DirectModelResource[];
  resolveLibraryModel?(id: string, signal: AbortSignal): Promise<string>;
  directModel?(id: string): DirectModelResource | null;
  retainPreview?(id: string): (() => void) | null;
  removeModel?(id: string, protectedIds: readonly string[]): Promise<{ id: string; removed: boolean }>;
  cacheState?(protectedIds: readonly string[]): unknown;
  pruneCache?(protectedIds: readonly string[]): Promise<unknown>;
  directAsset?(id:string,path:string): string|null;
  runtimeAsset?(path: string): string | null | Promise<string | null>;
  saveGeneratedCover?(id: string, png: Uint8Array): Promise<boolean>;
  /** Persist desired runtime settings for this resource; null requires a new candidate. */
  prepareConfiguration?(id:string,saved:ModelEditorState):Promise<ModelConfiguration|null>;
  prepare(file: string, signal: AbortSignal, options?: { librarySelection: string }): Promise<PreparedRawModel>;
  source?(file: string): Promise<ModelEditorState>;
  saveSourceProfile?(file: string, bindings: NativeBinding[], expectedRevision: string, expectedCatalogFingerprint: string, signal?: AbortSignal): Promise<ModelEditorState>;
  editor?(figure: string): Promise<ModelEditorState | null>;
  validateProfile?(figure: string, value: unknown, expectedRevision: string, expectedCatalogFingerprint?: string): Promise<ModelProfile>;
  saveProfile?(figure: string, value: unknown, expectedRevision: string, expectedCatalogFingerprint?: string): Promise<ModelEditorState>;
}

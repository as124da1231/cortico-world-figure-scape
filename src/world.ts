import { SCENE_SIZE_LIMITS, sceneScales } from '../web/framework/model-size.js';
import { createPresentationService, presentationMode, scenePosition, type PresentationMode } from './framework/presentation-service.ts';
import { createWallpaperLibrary } from './framework/wallpaper-library.ts';
import { createCabinWorld, type CabinRuntime, type CabinState } from './framework/cabin-world.ts';
import { cabinFigureSources, writeCabinFigure } from './framework/cabin-figures.ts';
import { createHash } from 'node:crypto';
import { CABIN_TOOLS } from './framework/cabin-tools.ts';
import { createImportUpload } from './live2d/import-upload.ts';
// @ts-expect-error Shared plain-data runtime configuration boundary.
import {modelConfiguration} from '../web/model-configuration-contract.js';
import { createBodyControls } from './framework/body-controls.ts';
import { createBodyTransaction } from './framework/body-transaction.ts';
import { createDraftActionDomain } from './framework/draft-action-domain.ts';
import { createFrameworkConsole } from './framework/console.ts';
import { createAppearanceDomain } from './framework/appearance-domain.ts';
import { preparedFigureSkin } from './live2d/model-selection.ts';
import { modelForCoo } from './live2d/coo-resource-adapter.ts';
import { createActionDomain } from './framework/action-domain.ts';
import { createModelDomain } from './framework/model-domain.ts';
import { createModelApplication } from './framework/model-application.ts';
import { createFrameworkConfiguration } from './framework/configuration.ts';
import { figureSchemes, validateFigureScheme, type createFigureLibrary } from './framework/figure-library.ts';
import type { CharacterTask, FigureEditorState, FigureSaveResult, FigureSettingsPatch, ModelConfiguration, ModelResources } from './framework/model-contract.ts';
import { BODY_EFFECT_KEYS, bodyEffectsFor, readBodyEffectsFeedback } from './body-effects.ts';
/**
 * DesktopPetWorld: the pet on the desktop as a World.
 *
 * Output goes through four tools that drive the pet page (bubble, options, going somewhere,
 * expressions and motions). Input arrives as events: speech heard through the pet window's
 * microphone (transcribed in this process by FunASR's SenseVoice or by Whisper, by Windows' own recognizer, or by an
 * OpenAI-compatible transcription service), typed text, answers to `live2d_pet_ask`, and touches
 * (poke, petting, being thrown). The page reports what actually happened; receipts and
 * events state only that.
 *
 * Processes owned here: the page server (while mounted), the manually opened pet window,
 * and the system recognizer's helper (voice input on, engine `system`). FunASR and
 * Whisper run in this process once their model is downloaded.
 *
 * Two languages are read at each use: the model-text language for what the bot reads, and the app
 * language (`DesktopPetWorldOptions.language`) for what the person reads: the pages' text (the
 * snapshot carries it, so the pages follow a change within PREFS_SYNC_MS), status lines, voice
 * hints, the default name for the person, and which recognizer and recognition language voice
 * input uses by default. The console's text follows the console request's language.
 */
import type { spawn } from 'node:child_process';
import { openLocalBrowser } from './open-browser.ts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, extname, join } from 'node:path';
import type {
  BlobInput, EventEnvelope, Logger, OutputTap, RunPhase, ToolCallContext, ToolDef, ToolOutcome, TriggerMode, World, WorldWebUiDecl,
  WorldHost, WorldLamp, WorldPanelDecl, WorldStreamSocket,
} from 'cortico/core/types.ts';
import { nowIso, shortTime } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import type { DeepPartial } from 'cortico/world.ts';
import {
  DESKTOP_PET_ID, MAX_HOVER_BUTTONS, PET_ACTIONS, SELF_KEYS, THRESHOLD_DB_MAX, THRESHOLD_DB_MIN, TOUCH_KINDS, USER_MAX, asrEngineFor,
  desktopPetConfigGroups, directSettings, hoverButtonList, selfAdjustMode, touchWakes,
  type AsrEngine, type DesktopPetConfigSection, type PetSkin, type PetTheme, type RoamMode, type SelfKey,
} from './config.ts';
import { capFor, cutChars, petText, type PetText } from './i18n/index.ts';
// @ts-expect-error Figure shares the same cue validation with the renderer.
import { parsePerformanceCues } from '../live2d-runtime/pack/backends/performance-plan.js';
import { createTtsService } from './speech/tts-service.ts';
import { createSpeechPlanner } from './speech/speech-planner.ts';
import { PetServer, type PageMessage } from './server.ts';
import { StatusTracker, type DescribeTool } from './status.ts';
import { createModelCoverJobs, type CoverRenderer } from './live2d/model-cover-jobs.ts';
import { WindowHost, resolveHostCommand } from './window-host.ts';
import { describeHostReason } from './host-reason.ts';
import { RuntimeStore, type ModelSpec } from './runtime/store.ts';
import { SENSEVOICE, SherpaAsr, WHISPER, type SherpaModelKind, type SherpaModule, type SherpaState } from './asr/sherpa.ts';
import { SystemRecognizer, systemRecognizerSupported, type SystemRecognizerState, type SystemSentence } from './asr/system-recognizer.ts';
import { createRecognitionRuntime } from './asr/recognition-runtime.ts';
import { TranscriptionApi, type TranscriptionState } from './asr/transcription-api.ts';
import { Packer, Segmenter, type SegmentSink, type Utterance } from './asr/segmenter.ts';
import { joinSpeech, looksHallucinated } from './asr/result.ts';
import { toSimplified } from './asr/simplify.ts';
import { estimateSeconds, parseActions, parseScript, vocabChange, vocabTable, type VocabWord } from './script.ts';
import { replyBubbleSeconds } from '../web/framework/bubble-timing.js';
import { ActivityGroup, ChatReplyFallback, ChatSockets, DESKTOP_CHAT_SOURCE, SELF_TYPE, chatItem, chatPage, chatRefs, isDesktopChatEvent, type ChatFigure } from './chat.ts';
import { readWindowCompatibility, type WindowCompatibility } from './framework/window-compatibility.ts';
import { ASK_OPTION_MAX, MODEL_TOOL_DECLS, petToolDecls } from './tools.ts';
import { lookOf, modelName, nameIn, type FigurePack, type MoveTarget } from './packs.ts';
import { moveChange, moveTable, readMove } from './moves.ts';
import { createEditService } from './framework/edit-service.ts';
import { createEditorBackend } from './framework/editor-backend.ts';
import { createAdaptationService } from './live2d/adaptation.ts';
import { createResourceConsole } from './framework/resources-console.ts';
import type { createSdkService } from './live2d/sdk-service.ts';
import type { createModelIntake } from './live2d/model-intake.ts';
import { dressTable, planSettings, type SettingChange } from './self.ts';
import { MODEL_TEXT, type ModelLanguage, type ModelText } from './model-text.ts';

import { createModelServices } from './framework/model-services.ts';
import { readControlLayout, validateControlLayout } from '../web/framework/control-layout.js';
import { TOUCH_REGIONS, readTouchProfile, readTouchRegion, touchRule, type TouchRegion } from '../web/framework/touch-geometry.js';
import { WORKSPACE_PANELS } from './framework/workspace.ts';

/** The console panels, titled in `language`. */
function desktopPetPanelDecls(language: Language = 'zh'): WorldPanelDecl[] {
  return WORKSPACE_PANELS.map(([id, cn, en]) => ({ id, title: language.startsWith('zh') ? cn : en }));
}

/** The culture of Windows' speech recognizer preferred for each app language, where its language has more than one. */
const SYSTEM_CULTURES: Readonly<Record<string, string>> = {
  zh: 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en-US', fr: 'fr-FR', de: 'de-DE', 'es-419': 'es-MX', 'pt-BR': 'pt-BR', it: 'it-IT', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR',
};

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
/** The environment prompt template of each model-text language; English falls back to Chinese while its file is missing. */
const ENV_PROMPT_FILES: Record<ModelLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

/** Longest `live2d_pet_quiet`: a quiet that outlasts a day is a setting, which `live2d_pet_set` changes. */
const QUIET_MAX_MIN = 24 * 60;
const FRAME_MS = 20;
const WALK_TIMEOUT_MS = 30_000;
/** Touches of one kind closer than this are reported as one event with a count. */
const TOUCH_MERGE_MS = 2500;
/** How long a confirmation bubble waits for an answer, counted from when the page shows it. */
const CONFIRM_TIMEOUT_MS = 60_000;
/** How long a confirmation waits in all, while the page has not shown it (lines ahead of it in the queue). */
const CONFIRM_UNSHOWN_MS = 180_000;
/** History events read per chat page load; the page asks for the ones before by cursor. */
const CHAT_PAGE_EVENTS = 300;
/** A message from the chat page: text cut to this, up to IMAGES_MAX images of at most IMAGE_MAX_BYTES each, as the console World takes them. */
const CHAT_TEXT_MAX = 4000;
const IMAGES_MAX = 8;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** How often config edits from the console reach the pages: short enough that the size slider moves the pet with it. */
const PREFS_SYNC_MS = 150;
/** Talk-key polling interval: well under the shortest key tap. */
const MIC_RELEASE_MS = 500;

/**
 * Run controls an embedding app lends the pet's menu. Each button shows only when its control is
 * lent: pause/resume needs `isPaused` and `setPaused`, settings `openSettings`, the power button
 * `quit`. Without any the menu shows the actions alone.
 */
export interface PetBotControls {
  isPaused?(): boolean;
  setPaused?(paused: boolean): void;
  openSettings?(): void;
  /** Shows the app's computer-use switch together with what turning it on risks; while computer use is off, `live2d_pet_cua_open_settings` calls it. */
  /** Shows the chat page; the bubble's expand button carries its draft there. */
  openChat?(): void;
  /** Shows the embedding app's own dress page; the menu's 「装扮」 then opens it instead of the pet's dress window. */
  openDress?(): void;
  openScenes?(): void;
  openWallpapers?(enter?: boolean): void;
  openCabin?(): void;
  openVoiceSettings?(): void;
  /** Shows the embedding app's list of its Worlds; the hover button 「我的 World」 shows only when this is lent. */
  openWorlds?(): void;
  quit?(): void;
  /** The power button's label, e.g. "Quit Coopanion", read when the menu opens. */
  quitLabel?: string | (() => string);
  /** Runs the embedding app's introduction again (the console's `pet.guide` panel method). */
  guide?(): void;
}

/**
 * One step of a conversation an embedding app holds through the pet's bubble (`dialog`): Coo says
 * `text`, then shows `input`, if any, in the same bubble. `step` draws progress dots, `closable`
 * a close button, `back` a button with that label before the dots.
 */
export interface PetDialog {
  text: string;
  /** Words in `text` drawn in the theme color, such as a name said for the first time. */
  marks?: string[];
  /** Expressions and motions (vocabulary words) played as the line starts. */
  actions?: string[];
  step?: [number, number];
  closable?: boolean;
  back?: string;
  input?: PetDialogInput;
}

/**
 * - `buttons`: a row of buttons, answered with the index; a button's `hover` is the label it shows while pointed at or
 *   focused. `keys` shows a key cap above them, pressed `taps` times over and over, the last press held (a talk key
 *   tapped, then held).
 * - `choices`: cards to try out before `confirm`, each with an optional level tag, a small `note` under its label, and icon (a web/ui.js
 *   `ICONS` name, or `image`, a `data:image/…` URL such as a service's logo); a card's `line` is typed when it is picked and
 *   its `motion` played (standing still, strolling, running about) until another is picked, and its `actions` (vocabulary
 *   words) once. A card's `skin` dresses the body in it while the card is picked, and stays on when it is the answer;
 *   closing the step puts the body back as the config has it. A card's `tint` (light and dark theme), or else the eye colour of
 *   its skin's Coo palette, colours its icon.
 *   `list` lays the cards out one per row; `hint` is a line beside the confirm button with `mark`, a word in it, drawn
 *   after the `icon` of that name. `more` is a last card that,
 *   clicked, unfolds its `options` after the others in place; the answer's index counts on through them, and a `value`
 *   among them shows them from the start.
 * - `text`: a text box answered with the text; `secret` hides what is typed, `suggestions` are offered
 *   as the person types, `link` opens a page in the browser, `alt` is a second way out, answered as `{ alt: true }`.
 * - `progress`: a bar the app moves with `update({ progress })`; it ends when the app closes it.
 */
export type PetDialogInput =
  | { kind: 'buttons'; options: Array<{ label: string; primary?: boolean; hover?: string }>; keys?: string; taps?: number }
  | { kind: 'choices'; options: PetDialogChoice[]; more?: { label: string; icon?: string; image?: string; options: PetDialogChoice[] }; value?: number; confirm: string; list?: boolean; hint?: { text: string; mark: string; icon: string } }
  | { kind: 'text'; submit: string; placeholder?: string; value?: string; secret?: boolean; maxLength?: number; suggestions?: string[]; link?: { label: string; url: string }; alt?: string }
  | { kind: 'progress'; label?: string };
export type PetDialogChoice = {
  label: string; level?: string; note?: string; icon?: string; image?: string; line?: string; motion?: 'still' | 'walk' | 'run';
  actions?: string[]; skin?: Partial<PetSkin>; tint?: { light: string; dark: string };
};

/**
 * How a step ended: a button or card (`index`), typed text, the text box's `alt`, the close
 * button, the back button, the line read to the end with nothing to answer (`done`, also a progress step the app
 * closed), or no pet page to show it on.
 */
export type PetDialogAnswer =
  | { index: number } | { text: string } | { alt: true } | { closed: true } | { back: true } | { done: true } | { unavailable: true };

/** What the app changes on a step while it is up: the line, and a progress step's bar (0–1, or null while there is no telling). */
export interface PetDialogUpdate {
  text?: string;
  progress?: number | null;
}

export interface PetDialogHandle {
  readonly answer: Promise<PetDialogAnswer>;
  update(patch: PetDialogUpdate): void;
  /** Takes the step off the bubble; an unanswered one resolves `done`. */
  close(): void;
}

/**
 * How a confirmation ended: one of the choices (`always` only when three were offered), closed, no answer in time,
 * or no pet page to ask on.
 */
export type ConfirmResult = 'yes' | 'always' | 'no' | 'dismissed' | 'timeout' | 'unavailable';

export interface DesktopPetWorldOptions {
  cfg: DesktopPetConfigSection;
  timezone: string;
  persist: (patch: DeepPartial<DesktopPetConfigSection>) => void;
  runtimesRoot: () => string;
  windowProfile?: string;
  coverRenderer?: CoverRenderer;
  figureLibrary?: ReturnType<typeof createFigureLibrary>;
  modelsDir: () => string;
  wallpaperDir?: string;
  cabinRuntime?: CabinRuntime;
  phone?: ReturnType<typeof import('./phone-link/service.ts').createPhoneConnection>;
  /** Downloads; tests pass a local stand-in. */
  fetchImpl?: typeof fetch;
  /** Loads sherpa-onnx; tests pass a fake recognizer. */
  loadSherpa?: () => SherpaModule;
  /** The speech models to download; tests pass small ones. */
  funasrModel?: ModelSpec;
  whisperModel?: ModelSpec;
  /** The transcription service's API Key, read at each request, and where the voice panel saves a new one; absent, there is none. */
  asrApiKey?: () => string;
  storeAsrApiKey?: (key: string) => void;
  /** The bot's name for the menu header, the chat page and computer use's question; read at each use. */
  botName?: () => string;
  controls?: PetBotControls;
  /** Starts the system recognizer's helper; tests pass a fake. */
  spawnSystemRecognizer?: typeof spawn;
  modelService?: ModelResources;
  modelIntake?: ReturnType<typeof createModelIntake>;
  tts?: Omit<Parameters<typeof createTtsService>[0], 'selected'>;
  serviceSecrets?: { secret(name: string): string | undefined; storeSecret(name: string, value: string): void };
  planner?: Pick<Parameters<typeof createSpeechPlanner>[0], 'secret' | 'storeSecret'>;
  sdkService?: ReturnType<typeof createSdkService>;
  /** Called after the bot changed settings itself (`live2d_pet_set`), so an app watching the config knows it was not the person. */
  onBotChange?: () => void;
  /** Called when the pet window comes onto the desktop or leaves it: shown or hidden, opened or closed. */
  onDesktopChange?: (onDesktop: boolean) => void;
  /** What the status bubble shows for a tool call. */
  describeTool?: DescribeTool;
  /** The language of what the bot reads from this World (`model-text.ts`), read at each use; Chinese when absent. */
  modelLanguage?: () => ModelLanguage;
  /** The app language: what the person reads (see the module header). Read at each use; `zh` when absent. */
  language?: () => Language;
  /**
   * The language the bot is to talk to the person in, named in the model-text language, when it is
   * not that language itself; it becomes one line of the environment prompt (`{{pet.reply}}`). Null
   * or absent: no such line.
   */
  replyLanguage?: () => string | null;
}

type SherpaEngine = Exclude<AsrEngine, 'system' | 'api'>;
type BackendState = SherpaState | SystemRecognizerState | TranscriptionState;

interface PendingWalk {
  resolve: (text: string) => void;
  timer: NodeJS.Timeout;
  /** The figure's target it goes to, as the bot reads its name; absent for a default target. */
  target?: string;
  /** The call's interrupt asked the page to stop the walk. */
  stopping?: boolean;
}

interface PendingAsk {
  id: string;
  question: string;
  options: string[];
}

interface TouchBatch {
  kind: string;
  region?: TouchRegion;
  areaNote?: string;
  area?: { id: string; name: string };
  rule?: ReturnType<typeof touchRule>;
  reaction?: string;
  count: number;
  woke: boolean;
  asleep: boolean;
  x: number | null;
  crashed: boolean;
  timer: NodeJS.Timeout;
}

interface HeardLine { text: string; at: number; ms: number; dropped?: boolean }

interface PendingConfirm {
  resolve: (result: ConfirmResult) => void;
  /** How many choices the bubble shows: the last one is no. */
  choices: number;
  /** Ends the wait with 'timeout': CONFIRM_UNSHOWN_MS from the ask, then CONFIRM_TIMEOUT_MS from when it was shown. */
  timer: NodeJS.Timeout;
  shown: boolean;
}

/** Characters a step's line is shown for per second (typing, then reading), for its time limit. */
const DIALOG_CPS = 4;

let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** The first expression among a beat's words for the chat page's tag: its id, and its first name in each language of the body's vocabulary. */
function moodOf(actions: readonly string[], vocab: readonly VocabWord[]): { mood?: Record<string, string> } {
  const v = actions.map((a) => vocab.find((e) => e.id === a)).find((e) => e?.kind === 'expression' && e.id !== 'neutral');
  if (!v) return {};
  return { mood: { id: v.id, ...Object.fromEntries(Object.entries(v.names).flatMap(([lang, names]) => (names[0] ? [[lang, names[0]]] : []))) } };
}

/** Images of a chat page message: the whole batch is taken, or the reason it is not. */
function parseChatImages(raw: unknown, user: string, s: PetText['chat'], m: ModelText): { ok: true; blobs: BlobInput[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, blobs: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: s.badImages };
  if (raw.length > IMAGES_MAX) return { ok: false, reason: s.tooManyImages(IMAGES_MAX) };
  const blobs: BlobInput[] = [];
  for (const [i, item] of raw.entries()) {
    const img = (item ?? {}) as { mime?: unknown; base64?: unknown; name?: unknown };
    if (typeof img.mime !== 'string' || !IMAGE_MIMES.has(img.mime)) return { ok: false, reason: s.badMime(String(img.mime)) };
    const bytes = typeof img.base64 === 'string' ? Buffer.from(img.base64, 'base64') : Buffer.alloc(0);
    if (bytes.length === 0) return { ok: false, reason: s.emptyImage };
    if (bytes.length > IMAGE_MAX_BYTES) return { ok: false, reason: s.bigImage(IMAGE_MAX_BYTES / 1048576) };
    const name = typeof img.name === 'string' && img.name.trim() ? img.name.trim().slice(0, 120) : undefined;
    blobs.push({ bytes, mime: img.mime, ...(name ? { name } : {}), fallbackText: m.image(user, i + 1, raw.length) });
  }
  return { ok: true, blobs };
}

/** A picture the typing box carries to the chat page with its draft, as the page's composer holds it; the page checks it again on send. */
interface DraftImage { name: string; mime: string; base64: string; bytes: number; width: number; height: number }

function draftImages(raw: unknown): DraftImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, IMAGES_MAX).flatMap((item) => {
    const i = (item ?? {}) as Partial<Record<keyof DraftImage, unknown>>;
    if (typeof i.mime !== 'string' || !IMAGE_MIMES.has(i.mime) || typeof i.base64 !== 'string' || !i.base64) return [];
    if (i.base64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 || typeof i.width !== 'number' || typeof i.height !== 'number') return [];
    const name = typeof i.name === 'string' && i.name ? i.name.slice(0, 120) : 'image';
    const bytes = typeof i.bytes === 'number' ? i.bytes : Math.floor(i.base64.length * 3 / 4);
    return [{ name, mime: i.mime, base64: i.base64, bytes, width: i.width, height: i.height }];
  });
}

interface SkinSelection { skin: Partial<PetSkin>; fromBot: boolean }

export class DesktopPetWorld implements World {
  readonly id = DESKTOP_PET_ID;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private readonly cfg: DesktopPetConfigSection;
  private readonly server: PetServer;
  /** The syllables of the pet page's speech; its dictionaries load the first time a text needs them. */
  private windowHost: WindowHost | null = null;
  private readonly modelCovers?: ReturnType<typeof createModelCoverJobs>;
  /** The tray's "click through": every click passes through the pet window. Not saved: it lasts until the Core stops. */
  private clickThrough = false;
  private readonly frameworkAppearance: ReturnType<typeof createAppearanceDomain>;
  private readonly sceneMessages = new Map<string, Promise<EventEnvelope | null>>();
  private readonly frameworkActions: ReturnType<typeof createActionDomain<VocabWord>>;
  private readonly frameworkModel: ReturnType<typeof createModelDomain<PageMessage, SkinSelection>>;
  private readonly frameworkConfiguration: ReturnType<typeof createFrameworkConfiguration>;
  private readonly draftAction: ReturnType<typeof createDraftActionDomain>;
  private readonly bodyControls: ReturnType<typeof createBodyControls>;
  private readonly frameworkConsole: ReturnType<typeof createFrameworkConsole>;
  private frameworkRuntime: { figure: string; snapshot: Record<string, unknown> } | null = null;
  private bodyEffectsFeedbackKey = '';
  private bodyEffectsFeedback: ReturnType<typeof readBodyEffectsFeedback> | null = null;
  private readonly store: RuntimeStore;
  private funasr: SherpaAsr | null = null;
  private whisper: SherpaAsr | null = null;
  private system: SystemRecognizer | null = null;
  private api: TranscriptionApi | null = null;
  /** The engine the running backend belongs to; a config change starts the other one. */
  private readonly recognition: ReturnType<typeof createRecognitionRuntime<BackendState>>;
  /** `cua.enabled` as syncPrefs last saw it: switching it off ends the engine process. */
  /** The person asked to send what was heard now, without waiting for the pause that ends a sentence. */
  private committing = false;
  private readonly segmenter: Segmenter;
  private readonly packer = new Packer({ minChars: 1 });
  private readonly queue: Utterance[] = [];
  private transcribing = false;
  private packTimer: NodeJS.Timeout | null = null;
  private wasSpeaking = false;
  private screen: { w: number; h: number } | null = null;
  /** The pet window said it is hidden (its menu's or the tray's 「隐藏」); reset when a page connects. */
  private petHidden = false;
  /** `onDesktop` as last told to `onDesktopChange`, null before the first time. */
  private desktopTold: boolean | null = null;
  private busyUntil = 0;
  private readonly walks = new Map<string, PendingWalk>();
  private ask: PendingAsk | null = null;
  private touch: TouchBatch | null = null;
  /** A touch has woken the bot and no turn has ended since; touches until then wait for the next wake. */
  private touchWoke = false;
  /** The local date of the last event's time stamp; the next event on another date names its date again. */
  private stampDay = '';
  private prefsKey = '';
  private prefsTimer: NodeJS.Timeout | null = null;
  /** Where the pet window last said the pet stands, measured as `petX` is; written by `savePosition` on stop. */
  private standX: number | null = null;
  /** How far down it stands, as `petY` is measured, when the body reported one with that position. */
  private standY: number | null = null;
  private readonly voiceSockets = new Set<WorldStreamSocket>();
  private lastLevelAt = 0;
  private readonly heard: HeardLine[] = [];
  private readonly counts = { utterances: 0, delivered: 0, dropped: 0 };
  private micState: { state: string; detail: string | null } = { state: 'off', detail: null };
  private devices: Array<{ id: string; label: string }> = [];
  private readonly confirms = new Map<string, PendingConfirm>();
  private readonly dialogs = new Map<string, (a: PetDialogAnswer) => void>();
  /** The pet's local microphone button is held down. */
  private talking = false;
  /** The audio stream is released after the local microphone button is released. */
  private micHeld = false;
  private micReleaseTimer: NodeJS.Timeout | null = null;
  /** Counts cancelled captures; a transcription begun before a cancel is dropped when it lands. */
  private cancels = 0;
  private level = -100;
  private readonly chat = new ChatSockets();
  private readonly chatReply = new ChatReplyFallback();
  private desktopChatCursor: number | null = null;
  private phoneHistoryCursor: number | null = null;
  private readonly activity = new ActivityGroup();
  /** What the status bubble shows. */
  private readonly status: StatusTracker;
  /** Computer use; its tools and its part of the environment prompt are there while `cua.enabled` is on. */
  private phase: RunPhase | null = null;
  /** The person's messages (typed, spoken) not yet delivered to the bot, by cursor. */
  private readonly pendingChat = new Set<number>();
  /** The first cursor of this run: Core queues this World's undelivered events from before it again at start. */
  private startCursor = 0;
  /** Text the bubble's expand button carried, until a chat page takes it. */
  private draft: { text: string; images: DraftImage[] } | null = null;
  private pausedShown: boolean | null = null;
  private botShown: string | null = null;

  /** Installs packs the dressing page sends, when the app named a directory for them. */
  private readonly adaptation: ReturnType<typeof createAdaptationService> | null;
  private readonly speechPlanner: ReturnType<typeof createSpeechPlanner> | null;
  private modelServices: ReturnType<typeof createModelServices> | null = null;
  private readonly tts: ReturnType<typeof createTtsService> | null;
  private readonly editService: ReturnType<typeof createEditService>;
  private readonly editorBackend: ReturnType<typeof createEditorBackend>;
  private readonly presentationService: ReturnType<typeof createPresentationService>;
  private readonly invokeResources: ReturnType<typeof createResourceConsole>;

  private readonly wallpapers: ReturnType<typeof createWallpaperLibrary>;
  private readonly cabinWorld: ReturnType<typeof createCabinWorld>;
  private cabinFigureImport?: Promise<string>;
  private cabinRestoreBody = false;
  private cabinHideTimer: NodeJS.Timeout | undefined;
  private cabinSceneReported = false;
  private readonly wallpaperUpload: ReturnType<typeof createImportUpload>;

  private readonly legacyPresentationScale: number;

  constructor(private readonly opts: DesktopPetWorldOptions) {
    this.wallpapers = createWallpaperLibrary(() => opts.wallpaperDir ?? join(opts.modelsDir(), '.wallpapers'));
    this.wallpaperUpload = createImportUpload({ importUpload:this.wallpapers.importUpload, cancel:() => false }, 'wallpaper');
    this.cfg = opts.cfg;
    this.cabinWorld = createCabinWorld({
      config:() => this.cfg.cabinWorld,
      persist:cabinWorld => opts.persist({ cabinWorld }),
      bundled:opts.cabinRuntime,
      changed:active => this.cabinVisibility(active),
      presented:() => this.reportCabinScene(true),
      conversation:() => this.cabinConversation(),
      sendMessage:(id,text) => this.sendCabinMessage(id,text),
      prepareBody:(signal,model) => this.prepareCabinBody(signal,model),
    });
    this.legacyPresentationScale = opts.cfg.window.scale;
    this.tts = opts.tts ? createTtsService({ ...opts.tts, selected: () => this.windowVisible(), activeService: () => this.modelServices?.resolve('tts') }) : null;
    this.speechPlanner = opts.planner ? createSpeechPlanner({
      ...opts.planner, config: () => this.cfg.planner ?? {}, persist: planner => this.opts.persist({ planner }),
      activeService: () => {
        const service = this.modelServices?.resolve('planner');
        return service ? { id: 'bound', name: '', provider: service.provider, endpoint: service.endpoint, model: service.model, apiKey: service.key } : service;
      },
      reportUsage: (usage, model) => this.host?.reportUsage(usage, { model, label: 'Live2D 桌宠表演编排' }),
    }) : null;
    this.bodyControls = createBodyControls({
      selected: () => this.selectedModel(),
      connected: () => this.server.petConnected,
      busy: () => this.frameworkModel.snapshot().busy || this.presentationService.busy(),
      report: () => this.frameworkRuntime,
      send: command => this.server.sendPet(command),
    });
    const transaction = this.bodyTransaction;
    this.presentationService = createPresentationService({
      transaction,
      desired: () => presentationMode(this.cfg.presentationMode) ? this.cfg.presentationMode : 'desktop',
      persist: presentationMode => this.opts.persist({ presentationMode }),
      connected: () => this.server.petInWindow, visible: () => !this.petHidden,
      model: () => this.selectedModel(), modelBusy: () => this.frameworkModel.snapshot().busy,
      send: message => this.server.sendPet(message),
      scene: () => (this.frameworkRuntime?.snapshot.domains as Record<string, unknown> | undefined)?.scene ?? null,
    });
    this.frameworkModel = createModelDomain<PageMessage, SkinSelection>({
      transaction,
      bodyId: DESKTOP_PET_ID,
      externallyBusy: () => this.presentationService.busy(),
      resources: opts.modelService,
      framing: this.bodyControls.framing,
      behavior: this.bodyControls.behavior,
      selected: () => this.selectedModel(),
      available: () => !!opts.modelService,
      prepare: async (file, signal, options) => {
        if (basename(file).toLowerCase() === 'figure.json' && opts.figureLibrary) return opts.figureLibrary.prepare(file, signal);
        return (await opts.modelService!.prepare(file, signal, options)).id;
      },
      resolveSelection: async (figure, signal) => {
        const pack = this.packs().find(pack => pack.id === figure);
        if (!pack) throw Error('The resource is no longer available');

        const resolved = pack.rawModel ? await opts.modelService?.resolveLibraryModel?.(figure, signal) : figure;
        return { figure: resolved ?? figure };
      },
      load: (figure, signal, options) => this.modelApplication.load(this.modelSkin(figure, options?.skin), signal),
      configure: async(figure,configuration,signal)=>{
        const report=await this.modelApplication.configure(figure,configuration,signal);
        if (report?.ok === true && figure === this.selectedModel()) this.bodyTouch = configuration.touch;
        if(report?.ok===true&&configuration.actions&&figure===this.cfg.skin.figure){
          const known=new Set(Array.isArray(report.words)?report.words.filter((word):word is string=>typeof word==='string'):[]);
          this.bodyWords.set(figure,known);
          this.bodyVocabulary.set(figure,configuration.actions.filter(word=>known.has(word.id)));
          const note=this.vocabNote();
          if(note)void this.push('desktop-live2d-pet.figure','desktop-live2d-pet.figure',this.t.figureNote(note),'debounce');
        }
        return report;
      },
      applied: report => report?.ok === true,
      commit: (figure, report, options) => {
        this.modelCovers?.enqueue(figure);
        const skin = this.modelSkin(figure, options?.skin);
        if (options?.fromBot) this.recordBotLook(skin);
        this.persistSkin(skin);
        if (report) {
          if (typeof report.request === 'string') this.server.sendPet({ t: 'confirm-figure-load', request: report.request });
          this.onFigure(report, options?.fromBot);
        }
      },
    });
    this.frameworkAppearance = createAppearanceDomain({
      selected: () => this.selectedModel(), axes: () => this.currentPack()?.manifest.axes ?? [],
      scheme: () => { const pack = this.currentPack(); return pack ? lookOf(this.cfg.skin) : ''; },
      available: () => this.server.petConnected, busy: () => this.frameworkModel.snapshot().busy,
      observed: () => this.server.petConnected ? this.appearanceReceipt : null,
      persist: scheme => {
        this.persistSkin({ ...this.cfg.skin, scheme });
      },
      looks: () => this.modelPresets(), saveLooks: looks => this.opts.persist({ looks }),
      applyLook: skin => this.applySkin(skin),
    });
    this.frameworkActions = createActionDomain({
      selected: () => this.selectedModel(), available: () => this.server.petConnected,
      busy: () => this.frameworkModel.snapshot().busy, vocabulary: () => this.vocab(),
      runtime: () => (this.bodyControls.snapshot()?.domains as Record<string, unknown> | undefined)?.actions ?? null,
      send: command => this.server.sendPet(command),
    });
    this.frameworkConfiguration = createFrameworkConfiguration({
      read: () => this.cfg.bodyEffects,
      persist: patch => this.opts.persist(patch),
      apply: () => this.syncPrefs(),
      observed: () => this.currentBodyEffectsFeedback(),
    });
    this.draftAction = createDraftActionDomain({
      selected: () => this.selectedModel(),
      busy: () => this.frameworkModel.snapshot().busy || this.presentationService.busy(),
      ready: () => {
        const domains = this.bodyControls.snapshot()?.domains as { body?: { draftAction?: { supported?: boolean } } } | undefined;
        return domains?.body?.draftAction?.supported === true;
      },
      send: command => this.server.sendPet(command),
    });
    this.editService = createEditService({
      model: this.frameworkModel, body: this.bodyControls, actions: this.draftAction,
      appearance: this.frameworkAppearance,
      previewVisual: (figure, owner, value) => {
        const report = this.bodyControls.behavior() as { visual?: { hue?: boolean; brightness?: boolean } } | null;
        if (!report?.visual?.hue || !report.visual.brightness) throw Error('The active body does not support visual adjustments');
        if (this.presentationService.busy() || this.frameworkModel.snapshot().busy) throw Error('The body is busy');
        const id = nextId('visual');
        if (!this.server.sendPet({ t: 'preview-model-visual', figure, owner, value, id })) throw Error('The main window is not connected');
        return id;
      },
      previewAppearance: (figure, owner, scheme) => this.server.sendPet({ t: 'preview-edit-appearance', figure, owner, scheme }),
      previewDraftWardrobe: (figure, owner, profile, picks) => this.server.sendPet({
        t: 'preview-draft-wardrobe', figure, owner, groups: profile.wardrobe, bindings: profile.bindings, picks,
      }),
      selected: () => this.selectedModel(),
      release: (figure, owner) => { this.server.sendPet({ t: 'release-edit-preview', figure, owner }); },
    });
    if (opts.coverRenderer) this.modelCovers = createModelCoverJobs({
      origin: () => this.server.origin,
      model: id => opts.modelService?.directModel?.(id),
      render: opts.coverRenderer,
    });
    this.frameworkConsole = createFrameworkConsole({
      draftAction: this.draftAction,
      model: this.frameworkModel,
      selectModel: (figure, id) => this.frameworkModel.select(figure, undefined, id),
      appearance: this.frameworkAppearance,
      actions: this.frameworkActions,
      body: this.bodyControls,
      configuration: this.frameworkConfiguration,
      state: () => this.frameworkState(),
      runtimeState: () => this.petState(),
      modelImported: id => { this.modelCovers?.enqueue(id); },
      resources: () => {
        const selected = this.selectedModel();
        const activeSource = opts.modelService?.directModel?.(selected)?.sourceId;
        return this.libraryPacks().map(pack => ({
          id: pack.id, name: nameIn(pack.manifest.name, this.appLanguage),
          kind: pack.rawModel ? 'live2d-model' : 'figure-pack', active: pack.id === selected,
          ...(pack.builtin ? { builtin:true } : {}),
          ready: pack.id === selected && this.bodyReady(), failed: pack.id === this.figureFailed,
          ...(pack.id === this.figureFailed && this.bodyMissing ? { failure: this.bodyMissing } : {}),
          loading: pack.id === selected && !this.bodyReady() && !this.figureFailed && this.windowHost?.state().phase === 'running',
          wardrobe: pack.manifest.axes.length > 0 || pack.manifest.presets.length > 0,
          sourceId: pack.rawModel?.sourceId, source: pack.rawModel?.sourceLabel, origin: pack.manifest.source,
          sourceActive: !!activeSource && activeSource === pack.rawModel?.sourceId,
          coverJob: pack.rawModel && !pack.rawModel.cover && !pack.rawModel.generatedCover ? this.modelCovers?.state(pack.id) : undefined,
          cover: pack.rawModel?.cover || pack.rawModel?.generatedCover
            ? pack.base + 'models/' + pack.id + (pack.rawModel.cover ? '/cover.png' : '/cover.generated.png')
            : !pack.rawModel && pack.manifest.thumb ? pack.base + pack.manifest.thumb : undefined,
        }));
      },
      unknownMethod: method => this.ui.console.unknownMethod(`framework.${method}`),
    });
    this.recognition = createRecognitionRuntime<BackendState>({
      enabled: () => this.cfg.asr.enabled && this.windowVisible(),
      engine: () => this.engine(),
      recognizer: engine => this.recognizer(engine),
      configurationChanged: engine => engine === 'system' ? this.system?.languageChanged === true
        : engine === 'api' ? this.api?.configChanged === true : this.sherpa(engine)?.configChanged === true,
      releaseInput: () => this.cancelSpeech(),
      changed: () => this.syncPrefs(),
    });
    this.adaptation = opts.modelIntake && opts.modelService?.saveSourceProfile ? createAdaptationService({
      intake: opts.modelIntake, resources: opts.modelService,
      settings: () => this.cfg.adaptation, persist: adaptation => this.opts.persist({ adaptation }),
    }) : null;
    this.invokeResources = createResourceConsole({
      adaptation: this.adaptation ?? undefined,
      sdk: opts.sdkService, intake: opts.modelIntake, models: opts.modelService,
      protectedModels: () => {
        const model = this.frameworkModel.snapshot();
        return [this.selectedModel(), ...(model.busy && model.candidate ? [model.candidate] : [])];
      },
      modelBusy: () => this.frameworkModel.snapshot().busy || this.presentationService.busy(),
      open: (file, id) => this.frameworkConsole.invoke('openModel', [file, id]),
      importModel: (file, id) => this.frameworkConsole.invoke('importModel', [file, id]),
      unknownMethod: method => this.ui.console.unknownMethod(method),
    });
    this.status = new StatusTracker((status) => this.server.sendPet({ t: 'status', status }), (...args) => opts.describeTool?.(...args), () => this.ui.busy);
    this.segmenter = new Segmenter(this.cfg.asr.segment, FRAME_MS);
    this.segmenter.setSink(this.sink);
    this.store = new RuntimeStore({ runtimesRoot: opts.runtimesRoot, modelsDir: opts.modelsDir, fetchImpl: opts.fetchImpl, funasrModel: opts.funasrModel, whisperModel: opts.whisperModel, text: () => this.ui });
    this.editorBackend = createEditorBackend(this.frameworkModel, () => join(opts.modelsDir(), '.editor-drafts'), () => structuredClone(this.cfg.touch), {
      read: id => this.figureEditorState(id),
      save: (id, profile, revision) => this.saveFigureSettings(id, profile, revision),
      apply: (id, revision) => this.applyFigureSettings(id, revision),
    });
    this.server = new PetServer({
      editorInvoke: (method, args) => this.editorBackend.invoke(method, args),
      port: () => this.cfg.port,
      webDir: WEB_DIR,
      snapshot: () => this.snapshot(),
      onPetMessage: (msg, reply) => this.onPage(msg, reply),
      onAudio: (frame) => this.onAudio(frame),
      onPetConnect: () => {
        this.frameworkRuntime = this.bodyEffectsFeedback = this.windowCompatibility = null;
        this.petHidden = this.cabinWorld.state().phase === 'active';
        this.bodyMissing = null;
        if (this.petHidden) this.server.sendPet({t:'hide'});
        this.log?.info('桌宠页面已连接');
        this.tellDesktop();
        if (this.windowVisible() && this.cfg.asr.enabled) void this.startVoiceBackend();
      },
      onPetDisconnect: () => this.onPageGone(),
      onSkin: (skin) => this.applySkin(skin),
      onPrefs: (prefs) => this.savePrefs(prefs),
      looks: () => this.modelPresets(),
      onLooks: (looks) => { this.frameworkAppearance.savePresets(looks); },
      packs: () => this.packs(),
      figureAsset: (id, path) => opts.figureLibrary?.asset(id, path),
      figureSettings: id => opts.figureLibrary?.settings(id),
      models: opts.modelService,
      coverJobs: this.modelCovers,
      importModels: opts.modelIntake?.importUpload,
      wallpaperAsset: this.wallpapers.asset,
      wallpaperSettings: this.wallpapers.settings,
      media: this.tts?.audio,
      mediaPlan: this.tts?.plan,
      language: () => this.appLanguage,
      text: () => this.ui,
      overlay: () => this.cfg.window.exportOverlay,
    });
  }

  /* ---------- figures ---------- */

  /** Vocabulary mismatches already reported by the renderer. */
  private readonly vocabularyWarnings = new Set<string>();
  /** The figure (and a pack's pick, `id:scheme`) the pet page last said it shows, null before it said. */
  private figureShown: string | null = null;
  private appearanceReceipt: {figure:string;scheme:string}|null = null;
  /** The selected model failed to render. Its saved selection remains available for recovery. */
  private figureFailed: string | null = null;
  private windowCompatibility: WindowCompatibility | null = null;
  /** Why the selected model could not render. */
  private bodyMissing: string | null = null;
  /** The words each pack's body said it knows when the page last loaded it; a body that did not say is taken at its manifest's word. */
  private readonly bodyWords = new Map<string, ReadonlySet<string>>();
  private bodyTouch: ModelConfiguration['touch'];
  private readonly bodyTransaction = createBodyTransaction();
  private readonly bodyVocabulary = new Map<string, VocabWord[]>();
  /** The words the bot was last told it may use: its prompt's at start, then a `[figure]` event's or a `live2d_pet_set` receipt's. */
  private toldVocab: readonly VocabWord[] = [];
  /** The figure's own `live2d_pet_move_to` targets the bot was last told of, as `toldVocab` the words. */
  private toldMoves: readonly MoveTarget[] = [];
  /** A look the bot put on itself: the pet page's report of it is not told back (the receipt said it). */
  private botLook: string | null = null;
  /** `live2d_pet_quiet` in force: what it overrides, until when, and the settings it found (a change to them ends it). */
  private quiet: { sound: boolean; roam: RoamMode; until: number; base: { sound: boolean; roam: RoamMode }; timer: NodeJS.Timeout } | null = null;

  packs(): FigurePack[] {
    return [...(this.opts.modelService?.directModels?.() ?? []).map(modelForCoo), ...(this.opts.figureLibrary?.list() ?? [])];
  }

  private modelPresets() {
    return this.cfg.looks.filter(look => !!look.skin.figure && look.skin.figure !== 'coo');
  }

  private libraryPacks(): FigurePack[] {
    const library = this.opts.modelService?.libraryModels?.(this.selectedModel());
    return library ? [...library.map(modelForCoo), ...(this.opts.figureLibrary?.list() ?? [])] : this.packs();
  }

  private selectedModel(): string {
    const id = this.cfg.skin.figure;
    const service = this.opts.modelService;
    return id && ((service?.hasModel?.(id) ?? service?.directModels?.().some(model => model.id === id)) || this.opts.figureLibrary?.find(id)) ? id : '';
  }

  private effectiveSkin(): PetSkin {
    if (this.selectedModel()) return this.cfg.skin;
    return { ...this.cfg.skin, figure: undefined, scheme: '' };
  }

  private currentPack(): FigurePack | null {
    const figure = this.selectedModel();
    return figure === this.figureFailed ? null : this.packs().find(pack => pack.id === figure) ?? null;
  }
  /** The words the body on screen does: its pack's vocabulary, less the words its body said it does not know. */
  private vocab(): VocabWord[] {
    const pack = this.currentPack();
    if (!pack) return [];
    if(pack.rawModel&&this.bodyVocabulary.has(pack.id))return this.bodyVocabulary.get(pack.id)!;
    const known = this.bodyWords.get(pack.id);
    return known ? pack.manifest.vocab.filter((w) => known.has(w.id)) : pack.manifest.vocab;
  }
  /** The `live2d_pet_move_to` targets of the body on screen's pack, beyond the default ones. */
  private moves(): MoveTarget[] {
    if (this.presentationService.mode() === 'room' && this.currentPack()?.manifest.can.walk) {
      return [ ['door', '门口'], ['center', '房间中央'], ['chair', '椅子'], ['sofa', '沙发'], ['bed', '床'] ].map(([id, zh]) => ({ id: id === 'center' ? 'room-center' : id, name: { zh, en: id }, about: { zh: '小屋中的目标', en: 'A target in the room' }, params: [] }));
    }
    return this.currentPack()?.manifest.moves ?? [];
  }

  /** The language of what the bot reads from this World. */
  private get language(): ModelLanguage {
    return this.opts.modelLanguage?.() ?? 'zh';
  }

  /** The text table of that language. */
  private get t(): ModelText {
    return MODEL_TEXT[this.language];
  }

  /** The app language: what the person reads. */
  private get appLanguage(): Language {
    return this.opts.language?.() ?? 'zh';
  }

  /** The text table of the app language. */
  private get ui(): PetText {
    return petText(this.appLanguage);
  }

  /** What events and bubbles call the person: the set name, else the app language's default. */
  get userName(): string {
    return this.cfg.user || this.ui.defaultUser;
  }

  /** Traditional characters heard become Simplified: the setting is on and the app language is Simplified Chinese. */
  private get simplifies(): boolean {
    return this.cfg.asr.simplified && this.appLanguage === 'zh';
  }

  /** Sends the pages what changed in the config now, without waiting for the next look; an app calls it after it changes the app language. */
  refresh(): void {
    this.syncPrefs();
  }

  /**
   * How the words the bot may use and the places it may go changed since it was last told, or ''. From here the
   * bot counts as told those of now.
   */
  private vocabNote(): string {
    const now = this.vocab(), moves = this.moves();
    const notes = [vocabChange(this.toldVocab, now, this.language), moveChange(this.toldMoves, moves, this.language)];
    this.toldVocab = now;
    this.toldMoves = moves;
    return notes.filter(Boolean).join('\n\n');
  }

  /** What the body looks like now, with its picked options. */
  private bodyText(pack: FigurePack | null): string {
    if (!pack) return '';
    const { language, t } = this;
    const m = pack.manifest;
    const scheme = lookOf(this.cfg.skin);
    const picks = scheme.split('-');
    const preset = m.presets.find((p) => p.id === scheme);
    const chosen = m.axes.map((a, i) => {
      const o = a.options.find((x) => x.id === (preset?.pick[a.id] ?? picks[i])) ?? a.options[0]!;
      return t.pick(modelName(a.name, a.id, language), modelName(o.name, o.id, language));
    });
    return t.body(modelName(m.name, pack.id, language), nameIn(m.about, language), chosen);
  }

  /** Update the observed body and its confirmed action vocabulary. */
  private onFigure(msg: PageMessage, fromBot = false): void {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id || id !== this.selectedModel()) return;
    const before = this.figureShown;
    const packs = this.packs();
    const pack = packs.find((p) => p.id === id) ?? null;
    if (msg.ok !== true) {
      this.bodyTouch = undefined;
      this.appearanceReceipt = null;
      this.figureShown = null;
      this.publishReadiness();
      this.figureFailed = id;
      const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : this.t.reasonUnknown;
      this.bodyMissing = reason;
      this.log?.warn(`Live2D: figure "${id}" failed to load: ${reason}`);

      this.releaseDesktopOperations();
      const note = this.vocabNote();
      const name = modelName(pack?.manifest.name, id, this.language);
      void this.push('desktop-live2d-pet.figure', 'desktop-live2d-pet.figure', this.t.figureFailed(name, reason, note), 'flush',
        { meta: { figure: { kind: 'failed', name: { ...pack?.manifest.name, id }, reason } } });
      return;
    }
    if ('words' in msg) {
      if (Array.isArray(msg.words)) this.bodyWords.set(id, new Set(msg.words.filter((w): w is string => typeof w === 'string')));
      else this.bodyWords.delete(id);
    }
    this.bodyTouch = pack && !pack.rawModel ? this.opts.figureLibrary?.settings(id).touch : undefined;
    if(pack?.rawModel){
      let actions=pack.manifest.vocab;
      try {
        const configuration = modelConfiguration(msg.configuration) as ModelConfiguration;
        actions = configuration.actions ?? actions;
        this.bodyTouch = configuration.touch;
      } catch { /* Older bodies report only their supported words. */ }
      const known=this.bodyWords.get(id);
      this.bodyVocabulary.set(id,known?actions.filter((word:VocabWord)=>known.has(word.id)):actions);
    }
    const known = this.bodyWords.get(id);
    const unknown = pack && known ? pack.manifest.vocab.filter((w) => !known.has(w.id)).map((w) => w.id) : [];
    const problem = `身体 ${id} 的词表里有身体不认得的词,没给 bot 用:${unknown.join('、')}`;
    if (unknown.length && !this.vocabularyWarnings.has(problem)) { this.vocabularyWarnings.add(problem); this.log?.warn(problem); }
    this.figureFailed = null;
    this.bodyMissing = null;
    const shown = `${id}:${typeof msg.scheme === 'string' ? msg.scheme : ''}`;
    this.figureShown = shown;
    this.appearanceReceipt = {figure:id,scheme:typeof msg.scheme === 'string' ? msg.scheme : ''};
    this.publishReadiness();
    if (fromBot) { this.botLook = null; return; }
    let look: string | null = null;
    // what the chat page says of a switch the person made: another figure, or another dress of the same one
    let change: ChatFigure | null = null;
    if (before !== null && before !== shown) {
      if (shown === this.botLook) this.botLook = null;
      else {
        look = this.t.figureNow(this.bodyText(pack));
        change = { kind: before.split(':')[0] === id ? 'dress' : 'figure', name: { ...pack?.manifest.name, id } };
      }
    }
    const note = this.vocabNote();
    const text = look && note ? `${look}\n${note}` : look ?? (note ? this.t.figureNote(note) : null);
    if (text) void this.push('desktop-live2d-pet.figure', 'desktop-live2d-pet.figure', text, 'debounce', change ? { meta: { figure: change } } : {});
  }

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.startCursor = host.store.latestCursor() + 1;
    this.log = host.log;
    // the words and targets the prompt is rendered with, until the bot is told otherwise
    this.toldVocab = this.vocab();
    this.toldMoves = this.moves();
    await this.tts?.load();
    if (this.opts.serviceSecrets && this.opts.tts) {
      const voice = this.tts?.savedSettings();
      const planner = this.speechPlanner?.state();
      this.modelServices = createModelServices({
        ...this.opts.serviceSecrets,
        directory: join(this.opts.tts.dataDir, 'desktop-live2d-pet'),
        voiceProfile: provider => this.tts?.voiceProfile(provider) ?? {},
        transcription: { language: () => 'auto', timeoutMs: () => 12_000, log: host.log },
        changed: async use => {
          if (use === 'asr' && this.api && this.cfg.asr.enabled && this.engine() === 'api' && this.windowVisible()) await this.startVoiceBackend();
        },
      });
      await this.modelServices.load(() => [
        ...Object.entries(voice?.profiles ?? {}).map(([provider, fields]) => ({
          use: 'tts' as const, protocol: provider === 'openai' ? 'openai-compatible' : 'tts:' + provider,
          name: provider, endpoint: String(fields.endpoint ?? ''), model: String(fields.model ?? ''),
          fields, key: this.opts.tts?.readKey(provider), active: voice?.provider === provider,
        })),
        ...(planner?.services ?? []).map(service => ({
          use: 'planner' as const, protocol: ['custom', 'openai'].includes(String(service.provider)) ? 'openai-compatible' : 'planner:' + String(service.provider),
          name: service.name || String(service.provider), endpoint: service.endpoint, model: service.model,
          key: this.speechPlanner?.legacyKey(service.id), active: planner?.selectedId === service.id,
        })),
        ...(this.cfg.asr.api.baseUrl && this.cfg.asr.api.model ? [{
          use: 'asr' as const, protocol: 'openai-compatible', name: '在线转写',
          endpoint: this.cfg.asr.api.baseUrl, model: this.cfg.asr.api.model,
          key: this.opts.asrApiKey?.(), active: true,
        }] : []),
      ]).catch(error => host.log.warn('模型服务配置读取失败: ' + (error instanceof Error ? error.message : String(error))));
    }
    await this.server.start();
    await this.opts.phone?.start(this.server.origin, code => host.log.warn('Figure Pet 连接服务异常', { code }));
    if (this.modelCovers) this.modelCovers.start(this.libraryPacks().filter(pack => pack.rawModel).map(pack => pack.id));
    this.windowHost = new WindowHost(host.log);
    const sherpa = (engine: SherpaEngine, kind: SherpaModelKind) => new SherpaAsr({
      kind,
      model: () => this.sherpaModel(engine),
      language: () => this.asrLanguage(),
      text: () => this.ui,
      threads: () => this.cfg.asr.threads,
      log: host.log,
      load: this.opts.loadSherpa,
    });
    this.funasr = sherpa('funasr', SENSEVOICE);
    this.whisper = sherpa('whisper', WHISPER);
    this.system = new SystemRecognizer({
      language: () => this.asrLanguage(),
      culture: () => SYSTEM_CULTURES[this.appLanguage] ?? '',
      text: () => this.ui,
      timeoutMs: () => this.cfg.asr.timeoutMs,
      log: host.log,
      spawnImpl: this.opts.spawnSystemRecognizer,
    });
    this.api = new TranscriptionApi({
      config: () => this.transcriptionBinding().api,
      key: () => this.transcriptionBinding().key,
      language: () => this.asrLanguage(),
      timeoutMs: () => this.cfg.asr.timeoutMs,
      text: () => this.ui,
      log: host.log,
    });
    this.recognition.mount();


    this.prefsKey = this.prefsSignature();
    this.prefsTimer = setInterval(() => { this.syncPrefs(); this.syncConversation(); }, PREFS_SYNC_MS);
  }

  async stop(): Promise<void> {
    await this.opts.phone?.stop();
    clearTimeout(this.cabinHideTimer);
    this.cabinHideTimer = undefined;
    await this.cabinWorld.leave(null,false);
    this.tts?.stopAll();
    this.editService.release();
    this.opts.modelIntake?.cancel();
    await this.modelCovers?.stop();
    await this.frameworkModel.stop();
    const recognitionStopped = this.recognition.shutdown();
    this.status.clear();
    if (this.quiet) clearTimeout(this.quiet.timer);
    this.quiet = null;
    if (this.prefsTimer) clearInterval(this.prefsTimer);
    this.prefsTimer = null;
    this.desktopChatCursor = null;
    this.phoneHistoryCursor = null;
    this.savePosition();
    if (this.packTimer) clearTimeout(this.packTimer);
    this.packTimer = null;
    if (this.touch) clearTimeout(this.touch.timer);
    this.touch = null;
    this.touchWoke = false;
    if (this.micReleaseTimer) clearTimeout(this.micReleaseTimer);
    this.micReleaseTimer = null;
    for (const c of this.confirms.values()) { clearTimeout(c.timer); c.resolve('unavailable'); }
    this.confirms.clear();
    for (const d of this.dialogs.values()) d({ unavailable: true });
    this.dialogs.clear();
    for (const w of this.walks.values()) { clearTimeout(w.timer); w.resolve(this.t.walkWorldStopped); }
    this.walks.clear();
    for (const s of this.voiceSockets) s.close('stopped');
    this.voiceSockets.clear();
    this.chat.closeAll('stopped');
    await this.windowHost?.stop();
    await recognitionStopped;
    await this.funasr?.stop();
    await this.whisper?.stop();
    await this.system?.stop();
    await this.api?.stop();
    await this.server.stop();
    this.host = null;
  }

  onTurnEnded(): void {
    const store = this.host?.store;
    const fallback = store ? this.chatReply.finish(store, [this.id, DESKTOP_CHAT_SOURCE]) : '';
    if (fallback) void this.say({ script: fallback }, true);
    this.touchWoke = false;
  }

  outputTap(): OutputTap {
    return {
      externalizes: () => false,
      onEvent: (event) => {
        this.chatReply.observe(event);
        if (this.server.petConnected && !this.petHidden) this.status.onEvent(event);
      },
      onRoundEnd: () => this.chatReply.endRound(),
      onAbort: () => this.chatReply.abort(),
    };
  }

  onRunPhase(phase: RunPhase): void {
    if (phase.state === 'delivering' && phase.round === undefined && this.host) {
      this.chatReply.begin(this.host.store.latestCursor());
    }
    this.phase = phase;
    this.status.onPhase(phase);
    if (this.activity.observe(phase, Date.now())) this.chat.broadcast({ t: 'activity', steps: this.activity.steps, startedAt: this.activity.startedAt });
    if (phase.state === 'idle') void this.closeActivity();
    this.chat.broadcast({ t: 'phase', phase });
  }

  /**
   * A message that waited shows where the bot took it in: the steps done before that are recorded
   * first, then a `delivered` record the history places the message at.
   */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    const input = outcome === 'delivered' ? this.chatReply.accept(events) : undefined;
    const rememberInput = () => input === undefined ? undefined : this.record({ kind: 'conversation-input', cursor: input }, '');
    const cursors = events
      .filter((e) => this.pendingChat.delete(e.cursor) || (e.cursor < this.startCursor && chatItem(e)?.kind === 'user'))
      .map((e) => e.cursor);
    if (!cursors.length) { void rememberInput(); return; }
    void (async () => {
      await this.closeActivity();
      const later = (this.host?.store.latestCursor() ?? 0) > Math.max(...cursors);
      const at = outcome === 'delivered' && later
        ? await this.record({ kind: 'delivered', cursors }, `送达了 ${cursors.map((c) => `#${c}`).join('、')}`)
        : null;
      this.chat.broadcast({ t: 'settled', cursors, outcome, ...(at !== null ? { at } : {}) });
      void rememberInput();
    })();
  }

  /** The steps since the pet's last line become one record: before each line, when the loop goes idle, before a waiting message is placed. */
  private async closeActivity(): Promise<void> {
    const group = this.activity.take(Date.now());
    if (!group) return;
    this.chat.broadcast({ t: 'activity', steps: null });
    await this.record({ kind: 'activity', ...group }, `做了:${group.steps.join('、')}`);
  }

  /**
   * One frame from a chat page:
   * - `hello`: the history, the messages still pending, the loop's phase and the pause, and a draft the bubble carried
   * - `more { before }`: the history before that cursor
   * - `send { id, text, images }`: a message typed on the page, delivered with `preempt`; answered with `sent { id, cursor }` or `rejected { id, reason }`
   * - `now { cursor }`: a pending message delivered at once, stopping what the bot is doing (`interrupt`)
   * - `withdraw { cursor }`: a pending message taken back; answered with `withdrawn { cursor }` to every page, or `notice` when it was already delivered
   * - `answer { askId, index | text }`: the open `live2d_pet_ask` answered on the page
   *
   * `init` and `ask` frames carry the id of the question that can still be answered (`askId`, null
   * when none). `init` and `older` carry `refs`: the `withdrawn` and `delivered` records in that
   * stretch of history about messages before it, which the page applies to the pages it loads later.
   */
  private async onChat(msg: Record<string, unknown>, socket: WorldStreamSocket, language: Language, view: 'timeline' | 'conversation' = 'timeline'): Promise<void> {
    const host = this.host;
    const s = petText(language).chat;
    switch (msg.t) {
      case 'hello': {
        this.syncConversation();
        const page = host ? chatPage(host.store, this.id, CHAT_PAGE_EVENTS, undefined, view) : { items: [], more: false };
        if (host) this.desktopChatCursor = host.store.latestCursor();
        this.chat.send(socket, {
          t: 'init', ...page, pending: [...this.pendingChat],
          askId: this.ask?.id ?? null, phase: this.phase,
          activity: this.activity.steps.length ? { steps: this.activity.steps, startedAt: this.activity.startedAt } : null,
          paused: this.opts.controls?.isPaused?.() ?? false, user: this.userName, bot: this.botName(),
          imagesSeen: host?.modelFacts.accepts('image/jpeg') ?? false,
        });
        if (this.draft !== null) { this.chat.send(socket, { t: 'draft', ...this.draft }); this.draft = null; }
        return;
      }
      case 'more': {
        if (!host || typeof msg.before !== 'number' || !Number.isSafeInteger(msg.before) || msg.before < 1) return;
        this.chat.send(socket, { t: 'older', ...chatPage(host.store, this.id, CHAT_PAGE_EVENTS, msg.before, view) });
        return;
      }
      case 'send': {
        const id = msg.id;
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, CHAT_TEXT_MAX) : '';
        const images = parseChatImages(msg.images, this.userName, s, this.t);
        if (!images.ok) { this.chat.send(socket, { t: 'rejected', id, reason: images.reason }); return; }
        if (!text && images.blobs.length === 0) return;
        if (!host || !socket.open) {
          this.chat.send(socket, { t: 'rejected', id, reason: s.offline }); return;
        }
        const key = typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? 'chat:' + id : undefined;
        const e = await this.commitChatMessage(key, async () => {
          const sent = await this.push('desktop-live2d-pet.message', 'desktop-live2d-pet.chat', this.t.typed(this.userName, text), 'preempt',
            { meta: { via: 'chat', text }, ...(images.blobs.length ? { blobs: images.blobs } : {}) });
          if (sent) this.server.sendPet({ t: 'said', via: 'chat', text, images: images.blobs.length, cursor: sent.cursor });
          return sent;
        });
        this.chat.send(socket, e ? { t: 'sent', id, cursor: e.cursor } : { t: 'rejected', id, reason: s.notSent });
        return;
      }
      case 'now': {
        if (!host?.promotePending || typeof msg.cursor !== 'number') return;
        await host.promotePending(msg.cursor, 'interrupt');
        return;
      }
      case 'withdraw': {
        const cursor = msg.cursor;
        if (!host?.withdrawPending || typeof cursor !== 'number') return;
        if (!await host.withdrawPending(cursor)) {
          this.chat.send(socket, { t: 'notice', cursor, text: s.tooLate });
          return;
        }
        this.pendingChat.delete(cursor);
        void this.record({ kind: 'withdrawn', cursor }, `撤回了 #${cursor}`);
        this.chat.broadcast({ t: 'withdrawn', cursor });
        this.server.sendPet({ t: 'said-withdrawn', cursor });
        return;
      }
      case 'answer': {
        return this.onAnswer(msg, 'chat');
      }
    }
  }

  private syncConversation(): void {
    const store = this.host?.store;
    if (!store) return;
    if (!this.chat.size) this.desktopChatCursor = null;
    if (!this.windowVisible() || this.presentationService.mode() !== 'phone') this.phoneHistoryCursor = null;
    const chatCursor = this.desktopChatCursor, phoneCursor = this.phoneHistoryCursor;
    if (chatCursor === null && phoneCursor === null) return;
    const latest = store.latestCursor();
    const fromCursor = Math.min(chatCursor ?? latest, phoneCursor ?? latest) + 1;
    if (fromCursor > latest) return;
    const peer = store.range({ source: DESKTOP_CHAT_SOURCE, fromCursor, toCursor: latest }).filter(isDesktopChatEvent);
    if (chatCursor !== null && chatCursor < latest) {
      for (const event of peer) {
        if (event.cursor <= chatCursor) continue;
        const item = chatItem(event);
        if (item) this.chat.broadcast({ t: 'item', item });
        const { withdrawn, delivered } = chatRefs([event]);
        for (const cursor of withdrawn) this.chat.broadcast({ t: 'withdrawn', cursor });
        if (delivered.length) this.chat.broadcast({ t: 'settled', cursors: delivered.map(([cursor]) => cursor), outcome: 'delivered', at: event.cursor });
      }
      this.desktopChatCursor = latest;
    }
    if (phoneCursor !== null && phoneCursor < latest) {
      const own = store.range({ source: this.id, fromCursor: phoneCursor + 1, toCursor: latest });
      const events = [...own, ...peer.filter(event => event.cursor > phoneCursor)].sort((a, b) => a.cursor - b.cursor);
      this.sendPhoneHistory(events.flatMap(event => chatItem(event) ?? []), chatRefs(events).withdrawn);
      this.phoneHistoryCursor = latest;
    }
  }

  private sendPhoneHistory(items: ReturnType<typeof chatPage>['items'], withdrawn: number[], replace = false): void {
    const messages = items.flatMap(item => item.kind === 'user'
      ? [{ cursor: item.cursor, side: 'user', text: item.text, images: item.images?.length ?? 0 }]
      : item.kind === 'say' ? [{ cursor: item.cursor, side: 'pet', text: item.beats.map(beat => beat.text).join('\n'), images: item.images?.length ?? 0 }] : []);
    if (replace || messages.length || withdrawn.length) {
      this.server.sendPet({ t: 'phone-history', replace, messages, withdrawn });
    }
  }

  private openPhoneHistory(): void {
    const store = this.host?.store;
    if (!store || !this.windowVisible() || this.presentationService.mode() !== 'phone') return;
    this.phoneHistoryCursor = store.latestCursor();
    const page = chatPage(store, this.id, CHAT_PAGE_EVENTS, undefined, 'conversation');
    this.sendPhoneHistory(page.items, [], true);
  }

  /** The open question changed: pages let only the one still open be answered. */
  private setAsk(ask: PendingAsk | null): void {
    this.ask = ask;
    this.chat.broadcast({ t: 'ask', askId: ask?.id ?? null });
  }

  /* ---------- window ---------- */

  get petUrl(): string {
    return `${this.server.origin}/pet`;
  }

  private launchStartX: number | null = null;

  private async prepareWindowRuntime(): Promise<void> {
    if (this.packs().some(pack => pack.id === this.selectedModel() && pack.rawModel)) await this.opts.sdkService?.prepare();
  }

  openWindow(startX?: number): void {
    if (!this.windowHost || !this.server.port) return;

    if (this.windowHost.state().phase === 'running') {
      if (this.server.petInWindow && this.petHidden) this.server.sendPet({ t: 'show' });
      return;
    }
    if (!this.selectedModel()) throw Error(this.appLanguage.startsWith('zh')
      ? '请先从工作台导入并选择 Live2D 模型。' : 'Import and select a Live2D model in the workbench first.');
    this.launchStartX = typeof startX === 'number' && startX >= 0 && startX <= 1 ? startX : null;
    const managed = this.store.electron.executable();
    this.windowHost.start(resolveHostCommand(this.server.windowUrl, this.cfg.window.electronFile, managed, this.opts.windowProfile, this.cfg.window));
  }

  private async openModelEditor(model: unknown, task: unknown) {
    if (!this.server.port) throw Error('Live2D runtime is offline');
    const pack = this.opts.figureLibrary?.find(typeof model === 'string' ? model : this.selectedModel());
    if (pack) return this.openModelPage(this.server.editorUrl(pack.id, typeof task === 'string' ? task : 'wardrobe'));
    const target = await this.frameworkModel.editor(model);
    if (!target.editor || !target.figure) throw Error('请选择模型库中的原始 Live2D 模型。');
    const section = typeof task === 'string' && ['framing','bindings','wardrobe','touch','visual','behavior','mouth'].includes(task) ? task : 'framing';
    return this.openModelPage(this.server.editorUrl(target.figure, section));
  }

  private async openModelPreview(model: unknown) {
    if (!this.server.port) throw Error('Live2D runtime is offline');
    if (typeof model !== 'string' || !this.packs().some(pack => pack.id === model)) {
      throw Error(this.appLanguage.startsWith('zh') ? '模型已移出模型库，请刷新后重试。' : 'This model is no longer in the library. Refresh and try again.');
    }
    const url = new URL('/model-preview', this.server.origin);
    url.searchParams.set('model', model);
    return this.openModelPage(url.href);
  }

  private async removeCharacter(id: unknown) {
    const pack = this.packs().find(item => item.id === id);
    if (!pack) throw Error('角色已移出角色库');
    const release = this.bodyTransaction.reserve('model');
    try {
      const current = this.selectedModel(), isCurrent = current === pack.id;
      const protectedIds = isCurrent ? [] : [current];
      const result = pack.rawModel ? await this.opts.modelService?.removeModel?.(pack.id, protectedIds)
        : await this.opts.figureLibrary?.remove(pack.id, protectedIds);
      if (!result?.removed) throw Error('无法移出角色');
      this.modelCovers?.cancel(pack.id);
      if (isCurrent) {
        await this.closeDesktopWindow();
        this.persistSkin({ ...this.cfg.skin, figure: '', scheme: '' });
      }
      return result;
    } finally { release(); }
  }

  private characterWardrobe(id: unknown) {
    const pack = this.packs().find(item => item.id === id);
    if (!pack) throw Error('角色已移出角色库');
    const userLooks = this.modelPresets().filter(look => look.skin.figure === pack.id);
    const defaults = this.opts.figureLibrary?.settings(pack.rawModel?.sourceId ?? pack.id);
    return {
      axes: pack.manifest.axes, presets: [...figureSchemes(pack.manifest), ...userLooks.map(look => ({
        id: lookOf(look.skin), name: { zh: look.name, en: look.name },
      }))],
      current: pack.id === this.selectedModel() ? lookOf(this.cfg.skin) : defaults?.scheme ?? '',
      active: pack.id === this.selectedModel(),
    };
  }

  private async chooseCharacterWardrobe(id: unknown, value: unknown) {
    const pack = this.packs().find(item => item.id === id);
    if (!pack || !this.opts.figureLibrary) throw Error('角色已移出角色库');
    if (this.frameworkModel.snapshot().busy || this.presentationService.busy()) throw Error('桌宠正在切换，请稍后重试');
    const scheme = validateFigureScheme(pack.manifest, value);
    if (pack.id === this.selectedModel()) await this.applySkin({ scheme });
    await this.opts.figureLibrary.rememberWardrobe(pack.rawModel?.sourceId ?? pack.id, scheme);
    return this.characterWardrobe(id);
  }

  private figureEditorState(id: string): FigureEditorState | null {
    const library = this.opts.figureLibrary;
    const pack = library?.find(id);
    if (!pack || !library) return null;
    const settings = library.settings(id);
    const { manifest } = pack;
    const tasks: CharacterTask[] = [];
    if (manifest.vocab.length) tasks.push('bindings');
    if (manifest.axes.length || manifest.presets.length) tasks.push('wardrobe');
    tasks.push('touch', 'source');
    return {
      character: { id, sourceId: id, kind: 'figure-pack', tasks },
      name: nameIn(manifest.name, this.appLanguage), author: manifest.author,
      axes: manifest.axes, presets: figureSchemes(manifest), actions: manifest.vocab,
      current: settings.scheme ?? '', active: id === this.selectedModel(), settings, revision: library.revisionOf(settings),
    };
  }

  private async saveFigureSettings(id: string, profile: unknown, expectedRevision?: string): Promise<FigureSaveResult> {
    const library = this.opts.figureLibrary;
    const pack = library?.find(id);
    if (!pack || !library) throw Error('形象包已移出角色库');
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('形象包编辑请求无效');
    const input = profile as FigureSettingsPatch;
    const touch = input.touch == null ? input.touch : readTouchProfile(input.touch);
    const allowed = new Set(pack.manifest.vocab.map(word => word.id));
    if (touch?.rules.some(rule => rule.reaction === 'action' && (!rule.action?.word || !allowed.has(rule.action.word)))) throw Error('形象包没有这个动作');
    const settings = await library.save(id, {
      ...('scheme' in input ? { scheme: input.scheme } : {}),
      ...('touch' in input ? { touch } : {}),
    }, expectedRevision);
    const revision = library.revisionOf(settings);
    try { return await this.applyFigureSettings(id, revision); }
    catch (error) { return { saved: true, settings, revision, applied: false, error: String((error as Error).message) }; }
  }

  private async applyFigureSettings(id: string, revision: string): Promise<FigureSaveResult> {
    const report = this.figureEditorState(id);
    if (!report || report.revision !== revision) throw Error('角色配置已更新，请重新打开编辑台。');
    const { settings, current: scheme, active } = report;
    const saved = { saved: true as const, settings, revision };
    if (!active) return { ...saved, applied: false };
    try {
      const result = await this.frameworkModel.select(id, { skin: { scheme }, fromBot: false });
      return { ...saved, applied: result.applied };
    } catch (error) { return { ...saved, applied: false, error: String((error as Error).message) }; }
  }

  private async openModelPage(address: string) {
    try { await openLocalBrowser(address); }
    catch { throw Error(this.appLanguage.startsWith('zh') ? '无法打开默认浏览器，请检查系统的浏览器设置后重试。' : 'Unable to launch the default browser. Check your system browser settings and try again.'); }
    return { open: true, mode: 'browser' as const };
  }

  /* ---------- page protocol ---------- */

  private presentationSizes() {
    return sceneScales(this.cfg.window.scale, this.cfg.presentationScales, this.legacyPresentationScale);
  }

  private presentationSize(mode: unknown, value: unknown) {
    if (!presentationMode(mode)) throw Error('Invalid presentation mode');
    const { min, max } = SCENE_SIZE_LIMITS[mode];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw Error(this.appLanguage.startsWith('zh') ? '角色大小超出这个场景的可用范围。' : 'Character size is outside this scene’s range.');
    }
    return { mode, scale: value };
  }

  private setPresentationSize(mode: PresentationMode, scale: number) {
    const { desktop, ...scenes } = this.presentationSizes();
    if ((mode === 'desktop' ? desktop : scenes[mode]) !== scale) {
      this.opts.persist({
        ...(mode === 'desktop' ? { window: { scale } } : {}),
        presentationScales: { ...scenes, ...(mode !== 'desktop' ? { [mode]: scale } : {}) },
      });
    }
    this.syncPrefs();
    return { mode, scale: this.presentationSizes()[mode] };
  }

  private snapshot(): Record<string, unknown> {
    return {
      skin: this.effectiveSkin(),
      presentationMode: this.presentationService.state().desired,
      presentationPositions: this.cfg.rememberPosition ? this.cfg.presentationPositions : {},
      presentationScales: this.presentationSizes(),
      roam: this.quiet?.roam ?? this.cfg.roam,
      sound: this.quiet?.sound ?? this.cfg.sound,
      sounds: this.cfg.sounds,
      theme: this.cfg.theme,
      rememberPosition: this.cfg.rememberPosition,
      // read by the page from `init` only
      startX: this.launchStartX ?? (this.cfg.rememberPosition ? this.cfg.petX : null),
      startY: this.cfg.rememberPosition ? this.cfg.petY : null,
      controlLayout: readControlLayout(this.cfg.controlPages, this.cfg.hoverButtons, this.cfg.hoverButtonsVisible, this.cfg.controlPanelSize),
      hoverButtons: hoverButtonList(this.cfg.hoverButtons),
      hoverButtonsVisible: this.cfg.hoverButtonsVisible !== false,
      touchRegionsVisible: this.cfg.touch.showRegions === true,
      doubleClickChat: this.cfg.doubleClickChat,
      scale: this.cfg.window.scale,
      bubbleSize: this.cfg.window.bubbleSize,
      fontSize: this.cfg.window.fontSize,
      bubbleSpeed: this.cfg.window.bubbleSpeed,
      replyBubbleSeconds: replyBubbleSeconds(this.cfg.window.replyBubbleSeconds),
      glow: this.cfg.window.glow,
      frameRate: this.cfg.window.frameRate,
      lockFrameRate: this.cfg.window.lockFrameRate,
      hideWhenFullscreen: this.cfg.window.hideWhenFullscreen,
      passWhenFullscreen: this.cfg.window.passWhenFullscreen,
      hideFromCapture: this.cfg.window.hideFromCapture === true,
      overTaskbar: this.cfg.window.overTaskbar !== false,
      clickThrough: this.clickThrough,
      language: this.appLanguage,
      user: this.userName,
      mic: this.micOpen(),
      voice: this.voiceBrief(),
      micDevice: this.cfg.asr.mic.deviceId,
      status: this.status.status,
      bodyEffects: this.frameworkConfiguration.desired(),
      statusBubble: this.cfg.statusBubble,
      saidBubbles: this.cfg.saidBubbles,
      bot: this.botInfo(),
    };
  }

  private botName(): string {
    return this.opts.botName?.() ?? '';
  }

  speechRemaining(): number {
    return this.server.petInWindow && !this.petHidden ? Math.max(0, this.busyUntil - Date.now(), this.tts?.remaining() ?? 0) : 0;
  }

  private readonly modelApplication = createModelApplication<PetSkin, PageMessage>({
    // The direct body host permits 60 s for SDK, decoding, upload and first draw.
    // Keep its concrete failure receipt ahead of the transport fallback deadline.
    timeoutMs: 65_000,
    send: message => this.server.sendPet(message),
    failure: () => this.appLanguage.startsWith('zh') ? '桌宠未能加载模型，请重试' : 'The pet could not load this model. Try again.',
    loadFailed: (id, reason) => this.log?.warn(`Live2D: figure "${id}" failed to load: ${reason}`),
  });

  private async openDesktopModel(file: unknown): Promise<Record<string, unknown>> {
    const result = await this.frameworkModel.open(file);
    return { ...this.petState(), modelApplied: result.applied };
  }

  private bodyReady(): boolean {
    const selected = this.selectedModel();
    return !!selected && this.windowVisible() && this.appearanceReceipt?.figure === selected;
  }

  private windowVisible(): boolean {
    return this.server.petInWindow && !this.petHidden;
  }

  private activeScene(applied: PresentationMode | null, cabin: CabinState, bodyReady: boolean) {
    if (cabin.phase === 'active' && cabin.presented !== false) return 'cabin-world';
    return bodyReady ? applied : null;
  }

  private availability() {
    const ready = this.bodyReady();
    const pack = ready ? this.currentPack() : null;
    const scheme = this.appearanceReceipt?.scheme ?? '';
    const preset = pack?.manifest.presets.find(entry => entry.id === scheme);
    const picks = scheme.split('-');
    const outfit = preset ? modelName(preset.name, preset.id, this.language) : pack?.manifest.axes.map((axis, i) => {
      const option = axis.options.find(entry => entry.id === picks[i]) ?? axis.options[0];
      return option ? modelName(option.name, option.id, this.language) : '';
    }).filter(Boolean).join(this.language === 'zh' ? '、' : ', ');
    const cabin = this.cabinWorld.state();
    const activeScene = this.activeScene(this.presentationService.state().applied, cabin, ready);
    return {
      visible: this.windowVisible(),
      ready,
      presentation: this.presentationService.mode(),
      activeScene,
      model: ready ? this.selectedModel() : null,
      modelName: pack ? modelName(pack.manifest.name, pack.id, this.language) : null,
      outfit: outfit || null,
      ...(activeScene === 'cabin-world' ? { cabinWorld: {actor:cabin.actor, name:cabin.residents?.find(row => row.key === cabin.actor)?.name ?? null} } : {}),
    };
  }

  private inputBody(scene?: string) {
    const live = this.availability();
    const mode = scene ?? live.activeScene ?? live.presentation;
    if (mode === 'cabin-world') {
      return { scene: mode, name: live.cabinWorld?.name ?? null, actor: live.cabinWorld?.actor ?? null };
    }
    return { scene: mode, name: live.modelName, figure: live.model, outfit: live.outfit };
  }

  private inputBodyReport?: { key: string; sent: Promise<EventEnvelope | null> };

  private async reportInputBody(body: ReturnType<DesktopPetWorld['inputBody']>): Promise<void> {
    if (!body.name && !this.inputBodyReport) return;
    const key = JSON.stringify(body);
    if (this.inputBodyReport?.key === key) { await this.inputBodyReport.sent; return; }
    const zh = this.language === 'zh';
    const scenes = { desktop: ['桌面', 'desktop'], room: ['小屋', 'room'], phone: ['竖屏', 'portrait'], wallpaper: ['壁纸', 'wallpaper'], 'cabin-world': ['小屋世界', 'Cabin World'] };
    const scene = scenes[body.scene as keyof typeof scenes]?.[zh ? 0 : 1] ?? (zh ? '对话页' : 'conversation');
    const label = (value: string | null) => value?.replace(/[\r\n\[\];；]/g, ' ').trim().slice(0, 120);
    const name = label(body.name);
    const outfit = 'outfit' in body ? label(body.outfit ?? null) : undefined;
    const text = zh ? `梦境当前场景为${scene}。${name ? `当前角色是${name}。` : '暂无已确认的角色。'}${outfit ? `装扮为${outfit}。` : ''}`
      : `Figure Scape is in ${scene}. ${name ? `The current character is ${name}.` : 'No character is confirmed.'}${outfit ? ` Outfit: ${outfit}.` : ''}`;
    const sent = this.push(`${this.id}.availability`, `${this.id}.availability`, text, 'piggyback', { meta: { body } });
    const report = this.inputBodyReport = { key, sent };
    if (!await sent && this.inputBodyReport === report) this.inputBodyReport = undefined;
  }

  private readinessTold = false;

  private publishReadiness(): void {
    const { ready, modelName: name } = this.availability();
    if (ready === this.readinessTold) return;
    this.readinessTold = ready;
    const text = this.language === 'zh'
      ? ready ? `梦境角色现在可见且就绪：${name}。` : '梦境角色现已隐藏、关闭或暂未就绪。'
      : ready ? `Figure Scape is visible and ready as ${name}.` : 'Figure Scape is now hidden, closed or unavailable.';
    void this.push('desktop-live2d-pet.availability', 'desktop-live2d-pet.availability', text, 'piggyback', { meta: { ready } });
  }

  private botInfo(): Record<string, unknown> {
    const c = this.opts.controls;
    const pause = !!(c?.isPaused && c.setPaused);
    const label = typeof c?.quitLabel === 'function' ? c.quitLabel() : c?.quitLabel;
    const quitLabel = c?.quit ? label || this.ui.menu.quit : '';
    return {
      name: this.botName(),
      controls: !!c,
      buttons: { pause, settings: !!c?.openSettings, dress: !!c?.openDress, worlds: !!c?.openWorlds, quit: !!c?.quit, chat: !!c?.openChat },
      // the typing box warns, as the chat page does, that the model gets only the count of pasted images
      imagesSeen: this.host?.modelFacts.accepts('image/jpeg') ?? false,
      paused: pause && c?.isPaused ? c.isPaused() : null,
      quitLabel,
      quitPrompt: quitLabel ? this.ui.menu.quitPrompt(quitLabel) : '',
    };
  }

  private prefsSignature(): string {
    const s = this.snapshot();
    delete s.status;
    // a talk key that opens the microphone sends each change by itself (setMicHeld): the signature keeps only that it does
    s.mic = 'press';
    return JSON.stringify(s);
  }

  /** Config is a live object edited by the console; changes reach the pages within PREFS_SYNC_MS. */
  private syncPrefs(): void {
    this.segmenter.configure(this.cfg.asr.segment);
    if (!this.cfg.asr.enabled) this.cancelSpeech();
    void this.recognition.reconcile();


    // the person changed what a quiet holds back: theirs wins
    if (this.quiet && (this.cfg.sound !== this.quiet.base.sound || this.cfg.roam !== this.quiet.base.roam)) this.endQuiet();
    this.server.syncOverlay();
    const paused = this.opts.controls?.isPaused?.() ?? false;
    if (paused !== this.pausedShown) { this.pausedShown = paused; this.chat.broadcast({ t: 'paused', paused }); }
    const bot = this.botName();
    if (bot !== this.botShown) { this.botShown = bot; this.chat.broadcast({ t: 'bot', bot }); }
    const key = this.prefsSignature();
    if (key === this.prefsKey) return;
    this.prefsKey = key;
    this.server.broadcast({ t: 'prefs', ...this.snapshot() });
  }

  private micWanted(): boolean {
    const phase = this.backendState()?.phase;
    return this.windowVisible() && this.cfg.asr.enabled && phase === 'running';
  }

  private micOpen(): boolean {
    return this.micWanted() && this.micHeld;
  }

  private setMicHeld(on: boolean): void {
    if (this.micReleaseTimer) clearTimeout(this.micReleaseTimer);
    this.micReleaseTimer = null;
    if (this.micHeld === on) return;
    this.micHeld = on;
    this.server.sendPet({ t: 'prefs', mic: this.micOpen() });
  }

  private releaseMicSoon(): void {
    if (!this.micHeld || this.micReleaseTimer) return;
    this.micReleaseTimer = setTimeout(() => this.setMicHeld(false), MIC_RELEASE_MS);
  }

  /** What the pet's microphone button shows: switched on, able to hear, and why not. */
  private voiceBrief(): Record<string, unknown> {
    const b = this.backendState();
    const ready = b?.phase === 'running';
    return {
      enabled: this.cfg.asr.enabled,
      ready,
      detail: ready ? null : b?.phase === 'starting' ? this.ui.voice.starting : b?.detail ?? this.ui.voice.notRunning,
      hint: this.talkHint(),
      mode: 'hold',
    };
  }

  private modelSkin(figure: string, skin?: Partial<PetSkin>): PetSkin {
    const pack = this.packs().find(model => model.id === figure);
    const base = preparedFigureSkin(this.cfg.skin, figure, () => this.packs());
    if (pack && figure !== this.cfg.skin.figure) {
      const preferred = this.opts.figureLibrary?.settings(pack.rawModel?.sourceId ?? pack.id).scheme;
      if (preferred !== undefined || !pack.rawModel) base.scheme = preferred ?? '';
    }
    return skin ? { ...base, ...skin, figure } : base;
  }

  private persistSkin(skin: PetSkin): void {
    this.opts.persist({ skin });
    this.syncPrefs();
  }

  private recordBotLook(skin: PetSkin): void {
    this.botLook = !skin.figure ? null : `${skin.figure}:${skin.scheme ?? ''}`;
  }

  private async applySkin(raw: unknown, fromBot = false): Promise<void> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid appearance');
    const patch = raw as Partial<PetSkin>;
    const current = this.selectedModel();
    if (patch.figure !== undefined && typeof patch.figure !== 'string') throw Error('Invalid model ID');
    if (patch.figure !== undefined && patch.figure !== current) {
      await this.frameworkModel.select(patch.figure, { skin: patch, fromBot });
      return;
    }
    if (!current) throw Error('Select a Live2D model first');
    if (this.frameworkModel.snapshot().busy) throw Error('A model is already loading');
    const skin = { ...this.effectiveSkin(), ...patch };
    if (fromBot) this.recordBotLook(skin);
    this.persistSkin(skin);
  }

  private savePrefs(prefs: Record<string, unknown>): void {
    const patch: DeepPartial<DesktopPetConfigSection> = {};
    if (prefs.roam === 'free' || prefs.roam === 'calm' || prefs.roam === 'off') patch.roam = prefs.roam as RoamMode;
    if (typeof prefs.sound === 'boolean') patch.sound = prefs.sound;
    // the menu's sound or roam button during a quiet: the person's choice, kept, and the quiet is over
    if (this.quiet && (patch.roam !== undefined || patch.sound !== undefined)) this.endQuiet();
    if (prefs.theme === 'dark' || prefs.theme === 'light') patch.theme = prefs.theme as PetTheme;
    if (typeof prefs.mic === 'boolean') patch.asr = { enabled: prefs.mic };
    if (Array.isArray(prefs.hoverButtons)) {
      const ids = prefs.hoverButtons.filter((id): id is string => typeof id === 'string' && (PET_ACTIONS as readonly string[]).includes(id));
      patch.hoverButtons = hoverButtonList(ids.slice(0, MAX_HOVER_BUTTONS).join(',')).join(',');
    }
    const mic = prefs.micSettings as Record<string, unknown> | undefined;
    if (mic && typeof mic === 'object') {
      if (typeof mic.deviceId === 'string') patch.asr = { ...patch.asr, mic: { deviceId: mic.deviceId } };
    }
    if (Object.keys(patch).length) this.opts.persist(patch);
    if (prefs.mic === true && this.windowVisible()) void this.startVoiceBackend();
    this.syncPrefs();
  }

  /**
   * Called only from `stop`, so config.json changes at most once a run: with `rememberPosition` on it
   * stores the last reported position, with it off it clears a stored one. A failed write leaves
   * the stored position as it was.
   */
  private savePosition(): void {
    const x = this.cfg.rememberPosition ? this.standX ?? this.cfg.petX : null;
    // a report without y comes from a body on the floor, which clears a saved height
    const y = !this.cfg.rememberPosition ? null : this.standX === null ? this.cfg.petY : this.standY;
    if (x === this.cfg.petX && y === this.cfg.petY) return;
    try {
      this.opts.persist({ petX: x, ...(y !== this.cfg.petY ? { petY: y } : {}) });
    } catch (err) {
      this.log?.warn(`桌宠位置没有保存:${(err as Error).message}`);
    }
  }

  private onPage(msg: PageMessage, reply?: (msg: PageMessage) => void): void {
    switch (msg.t) {
      case 'window-compatibility': {
        if (!this.server.petInWindow) return;
        const report = readWindowCompatibility(msg, this.cfg.window.hideFromCapture === true, this.cfg.window.overTaskbar !== false);
        if (report) this.windowCompatibility = report;
        return;
      }
      case 'speech-media': return this.tts?.report(msg);
      case 'speech-visible':
        if (Number.isSafeInteger(msg.cursor)) this.log?.debug('发言气泡已打开', { cursor: msg.cursor });
        return;
      case 'draft-action-result': return this.draftAction.receive(msg);
      case 'model-configuration': {
        if(typeof msg.request==='string')this.modelApplication.receive(msg);
        return;
      }
      case 'figure': {
        if (typeof msg.request !== 'string') return this.onFigure(msg);
        this.modelApplication.receive(msg);
        return;
      }
      case 'hello': {
        const s = msg.screen as { w?: unknown; h?: unknown } | undefined;
        if (s && typeof s.w === 'number' && typeof s.h === 'number') this.screen = { w: s.w, h: s.h };
        return;
      }
      case 'arrived':
      case 'interrupted': {
        const w = this.walks.get(String(msg.walkId));
        if (!w) return;
        this.walks.delete(String(msg.walkId));
        clearTimeout(w.timer);
        const t = this.t;
        const at = (typeof msg.x === 'number' ? pct(msg.x) : '?') + (typeof msg.y === 'number' ? t.downAt(pct(msg.y)) : '');
        // what stopped a figure's own move is its body's word, kept short
        const by = String(msg.by).slice(0, 40);
        const name = w.target;
        w.resolve(msg.t === 'arrived' ? (name === undefined ? t.walkArrived(at) : t.moveArrived(name, at))
          : w.stopping ? (name === undefined ? t.walkStopped(at) : t.moveStopped(name, at))
          : msg.by === 'drag' ? (name === undefined ? t.walkGrabbed(at, this.userName) : t.moveGrabbed(name, at, this.userName))
          : name === undefined ? t.walkReplaced(at, by) : t.moveFailed(name, at, by));
        return;
      }
      case 'answer': return this.onAnswer(msg, 'pet');
      case 'presentation-ready': if (this.server.petInWindow) this.presentationService.ready(msg); return;
      case 'presentation-result': {
        if (!this.server.petInWindow) return;
        const previous = this.presentationService.mode();
        this.presentationService.receive(msg);
        if (previous !== this.presentationService.mode()) {
          const note = this.vocabNote();
          if (note) void this.push('desktop-live2d-pet.figure', 'desktop-live2d-pet.figure', this.t.figureNote(note), 'debounce');
        }
        return;
      }
      case 'visual-preview-failed': {
        const domains = this.frameworkRuntime?.snapshot.domains as { body?: Record<string, unknown> } | undefined;
        if (domains?.body && msg.figure === this.selectedModel()) domains.body.visualPreview = { owner: msg.owner, request: msg.request, status: 'failed', reason: msg.reason };
        return;
      }
      case 'scene-result': return this.presentationService.sceneReceive(msg);
      case 'framework-state': {
        const snapshot = msg.snapshot;
        if (msg.figure === (this.selectedModel()) && snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
          this.frameworkRuntime = { figure: String(msg.figure), snapshot: snapshot as Record<string, unknown> };
          const state = this.frameworkRuntime.snapshot;
          const view = (state.domains as Record<string, unknown> | undefined)?.presentation;
          this.presentationService.updateDetails(state.presentation, view, state.modelGeneration);
        }
        return;
      }
      case 'body-effects': {
        const desired = bodyEffectsFor(this.cfg.bodyEffects);
        const requested = msg.requested as Record<string, unknown> | undefined;
        if (msg.figure === (this.selectedModel()) && BODY_EFFECT_KEYS.every(key => requested?.[key] === desired[key])) {
          this.bodyEffectsFeedback = readBodyEffectsFeedback(msg.report);
          this.bodyEffectsFeedbackKey = JSON.stringify([this.selectedModel(), desired]);
        }
        return;
      }
      case 'visibility': {
        if (msg.hidden === false && this.cabinWorld.state().phase === 'active') {
          this.server.sendPet({t:'hide'});
          return;
        }
        const hiding = !this.petHidden && msg.hidden === true;
        const showing = this.petHidden && msg.hidden === false;
        this.petHidden = msg.hidden === true;
        if (showing && this.server.petInWindow) {
          this.server.sendPet({ t: 'presentation-resume', mode: this.presentationService.state().desired });
          if (this.cfg.asr.enabled) void this.startVoiceBackend();
        }
        this.tellDesktop();
        if (hiding) this.releaseDesktopOperations();
        if (msg.hidden === true) this.revealCabin();
        return;
      }
      case 'phone-message': return void this.handlePhoneMessage(msg);
      case 'phone-history': return this.openPhoneHistory();
      case 'phone-control': return void this.handlePhoneControl(msg);
      case 'text': return void this.handlePetText(msg, reply);
      case 'expand': {
        const text = typeof msg.text === 'string' ? msg.text.slice(0, CHAT_TEXT_MAX) : '';
        const images = draftImages(msg.images);
        this.draft = { text, images };
        if (this.chat.size) { this.chat.broadcast({ t: 'draft', text, images }); this.draft = null; }
        this.opts.controls?.openChat?.();
        return;
      }
      case 'touch': return this.onTouch(msg);
      case 'touch-reaction': if (this.touch?.kind === 'drop' && msg.kind === 'drop' && typeof msg.status === 'string' && ['suppressed','busy','played','unavailable'].includes(msg.status)) this.touch.reaction = msg.status; return;
      case 'mic': {
        this.micState = { state: String(msg.state), detail: typeof msg.detail === 'string' ? msg.detail : null };
        // a closed microphone sends no more frames: the meter drops to silence
        if (this.micState.state !== 'on') {
          this.level = -100;
          this.voiceFrame({ type: 'level', level: this.level, speaking: false, open: this.gateOpen() });
        }
        return;
      }
      case 'prefs': return this.savePrefs(msg);
      case 'position': {
        if (msg.mode === 'wallpaper') return;
        if (msg.mode === 'room' || msg.mode === 'phone') {
          const position = scenePosition(msg);
          if (position && this.server.petInWindow && this.cfg.rememberPosition && msg.mode === this.presentationService.mode()) {
            this.opts.persist({ presentationPositions: { ...this.cfg.presentationPositions, [msg.mode]: position } });
          }
          return;
        }
        if (typeof msg.x !== 'number' || !Number.isFinite(msg.x)) return;
        this.standX = Math.min(1, Math.max(0, msg.x));
        this.standY = typeof msg.y === 'number' && Number.isFinite(msg.y) ? Math.min(1, Math.max(0, msg.y)) : null;
        return;
      }
      case 'devices': {
        const list = Array.isArray(msg.list) ? msg.list : [];
        this.devices = list
          .filter((d): d is { id: string; label: string } => !!d && typeof (d as { id?: unknown }).id === 'string')
          .map((d) => ({ id: d.id, label: typeof d.label === 'string' ? d.label : '' }));
        return;
      }
      case 'confirm-shown': {
        const id = String(msg.id), c = this.confirms.get(id);
        if (!c || c.shown) return;
        c.shown = true;
        clearTimeout(c.timer);
        c.timer = this.confirmTimer(id, CONFIRM_TIMEOUT_MS);
        return;
      }
      case 'confirmed': {
        const c = this.confirms.get(String(msg.id));
        if (!c) return;
        this.confirms.delete(String(msg.id));
        clearTimeout(c.timer);
        c.resolve(msg.index === 0 ? 'yes' : msg.index === c.choices - 1 ? 'no' : msg.index === 1 ? 'always' : 'dismissed');
        return;
      }
      case 'control':
        if (msg.action === 'desktop-presentation' && typeof msg.request === 'string' && this.server.petInWindow) {
          const request = msg.request;
          void this.selectScene(msg.mode, request).then(result => {
            this.server.sendPet({t:'desktop-presentation-result', request, ok:result.applied, reason:result.error});
          }, (error: unknown) => {
            this.server.sendPet({t:'desktop-presentation-result', request, ok:false, reason:String(error instanceof Error ? error.message : error)});
          });
          return;
        }
        return this.onControl(String(msg.action));
      case 'dialog': {
        const settle = this.dialogs.get(String(msg.id));
        if (!settle) return;
        this.dialogs.delete(String(msg.id));
        settle(typeof msg.index === 'number' ? { index: msg.index }
          : typeof msg.text === 'string' ? { text: msg.text.slice(0, 2000) }
          : msg.alt ? { alt: true } : msg.closed ? { closed: true } : msg.back ? { back: true } : { done: true });
        return;
      }
      case 'speak-hold': {
        if (msg.down === true && this.micWanted()) this.setTalking(true);
        else if (msg.down === false && this.talking) this.commitSpeech();
        return;
      }
      case 'commit': return this.commitSpeech();
      case 'cancel': return this.cancelSpeech();
    }
  }

  private deliverPetText(text: string, blobs: BlobInput[] = []): Promise<EventEnvelope | null> {
    return this.push('desktop-live2d-pet.message', 'desktop-live2d-pet.text', this.t.typed(this.userName, text), 'preempt',
      { meta: { via: 'bubble', text }, ...(blobs.length ? { blobs } : {}) });
  }

  private async handlePetText(msg: PageMessage, reply?: (msg: PageMessage) => void) {
    const request = typeof msg.request === 'string' && /^[\w-]{1,80}$/.test(msg.request) ? msg.request : undefined;
    const language = petText(this.appLanguage).chat;
    const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
    const images = parseChatImages(msg.images, this.userName, language, this.t);
    const respond = (value: Record<string, unknown>) => {
      if (request) reply?.({ t: 'text-result', request, ...value });
    };
    if (!images.ok || (!text && !images.blobs.length) || this.petHidden) {
      respond({ ok: false, reason: images.ok ? language.notSent : images.reason });
      return;
    }
    const sent = await this.commitChatMessage(request && 'bubble:' + request, () => this.deliverPetText(text, images.blobs));
    respond(sent ? { ok: true, cursor: sent.cursor } : { ok: false, reason: language.notSent });
  }

  private async handlePhoneMessage(msg: PageMessage): Promise<void> {
    const request = msg.request;
    if (typeof request !== 'string' || !/^[\w-]{1,80}$/.test(request) || !this.server.petInWindow) return;
    const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
    const respond = (value: Record<string, unknown>) => this.server.sendPet({ t: 'phone-message-result', request, ...value });
    const scene = msg.scene ?? 'phone';
    if (!text || this.petHidden || !presentationMode(scene) || scene === 'desktop' || this.presentationService.state().applied !== scene) {
      respond({ ok: false, reason: 'unavailable' });
      return;
    }
    const result = await this.deliverSceneText(scene, request, text);
    respond(result ? { ok: true, cursor: result.cursor } : { ok: false, reason: 'delivery-failed' });
  }

  private async deliverSceneText(scene: string, request: string, text: string, actor?: string) {
    return this.commitChatMessage(scene + ':' + (actor ?? '') + ':' + request, () =>
      this.push('desktop-live2d-pet.message', 'desktop-live2d-pet.text', this.t.typed(this.userName, text), 'preempt',
        { meta: { via:'bubble', text, scene, ...(actor ? {actor} : {}) } }));
  }

  private async commitChatMessage(key: string | undefined, deliver: () => Promise<EventEnvelope | null>) {
    if (!key) return deliver();
    let task = this.sceneMessages.get(key);
    if (!task) {
      task = deliver();
      this.sceneMessages.set(key, task);
      if (this.sceneMessages.size > 64) this.sceneMessages.delete(this.sceneMessages.keys().next().value!);
    }
    const result = await task;
    if (!result && this.sceneMessages.get(key) === task) this.sceneMessages.delete(key);
    return result;
  }

  private replyInput(): EventEnvelope | undefined {
    const turn = this.chatReply.turn(), store = this.host?.store;
    if (!turn || !store) return undefined;
    let cursor = turn.input;
    for (const settled of store.range({ source: DESKTOP_CHAT_SOURCE, fromCursor: turn.after + 1 })) {
      if (settled.type !== 'desktop-pet.self' || settled.meta?.kind !== 'delivered' || !Array.isArray(settled.meta.cursors)) continue;
      for (const id of settled.meta.cursors) {
        if (typeof id !== 'number' || id <= cursor) continue;
        const input = store.get(id);
        if (input?.source === DESKTOP_CHAT_SOURCE && chatItem(input)?.kind === 'user') cursor = id;
      }
    }
    return cursor ? store.get(cursor) : undefined;
  }

  private async sendCabinMessage(request: unknown, value: unknown) {
    const state = this.cabinWorld.state();
    if (state.phase !== 'active' || state.presented === false || !state.actor) throw Error('小屋世界尚未就绪，输入已保留。');
    const text = typeof value === 'string' ? value.trim().slice(0, 500) : '';
    if (typeof request !== 'string' || !/^[\w-]{1,80}$/.test(request) || !text) throw Error('请输入消息后发送。');
    const sent = await this.deliverSceneText('cabin-world',request,text,state.actor);
    if (!sent) throw Error('Coo 未收到这条消息，请重试。');
    return { cursor:sent.cursor };
  }

  private cabinConversation() {
    const store = this.host?.store;
    const items = store ? chatPage(store,this.id,CHAT_PAGE_EVENTS,undefined,'conversation').items : [];
    return { phase:this.phase?.state ?? 'idle', messages:items.flatMap(item => {
      if (item.kind !== 'user' && item.kind !== 'say') return [];
      const text = item.kind === 'user' ? item.text : item.beats.map(beat => beat.text).join('\n');
      const count = item.images?.length ?? 0;
      const attachment = count ? this.language === 'zh' ? `[${count} 张图片]` : `[${count} image(s)]` : '';
      return [{cursor:item.cursor,side:item.kind === 'user' ? 'user' : 'pet',text:[text,attachment].filter(Boolean).join('\n')}];
    }).filter(item => item.text).slice(-8) };
  }

  private async saveWallpaperComposition(id: unknown, input: unknown, revision: unknown) {
    let release: () => void;
    try { release = this.bodyTransaction.reserve('presentation'); }
    catch { throw Error('presentation-busy'); }
    try {
      const composition = await this.wallpapers.setComposition(id,input,revision);
      const wallpaper = await this.wallpapers.settings();
      if (wallpaper?.id === id) this.server.sendPet({t:'wallpaper-options',wallpaper});
      return composition;
    } finally { release(); }
  }

  private async handlePhoneControl(msg: PageMessage): Promise<void> {
    const request = msg.request;
    if (typeof request !== 'string' || !/^[\w-]{1,80}$/.test(request)) return;
    const windowOnly = msg.command !== 'model-size';
    if (windowOnly && !this.server.petInWindow) return;
    const localized = (zh: string, en: string) => this.appLanguage.startsWith('zh') ? zh : en;
    try {
      if (this.petHidden) throw Error(localized('请先显示桌宠。', 'Show the pet first.'));
      const appearance = () => ({
        ...this.frameworkAppearance.read(),
        presets: this.frameworkAppearance.presets()
          .filter(preset => preset.skin.figure === this.selectedModel())
          .map(({ id, name }) => ({ id, name })),
      });
      let result: unknown;
      switch (msg.command) {
        case 'edit-touch': {
          result = await this.openModelEditor(undefined, 'touch');
          break;
        }
        case 'touch-regions': {
          if (typeof msg.value !== 'boolean') throw Error(localized('需要指定是否显示判定区。', 'Choose whether to show touch regions.'));
          if (msg.value !== (this.cfg.touch.showRegions === true)) {
            this.opts.persist({ touch: { ...this.cfg.touch, showRegions: msg.value } });
            this.syncPrefs();
          }
          result = { visible: this.cfg.touch.showRegions === true };
          break;
        }
        case 'hover-buttons': {
          if (typeof msg.value !== 'boolean') throw Error(localized('需要指定是否显示。', 'Choose whether to show the buttons.'));
          if (msg.value !== this.cfg.hoverButtonsVisible) {
            this.opts.persist({ hoverButtonsVisible: msg.value });
            this.syncPrefs();
          }
          result = { visible: this.cfg.hoverButtonsVisible };
          break;
        }
        case 'wallpaper-placement-state':
        case 'wallpaper-placement': {
          const value = msg.value as Record<string,unknown> | null;
          const wallpaper = await this.wallpapers.settings();
          if (!value || !wallpaper || value.id !== wallpaper.id || this.presentationService.state().applied !== 'wallpaper') {
            throw Error('wallpaper-source-unavailable');
          }
          result = msg.command === 'wallpaper-placement-state'
            ? {id:wallpaper.id,title:wallpaper.title,composition:wallpaper.composition}
            : await this.saveWallpaperComposition(wallpaper.id,value.placement,value.revision);
          break;
        }
        case 'model-size': {
          const value = msg.value;
          const target = value && typeof value === 'object' ? value as Record<string, unknown>
            : {mode: this.presentationService.mode(), scale: value};
          const {mode,scale} = this.presentationSize(target.mode, target.scale);
          result = this.setPresentationSize(mode, scale);
          break;
        }
        case 'appearance': result = appearance(); break;
        case 'actions': {
          const { figure, vocabulary } = this.frameworkActions.read();
          result = { figure, vocabulary };
          break;
        }
        case 'preview-outfit':
        case 'outfit':
        case 'preset':
        case 'play':
          if (msg.figure !== this.selectedModel() || this.presentationService.busy()
            || this.frameworkModel.snapshot().busy || this.bodyMissing || this.appearanceReceipt?.figure !== msg.figure) {
            throw Error(localized('角色还在准备，请返回后重试。', 'The character is still loading. Go back and try again.'));
          }
          if (msg.command === 'preview-outfit') {

            result = { scheme: this.frameworkAppearance.selection(msg.figure, msg.value) };
          } else if (msg.command === 'outfit') {
            this.frameworkAppearance.select(msg.figure, msg.value);
            result = appearance();
          } else if (msg.command === 'preset') {
            const preset = appearance().presets.find(preset => preset.id === msg.value);
            if (!preset) throw Error(localized('该预设已不可用。', 'This preset is no longer available.'));
            await this.frameworkAppearance.applyPreset(preset.id);
            result = appearance();
          } else result = this.frameworkActions.preview(msg.figure, [msg.value]);
          break;
        default: throw Error(localized('此操作不可用。', 'This action is unavailable.'));
      }
      this.server.sendPet({ t: 'phone-control-result', request, ok: true, result });
    } catch (error) {
      this.server.sendPet({ t: 'phone-control-result', request, ok: false, reason: String(error instanceof Error ? error.message : error) });
    }
  }

  private onControl(action: string): void {
    if (action === 'desktop-through') { this.setDesktopClickThrough(!this.clickThrough); return; }
    if (action === 'desktop-close') { void this.closeDesktopWindow(); return; }
    const c = this.opts.controls;
    if (!c) return;
    if (action === 'pause' || action === 'resume') c.setPaused?.(action === 'pause');
    else if (action === 'settings') c.openSettings?.();
    else if (action === 'dress') c.openDress?.();
    else if (action === 'desktop-scene') c.openScenes?.();
    else if (action === 'desktop-wallpapers' || action === 'desktop-wallpaper-enter') c.openWallpapers?.(action === 'desktop-wallpaper-enter');
    else if (action === 'desktop-cabin-settings') c.openCabin?.();
    else if (action === 'desktop-cabin') {
      if (!this.cabinWorld.state().configured) c.openCabin?.();
      else {
        try { this.enterCabin(undefined,true); }
        catch { c.openCabin?.(); }
      }
    }
    else if (action === 'desktop-voice-settings') c.openVoiceSettings?.();
    else if (action === 'worlds') c.openWorlds?.();
    else if (action === 'quit') c.quit?.();
    this.syncPrefs();
  }

  private setDesktopClickThrough(on: boolean): void {
    this.clickThrough = on;
    this.server.sendPet({ t: 'prefs', clickThrough: on });
  }

  private async closeDesktopWindow(): Promise<void> {
    if (this.server.petInWindow || this.windowHost?.state().phase === 'running') {
      this.petHidden = true;
      this.tellDesktop();
      this.releaseDesktopOperations();
    }
    await this.windowHost?.stop();
  }

  private revealCabin(): void {
    clearTimeout(this.cabinHideTimer);
    this.cabinHideTimer = undefined;
    this.cabinWorld.reveal();
  }

  private cabinVisibility(active: boolean): void {
    if (active) {
      this.cabinRestoreBody = this.windowVisible();
      if (this.cabinRestoreBody) {
        this.petHidden = true;
        this.releaseDesktopOperations();
        const sent = this.server.sendPet({ t:'hide' });
        if (!sent) this.revealCabin();
        else if (this.cabinWorld.state().presented === false) {
          this.cabinHideTimer = setTimeout(() => void this.cabinWorld.leave('原场景未确认隐藏，已取消切换。'),4000);
        }
        this.tellDesktop();
      } else this.revealCabin();
    } else {
      clearTimeout(this.cabinHideTimer);
      this.cabinHideTimer = undefined;
      if (this.cabinRestoreBody) this.server.sendPet({ t:'show' });
      this.cabinRestoreBody = false;
    }
    if (!active || this.cabinWorld.state().presented === undefined) this.reportCabinScene(active);
  }

  private reportCabinScene(active: boolean): void {
    if (active === this.cabinSceneReported) return;
    this.cabinSceneReported = active;
    const text = this.language === 'zh'
      ? active ? '已进入小屋世界。使用 cabin_status 或 cabin_look 查看住户和场景。' : '已离开小屋世界。继续在原会话中对话。'
      : active ? 'Cabin World is active. Use cabin_status or cabin_look to inspect the resident and scene.' : 'Cabin World is no longer active. Continue in the same conversation.';
    void this.push('desktop-live2d-pet.scene','desktop-live2d-pet.scene',text,'piggyback',{meta:{scene:'cabin-world',active}});
  }

  private async prepareCabinBody(signal: AbortSignal, model?: string) {
    const pack = model ? this.packs().find(candidate => candidate.id === model) : this.currentPack();
    if (!pack) throw Error('请先在梦境工作台选一个角色。');
    if (pack.manifest.source === 'cabin-world') return undefined;
    if (pack.rawModel) await this.opts.sdkService?.prepare();
    signal.throwIfAborted();
    const url = new URL('/model-preview',this.server.origin);
    const scheme = pack.id === this.selectedModel() ? lookOf(this.cfg.skin)
      : this.opts.figureLibrary?.settings(pack.rawModel?.sourceId ?? pack.id).scheme ?? '';
    url.search = new URLSearchParams({ model:pack.id, cabin:'1', scheme }).toString();
    const runtime = resolveHostCommand(url.href,this.cfg.window.electronFile,this.store.electron.executable());
    if ('missing' in runtime || !runtime.args[0]?.endsWith('electron-main.cjs')) throw Error('请先在梦境运行详情中安装 Electron 运行组件。');
    return {
      key:'figure-scape-'+createHash('sha256').update(pack.rawModel?.sourceId ?? pack.id).digest('hex').slice(0,24),
      name:(pack.manifest.name.zh || pack.manifest.name.en || '梦境角色').slice(0,32),
      url:url.href,
      electron:runtime.command,
    };
  }

  private enterCabin(model?: unknown, fromDesktop = false) {
    if (model !== undefined && (typeof model !== 'string' || !this.packs().some(pack => pack.id === model))) {
      throw Error('请选择角色库里已有的角色。');
    }
    const current = this.cabinWorld.state();
    if (current.phase === 'connecting' || current.phase === 'active' || current.phase === 'leaving') return current;
    if (this.presentationService.busy() || this.frameworkModel.snapshot().busy) throw Error('Wait for the current scene or model change');
    const release = this.bodyTransaction.reserve('presentation');
    void this.cabinWorld.enter(model).then(next => {
      if (fromDesktop && next.phase === 'error') this.opts.controls?.openCabin?.();
    }).finally(release);
    return this.cabinWorld.state();
  }

  private async selectScene(mode: unknown, request?: unknown) {
    if (!presentationMode(mode)) throw Error('Invalid presentation mode');
    if (this.frameworkModel.operation(request)) throw Error('Operation ID already belongs to a model request');
    const wallpaper = mode === 'wallpaper' ? await this.wallpapers.prepare() : null;
    if (this.cabinWorld.state().phase === 'active') await this.cabinWorld.leave();
    return this.presentationService.select(mode, request, wallpaper ? {payload:wallpaper} : undefined);
  }

  /** Ends the wait with 'timeout' after `ms`, and takes the confirmation off the page, queued or shown. */
  private confirmTimer(id: string, ms: number): NodeJS.Timeout {
    return setTimeout(() => {
      const c = this.confirms.get(id);
      this.confirms.delete(id);
      this.server.sendPet({ t: 'ask-close', id });
      c?.resolve('timeout');
    }, ms);
  }

  /**
   * Asks the person in a bubble with two choices, the first one meaning yes, or three, the middle one
   * meaning yes and from now on. Answers never reach the bot as events; the caller gets them. A hidden
   * pet's bubble cannot be seen, so the caller gets 'unavailable' at once, as with no pet page. The answer
   * is awaited CONFIRM_TIMEOUT_MS from when the page shows the bubble, which may queue it behind lines.
   */
  confirm(question: string, choices: [yes: string, no: string] | [yes: string, always: string, no: string]): Promise<ConfirmResult> {
    const id = nextId('k');
    if (this.petHidden || !this.server.sendPet({ t: 'confirm', id, question, options: choices })) return Promise.resolve('unavailable');
    return new Promise((resolve) => {
      this.confirms.set(id, { resolve, timer: this.confirmTimer(id, CONFIRM_UNSHOWN_MS), choices: choices.length, shown: false });
    });
  }

  /**
   * Shows one step of a conversation in the bubble; see `PetDialog`. Nothing reaches the bot: the
   * caller gets the answer. Steps wait for as long as the person takes; a step with nothing to
   * answer ends once its line has been read.
   */
  dialog(d: PetDialog): PetDialogHandle {
    const id = nextId('d');
    const vocab = this.vocab();
    const { actions } = parseActions(d.actions ?? [], vocab);
    // a card's words go through the same vocabulary as the line's
    const input = d.input?.kind === 'choices'
      ? { ...d.input, options: d.input.options.map((o) => (o.actions ? { ...o, actions: parseActions(o.actions, vocab).actions } : o)) }
      : d.input;
    let settle: (a: PetDialogAnswer) => void = () => {};
    const answer = new Promise<PetDialogAnswer>((resolve) => { settle = resolve; });
    if (!this.server.sendPet({ t: 'dialog', id, ...d, input, actions })) settle({ unavailable: true });
    else this.dialogs.set(id, settle);
    // a page that never reports back (a tab put to sleep) does not hold a line with nothing to answer forever
    if (!d.input && this.dialogs.has(id)) {
      const timer = setTimeout(() => this.dialogs.get(id)?.({ done: true }), 5000 + d.text.length / DIALOG_CPS * 1000);
      void answer.finally(() => { clearTimeout(timer); this.dialogs.delete(id); });
    }
    return {
      answer,
      update: (patch) => { if (this.dialogs.has(id)) this.server.sendPet({ t: 'dialog-update', id, ...patch }); },
      close: () => {
        const s = this.dialogs.get(id);
        this.dialogs.delete(id);
        this.server.sendPet({ t: 'dialog-close', id });
        s?.({ done: true });
      },
    };
  }

  /** Dresses the body in `patch` over the skin as it is, and saves it, as a pick on the dressing page does. */
  dress(patch: Partial<PetSkin>): Promise<void> {
    return this.applySkin(patch);
  }

  /** Tells `onDesktopChange` when the pet window's place on the desktop changed since it was last told. */
  private tellDesktop(): void {
    this.publishReadiness();
    const on = this.windowVisible();
    if (on === this.desktopTold) return;
    this.desktopTold = on;
    this.opts.onDesktopChange?.(on);
  }

  private onPageGone(): void {
    this.revealCabin();
    this.windowCompatibility = null;
    this.phoneHistoryCursor = null;
    this.bodyTouch = undefined;
    this.appearanceReceipt = null;
    this.log?.info('桌宠页面断开');
    this.modelApplication.disconnected();
    this.presentationService.disconnected();
    this.draftAction.disconnected();
    this.releaseDesktopOperations();
    this.tellDesktop();
  }

  private releaseDesktopOperations(): void {
    this.tts?.stopAll();
    this.editService.releasePreview();
    this.cancels++;
    this.talking = false;
    this.listenOpen = false;
    this.committing = false;
    this.partial = this.interim = '';
    this.queue.length = 0;
    if (this.packTimer) clearTimeout(this.packTimer);
    this.packTimer = null;
    this.packer.take();
    this.segmenter.flush();
    this.wasSpeaking = false;
    this.setMicHeld(false);
    this.voiceFrame({ type: 'gate', open: false });
    if (this.touch) clearTimeout(this.touch.timer);
    this.touch = null;
    this.setAsk(null);
    this.server.sendPet({ t: 'desktop-release' });
    for (const id of this.walks.keys()) this.server.sendPet({ t: 'walk-stop', id });
    for (const [id, d] of this.dialogs) { d({ unavailable: true }); this.dialogs.delete(id); }
    for (const [id, w] of this.walks) { clearTimeout(w.timer); w.resolve(this.t.walkWindowGone); this.walks.delete(id); }
    for (const [id, c] of this.confirms) { clearTimeout(c.timer); c.resolve('unavailable'); this.confirms.delete(id); }
    this.segmenter.flush();
    if (this.wasSpeaking) this.wasSpeaking = false;
  }

  /** An answer from the pet's bubble or the chat page; an answer from the page closes the bubble. */
  private onAnswer(msg: Record<string, unknown>, from: 'pet' | 'chat'): void {
    const ask = this.ask;
    if (!ask || ask.id !== msg.askId) return;
    const t = this.t;
    if (msg.dismissed) {
      this.setAsk(null);
      void this.push('desktop-live2d-pet.answer', 'desktop-live2d-pet.answer', t.answerClosed(this.userName, ask.question), 'debounce', { meta: { askId: ask.id, dismissed: true } });
      return;
    }
    const index = typeof msg.index === 'number' && ask.options[msg.index] !== undefined ? msg.index : null;
    const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
    if (index === null && !text) return;
    this.setAsk(null);
    if (from === 'chat') this.server.sendPet({ t: 'ask-close', id: ask.id });
    const line = index !== null
      ? t.answerPicked(this.userName, ask.question, index + 1, ask.options[index]!)
      : t.answerWrote(this.userName, ask.question, text);
    void this.push('desktop-live2d-pet.answer', 'desktop-live2d-pet.answer', line, 'flush',
      { meta: { askId: ask.id, ...(index !== null ? { index } : { text }) } });
  }

  private onTouch(msg: PageMessage): void {
    if (!this.cfg.touch.enabled || typeof msg.figure === 'string' && msg.figure !== this.selectedModel()) return;
    const kind = String(msg.kind);
    if (kind === 'grab') return;
    if (kind === 'crash' && this.touch && (this.touch.kind === 'throw' || this.touch.kind === 'drop')) {
      this.touch.crashed = true;
      return;
    }
    const profile = this.bodyTouch;
    const location = kind === 'poke' || kind === 'pet';
    const region = location ? readTouchRegion(msg.region) : undefined;
    const area = location ? profile?.areas.find(area => area.id === msg.region) : undefined;
    const locationId = area?.id ?? region;
    const note = locationId ? profile?.areaNotes?.[locationId] : undefined;
    const areaNote = typeof note === 'string' ? note : undefined;
    const rule = touchRule(profile, kind, locationId ?? 'all');
    const reaction = typeof msg.reaction === 'string' && ['suppressed','busy','played','unavailable'].includes(msg.reaction) ? msg.reaction : undefined;
    if (rule?.send === 'local' || kind === 'shake' && !rule) return;
    if (this.touch && this.touch.kind === kind && this.touch.region === region && this.touch.area?.id === area?.id
      && this.touch.areaNote === areaNote && this.touch.rule?.send === rule?.send && this.touch.rule?.note === rule?.note && kind !== 'throw' && kind !== 'drop') {
      this.touch.count++;
      this.touch.reaction = reaction ?? this.touch.reaction;
      this.touch.woke ||= msg.woke === true;
      clearTimeout(this.touch.timer);
      this.touch.timer = setTimeout(() => this.flushTouch(), TOUCH_MERGE_MS);
      return;
    }
    if (this.touch) this.flushTouch();
    this.touch = {
      kind, region, area, areaNote, rule, reaction, count: 1, woke: msg.woke === true, asleep: msg.asleep === true, crashed: false,
      x: typeof msg.x === 'number' ? msg.x : null,
      timer: setTimeout(() => this.flushTouch(), TOUCH_MERGE_MS),
    };
  }

  private flushTouch(): void {
    const t = this.touch;
    this.touch = null;
    if (!t) return;
    clearTimeout(t.timer);
    const u = this.userName;
    const m = this.t;
    let text: string;
    switch (t.kind) {
      case 'poke': text = t.woke ? m.pokedAwake(u, t.region) : m.poked(u, t.count, t.region); break;
      case 'pet': text = t.asleep ? m.pettedAsleep(u, t.region) : m.petted(u, t.count, t.region); break;
      case 'throw': text = m.thrown(u, t.crashed); break;
      case 'drop': text = m.dropped(u, t.x !== null && this.screen ? pct(t.x / this.screen.w) : null, t.crashed); break;
      case 'crash': text = m.crashed; break;
      case 'shake': text = this.language.startsWith('zh') ? u + '摇晃了你' : u + ' shook you'; break;
      default: return;
    }
    if (t.area) {
      if (this.language.startsWith('zh')) text = u + (t.kind === 'poke' ? '戳了' : '抚摸了') + '你的' + t.area.name
        + (t.count > 1 ? ' ' + t.count + ' 次' : '') + (t.woke ? '，把你弄醒了' : '');
      else text = u + (t.kind === 'poke' ? ' poked your ' : ' petted your ') + t.area.name
        + (t.count > 1 ? ' ' + t.count + ' times' : '') + (t.woke ? ' and woke you up' : '');
    }
    const areaName = t.area?.name ?? (t.region ? TOUCH_REGIONS[t.region][this.language.startsWith('zh') ? 0 : 1] : undefined);
    const notes = [...new Set([t.areaNote, t.rule?.note].filter(Boolean))];
    if (notes.length) text += ' (' + notes.join(this.language.startsWith('zh') ? '。' : '. ') + ')';
    const wakes = t.rule?.send !== 'next' && !this.touchWoke && touchWakes(this.cfg.touch, t.kind);
    if (wakes) this.touchWoke = true;
    void this.push('desktop-live2d-pet.touch', 'desktop-live2d-pet.touch', m.touch(text), wakes ? 'debounce' : 'piggyback',
      { meta: { touch: { kind: t.kind, count: t.count, woke: t.woke, crashed: t.crashed, ...(t.reaction ? { reaction: t.reaction } : {}), ...(t.region ? { region: t.region } : {}), body: DESKTOP_PET_ID, areaId: t.area?.id ?? t.region ?? 'all', ...(areaName ? { areaName } : {}), ...(t.areaNote ? { areaNote: t.areaNote } : {}) } } });
  }

  /**
   * The person's local time an event happened, before its text: `[HH:MM] `, and `[MM-DD <weekday> HH:MM] ` for the
   * first event of a run and the first on a new date, so the bot knows the date without a clock in its prefix.
   * The weekday is short, in the model-text language (周日, Sun).
   */
  private stamp(now = new Date()): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat(this.t.dateLocale, { timeZone: this.opts.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(now).map((p) => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const time = shortTime(this.opts.timezone, now);
    if (day === this.stampDay) return `[${time}] `;
    this.stampDay = day;
    return `[${parts.month}-${parts.day} ${parts.weekday} ${time}] `;
  }

  /**
   * Delivers an event to the bot. `meta` carries what the chat page shows of it; the person's
   * messages stay pending on the page until Core reports them delivered.
   */
  private async push(
    type: string, senderKey: string, text: string, trigger: TriggerMode,
    extra: { meta?: Record<string, unknown>; blobs?: BlobInput[] } = {},
  ): Promise<EventEnvelope | null> {
    const host = this.host;
    if (!host) return null;
    try {
      const bodyInput = ['message', 'speech', 'answer', 'touch'].some(kind => type === `${this.id}.${kind}`);
      const sourceScene = typeof extra.meta?.scene === 'string' ? extra.meta.scene : undefined;
      if (bodyInput) await this.reportInputBody(this.inputBody(sourceScene));
      const prefix = this.language === 'zh' ? '[梦境] ' : '[Figure Scape] ';
      const e = await host.pushEvent({ type, source: this.id, senderKey, ts: nowIso(this.opts.timezone),
        text: this.stamp() + (bodyInput ? prefix : '') + text, ...extra }, { trigger });
      const item = chatItem(e);
      if (!item) return e;
      const pending = item.kind === 'user' && e.contextDelivery === 'deliver';
      if (pending) this.pendingChat.add(e.cursor);
      this.chat.broadcast({ t: 'item', item, ...(pending ? { pending: true } : {}) });
      return e;
    } catch (err) {
      this.log?.warn(`事件没能送出:${(err as Error).message}`);
      return null;
    }
  }

  /** Stores what the pet said or did for the chat page; never delivered to the bot. Resolves to its cursor. */
  private async record(meta: Record<string, unknown>, text: string, blobs: BlobInput[] = []): Promise<number | null> {
    const host = this.host;
    if (!host) return null;
    try {
      const e = await host.pushEvent({ type: SELF_TYPE, source: this.id, senderKey: SELF_TYPE, ts: nowIso(this.opts.timezone), text, meta, ...(blobs.length ? { blobs } : {}) }, { deliver: false });
      const item = chatItem(e);
      if (item) this.chat.broadcast({ t: 'item', item });
      if (item?.kind === 'say') this.cabinWorld.conversationChanged();
      return e.cursor;
    } catch (err) {
      this.log?.warn(`对话记录没能保存:${(err as Error).message}`);
      return null;
    }
  }

  /* ---------- voice ---------- */

  /** The model files of a sherpa-onnx engine, or why they are not there. */
  private sherpaModel(engine: SherpaEngine): { paths: Record<string, string> } | { missing: string } {
    const slot = this.store[engine];
    if (slot.state().phase !== 'ready') return { missing: this.ui.voice.modelMissing(Math.round(slot.bytes / 1048576)) };
    return { paths: slot.paths() };
  }

  /** The engine in force (`asrEngineFor`). */
  engine(): AsrEngine {
    return asrEngineFor(this.cfg.asr.engine, this.appLanguage, systemRecognizerSupported());
  }

  /** The sherpa-onnx engine whose model voice input downloads: the one in force, else the app language's. */
  private modelEngine(): SherpaEngine {
    const engine = this.engine();
    return engine === 'system' || engine === 'api' ? asrEngineFor('', this.appLanguage, false) as SherpaEngine : engine;
  }

  private sherpa(engine: SherpaEngine): SherpaAsr | null {
    return engine === 'whisper' ? this.whisper : this.funasr;
  }

  private recognizer(engine = this.engine()): SherpaAsr | SystemRecognizer | TranscriptionApi | null {
    return engine === 'system' ? this.system : engine === 'api' ? this.api : this.sherpa(engine);
  }

  /** The recognition language: the set one, else the app language's ISO 639-1 code; FunASR and Whisper read a code they do not take as `auto`. */
  private asrLanguage(): string {
    return this.cfg.asr.language || this.appLanguage.split('-')[0]!;
  }

  private backendState(): BackendState | null {
    return this.recognition.read();
  }

  /** The existing host entry delegates recognizer lifecycle to the ASR module. */
  startVoiceBackend(): Promise<BackendState | null> {
    return this.recognition.start();
  }

  private stopVoiceBackend(): Promise<void> {
    return this.recognition.stop();
  }

  /* ---------- talk key ---------- */

  /** Audio reaches the segmenter only while this is true. */
  private gateOpen(): boolean {
    return this.micWanted() && this.talking;
  }

  private talkHint(): string {
    return this.language === 'zh' ? '按住 Live2D 的麦克风按钮说话，松开发送' : 'Hold the Live2D microphone button to speak. Release to send.';
  }

  private setTalking(on: boolean): void {
    if (this.talking === on) return;
    this.talking = on;
    this.voiceFrame({ type: 'gate', open: on });
    if (!on) this.releaseMicSoon();
    if (!this.cfg.asr.enabled || !this.micWanted()) return;
    if (on) {
      this.listenOpen = true;
      this.tts?.stopAll();
      this.server.sendPet({ t: 'speech-stop', reason: 'voice-input' });
      this.setMicHeld(true);
      return;
    }
    const tail = this.segmenter.flush();
    if (tail) this.enqueue(tail);
    this.wasSpeaking = false;
    this.schedulePack();
  }

  /** Cancel the current recording and discard any pending transcription. */
  private cancelSpeech(): void {
    if (!this.talking && !this.listenOpen) return;
    this.talking = false;
    this.setMicHeld(false);
    this.voiceFrame({ type: 'gate', open: false });
    this.segmenter.flush();
    this.queue.length = 0;
    this.cancels++;
    this.packer.take();
    this.committing = false;
    this.partial = '';
    this.wasSpeaking = false;
    if (this.listenOpen) {
      this.listenOpen = false;
      this.server.sendPet({ t: 'listen', phase: 'none' });
    }
    this.log?.info('倾听气泡里点了取消,这次收音已丢弃');
  }

  /** Finish the local recording and deliver it when transcription settles. */
  private commitSpeech(): void {
    if (!this.cfg.asr.enabled || !this.micWanted()) return;
    this.committing = true;
    if (this.talking) this.setTalking(false);
    else {
      const tail = this.segmenter.flush();
      if (tail) this.enqueue(tail);
      this.wasSpeaking = false;
    }
    this.schedulePack();
  }

  private enqueue(u: Utterance): void {
    this.counts.utterances++;
    this.queue.push(u);
    this.server.sendPet({ t: 'listen', phase: 'transcribing' });
    void this.drain();
  }

  private onAudio(frame: Int16Array): void {
    const open = this.gateOpen();
    if (!open) return;
    for (const utterance of this.segmenter.push(frame)) this.enqueue(utterance);
    this.level = this.segmenter.level;
    const speaking = this.segmenter.active;
    if (speaking && !this.wasSpeaking) this.server.sendPet({ t: 'listen', phase: 'start' });
    this.wasSpeaking = speaking;
    const now = Date.now();
    if (now - this.lastLevelAt >= 100) {
      this.lastLevelAt = now;
      this.voiceFrame({ type: 'level', level: this.level, speaking, open });
    }
    this.schedulePack();
  }

  private async drain(): Promise<void> {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (this.queue.length) {
        const u = this.queue.shift()!;
        const cancels = this.cancels;
        const recognizer = this.recognizer();
        const res = u.result
          ? await u.result
          : recognizer
            ? await recognizer.transcribe(u.pcm)
            : { text: '', ms: 0, error: this.ui.voice.notRunning };
        if (cancels !== this.cancels) continue;
        let text = res.text;
        if (this.simplifies) text = toSimplified(text);
        if (res.error || looksHallucinated(text)) {
          this.counts.dropped++;
          this.remember({ text: res.error ? this.ui.voice.failedLine(res.error) : text, at: Date.now(), ms: res.ms, dropped: true });
          this.voiceFrame({ type: 'dropped', text: res.error ?? text, ms: res.ms });
          // the page was showing this sentence as it was heard: take it back
          if (u.result) this.showHeard();
          continue;
        }
        this.packer.add(text);
        this.remember({ text, at: Date.now(), ms: res.ms });
        this.voiceFrame({ type: 'text', text, ms: res.ms });
        this.pendingText(text);
        this.showHeard();
      }
    } finally {
      this.transcribing = false;
    }
    this.schedulePack();
  }

  private partial = '';
  private pendingText(add: string): string {
    this.partial = joinSpeech([this.partial, add]);
    return this.partial;
  }

  /* ---------- hearing as it is spoken ---------- */

  /** The sentence the recognizer is hearing now, and what it has made of it so far. */
  private sentence: SystemSentence | null = null;
  private interim = '';

  /** The segmenter hands each sentence's audio over as it arrives when the engine can take it. */
  private readonly sink: SegmentSink = {
    begin: (frames) => {
      this.sentence = null;
      this.interim = '';
      const recognizer = this.recognizer();
      if (!recognizer) return;
      const s: SystemSentence | null = recognizer.sentence((text) => {
        if (this.sentence !== s) return;
        this.interim = this.simplifies ? toSimplified(text) : text;
        this.showHeard();
      });
      this.sentence = s;
      if (s) for (const f of frames) s.write(f);
    },
    frame: (f) => this.sentence?.write(f),
    end: (kept) => {
      const s = this.sentence;
      this.sentence = null;
      if (!s) return undefined;
      const result = s.end();
      if (!kept && this.interim) { this.interim = ''; this.showHeard(); }
      else this.interim = '';
      return kept ? result : undefined;
    },
  };

  /** The listening bubble: sentences already transcribed, then the one being heard, greyed. */
  private showHeard(): void {
    this.server.sendPet({ t: 'listen', phase: 'partial', text: this.partial, interim: this.interim });
  }

  /** Delivers the packed text once nothing upstream is still open. */
  private schedulePack(): void {
    if (!this.windowVisible() || this.talking) return;
    const upstream = this.transcribing || this.queue.length > 0;
    // a commit does not wait for the closing pause, nor for speech begun after it
    const hold = upstream || (!this.committing && (this.segmenter.active || this.segmenter.settleRemainingMs > 0));
    const text = this.committing && !upstream ? this.packer.take() : this.packer.due(hold);
    if (this.committing && !upstream && !text) {
      // nothing was heard: the committed episode closes empty, unless the talk key still holds it open
      this.committing = false;
      if (this.listenOpen && !this.talking && !this.segmenter.active) {
        this.listenOpen = false;
        this.partial = '';
        this.server.sendPet({ t: 'listen', phase: 'none' });
      }
    }
    if (text) {
      this.committing = false;
      this.partial = '';
      this.listenOpen = false;
      this.counts.delivered++;
      this.server.sendPet({ t: 'listen', phase: 'heard', text });
      void this.push('desktop-live2d-pet.speech', 'desktop-live2d-pet.voice', this.t.heard(this.userName, text), 'interrupt', { meta: { text } });
      return;
    }
    if (this.segmenter.active || this.transcribing || this.queue.length > 0) this.listenOpen = true;
    else if (!hold && !this.packer.pending && this.listenOpen && !this.talking) {
      // the episode ended with nothing worth delivering; an open talk key keeps it going
      this.listenOpen = false;
      this.partial = '';
      this.server.sendPet({ t: 'listen', phase: 'none' });
    }
    if (this.packer.pending && !this.packTimer) {
      this.packTimer = setTimeout(() => { this.packTimer = null; this.schedulePack(); }, Math.max(50, this.segmenter.settleRemainingMs || 100));
    }
  }

  /** A listening episode is open on the page (bubble shown) and has not been closed yet. */
  private listenOpen = false;

  private remember(line: HeardLine): void {
    this.heard.push(line);
    if (this.heard.length > 50) this.heard.shift();
  }

  private voiceFrame(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    for (const s of this.voiceSockets) if (s.open) s.send(text);
  }

  /* ---------- tools ---------- */

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      live2d_pet_status: async () => ({ text: JSON.stringify(this.availability()) }),
      live2d_pet_say: (args, ctx) => {
        const input = ctx.round === undefined ? undefined : this.replyInput();
        if (input?.source === DESKTOP_CHAT_SOURCE && (input.meta?.via === 'bubble' || input.type === 'desktop-pet.speech')) {
          return Promise.resolve({ text: this.language === 'zh'
            ? '这条消息来自原版桌宠。请用 pet_say 回复这个入口。'
            : 'This message came from Desktop Pet. Use pet_say to answer there.', failed: true });
        }
        return this.say(args);
      },
      live2d_pet_ask: (args) => this.askUser(args),
      live2d_pet_move_to: (args, ctx) => this.moveTo(args, ctx),
      live2d_pet_act: (args) => this.act(args),
      live2d_pet_set: (args) => this.setSettings(args),
      live2d_pet_quiet: (args) => this.setQuiet(args),
    };
    const own = petToolDecls(this.appLanguage).map((decl): ToolDef => ({
      ...decl,
      handler: async (args, ctx) => this.petHidden && decl.name !== 'live2d_pet_status' && decl.name !== 'live2d_pet_say'
        ? this.notConnected(decl.name) : handlers[decl.name](args, ctx),
      ...(decl.name === 'live2d_pet_move_to' ? { interruptible: true } : {}),
    }));
    if (this.adaptation) own.push(...MODEL_TOOL_DECLS.map((decl): ToolDef => ({
      ...decl, handler: (args, ctx) => this.invokeModelTool(decl.name, args, ctx.signal),
    })));
    own.push(...CABIN_TOOLS.map((decl): ToolDef => ({
      ...decl,
      handler: async (args, ctx) => {
        try {
          const receipt = await this.cabinWorld.run(decl.name,args,ctx.signal);
          return { text:JSON.stringify(receipt), ...(receipt.ok === false || receipt.status === 'failed' ? {failed:true as const} : {}) };
        } catch (error) {
          return { text:error instanceof Error ? error.message : 'Cabin World is unavailable', failed:true };
        }
      },
    })));
    return own;
  }

  private async requestModelAdaptation(id: unknown, fromLibrary = false) {
    const intake = this.opts.modelIntake;
    if (fromLibrary) {
      const model = typeof id === 'string' && await this.opts.modelService?.editor?.(id);
      if (!model || !intake) throw Error('模型来源不可用，请重新选择模型文件夹');
      const { models, problems } = await intake.importPaths([model.modelFile]);
      if (models.length !== 1) throw Error(problems[0]?.reason ?? '未找到模型，请重新选择模型文件夹');
      id = models[0].id;
    }
    const target = intake?.candidate(id);
    if (!target || !this.adaptation) throw Error('模型分析暂不可用');
    const message = '请用 live2d_pet_model_actions 查看候选 ' + target.id + ' 的原生资源，用 live2d_pet_prepare_model 提交动作绑定建议，方案留在工作台审阅。';
    const event = await this.push('desktop-live2d-pet.message', 'desktop-live2d-pet.chat', message, 'preempt', { meta: { via: 'chat', text: message } });
    if (!event) throw Error('当前 Coo 会话未接收分析请求，请重试');
    return { accepted: true, id: target.id };
  }

  private async invokeModelTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const adaptation = this.adaptation, intake = this.opts.modelIntake;
    if (!adaptation || !intake) return this.notConnected(name);
    try {
      signal?.throwIfAborted();
      let value: unknown;
      switch (name) {
        case 'live2d_pet_models': value = await intake.importPaths(args.paths); break;
        case 'live2d_pet_model_actions': value = await adaptation.actions(args.model, args.offset, args, signal); break;
        case 'live2d_pet_prepare_model': value = await adaptation.propose(args.model, args.bindings, signal); break;
        case 'live2d_pet_save_model_adaptation': {
          const plan = adaptation.read(args.proposal);
          if (plan.status === 'pending' && plan.requiresConfirmation) {
            const answer = await this.confirm(`保存「${plan.target.title.slice(0, 30)}」的动作绑定？`, ['保存绑定', '取消']);
            signal?.throwIfAborted();
            if (answer !== 'yes') return { text: '用户未确认保存这份方案。', failed: true };
            adaptation.approve(plan.id);
          }
          value = await adaptation.apply(plan.id, signal);
          break;
        }
        default: throw Error('Unknown model tool');
      }
      return { text: JSON.stringify(value) };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), failed: true };
    }
  }

  private notConnected(tool: string): ToolOutcome {
    const w = this.windowHost?.state();
    const detail = w && w.phase !== 'running' && w.reason ? describeHostReason(this.t.window, w.reason) : null;
    return { text: this.t.notConnected(tool, detail, this.userName), failed: true };
  }

  private async say(args: Record<string, unknown>, plainText = false): Promise<ToolOutcome> {
    const script = typeof args.script === 'string' ? args.script : '';
    const shown = this.shownImages(args.images);
    if (!shown.ok) return { text: shown.reason, failed: true };
    const { beats, dropped } = plainText ? { beats: [{ text: script, actions: [], anchors: [] }], dropped: [] }
      : parseScript(script, this.vocab());
    let cues: unknown;
    if (args.cues !== undefined) {
      try { cues = parsePerformanceCues(args.cues); }
      catch (error) { return { text: error instanceof Error ? error.message : String(error), failed: true }; }
    }
    const spoken = beats.some((b) => b.text || b.actions.length || b.anchors.length);
    if (!spoken && shown.blobs.length === 0) return { text: this.t.sayEmpty, failed: true };
    const line = beats.map(b => b.text).join('');
    const hasReply = Boolean(line || shown.blobs.length);
    const figure = this.selectedModel();
    const performance = {figure, scheme:lookOf(this.cfg.skin), createdAt:Date.now(), beats, ...(cues ? {cues} : {})};
    let replyCursor: number | null = null;
    if (hasReply) {
      await this.closeActivity();
      replyCursor = await this.record({ kind: 'say', beats: beats.map(b => ({ text: b.text, ...moodOf(b.actions, this.vocab()) })),
         ...(figure ? {performance} : {}) }, line, shown.blobs);
      if (replyCursor === null) return { text: this.t.saySaveFailed, failed: true };
    }
    if (!spoken) return { text: this.t.imagesShown(shown.blobs.length, this.chat.size > 0) };
    if (!hasReply && figure) this.chat.broadcast({ t:'performance', id:nextId('mobile-action'), performance });
    const unavailable = () => hasReply ? { text: this.t.saySavedOnly } : this.notConnected('live2d_pet_say');
    if (this.petHidden || !this.server.petConnected) return unavailable();
    const modelGeneration = this.bodyControls.snapshot()?.modelGeneration;
    const planner = this.speechPlanner;
    let firstVoice = true;
    const planClips: string[] = [];
    const faces = beats.map(beat => moodOf(beat.actions, this.vocab()).mood?.id ?? null);
    const clips = beats.map((beat, index) => {
      const plan = firstVoice && !cues && planner?.ready() ? async (signal: AbortSignal) => {
        const ownsBody = () => !signal.aborted && this.windowVisible() && (this.selectedModel()) === figure
          && this.bodyControls.snapshot()?.modelGeneration === modelGeneration;
        if (!ownsBody()) return;
        const { editor } = await this.frameworkModel.editor();
        if (!ownsBody() || !editor?.catalog) return;
        const result = await planner.plan(beat.text, faces[index] ?? undefined, editor.catalog.resources, editor.profile, signal);
        if (ownsBody()) return result;
      } : undefined;
      const id = this.tts?.stage(beat.text, false, plan) ?? null;
      if (id && plan) planClips.push(id);
      if (id) firstVoice = false;
      return id;
    });
    const media = clips.some(Boolean) ? { clips, cues, faces, planClips, figure, modelGeneration } : {};
    if (!this.server.sendPet({ t: 'say', id: nextId('s'), beats, cursor: replyCursor, ...media })) {
      for (const id of clips) if (id) this.tts?.stop(id);
      return unavailable();
    }
    const now = Date.now();
    const selfSec = estimateSeconds(beats, this.cfg.window.bubbleSpeed, undefined, this.cfg.window.replyBubbleSeconds);
    const waitSec = Math.max(0, (this.busyUntil - now) / 1000);
    this.busyUntil = Math.max(now, this.busyUntil) + selfSec * 1000;
    const replaced = this.ask?.question ?? null;
    if (this.ask) this.setAsk(null);
    return { text: this.t.sayReceipt({ waitSec, selfSec, chatOpen: this.chat.size > 0, replaced, dropped, images: shown.blobs.length }) };
  }

  /**
   * The images of a `live2d_pet_say`: each handle is read through the host and attached again as bytes,
   * so the stored line keeps the picture it showed after a Memory file changes.
   */
  private shownImages(raw: unknown): { ok: true; blobs: BlobInput[] } | { ok: false; reason: string } {
    if (raw === undefined) return { ok: true, blobs: [] };
    if (!Array.isArray(raw) || raw.some((h) => typeof h !== 'string')) return { ok: false, reason: this.t.imagesNotHandles };
    if (raw.length > IMAGES_MAX) return { ok: false, reason: this.t.tooManyImages(IMAGES_MAX) };
    const blobs: BlobInput[] = [];
    for (const [i, handle] of (raw as string[]).entries()) {
      const got = this.host?.blob(handle);
      if (!got) return { ok: false, reason: this.t.imageMissing(handle) };
      if (!got.mime.startsWith('image/')) return { ok: false, reason: this.t.imageNotImage(handle, got.mime) };
      blobs.push({ bytes: got.bytes, mime: got.mime, fallbackText: this.t.shownImage(i + 1, raw.length) });
    }
    return { ok: true, blobs };
  }

  private async askUser(args: Record<string, unknown>): Promise<ToolOutcome> {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const raw = Array.isArray(args.options) ? args.options : [];
    const optionMax = capFor(ASK_OPTION_MAX, this.appLanguage);
    const options = raw.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => cutChars(o.trim(), optionMax)).slice(0, 3);
    const allowOwn = args.allowOwnAnswer !== false;
    if (!question) return { text: this.t.askEmpty, failed: true };
    if (options.length === 0 && !allowOwn) return { text: this.t.askNoWay, failed: true };
    const id = nextId('live2d-a');
    if (!this.server.sendPet({ t: 'ask', id, question, options, own: allowOwn })) return this.notConnected('live2d_pet_ask');
    const replaced = this.ask?.question ?? null;
    this.setAsk({ id, question, options });
    void this.closeActivity();
    void this.record({ kind: 'ask', askId: id, question, options, own: allowOwn }, question);
    return { text: this.t.askReceipt({ replaced, cut: raw.length > 3, chatOpen: this.chat.size > 0 }) };
  }

  /**
   * Interruptible: an interrupt stops the walk or the move where the pet stands, and the receipt says where.
   * A default target is walked to by the page; a target of the figure's own goes to its body as the call gave it
   * once its params check out against the pack's declaration (moves.ts). The body reports either way.
   */
  private async moveTo(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolOutcome> {
    const { language, t } = this;
    const pack = this.currentPack();
    const order = readMove(args, this.moves());
    if (order.kind === 'noTarget') return { text: t.moveNoTarget, failed: true };
    if (order.kind === 'badTarget') return { text: t.moveBadTarget(order.got, this.moves().map((m) => m.id)), failed: true };
    if (order.kind === 'badParams') return { text: t.moveBadParams(order.target?.id ?? null, order.target?.params.map((p) => `${p.id} ${p.min}–${p.max}`) ?? [], order.got), failed: true };
    if (order.kind === 'walk' && pack?.manifest.can.walk === false) return { text: t.walkCannot(modelName(pack.manifest.name, pack.id, language)), failed: true };
    const walkId = nextId('w');
    const sent = order.kind === 'walk' ? this.server.sendPet({ t: 'walk', id: walkId, to: order.to, run: order.run })
      : this.server.sendPet({ t: 'move', id: walkId, move: { to: order.to, run: order.run, params: order.params } });
    if (!sent) return this.notConnected('live2d_pet_move_to');
    const target = order.kind === 'move' ? modelName(order.target.name, order.target.id, language) : undefined;
    const text = await new Promise<string>((resolve) => {
      const onAbort = (): void => {
        if (!this.walks.has(walkId)) return;
        walk.stopping = true;
        this.server.sendPet({ t: 'walk-stop', id: walkId });
      };
      const done = (s: string): void => {
        ctx?.signal?.removeEventListener('abort', onAbort);
        resolve(s);
      };
      const timer = setTimeout(() => {
        this.walks.delete(walkId);
        done(target === undefined ? t.walkTimeout(WALK_TIMEOUT_MS / 1000) : t.moveTimeout(target, WALK_TIMEOUT_MS / 1000));
      }, WALK_TIMEOUT_MS);
      const walk: PendingWalk = { resolve: done, timer, ...(target === undefined ? {} : { target }) };
      this.walks.set(walkId, walk);
      ctx?.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return { text };
  }

  private async setSettings(args: Record<string, unknown>): Promise<ToolOutcome> {
    const t = this.t;
    if (selfAdjustMode(this.cfg.selfAdjust) === 'off') return { text: t.selfAdjustOff('live2d_pet_set', this.userName), failed: true };
    const packs = this.packs();
    const sizeMode = this.presentationService.state().applied ?? this.presentationService.state().desired;
    const { changes, errors } = planSettings(args, {
      ...this.cfg, user: this.userName, window: { ...this.cfg.window, scale: this.presentationSizes()[sizeMode] },
    }, packs, this.language, capFor(USER_MAX, this.appLanguage), this.appLanguage);
    if (changes.some(change => change.key === 'scale')) {
      try { this.presentationSize(sizeMode, args.scale); }
      catch (error) { errors.push((error as Error).message); }
    }
    if (errors.length) return { text: t.setErrors(errors), failed: true };
    if (!changes.length) return { text: t.setNothing };
    const lines: string[] = [];
    let failed = false, changedLook = false;
    const plannedFigure = typeof args.figure === 'string' ? args.figure : this.selectedModel();
    const apply = async (list: SettingChange[]) => {
      const skin: Partial<PetSkin> = {};
      for (const change of list) if (change.patch.skin) Object.assign(skin, change.patch.skin);
      try {
        if (Object.keys(skin).length) {
          if (!skin.figure && (this.selectedModel()) !== plannedFigure) throw Error('The model for this appearance is not active');
          await this.applySkin(skin, true);
          changedLook = true;
        }
        for (const change of list) {
          if (change.key === 'scale' && change.patch.window?.scale !== undefined) this.setPresentationSize(sizeMode, change.patch.window.scale);
          else if (!change.patch.skin) this.opts.persist(change.patch);
        }
        this.syncPrefs();
        this.opts.onBotChange?.();
        return true;
      } catch (error) {
        lines.push(t.setErrors([error instanceof Error ? error.message : String(error)]));
        failed = true;
        return false;
      }
    };
    const says = (list: SettingChange[]) => list.map((c) => c.say);
    const asksForModel = changes.some(change => change.key === 'figure' && change.tier === 'ask');
    const needsConsent = (change: SettingChange) => change.tier === 'ask' || (asksForModel && change.key === 'scheme');
    const mine = changes.filter(change => !needsConsent(change));
    if (mine.length && await apply(mine)) lines.push(t.setDone(says(mine)));
    const asked = changes.filter(needsConsent);
    if (asked.length) {
      const c = this.ui.consent;
      const answer = await this.confirm(c.question(asked.map((x) => x.show)), c.choices);
      if (answer === 'always') {
        // these items stop being asked: the rest stay as they were, under `custom`; told to the app with the changes as the bot's own
        const keys = [...new Set(asked.map((x) => x.key))];
        this.opts.persist({ selfAdjust: 'custom', selfAdjustCustom: { ...directSettings(this.cfg), ...Object.fromEntries(keys.map((k) => [k, true])) } });
        if (await apply(asked)) lines.push(t.setAlways(this.userName, says(asked), keys.map((k) => t.settingNames[k])));
      } else if (answer === 'yes') { if (await apply(asked)) lines.push(t.setAgreed(this.userName, says(asked))); }
      else lines.push(t.setNotChanged(answer === 'unavailable' || answer === 'timeout' ? answer : 'no', this.userName, says(asked)));
    }
    if (changedLook && this.server.petConnected) {
      lines.push(t.lookNow(this.bodyText(this.currentPack())));
      const note = this.vocabNote();
      if (note) lines.push(note);
    }
    return { text: lines.join('\n'), ...(failed ? { failed } : {}) };
  }

  private async setQuiet(args: Record<string, unknown>): Promise<ToolOutcome> {
    const t = this.t;
    const minutes = args.minutes;
    if (typeof minutes !== 'number' || !(minutes >= 0) || minutes > QUIET_MAX_MIN) return { text: t.quietBad(QUIET_MAX_MIN), failed: true };
    if (minutes === 0) {
      if (!this.quiet) return { text: t.quietNone };
      this.endQuiet();
      return { text: t.quietEnded };
    }
    if (selfAdjustMode(this.cfg.selfAdjust) === 'off') return { text: t.selfAdjustOff('live2d_pet_quiet', this.userName), failed: true };
    const sound = args.sound === true;
    const roam = args.roam === 'calm' ? 'calm' : 'off';
    const base = this.quiet?.base ?? { sound: this.cfg.sound, roam: this.cfg.roam };
    if (this.quiet) clearTimeout(this.quiet.timer);
    const until = Date.now() + minutes * 60_000;
    this.quiet = { sound, roam, until, base, timer: setTimeout(() => this.endQuiet(), minutes * 60_000) };
    this.syncPrefs();
    return { text: t.quietUntil(shortTime(this.opts.timezone, new Date(until)), sound, roam) };
  }

  private endQuiet(): void {
    if (!this.quiet) return;
    clearTimeout(this.quiet.timer);
    this.quiet = null;
    this.syncPrefs();
  }

  private async act(args: Record<string, unknown>): Promise<ToolOutcome> {
    const list = Array.isArray(args.actions) ? args.actions : typeof args.actions === 'string' ? [args.actions] : [];
    const vocab = this.vocab();
    const { actions, dropped } = parseActions(list, vocab);
    if (!actions.length) return { text: this.t.actNone(dropped), failed: true };
    if (!this.server.sendPet({ t: 'act', id: nextId('c'), actions })) return this.notConnected('live2d_pet_act');
    const lasting = actions.filter((a) => vocab.find((v) => v.id === a)?.lasting);
    return { text: this.t.actReceipt(actions, lasting, dropped) };
  }

  /* ---------- prompt ---------- */

  async envPromptVars(): Promise<Record<string, string>> {
    const { language, t } = this;
    const user = this.userName;
    const reply = this.opts.replyLanguage?.() ?? null;
    return {
      'pet.user': user,
      'pet.vocab': vocabTable(this.vocab(), language),
      'pet.moves': moveTable(this.moves(), language),
      'pet.voice': this.cfg.asr.enabled ? t.on : t.off,
      'pet.body': this.bodyText(this.currentPack()),
      'pet.dress': dressTable(this.libraryPacks(), language),
      'pet.self': this.selfText(),
      'pet.chat': this.opts.controls?.openChat ? t.chatPage(user) : '',
      'pet.reply': reply ? t.reply(user, reply) : '',
      'pet.cabin': this.cabinWorld.state().phase === 'active'
        ? language === 'zh' ? '当前身体在 Cabin World。行动前先用 cabin_status 或 cabin_look 看状态。cabin_task 的 done 才确认任务完成。对话回复继续写入 Coo 会话。'
          : 'Your body is in Cabin World. Use cabin_status or cabin_look first. A cabin_task result of done confirms completion. Continue replying in the same Coo conversation.'
        : language === 'zh' ? '小屋世界的 cabin_* 工具在使用者从场景页进入后可用。' : 'Cabin World tools act only after the person enters it from the scene page.',
    };
  }

  /** `{{pet.self}}`: which `live2d_pet_set` items change at once and which are asked first, or that none can change. */
  private selfText(): string {
    const t = this.t;
    if (selfAdjustMode(this.cfg.selfAdjust) === 'off') return t.selfNone(this.userName);
    const direct = directSettings(this.cfg);
    return t.selfTiers(this.userName, SELF_KEYS.filter((k) => direct[k]).map((k) => t.settingNames[k]), SELF_KEYS.filter((k) => !direct[k]).map((k) => t.settingNames[k]));
  }

  /** The environment prompt template of the model-text language. */
  private envPromptFile(): string {
    const file = ENV_PROMPT_FILES[this.language];
    return existsSync(file) ? file : ENV_PROMPT_FILES.zh;
  }

  /* ---------- WebUI ---------- */

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const w = this.windowHost?.state();
    const v = this.backendState();
    const c = petText(language).console;
    // the lamp is the window's: a browser page standing in for it is only mentioned
    const inWindow = this.server.petInWindow;
    const hint = w?.reason ? describeHostReason(petText(language).windowReason, w.reason) : c.notOpen;
    const lamps: WorldLamp[] = [
      {
        label: c.window,
        state: inWindow ? (this.bodyMissing === null ? 'online' : 'error') : w?.phase === 'running' ? 'loading' : w?.phase === 'missing' || w?.phase === 'error' ? 'error' : 'offline',
        hint: inWindow ? (this.bodyMissing === null ? c.connected : c.noBody(this.bodyMissing)) : this.server.petConnected ? c.alsoBrowser(hint) : hint,
      },
      {
        label: c.voice,
        state: !this.cfg.asr.enabled ? 'offline' : v?.phase === 'running' ? 'online' : v?.phase === 'starting' ? 'loading' : v?.phase === 'error' ? 'error' : 'offline',
        hint: v?.detail ?? v?.phase ?? c.notStarted,
      },
    ];
    return {
      label: c.label,
      lamps,
      panels: desktopPetPanelDecls(language),
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => {
        if (panel === 'chat') { this.chat.add(socket, (msg, s) => void this.onChat(msg, s, language)); return; }
        if (panel !== 'framework' && panel !== 'voice') { socket.close('no stream'); return; }
        this.voiceSockets.add(socket);
        socket.onClose(() => this.voiceSockets.delete(socket));
        if (panel === 'framework') this.chat.add(socket, (msg, s) => void this.onChat(msg, s, language, 'conversation'), true);
      },
      links: this.server.port ? [{ label: c.viewInBrowser, href: this.petUrl }] : [],
      config: desktopPetConfigGroups(language),
      promptDocs: [{
        key: `worlds.${DESKTOP_PET_ID}.envPrompt`,
        ...c.envPrompt,
        path: this.envPromptFile(),
        role: 'envPrompt',
        vars: ['pet.user', 'pet.vocab', 'pet.moves', 'pet.voice', 'pet.body', 'pet.dress', 'pet.self', 'pet.chat', 'pet.reply', 'pet.cabin']
          .map((name) => ({ name, description: c.vars[name] ?? petText('en').console.vars[name] ?? name, ...(name === 'pet.vocab' || name === 'pet.moves' || name === 'pet.dress' ? { multiline: true } : {}) })),
      }],
    };
  }

  private async invokeAudio(method: string, args: unknown[]) {
    const tts = this.tts;
    if (!tts) throw Error('Voice services are unavailable');
    switch (method) {
      case 'audio.ttsState': return tts.state();
      case 'audio.setTts': {
        const state = await tts.save(args[0]);
        if (!state.enabled) { tts.stopAll(); this.server.sendPet({ t: 'speech-stop' }); }
        return tts.state();
      }
      case 'audio.previewTts': {
        if (this.speechRemaining() > 0) throw Error('Wait for the current speech to finish');
        const text = typeof args[0] === 'string' ? args[0] : '';
        const id = tts.stage(text, true);
        if (!id) throw Error('Show Live2D and choose a configured voice service and preview text');
        if (!this.server.sendPet({ t: 'speech-preview', id })) { tts.stop(id); throw Error('The main window is not connected'); }
        return { accepted: true, id };
      }
      case 'audio.stopTts':
        if (typeof args[0] === 'string' && tts.state().playback?.id !== args[0]) return tts.state();
        tts.stopAll(); this.server.sendPet({ t: 'speech-stop' }); return tts.state();
      default: throw Error(this.ui.console.unknownMethod(method));
    }
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    // Native tabs share the existing framework data methods.
    if (panel === 'framework') {
      const presentation = this.presentationService;
      switch (method) {
        case 'phone.state': return this.opts.phone?.status();
        case 'phone.setEnabled': {
          if (!this.opts.phone || typeof args[0] !== 'boolean') throw Error('Invalid Figure Pet setting');
          return this.opts.phone.setEnabled(args[0]);
        }
        case 'phone.pair': {
          if (!this.opts.phone || typeof args[0] !== 'string') throw Error('Invalid Figure Pet address');
          return this.opts.phone.pair(args[0]);
        }
        case 'phone.revoke': {
          if (!this.opts.phone || typeof args[0] !== 'string') throw Error('Invalid Figure Pet device');
          return this.opts.phone.revoke(args[0]);
        }
        case 'phone.apk': return this.opts.phone?.apk();
        case 'controls.state': {
          const layout = readControlLayout(this.cfg.controlPages, this.cfg.hoverButtons, this.cfg.hoverButtonsVisible, this.cfg.controlPanelSize);
          return { layout, revision: JSON.stringify(layout) };
        }
        case 'controls.save': {
          const previous = readControlLayout(this.cfg.controlPages, this.cfg.hoverButtons, this.cfg.hoverButtonsVisible, this.cfg.controlPanelSize);
          if (args[1] !== JSON.stringify(previous)) throw Error(this.appLanguage.startsWith('zh')
            ? '布局已在其他入口更新，请重新读取后再保存。' : 'The layout changed elsewhere. Reload it before saving.');
          const layout = validateControlLayout(args[0], previous.panelSize);
          this.opts.persist({ controlPages: layout.pages, hoverButtons: layout.rail.join(','), hoverButtonsVisible: layout.hoverVisible, controlPanelSize: layout.panelSize });
          this.syncPrefs();
          return { layout, revision: JSON.stringify(layout) };
        }
        case 'presentation.state': return presentation.state();
        case 'presentation.setScale': {
          const {mode,scale} = this.presentationSize(args[0], args[1]);
          return this.setPresentationSize(mode, scale);
        }
        case 'presentation.previewScale': {
          if (!presentationMode(args[0])) throw Error('Invalid presentation mode');
          const value = args[1] === null ? null : this.presentationSize(args[0],args[1]).scale;
          if (!this.windowVisible() || presentation.state().applied !== args[0] || presentation.busy()) return { previewed: false };
          return { previewed: this.server.sendPet({t:'presentation-scale-preview',mode:args[0],scale:value}) };
        }
        case 'wallpaper.beginUpload':
        case 'wallpaper.appendUpload':
        case 'wallpaper.finishUpload':
        case 'wallpaper.cancelUpload': return this.wallpaperUpload(method, args);
        case 'wallpaper.state': return this.wallpapers.state();
        case 'wallpaper.setPlacement': return this.saveWallpaperComposition(args[0],args[1],args[2]);
        case 'wallpaper.import': return this.wallpapers.importPath(args[0]);
        case 'wallpaper.scan': return this.wallpapers.scan(args[0]);
        case 'wallpaper.remove': {
          if (presentation.busy()) throw Error('Wait for the scene to finish switching');
          const selected = (await this.wallpapers.state()).selected === args[0];
          if (selected && (presentation.state().desired === 'wallpaper' || presentation.mode() === 'wallpaper')) {
            const result = await presentation.select('desktop');
            if (result.phase !== 'completed') throw Error(result.error ?? 'presentation-rejected');
          }
          await this.wallpapers.remove(args[0], selected && !presentation.busy());
          return this.wallpapers.state();
        }
        case 'wallpaper.options':
          if (this.presentationService.busy()) throw Error('Wait for the scene to finish switching');
          await this.wallpapers.configure(args[0]);
          this.server.sendPet({t:'wallpaper-options', wallpaper:await this.wallpapers.settings()});
          return this.wallpapers.state();
        case 'wallpaper.cover': {
          const cover = await this.wallpapers.cover(args[0]);
          if (!cover || cover.size > 8 * 1024 * 1024) throw Error('Wallpaper cover unavailable');
          const mime = ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif'} as Record<string,string>)[cover.extension] ?? 'image/png';
          return {$binary:{mime,base64:(await readFile(cover.file)).toString('base64')}};
        }
        case 'wallpaper.choose':
        case 'wallpaper.select': {
          const wallpaper = await this.wallpapers.prepare(args[0]);
          if (this.frameworkModel.operation(args[1])) throw Error('Operation ID already belongs to a model request');
          if (method === 'wallpaper.choose') {
            if (presentation.busy()) throw Error('Wait for the scene to finish switching');
            const cabin = this.cabinWorld.state().phase;
            if (['connecting','active','leaving'].includes(cabin) || presentation.state().desired !== 'wallpaper') {
              const release = this.bodyTransaction.reserve('presentation');
              try {
                await this.wallpapers.select(wallpaper.id);
                return {phase:'completed', applied:false, selectionOnly:true};
              } finally { release(); }
            }
          }
          if (this.cabinWorld.state().phase === 'active') await this.cabinWorld.leave();
          return this.presentationService.select('wallpaper', args[1], {
            payload:wallpaper, replace:true, commit:() => this.wallpapers.select(wallpaper.id),
          });
        }
        case 'presentation.select': return this.selectScene(args[0],args[1]);
        case 'cabin.state': return this.cabinWorld.state();
        case 'cabin.conversation': return this.cabinConversation();
        case 'cabin.sendMessage': return this.sendCabinMessage(args[0],args[1]);
        case 'cabin.figures': return cabinFigureSources(this.cabinWorld.installationRoot());
        case 'cabin.importFigure': {
          const library = this.opts.figureLibrary;
          if (!library) throw Error('角色库暂不可用。');
          if (this.cabinFigureImport) throw Error('正在导入小屋角色。');
          const root = this.cabinWorld.installationRoot();
          const task = library.importGenerated((directory, signal) => writeCabinFigure(root, args[0], directory, signal));
          this.cabinFigureImport = task;
          try { return { imported:await task }; }
          finally { this.cabinFigureImport = undefined; }
        }
        case 'cabin.configure': return this.cabinWorld.configure(args[0]);
        case 'cabin.enter': return this.enterCabin(args[0]);
        case 'cabin.leave': return this.cabinWorld.leave();
        case 'cabin.actor': return this.cabinWorld.setActor(args[0]);
        case 'cabin.residents': return this.cabinWorld.refreshResidents();
        case 'cabin.tool': return this.cabinWorld.run(String(args[0]),args[1] && typeof args[1] === 'object' ? args[1] as Record<string,unknown> : {});
        case 'runtime.openPreview': return this.openModelPreview(args[0]);
        case 'runtime.openEditor': return this.openModelEditor(args[0], args[1]);
        case 'runtime.editorState': return { mode: 'browser', available: this.server.port > 0 };
        case 'runtime.openConversation': {
          const open = this.opts.controls?.openChat;
          if (!open) throw Error(this.appLanguage.startsWith('zh') ? '请从 Coo 中打开对话。' : 'Open the conversation from Coo.');
          open();
          return { opened: true };
        }
        case 'runtime.openChat':
          if (!this.windowVisible() || !this.server.sendPet({ t: 'type' })) throw Error(this.appLanguage.startsWith('zh')
            ? '请先显示 Live2D 桌宠。' : 'Show the Live2D pet first.');
          return this.petState();
        case 'resources.characterWardrobe': return this.characterWardrobe(args[0]);
        case 'resources.chooseWardrobe': return this.chooseCharacterWardrobe(args[0], args[1]);
        case 'resources.removeModel': return this.removeCharacter(args[0]);
        case 'resources.retryCover': {
          const id = args[0];
          if (typeof id !== 'string' || !this.libraryPacks().some(pack => pack.id === id && pack.rawModel)) throw Error('角色已移出模型库');
          return { queued: this.modelCovers?.enqueue(id, true) ?? false };
        }
        case 'resources.cover': {
          const id = typeof args[0] === 'string' ? args[0] : '';
          const models = this.opts.modelService;
          const pack = this.opts.figureLibrary?.find(id);
          const figureCover = pack?.manifest.thumb && this.opts.figureLibrary?.asset(id, pack.manifest.thumb);
          const cover = figureCover || (models?.directAsset?.(id, 'models/' + id + '/cover.png')
            ?? models?.directAsset?.(id, 'models/' + id + '/cover.generated.png'));
          if (!cover) throw Error('Cover unavailable');
          return { $binary: { mime: ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(cover).toLowerCase()] ?? 'image/png', base64: (await readFile(cover)).toString('base64') } };
        }
        case 'resources.requestAdaptation': return this.requestModelAdaptation(args[0]);
        case 'resources.analyzeModel': return this.requestModelAdaptation(args[0], true);
        case 'scene.state': return presentation.sceneState();
        case 'scene.move': return presentation.sceneStart(args[0], false, args[1]);
        case 'scene.interact': return presentation.sceneStart(args[0], true, args[1]);
        case 'scene.cancel': return presentation.sceneCancel(args[0]);
        case 'operation.get': if (presentation.operation(args[0])) return presentation.operation(args[0]); break;
        case 'operation.cancel': if (presentation.operation(args[0])) return presentation.cancel(args[0]); break;
      }
    }
    if(panel==='framework' && method.startsWith('runtime.'))return this.invoke('pet',method.slice(8),args);
    if(panel==='framework' && method.startsWith('voice.'))return this.invoke('voice',method.slice(6),args);
    if (panel === 'framework' && method.startsWith('resources.')) return this.invokeResources(method, args);
    if (panel === 'framework' && method.startsWith('edit.')) return this.editService.invoke(method, args);
    if (panel === 'framework' && /^audio\.(?:planner|configurePlanner|savePlanner|selectPlanner|removePlanner|testPlanner)/.test(method)) {
      if (!this.speechPlanner) throw Error('The speech planner is unavailable');
      return this.speechPlanner.invoke(method, args);
    }
    if (panel === 'framework' && method.startsWith('audio.')) return this.invokeAudio(method, args);
    if (panel === 'framework' && method.startsWith('services.')) {
      if (!this.modelServices) throw Error('模型服务暂不可用');
      return this.modelServices.invoke(method, args);
    }
    if (panel === 'framework') return this.frameworkConsole.invoke(method, args);
    if (panel === 'pet') {
      switch (method) {
        case 'state': return this.petState();
        case 'frameworkState': return this.frameworkState();
        case 'setBodyEffects': this.frameworkConfiguration.patchBodyEffects(args[0]); return this.petState();
        case 'modelEditor': return (await this.frameworkModel.editor()).editor;
        case 'saveModelProfile': return this.frameworkConsole.invoke('saveModel', args);
        case 'openDesktopModel': return this.openDesktopModel(args[0]);
        case 'openWindow':
          if (this.cabinWorld.state().phase === 'active') await this.cabinWorld.leave();
          await this.prepareWindowRuntime();
          this.openWindow(typeof args[0] === 'number' ? args[0] : undefined);
          return this.petState();
        case 'closeWindow': await this.closeDesktopWindow(); return this.petState();
        case 'recoverWindow':
          await this.prepareWindowRuntime();
          await this.closeDesktopWindow();
          this.openWindow();
          return this.petState();
        // hides the window as the pet's menu does; it stays connected and comes back with openWindow
        case 'hideWindow': this.server.sendPet({ t: 'hide' }); return this.petState();
        // the tray's "click through": kept for this run only, and sent again to a window that reconnects
        case 'setClickThrough': this.setDesktopClickThrough(args[0] === true); return this.petState();
        case 'installElectron': void this.store.electron.install(); return this.petState();
        // the Habits page's custom picks (/api/config writes no list or map): `custom` and its picks in one write, as the person's change
        case 'setWakeKinds': {
          const picked = Array.isArray(args[0]) ? args[0] as unknown[] : [];
          this.opts.persist({ touch: { wakeOn: 'custom', wakeKinds: TOUCH_KINDS.filter((k) => picked.includes(k)) } });
          return this.petState();
        }
        case 'setSelfAdjustCustom': {
          const raw = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {};
          const custom = this.selfCustom();
          for (const k of SELF_KEYS) if (typeof raw[k] === 'boolean') custom[k] = raw[k] as boolean;
          this.opts.persist({ selfAdjust: 'custom', selfAdjustCustom: custom });
          return this.petState();
        }
        case 'guide': {
          if (!this.opts.controls?.guide) throw new Error(this.ui.console.noGuide);
          this.opts.controls.guide();
          return this.petState();
        }
      }
    }
    if (panel === 'voice') {
      switch (method) {
        case 'state': return this.voiceState();
        case 'install': void this.installVoice(); return this.voiceState();
        case 'start': await this.startVoiceBackend(); return this.voiceState();
        case 'stop': await this.stopVoiceBackend(); return this.voiceState();
        case 'setEngine': {
          const engine = args[0];
          if (engine === '' || engine === 'funasr' || engine === 'whisper' || engine === 'system' || engine === 'api') this.opts.persist({ asr: { engine } });
          if (this.cfg.asr.enabled) await this.startVoiceBackend();
          return this.voiceState();
        }
        // the transcription service: address and model go to the config, the API Key to the deployment's secrets
        case 'setApi': {
          const raw = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {};
          const api: { baseUrl?: string; model?: string } = {};
          if (typeof raw.baseUrl === 'string') api.baseUrl = raw.baseUrl.trim();
          if (typeof raw.model === 'string') api.model = raw.model.trim();
          if (Object.keys(api).length) this.opts.persist({ asr: { api } });
          if (this.modelServices && (Object.keys(api).length || typeof raw.key === 'string' && raw.key.trim())) {
            const current = this.transcriptionBinding().api;
            const next = { ...current, ...api };
            if (next.baseUrl && next.model) {
              await this.modelServices.selectLegacy('asr', { use:'asr', name:'在线转写', protocol:'openai-compatible', endpoint:next.baseUrl, model:next.model, key:typeof raw.key === 'string' ? raw.key.trim() : undefined });
              return this.voiceState();
            }
          }
          if (typeof raw.key === 'string' && raw.key.trim()) this.opts.storeAsrApiKey?.(raw.key.trim());
          if (this.cfg.asr.enabled && this.engine() === 'api') await this.startVoiceBackend();
          return this.voiceState();
        }
        case 'setEnabled': this.savePrefs({ mic: args[0] === true }); return this.voiceState();
        case 'setMic': {
          this.savePrefs({ micSettings: args[0] });

          return this.voiceState();
        }
        // the meter's mark; the segmenter reads the live section, so the next frame is measured against it
        case 'setThreshold': {
          const db = args[0];
          if (typeof db === 'number' && Number.isFinite(db)) this.opts.persist({ asr: { segment: { thresholdDb: Math.max(THRESHOLD_DB_MIN, Math.min(THRESHOLD_DB_MAX, db)) } } });
          return this.voiceState();
        }
      }
    }
    throw new Error(this.ui.console.unknownMethod(`${panel}.${method}`));
  }

  /** Downloads the model of `modelEngine()`, chooses that engine, and starts it when voice input is on. */
  async installVoice(): Promise<void> {
    const engine = this.modelEngine();
    const slot = this.store[engine];
    if (slot.state().phase !== 'ready') await slot.install();
    if (slot.state().phase !== 'ready') { this.syncPrefs(); return; }
    // downloading the model is choosing it
    if (this.engine() !== engine) this.opts.persist({ asr: { engine } });
    if (this.cfg.asr.enabled) await this.startVoiceBackend();
    else this.syncPrefs();
  }

  private currentBodyEffectsFeedback() {
    return this.server.petConnected && this.bodyEffectsFeedbackKey === JSON.stringify([this.selectedModel(), bodyEffectsFor(this.cfg.bodyEffects)]) ? this.bodyEffectsFeedback : null;
  }

  private frameworkState() {
    const base = this.frameworkConfiguration.read();
    const runtime = this.bodyControls.snapshot();
    return { ...base, model: this.frameworkModel.snapshot(), runtime };
  }

  petState(): Record<string, unknown> {
    const pack = this.currentPack();
    const window = this.windowHost?.state() ?? null;
    const presentation = this.presentationService.state();
    const cabinWorld = this.cabinWorld.state();
    const bodyReady = this.bodyReady();
    const hideFromCapture = this.cfg.window.hideFromCapture === true;
    const reported = this.windowCompatibility;
    const windowCompatibility: WindowCompatibility = this.server.petInWindow && reported?.hideFromCapture === hideFromCapture
      && (reported.overTaskbar === null || reported.overTaskbar === (this.cfg.window.overTaskbar !== false))
      ? reported : { hideFromCapture, capture: this.server.petInWindow ? 'pending' : 'offline', overTaskbar: null };
    return {
      framework: this.frameworkState(),
      presentation,
      cabinWorld,
      activeScene: this.activeScene(presentation.applied, cabinWorld, bodyReady),
      connected: this.server.petConnected,
      bodyReady,
      bodyEffects: bodyEffectsFor(this.cfg.bodyEffects),
      bodyEffectsFeedback: this.currentBodyEffectsFeedback(),
      modelProvider: this.opts.modelService?.provider ?? 'unavailable',
      canOpenLive2d: !!this.opts.modelService,
      previousModelUnavailable: !!this.cfg.skin.figure && this.cfg.skin.figure !== 'coo' && !this.selectedModel(),
      clickThrough: this.clickThrough,
      theme: this.cfg.theme,
      sound: this.quiet?.sound ?? this.cfg.sound,
      scale: this.presentationSizes()[presentation.applied ?? presentation.desired],
      presentationScales: this.presentationSizes(),
      fontSize: this.cfg.window.fontSize,
      bubbleSize: this.cfg.window.bubbleSize,
      windowHint: window?.reason ? describeHostReason(this.t.window, window.reason) : this.bodyMissing,
      windowCompatibility,
      /** The connected pet page is the window's, not a browser page standing in for it. */
      inWindow: this.server.petInWindow,
      /** The pet window is connected and shown (hidden from its menu or the tray, it stays connected). */
      onDesktop: this.server.petInWindow && !this.petHidden,
      url: this.server.port ? this.petUrl : null,
      dressUrl: this.server.port ? `${this.server.origin}/dress` : null,
      /** The OBS overlay page while `window.exportOverlay` is on. */
      overlayUrl: this.server.port && this.cfg.window.exportOverlay ? `${this.server.origin}/overlay` : null,
      skin: this.effectiveSkin(),
      figureLabel: pack ? nameIn(pack.manifest.name, this.appLanguage) : undefined,
      /** What the person is called while `user` is empty, in the app language. */
      defaultUser: this.ui.defaultUser,
      window,
      electron: { ...this.store.electron.state(), supported: this.store.electron.supported },
      screen: this.screen,
      /** The Habits page's two rows, legacy values read as they now mean. */
      wake: { wakeOn: this.cfg.touch.wakeOn, wakeKinds: this.cfg.touch.wakeKinds },
      selfAdjust: { mode: selfAdjustMode(this.cfg.selfAdjust), custom: this.selfCustom() },
      /** The Habits page's typing key: the setting, the keys named in the app language, and why it cannot be read. */
    };
  }

  /** `selfAdjustCustom` with every item, the default's for one missing. */
  private selfCustom(): Record<SelfKey, boolean> {
    return directSettings({ selfAdjust: 'custom', selfAdjustCustom: this.cfg.selfAdjustCustom });
  }

  private transcriptionBinding() {
    const service = this.modelServices?.resolve('asr');
    return service === undefined ? { api: this.cfg.asr.api, key: this.opts.asrApiKey?.() ?? '' }
      : service ? { api: { baseUrl: service.endpoint, model: service.model }, key: service.key }
        : { api: { baseUrl: '', model: '' }, key: '' };
  }

  voiceState(): Record<string, unknown> {
    const modelEngine = this.modelEngine();
    const model = this.store[modelEngine];
    return {
      enabled: this.cfg.asr.enabled,
      engine: this.engine(),
      engineSetting: this.cfg.asr.engine,
      systemSupported: systemRecognizerSupported(),
      server: this.backendState(),
      model: { ...model.state(), bytes: model.bytes, engine: modelEngine },
      /** The transcription service's settings; of the API Key only whether one is saved. */
      api: { ...this.transcriptionBinding().api, keySaved: !!this.transcriptionBinding().key },
      mic: this.micState,
      input: {
        deviceId: this.cfg.asr.mic.deviceId,
        mode: 'hold',
        openOnPress: true,
        hint: this.talkHint(),
        open: this.gateOpen(),
        devices: this.devices,
      },
      level: this.level,
      thresholdDb: this.cfg.asr.segment.thresholdDb,
      recent: this.heard.slice(-20),
      counts: { ...this.counts },
    };
  }
}

export const modelsDirFor = (root: string) => join(root, DESKTOP_PET_ID);

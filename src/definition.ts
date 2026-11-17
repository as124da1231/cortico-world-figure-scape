import { createSdkService } from './live2d/sdk-service.ts';
import { modelCoverRenderer } from './live2d/model-cover-browser.ts';
import { createFigureLibrary } from './framework/figure-library.ts';
import { createModelIntake } from './live2d/model-intake.ts';
import { createModelResources } from './framework/assembly.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import { runtimesRoot, modelsRoot } from 'cortico/paths.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import { DESKTOP_PET_DEFAULTS, DESKTOP_PET_ID, DESKTOP_PET_SECRETS, type DesktopPetConfigSection, type PetSkin } from './config.ts';
import { DesktopPetWorld, modelsDirFor, type PetBotControls } from './world.ts';
import type { DescribeTool } from './status.ts';
import type { ModelLanguage } from './model-text.ts';
import { MODEL_TOOL_DECLS, petToolDecls } from './tools.ts';
import { CABIN_TOOLS } from './framework/cabin-tools.ts';
import { SELF_TYPE } from './chat.ts';
import { petText } from './i18n/index.ts';
import { HOST_ENV } from './window-host.ts';
import { workspaceHref } from './framework/workspace.ts';
import { createPhoneConnection } from './phone-link/service.ts';
import { createCabinBundle } from './framework/cabin-bundle.ts';

const BUILTIN_FIGURE = {
  id: 'figure-dab2862c640e3986ab094857',
  directory: fileURLToPath(new URL('../figures/coo-dungeon', import.meta.url)),
};

/** 内置小屋世界的拆包方式变了才需要动它;见 `scripts/split-cabin-runtime.mjs`。 */
const CABIN_BUNDLE_VERSION = 'win32-x64-1';

/** Public tools and events of the Figure Scape body. */
const DESCRIBE: WorldDescribe = {
  tools: describeTools([...petToolDecls(), ...MODEL_TOOL_DECLS, ...CABIN_TOOLS], {
    live2d_pet_models: { zh: '识别本机 Live2D 原始模型', en: 'Discovers original Live2D models.' },
    live2d_pet_model_actions: { zh: '读取模型的原生动作和表情', en: 'Inspects a model’s native actions and expressions.' },
    live2d_pet_prepare_model: { zh: '准备模型动作适配方案', en: 'Prepares a model action adaptation proposal.' },
    live2d_pet_save_model_adaptation: { zh: '保存确认后的原始模型动作绑定', en: 'Saves approved bindings to the original model profile.' },
    live2d_pet_status: { zh: '查看梦境身体是否可见、就绪，以及已确认的角色和装扮。', en: 'Checks Figure Scape visibility and readiness, including the confirmed character and outfit.' },
    live2d_pet_say: { zh: '把梦境入口的回复写入 Coo 对话，并在梦境窗口可用时播放气泡、声音和动作。', en: 'Saves a reply to the Figure Scape input in the Coo conversation and plays bubbles, audio, and motions when its window is available.' },
    live2d_pet_ask: { zh: '弹出带至多 3 个选项的提问气泡,回答之后作为事件送回。', en: 'Asks a question in a bubble with up to 3 options; the answer comes back later as an event.' },
    live2d_pet_move_to: { zh: '沿屏幕底边走到或跑到某个位置。', en: "Walks or runs along the bottom edge of the screen to a position." },
    live2d_pet_set: { zh: '修改桌宠自己的外观与习惯;按使用者的设置直接生效,或先在气泡里询问。', en: "Changes the pet's own looks and habits, at once or after asking in a bubble, as the person's settings say." },
    live2d_pet_quiet: { zh: '安静一段时间:关掉音效、停止走动,到时恢复。', en: 'Keeps quiet for a while: sound effects off and standing still until the time is up.' },
    live2d_pet_act: { zh: '不说话,播放一串表情或动作。', en: 'Plays a sequence of expressions or motions without speaking.' },
  }),
  events: [
    {
      type: 'desktop-live2d-pet.scene',
      description: { zh:'进入或离开 Cabin World，随下轮对话告知 Coo。', en:'Entering or leaving Cabin World, reported on the next conversation turn.' },
      trigger:'piggyback',
    },
    {
      type: 'desktop-live2d-pet.availability',
      description: { zh: '梦境身体就绪或离开桌面，随下轮对话投递。', en: 'The Figure Scape body became ready or unavailable, delivered with the next turn.' },
      trigger: 'piggyback',
    },
    {
      type: 'desktop-live2d-pet.message',
      description: { zh: '使用者在气泡里或对话页上打了字,对话页上的可带图片。', en: 'The person typed a message in the bubble or on the chat page; one from the chat page may carry images.' },
      trigger: 'preempt',
    },
    {
      type: 'desktop-live2d-pet.speech',
      description: { zh: '使用者按住梦境的麦克风按钮说的话，松手后转写并投递。', en: 'Transcribed speech captured while holding Figure Scape’s microphone button, delivered on release.' },
      trigger: 'interrupt',
    },
    {
      type: 'desktop-live2d-pet.answer',
      description: { zh: 'live2d_pet_ask 问题的回答,或问题没有回答就被关掉。', en: 'The answer to a live2d_pet_ask question, or the question closed unanswered.' },
    },
    {
      type: 'desktop-live2d-pet.touch',
      description: { zh: '使用者戳、摸、扔出或拎起放下了桌宠。戳和摸可报告模型的自定义部位和本地反应。', en: 'The person poked, patted, threw or dropped the pet. Pokes and pats may include a custom region and the local reaction.' },
    },
    {
      type: 'desktop-live2d-pet.figure',
      description: { zh: '使用者换了形象或装扮,或形象没能加载。', en: 'The person switched the figure or its dress, or a figure failed to load.' },
    },
    {
      type: SELF_TYPE,
      description: { zh: '桌宠自己说的话与做的事,只给对话页显示,不送给 bot。', en: 'What the pet said and did, kept for the chat page and never delivered to the bot.' },
    },
  ],
};

export interface DesktopPetAssembly {
  /** The bot's name as it is now, read at each use, so a rename needs no restart; the name at mount (`ctx.botName`) when absent. */
  botName?(): string;
  /** Run controls for the menu header; see `PetBotControls`. */
  controls?: PetBotControls;
  /** Called with each World instance Core creates, for an app that calls `confirm` on it. */
  onCreate?(world: DesktopPetWorld): void;
  /** Called after the dressing page saves a look, with that look as saved. */
  onSkin?(skin: PetSkin): void;
  /** Called after the bot changed its own settings (`live2d_pet_set`). */
  onBotChange?(): void;
  /** Called when the pet window comes onto the desktop or leaves it (`onDesktop` of the pet panel's state). */
  onDesktopChange?(onDesktop: boolean): void;
  /** What the status bubble shows for a tool call; see `DescribeTool`. */
  describeTool?: DescribeTool;
  /** The language of what the bot reads from this World, read at each use; Chinese when absent. */
  modelLanguage?(): ModelLanguage;
  /** The language the bot is to talk to the person in; see `DesktopPetWorldOptions.replyLanguage`. */
  replyLanguage?(): string | null;
  /** The app language, what the person reads; see `DesktopPetWorldOptions.language`. */
  language?(): Language;
  /** Called with each answer to computer use's question in the pet's bubble. */
}

/** The definition, with what an embedding app lends the World. */
export function desktopPetDefinition(assembly: DesktopPetAssembly = {}): WorldDefinition<DesktopPetConfigSection> {
  return {
    id: DESKTOP_PET_ID,
    // read when Core assembles the Worlds, in the app language of that moment
    get label() { return petText(assembly.language?.()).console.label; },
    defaults: () => {
      const config = structuredClone(DESKTOP_PET_DEFAULTS);
      config.skin.figure = BUILTIN_FIGURE.id;
      return config;
    },
    // ctx.cfg is the live `worlds.desktop-live2d-pet` section: hot keys are read at use
    create: (ctx) => {
      const openInCoo = process.send && process.env[HOST_ENV]
        ? (path: string) => { process.send?.({ type: 'companion:open', path }); }
        : undefined;
      const sdkService = createSdkService(ctx.dataDir);
      // 发布版把 210MB 的小屋引擎拆成资源包,这里在后台先拼好;真正进入时还会再等一次。
      const cabinBundle = process.platform === 'win32' && process.arch === 'x64'
        ? createCabinBundle({
          packageRoot: fileURLToPath(new URL('..', import.meta.url)),
          targetRoot: join(ctx.dataDir, DESKTOP_PET_ID, 'cabin-runtime'),
          version: CABIN_BUNDLE_VERSION,
        })
        : undefined;
      void cabinBundle?.prepare().catch(() => {});
      const world = new DesktopPetWorld({
        cfg: ctx.cfg,
        modelService: createModelResources({ dataDir: ctx.dataDir, sdk: sdkService }),
        coverRenderer: modelCoverRenderer(join(ctx.dataDir, DESKTOP_PET_ID, 'cover-work')),
        figureLibrary: createFigureLibrary(join(ctx.dataDir, DESKTOP_PET_ID, 'figure-library'), BUILTIN_FIGURE),
        modelIntake: createModelIntake(join(ctx.dataDir, DESKTOP_PET_ID, 'imported-sources')),
        sdkService,
        phone: createPhoneConnection({
          dataDir: ctx.dataDir,
          botDir: ctx.botDir,
          secret: name => ctx.secret(name),
          enabled: () => ctx.cfg.phoneLinkEnabled === true,
          persist: phoneLinkEnabled => ctx.persist({ phoneLinkEnabled }),
        }),
        timezone: ctx.timezone,
        persist: (patch) => {
          ctx.persist(patch);
          // the whole look as it now is: a patch may carry only the part that changed
          if (patch.skin) assembly.onSkin?.(ctx.cfg.skin);
        },
        runtimesRoot,
        windowProfile: join(ctx.dataDir, DESKTOP_PET_ID, 'window-profile'),
        modelsDir: () => modelsDirFor(modelsRoot()),
        wallpaperDir: join(ctx.dataDir, DESKTOP_PET_ID, 'wallpapers'),
        cabinRuntime: cabinBundle && {
          root: cabinBundle.root,
          dataDir: join(ctx.dataDir, DESKTOP_PET_ID, 'cabin-world'),
        },
        ensureCabinRuntime: cabinBundle ? () => cabinBundle.prepare() : undefined,
        asrApiKey: () => ctx.secret(DESKTOP_PET_SECRETS.asrApiKey),
        storeAsrApiKey: (key) => ctx.storeSecret(DESKTOP_PET_SECRETS.asrApiKey, key),
        serviceSecrets: {
          secret: name => ctx.secret('DESKTOP_LIVE2D_PET_' + name),
          storeSecret: (name, key) => ctx.storeSecret('DESKTOP_LIVE2D_PET_' + name, key),
        },
        planner: {
          secret: key => ctx.secret(`DESKTOP_LIVE2D_PET_${key}`),
          storeSecret: (key, value) => ctx.storeSecret(`DESKTOP_LIVE2D_PET_${key}`, value),
        },
        tts: {
          dataDir: ctx.dataDir,
          readKey: provider => ctx.secret(`DESKTOP_LIVE2D_PET_TTS_${provider.toUpperCase()}`),
          storeKey: (provider, key) => ctx.storeSecret(`DESKTOP_LIVE2D_PET_TTS_${provider.toUpperCase()}`, key),
        },
        botName: () => assembly.botName?.() ?? ctx.botName,
        controls: assembly.controls ?? (openInCoo ? {
          openSettings: () => openInCoo('#/provider/world%3Adesktop-live2d-pet/framework'),
          openChat: () => openInCoo(workspaceHref('framework', 'conversation')),
          openDress: () => openInCoo('#/provider/world%3Adesktop-live2d-pet/framework?task=appearance'),
          openVoiceSettings: () => openInCoo('#/provider/world%3Adesktop-live2d-pet/sound?task=listening'),
          openScenes: () => openInCoo('#/provider/world%3Adesktop-live2d-pet/desktop'),
          openWallpapers: enter => openInCoo('#/provider/world%3Adesktop-live2d-pet/desktop?task=' + (enter ? 'wallpaper-enter' : 'wallpaper')),
          openCabin: () => openInCoo('#/provider/world%3Adesktop-live2d-pet/desktop?task=cabin'),
        } : undefined),
        onBotChange: () => assembly.onBotChange?.(),
        onDesktopChange: (on) => assembly.onDesktopChange?.(on),
        describeTool: assembly.describeTool,
        modelLanguage: () => assembly.modelLanguage?.() ?? 'zh',
        replyLanguage: () => assembly.replyLanguage?.() ?? null,
        language: () => assembly.language?.() ?? 'zh',
      });
      assembly.onCreate?.(world);
      return world;
    },
    describe: DESCRIBE,
  };
}

export const DESKTOP_PET = desktopPetDefinition();

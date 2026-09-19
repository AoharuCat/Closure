import { z } from 'zod';
// Story 10.1 Wave D：material:changed 推送通道常量 re-export（shell 发射器
// materialNotify 与 preload 订阅面共同引用的名单源；preload 侧经 channels 叶子深导入
// 取值——本 re-export 供 shell barrel 消费，mirror world-panel 对 WORLD_CHANGED_CHANNEL
// 的 re-export 先例）。E10.2b Wave 1：craft:distill-progress 推送通道常量同款 re-export。
export { CRAFT_DISTILL_PROGRESS_CHANNEL, DECON_PROGRESS_CHANNEL, MATERIAL_CHANGED_CHANNEL } from './contracts/channels';
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  GenerateFallbackEntry,
  ImageGenerationRequest,
  ImageGenerationResponse,
  TextGenerationRequest,
  TextGenerationResponse,
} from './contracts/generation';
import type { ModelCapability, ModelConfig, ModelProtocol } from './contracts/model';
import type {
  DocParserProbeResult,
  ResearchConfigSave,
  ResearchConfigView,
  VisionCanaryResult,
} from './contracts/research';
import type { NovelStorySyncPayload } from './contracts/novel-orchestration';
import type { FieldPatchEntry } from './contracts/project-patch';
import type { CraftRebuildResult, RerankPayload, RerankResponse } from './contracts/closure-craft-retrieval';
import type { IndexStatus, StoryRebuildResult } from './contracts/closure-index';
import type { ChapterBrief } from './contracts/chapter-brief';
import type { ChapterAcceptArtifact, EscalateFinding } from './contracts/chapter-integration';
// 链流程重排 W4（R6 / 09-13 子3 W6）：derivation-status 查询 + 链外重提取的结果契约
//（输入镜像 Zod 单源 schema，见 chapter-chain-artifacts.ts「W4」段）。
import type { ChapterDerivationStatusResult, ReExtractChapterResult } from './contracts/chapter-chain-artifacts';
import type { ArcBeat } from './contracts/arc-registry';
import type { ArchiveIssue, CompileReport, ResearchSuspension } from './contracts/research-brief';
import type { StoryTimeDriftWarning } from './contracts/storytime-drift';
import type { RevisionIntent } from './contracts/revision-intent';
import type { RevisionGuardArtifact } from './contracts/revision-guard';
import type { BalancedAskCategory, ParticipationGear } from './contracts/batch-runs';
import type { AcceptSettingMdInput, AcceptSettingMdResult } from './contracts/setting-md-edit';
import type { ApplyAuthorProfileNoteInput, ApplyAuthorProfileNoteResult } from './contracts/author-profile';
import type { LintClassifyResult, LintFixPatch, LintFullReport } from './contracts/lint';
// 09-12 usage-panel（子5）：usage:overview 载荷契约（type-only；类型体单源 contracts/usage.ts，
// 下方「Usage panel」段 re-export 供外部消费）。
import type { UsageOverview } from './contracts/usage';
import type {
  WorldChangedEvent,
  WorldOverview,
  WorldOverviewRequest,
  WorldSliceDetail,
  WorldSliceDetailRequest,
  WorldSubjectDetail,
  WorldSubjectDetailRequest,
} from './contracts/world-panel';
import type {
  Material,
  MaterialChapterConfidence,
  MaterialChapterMethod,
  MaterialFormat,
  MaterialStatus,
} from './contracts/material';
import type {
  CraftCard,
  CraftCardCategory,
  CraftCardStatus,
  CraftTerm,
  CraftTermStatus,
  CraftTeachingRank,
} from './contracts/closure-craft-card';
import type {
  CraftDistillLedger,
  CraftDistillPhase,
  CraftDistillStatus,
  CraftMergeReview,
  CraftMergeReviewAction,
} from './contracts/closure-craft-distill';
// E10.3a（task 09-05）W6：拆解管线控制面载荷契约（job/pass 状态/canon/dictionary/entity
// 类型单源 contracts/closure-decon.ts——type-only 零 runtime 内联，preload sandbox 纪律同上）。
// E10.3b（task 09-05）W1 增补：product/report/review 三表行与维度/枚举类型同源。
import type {
  DeconCanonEntry,
  DeconDictionary,
  DeconEntity,
  DeconJob,
  DeconJobStatus,
  DeconP1Inheritance,
  DeconPassState,
  DeconProductRow,
  DeconReportKind,
  DeconReportMeta,
  DeconReportRow,
  DeconReviewCheckpoint,
  DeconReviewRow,
  DeconTier,
} from './contracts/closure-decon';

export const desktopIpcSchema = z.object({
  channel: z.enum([
    'project:pick-directory',
    'project:create-directory',
    'project:pick-cover-image',
    'project:copy-cover-image',
    'project:import-docx',
    'project:docx-to-html',
    'project:docx-to-markdown',
    'project:save-meta',
    'project:ensure-document',
    'project:sync-meta',
    'project:sync-chapters-meta',
    'project:load-meta',
    'project:load-document',
    'project:read-directory',
    'project:delete-entry',
    'project:rename-entry',
    'project:create-entry',
    'project:read-file',
    'project:read-file-binary',
    'project:write-file',
    'project:word-count',
    'project:path-exists',
    'project:save-base64-image',
    'project:move-file',
    'project:delete-file',
    'project:import-files',
    // 09-01 A 波（inbox 附件）三通道——handler 收在 shell parseDocumentHandlers.ts 同文件
    // （共享解析内核），preload 经 canonical 类型暴露（A3 契约补条目）。
    'project:parse-inbox-doc',
    'project:resolve-inbox-attachment',
    'project:store-attachment-description',
    'project:search',
    'project:watch',
    'project:unwatch',
    'project:ensure-registration',
    'project:list-registered',
    'project:touch-registration',
    'config:load-model',
    'config:save-model',
    'config:load-user-preferences',
    'config:save-user-preferences',
    'config:list-imported-fonts',
    'config:import-fonts',
    'config:import-wallpaper',
    'config:clear-wallpaper',
    'research:load-config',
    'research:save-config',
    'research:probe-doc-parser',
    'research:canary-vision',
    'model:list-remote-models',
    'model:list-cli-models',
    'model:generate-text',
    'model:generate-image',
    'model:generate-embedding',
    'model:rerank',
    // 09-12 usage-panel（子5 W3）：应用内用量面两通道（聚合读面 + 手动清空）。无推送事件
    // ——设置页「用量」段是瞬态读面（mount 拉取 + 手动刷新 + 清空/保存后重拉），design §5。
    'usage:overview',
    'usage:clear',
    // 子4 agy MCP 工具桥（09-12-agy-mcp-tool-bridge W4）：同意/状态/关闭回收三通道
    //（machine 级读写，无窗口面无 pathGuard 面；revoke 语义 = 状态翻转关闭——design §4.4）。
    'agy-bridge:status',
    'agy-bridge:consent',
    'agy-bridge:revoke',
    // 09-19 CLI 内置工具白名单（W3）：Closure 文本 Agent 状态面三通道（machine 级读写，
    // 无窗口面无 pathGuard 面；store 仅记显式 declined——无记录 = 默认开启，prd R4）。
    'agy-text-agent:status',
    'agy-text-agent:enable',
    'agy-text-agent:disable',
    'closure:rebuild-craft-kb',
    'closure:index-status',
    'closure:rebuild-story-index',
    'closure:accept-setting-md',
    'lint:scan-full',
    'lint:classify',
    'lint:apply-fix',
    'lint:model-probe',
    'author-profile:apply',
    'storySync:run',
    'field:sync',
    'field:apply-agent-patch',
    'field:toggle-lock',
    'git:is-repo',
    'git:init',
    'git:log',
    'git:commit-diff',
    'git:file-at-commit',
    'git:create-node',
    'git:list-branches',
    'git:current-branch',
    'git:create-branch',
    'git:checkout-branch',
    'git:status-count',
    'task:list',
    'task:upsert',
    'task:update-status',
    'task:delete',
    'asset:list',
    'asset:upsert',
    'asset:update',
    'asset:delete',
    'asset:import-files',
    'world:overview',
    'world:slice-detail',
    'world:subject-detail',
    // Story 10.1 Wave D：材料库管理面（list/get/delete/reingest/import/update-provenance）。
    // material:changed 推送事件不进 enum（push 通道同 world:changed 先例，名单源
    // contracts/channels.ts MATERIAL_CHANGED_CHANNEL）。
    'materials:list',
    'materials:get',
    'materials:delete',
    'materials:reingest',
    'materials:import',
    'materials:update-provenance',
    // E10.2a：材料显示名编辑（视频标题等——name 列，materialId 路径身份不变，design §3.1）。
    'materials:update-name',
    // E10.2b Wave 1（task 09-05）：手艺卡/蒸馏管线管理面（11 invoke）。craft:distill-progress
    // 推送事件不进 enum（push 通道同 material:changed 先例，名单源 contracts/channels.ts
    // CRAFT_DISTILL_PROGRESS_CHANNEL）。OrisonDesktopApi 接口方法 + preload + shell handler
    // 三层同步的其余两层归 W4/W5 waves 落地——本 wave 只落契约（apps/ 面禁改，此刻补接口
    // 方法会破 shell exposedDesktopApi satisfies OrisonDesktopApi 的 typecheck）。
    'craft:distill-run',
    'craft:card-list',
    'craft:card-get',
    'craft:card-patch',
    'craft:card-review',
    'craft:merge-review-list',
    'craft:merge-review-resolve',
    'craft:term-list',
    'craft:term-approve',
    'craft:term-merge',
    'craft:distill-status',
    // E10.3a（task 09-05）W6：拆解管线控制面（七 invoke——child A P0-P2 + 断点底座的通道族；
    // canon 浏览/reports/approve/export-style 等消费面通道归 child B 增补）。decon:progress
    // 推送事件不进 enum（push 通道同 material:changed 先例，名单源 contracts/channels.ts
    // DECON_PROGRESS_CHANNEL）。
    'decon:create',
    'decon:start',
    'decon:pause',
    'decon:cancel',
    'decon:delete',
    'decon:get',
    'decon:list',
    // E10.3b（task 09-05）W1：拆解消费面四通道（products/reports 读侧 + 人审闸门确认 +
    // 风格卡导出）。OrisonDesktopApi 接口方法 + preload + shell handler 三层同步的其余两层
    // 归 W3b/W5/W6 waves 落地——本 wave 只落契约（补接口方法会破 shell exposedDesktopApi
    // satisfies OrisonDesktopApi 的 typecheck，E10.2b W1 同款注记）。
    'decon:products',
    'decon:reports',
    'decon:approve-review',
    'decon:export-style',
    // E10.3b（task 09-05）W7 小补③：stale 确认重跑通道（A 的 confirmDeconRerun 落库函数的
    // IPC 化——刷新双指纹 + 复位派生产物后自动 start 续跑，替代「删除后重拆」引导）。
    'decon:confirm-rerun',
    'agent:create-session',
    'agent:get-session',
    'agent:set-session-mode',
    'agent:set-session-behavior-mode',
    'agent:set-session-participation-gear',
    'agent:list-sessions',
    'agent:delete-session',
    'agent:stream-message',
    'agent:resolve-confirmation',
    'agent:list-skills',
    'agent:execute-skill',
    'agent:list-continuations',
    'agent:restore-continuation',
    'agent:abort-run',
    'agent:compact-session',
    'agent:list-skill-packages',
    'agent:set-package-enabled',
    'agent:set-skill-enabled',
    'log:open-dir',
    'log:write',
    'app:get-version',
    'update:check',
    'update:download',
    'update:install',
  ])
});

/* ── Skill Package types ── */

export type SkillPackageInfo = {
  name: string;
  path: string;
  enabled: boolean;
  skills: Array<{ name: string; description?: string; enabled: boolean }>;
};

/* ── Project registry (SQLite, ~/.orison) ── */

/**
 * A project registered in the local machine registry (`~/.orison/data/projects.db`).
 * This is the durable source of truth for "which projects exist on this machine",
 * surviving app version changes / reinstalls (unlike the localStorage recent list).
 */
export type RegisteredProject = {
  projectId: string;
  name: string;
  type: 'novel' | 'script';
  /** Absolute path to the project folder (also the registry's unique fingerprint). */
  path: string;
  coverImage?: string;
  /** ISO timestamp of the last time the project was opened. */
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectLifecycleError =
  | 'invalid-name'
  | 'name-exists'
  | 'not-found'
  | 'protected-path'
  | 'operation-failed';

export type ProjectLifecycleResult =
  | { ok: true; project?: RegisteredProject }
  | { ok: false; error: ProjectLifecycleError };

/* ── Shared types ── */

export type { ModelCapability, ModelProtocol, DiscoveredModel, ApiKeyConfig, ApiKeyEntry, ModelConfig, ResolvedModel } from './contracts/model';

/* ── Usage panel（09-12 usage-panel，design §3——usage:overview 载荷契约）── */
export type {
  UsageOverview,
  UsageWindowTotals,
  UsageModelKeyRow,
  UsageModelBreakdown,
  UsageTaskBreakdown,
  UsageRecentCall,
  UsageCostTokenInput,
} from './contracts/usage';
export { estimateUsageCost } from './contracts/usage';

/**
 * usage:clear 模式 A 结果（09-12 usage-panel，design §3）：确认对话框语义归 UI 侧，
 * handler 只做清空；db 错误内部 catch + warn 后返 'operation-failed'（不上抛 renderer）。
 */
export type UsageClearResult =
  | { ok: true; deleted: number }
  | { ok: false; error: 'operation-failed' };

/**
 * Request to list models from a remote endpoint. `customHeaders`/`verifySsl`
 * (09-12 子3, design §2 #6) ride the ad-hoc path (first-key setup, no keyId
 * yet): a gateway authenticating via custom headers would otherwise make the
 * discovery request fail forever. The keyId path ignores them — the shell
 * reads the persisted key's own fields.
 */
export type ListRemoteModelsRequest = {
  keyId?: string;
  protocol?: ModelProtocol;
  apiKey?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  verifySsl?: boolean;
};

/**
 * A model discovered from the remote /v1/models endpoint.
 */
export type RemoteModel = {
  id: string;
  capability: ModelCapability;
  alias: string;
};

/* ── CLI-form provider model discovery（09-12 agy provider W4）── */

/**
 * Request to discover models from a CLI-form provider: spawns
 * `<cliExecutable> models` and parses the two-column TSV output
 * (`slug<TAB>显示名`, machine-verified shape). An empty/absent
 * `cliExecutable` asks the shell to try its default install candidates
 * (Windows: `%LOCALAPPDATA%\agy\bin\agy.exe`, then `agy.exe` on PATH).
 */
export type ListCliModelsRequest = {
  cliExecutable?: string;
};

/**
 * Typed failure codes for CLI model discovery (模式 A — each carries renderer
 * guidance, not a raw throw): `not-logged-in` (agy cached credentials missing
 * → run `agy` in a terminal first), `executable-not-found` (path/PATH miss),
 * `discovery-failed` (everything else, `detail` carries the stderr excerpt).
 */
export type CliModelDiscoveryErrorCode = 'not-logged-in' | 'executable-not-found' | 'discovery-failed';

/**
 * Discovery result. On success `resolvedExecutable` echoes the executable that
 * actually ran (the auto-detected default when the request left it empty) so
 * the renderer can persist a concrete path — the key schema requires one.
 */
export type CliModelDiscoveryResult =
  | { ok: true; resolvedExecutable: string; models: RemoteModel[] }
  | { ok: false; error: CliModelDiscoveryErrorCode; detail?: string };

/* ── CLI-form provider credential probe（09-19 dogfood R4）── */

/**
 * Probe verdict for one CLI-form key. `agy models` does NOT verify the login
 * (an unauthenticated run still lists models), so the probe runs a tiny real
 * generation (`<cliExecutable> -p "hi"`) and classifies the outcome:
 *   - `ok`: exit 0, non-empty stdout, no auth signal.
 *   - `auth-dead`: output hit the shared auth-signal word list (model-protocols
 *     `isAuthError` — same single source as the driver's error classifier and
 *     the `agy models` discovery path).
 *   - `error`: everything else (timeout / crash / empty output); `detail`
 *     carries a raw excerpt for the settings-page tooltip.
 */
export type CliProbeStatus = 'ok' | 'auth-dead' | 'error';

/** One stored probe outcome (per keyId, in shell memory only — never persisted). */
export type CliProbeSnapshot = {
  keyId: string;
  status: CliProbeStatus;
  /** ISO timestamp of when this probe ran. */
  probedAt: string;
  /** Raw failure excerpt (error verdicts only) — tooltip face, not a log face. */
  detail?: string;
};

/* ── agy MCP 工具桥（09-12-agy-mcp-tool-bridge 子4 W4）── */

/** 同意值：allowed = 已同意（假宿副本可写预授权）；declined = 已拒绝（记住，降级纯文本）。 */
export type AgyBridgeConsentValue = 'allowed' | 'declined';

/** 运行前状态机四态（design §4.2/§5.1：declined > conflict > missing-consent > ok）。 */
export type AgyBridgeConsentState = 'ok' | 'missing-consent' | 'conflict' | 'declined';

/**
 * 桥状态读面（agy-bridge:status / consent 写后回显）：状态机四态 + 冲突规则原文（用户
 * deny/ask 压制——UI 列原文指引自行调整，不代删）+ 当前同意值 + 假宿根/同意文件路径
 * （设置页展示用）。
 */
export type AgyBridgeStatusView = {
  state: AgyBridgeConsentState;
  conflicts: string[];
  consent: AgyBridgeConsentValue | undefined;
  homeRoot: string;
  consentFilePath: string;
};

/**
 * agy-bridge:consent 模式 A 结果：写失败 'operation-failed'（warn 记日志不上抛）；
 * 成功附写后状态视图（consent=allowed 而用户 deny/ask 压制时 UI 即时见 conflict 态）。
 */
export type AgyBridgeConsentResult =
  | { ok: true; view: AgyBridgeStatusView }
  | { ok: false; error: 'operation-failed' };

/**
 * agy-bridge:revoke 结果（关闭回收 = 状态翻转回未配置；用户真实全局零写入——无条目
 * 移除面）。活动桥会话存在 → 'active-sessions'（附会话 id——UI 如实说明释放条件：桥会话
 * 闲置超时后自动回收，与对话是否结束无关）；
 * 存储错误 → 'operation-failed'（warn 记原文不上抛——与 consent 通道同语义，不伪装
 * 成活动会话占用）。
 */
export type AgyBridgeRevokeResult =
  | { ok: true }
  | { ok: false; error: 'active-sessions'; activeSessions: string[] }
  | { ok: false; error: 'operation-failed' };

/* ── Closure 文本 Agent（09-19-cli-builtin-tool-whitelist W3）── */

/**
 * 真实全局 agent.md 文件四态（design §1.2）：current（Closure 尾标记 + hash 一致）/
 * stale（有标记但 hash ≠ 当前生成器输出——启动对账即修）/ foreign（存在但无标记——
 * 外来文件，绝不覆盖/误删）/ missing（启动对账即修）。
 */
export type AgyTextAgentFileState = 'current' | 'stale' | 'foreign' | 'missing';

/**
 * 文本 Agent 状态读面（agy-text-agent:status / enable / disable 写后回显）：
 * - enabled = 开关维（无 declined 记录 = 默认开启，prd R4）；cliKeyPresent = 启用前提
 *   第二半（存在任一 antigravity-cli provider key）——两者齐备才实际挂 agent。
 * - shadowedBy ≠ 空 = 同 frontmatter `name` 遮蔽警示（agy 对同名零警告静默竞速——装机
 *   探针定谳；路径级 foreign 检测罩不住，一层扫描外来路径呈报，宁误报不漏报，不代删；
 *   不阻断我方文件维护）。
 */
export type AgyTextAgentStatusView = {
  enabled: boolean;
  cliKeyPresent: boolean;
  fileState: AgyTextAgentFileState;
  /** 同 frontmatter `name` 遮蔽我方的外来 agent.md 绝对路径（空 = 无遮蔽）。 */
  shadowedBy: string[];
  /** 真实全局 agent.md 绝对路径（卡片披露 + 冲突态展示）。 */
  agentFilePath: string;
  /** 同意状态文件路径（仅记显式 declined）。 */
  consentFilePath: string;
};

/**
 * agy-text-agent:enable 模式 A 结果：foreign-conflict = 外来同名文件压住我方路径（拒写
 * 不覆盖——路径经 status 的 agentFilePath 呈现，不代删）；operation-failed = 写失败
 * （warn 记日志不上抛）。成功附写后状态视图。
 */
export type AgyTextAgentEnableResult =
  | { ok: true; view: AgyTextAgentStatusView }
  | { ok: false; error: 'foreign-conflict' | 'operation-failed' };

/**
 * agy-text-agent:disable 模式 A 结果：declined 记住 + 自有文件回收（验 Closure 尾标记
 * 才删——外来文件绝不动）。
 */
export type AgyTextAgentDisableResult =
  | { ok: true; view: AgyTextAgentStatusView }
  | { ok: false; error: 'operation-failed' };

/* ── Generation IPC payloads ── */

/**
 * Model reference used in generation requests.
 * Points to a specific key + model combination.
 */
export type ModelRef = {
  keyId: string;
  modelId: string;
};

export type GenerateTextPayload = {
  ref: ModelRef;
  request: TextGenerationRequest;
  /**
   * Ordered fallback chain behind `ref` (09-12 子2 fallback chains): the
   * hand-written mirror of generateTextPayloadSchema's additive `fallbacks` —
   * ABSENT = zero-default single-model path; ≥1 entries = the gateway loop
   * advances through them on fallback-eligible failures. Normalized wire form
   * ({ref, thinking?} — never the raw slot fields).
   */
  fallbacks?: GenerateFallbackEntry[];
};

export type GenerateImagePayload = {
  ref: ModelRef;
  request: ImageGenerationRequest;
};

export type GenerateEmbeddingPayload = {
  ref: ModelRef;
  request: EmbeddingRequest;
};

/**
 * Story-sync IPC payload.
 */
export type RunStorySyncPayload = {
  ref: ModelRef;
  runId: string;
  chapterId: string;
  candidate: Record<string, unknown>;
  context: Record<string, unknown>;
  fieldVersions: Partial<Record<string, number>>;
};

export type RunStorySyncResult = {
  patches: NovelStorySyncPayload['patches'];
  summary: string;
  fallbackToRules: boolean;
};

// ── Story 4.0 写章战术链段：dogfood IPC `closure:run-chapter-chain`（design §4.8 / implement.md 6.2）──
//
// 无工作台 leader session 时（4.0 工作台 UX defer E3/4.1），dogfood + 测试经此 IPC 触发链段：
// handler loadProject → assembleChapterChainArtifacts → runtime.runChapterChain(stubParentSession, artifacts)。
// 结构镜像 leader `write_chapter` tool（agent）——两入口共用 assembleChapterChainArtifacts 纯函数。

/**
 * `closure:run-chapter-chain` 请求体。
 *
 * - projectPath：项目根绝对路径（loadProject 读 `<projectPath>/project.yaml`）。
 * - episodeId：本章目标 episode（refs episode_outlines[].id）。
 * - chapterBrief：leader 填的 LLM 段（#1-5,10）；缺 → 空 brief（brief-compiler 仅填 #6 from scene_graph）。
 * - sceneIds：可选场过滤（4.0 未用——brief-compiler 按 episodeId 匹配场；预留 4.1 细化）。
 * - chapterId：可选，用户工作台选章直传（4.1 Step 4；绕过 episode.index→sort_order 映射推断，优先）。
 */
export type RunChapterChainInput = {
  projectPath: string;
  episodeId: string;
  chapterBrief?: ChapterBrief;
  sceneIds?: string[];
  chapterId?: string;
};

/**
 * Story 4.3 Step 3：`closure:resume-chapter-chain` 请求体（design §3.5 / controller resume 设计）。
 *
 * resume/redo/abort 走结构化 IPC（mirror 4.6 PatchReview accept/reject 模式，非 leader LLM 解释）。
 * 镜像 `resumeChapterChainInputSchema`（chapter-chain-artifacts.ts，Zod 单源）。
 *
 * - projectPath：项目根绝对路径（assertSafePath 守卫 + 持久化目录）。
 * - sessionId：chainSnapshot 所在 parent 会话（leader session / dogfood stub parent）——runChapterChain
 *   读 runState.getChainSnapshot(sessionId) 续跑。
 * - chapterId：optional，UI 透传（持久化映射用，同 RunChapterChainInput.chapterId 语义）。
 * - action：continue（续跑）/ redo（重跑 draft-writer，带 feedback）/ abort（清 chainSnapshot 弃链段）。
 * - feedback：redo 时的改稿指令（进 draft-writer user prompt 的 {{revisionFeedback}}；其他 action 忽略）。
 * - revisionIntent：Story 7.1 Route 1——B trigger 选区指挥精修时，用户确认后的 RevisionIntent（进
 *   initialArtifacts['revision_intent']，draft-writer 段落级 directive + splice 消费；其他 action 忽略）。
 *   与 feedback 互斥语义：feedback 是 C trigger 整章自由文本（redo_feedback artifact），revisionIntent 是
 *   B trigger 结构化意图（revision_intent artifact）。两者可共存（feedback 作补充说明）但不强制。
 * - guardOverride：Story 7.2 art-mode——soft-violation pause 后作者「强行放行」（revision_guard_override
 *   artifact → revision-guard force-accept splice）。**仅 action=redo 时透传**（soft-violation pause 时 guard 已
 *   在 completedNodes，continue 会跳过 → splice 不发生；IPC redoOpts 据 guardOverride 切 redo.nodeId）。
 * - editedDraft：链流程重排 W2（R3 终稿手改通道）——人手改正文**全文**（终稿卡编辑面产出），仅
 *   action=accept（终稿 checkpoint 专属动作）合法。shell resume 入口先 F1a 立即落正文再续跑 E 段
 *   （editedDraft 覆写 draft.initial.text + wordCount 机械重算 + 申报类 stale 清理，applyEditedDraft 单源）。
 */
export type ResumeChapterChainInput = {
  projectPath: string;
  sessionId: string;
  chapterId?: string;
  action: 'continue' | 'accept' | 'redo' | 'abort';
  feedback?: string;
  /** Story 7.1 Route 1：B trigger 选区精修的 RevisionIntent（revision_intent artifact 注入）。 */
  revisionIntent?: RevisionIntent;
  /** Story 7.2 art-mode：soft-violation 强行放行（revision_guard_override artifact 注入）。 */
  guardOverride?: 'force-accept';
  /** 链流程重排 W2：终稿手改全文（action=accept 可选载荷；F1a 立即落正文 + E 段对改后正文提取）。 */
  editedDraft?: string;
};

/**
 * Story 7.1 Route 1：`closure:compile-revision-intent` IPC 请求体（B trigger 选区指挥精修）。
 *
 * UI 在 draft checkpoint pause 后，用户在 TipTap 选段 + 写粗指令 → 调本 IPC 派 revision-optimizer 子 agent
 * 编译 RevisionIntent。selectedPassage + userInstruction 是核心入参；chapterContext（本章 brief）+ auditFindings
 * 是 optional 辅助（帮 optimizer 判锁定项背景）。
 *
 * 🔑 Story 7.1 BMad CR F2（范式订正）：scope.anchor 由 **IPC 层纯代码构造**（非 LLM 产）——
 * `selectionFrom/selectionTo`（TipTap ProseMirror 位置）+ `draftText`（整章正文）经 IPC 传入，
 * IPC 用确定性字符串切片构 SelectionAnchor（quote=selectedPassage / prefix=slice(from-N,from) /
 * suffix=slice(to,to+N) / rangeHint={from,to}）。anchor 是非语义机械活归纯代码（ADR-3 /
 * feedback-semantic-llm-nonsemantic-purecode）；LLM 只编译意图（change/locks/rationale），不产 anchor。
 */
export type CompileRevisionIntentInput = {
  projectPath: string;
  sessionId: string;
  /** 作者选中的正文段（改稿范围，渲染 revision-optimizer yaml {{selectedPassage}}，也作 anchor.quote）。 */
  selectedPassage: string;
  /** 作者粗指令原文（硬权威来源，渲染 {{userInstruction}}，也作 provenance.rawUserInstruction 的 ground truth）。 */
  userInstruction: string;
  /** 本章创作意图（brief LLM 段 JSON 串，渲染 {{chapterContext}}，帮 optimizer 判锁定项背景）。optional。 */
  chapterContext?: string;
  /** Reader-Audit 审核发现 JSON 串（渲染 {{auditFindings}}；B trigger 通常空，A trigger 归 7.4）。optional。 */
  auditFindings?: string;
  /** 🔑 F2：选区起始 ProseMirror 位置（IPC 构 anchor.rangeHint.from + 切 prefix）。required（B trigger 必带选区）。 */
  selectionFrom: number;
  /** 🔑 F2：选区结束 ProseMirror 位置（IPC 构 anchor.rangeHint.to + 切 suffix）。required。 */
  selectionTo: number;
  /** 🔑 F2：整章 draft 正文（IPC 构 anchor.prefix/suffix 切片源；splice 目标文本）。required。 */
  draftText: string;
  /** 选区锚点上下文窗口（prefix/suffix 切多少字符，default 50）。optional。 */
  anchorContextChars?: number;
};

/**
 * Story 7.1 Route 1：`closure:compile-revision-intent` IPC 响应。
 *
 * - `intent`：编译出的 RevisionIntent（用户确认关用）；null = 编译失败 graceful（optimizer 不可用 / parse 失败）。
 * - `error?`：失败原因（UI 据此告知「意图编译失败，请重述或手改」）。
 */
export type CompileRevisionIntentResult = {
  intent: RevisionIntent | null;
  error?: string;
};

/**
 * `closure:run-chapter-chain` 响应 = RunSnapshot 摘要（context isolation，design §4.3 / ADR-17）。
 *
 * 镜像 agent `RunSnapshotSummary`（contracts/run.ts）shape——链段只回摘要给调用方，不灌内部 trace /
 * 全量 artifacts。agent RunSnapshotSummary 结构上满足本类型（TS 结构兼容）。
 *
 * CR-15a 落地公理：`draftText`（初稿/修订稿正文）是 deliverable 非 internal trace——读者/dogfood 须能
 * 检视产出正文（[[project-prose-landing-axiom]]），prose 豁免 context isolation。
 *
 * CR-15b（4.1 Step 4）：`chapter_accept` = accept 持久化载荷（chapterId + candidate + storyDecisions），
 * 亦为 deliverable 非 internal trace——入口层（IPC 直接写盘 / leader 转 field_patch 走 patch review）
 * 据此持久化 chapters/*.md + project.yaml + story_decisions。同 draftText 豁免 context isolation。
 */
export type RunChapterChainSummary = {
  status: string;
  routeDecision?: {
    decision: string;
    reason: string;
    /**
     * dogfood R2 #107 / R1.1c：route 判正文偏离计划（deviation=true）时投影——#107 no-chapter
     * 自动建章的入口层补产 storyDecisions 数据源（buildAcceptStoryDecisions 单源消费）。
     * 只在 true 时出现（false/缺省省略——route 非 accept 终态本就无此语义）。additive optional
     * （零 migration）。镜像 agent RunSnapshotSummary.routeDecision.deviation（两处平行 type 同步）。
     */
    deviation?: true;
  };
  reviewVerdict?: string;
  draftTitle?: string;
  draftWordCount?: number;
  /** 初稿/修订稿正文（CR-15a：prose 是 deliverable，豁免 context isolation）。 */
  draftText?: string;
  /**
   * accept 持久化载荷（CR-15b：route=accept_as_truth 时，链段 onAccept 产；deliverable，豁免 context isolation）。
   * 入口层据此持久化：IPC 调 acceptChapterCandidate 写盘 / leader 转 field_patch metadata 走 patch review。
   * route 非 accept / chapterId 映射失败 → 缺省（持久化阻断，调用方报明确错误）。
   */
  chapter_accept?: ChapterAcceptArtifact;
  /**
   * route=escalate_user 时附带：Reader-Audit 灰区 findings grounding（quote/location/severity），
   * 供裁决器子 agent 初审 + 用户裁决（Story 4.6）。非 escalate 缺省。
   */
  escalateFindings?: EscalateFinding[];
  /**
   * Story 4.3：status='paused' 时链段暂停的 checkpoint 阶段（brief/draft/verdict）。供 leader / UI 决定 review
   * 形态（draft→prose-review 面板 / brief→对话软门 / verdict→PatchReview）。非 paused 缺省。
   * additive optional（零 migration）。镜像 agent RunSnapshotSummary.pausedStage。
   *
   * Story 7.2：加 'revision-guard'（段落级改稿保义门 soft-violation pause → art-mode 卡）。UI 据 pausedStage
   * = 'revision-guard' 展 guard 确认卡（findings + before/after + 强行放行/改/取消）。
   *
   * 链流程重排 W2：加 'final'（终稿人审——route accept 后、E 段前；正文可编辑 + accept 可携
   * editedDraft）。旧 'draft'/'verdict' 已退出 deriveCheckpointPolicy 停点集（枚举值保留兼容旧载荷）。
   */
  pausedStage?: 'brief' | 'draft' | 'final' | 'verdict' | 'revision-guard';
  /**
   * 链流程重排 W2（plan-review M5）：终稿 checkpoint（pausedStage='final'）的审读摘要——终稿卡呈现
   * 「AI 自审收敛了几轮、结论如何」。镜像 agent RunSnapshotSummary.reviewSummary（两处平行 type
   * 同步，B01 纪律）。非 final pause 缺省。
   */
  reviewSummary?: { verdict: string; reasons: string[]; loopCount: number; capExhausted: boolean };
  /**
   * 链流程重排 W2（R2 去味门禁）：终稿 checkpoint 的 lint 终态报告 digest（命中计数 + 高优命中摘录）。
   * 镜像 agent RunSnapshotSummary.lintReport。非 final pause 缺省。
   */
  lintReport?: string;
  /**
   * 链流程重排（W2 引入 / W3 接真判决）：去味门禁信号——终轮 review.latest 含 L2 确认的 lint 来源
   * 条目（finding.source==='lint' 且 severity=block/warn——判真伪归 multi-review L2，判源不判义）。
   * hardEscalate='auto' 的 cap 超限两支（终弃 vs 采信）消费。缺省 = 门禁过 / 无 lint 确认（保守采信）。
   * 镜像 agent RunSnapshotSummary.lintUnresolved。
   */
  lintUnresolved?: true;
  /**
   * 链流程重排 W2（R4c 落盘拆两步 / AC2c）：E 段提取失败章标——route accept 已过（终稿已定）但
   * E 段节点 error 中断。入口层据此走 post-hoc 落正文 + 章标 stale + 指引 re-extract 修复通道
   * （W4 落地）。镜像 agent RunSnapshotSummary.derivationStale。
   */
  derivationStale?: true;
  /**
   * Story 4.3：draft checkpoint pause 时的正文（review payload，豁免 context isolation 同 CR-15a prose 是 deliverable）。
   * 源 `artifacts['draft.initial'].text`。非 paused 缺省。镜像 agent RunSnapshotSummary.draftContent。
   */
  draftContent?: string;
  /**
   * Story 4.3：brief checkpoint pause 时的 chapter_brief artifact（review payload，豁免 context isolation）。
   * 非 paused 缺省。镜像 agent RunSnapshotSummary.briefContent。
   */
  briefContent?: unknown;
  /**
   * Story 7.2：pausedStage='revision-guard' 时的保义门载荷（soft-violation findings + 改前/改后 + L1 幅度）。
   * 供 UI art-mode 确认卡展示（作者据此决定强行放行/改/取消）。deliverable 非 internal trace（同
   * draftContent/escalateFindings 豁免 context isolation）。非 revision-guard pause 缺省。
   * 镜像 agent RunSnapshotSummary.revisionGuard。
   */
  revisionGuard?: RevisionGuardArtifact;
  /**
   * Story 2.2 WP-E（CR-08-16-201）：resume 终态透传 story-sync 提取载荷（mirror agent
   * RunSnapshotSummary.storySync 的 deliverable 豁免——suggest 档链段必在 draft checkpoint
   * pause，终态提取只能经 resume IPC 回到 UI/落盘点，write_chapter 的 applier 走不到）。
   * 由 resume IPC handler 消费（转 story_sync_apply），非 paused/completed 直跑路径缺省。
   */
  storySync?: NovelStorySyncPayload;
  /**
   * Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺的**人审档**产出——shell 消费 storySync 后
   * 把投影 envelope 组（FULL data + fieldVersion=diskVersion+1，mirror write_chapter suggest 档
   * metadata.storySyncPatches 形态）挂在这里返给 UI；chapterReviewSlice.runResume 路由进
   * PatchReview（setPendingPatch merge）。auto 档直落时不设（走 storySyncLanded）。
   */
  storySyncReview?: { note: string; patches: FieldPatchEntry[] };
  /**
   * Story 2.2 WP-E（CR-08-16-201）：resume 终态反哺的 **auto 直落档**产出（已落盘字段清单 +
   * 章节出处）——UI toast 告知（非静默）。suggest 档不设（走 storySyncReview）。
   */
  storySyncLanded?: { note: string; fields: string[] };
  /**
   * dogfood R2 #93（P0-2）：resume 终态 chapter_accept 的落盘去向标记。true = shell 侧已直落
   * chapters/（auto 档 dogfood stub 会话语义 / auto-trust 采信 accept）；缺省 = 未落盘——envelope
   * 仍在 `chapter_accept` 字段，待 UI 路由进 pendingPatch 人审（suggest/readonly leader 会话，
   * mirror write_chapter metadata field_patch 路径——resume 车道跑在 leader 工具调用生命周期外，
   * envelope 只能经 resume summary 返 UI）。UI（chapterReviewSlice.runResume）据此分流：未落盘 →
   * stage 审核卡；已落盘 → toast 告知（非静默）。
   */
  chapterPersisted?: true;
  /**
   * Story 8.2：本章写时声明的弧节拍（arc-emergence-node 产经 arcRegistry 透传；无则空数组）。
   * 供入口层关口判定（卷弧 close beat → arc-audit-agent 大审）+ 停滞检测。镜像 agent
   * RunSnapshotSummary.arcEmergenceBeats（两处平行 type 同步，B01 纪律——arc-registry.ts
   * ArcBeat 单源）。
   */
  arcEmergenceBeats?: ArcBeat[];
  /**
   * Story 8.4 Step 3（A7 档案议题通道）：出发核查（资料员）verdict 的 archive_issues 透传（设定卡
   * 疑似过时/与正文矛盾）。deliverable 非 internal trace（同 escalateFindings 豁免）——leader/用户
   * 须看见处理（资料员只报告不改档案）。空/缺不抽（零痕迹）。additive optional（零 migration）。
   * 镜像 agent RunSnapshotSummary.archiveIssues（两处平行 type 同步，B01 纪律——research-brief.ts
   * archiveIssueSchema 单源）。
   */
  archiveIssues?: ArchiveIssue[];
  /**
   * Story 8.4 C2（design §3.3）：提取器 storyTime 漂移 warning 透传（本章提取的世界状态事件时间落在
   * 本章场景 storyTime 窗外——提取误差 / scene_graph 过时 / 跨章误归属，机械层不区分）。零阻断零噪音
   * （warning 不停链；对齐/无数据章缺省不抽）。additive optional（零 migration）。镜像 agent
   * RunSnapshotSummary.driftWarnings（两处平行 type 同步，B01 纪律——storytime-drift.ts 单源）。
   */
  driftWarnings?: StoryTimeDriftWarning[];
  /**
   * Story 8.4 Step 4（A8）：draft pause 因出发核查挂起（矛盾/超限）时的挂起载荷（用户决断所需证据，
   * deliverable 豁免 context isolation——mirror escalateFindings）。全档位暂停（含 auto），恢复 = redo
   * 重跑该章。非挂起 pause / 非 paused 缺省。镜像 agent RunSnapshotSummary.researchSuspension
   * （两处平行 type 同步，B01 纪律——research-brief.ts researchSuspensionSchema 单源）。
   */
  researchSuspension?: ResearchSuspension;
  /**
   * Story 8.4 B1（design §2.1）：热层编译报告透出（源 artifacts['compile_report']，brief-compiler-node
   * 汇总点产；mirror 章摘要 tokenEstimate 先例）。segments 各段 token 估算 + total（两编译点之和）+
   * degraded（降级动作记录，缺失 = 未降级 L0）+ overloaded（L3 复杂场景标记——建议拆章人审）。artifact
   * 缺（旧链 / bypass 路径）缺省。additive optional（零 migration）。镜像 agent RunSnapshotSummary
   * .compileReport（两处平行 type 同步，B01 纪律——research-brief.ts compileReportSchema 单源守形）。
   */
  compileReport?: CompileReport;
  errors: string[];
};

export type UserPreferencesConfig = {
  theme: string;
  locale: string;
  /** Whether to silently check for updates on startup. Defaults to true. */
  autoCheckUpdates?: boolean;
  /** @deprecated Custom manifest URL — superseded by the electron-updater GitHub feed. Read for back-compat only. */
  updateManifestUrl?: string;
  /** Reading font family for editor + agent panel body text. CSS font-family value or font stack name. */
  readingFontFamily?: string;
  /** Reading font weight for editor + agent panel body text (e.g. 400 / 500 / 600). */
  readingFontWeight?: number;
  /** Reading font scale multiplier for editor + agent panel body text (1 = default). */
  readingFontScale?: number;

  // ── Writing settings ──
  paragraphIndent?: boolean;
  showWordCount?: boolean;
  /** Whether auto-save is enabled. When false, only manual Ctrl+S saves. Defaults to true. */
  autoSaveEnabled?: boolean;
  /** Auto-save debounce interval in milliseconds. Defaults to 1500. */
  autoSaveInterval?: number;
  /** Whether the manuscript/code editors enable native browser spellcheck. Defaults to false. */
  spellCheck?: boolean;
  /** Target character count for the active document. 0 = no goal. Defaults to 0. */
  wordCountGoal?: number;

  // ── Appearance settings ──
  editorLineHeight?: number;

  // ── App wallpaper（08-25 全窗口背景，壁纸式不分区）──
  /**
   * Full-window wallpaper image URL (`orison-file:///` + absolute path of a
   * copy under `userData/wallpaper/` — the copy decouples the background from
   * the source file). Empty/undefined = no wallpaper.
   */
  wallpaperUrl?: string;
  /** Wallpaper image opacity 0.1–1.0 (default 1). 10% floor keeps it visible. */
  wallpaperOpacity?: number;
  /**
   * Frosted-glass blur radius for the wallpaper layer, in px (0–50 integer,
   * default 0 = off). Blurs the image itself so busy backgrounds stop fighting
   * foreground text. Purely cosmetic — no effect when no wallpaper is set.
   * Legacy boolean `wallpaperFrost` (08-26 fixed-20px toggle) normalizes on the
   * shell read path — true → 20, false/missing/garbage → 0 — and the write path
   * only ever persists this numeric key (zero migration for old disk files).
   */
  wallpaperFrostBlur?: number;

  // ── Context compaction (conversation window) ──
  /**
   * Conversation context-compaction controls. `redlinePercent` is the
   * context-window usage percentage (50–100, default 95) at which automatic
   * compaction triggers — below the redline nothing is compacted (thinking
   * history etc. is preserved verbatim). 95 ≈ "compact only when the window is
   * nearly full", leaving headroom for the reply. Persisted flat as
   * `contextCompaction.redlinePercent`; the shell read path clamps to 50–100
   * and falls back to the default on illegal/missing values.
   */
  contextCompaction?: { redlinePercent: number };

  // ── Global interface scale（08-26 structure-rebuild R8）──
  /**
   * Whole-app UI zoom level. Must be a finite number within the legal band;
   * anything else (hand-edited YAML / corrupt value / missing key on legacy
   * files) clamps back or falls back to 1 at every consumption point — see
   * clampInterfaceScale. NOTE: this preference is persisted and displayed by
   * the renderer, but APPLIED by the shell (webContents.setZoomFactor), not as
   * CSS zoom / root font-size — mechanism trade-offs are documented at the
   * helper below.
   */
  interfaceScale?: number;

  // ── In-app usage ledger retention（09-12 usage-panel，R5 数据治理）──
  /**
   * closure_llm_log 滚动保留窗天数（启动期 prune + 变更即 prune + 清空）。缺省 90；
   * 手改合法带 [7, 730]——带外值在每个消费点经 clampUsageRetentionDays 归位（mirror
   * interfaceScale 的 lenient-read 形态）。「累计」语义 = 保留窗内累计（prune 后历史
   * 不可恢复，UI 文案如实标注）。配置读写搭既有 config:load/save-user-preferences
   * 通道（shell 读侧默认合并归位，W3 接线）。
   */
  usageRetentionDays?: number;
};

/** Preset levels offered in Settings ▸ 外观; rendered as 85% / 100% / 115% / 130%. */
export const INTERFACE_SCALE_PRESETS = [0.85, 1, 1.15, 1.3] as const;
/** Legal hand-edit band; out-of-band values clamp back (shell read/write + renderer defensive). */
export const INTERFACE_SCALE_MIN = INTERFACE_SCALE_PRESETS[0];
export const INTERFACE_SCALE_MAX = INTERFACE_SCALE_PRESETS[INTERFACE_SCALE_PRESETS.length - 1];

/**
 * R8 default zoom (single source). The `UserPreferencesConfig.interfaceScale` schema
 * key stays optional (legacy files without it are the normal case), so consumers
 * reference THIS constant instead of re-deriving from
 * `DEFAULT_USER_PREFERENCES.interfaceScale` — that shape forces either a `!`
 * assertion or a scattered `?? 1` at every consumption point; both vanish when
 * the default lives here (BMad CR 组4：interfaceScale 契约单一化).
 */
export const INTERFACE_SCALE_DEFAULT: number = INTERFACE_SCALE_PRESETS[1];

// ── Usage ledger retention band（09-12 usage-panel，design §3 搭车 preferences）──
// 先于 DEFAULT_USER_PREFERENCES 声明（mirror INTERFACE_SCALE_DEFAULT 位次——const
// 无提升，DEFAULT 在模块求值期即引用）。
export const USAGE_RETENTION_DAYS_DEFAULT: number = 90;
/** 手改合法带下界（更短窗口抹掉「近 7 日」聚合意义）。 */
export const USAGE_RETENTION_DAYS_MIN = 7;
/** 手改合法带上界（两年——无界增长违 R5「过期行删除」本义）。 */
export const USAGE_RETENTION_DAYS_MAX = 730;

/**
 * Clamp an arbitrary (possibly corrupt) usageRetentionDays into the legal band
 * — NaN / non-number / missing → default 90；带外值钳到最近边界。shell prune 消费点
 * 与 UI 保存路径共用（clamp-before-persist 保磁盘恒合法，mirror clampInterfaceScale）。
 */
export function clampUsageRetentionDays(value: unknown): number {
  if (!Number.isFinite(value as number)) return USAGE_RETENTION_DAYS_DEFAULT;
  return Math.min(
    USAGE_RETENTION_DAYS_MAX,
    Math.max(USAGE_RETENTION_DAYS_MIN, value as number),
  );
}

/** Single source of truth for user-preference defaults, shared by main + renderer. */
export const DEFAULT_USER_PREFERENCES: UserPreferencesConfig = {
  theme: 'system',
  locale: 'system',
  autoCheckUpdates: true,
  readingFontWeight: 400,
  readingFontScale: 1,
  paragraphIndent: true,
  showWordCount: true,
  autoSaveEnabled: true,
  autoSaveInterval: 1500,
  spellCheck: false,
  wordCountGoal: 0,
  editorLineHeight: 1.75,
  wallpaperOpacity: 1,
  wallpaperFrostBlur: 0,
  contextCompaction: { redlinePercent: 95 },
  interfaceScale: INTERFACE_SCALE_DEFAULT,
  usageRetentionDays: USAGE_RETENTION_DAYS_DEFAULT,
};

/* ── Global interface scale（08-26 structure-rebuild R8）──
 *
 * 需求：偏好键 interfaceScale，四档预设 [0.85, 1.0, 1.15, 1.3]，默认 1.0；启动即生效
 * + 设置内改动即时生效，无需重启；解析失败回退默认 1.0，不得白屏。
 *
 * 施加方式选型（考察结论钉在此处——单源决策点）：
 * ① CSS `zoom` 施加于应用根元素 —— 否决。本仓有十余个 clientX/Y / getBoundingClientRect
 *    驱动的定位面（AgentInput 右键菜单、TiptapEditor、FileTabBar、ProjectTree、
 *    ResizeHandle 拖宽、结构页 SceneEditPopover / TimelineContextMenu 等）。CSS zoom
 *    生效时事件坐标仍是视口系，而这些面的 inline left/top px 会被有效 zoom 放大——
 *    指针锚定与拖拽数学全体漂移；结构页面正处于并行重构禁区（不可越界修复）。
 * ② 根 font-size 缩放 —— 否决。只覆盖 rem 消费面（scales.css 的间距/圆角/字号 token
 *    是 rem），而结构页 SVG 几何常量等 px 字面量不随动：非「整体」缩放，1.15+ 即出
 *    「文字涨框格不涨」的错位，恰好砸在本次重构的页面上。
 * ✔ 采用 Electron webContents.setZoomFactor（Chromium 原生页面级缩放，与浏览器
 *   Ctrl+滚轮同语义）：视口本身重标定，事件坐标 / fixed 浮层 / rect 实测三方保持自洽，
 *   全仓零逐组件适配点，渲染层不做任何 DOM 施加（白屏无从谈起）。施加点两处：
 *   createWindow 启动读盘一次 + config:save-user-preferences 落盘后对发起方 sender
 *   即时施加。
 */
/**
 * Clamp an arbitrary (possibly corrupt) interfaceScale value into the legal
 * band. NaN / non-number / missing → default 1; out-of-band numbers clamp to
 * the nearest preset bound — same lenient-read story as redlinePercent and
 * wallpaperOpacity. Used by the shell YAML read path, the shell write path
 * (clamp-before-persist keeps the disk file always legal), AND defensively by
 * the renderer store so a malformed disk value can never reach setZoomFactor.
 */
export function clampInterfaceScale(value: unknown): number {
  if (!Number.isFinite(value as number)) return INTERFACE_SCALE_DEFAULT;
  return Math.min(INTERFACE_SCALE_MAX, Math.max(INTERFACE_SCALE_MIN, value as number));
}

/** A font file the user imported into the app's font folder. */
export type ImportedFont = {
  /** CSS font-family name (derived from the file stem). */
  family: string;
  /** `data:` URL of the font file, ready to feed an @font-face src. */
  dataUrl: string;
};

/* ── Update check IPC ── */

/** @deprecated Legacy custom-manifest shape — kept for type back-compat, no longer fetched. */
export type UpdateManifest = {
  /** Latest available version (semver-like, e.g. "0.2.0"). */
  latestVersion: string;
  /** External URL the user follows to download the new build. */
  downloadUrl: string;
  /** Optional human-readable changelog. */
  releaseNotes?: string;
};

export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string; latestVersion: string }
  | {
      status: 'available';
      currentVersion: string;
      latestVersion: string;
      /** True when the major version increased (current -> latest). Drives the prominent guided banner. */
      isMajor: boolean;
      releaseNotes?: string;
      /** Fallback download page, used by portable builds that cannot self-update. */
      downloadUrl?: string;
      /** True for portable/dir builds: no in-app download; user opens downloadUrl manually. */
      manual?: boolean;
    }
  | { status: 'not-configured' }
  /** Running unpackaged (dev) — electron-updater is unavailable. */
  | { status: 'dev'; currentVersion: string }
  | { status: 'error'; message: string };

/** Progressive update lifecycle events pushed from main -> renderer over `update:event`. */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; currentVersion: string; latestVersion: string; isMajor: boolean; releaseNotes?: string; manual?: boolean; downloadUrl?: string }
  | { type: 'not-available'; currentVersion: string }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; latestVersion: string }
  | { type: 'error'; message: string };

/* ── Git IPC types ── */

export type GitCommitEntry = {
  oid: string;
  parents: string[];
  message: string;
  author: string;
  timestamp: number;
  tag?: string;
};

export type GitFileDiff = {
  filepath: string;
  status: 'added' | 'modified' | 'deleted';
};

/** A single regex search hit within a project file. */
export type ProjectSearchResult = {
  /** Path relative to the project directory. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Trimmed matching line text. */
  text: string;
};

/**
 * Canonical type for the preload API surface exposed via contextBridge.
 */
export type ProjectMutationResult = { ok: true } | { ok: false; error: string };

/**
 * Story 3.1: leader runLoop behavior mode — orthogonal to SessionPermissionMode
 * (which gates tool permission). normal = execute directly; discuss = converse
 * without writing; plan = restate a plan first, then execute on confirmation.
 * See design.md WP1.
 */
export type AgentBehaviorMode = 'normal' | 'discuss' | 'plan';

/**
 * Story 3.5: 参与档位别名（zod 单源在 contracts/batch-runs.ts participationGearSchema；
 * 此处 alias 保 ipc.ts 既有命名惯例——mirror AgentBehaviorMode 但不重复定义枚举值，
 * interface-contracts「No different-name-same-semantics」以 re-export 满足）。
 */
export type { ParticipationGear, BalancedAskCategory } from './contracts/batch-runs';

/* ── C1.2 lint（llmlint 静态扫描）IPC payload types ── */

/** scan-full 附带的章定位面（issue 跳转 / fix 确认文案用；报告本体 LintFullReport 只含 chapterId）。 */
export type LintChapterFile = {
  chapterId: string;
  title: string;
  /** 章正文绝对路径（project.yaml novel.chapters[].sections[0].content_file 解析产物）。 */
  filePath: string;
};

/**
 * scan-full 跳章/未覆盖条目（CR-011，additive optional——handler 恒填，旧构造者可缺省）。
 * reason 稳定码：'no-content-file'（无 id/无 sections[0].content_file）/ 'escapes-project-dir'
 * （路径穿越防御）/ 'not-landed'（正文文件不存在）/ 'unreadable'（读失败/编码不可解）/
 * 'scan-failed'（引擎对该章抛错）/ 'multi-section'（多 section 章只扫 sections[0]——跟随
 * batch 先例，多余 section 的正文未扫，note 计数）。UI（C1.3/batch B）按 reason 呈现。
 */
export type LintSkippedChapter = {
  chapterId: string;
  reason: string;
  note?: string;
};

/** `lint:scan-full` 结果（模式 A：失败带稳定 error code，不抛）。 */
export type LintScanFullResult =
  | {
      ok: true;
      report: LintFullReport;
      chapterFiles: LintChapterFile[];
      /** 引擎 dry-run 投影的机械修复补丁（fixability:auto；作者确认后经 lint:apply-fix 应用）。 */
      fixPatches: LintFixPatch[];
      /** 未入扫描的章及原因（CR-011：跳章不再静默；handler 恒填，消费侧 ?? [] 防御旧载荷）。 */
      skipped?: LintSkippedChapter[];
    }
  | {
      ok: false;
      error: 'no-project' | 'project-not-found' | 'engine-unavailable' | 'operation-failed';
      message?: string;
    };

/** apply-fix 单章应用结果（引擎按当前正文重放确定性修复——changes=0 表示已无可修项未写盘）。 */
export type LintApplyFixChapterResult = {
  chapterId: string;
  filePath: string;
  changes: number;
  written: boolean;
  note?: string;
};

/** `lint:apply-fix` 结果（模式 A）。 */
export type LintApplyFixResult =
  | { ok: true; results: LintApplyFixChapterResult[] }
  | {
      ok: false;
      error: 'no-project' | 'project-not-found' | 'engine-unavailable' | 'invalid-patches' | 'operation-failed';
      message?: string;
    };

/**
 * `lint:model-probe` 结果（CR-014，additive）：review-judge 档解析 + resolveModel
 * 是否成功（shell 单源——与 lint:classify 同一解析链；纯配置解析，不发网络请求）。
 * renderer 端不再自启发式探测（旧「任一启用模型」与 shell 端 default 哨兵语义会漂移）。
 */
export type LintModelProbeResult = { available: boolean };

export type OrisonDesktopApi = {
  pickProjectDirectory(): Promise<string | null>;
  createProjectDirectory(parentDir: string, name: string): Promise<string>;
  pickCoverImage(): Promise<string | null>;
  copyCoverImage(src: string, projectDir: string): Promise<string>;
  importDocx(projectDir: string): Promise<string | null>;
  docxToHtml(fullPath: string): Promise<string | null>;
  docxToMarkdown(fullPath: string, projectDir: string): Promise<string | null>;
  saveProjectMeta(projectDir: string, meta: Record<string, unknown>): Promise<ProjectMutationResult>;
  /** Idempotently ensure `<projectDir>/project.yaml` exists (create-if-absent, no version bump). */
  ensureProjectDocument(projectDir: string, meta: Record<string, unknown>): Promise<ProjectMutationResult>;
  syncProjectMeta(projectDir: string, meta: Record<string, unknown>): Promise<ProjectMutationResult>;
  syncChaptersMeta(projectDir: string, chapters: Array<{
    id: string;
    title: string;
    sort_order: number;
    status: string;
    summary?: string;
    summary_source?: string;
    sections?: Array<{
      id: string;
      title?: string;
      sort_order: number;
      content_file: string;
      word_count?: number;
    }>;
  }>): Promise<ProjectMutationResult>;
  loadProjectMeta(projectDir: string): Promise<Record<string, unknown> | null>;
  getLocale(): string;
  minimize(): void;
  maximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  platform: string;
  syncField(projectPath: string, field: string, data: unknown): Promise<void>;
  applyAgentFieldPatch(projectPath: string, fieldPatch: unknown): Promise<unknown>;
  /**
   * Story 3.1: toggle a creative field's `locked` flag without bumping its
   * version or marking downstream stale (distinct from syncField's user-edit
   * path, which bumps version + marks dependents stale). Locked fields reject
   * user edits (throw) and skip agent patches (surfaced via skipped[]).
   */
  toggleFieldLock(projectPath: string, field: string): Promise<void>;
  loadProjectDocument(projectDir: string): Promise<Record<string, unknown> | null>;
  loadModelConfig(): Promise<ModelConfig>;
  saveModelConfig(config: ModelConfig): Promise<void>;
  /** Whether OS keyring encryption is available for API keys (false → plaintext on disk). */
  isKeyEncryptionAvailable(): Promise<boolean>;
  /**
   * Story 3.6 WP10: read the「研究与视觉」settings aggregate — research net proxy
   * tier + search-engine chain config (API keys REDACTED to '' + `*Set` flags) +
   * doc-parser endpoint config + read-only wiki presets. Never throws for a
   * corrupt sidecar (each side degrades to its default).
   */
  loadResearchConfig(): Promise<ResearchConfigView>;
  /**
   * Story 3.6 WP10: persist the research settings aggregate (all three sidecars).
   * Search-engine API keys use the writeModelConfig sentinel: '' / undefined =
   * keep the persisted key. Schema violations (e.g. `custom` proxy without a
   * proxyUrl, docParser type without baseUrl) reject with the Zod message.
   */
  saveResearchConfig(config: ResearchConfigSave): Promise<void>;
  /**
   * Story 3.6 WP10: probe the configured doc-parser endpoint (`GET {base}/health`,
   * force refresh — bypasses the per-process cache so the settings-page lamp
   * reflects the just-saved config).
   */
  probeResearchDocParser(): Promise<DocParserProbeResult>;
  /**
   * Story 3.6 WP10: run the vision-model canary probe (known-answer image →
   * silent-strip detection, design D4) against the given `{keyId, modelId}` ref.
   */
  canaryProbeVision(ref: ModelRef): Promise<VisionCanaryResult>;
  listRemoteModels(request: ListRemoteModelsRequest): Promise<RemoteModel[]>;
  /**
   * 09-12 agy provider W4: discover models from a CLI-form provider
   * (`<cliExecutable> models`, two-column TSV). Typed result (模式 A) —
   * `not-logged-in` drives the inline login guidance on the settings page.
   */
  listCliModels(request: ListCliModelsRequest): Promise<CliModelDiscoveryResult>;
  /**
   * 09-19 dogfood R4: read the latest CLI credential-probe snapshots (per
   * keyId, shell memory only). Keys with no stored result are absent — the
   * renderer renders them as「未探测」. Snapshots for deleted keys are filtered
   * against the on-disk config at read time.
   */
  cliProbeStatus(): Promise<Record<string, CliProbeSnapshot>>;
  /**
   * 09-19 dogfood R4: run a credential probe for one saved CLI-form key right
   * now (settings-page「测试连接」button) and return the fresh snapshot. A tiny
   * real generation (`<cliExecutable> -p "hi"`, 30s cap) — 模式 A, never throws
   * for an expected failure (an unresolvable key yields an `error` snapshot).
   */
  cliProbeRun(input: { keyId: string }): Promise<CliProbeSnapshot>;
  generateText(payload: GenerateTextPayload): Promise<TextGenerationResponse>;
  generateImage(payload: GenerateImagePayload): Promise<ImageGenerationResponse>;
  generateEmbedding(payload: GenerateEmbeddingPayload): Promise<EmbeddingResponse>;
  rerank(payload: RerankPayload): Promise<RerankResponse>;
  /**
   * Trigger a full rebuild of the global craft KB index (~/.orison/craft-kb/ +
   * bundled seeds): DROP+reCREATE the vec0 table on a dim change + re-embed every
   * craft doc. Returns a typed result; `ok:false` carries a stable error code for
   * the renderer (Story 2.1 CR-craft-kb-011).
   */
  rebuildCraftKb(): Promise<CraftRebuildResult>;
  /**
   * Story 2.7: fetch derived-index status for the KB index management page —
   * craft (global) counts + the current project's story counts (project_assets
   * + asset_cards), with pending_embed + model provenance. `projectId` omitted
   * when no project is open (story counts return zero / null).
   */
  getIndexStatus(input: { projectId?: string }): Promise<IndexStatus>;
  /**
   * Story 2.7: rebuild the current project's story derived index (project_assets
   * via `reindexAll` + asset_cards via `reindexAssetCards`) under the resolved
   * embedding model — the manual escape hatch complementary to the watcher.
   * Returns a typed result; `ok:false` carries a stable error code (模式 A).
   */
  rebuildStoryIndex(input: { projectId: string }): Promise<StoryRebuildResult>;
  /**
   * Story 4.0: trigger the chapter-chain subgraph for a given episode (dogfood +
   * test entry; leader `write_chapter` tool is the agent-side mirror). Loads the
   * project, assembles initialArtifacts (scene_graph + 2.3 setting prefix +
   * ChapterBrief + promise_registry), dispatches a chapter-chain child session,
   * and returns a RunSnapshot summary (context isolation — no internal trace).
   */
  runChapterChain(input: RunChapterChainInput): Promise<RunChapterChainSummary>;
  /**
   * Story 4.3: resume / redo / abort a paused chapter chain (structured IPC mirror of
   * the leader write_chapter paused-review flow — UI calls this directly rather than
   * having the leader re-interpret a user message). Reads the chainSnapshot persisted
   * under `sessionId` (set by runChapterChain's onCheckpoint), then either continues
   * (skip completed nodes), redoes draft-writer with feedback, or aborts (clears the
   * snapshot). Returns the same RunChapterChainSummary shape as runChapterChain.
   */
  resumeChapterChain(input: ResumeChapterChainInput): Promise<RunChapterChainSummary>;
  /**
   * 链流程重排 W4（R6 / 09-13 子3 W6 preload 暴露）：查询注册章的衍生状态新鲜度（章卡
   * stale 徽标 + 「重提取」按钮态数据源）。轻量 best-effort 查询——loadProject 失败 / 未注册
   * db 返空 chapters（如实：从未提取），不 throw。镜像 `chapterDerivationStatusInputSchema`
   * （chapter-chain-artifacts.ts，Zod 单源）。
   */
  chapterDerivationStatus(input: { projectPath: string; chapterId?: string }): Promise<ChapterDerivationStatusResult>;
  /**
   * 链流程重排 W4（R6 / 09-13 子3 W6 preload 暴露）：链外重提取——盘上正文 standalone 跑
   * E 段（幂等写 world/promise/arc/summary/mention/story-sync），修复「落盘后手改正文 /
   * E 段失败章标」的衍生状态漂移。同项目单 run 闸拒绝（reason 机器串，projectRunBusy 解析）；
   * story-sync 反哺 patches 走档位分流（storySyncReview 人审 envelope / storySyncLanded 直落，
   * mirror resume 终态消费）。镜像 `reExtractChapterInputSchema`（Zod 单源）。
   */
  reExtractChapter(input: { projectPath: string; chapterId: string; autonomy?: 'readonly' | 'suggest' | 'auto' }): Promise<ReExtractChapterResult>;
  /**
   * Story 7.1 Route 1：B trigger 选区指挥精修——编译改稿意图。UI 在 draft checkpoint pause 后，
   * 用户选段 + 写粗指令 → 调本 IPC → 派 revision-optimizer 子 agent → 返 RevisionIntent（用户确认关用）
   * OR null（编译失败 graceful）。确认后 UI 再调 resumeChapterChain(action=redo, revisionIntent=确认后的 intent)。
   */
  compileRevisionIntent(input: CompileRevisionIntentInput): Promise<CompileRevisionIntentResult>;
  /**
   * Story 2.2 WP-B: persist an accepted setting-md patch. The UI diff card
   * calls this on accept — the shell RE-APPLIES the bounded actions against
   * the CURRENT `settings/<settingId>.md` (never writes the stale proposed
   * `after`), so intermediate user edits are never clobbered; a drifted
   * anchor returns `{ok:false}` (the card toasts「文档已变化，请重新提议」).
   * Also the persist core behind the `setting_md_update` tool's autoApply path.
   */
  acceptSettingMdPatch(input: AcceptSettingMdInput): Promise<AcceptSettingMdResult>;
  /**
   * Story 8.6 R4: append an accepted author-profile note (UI diff-card accept
   * path). The shell appends the note as a NEW dated entry to
   * `~/.orison/author_profile.md` against the CURRENT file — never writes the
   * stale proposed `after` snapshot, so author edits between proposal and
   * accept are always preserved (append-only semantics).
   */
  applyAuthorProfileNote(input: ApplyAuthorProfileNoteInput): Promise<ApplyAuthorProfileNoteResult>;
  /**
   * C1.2: run a full-manuscript static lint scan (vendored llmlint engine) —
   * enumerate chapter prose from project.yaml (traversal-guarded, unlanded
   * chapters skipped), scan each chapter (review=all bucket), aggregate a
   * LintFullReport, persist `.orison/lint/full-report.json`, and return the
   * report + chapter locator map + dry-run auto-fix patches. 模式 A — never
   * throws; failure carries a stable error code.
   */
  lintScanFull(input: { projectPath: string }): Promise<LintScanFullResult>;
  /**
   * C1.2: LLM contextual classification of the last scan's review=agent bucket
   * hits (shell direct model-gateway call — review-judge task slot with the
   * default-sentinel auto-pick fallback, single structured judgment + one
   * JSON-parse retry). No model configured / call or parse failure / no report
   * on disk → `{degraded:true, verdicts:[]}` — the static report stays
   * independently complete (R3 graceful degradation).
   */
  lintClassify(input: { projectPath: string }): Promise<LintClassifyResult>;
  /**
   * C1.2: apply the author-confirmed mechanical fix patches. Re-derives the
   * deterministic fixes from the CURRENT chapter prose (idempotent replay —
   * patch spans are scan-time artifacts, never trusted as write coordinates;
   * authoritative file paths come from project.yaml, not the renderer payload),
   * writes inside withProjectLock, then rescans the touched chapters to refresh
   * `.orison/lint/<chapterId>.json` ledgers + the full-report entries.
   */
  lintApplyFix(input: { projectPath: string; patches: LintFixPatch[] }): Promise<LintApplyFixResult>;
  /**
   * C1.2 CR-014: probe whether the lint contextual-judgment model is resolvable
   * (review-judge task slot with the default-sentinel auto-pick fallback — the
   * SAME resolution chain lint:classify uses, resolved in the shell as the
   * single source of truth). Pure config resolution, no network request.
   */
  lintModelProbe(): Promise<LintModelProbeResult>;
  /**
   * dogfood R2 #92：世界状态面板读面——L1 世界总览（design v2 三级缩放）。主体轻量投影（每主体
   * 一行最后变化）+ storyTime 场锚点聚合行；写章链世界提取运行中附带 extracting 态。载荷契约
   * 单源 contracts/world-panel.ts。
   */
  worldOverview(input: WorldOverviewRequest): Promise<WorldOverview>;
  /**
   * L2 时点详情：该 storyTime 全部变更跨主体分组（anchor 聚合行 + per-subject 组，组内 patches
   * 可展开 value）。
   */
  worldSliceDetail(input: WorldSliceDetailRequest): Promise<WorldSliceDetail>;
  /**
   * L3 主体详情：仅全史 patches（BMad CR #4 砍除 shell 侧 reduce/reduced/issues 载荷与 `at` 参数）
   * ——as-of 切线快照/折叠由 UI 本地纯函数重算（数据已在手零 IPC）。
   */
  worldSubjectDetail(input: WorldSubjectDetailRequest): Promise<WorldSubjectDetail>;
  /**
   * 订阅 `world:changed` 推送事件（world 数据三写入口——写章链 slice 落表 / backfill reset /
   * amendment——事务提交后 best-effort 发射）。返回退订函数，只移除本监听器（mirror
   * onUpdateEvent / onToolEvent 形态）。
   */
  onWorldChanged(callback: (event: WorldChangedEvent) => void): () => void;
  /** 显式退订单个监听器（removeListener 本监听器，绝不 removeAllListeners）。 */
  offWorldChanged(callback: (event: WorldChangedEvent) => void): void;
  // ── Story 10.1 Wave D：材料库管理面（六 invoke + material:changed 推送订阅）──
  /** 材料清单（scope 车道；Material 裁剪摘要行——列表/徽章/表单字段）。 */
  listMaterials(input: MaterialsListInput): Promise<MaterialSummary[]>;
  /** 全行材料详情 + 派生/原件绝对路径（打开派生 .md 校对入口 / reveal 用）。 */
  getMaterial(input: { materialId: string }): Promise<MaterialDetail | null>;
  /**
   * 删除材料（D8 四清：原件 + 派生 .md + 登记行 + 双车道 chunk 行；删除前 .orison/history
   * 快照兜底）。确认弹窗归 UI，IPC 层不二次确认。
   */
  deleteMaterial(input: { materialId: string }): Promise<MaterialDeleteResult>;
  /** 重摄取（registerMaterial 完整管线入 per-scope 串行队列，回执 outcome）。 */
  reingestMaterial(input: { materialId: string }): Promise<MaterialReingestResult>;
  /**
   * 批量拖入导入（外部绝对路径 → 拷入 materials/ 根 + 逐份登记；≤250/批 + 50MB/件
   * shell 侧强制；拒收分类回报〔MaterialImportRejectionKind 六档——格式/超大/超批量/
   * stem 冲突/敏感源/源缺失〕+ failed（拷入成功摄取失败，watcher 自愈））。
   */
  importMaterials(input: MaterialsImportInput): Promise<MaterialsImportResult>;
  /**
   * provenance 后补（F-05 六字段表单：medium/tier/author/lang/originDate/description——字段
   * 缺省不动，nullable 字段显式 null = 清空；upsertMaterialRow 的 COALESCE 防重摄取清除）。
   */
  updateMaterialProvenance(input: MaterialProvenancePatchInput): Promise<MaterialProvenancePatchResult>;
  /**
   * 材料显示名编辑（E10.2a，design §3.1）：name 列更新（materialId 路径身份不变），落库后
   * 广播 material:changed（reason='name-updated'——列表名刷新既有事件面）。校验 trim + 非空 +
   * ≤ MATERIAL_NAME_MAX_CHARS，非法 → {ok:false, error:'invalid-input'}（模式 A）。
   */
  updateMaterialName(input: MaterialUpdateNameInput): Promise<MaterialUpdateNameResult>;
  /**
   * 订阅 `material:changed` 推送（材料变更全窗广播，mirror onWorldChanged——返回退订
   * 函数，只移除本监听器，绝不 removeAllListeners）。
   */
  onMaterialChanged(callback: (event: MaterialChangedEvent) => void): () => void;
  // ── E10.2b（task 09-05）W3：蒸馏管线面（两 invoke；card/term/merge-review 九通道三层同步
  //    归 W5 落地〔见下方 W5 段〕；craft:distill-progress 订阅面随 W5.5 UI 事件刷新接线）──
  /**
   * 批量入队蒸馏（craft:distill-run——后台执行即回；跳过项逐份回报原因
   * not-found/not-ready/already-running/hash-unchanged；相位/终态经 craft:distill-progress 推送）。
   */
  craftDistillRun(input: CraftDistillRunInput): Promise<CraftDistillRunResult>;
  /** 蒸馏进度订阅（W5.5 合流缝补——mirror onMaterialChanged 形态，返回退订函数）。 */
  onCraftDistillProgress(callback: (event: CraftDistillProgressEvent) => void): () => void;
  /** 材料蒸馏台账查询（craft:distill-status——省略 materialIds = 全部行；徽章取数面）。 */
  craftDistillStatus(input: CraftDistillStatusInput): Promise<CraftDistillLedger[]>;
  // ── E10.2b（task 09-05）W5：手艺卡人审面（card/term/merge-review 九 invoke——载荷契约
  //    见下方「E10.2b Wave 1」段单源；craft:distill-progress 订阅面归 W5.5 UI 事件刷新接线）──
  /** 手艺卡队列（craft:card-list——全字段可选 AND + tags OR + 置信排序；返回摘要行）。 */
  craftCardList(input: CraftCardListInput): Promise<CraftCardSummary[]>;
  /** 取整卡（craft:card-get——claim 四件套全文 + 讲法数组；未知 id → null）。 */
  craftCardGet(input: { cardId: string }): Promise<CraftCard | null>;
  /**
   * 卡内容编辑（craft:card-patch——**编辑即降级执行点**：任何实际写库 → status 回
   * pending_review + entry 检索行删）。rejected 卡 = `rejected-card`（须先 recover）。
   */
  craftCardPatch(input: CraftCardPatchInput): Promise<CraftCardPatchResult>;
  /** 人审状态机动作 + 讲法 rank 改级（craft:card-review——verify/reject/recover；非法转换 = `invalid-state`）。 */
  craftCardReview(input: CraftCardReviewInput): Promise<CraftCardReviewResult>;
  /** 并排任务队列（craft:merge-review-list——默认仅待审 resolution=null）。 */
  craftMergeReviewList(input: CraftMergeReviewListInput): Promise<CraftMergeReview[]>;
  /** 三动作裁决（craft:merge-review-resolve——merge/independent/dismiss；已裁决再 resolve = `invalid-state`）。 */
  craftMergeReviewResolve(input: CraftMergeReviewResolveInput): Promise<CraftMergeReviewResolveResult>;
  /** 词目清单（craft:term-list——UI 补全 chips / 待并词表视图；含 pending）。 */
  craftTermList(input: CraftTermListInput): Promise<CraftTerm[]>;
  /** 核准待并词目（craft:term-approve——pending → active；非 pending = `invalid-state`）。 */
  craftTermApprove(input: { termId: string }): Promise<CraftTermApproveResult>;
  /** 归并词目（craft:term-merge——卡改挂 + category 跟随 + entry 检索行重写；movedCardCount = 改挂卡数）。 */
  craftTermMerge(input: CraftTermMergeInput): Promise<CraftTermMergeResult>;
  // ── E10.3a（task 09-05）W6：拆解管线控制面（七 invoke + decon:progress 订阅——载荷契约
  //    见下方「E10.3a W6」段单源；拆书页 UI 归 child B）──
  /** 创建拆解会话（decon:create——P0 落库：材料就绪门 + 在途守卫 + 双指纹快照 + P1 继承；回执带成本预估）。 */
  deconCreate(input: DeconCreateInput): Promise<DeconCreateResult>;
  /**
   * 启动/续跑（decon:start——后台执行即回，进度经 decon:progress 推送）。capped 续跑的调预算
   * 面在 `budget` 字段（start 前生效——retry 语义）；done/running 幂等 no-op。
   */
  deconStart(input: DeconStartInput): Promise<DeconStartResult>;
  /** 暂停（decon:pause——优雅中断，章边界感知停，state 行保留）。 */
  deconPause(input: DeconJobIdInput): Promise<DeconTransitionResult>;
  /** 取消（decon:cancel——终态；重拆走新 job）。 */
  deconCancel(input: DeconJobIdInput): Promise<DeconTransitionResult>;
  /** 删除会话（decon:delete——job + pass_state + canon per-job 级联；事实层三表材料级保留 F-07）。 */
  deconDelete(input: DeconJobIdInput): Promise<DeconDeleteResult>;
  /** 会话详情（decon:get——人审取数面：断点行 + canon 六域 + 词典 + 实体；stale 时产物面为空）。 */
  deconGet(input: DeconJobIdInput): Promise<DeconJobDetail | null>;
  /** 会话清单（decon:list——省略 materialId = 全部）。 */
  deconList(input: DeconListInput): Promise<DeconJob[]>;
  /**
   * 人审闸门确认（decon:approve-review——E10.3b 拍板①）：review 行 pending → approved 后
   * 经 start 续跑（台账 skip 已 done pass 零重付）。invalid-state = 闸门行非 pending。
   */
  deconApproveReview(input: DeconApproveReviewInput): Promise<DeconApproveReviewResult>;
  /**
   * product 读面（decon:products——E10.3b W5）：craft 闸门卡 / 产出阅读的 findings 投影取数
   * 通道（按 pass/passStem 前缀/unit 过滤控体量——CR-8：'p4' 茎匹配全部 p4:<dim>，含
   * p4:style，排除逻辑留 UI）。stale/cancelled → fresh=false + 空集。
   */
  deconProducts(input: DeconProductsInput): Promise<DeconProductsResult>;
  /**
   * 报告读面（decon:reports——E10.3b W5）：省略 unit = meta 列表（不带全文）；带 kind+unit =
   * 单取全文行。坏 kind 串 → error='invalid-input' 显式拒收（CR-24）。stale freshness 门同
   * decon:get 纪律。
   */
  deconReports(input: DeconReportsInput): Promise<DeconReportsResult>;
  /**
   * 风格维导出（decon:export-style——E10.3b W5）：p4:style 结构化 payload merge 写目标项目
   * settings/style.md（语义键替换/手写节保留/无卡新建）。writtenSections = 实际写入的节。
   * 写前确认与无项目禁用提示归 UI。
   */
  deconExportStyle(input: DeconExportStyleInput): Promise<DeconExportStyleResult>;
  /**
   * stale 确认重跑（decon:confirm-rerun——E10.3b W7 小补③）：刷新双指纹为材料现值 + 复位
   * 派生 pass 台账与产物（canon/product/report + 闸门复位 pending）后**自动 start 续跑**
   * （材料级 P1 同新指纹产物命中则零重付）。material-not-found = 材料已删（只剩 delete 出路）。
   */
  deconConfirmRerun(input: DeconConfirmRerunInput): Promise<DeconConfirmRerunResult>;
  // ── 09-12 usage-panel（子5 W3）：应用内用量面（设置页「用量」段）──
  /**
   * closure_llm_log 聚合读面（单载荷单 loading 态——mirror research aggregate-load 先例）：
   * 今日 / 近 7 日 / 累计（=保留窗内）三窗合计 + byModel（近 7 日，per-(key,model,protocol)
   * 行组）+ byTask（近 7 日，NULL 组 = 未标注）+ 最近 20 条 + retentionDays + oldestTs。
   * 窗口边界 = 本地时区自然日（epoch ms 列 + 查询侧 JS 算日界——design §2 偏离注记①）。
   * ¥ 估算（estimatedCost）：仅配了 per-model pricing 的行组有值，恒「仅供参考」是 UI 义务。
   */
  usageOverview(): Promise<UsageOverview>;
  /**
   * 手动清空全表（确认对话框归 UI 侧；本 handler 只做清空，清后无需 prune——全删语义）。
   * 模式 A 类型化结果，失败 'operation-failed'。
   */
  usageClear(): Promise<UsageClearResult>;
  // ── 子4 agy MCP 工具桥（09-12-agy-mcp-tool-bridge W4）：同意状态面三通道 ──
  /**
   * 桥状态读面（状态机四态 + 冲突规则原文 + 假宿根/同意文件路径）。每次现读（用户手改
   * agy settings 即时反映——不信缓存，design §10）。
   */
  agyBridgeStatus(): Promise<AgyBridgeStatusView>;
  /**
   * 设置同意（allowed/declined——拒绝也记住，AC6；同意后本次运行不自动重试——用户重发，
   * design §4.3）。成功附写后状态视图。
   */
  agyBridgeSetConsent(input: { consent: AgyBridgeConsentValue }): Promise<AgyBridgeConsentResult>;
  /**
   * 关闭回收（状态翻转回未配置 + 活动桥会话提示；用户真实全局零写入——无条目移除面，
   * 假宿残留由启动清扫守卫覆盖）。
   */
  agyBridgeRevoke(): Promise<AgyBridgeRevokeResult>;
  // ── 09-19 CLI 白名单（W3）：Closure 文本 Agent 状态面三通道 ──
  /**
   * 文本 Agent 状态读面（开关维 + CLI key 前提 + 文件四态 + name 遮蔽警示 + 路径）。
   * 每次现读（文件被手删/外来覆盖即时反映——不信缓存）。
   */
  agyTextAgentStatus(): Promise<AgyTextAgentStatusView>;
  /**
   * 开启（清 declined 记录 + 立即写入最新 agent 文件；外来同名文件压住 → foreign-conflict
   * 拒写不覆盖）。成功附写后状态视图。
   */
  agyTextAgentEnable(): Promise<AgyTextAgentEnableResult>;
  /** 关闭（记 declined + 删除自有 agent 文件——验标记才删，外来文件绝不动）。 */
  agyTextAgentDisable(): Promise<AgyTextAgentDisableResult>;
  /** 拆解进度订阅（mirror onCraftDistillProgress 形态，返回退订函数只移除本监听器）。 */
  onDeconProgress(callback: (event: DeconProgressEvent) => void): () => void;
  runStorySync(payload: RunStorySyncPayload): Promise<RunStorySyncResult>;
  loadUserPreferences(): Promise<UserPreferencesConfig>;
  saveUserPreferences(config: UserPreferencesConfig): Promise<void>;
  /** Enumerate fonts the user has imported into the app's font folder. */
  listImportedFonts(): Promise<ImportedFont[]>;
  /** Open a file picker, copy chosen font files into the app, return all imported fonts. */
  importFonts(): Promise<ImportedFont[]>;
  /**
   * Open a file picker (single image), copy the chosen file into
   * `userData/wallpaper/`, and return its `orison-file:///` URL. Null when the
   * dialog is canceled (or the picked file is not a supported image).
   */
  importWallpaper(): Promise<{ url: string } | null>;
  /** Delete the imported wallpaper files (the wallpaper directory itself is kept). */
  clearWallpaper(): Promise<void>;
  showItemInFolder(fullPath: string): void;
  openPath(fullPath: string): void;
  /** Open an external https URL in the user's default browser. */
  openExternal(url: string): void;
  readDirectory(projectDir: string, maxDepth?: number): Promise<FileTreeEntry[]>;
  deleteEntry(fullPath: string): Promise<boolean>;
  renameEntry(oldPath: string, newPath: string): Promise<boolean>;
  createEntry(fullPath: string, isDir: boolean): Promise<boolean>;
  readFile(fullPath: string): Promise<string | null>;
  /** Regex text search across a project directory; returns structured hits. */
  searchProject(projectDir: string, query: string, maxResults?: number): Promise<ProjectSearchResult[]>;
  readFileBinary(fullPath: string): Promise<BinaryFilePayload | null>;
  readFileBinary(fullPath: string): Promise<BinaryFilePayload | null>;
  writeFile(fullPath: string, content: string): Promise<boolean>;
  wordCount(projectDir: string): Promise<number>;
  pathExists(fullPath: string): Promise<boolean>;
  saveBase64Image(projectDir: string, input: SaveBase64ImageInput): Promise<SavedImageFile>;
  moveProjectFile(projectDir: string, fromRelativePath: string, toRelativePath: string): Promise<string>;
  deleteProjectFile(projectDir: string, relativePath: string): Promise<boolean>;
  // Drag-drop import of external OS files into the project tree.
  // 09-01 A1 additive: a non-empty `allowedExtensions` whitelist (lowercase,
  // leading dot normalized) rejects non-matching entries in the shell (partial
  // success — legal files still copy) and switches the return shape to
  // ImportFilesResult; absent / empty keeps the legacy string[] behavior.
  importFiles(
    projectDir: string,
    targetRelDir: string,
    sourcePaths: string[],
    allowedExtensions?: string[],
  ): Promise<string[] | ImportFilesResult>;
  // 09-01 A3：inbox 附件三通道（canonical 载荷类型见上方 A 波分段；shell handler 单源
  // parseDocumentHandlers.ts，preload 经本契约类型暴露）。
  /** 上传进件即预解析：docx/pdf 解析出派生 .md 落盘（+ file:changed），txt/md preview-only。 */
  parseInboxDoc(input: ParseInboxDocInput): Promise<ParseInboxDocResult>;
  /** 挂附件协议（R1.2c）：mtime 重解析 → 内容哈希 → exact/similar/fresh 三态 + 描述复用。 */
  resolveInboxAttachment(input: ResolveInboxAttachmentInput): Promise<ResolveInboxAttachmentResult>;
  /** fresh 描述生成完毕回写 sidecar（哈希/sample 由 shell 现算，不信任 renderer 传入）。 */
  storeAttachmentDescription(input: StoreAttachmentDescriptionInput): Promise<StoreAttachmentDescriptionResult>;
  pathForFile(file: File): string;
  watchProject(projectDir: string): Promise<void>;
  unwatchProject(): Promise<void>;
  ensureProjectRegistration(input: { projectId?: string; name: string; type: 'novel' | 'script'; localFingerprint: string; path?: string; coverImage?: string }): Promise<{ projectId: string; name: string; type: string }>;
  /** List every project registered on this machine (durable across version changes). */
  listRegisteredProjects(): Promise<RegisteredProject[]>;
  /** Bump last-opened time (and optionally cover image) for a registered project. */
  touchProjectRegistration(input: { localFingerprint: string; coverImage?: string }): Promise<void>;
  /** 将项目内容复制到同级新目录，并生成独立项目身份。 */
  duplicateProject(projectPath: string, name: string): Promise<ProjectLifecycleResult>;
  /** 只重命名项目元数据，不移动项目目录。 */
  renameProject(projectPath: string, name: string): Promise<ProjectLifecycleResult>;
  /** 将项目目录移入系统回收站，并软归档注册记录。 */
  deleteProject(projectPath: string): Promise<ProjectLifecycleResult>;
  // Task persistence (SQLite)
  listTasks(projectId: string, limit?: number): Promise<TaskRecord[]>;
  upsertTask(input: TaskUpsertInput): Promise<void>;
  updateTaskStatus(taskId: string, status: string, errorMessage?: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  // Asset persistence (SQLite)
  listAssets(projectId: string): Promise<AssetRecord[]>;
  upsertAsset(input: AssetUpsertInput): Promise<void>;
  updateAsset(projectId: string, assetId: string, fields: Partial<Pick<AssetRecord, 'assetName' | 'assetGroup' | 'summary' | 'assetStatus'>>): Promise<void>;
  deleteAsset(projectId: string, assetId: string): Promise<void>;
  /** Open a native picker to import external image files into assets/images and
   *  register them. Returns the relative paths actually imported. */
  importAssets(projectDir: string, projectId: string): Promise<string[]>;
  // Logging
  openLogsDir(): Promise<string>;
  writeLog(payload: { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string; meta?: Record<string, unknown> }): Promise<void>;
  // Version + update
  getAppVersion(): Promise<string>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  /** Begin downloading the available update (electron-updater). */
  downloadUpdate(): Promise<void>;
  /** Quit and install the downloaded update now. */
  installUpdate(): Promise<void>;
  /** Subscribe to update lifecycle events. Returns an unsubscribe fn. */
  onUpdateEvent(callback: (event: UpdateEvent) => void): () => void;
  // Git
  gitIsRepo(dir: string): Promise<boolean>;
  gitInit(dir: string): Promise<{ initialized: boolean }>;
  gitLog(dir: string, depth?: number): Promise<GitCommitEntry[]>;
  gitCommitDiff(dir: string, oid: string): Promise<GitFileDiff[]>;
  gitFileAtCommit(dir: string, oid: string, filepath: string): Promise<string | null>;
  gitCreateNode(dir: string, message: string, tag?: string): Promise<{ oid: string }>;
  gitListBranches(dir: string): Promise<string[]>;
  gitCurrentBranch(dir: string): Promise<string>;
  gitCreateBranch(dir: string, name: string, fromOid?: string): Promise<void>;
  gitCheckoutBranch(dir: string, name: string): Promise<void>;
  /** Restore the working tree to `oid` and commit it as a new node on the current branch. */
  gitRestoreVersion(dir: string, oid: string, message: string): Promise<{ oid: string }>;
  gitStatusCount(dir: string): Promise<number>;
  onToolEvent(callback: (data: { type: string; [key: string]: unknown }) => void): () => void;
  // Agent
  createAgentSession(input: { agentName: string; projectPath: string; mode?: 'readonly' | 'suggest' | 'auto'; behaviorMode?: AgentBehaviorMode; participationGear?: ParticipationGear }): Promise<unknown>;
  getAgentSession(id: string, projectPath?: string): Promise<unknown>;
  setAgentSessionMode(sessionId: string, projectPath: string | undefined, mode: 'readonly' | 'suggest' | 'auto'): Promise<{ ok: boolean }>;
  /** Story 3.1: set the leader runLoop's behavior mode (normal/discuss/plan). */
  setAgentSessionBehaviorMode(sessionId: string, projectPath: string | undefined, behaviorMode: AgentBehaviorMode): Promise<{ ok: boolean }>;
  /**
   * Story 3.5: set the leader's participation gear (smart/steer/balanced/hands_off) +
   * balanced 档圈类别 / hands_off trustAdjudication。Session 级持久化；跑动中拒改（下一轮生效，
   * mirror setAgentSessionBehaviorMode；chat 指令中途调档走 leader 的 set_participation_gear 工具）。
   */
  setAgentSessionParticipationGear(
    sessionId: string,
    projectPath: string | undefined,
    gear: ParticipationGear,
    options?: { balancedAskCategories?: BalancedAskCategory[]; trustAdjudication?: boolean },
  ): Promise<{ ok: boolean }>;
  listAgentSessions(projectPath?: string): Promise<unknown>;
  deleteAgentSession(id: string, projectPath?: string): Promise<boolean>;
  /**
   * 从此截断（dogfood 2026-08-21）：丢弃 messageId 及其后全部（runtime 内存+JSONL+索引）。
   * 纯对话尾巴专用——含工具痕迹（含只读）/运行中/未找到 → ok:false 拒绝。
   */
  truncateAgentSession(sessionId: string, messageId: string): Promise<
    { ok: true; removed: number } | { ok: false; reason: 'not-found' | 'running' | 'tool-activity' }
  >;
  streamAgentMessage(input: { sessionId: string; content: string; attachments?: unknown[] }): Promise<StreamAgentMessageResult>;
  onAgentStreamEvent(callback: (event: { type: string; data: unknown }) => void): () => void;
  /**
   * 09-01 CR-003a（决议 a）：识图转述进度推送订阅（channel `image-relay-progress`，shell
   * generate 缝全窗广播）。载荷 `{current, total}`——current = 正在转述图在本载荷指针图
   * 串行处理序中的 1-based 位次，total = 本载荷指针图总数；每图转述开始/完成各发一次。
   * 直传路 / 缓存全命中 / 无图场景不发送（天然零显示）。返回退订函数（mirror onToolEvent
   * 订阅纪律——只移除本监听器，绝不 removeAllListeners）。
   */
  onImageRelayProgress(callback: (progress: { current: number; total: number }) => void): () => void;
  resolveAgentConfirmation(sessionId: string, callId: string, approved: boolean): Promise<unknown>;
  listAgentSkills(projectPath: string): Promise<unknown>;
  executeAgentSkill(sessionId: string, skillName: string, request?: unknown): Promise<unknown>;
  listAgentContinuations(sessionId: string): Promise<unknown>;
  restoreAgentContinuation(sessionId: string, continuationId: string): Promise<unknown>;
  abortAgentRun(sessionId: string): Promise<boolean>;
  /**
   * Context-compaction manual trigger (compaction three-trigger model, trigger
   * ① manual): compact the given leader session's conversation NOW via a single
   * summarization compaction pass. The redline (②) and window-overflow (③)
   * auto-triggers live inside the runtime — this is the user-initiated path
   * (leader toolbar button; the one-line-command form attaches here once the
   * dual-use command bar exists). Idle semantics: without an active run the
   * runtime loads the persisted session and compacts it independently.
   * Returns true when a compaction ran; false when the runtime seam is not
   * wired yet, or the session is missing / busy.
   */
  compactAgentSession(sessionId: string): Promise<boolean>;
  // Skill package management
  listSkillPackages(projectPath?: string): Promise<SkillPackageInfo[]>;
  setPackageEnabled(packageName: string, enabled: boolean): Promise<{ ok: boolean }>;
  setSkillEnabled(packageName: string, skillName: string, enabled: boolean): Promise<{ ok: boolean }>;
  // Window lifecycle
  onBeforeClose(callback: () => void): () => void;
  confirmClose(): void;
};

/**
 * `agent:stream-message` invoke 返回值（dogfood T1 Stage 3 D4 + CR-T1-013 契约同步）。
 *
 * - completed/aborted/error：run 已走完的终态（message 为 error/aborted 附言）。
 * - rejected：**run 未启动**的结构化拒绝——两种 code：
 *   - `project_run_active`：D4 同项目单 run 闸（shell projectActiveRuns）占用，heldBySessionId
 *     为占用者（会话 id 或链租约 id `chain-run:closure:*`——后者不可跳转，UI 换文案不提供跳转钮）。
 *   - `session_run_active`：该会话自身 runState 已有活跃 run（重叠 invoke）——UI 按「已占用」
 *     处理，不 purge 流占位、不显错误横幅。
 */
export type StreamAgentMessageResult =
  | { status: 'completed' | 'aborted' | 'error'; message?: string }
  | { status: 'rejected'; code?: string; heldBySessionId?: string; projectPath?: string };

/* ── 风格卡片 MVP（08-28 C 路）：request_style_input 事件链契约 ── */

/**
 * `style_input_requested` tool:event 载荷（风格卡片 MVP）。
 *
 * 链路：leader `request_style_input` 工具 → shell handler（toolExecution）→ notifyUI
 * （tool:event 既有推送通道，零新 IPC/preload 面）→ renderer useToolEvents（过
 * current-project 匹配守卫）→ 风格片段对话框（StyleInputDialog）弹出。
 *
 * - projectPath：工具执行的 projectDir（消费侧项目匹配守卫用）。
 * - prompt：leader 可选传的一句提示语，显示在对话框顶部（告诉作者贴什么样的片段）。
 */
export type StyleInputRequestedEvent = {
  type: 'style_input_requested';
  projectPath: string;
  prompt?: string;
};

/**
 * 风格片段结构化 user message 的标记行约定（风格卡片 MVP，D4 原文直传 / D6 对话框收集）。
 *
 * `agent:stream-message` 的 content 只收纯文本——fragment/notes 分离字段以**标记行**结构化。
 * 对话框提交侧用 buildStyleInputMessage 构造；按 sourceMessageId 机械提取原文的一侧
 * （dispatch_style_analyzer）**直接 import parseStyleInputMessage 解析，勿自行复制格式**
 * （单源防两处漂移）。形态：
 *
 * ```
 * [style-input-fragment]
 * <fragment 逐字原文（内部换行原样保留）>
 * [style-input-notes]
 * <notes（可省略整段；有 marker 行时可为空串）>
 * ```
 *
 * - fragment 两标记行之间**逐字节**保存（构造端已 trim，解析端不再 trim——保 verbatim）。
 * - 无备注时 notes 标记行整段省略。
 * - 标记行判定**独占一行**（行首 + 行尾即 `\n`/串尾；带余文或尾随空白不算标记行）——
 *   防手打文本里的伪标记被误认成结构边界（CR-011）。
 * - fragment/notes 含与标记行 trim 相等的独立行 → 构造**抛错**（响亮拒绝，不静默坏解析）。
 */
export const STYLE_INPUT_FRAGMENT_MARKER = '[style-input-fragment]';
export const STYLE_INPUT_NOTES_MARKER = '[style-input-notes]';

/** parseStyleInputMessage 的返回：fragment 逐字节原文 + 可选作者备注。 */
export type StyleInputMessage = {
  fragment: string;
  notes?: string;
};

/** 构造风格片段结构化 user message（对话框提交侧单源；含保留标记行时抛错）。 */
export function buildStyleInputMessage(fragment: string, notes?: string): string {
  assertNoMarkerLine(fragment, 'fragment');
  const hasNotes = notes !== undefined && notes.length > 0;
  if (hasNotes) assertNoMarkerLine(notes as string, 'notes');
  const base = `${STYLE_INPUT_FRAGMENT_MARKER}\n${fragment}`;
  return hasNotes
    ? `${base}\n${STYLE_INPUT_NOTES_MARKER}\n${notes}`
    : base;
}

/**
 * 从消息 content 机械提取风格片段结构（dispatch 侧单源）。
 * 非 style-input 消息（无行首 fragment 标记）→ null。fragment 逐字节原样返回（不 trim）。
 *
 * **两个标记都必须独占一行**（CR-011 收紧）：行首（串首或前随 `\n`）且行尾即 `\n` 或串尾
 * ——标记后带余文（含尾随空格）不算标记行，该次出现按普通正文对待。防用户手打文本里
 * 「[style-input-notes] 余文」形态被误认成结构边界导致 notes 起点错位。
 */
export function parseStyleInputMessage(content: string): StyleInputMessage | null {
  const head = content.indexOf(STYLE_INPUT_FRAGMENT_MARKER);
  // fragment 标记须独占一行（行首 + 行尾即 \n 或 EOS）——行中/行尾带余文的同文不算。
  if (head === -1 || (head !== 0 && content[head - 1] !== '\n')) return null;
  const afterMarker = head + STYLE_INPUT_FRAGMENT_MARKER.length;
  if (afterMarker < content.length && content[afterMarker] !== '\n') return null;
  const fragmentStart = afterMarker + 1;
  const notesHead = content.indexOf(`\n${STYLE_INPUT_NOTES_MARKER}`, fragmentStart);
  if (notesHead === -1) {
    return { fragment: content.slice(fragmentStart) };
  }
  // notes 标记同判独占一行（CR-011）：行尾非 \n/EOS（带余文/尾随空白）→ 不是标记——
  // 该行按 fragment 正文原样保留，整条按无 notes 段解析。
  const afterNotes = notesHead + 1 + STYLE_INPUT_NOTES_MARKER.length;
  if (afterNotes < content.length && content[afterNotes] !== '\n') {
    return { fragment: content.slice(fragmentStart) };
  }
  const notesStart = afterNotes + 1;
  return {
    fragment: content.slice(fragmentStart, notesHead),
    notes: content.slice(notesStart),
  };
}

function assertNoMarkerLine(text: string, where: string): void {
  const hit = [STYLE_INPUT_FRAGMENT_MARKER, STYLE_INPUT_NOTES_MARKER].find((marker) =>
    text.split('\n').some((line) => line.trim() === marker),
  );
  if (hit !== undefined) {
    throw new Error(`${where} contains the reserved marker line ${hit}`);
  }
}

export type FileTreeEntry = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeEntry[];
};

export type SaveBase64ImageInput = {
  b64Json: string;
  mimeType: string;
  /**
   * `inbox/images` = Agent 对话图片附件落位（task 09-01 B 波 R2.3——用户可见、持久、
   * 可删；与 temp 生成图 / assets 资产图正交，不互转）。shell handler 已支持（B3 落
   * ALLOWED_IMAGE_DIRS + notify 参数），此处仅补齐契约字面量。
   */
  directory: 'temp/images/generation' | 'assets/images' | 'inbox/images';
  fileName?: string;
  /**
   * 09-01 B4：落盘后显式广播 `file:changed`（chat 进件路径传 true——文件树即时可见，
   * 不赌平台 watcher 差异）。默认不开：既有消费者（AssetsPanel 拖入 / ImageGenEditor）
   * 自带重载，无差别事件会白触发资产页全量重载（design §2.1 / 复查 M4）。
   */
  notify?: boolean;
};

export type SavedImageFile = {
  relativePath: string;
  fullPath: string;
  fileName: string;
};

/** Binary file payload returned by `project:read-file-binary`. */
export type BinaryFilePayload = {
  base64: string;
  mimeType: string;
};

/* ── A 波 09-01（task 09-01-agent-chat-attachments）：inbox 附件上传 IPC 载荷契约 ──
 *
 * canonical 类型源在此（OrisonDesktopApi 的三方法 + importFiles 白名单扩参）；shell
 * handler 侧形态单源在 `main/ipc/toolHandlers/parseDocumentHandlers.ts`（三通道）与
 * `main/ipc/projectFileIpc.ts`（import-files）——手动 keep-in-sync（mirror contracts/
 * attachment.ts 契约惯例），preload/index.ts 经本模块类型暴露（本地镜像段已并回）。 */

/**
 * `project:import-files` 传入非空 `allowedExtensions` 白名单时的返回形态（A1 additive）。
 * 不传 / 空数组 = 旧行为，返回 `string[]`（既有文件树拖入消费方零漂移）。
 */
export type ImportFilesResult = {
  /** 拷入成功的文件（项目相对路径，带前导 `/`——与旧 string[] 形态一致）。 */
  imported: string[];
  /** 拒收条目（未拷入、不触发 file:changed）。两种形态（CR-018）：扩展名白名单拒收 =
   *  裸文件名；大小超限 / 批量溢出 = `文件名 (原因)` 带原因后缀（附件路径下 AC2 明确
   *  提示，UI 文案按原因细分）。敏感路径等其余闸维持静默跳过，不混入 rejected。 */
  rejected: string[];
};

/**
 * 解析通道标签（mirror shell `parseDocumentHandlers.ts` 的 `ParseDocVia`，手动
 * keep-in-sync——shell 侧后续迁 shared-contracts 单源时的落点即此处）。
 */
export type ParseDocVia =
  | 'endpoint-mineru'
  | 'endpoint-docling'
  | 'endpoint-custom'
  | 'builtin-pdfjs'
  | 'builtin-mammoth'
  | 'direct-read';

export interface ParseInboxDocInput {
  projectPath: string;
  /** inbox 内项目相对路径（docx/pdf 预解析派生 .md；txt/md preview-only）。 */
  filePath: string;
}

export type ParseInboxDocResult =
  | { ok: true; markdownPath: string; preview: string; via: ParseDocVia; notes: string[] }
  | { ok: false; error: string; kind?: 'scanned' };

export interface ResolveInboxAttachmentInput {
  projectPath: string;
  filePath: string;
}

export type ResolveInboxAttachmentResult =
  | {
      ok: true;
      /** `sha256:<hex>`——内容身份（派生 .md 优先，txt/md 原件；R1.2c）。 */
      contentHash: string;
      /** 原件 mtime（epoch ms）——附件携带 fileMtime 供 staleness 判定。 */
      mtime: number;
      preview: string;
      /** 命中缓存的描述（exact/similar 命中时在）；fresh 未生成时缺省。 */
      description?: string;
      /** 描述生成时间（epoch ms）＝sidecar 条目 generatedAt。 */
      describedAt?: number;
      /** 附件指针指向的材料路径（docx/pdf = 派生 .md；txt/md = 原件）。 */
      derivedPath: string;
      /** 命中形态：exact 精确哈希（零 LLM）/ similar shingle ≥80%（零 LLM）/ false fresh。 */
      reused: 'exact' | 'similar' | false;
      /** 解析备注透传（CR-010）：非 UTF-8 转换提示 / 端点降级备注等——preview 被编码
       *  检测抑制为空时 UI 靠它说明原因（转换引导可达）。无备注时省略。 */
      notes?: string[];
    }
  | { ok: false; error: string; kind?: 'scanned' };

export interface StoreAttachmentDescriptionInput {
  projectPath: string;
  filePath: string;
  /** LLM 生成的一句话定性（UI 侧生成完毕后回写 sidecar 落缓存）。 */
  description: string;
  /** 描述生成时所见文件 mtime（= resolve 返回的 mtime，CR-013 TOCTOU 守卫）：shell
   *  比对现盘 mtime 更新则拒绝回写——防过期描述挂到新内容哈希、staleness 判定恒假。
   *  缺省 = 守卫不启用（additive，旧调用方零影响）。 */
  capturedMtime?: number;
}

export type StoreAttachmentDescriptionResult =
  | { ok: true; contentHash: string }
  | { ok: false; error: string };

/* ── Story 10.1 Wave D（E10.1 摄取基座）：材料库管理面 IPC 载荷契约 ──
 *
 * 六 invoke 通道（shell handler 单源 `main/ipc/materialIpc.ts`）+ material:changed 推送
 * 事件（通道名单源 contracts/channels.ts MATERIAL_CHANGED_CHANNEL，不进 desktopIpcSchema
 * enum——push 同 world:changed 先例）。错误一律模式 A（判别联合 + 稳定 error code，
 * 不向 renderer 抛）。
 *
 * expected_downstream_consumers:
 * - ui 材料 页 + materialsSlice（list/import/delete/reingest/provenance 表单消费面）。
 * - 10.2/10.3 管线后续接入时经 materials:list/get 取材料清单与章界（本面为管理面，
 *   检索消费走 query_craft/query_story 天然含材料 chunk，design §7 消费缝）。 */

/**
 * `materials:list` 入参。scope='project' 时 projectId 必填（registry 5 位 id，mirror
 * worldIpc 直查形态——读参数全绑定无路径安全面）；scope='global' 全局车道（~/.orison/
 * materials/，机器级）。
 */
export interface MaterialsListInput {
  scope: 'project' | 'global';
  projectId?: string;
}

/**
 * 材料行摘要（materials:list 返回行——Material 裁剪投影：剥 chapters/chunkSpans 大数组，
 * 保留列表/徽章/表单所需字段。UI 全行详情走 materials:get）。
 */
export type MaterialSummary = {
  materialId: string;
  scope: 'project' | 'global';
  projectId: string | null;
  kind: string;
  name: string;
  format: MaterialFormat;
  /**
   * provenance.medium（来源类别徽章；开放词表——未知值**原样呈现不推测**，不归「其他」，
   * mirror MaterialRow.mediumLabel 实现：i18n 键回落时显示原文）。
   */
  medium: string;
  /** provenance.tier（三级来源，10.4 预留）。 */
  tier: 'original' | 'community' | 'criticism' | 'unspecified';
  author: string | null;
  lang: string | null;
  originDate: string | null;
  /** 原件路径（相对各自车道根，schema 约定）。 */
  sourcePath: string;
  status: MaterialStatus;
  charCount: number;
  /** 章界计数 + 分章结论（章状态徽章与置信呈现）。 */
  chapterCount: number;
  chapterMethod: MaterialChapterMethod;
  chapterConfidence: MaterialChapterConfidence;
  /** 质量徽章信号（AC8 诚实标注：扫描版 / 非 UTF-8 乱码嫌疑）。 */
  scanned: boolean;
  nonUtf8: boolean;
  /** 解析备注（端点降级 / LLM 兜底挂起原因等，tooltip 呈现）。 */
  parseNotes: string[];
  /** 摄取完成时刻（ISO；列表时间列）。 */
  ingestedAt: string;
};

/** `materials:get` 返回：全行 Material + 派生/原件绝对路径（打开派生 .md / reveal 用）。 */
export type MaterialDetail = {
  material: Material;
  /** 派生 .md 绝对路径（车道根 + .derived/ 镜像布局）；路径不可解析时 null。 */
  derivedAbsPath: string | null;
  /** 原件绝对路径；路径不可解析时 null。 */
  sourceAbsPath: string | null;
};

/** `materials:delete` 结果（D8 四清：原件 + 派生 .md + 登记行 + 双车道 chunk 行）。 */
export type MaterialDeleteResult =
  | { ok: true; removedSourceFile: boolean; removedDerivedFile: boolean }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'operation-failed'; message?: string };

/** `materials:reingest` 结果（registerMaterial 入 per-scope 串行队列执行完毕回执）。 */
export type MaterialReingestResult =
  | { ok: true; outcome: 'registered' | 'reused' | 'orphaned'; materialId: string }
  | { ok: false; error: 'not-found' | 'unregistered' | 'invalid-input' | 'operation-failed'; message?: string };

/**
 * `materials:import` 入参。批量拖入的外部文件绝对路径（≤250/批 + 50MB/件 shell 侧强制，
 * AC7 独立上限〔F-06〕）；scope='project' 时 projectId 必填（车道根解析）。
 */
export interface MaterialsImportInput {
  scope: 'project' | 'global';
  projectId?: string;
  absolutePaths: string[];
}

/**
 * 批量导入拒收分类（machine-readable 档位——UI 按档分文案，zh/en materials.yaml
 * `import.rejectedKind.*` 键集与之对拍）。前三档 = 容量/格式闸（mirror materialIngest
 * `MATERIAL_REJECTION_KINDS`）；CR-001/CR-011 细化三档（真实原因可见，不塞进
 * unsupported-format）：
 * - `stem-conflict`：同车道/同批内同 stem 异扩展（`foo.txt` + `foo.md`——派生 .md 镜像
 *   `.derived/<stem>.md` 同路径互覆写，后到者拒收）。
 * - `sensitive`：源在敏感目录（realpath 解析 symlink/junction 后命中）。
 * - `missing`：源 stat 失败/已消失（拖拽列表与拷入之间的 TOCTOU）。
 */
export type MaterialImportRejectionKind =
  | 'unsupported-format'
  | 'too-large'
  | 'batch-overflow'
  | 'stem-conflict'
  | 'sensitive'
  | 'missing';

export type MaterialImportRejectedItem = {
  /** 原文件名（拒收回报对位）。 */
  name: string;
  kind: MaterialImportRejectionKind;
};

/** 拷入成功且登记完成的条目（outcome 语义同 RegisterMaterialResult）。 */
export type MaterialImportedItem = {
  name: string;
  /** materials 根内相对路径（posix）。 */
  relPath: string;
  materialId: string | null;
  outcome: 'registered' | 'reused' | 'orphaned';
};

/**
 * `materials:import` 结果（部分成功语义）。`failed` = 拷入成功但摄取失败（解析/坏档/
 * 扫描件——文件已在 materials/，watcher/backfill 会自愈重试，非拒收档）。
 */
export type MaterialsImportResult =
  | {
      ok: true;
      imported: MaterialImportedItem[];
      rejected: MaterialImportRejectedItem[];
      failed: Array<{ name: string; relPath: string; reason: string }>;
    }
  | { ok: false; error: 'invalid-input' | 'unregistered' | 'operation-failed'; message?: string };

/**
 * `materials:update-provenance` 入参（F-05 UI 后补面）。六字段表单（E10.2a += 简介
 * `description`，多行）——**字段缺省 = 不动**（partial patch 语义）；author/lang/originDate/
 * description 显式 null = 清空（可撤销后补；description 空串在 handler 归一为 null，同型）。
 * medium 开放受控词表（非空字符串）；tier 三级来源枚举。
 */
export interface MaterialProvenancePatchInput {
  materialId: string;
  patch: {
    medium?: string;
    tier?: 'original' | 'community' | 'criticism' | 'unspecified';
    author?: string | null;
    lang?: string | null;
    originDate?: string | null;
    /** 简介（E10.2a，design §3.2）：空串 → null 归一（同 author 三字段语义）。 */
    description?: string | null;
  };
}

export type MaterialProvenancePatchResult =
  | { ok: true; material: Material }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-patch' | 'operation-failed'; message?: string };

/**
 * `materials:update-name` 入参（E10.2a，design §3.1）。材料显示名（视频标题等）编辑——name
 * 是 display 列，materialId 路径身份不受影响（重命名不影响幂等/锚定）。校验语义：trim + 非空
 * + 长度 ≤ MATERIAL_NAME_MAX_CHARS（handler 侧强制，越界/空白 → `invalid-input`，模式 A）。
 */
export interface MaterialUpdateNameInput {
  materialId: string;
  name: string;
}

/** 材料显示名长度上限（design §3.1；UI maxlength 与 handler 校验单源）。 */
export const MATERIAL_NAME_MAX_CHARS = 200;

/** `materials:update-name` 结果（模式 A；成功回完整 Material——列表名/表单基线刷新用）。 */
export type MaterialUpdateNameResult =
  | { ok: true; material: Material }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'operation-failed'; message?: string };

/**
 * `material:changed` 推送事件载荷（shell materialNotify 全窗广播，best-effort——事件可丢，
 * 读侧兜底 = 材料页打开边沿 force 重拉）。reason：imported（批量导入逐份）/ reingested /
 * deleted / provenance-updated / name-updated（E10.2a 显示名编辑——列表名刷新）/ reindexed
 * （watcher .derived 变更路由，预埋）。
 */
export type MaterialChangedEvent = {
  scope: 'project' | 'global';
  /** project 车道 registry projectId（事件过滤用；global 车道 null）。 */
  projectId?: string | null;
  materialId?: string;
  reason: 'imported' | 'reingested' | 'deleted' | 'provenance-updated' | 'name-updated' | 'reindexed';
};

/* ── E10.2b Wave 1（task 09-05）：经验文档蒸馏管线 IPC 载荷契约（手艺卡/词表/台账管理面）──
 *
 * 11 invoke 通道（载荷契约本块单源；shell handler + preload + OrisonDesktopApi 接口方法
 * 归 W3-W5 waves 三层同步落地）。错误一律模式 A（判别联合 + 稳定 error code，不向
 * renderer 抛——mirror 材料管理面）；读面 plain 返回（mirror materials:list/get）：
 * - craft:card-list → CraftCardSummary[]；craft:card-get → CraftCard | null。
 * - craft:merge-review-list → CraftMergeReview[]；craft:term-list → CraftTerm[]。
 * - craft:distill-status → CraftDistillLedger[]。
 * 领域 schema 单源在 contracts/closure-craft-card.ts + contracts/closure-craft-distill.ts。
 *
 * expected_downstream_consumers:
 * - W5 手艺页（队列/卡编辑/并排对比/废弃区）+ 材料页联动（蒸馏按钮/台账徽章/N 卡跳转）。
 * - W3 蒸馏编排（distill-run 入队 / distill-status 台账 / progress 事件发射）。 */

/** `craft:distill-run` 入参（批量队列——按材料触发，材料页/手艺页入口）。 */
export interface CraftDistillRunInput {
  materialIds: string[];
}

/**
 * distill-run 跳过原因（机器可读档位——UI 分文案）：
 * - `not-ready`：pending/failed 材料不可蒸（ready/low-confidence 可蒸——章界挂起与
 *   蒸馏正交，F-09 语义）。
 * - `hash-unchanged`：双 hash 门控命中（已蒸馏且原件未变——材料级幂等，AC7）。
 */
export type CraftDistillSkipReason = 'not-found' | 'not-ready' | 'already-running' | 'hash-unchanged';

/** `craft:distill-run` 结果（模式 A；部分成功语义——跳过项逐份回报原因）。 */
export type CraftDistillRunResult =
  | {
      ok: true;
      queued: string[];
      skipped: Array<{ materialId: string; reason: CraftDistillSkipReason }>;
    }
  | { ok: false; error: 'invalid-input' | 'operation-failed'; message?: string };

/** 队列排序（默认 confidence-asc——低置信排前，R5 人审负担控制）。 */
export type CraftCardSort = 'confidence-asc' | 'updated-desc' | 'created-desc';

/** `craft:card-list` 入参（队列过滤——全字段可选 AND 组合，tags 内 OR；返回摘要行）。 */
export interface CraftCardListInput {
  status?: CraftCardStatus;
  category?: CraftCardCategory;
  termId?: string;
  /** 自由标签过滤（**任一命中即召回** OR 语义——R10 人审侧 chips 点击过滤）。 */
  tags?: string[];
  /** 按来源材料过滤（按文档分批分组键，R5）。 */
  materialId?: string;
  sort?: CraftCardSort;
}

/**
 * 手艺卡摘要行（craft:card-list 返回——CraftCard 裁剪投影：剥 teachings 大数组保
 * 计数/来源，mirror MaterialSummary 投影纪律；四件套全文/讲法/锚点走 card-get）。
 */
export type CraftCardSummary = {
  cardId: string;
  category: CraftCardCategory;
  termId: string;
  /** 词目名（join 词目表；词目行缺失防御性 null——UI 回退显示 termId）。 */
  termName: string | null;
  title: string;
  /** claim.condensed（队列预览——保义浓缩首面）。 */
  condensed: string;
  tags: string[];
  status: CraftCardStatus;
  dispute: boolean;
  confidence: number;
  /** 讲法计数 + stale 复核计数（队列徽章——stale 讲法不降级卡但进队列）。 */
  teachingCount: number;
  staleTeachingCount: number;
  /** 讲法来源材料（按材料分批分组键——去重合并后可多来源）。 */
  materialIds: string[];
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** claim 四件套 per-field patch（卡编辑轻量表单 blur 落盘的最小粒度）。 */
export interface CraftCardClaimPatch {
  condensed?: string;
  points?: string[];
  scenarios?: string[];
  counterexamples?: string[];
}

/**
 * `craft:card-patch` 入参（**编辑即降级执行点**——内容字段任何实际写库 → status 回
 * pending_review，uniform 人改也回待审，R5）。F-15：**无 category 字段**——大类恒
 * 跟随 term.category 单源（词目归并时自动改）。rejected 卡 patch = `rejected-card`
 * 错误（编辑入口禁用，必须先 recover 救回）。
 */
export interface CraftCardPatchInput {
  cardId: string;
  patch: {
    title?: string;
    /** 词目改挂（category 随新 term 自动改）。 */
    termId?: string;
    claim?: CraftCardClaimPatch;
    /** 自由标签整组替换（chips 增删净结果——R10 人审可改标签）。 */
    tags?: string[];
    /** 分歧标记人审确认/取消（LLM 判 + 人审确认——R4）。 */
    dispute?: boolean;
  };
}

/** `craft:card-patch` 结果（成功回完整卡——表单基线/降级反馈刷新用）。 */
export type CraftCardPatchResult =
  | { ok: true; card: CraftCard }
  | {
      ok: false;
      error: 'not-found' | 'invalid-input' | 'rejected-card' | 'operation-failed';
      message?: string;
    };

/** 卡状态机动作（转换表权威描述见 contracts/closure-craft-card.ts craftCardSchema JSDoc）。 */
export type CraftCardReviewAction = 'verify' | 'reject' | 'recover';

/**
 * `craft:card-review` 入参（人审状态机动作 + 讲法级 rank 改级；`action` 与
 * `teachingRank` 至少其一——都缺省 = `invalid-input`）：
 * - action 省略 = 仅改讲法 rank 不动卡状态（rank 是讲法级状态，**不触发卡降级**——
 *   与内容编辑〔降级〕和人审状态动作〔不降级〕都正交）。
 * - reject 带理由（废弃区回看）；recover 救回 rejected 卡（编辑入口解锁）。
 * - 非法转换（如 verified 卡 recover）= `invalid-state`。
 */
export interface CraftCardReviewInput {
  cardId: string;
  action?: CraftCardReviewAction;
  /** action='reject' 时的驳回理由。 */
  rejectReason?: string;
  /** 讲法级 rank 改级（approved = 人审显式认可——AI 蒸馏产恒 normal 起板）。 */
  teachingRank?: {
    teachingId: string;
    rank: CraftTeachingRank;
    /** 差异备注/不认可理由（rank='rejected' 时建议带）。 */
    note?: string;
  };
}

/** `craft:card-review` 结果（成功回完整卡——状态徽章/rank 控件刷新用）。 */
export type CraftCardReviewResult =
  | { ok: true; card: CraftCard }
  | {
      ok: false;
      error: 'not-found' | 'invalid-input' | 'invalid-state' | 'operation-failed';
      message?: string;
    };

/** `craft:merge-review-list` 入参（并排任务队列——默认只回待审）。 */
export interface CraftMergeReviewListInput {
  /** 含已裁决记录（审计回看）；缺省 = 仅待审（resolution=null）。 */
  includeResolved?: boolean;
}

/**
 * `craft:merge-review-resolve` 入参（三动作裁决——AC3 专属用例；已裁决记录再 resolve =
 * `invalid-state`）。merge/independent 产物卡回 pending_review（编辑即降级同族——
 * 裁决产物必须再过人审 verify 才进检索面）。
 */
export interface CraftMergeReviewResolveInput {
  reviewId: string;
  action: CraftMergeReviewAction;
  note?: string;
}

/** `craft:merge-review-resolve` 结果（产物卡 id 供 UI toast/跳转）。 */
export type CraftMergeReviewResolveResult =
  | {
      ok: true;
      review: CraftMergeReview;
      /** action='merge'：讲法挂入的目标卡 id（= existingCardId）。 */
      mergedIntoCardId?: string;
      /** action='independent'：新建卡 id。 */
      createdCardId?: string;
    }
  | {
      ok: false;
      error: 'not-found' | 'invalid-input' | 'invalid-state' | 'operation-failed';
      message?: string;
    };

/** `craft:term-list` 入参（词目清单——UI 补全 chips / 待并词表视图；含 pending）。 */
export interface CraftTermListInput {
  status?: CraftTermStatus;
  category?: CraftCardCategory;
}

/**
 * `craft:term-approve` 结果（pending → active；核准已 active/merged 词目 = `invalid-state`）。
 * W5 补 `'invalid-input'`（坏 termId 形态——W1 基座漏列，其余写通道均含此码，additive 补齐）。
 */
export type CraftTermApproveResult =
  | { ok: true; term: CraftTerm }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-state' | 'operation-failed'; message?: string };

/**
 * `craft:term-merge` 入参（归并：source 词目 → merged 留痕；挂它的卡 termId 改指目标 +
 * category 随目标自动改 + entry 检索行重写）。`mergeIntoTermId` 须存在且 ≠ `termId`
 * （否则 `invalid-input`）。
 */
export interface CraftTermMergeInput {
  termId: string;
  mergeIntoTermId: string;
}

/** `craft:term-merge` 结果（movedCardCount = 改挂卡数——UI 反馈「N 张卡已改挂」）。 */
export type CraftTermMergeResult =
  | { ok: true; term: CraftTerm; movedCardCount: number }
  | {
      ok: false;
      error: 'not-found' | 'invalid-input' | 'invalid-state' | 'operation-failed';
      message?: string;
    };

/** `craft:distill-status` 入参（材料台账查询——省略 materialIds = 全部台账行）。 */
export interface CraftDistillStatusInput {
  materialIds?: string[];
}

/**
 * `craft:distill-progress` 推送事件载荷（相位 + 耗时 + materialId——运行阶段可见性
 * 硬要求；shell 相位切换/周期发射，best-effort 可丢，读侧兜底 = distill-status 拉取）。
 * 终态（done/failed）事件驱动队列/台账徽章即时刷新（phase=null）。
 */
export type CraftDistillProgressEvent = {
  materialId: string;
  status: CraftDistillStatus;
  /** 运行相位（status='running' 时非 null；终态 null）。 */
  phase: CraftDistillPhase | null;
  /** 本材料蒸馏累计耗时（ms）。 */
  elapsedMs: number;
  /** status='failed' 时的失败原因。 */
  error?: string;
};

// ── E10.3a（task 09-05）W6：拆解管线控制面载荷（七 invoke + decon:progress 推送）──
//
// 变更面（模式 A——预期内用户失败判别联合不抛 renderer，mirror 材料管理面）；job/pass/canon
// 行类型单源 contracts/closure-decon.ts（本段只定义 IPC 入参/回执形状）。

/** 拆解预算 IPC 入参形态（deconBudgetSchema 的输入面——perPass 可选缺省空表）。 */
export interface DeconBudgetInput {
  /** 总 token 上限（null = 无上限跑完为止）。 */
  totalTokens: number | null;
  /** per-pass 茎追加上限（键 = pass 茎，如 'p1b'）。 */
  perPass?: Record<string, number>;
}

/** `decon:create` 入参（P0 会话建立——材料 × 档位 × 维度子集 + 可选预算）。 */
export interface DeconCreateInput {
  materialId: string;
  tier: DeconTier;
  /**
   * 维度子集（成员枚举权威 = `DECON_DIMENSIONS` 13 项目录〔12 手艺维 + 风格维 style〕，
   * parent design §6.0 矩阵）。档位约束（**拍板②实况**——与 shell `validateDeconDimensions`
   * 单源同义，CR-27 注释同步）：coarse → dims ⊆ {style}（风格维粗拆档也允许勾选，可省）；
   * fine → 手艺维 1-3 个 + style 可选不计入；deep → 全 12 手艺维必含 + style 可选。
   */
  dimensions?: string[];
  budget?: DeconBudgetInput;
  /**
   * 人审闸门开关（E10.3b 拍板①——默认开）：缺省/true → 三 checkpoint 行 status='pending'
   * （到点暂停等确认）；false → status='off'（配置即行零改 A job 表）。additive 字段——
   * 旧调用方不传 = 默认开。
   */
  reviewCheckpoints?: boolean;
}

/** 成本预估回执（启动前呈现面——estimateDeconCost 纯函数计算，P1 已有产物时打折 F-07）。 */
export interface DeconEstimateIpc {
  totalTokens: number;
  /** per-pass 键 = pass 全值（'p1a'/'p1b'/'p4:<dim>'/'p5:book_reading'…）。 */
  byPass: Record<string, number>;
}

/** `decon:create` 结果（模式 A；inflight-exists 带在途 job id 供跳转）。inheritedP1 = P1 三 pass 各自旗标（CR-17——部分继承合法）。 */
export type DeconCreateResult =
  | { ok: true; job: DeconJob; inheritedP1: DeconP1Inheritance; estimate: DeconEstimateIpc }
  | {
      ok: false;
      error:
        | 'invalid-input'
        | 'material-not-found'
        | 'material-not-ready'
        | 'derived-unreadable'
        | 'inflight-exists'
        | 'invalid-dimensions'
        | 'operation-failed';
      inflightJobId?: string;
      message: string;
    };

/** `decon:start` 入参（capped-hold 重入的调预算面：budget 在 start 前生效）。 */
export interface DeconStartInput {
  jobId: string;
  budget?: DeconBudgetInput;
}

/** `decon:start` 结果（noop = 已 running/已 done——在途管线/既有结果是权威，不重跑）。 */
export type DeconStartResult =
  | { ok: true; job: DeconJob; noop: boolean }
  | {
      ok: false;
      error: 'not-found' | 'stale-fingerprints' | 'invalid-state' | 'invalid-input' | 'operation-failed';
      job?: DeconJob;
      message: string;
    };

/** `decon:pause` / `decon:cancel` / `decon:delete` / `decon:get` 入参。 */
export interface DeconJobIdInput {
  jobId: string;
}

/** `decon:pause` / `decon:cancel` 结果。 */
export type DeconTransitionResult =
  | { ok: true; job: DeconJob }
  | { ok: false; error: 'not-found' | 'invalid-state' | 'invalid-input'; message: string };

/** `decon:delete` 结果（事实层三表材料级保留——F-07 跨 job 复用键控）。 */
export type DeconDeleteResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'operation-failed'; message?: string };

/**
 * `decon:get` 返回（人审取数面：断点行 + canon 六域 + 词典 + 聚合实体——child A prd「IPC 可查
 * 词典/canon 数据」的落点）。`fresh=false`（双指纹失配 → job 已翻 stale **或** job 已取消——
 * 两种态产物面均为空：stale 产物不静默供给下游〔F-02 读侧半边〕；cancelled 终态无消费面）
 * 时产物字段为空集，`freshReason` 标明原因。
 *
 * `entities` 为 mentions 截断投影（CR-9：首 N + 末 N 章 + 总数——千章级 mentions 不整面
 * 灌 renderer；全量走 db 消费面）。
 */
export interface DeconJobDetail {
  job: DeconJob;
  passStates: DeconPassState[];
  /**
   * 章 index → 真实章标短标签（CR-1 拍板 B——章引用标签单制）：壳侧 chapterHeadings 单源
   * 构建（chapterShortLabel：章号可解析 →「第 N 章」/无数字章标 → 章标行原词/无章标 → 语义
   * 回落《title》·简介（卷首）·正文（无章标）——零序号算术）。UI 一切章引用（unit 标签/
   * 报告锚点/续跑落点/进度 N/M）消费本表，键缺失回落 `decon.unit.materialChapter`
   * （材料第 {index} 章）。材料缺/派生读失败 → 空表（stale 态仍回——章序展示面）。
   */
  chapterLabels: Record<number, string>;
  fresh: boolean;
  /** fresh=false 的原因（fresh=true 时缺省）。 */
  freshReason?: 'stale' | 'cancelled';
  canon: DeconCanonEntry[];
  dictionary: DeconDictionary | null;
  entities: DeconEntityIpc[];
  /**
   * 人审闸门行（E10.3b additive——create 时初始化三行）。stale/cancelled 态**仍回**：off
   * 是用户常设配置、UI 区分「等审暂停」与「用户暂停」靠 review 行（pending = 等审）。
   */
  reviews?: DeconReviewRow[];
  /** 报告计数（E10.3b additive——kind → 行数；产出阅读 tab 徽标 / 导出入口可见性判据）。stale/cancelled 时空表。 */
  reportCounts?: Record<string, number>;
}

/** decon:get 实体行（mentions 截断投影——CR-9）。 */
export type DeconEntityIpc = DeconEntity & {
  /** mentions 总章数（截断时 > mentions.length）。 */
  mentionsTotal: number;
  /** mentions 是否被截断（首 N + 末 N）。 */
  mentionsTruncated: boolean;
};

/** `decon:list` 入参（省略 materialId = 全部 job）。 */
export interface DeconListInput {
  materialId?: string;
}

/**
 * `decon:progress` 推送事件载荷（运行阶段可见性硬要求；pass 相位 + 终态）。shell 在 pass
 * 边界/终态发射（P1b 另逐章发 running——CR-8 千章级小时静默防线），best-effort 可丢——读侧
 * 兜底 = decon:get 拉取（事件可丢是设计内行为）。
 */
export type DeconProgressEvent = {
  jobId: string;
  status: DeconJobStatus;
  /** 当前 pass（status='running' 时非 null；终态/中断 null）。 */
  pass: string | null;
  /** 当前 unit（章号/域名/单行哨兵——pass 内细粒度，可缺省）。 */
  unit?: string | null;
  /** 距管线启动的毫秒数（CR-8 运行相位可见——耗时面；管线发的事件恒带）。 */
  elapsedMs?: number;
  /** capped/failed 的诚实挂起原因。 */
  error?: string;
  /**
   * 软提示注记（CR-10——与 `error` 分立的常规预期态通道）：如闸门暂停的「待人工确认」。
   * `error` 只留给真失败（capped/failed 的挂起原因）；预期内的暂停/提示走 `note`，不污染
   * 诊断面。additive 可选字段——旧消费者不读不受影响。
   */
  note?: string;
};

// ── E10.3b（task 09-05）W1：拆解消费面载荷（products/reports/approve-review/export-style）──
//
// 变更面模式 A 同上。**读侧 freshness 门**（同 decon:get 纪律——F-02 读侧半边）：job=stale /
// cancelled 时不供给产物面（漂移锚点的 findings/报告不静默喂下游）。行类型单源
// contracts/closure-decon.ts（本段只定义 IPC 入参/回执形状）。

/** `decon:products` 入参（product 读面——craft 闸门卡 / 产出阅读的取数通道；按 pass 过滤控体量）。 */
export interface DeconProductsInput {
  jobId: string;
  /** pass 全值过滤（'p3a' / 'p4:huoke'…；缺省 = 全部 product 行）。 */
  pass?: string;
  /**
   * pass 前缀过滤（CR-8——壳面前缀语义）：命中条件 = `pass.startsWith(passStem)`。'p4' 匹配
   * 全部 `p4:<dim>`（**含 p4:style——风格维排除逻辑留在 UI 消费面**，通道层不做维内裁剪）；
   * 'p3' 匹配 p3a/p3b。与 `pass` 同传时两过滤叠加（AND——精确 + 前缀）；缺省 = 不过滤。
   */
  passStem?: string;
  /** unit 过滤（'3' / 'arc:1'…；缺省 = 该范围全 unit）。 */
  unit?: string;
}

/** `decon:products` 结果（stale/cancelled → fresh=false 且 products 空集）。 */
export interface DeconProductsResult {
  fresh: boolean;
  freshReason?: 'stale' | 'cancelled';
  products: DeconProductRow[];
}

/**
 * `decon:reports` 入参：省略 unit = **列表**（只回 meta——大书章评数百行不整面灌 renderer）；
 * 带 kind + unit = **单取**（回全文行）。stale freshness 门同上。**坏 kind 串显式拒收**
 * （CR-24——kind 存在但不在枚举内 → `error='invalid-input'`，不静默降级全列表）。
 */
export interface DeconReportsInput {
  jobId: string;
  kind?: DeconReportKind;
  unit?: string;
}

/**
 * `decon:reports` 结果：`report !== null` = 单取形态（列表调用方忽略 list）；否则 list 形态
 * （单取调用方忽略 list——未命中时 report=null）。stale/cancelled → fresh=false + 双空。
 * `error='invalid-input'`（CR-24 additive 可选字段）= kind 串坏被显式拒收（list/report 双空
 * + message 说明——正常路径缺省，旧消费者不读不受影响）。
 */
export interface DeconReportsResult {
  fresh: boolean;
  freshReason?: 'stale' | 'cancelled';
  /** 入参拒收面（kind 串坏——CR-24；正常路径缺省）。 */
  error?: 'invalid-input';
  /** error 面的说明文案（正常路径缺省）。 */
  message?: string;
  list: DeconReportMeta[];
  report: DeconReportRow | null;
}

/** `decon:approve-review` 入参（闸门确认——approved 后 start 续跑，台账 skip 已 done pass 零重付）。 */
export interface DeconApproveReviewInput {
  jobId: string;
  checkpoint: DeconReviewCheckpoint;
}

/** `decon:approve-review` 结果（invalid-state = 闸门行非 pending——已确认/已关）。 */
export type DeconApproveReviewResult =
  | { ok: true; review: DeconReviewRow }
  | { ok: false; error: 'not-found' | 'invalid-input' | 'invalid-state'; message: string };

/**
 * `decon:export-style` 入参（风格维 p4:style 结构化 payload → 合并写目标项目
 * settings/style.md：parseStyleSections 按语义键替换识别节、保留未识别/手写节与卡头、无卡
 * 标准 14 节新建；withProjectLock + atomicWrite 落盘；写前确认与无项目禁用提示归 UI）。
 * projectId = 操作时项目上下文（目标绑定——全局车道材料自身无项目归属）。
 */
export interface DeconExportStyleInput {
  jobId: string;
  projectId: string;
}

/** `decon:export-style` 结果（writtenSections = 实际写入的节语义键列表；style-payload-missing = p4:style 未产出）。 */
export type DeconExportStyleResult =
  | { ok: true; writtenSections: string[] }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'invalid-input'
        | 'style-payload-missing'
        | 'project-not-found'
        | 'operation-failed';
      message: string;
    };

// ── E10.3b（task 09-05）W7 小补③：stale 确认重跑通道（decon:confirm-rerun）──

/** `decon:confirm-rerun` 入参（stale 态专用——非 stale 态 invalid-state）。 */
export interface DeconConfirmRerunInput {
  jobId: string;
}

/**
 * `decon:confirm-rerun` 结果：ok = 确认成功且续跑已派发（job pending→running，后台管线
 * 重入）。invalid-state = 非 stale 态（须先经 decon:get 读侧翻 stale）或续跑被拒（确认已
 * 落）；material-not-found = 材料已删（无重跑基面，只剩 delete 出路）。
 */
export type DeconConfirmRerunResult =
  | { ok: true; job: DeconJob }
  | {
      ok: false;
      error: 'not-found' | 'invalid-state' | 'material-not-found' | 'invalid-input';
      job?: DeconJob;
      message: string;
    };

/* ── Task persistence types ── */

export type TaskRecord = {
  taskId: string;
  projectId: string;
  taskType: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  errorMessage?: string;
  outputPayload?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskUpsertInput = {
  taskId: string;
  projectId: string;
  taskType: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  errorMessage?: string;
  outputPayload?: string;
};

export type AssetRecord = {
  assetId: string;
  projectId: string;
  assetType: string;
  assetName: string;
  assetGroup: string;
  assetStatus: string;
  relativePath: string;
  sourceTaskId?: string;
  summary?: string;
  version: number;
  updatedAt: string;
};

export type AssetUpsertInput = {
  assetId: string;
  projectId: string;
  assetType: string;
  assetName: string;
  assetGroup?: string;
  assetStatus?: string;
  relativePath: string;
  sourceTaskId?: string;
  summary?: string;
};

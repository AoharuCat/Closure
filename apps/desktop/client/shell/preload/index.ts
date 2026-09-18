import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AssetRecord,
  AssetUpsertInput,
  // 子4 agy MCP 工具桥（W4）：同意/状态/关闭回收三通道契约类型（type-only，sandbox 纪律
  // 见下方 WORLD_CHANGED_CHANNEL 注释）。
  AgyBridgeConsentResult,
  AgyBridgeConsentValue,
  AgyBridgeRevokeResult,
  AgyBridgeStatusView,
  CraftRebuildResult,
  GenerateEmbeddingPayload,
  GenerateImagePayload,
  GenerateTextPayload,
  GitCommitEntry,
  GitFileDiff,
  ImportedFont,
  ImageGenerationResponse,
  EmbeddingResponse,
  IndexStatus,
  ListRemoteModelsRequest,
  ListCliModelsRequest,
  CliModelDiscoveryResult,
  DocParserProbeResult,
  ModelConfig,
  ModelRef,
  OrisonDesktopApi,
  // 09-01 A3：inbox 附件三通道 canonical 契约类型（type-only，零 runtime 内联——
  // preload sandbox 纪律见下方 WORLD_CHANGED_CHANNEL 注释）。
  ParseInboxDocInput,
  ParseInboxDocResult,
  ResolveInboxAttachmentInput,
  ResolveInboxAttachmentResult,
  StoreAttachmentDescriptionInput,
  StoreAttachmentDescriptionResult,
  ImportFilesResult,
  ProjectLifecycleResult,
  ProjectMutationResult,
  ProjectSearchResult,
  RegisteredProject,
  RemoteModel,
  RerankPayload,
  RerankResponse,
  ResearchConfigSave,
  ResearchConfigView,
  VisionCanaryResult,
  CompileRevisionIntentInput,
  CompileRevisionIntentResult,
  AcceptSettingMdInput,
  AcceptSettingMdResult,
  ApplyAuthorProfileNoteInput,
  ApplyAuthorProfileNoteResult,
  LintApplyFixResult,
  LintClassifyResult,
  LintFixPatch,
  LintModelProbeResult,
  LintScanFullResult,
  ResumeChapterChainInput,
  RunChapterChainInput,
  RunChapterChainSummary,
  // 链流程重排 W4（R6 / 09-13 子3 W6）：derivation-status 查询 + 链外重提取的结果契约
  //（type-only 零 runtime 内联——sandbox 纪律见下方 WORLD_CHANGED_CHANNEL 注释）。
  ChapterDerivationStatusResult,
  ReExtractChapterResult,
  RunStorySyncPayload,
  RunStorySyncResult,
  SaveBase64ImageInput,
  StoryRebuildResult,
  TaskRecord,
  TaskUpsertInput,
  TextGenerationResponse,
  UpdateCheckResult,
  UpdateEvent,
  UserPreferencesConfig,
  UsageClearResult,
  UsageOverview,
  WorldChangedEvent,
  WorldOverview,
  WorldOverviewRequest,
  WorldSliceDetail,
  WorldSliceDetailRequest,
  WorldSubjectDetail,
  WorldSubjectDetailRequest,
  // Story 10.1 Wave D：材料库管理面契约类型（type-only 零 runtime 内联——sandbox 纪律
  // 见下方 WORLD_CHANGED_CHANNEL 注释与 channels 深导入）。
  MaterialChangedEvent,
  MaterialDeleteResult,
  MaterialDetail,
  MaterialProvenancePatchInput,
  MaterialProvenancePatchResult,
  // E10.2a：materials:update-name 契约类型（type-only 零 runtime 内联）。
  MaterialUpdateNameInput,
  MaterialUpdateNameResult,
  MaterialReingestResult,
  MaterialsImportInput,
  MaterialsImportResult,
  MaterialsListInput,
  MaterialSummary,
  // E10.2b（task 09-05）W3：蒸馏管线契约类型（type-only 零 runtime 内联——同上 sandbox 纪律）。
  CraftDistillRunInput,
  CraftDistillProgressEvent,
  CraftDistillRunResult,
  CraftDistillStatusInput,
  CraftDistillLedger,
  // E10.2b（task 09-05）W5：手艺卡人审面九通道契约类型（type-only 零 runtime 内联——载荷
  // 契约单源 shared-contracts ipc.ts「E10.2b Wave 1」段）。
  CraftCard,
  CraftCardListInput,
  CraftCardPatchInput,
  CraftCardPatchResult,
  CraftCardReviewInput,
  CraftCardReviewResult,
  CraftCardSummary,
  CraftMergeReview,
  CraftMergeReviewListInput,
  CraftMergeReviewResolveInput,
  CraftMergeReviewResolveResult,
  CraftTerm,
  CraftTermApproveResult,
  CraftTermListInput,
  CraftTermMergeInput,
  CraftTermMergeResult,
  // E10.3a（task 09-05）W6：拆解管线控制面契约类型（type-only 零 runtime 内联——载荷契约
  // 单源 shared-contracts ipc.ts「E10.3a W6」段）。
  DeconCreateInput,
  DeconCreateResult,
  DeconStartInput,
  DeconStartResult,
  DeconJobIdInput,
  DeconTransitionResult,
  DeconDeleteResult,
  DeconJobDetail,
  DeconListInput,
  DeconJob,
  DeconProgressEvent,
  // E10.3b（task 09-05）W3b：人审闸门确认通道契约类型（type-only 零 runtime 内联）。
  DeconApproveReviewInput,
  DeconApproveReviewResult,
  // E10.3b（task 09-05）W5：读面 + 风格导出通道契约类型（type-only 零 runtime 内联）。
  DeconProductsInput,
  DeconProductsResult,
  DeconReportsInput,
  DeconReportsResult,
  DeconExportStyleInput,
  DeconExportStyleResult,
  // E10.3b（task 09-05）W7 小补③：stale 确认重跑通道契约类型（type-only 零 runtime 内联）。
  DeconConfirmRerunInput,
  DeconConfirmRerunResult,
} from '@orison/shared-contracts';
// 推送通道名单源常量（BMad CR #8）：preload 与 shell 发射器（worldNotify）共同引用
// shared-contracts WORLD_CHANGED_CHANNEL，禁硬编码。**深导入 zod-free 叶子模块**
// （dogfood R2 #99）：barrel 导入会把 contracts 全图连同 zod（顶层 require node:crypto）
// 内联进 preload bundle——sandbox preload 随即整崩、window.orisonDesktop 消失、
// 全 app IPC 静默哑掉。叶子路径只内联常量本体。守卫：shell test preload-sandbox-imports。
import { WORLD_CHANGED_CHANNEL } from '@orison/shared-contracts/contracts/channels';
// Story 10.1 Wave D：material:changed 推送通道常量（同上 zod-free 叶子深导入纪律）。
import { MATERIAL_CHANGED_CHANNEL } from '@orison/shared-contracts/contracts/channels';
import { CRAFT_DISTILL_PROGRESS_CHANNEL } from '@orison/shared-contracts/contracts/channels';
// E10.3a（task 09-05）W6：decon:progress 推送通道常量（同上 zod-free 叶子深导入纪律）。
import { DECON_PROGRESS_CHANNEL } from '@orison/shared-contracts/contracts/channels';

/**
 * dogfood R2 #92：world:changed 订阅的 callback → 包装 listener 映射（BMad CR #7+#105：WeakMap →
 * **Map**——wrapper 登记必须存活到显式退订，不随 callback 可达性被 GC）。ipcRenderer.removeListener
 * 只认注册时的包装函数，offWorldChanged(callback) 以原 callback 为键取回包装再移除（只移除本
 * 监听器，绝不 removeAllListeners——mirror onUpdateEvent / onToolEvent 订阅纪律）。同 callback
 * 重复订阅时**先摘旧 wrapper 再挂新**（防双份回调：旧 wrapper 若不摘，channel 上会残留两条都指向
 * 同一 callback 的监听，offWorldChanged 只能摘到最新那条）。
 */
const worldChangedListeners = new Map<
  (event: WorldChangedEvent) => void,
  (_e: unknown, event: WorldChangedEvent) => void
>();

/**
 * A 波 09-01（inbox 附件）三通道：canonical 载荷类型已落 shared-contracts ipc.ts
 * （A3 契约补条目），本地镜像段（`ok: boolean` 宽形态）退役——直接以契约类型暴露，
 * 方法并入下方主对象（键面不变，securitySurface 白名单零漂移）。
 */

export const exposedDesktopApi = {
  pickProjectDirectory: () => ipcRenderer.invoke('project:pick-directory'),
  createProjectDirectory: (parentDir: string, name: string) =>
    ipcRenderer.invoke('project:create-directory', parentDir, name) as Promise<string>,
  pickCoverImage: () => ipcRenderer.invoke('project:pick-cover-image') as Promise<string | null>,
  copyCoverImage: (src: string, projectDir: string) =>
    ipcRenderer.invoke('project:copy-cover-image', src, projectDir) as Promise<string>,
  importDocx: (projectDir: string) =>
    ipcRenderer.invoke('project:import-docx', projectDir) as Promise<string | null>,
  docxToHtml: (fullPath: string) =>
    ipcRenderer.invoke('project:docx-to-html', fullPath) as Promise<string | null>,
  docxToMarkdown: (fullPath: string, projectDir: string) =>
    ipcRenderer.invoke('project:docx-to-markdown', fullPath, projectDir) as Promise<string | null>,
  saveProjectMeta: (projectDir: string, meta: Record<string, unknown>) =>
    ipcRenderer.invoke('project:save-meta', projectDir, meta) as Promise<ProjectMutationResult>,
  ensureProjectDocument: (projectDir: string, meta: Record<string, unknown>) =>
    ipcRenderer.invoke('project:ensure-document', projectDir, meta) as Promise<ProjectMutationResult>,
  syncProjectMeta: (projectDir: string, meta: Record<string, unknown>) =>
    ipcRenderer.invoke('project:sync-meta', projectDir, meta),
  syncChaptersMeta: (projectDir: string, chapters: Array<{
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
  }>) =>
    ipcRenderer.invoke('project:sync-chapters-meta', projectDir, chapters),
  loadProjectMeta: (projectDir: string) =>
    ipcRenderer.invoke('project:load-meta', projectDir) as Promise<Record<string, unknown> | null>,
  getLocale: () => navigator.language,
  // 窗口控制
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  platform: process.platform,
  // 字段同步
  syncField: (projectPath: string, field: string, data: unknown) =>
    ipcRenderer.invoke('field:sync', projectPath, field, data) as Promise<void>,
  applyAgentFieldPatch: (projectPath: string, fieldPatch: unknown) =>
    ipcRenderer.invoke('field:apply-agent-patch', projectPath, fieldPatch) as Promise<unknown>,
  toggleFieldLock: (projectPath: string, field: string) =>
    ipcRenderer.invoke('field:toggle-lock', projectPath, field) as Promise<void>,
  loadProjectDocument: (projectDir: string) =>
    ipcRenderer.invoke('project:load-document', projectDir) as Promise<Record<string, unknown> | null>,
  // 模型配置
  loadModelConfig: () => ipcRenderer.invoke('config:load-model') as Promise<ModelConfig>,
  saveModelConfig: (config: ModelConfig) => ipcRenderer.invoke('config:save-model', config) as Promise<void>,
  isKeyEncryptionAvailable: () => ipcRenderer.invoke('config:is-key-encryption-available') as Promise<boolean>,
  // Story 3.6 WP10: research settings aggregate (net proxy + search chain with
  // REDACTED keys + doc parser + wiki presets) —「研究与视觉」settings page.
  loadResearchConfig: () =>
    ipcRenderer.invoke('research:load-config') as Promise<ResearchConfigView>,
  saveResearchConfig: (config: ResearchConfigSave) =>
    ipcRenderer.invoke('research:save-config', config) as Promise<void>,
  // Forced doc-parser endpoint health probe (settings「测试连接」lamp).
  probeResearchDocParser: () =>
    ipcRenderer.invoke('research:probe-doc-parser') as Promise<DocParserProbeResult>,
  // Vision-model canary probe (known-answer image → silent-strip detection).
  canaryProbeVision: (ref: ModelRef) =>
    ipcRenderer.invoke('research:canary-vision', ref) as Promise<VisionCanaryResult>,
  listRemoteModels: (request: ListRemoteModelsRequest) =>
    ipcRenderer.invoke('model:list-remote-models', request) as Promise<RemoteModel[]>,
  // 09-12 agy provider W4: CLI-form provider model discovery (`agy models` TSV).
  // Typed result — `not-logged-in` drives the settings-page login guidance.
  listCliModels: (request: ListCliModelsRequest) =>
    ipcRenderer.invoke('model:list-cli-models', request) as Promise<CliModelDiscoveryResult>,
  // 模型生成（desktop main 直连 provider）
  generateText: (payload: GenerateTextPayload) =>
    ipcRenderer.invoke('model:generate-text', payload) as Promise<TextGenerationResponse>,
  generateImage: (payload: GenerateImagePayload) =>
    ipcRenderer.invoke('model:generate-image', payload) as Promise<ImageGenerationResponse>,
  generateEmbedding: (payload: GenerateEmbeddingPayload) =>
    ipcRenderer.invoke('model:generate-embedding', payload) as Promise<EmbeddingResponse>,
  // Story 2.1: cross-encoder rerank（检索阶段 rerank，mirror embedding 通道）
  rerank: (payload: RerankPayload) =>
    ipcRenderer.invoke('model:rerank', payload) as Promise<RerankResponse>,
  // ── 09-12 usage-panel（子5 W3）：应用内用量面两通道（纯读聚合 + 手动清空；无推送事件面）。──
  usageOverview: () =>
    ipcRenderer.invoke('usage:overview') as Promise<UsageOverview>,
  usageClear: () =>
    ipcRenderer.invoke('usage:clear') as Promise<UsageClearResult>,
  // ── 子4 agy MCP 工具桥（W4）：同意/状态/关闭回收三通道（machine 级读写，无推送面）。──
  agyBridgeStatus: () =>
    ipcRenderer.invoke('agy-bridge:status') as Promise<AgyBridgeStatusView>,
  agyBridgeSetConsent: (input: { consent: AgyBridgeConsentValue }) =>
    ipcRenderer.invoke('agy-bridge:consent', input) as Promise<AgyBridgeConsentResult>,
  agyBridgeRevoke: () =>
    ipcRenderer.invoke('agy-bridge:revoke') as Promise<AgyBridgeRevokeResult>,
  // Story 2.1 CR-craft-kb-011: manual full rebuild of the global craft KB index.
  // No 2.1 UI calls it (agent-facing story); the IPC surface is the deliverable
  // for Epic 3's settings/command-bar "Rebuild craft KB" action.
  rebuildCraftKb: () =>
    ipcRenderer.invoke('closure:rebuild-craft-kb') as Promise<CraftRebuildResult>,
  // Story 2.7: KB index management page — status counts + manual story-index rebuild.
  // Channel declared in A1; the ipcMain.handle lands in B段 (closureIndexIpc).
  getIndexStatus: (input: { projectId?: string }) =>
    ipcRenderer.invoke('closure:index-status', input) as Promise<IndexStatus>,
  rebuildStoryIndex: (input: { projectId: string }) =>
    ipcRenderer.invoke('closure:rebuild-story-index', input) as Promise<StoryRebuildResult>,
  // Story 4.0: trigger the chapter-chain subgraph for an episode (dogfood + test
  // entry; leader write_chapter tool is the agent-side mirror). Loads project,
  // assembles initialArtifacts, dispatches chain, returns RunSnapshot summary.
  runChapterChain: (input: RunChapterChainInput) =>
    ipcRenderer.invoke('closure:run-chapter-chain', input) as Promise<RunChapterChainSummary>,
  // Story 4.3: resume / redo / abort a paused chapter chain via structured IPC
  // (mirror 4.6 PatchReview accept/reject — UI calls directly, not via leader LLM).
  resumeChapterChain: (input: ResumeChapterChainInput) =>
    ipcRenderer.invoke('closure:resume-chapter-chain', input) as Promise<RunChapterChainSummary>,
  // 链流程重排 W4（R6 / 09-13 子3 W6 preload 暴露）：shell handler 在位，此处补渲染层通道——
  // 章卡衍生状态查询（stale 徽标 / 重提取按钮态）+ 链外重提取（盘上正文 standalone E 段）。
  chapterDerivationStatus: (input: { projectPath: string; chapterId?: string }) =>
    ipcRenderer.invoke('closure:chapter-derivation-status', input) as Promise<ChapterDerivationStatusResult>,
  reExtractChapter: (input: { projectPath: string; chapterId: string; autonomy?: 'readonly' | 'suggest' | 'auto' }) =>
    ipcRenderer.invoke('closure:re-extract-chapter', input) as Promise<ReExtractChapterResult>,
  // Story 7.1 Route 1: compile revision intent from selection + instruction
  // (B trigger 选区指挥精修 — UI calls at draft checkpoint pause after user selects a passage).
  compileRevisionIntent: (input: CompileRevisionIntentInput) =>
    ipcRenderer.invoke('closure:compile-revision-intent', input) as Promise<CompileRevisionIntentResult>,
  // Story 2.2 WP-B: persist an accepted setting-md patch (UI diff card accept
  // path — shell re-applies actions against the current settings/<id>.md).
  acceptSettingMdPatch: (input: AcceptSettingMdInput) =>
    ipcRenderer.invoke('closure:accept-setting-md', input) as Promise<AcceptSettingMdResult>,
  // Story 8.6 R4: append an accepted author-profile note (UI diff card accept
  // path — shell appends a dated entry to ~/.orison/author_profile.md against
  // the CURRENT file, append-only so author edits are never clobbered).
  applyAuthorProfileNote: (input: ApplyAuthorProfileNoteInput) =>
    ipcRenderer.invoke('author-profile:apply', input) as Promise<ApplyAuthorProfileNoteResult>,
  // C1.2 llmlint: full-manuscript static scan / LLM contextual classification /
  // author-confirmed mechanical fix application (Lint tab, bottom panel).
  lintScanFull: (input: { projectPath: string }) =>
    ipcRenderer.invoke('lint:scan-full', input) as Promise<LintScanFullResult>,
  lintClassify: (input: { projectPath: string }) =>
    ipcRenderer.invoke('lint:classify', input) as Promise<LintClassifyResult>,
  lintApplyFix: (input: { projectPath: string; patches: LintFixPatch[] }) =>
    ipcRenderer.invoke('lint:apply-fix', input) as Promise<LintApplyFixResult>,
  // C1.2 CR-014: judge-model resolvability probe (review-judge slot + default-sentinel
  // auto-pick — the SAME resolution chain lint:classify uses; pure config, no network).
  lintModelProbe: () =>
    ipcRenderer.invoke('lint:model-probe') as Promise<LintModelProbeResult>,
  // Story-sync 桥（renderer -> desktop main 调 LLM 提补丁）
  runStorySync: (payload: RunStorySyncPayload) =>
    ipcRenderer.invoke('storySync:run', payload) as Promise<RunStorySyncResult>,
  loadUserPreferences: () =>
    ipcRenderer.invoke('config:load-user-preferences') as Promise<UserPreferencesConfig>,
  saveUserPreferences: (config: UserPreferencesConfig) =>
    ipcRenderer.invoke('config:save-user-preferences', config) as Promise<void>,
  listImportedFonts: () =>
    ipcRenderer.invoke('config:list-imported-fonts') as Promise<ImportedFont[]>,
  importFonts: () => ipcRenderer.invoke('config:import-fonts') as Promise<ImportedFont[]>,
  importWallpaper: () =>
    ipcRenderer.invoke('config:import-wallpaper') as Promise<{ url: string } | null>,
  clearWallpaper: () => ipcRenderer.invoke('config:clear-wallpaper') as Promise<void>,
  showItemInFolder: (fullPath: string) => ipcRenderer.send('shell:show-item-in-folder', fullPath),
  openPath: (fullPath: string) => ipcRenderer.send('shell:open-path', fullPath),
  openExternal: (url: string) => ipcRenderer.send('shell:open-external', url),
  // 文件树操作
  readDirectory: (projectDir: string, maxDepth?: number) =>
    ipcRenderer.invoke('project:read-directory', projectDir, maxDepth),
  deleteEntry: (fullPath: string) =>
    ipcRenderer.invoke('project:delete-entry', fullPath) as Promise<boolean>,
  renameEntry: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('project:rename-entry', oldPath, newPath) as Promise<boolean>,
  createEntry: (fullPath: string, isDir: boolean) =>
    ipcRenderer.invoke('project:create-entry', fullPath, isDir) as Promise<boolean>,
  readFile: (fullPath: string) =>
    ipcRenderer.invoke('project:read-file', fullPath) as Promise<string | null>,
  searchProject: (projectDir: string, query: string, maxResults?: number) =>
    ipcRenderer.invoke('project:search', projectDir, query, maxResults) as Promise<ProjectSearchResult[]>,
  readFileBinary: (fullPath: string) =>
    ipcRenderer.invoke('project:read-file-binary', fullPath) as Promise<{ base64: string; mimeType: string } | null>,
  writeFile: (fullPath: string, content: string) =>
    ipcRenderer.invoke('project:write-file', fullPath, content) as Promise<boolean>,
  wordCount: (projectDir: string) =>
    ipcRenderer.invoke('project:word-count', projectDir) as Promise<number>,
  pathExists: (fullPath: string) =>
    ipcRenderer.invoke('project:path-exists', fullPath) as Promise<boolean>,
  saveBase64Image: (projectDir: string, input: SaveBase64ImageInput) =>
    ipcRenderer.invoke('project:save-base64-image', projectDir, input),
  moveProjectFile: (projectDir: string, fromRelativePath: string, toRelativePath: string) =>
    ipcRenderer.invoke('project:move-file', projectDir, fromRelativePath, toRelativePath) as Promise<string>,
  deleteProjectFile: (projectDir: string, relativePath: string) =>
    ipcRenderer.invoke('project:delete-file', projectDir, relativePath) as Promise<boolean>,
  // Drag-drop import of external OS files into the project tree.
  // 09-01 A1 additive: allowedExtensions 白名单转发（shell 侧强制，非白名单拒收部分成功）。
  importFiles: (projectDir: string, targetRelDir: string, sourcePaths: string[], allowedExtensions?: string[]) =>
    ipcRenderer.invoke('project:import-files', projectDir, targetRelDir, sourcePaths, allowedExtensions) as Promise<string[] | ImportFilesResult>,
  // Resolve the absolute path of a dropped File (Electron 32+ removed File.path)
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  // A 波 09-01：inbox 附件三通道（canonical 契约类型 shared-contracts ipc.ts）。
  // parseInboxDoc：上传进件即预解析（docx/pdf 派生 .md 落盘 + file:changed；txt/md
  // preview-only）；resolveInboxAttachment：挂附件协议（哈希身份 exact/similar/fresh）；
  // storeAttachmentDescription：fresh 描述生成完毕回写 sidecar。
  parseInboxDoc: (input: ParseInboxDocInput) =>
    ipcRenderer.invoke('project:parse-inbox-doc', input) as Promise<ParseInboxDocResult>,
  resolveInboxAttachment: (input: ResolveInboxAttachmentInput) =>
    ipcRenderer.invoke('project:resolve-inbox-attachment', input) as Promise<ResolveInboxAttachmentResult>,
  storeAttachmentDescription: (input: StoreAttachmentDescriptionInput) =>
    ipcRenderer.invoke('project:store-attachment-description', input) as Promise<StoreAttachmentDescriptionResult>,
  // Filesystem watcher for external-change auto-refresh
  watchProject: (projectDir: string) =>
    ipcRenderer.invoke('project:watch', projectDir) as Promise<void>,
  unwatchProject: () => ipcRenderer.invoke('project:unwatch') as Promise<void>,
  ensureProjectRegistration: (input: { projectId?: string; name: string; type: 'novel' | 'script'; localFingerprint: string; path?: string; coverImage?: string }) =>
    ipcRenderer.invoke('project:ensure-registration', input) as Promise<{ projectId: string; name: string; type: string }>,
  listRegisteredProjects: () =>
    ipcRenderer.invoke('project:list-registered') as Promise<RegisteredProject[]>,
  touchProjectRegistration: (input: { localFingerprint: string; coverImage?: string }) =>
    ipcRenderer.invoke('project:touch-registration', input) as Promise<void>,
  duplicateProject: (projectPath: string, name: string) =>
    ipcRenderer.invoke('project:duplicate', projectPath, name) as Promise<ProjectLifecycleResult>,
  renameProject: (projectPath: string, name: string) =>
    ipcRenderer.invoke('project:rename', projectPath, name) as Promise<ProjectLifecycleResult>,
  deleteProject: (projectPath: string) =>
    ipcRenderer.invoke('project:delete', projectPath) as Promise<ProjectLifecycleResult>,
  // Task persistence (SQLite)
  listTasks: (projectId: string, limit?: number) =>
    ipcRenderer.invoke('task:list', projectId, limit) as Promise<TaskRecord[]>,
  upsertTask: (input: TaskUpsertInput) =>
    ipcRenderer.invoke('task:upsert', input) as Promise<void>,
  updateTaskStatus: (taskId: string, status: string, errorMessage?: string) =>
    ipcRenderer.invoke('task:update-status', taskId, status, errorMessage) as Promise<void>,
  deleteTask: (taskId: string) =>
    ipcRenderer.invoke('task:delete', taskId) as Promise<void>,
  // Asset persistence (SQLite)
  listAssets: (projectId: string) =>
    ipcRenderer.invoke('asset:list', projectId) as Promise<AssetRecord[]>,
  upsertAsset: (input: AssetUpsertInput) =>
    ipcRenderer.invoke('asset:upsert', input) as Promise<void>,
  updateAsset: (projectId: string, assetId: string, fields: Partial<Pick<AssetRecord, 'assetName' | 'assetGroup' | 'summary' | 'assetStatus'>>) =>
    ipcRenderer.invoke('asset:update', projectId, assetId, fields) as Promise<void>,
  deleteAsset: (projectId: string, assetId: string) =>
    ipcRenderer.invoke('asset:delete', projectId, assetId) as Promise<void>,
  importAssets: (projectDir: string, projectId: string) =>
    ipcRenderer.invoke('asset:import-files', projectDir, projectId) as Promise<string[]>,
  // dogfood R2 #92：世界状态面板读面三通道（design v2 三级缩放——L1 总览 / L2 时点切片 / L3 主体
  // 脊柱；载荷契约单源 contracts/world-panel.ts）。纯读 invoke；实时性走 world:changed 推送订阅。
  worldOverview: (input: WorldOverviewRequest) =>
    ipcRenderer.invoke('world:overview', input) as Promise<WorldOverview>,
  worldSliceDetail: (input: WorldSliceDetailRequest) =>
    ipcRenderer.invoke('world:slice-detail', input) as Promise<WorldSliceDetail>,
  worldSubjectDetail: (input: WorldSubjectDetailRequest) =>
    ipcRenderer.invoke('world:subject-detail', input) as Promise<WorldSubjectDetail>,
  // world:changed 推送订阅（world 数据三写入口事务提交后 best-effort 广播）。返回退订函数（mirror
  // onUpdateEvent / onToolEvent 形态）；offWorldChanged 以原 callback 为键退订同一监听器。
  onWorldChanged: (callback: (event: WorldChangedEvent) => void) => {
    // 重复订阅守卫：先摘同 callback 旧 wrapper 再挂新（见上方 worldChangedListeners 注释）。
    const stale = worldChangedListeners.get(callback);
    if (stale) ipcRenderer.removeListener(WORLD_CHANGED_CHANNEL, stale);
    const listener = (_e: unknown, event: WorldChangedEvent) => callback(event);
    worldChangedListeners.set(callback, listener);
    ipcRenderer.on(WORLD_CHANGED_CHANNEL, listener);
    return () => {
      // 只摘本订阅注册的 wrapper；若 callback 此间已被再订阅（map 持新 wrapper，旧 wrapper 已被
      // 上面的守卫摘除），不动新 wrapper。
      if (worldChangedListeners.get(callback) === listener) {
        ipcRenderer.removeListener(WORLD_CHANGED_CHANNEL, listener);
        worldChangedListeners.delete(callback);
      }
    };
  },
  offWorldChanged: (callback: (event: WorldChangedEvent) => void) => {
    const listener = worldChangedListeners.get(callback);
    if (listener) {
      ipcRenderer.removeListener(WORLD_CHANGED_CHANNEL, listener);
      worldChangedListeners.delete(callback);
    }
  },
  // ── Story 10.1 Wave D：材料库管理面（六 invoke + material:changed 推送订阅）──
  listMaterials: (input: MaterialsListInput) =>
    ipcRenderer.invoke('materials:list', input) as Promise<MaterialSummary[]>,
  getMaterial: (input: { materialId: string }) =>
    ipcRenderer.invoke('materials:get', input) as Promise<MaterialDetail | null>,
  deleteMaterial: (input: { materialId: string }) =>
    ipcRenderer.invoke('materials:delete', input) as Promise<MaterialDeleteResult>,
  reingestMaterial: (input: { materialId: string }) =>
    ipcRenderer.invoke('materials:reingest', input) as Promise<MaterialReingestResult>,
  importMaterials: (input: MaterialsImportInput) =>
    ipcRenderer.invoke('materials:import', input) as Promise<MaterialsImportResult>,
  updateMaterialProvenance: (input: MaterialProvenancePatchInput) =>
    ipcRenderer.invoke('materials:update-provenance', input) as Promise<MaterialProvenancePatchResult>,
  // E10.2a（design §3.1）：材料显示名（视频标题）编辑——name 列 display 面，materialId 路径
  // 身份不变；落库后 material:changed（reason='name-updated'）驱动列表名刷新。
  updateMaterialName: (input: MaterialUpdateNameInput) =>
    ipcRenderer.invoke('materials:update-name', input) as Promise<MaterialUpdateNameResult>,
  // material:changed 推送订阅（材料变更全窗广播，mirror onToolEvent 订阅纪律——返回退订
  // 函数只移除本监听器注册的 listener，绝不 removeAllListeners）。
  onMaterialChanged: (callback: (event: MaterialChangedEvent) => void) => {
    const listener = (_e: unknown, event: MaterialChangedEvent) => callback(event);
    ipcRenderer.on(MATERIAL_CHANGED_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(MATERIAL_CHANGED_CHANNEL, listener); };
  },
  // ── E10.2b（task 09-05）W3：蒸馏管线（两 invoke——craft:distill-progress 订阅面归 W5.5 UI 事件刷新）──
  // 批量入队蒸馏（后台执行；跳过项逐份回报原因；相位/终态经 craft:distill-progress 推送）。
  craftDistillRun: (input: CraftDistillRunInput) =>
    ipcRenderer.invoke('craft:distill-run', input) as Promise<CraftDistillRunResult>,
  // 材料蒸馏台账查询（省略 materialIds = 全部行——材料页/手艺页徽章取数面）。
  craftDistillStatus: (input: CraftDistillStatusInput) =>
    ipcRenderer.invoke('craft:distill-status', input) as Promise<CraftDistillLedger[]>,
  // ── E10.2b（task 09-05）W5：手艺卡人审面（九 invoke——队列/卡编辑/并排对比/词表视图）──
  // 手艺卡队列（过滤 AND 组合 + tags OR + 置信排序；返回摘要行——teachings 剥离投影）。
  craftCardList: (input: CraftCardListInput) =>
    ipcRenderer.invoke('craft:card-list', input) as Promise<CraftCardSummary[]>,
  // 取整卡（claim 四件套全文 + 讲法数组；未知 id → null）。
  craftCardGet: (input: { cardId: string }) =>
    ipcRenderer.invoke('craft:card-get', input) as Promise<CraftCard | null>,
  // 卡内容编辑（编辑即降级执行点——verified 卡 patch 后回 pending_review）。
  craftCardPatch: (input: CraftCardPatchInput) =>
    ipcRenderer.invoke('craft:card-patch', input) as Promise<CraftCardPatchResult>,
  // 人审状态机动作（verify/reject/recover）+ 讲法级 rank 改。
  craftCardReview: (input: CraftCardReviewInput) =>
    ipcRenderer.invoke('craft:card-review', input) as Promise<CraftCardReviewResult>,
  // 并排任务队列（默认仅待审；includeResolved 含已裁决审计回看）。
  craftMergeReviewList: (input: CraftMergeReviewListInput) =>
    ipcRenderer.invoke('craft:merge-review-list', input) as Promise<CraftMergeReview[]>,
  // 三动作裁决（merge/independent/dismiss；已裁决再 resolve = invalid-state）。
  craftMergeReviewResolve: (input: CraftMergeReviewResolveInput) =>
    ipcRenderer.invoke('craft:merge-review-resolve', input) as Promise<CraftMergeReviewResolveResult>,
  // 词目清单（UI 补全 chips / 待并词表视图；含 pending）。
  craftTermList: (input: CraftTermListInput) =>
    ipcRenderer.invoke('craft:term-list', input) as Promise<CraftTerm[]>,
  // 核准待并词目（pending → active）。
  craftTermApprove: (input: { termId: string }) =>
    ipcRenderer.invoke('craft:term-approve', input) as Promise<CraftTermApproveResult>,
  // 归并词目（卡改挂 + category 跟随；movedCardCount = 改挂卡数）。
  craftTermMerge: (input: CraftTermMergeInput) =>
    ipcRenderer.invoke('craft:term-merge', input) as Promise<CraftTermMergeResult>,
  // W5.5 合流缝补：蒸馏进度订阅（mirror onMaterialChanged 形态——channel 常量深导入 zod-free
  // 叶子，返回退订函数；UI craftSlice 事件刷新三件套消费）。
  onCraftDistillProgress: (callback: (event: CraftDistillProgressEvent) => void) => {
    const listener = (_e: unknown, event: CraftDistillProgressEvent) => callback(event);
    ipcRenderer.on(CRAFT_DISTILL_PROGRESS_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(CRAFT_DISTILL_PROGRESS_CHANNEL, listener); };
  },
  // ── E10.3a（task 09-05）W6：拆解管线控制面（七 invoke + decon:progress 订阅——拆书页 UI 归 child B）──
  // 创建拆解会话（P0 落库——材料就绪门 + 在途守卫 + 双指纹快照 + P1 继承；回执带成本预估）。
  deconCreate: (input: DeconCreateInput) =>
    ipcRenderer.invoke('decon:create', input) as Promise<DeconCreateResult>,
  // 启动/续跑（后台执行即回；capped 续跑的调预算面在 budget 字段；进度经 decon:progress 推送）。
  deconStart: (input: DeconStartInput) =>
    ipcRenderer.invoke('decon:start', input) as Promise<DeconStartResult>,
  // 暂停（优雅中断——章边界感知停，断点行保留）。
  deconPause: (input: DeconJobIdInput) =>
    ipcRenderer.invoke('decon:pause', input) as Promise<DeconTransitionResult>,
  // 取消（终态；重拆走新 job）。
  deconCancel: (input: DeconJobIdInput) =>
    ipcRenderer.invoke('decon:cancel', input) as Promise<DeconTransitionResult>,
  // 删除会话（job + pass_state + canon per-job 级联；事实层三表材料级保留）。
  deconDelete: (input: DeconJobIdInput) =>
    ipcRenderer.invoke('decon:delete', input) as Promise<DeconDeleteResult>,
  // 会话详情（人审取数面：断点行 + canon 六域 + 词典 + 实体；stale 时产物面为空）。
  deconGet: (input: DeconJobIdInput) =>
    ipcRenderer.invoke('decon:get', input) as Promise<DeconJobDetail | null>,
  // 会话清单（省略 materialId = 全部）。
  deconList: (input: DeconListInput) =>
    ipcRenderer.invoke('decon:list', input) as Promise<DeconJob[]>,
  // 人审闸门确认（decon:approve-review——pending → approved 后经 start 续跑，台账零重付）。
  deconApproveReview: (input: DeconApproveReviewInput) =>
    ipcRenderer.invoke('decon:approve-review', input) as Promise<DeconApproveReviewResult>,
  // product 读面（decon:products——craft 闸门卡/产出阅读取数；stale freshness 门同 get 纪律）。
  deconProducts: (input: DeconProductsInput) =>
    ipcRenderer.invoke('decon:products', input) as Promise<DeconProductsResult>,
  // report 读面（decon:reports——列表只回 meta；带 kind+unit 单取全文）。
  deconReports: (input: DeconReportsInput) =>
    ipcRenderer.invoke('decon:reports', input) as Promise<DeconReportsResult>,
  // 风格卡导出（decon:export-style——p4:style payload 合并写目标项目 settings/style.md）。
  deconExportStyle: (input: DeconExportStyleInput) =>
    ipcRenderer.invoke('decon:export-style', input) as Promise<DeconExportStyleResult>,
  // stale 确认重跑（decon:confirm-rerun——刷新双指纹 + 复位派生产物后自动 start 续跑）。
  deconConfirmRerun: (input: DeconConfirmRerunInput) =>
    ipcRenderer.invoke('decon:confirm-rerun', input) as Promise<DeconConfirmRerunResult>,
  // 拆解进度订阅（mirror onCraftDistillProgress 形态——channel 常量深导入 zod-free 叶子，
  // 返回退订函数只移除本监听器；事件 best-effort 可丢，读侧兜底 decon:get）。
  onDeconProgress: (callback: (event: DeconProgressEvent) => void) => {
    const listener = (_e: unknown, event: DeconProgressEvent) => callback(event);
    ipcRenderer.on(DECON_PROGRESS_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(DECON_PROGRESS_CHANNEL, listener); };
  },
  // Logging
  openLogsDir: () => ipcRenderer.invoke('log:open-dir') as Promise<string>,
  writeLog: (payload: { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string; meta?: Record<string, unknown> }) =>
    ipcRenderer.invoke('log:write', payload) as Promise<void>,
  getAppVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  checkForUpdate: () => ipcRenderer.invoke('update:check') as Promise<UpdateCheckResult>,
  downloadUpdate: () => ipcRenderer.invoke('update:download') as Promise<void>,
  installUpdate: () => ipcRenderer.invoke('update:install') as Promise<void>,
  onUpdateEvent: (callback: (event: UpdateEvent) => void) => {
    const listener = (_e: unknown, event: UpdateEvent) => callback(event);
    ipcRenderer.on('update:event', listener);
    return () => { ipcRenderer.removeListener('update:event', listener); };
  },
  gitIsRepo: (dir: string) => ipcRenderer.invoke('git:is-repo', dir) as Promise<boolean>,
  gitInit: (dir: string) => ipcRenderer.invoke('git:init', dir) as Promise<{ initialized: boolean }>,
  gitLog: (dir: string, depth?: number) => ipcRenderer.invoke('git:log', dir, depth) as Promise<GitCommitEntry[]>,
  gitCommitDiff: (dir: string, oid: string) => ipcRenderer.invoke('git:commit-diff', dir, oid) as Promise<GitFileDiff[]>,
  gitFileAtCommit: (dir: string, oid: string, filepath: string) => ipcRenderer.invoke('git:file-at-commit', dir, oid, filepath) as Promise<string | null>,
  gitCreateNode: (dir: string, message: string, tag?: string) => ipcRenderer.invoke('git:create-node', dir, message, tag) as Promise<{ oid: string }>,
  gitListBranches: (dir: string) => ipcRenderer.invoke('git:list-branches', dir) as Promise<string[]>,
  gitCurrentBranch: (dir: string) => ipcRenderer.invoke('git:current-branch', dir) as Promise<string>,
  gitCreateBranch: (dir: string, name: string, fromOid?: string) => ipcRenderer.invoke('git:create-branch', dir, name, fromOid) as Promise<void>,
  gitCheckoutBranch: (dir: string, name: string) => ipcRenderer.invoke('git:checkout-branch', dir, name) as Promise<void>,
  gitRestoreVersion: (dir: string, oid: string, message: string) => ipcRenderer.invoke('git:restore-version', dir, oid, message) as Promise<{ oid: string }>,
  gitStatusCount: (dir: string) => ipcRenderer.invoke('git:status-count', dir) as Promise<number>,
  // Tool event notifications (pushed from Shell when Agent executes tools)
  onToolEvent: (callback: (data: { type: string; [key: string]: unknown }) => void) => {
    const listener = (_e: unknown, data: { type: string; [key: string]: unknown }) => callback(data);
    ipcRenderer.on('tool:event', listener);
    // Scoped removal: removeAllListeners would also kill any other subscriber on
    // this channel. Remove only the listener this subscription registered.
    return () => { ipcRenderer.removeListener('tool:event', listener); };
  },
  // Agent
  createAgentSession: (input: { agentName: string; projectPath: string; mode?: 'readonly' | 'suggest' | 'auto'; behaviorMode?: 'normal' | 'discuss' | 'plan'; participationGear?: 'smart' | 'steer' | 'balanced' | 'hands_off' }) =>
    ipcRenderer.invoke('agent:create-session', input),
  getAgentSession: (id: string, projectPath?: string) =>
    ipcRenderer.invoke('agent:get-session', id, projectPath),
  setAgentSessionMode: (sessionId: string, projectPath: string | undefined, mode: 'readonly' | 'suggest' | 'auto') =>
    ipcRenderer.invoke('agent:set-session-mode', sessionId, projectPath, mode),
  setAgentSessionBehaviorMode: (sessionId: string, projectPath: string | undefined, behaviorMode: 'normal' | 'discuss' | 'plan') =>
    ipcRenderer.invoke('agent:set-session-behavior-mode', sessionId, projectPath, behaviorMode),
  setAgentSessionParticipationGear: (
    sessionId: string,
    projectPath: string | undefined,
    gear: 'smart' | 'steer' | 'balanced' | 'hands_off',
    options?: { balancedAskCategories?: ('protagonist_safety' | 'information_gap' | 'direction_turn')[]; trustAdjudication?: boolean },
  ) =>
    ipcRenderer.invoke('agent:set-session-participation-gear', sessionId, projectPath, gear, options),
  listAgentSessions: (projectPath?: string) =>
    ipcRenderer.invoke('agent:list-sessions', projectPath),
  deleteAgentSession: (id: string, projectPath?: string) =>
    ipcRenderer.invoke('agent:delete-session', id, projectPath),
  // 从此截断（dogfood 2026-08-21）：纯对话尾巴专用——含工具痕迹的区间 runtime 拒绝。
  truncateAgentSession: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke('agent:truncate-session', sessionId, messageId) as Promise<
      { ok: true; removed: number } | { ok: false; reason: 'not-found' | 'running' | 'tool-activity' }
    >,
  streamAgentMessage: (input: { sessionId: string; content: string; attachments?: unknown[] }) =>
    ipcRenderer.invoke('agent:stream-message', input),
  onAgentStreamEvent: (callback: (event: { type: string; data: unknown }) => void) => {
    const listener = (_e: unknown, event: { type: string; data: unknown }) => callback(event);
    ipcRenderer.on('agent:stream-event', listener);
    return () => { ipcRenderer.removeListener('agent:stream-event', listener); };
  },
  // 09-01 CR-003a（决议 a）：识图转述进度订阅（shell agentIpc 全窗 webContents.send 广播，
  // 多图串行转述全程可见）。形态 mirror onUpdateEvent / onToolEvent——返回退订函数，只移除
  // 本监听器注册的 listener，绝不 removeAllListeners。
  onImageRelayProgress: (callback: (progress: { current: number; total: number }) => void) => {
    const listener = (_e: unknown, progress: { current: number; total: number }) => callback(progress);
    ipcRenderer.on('image-relay-progress', listener);
    return () => { ipcRenderer.removeListener('image-relay-progress', listener); };
  },
  resolveAgentConfirmation: (sessionId: string, callId: string, approved: boolean) =>
    ipcRenderer.invoke('agent:resolve-confirmation', sessionId, callId, approved),
  listAgentSkills: (projectPath: string) =>
    ipcRenderer.invoke('agent:list-skills', projectPath),
  executeAgentSkill: (sessionId: string, skillName: string, request?: unknown) =>
    ipcRenderer.invoke('agent:execute-skill', sessionId, skillName, request),
  listAgentContinuations: (sessionId: string) =>
    ipcRenderer.invoke('agent:list-continuations', sessionId),
  restoreAgentContinuation: (sessionId: string, continuationId: string) =>
    ipcRenderer.invoke('agent:restore-continuation', sessionId, continuationId),
  abortAgentRun: (sessionId: string) =>
    ipcRenderer.invoke('agent:abort-run', sessionId),
  // Manual context-compaction trigger (redline/overflow auto-triggers live in
  // the runtime; this is the user-initiated path).
  compactAgentSession: (sessionId: string) =>
    ipcRenderer.invoke('agent:compact-session', sessionId) as Promise<boolean>,
  // Skill package management
  listSkillPackages: (projectPath?: string) =>
    ipcRenderer.invoke('agent:list-skill-packages', projectPath),
  setPackageEnabled: (packageName: string, enabled: boolean) =>
    ipcRenderer.invoke('agent:set-package-enabled', packageName, enabled),
  setSkillEnabled: (packageName: string, skillName: string, enabled: boolean) =>
    ipcRenderer.invoke('agent:set-skill-enabled', packageName, skillName, enabled),
  // Window lifecycle
  onBeforeClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('app:before-close', listener);
    return () => { ipcRenderer.removeListener('app:before-close', listener); };
  },
  confirmClose: () => ipcRenderer.send('app:close-confirmed'),
} satisfies OrisonDesktopApi;

contextBridge.exposeInMainWorld('orisonDesktop', exposedDesktopApi);

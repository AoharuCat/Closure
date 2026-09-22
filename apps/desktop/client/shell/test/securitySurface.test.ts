import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}));

import { exposedDesktopApi } from '../preload/index';

describe('preload security surface', () => {
  it('only exposes the whitelisted desktop api', () => {
    expect(Object.keys(exposedDesktopApi).sort()).toEqual([
      'abortAgentRun',
      'acceptSettingMdPatch',
      // 子4 agy MCP 工具桥（W4）：同意/状态/关闭回收三通道。
      'agyBridgeRevoke',
      'agyBridgeSetConsent',
      'agyBridgeStatus',
      // 09-19 CLI 白名单（W3）：Closure 文本 Agent 状态面三通道。
      'agyTextAgentDisable',
      'agyTextAgentEnable',
      'agyTextAgentStatus',
      'applyAgentFieldPatch',
      'applyAuthorProfileNote',
      // C3.2 W2 多套预设：任务档预设四通道（taskPresets:list/save/apply/delete）。
      'applyTaskPreset',
      'canaryProbeVision',
      // 拆书链：章标派生状态读 + 失败章重取（closureChain 两 invoke）。
      'chapterDerivationStatus',
      'checkForUpdate',
      'clearWallpaper',
      // 09-19 dogfood R4：CLI 凭据探针两通道（读最近结果 / 手动重测）。
      'cliProbeRun',
      'cliProbeStatus',
      'close',
      'compactAgentSession',
      'compileRevisionIntent',
      'confirmClose',
      'copyCoverImage',
      // E10.2b（task 09-05）W3：蒸馏管线两通道（craft:distill-run/status）。
      'craftCardGet',
      'craftCardList',
      'craftCardPatch',
      'craftCardReview',
      'craftDistillRun',
      'craftDistillStatus',
      // W5：手艺卡人审面九通道（card/term/merge-review——本注释块与上行 W3 同族）。
      'craftMergeReviewList',
      'craftMergeReviewResolve',
      'craftTermApprove',
      'craftTermList',
      'craftTermMerge',
      'createAgentSession',
      'createEntry',
      'createProjectDirectory',
      // E10.3a（task 09-05）W6：拆解管线控制面（decon:* 七 invoke）+ E10.3b W3b 闸门确认 +
      // W5 读面/风格导出（products/reports/export-style）+ W7 小补③ stale 确认重跑。
      'deconApproveReview',
      'deconCancel',
      'deconConfirmRerun',
      'deconCreate',
      'deconDelete',
      'deconExportStyle',
      'deconGet',
      'deconList',
      'deconPause',
      'deconProducts',
      'deconReports',
      'deconStart',
      'deleteAgentSession',
      'deleteAsset',
      'deleteEntry',
      // Story 10.1 Wave D：材料库管理面（materials:delete 等）。
      'deleteMaterial',
      'deleteProject',
      'deleteProjectFile',
      'deleteTask',
      'deleteTaskPreset',
      'docxToHtml',
      'docxToMarkdown',
      'downloadUpdate',
      'duplicateProject',
      'ensureProjectDocument',
      'ensureProjectRegistration',
      'executeAgentSkill',
      'generateEmbedding',
      'generateImage',
      'generateText',
      'getAgentSession',
      'getAppVersion',
      'getIndexStatus',
      'getLocale',
      // Story 10.1 Wave D：材料库管理面。
      'getMaterial',
      'gitCheckoutBranch',
      'gitCommitDiff',
      'gitCreateBranch',
      'gitCreateNode',
      'gitCurrentBranch',
      'gitFileAtCommit',
      'gitInit',
      'gitIsRepo',
      'gitListBranches',
      'gitLog',
      'gitRestoreVersion',
      'gitStatusCount',
      'importAssets',
      'importDocx',
      'importFiles',
      'importFonts',
      // Story 10.1 Wave D：材料库管理面。
      'importMaterials',
      // E10.4 W1：在线解析生态（URL 直贴导入——shell handler W1 占位、W2 落实现）。
      'importOnlineMaterial',
      'importWallpaper',
      'installUpdate',
      'isKeyEncryptionAvailable',
      'isMaximized',
      // C1.2 llmlint：三 lint 通道（scan-full / classify / apply-fix）+ 判档探测（CR-014）。
      'lintApplyFix',
      'lintClassify',
      'lintModelProbe',
      'lintScanFull',
      // W4（09-21-subagent-bg-decouple）：后台任务注册表只读查询（`agent:bg-tasks`）。
      'listAgentBgTasks',
      'listAgentContinuations',
      'listAgentSessions',
      'listAgentSkills',
      'listAssets',
      // 09-12 agy provider W4：CLI 形态模型发现（model:list-cli-models）。
      'listCliModels',
      'listImportedFonts',
      // Story 10.1 Wave D：材料库管理面。
      'listMaterials',
      'listRegisteredProjects',
      'listRemoteModels',
      'listSkillPackages',
      'listTaskPresets',
      'listTasks',
      'loadModelConfig',
      'loadProjectDocument',
      'loadProjectMeta',
      'loadResearchConfig',
      'loadUserPreferences',
      'maximize',
      'minimize',
      'moveProjectFile',
      // dogfood R2 #92：世界状态面板读面（三 invoke + world:changed 订阅/退订）。
      'offWorldChanged',
      'onAgentStreamEvent',
      'onBeforeClose',
      // E10.2b W5.5：蒸馏进度推送订阅（craft:distill-progress）。
      'onCraftDistillProgress',
      // E10.3a（task 09-05）W6：拆解进度推送订阅（decon:progress）。
      'onDeconProgress',
      // 09-01 CR-003a：识图转述进度推送订阅（image-relay-progress）。
      'onImageRelayProgress',
      // Story 10.1 Wave D：材料变更推送订阅（material:changed）。
      'onMaterialChanged',
      'onToolEvent',
      'onUpdateEvent',
      'onWorldChanged',
      'openExternal',
      'openLogsDir',
      'openPath',
      // A 波 09-01：inbox 附件三通道（parse / resolve / description 回写）。
      'parseInboxDoc',
      'pathExists',
      'pathForFile',
      'pickCoverImage',
      'pickProjectDirectory',
      'platform',
      'probeResearchDocParser',
      'reExtractChapter',
      'readDirectory',
      'readFile',
      'readFileBinary',
      'rebuildCraftKb',
      'rebuildStoryIndex',
      // Story 10.1 Wave D：材料库管理面。
      'reingestMaterial',
      'renameEntry',
      'renameProject',
      'rerank',
      'resolveAgentConfirmation',
      'resolveInboxAttachment',
      'restoreAgentContinuation',
      'resumeChapterChain',
      'runChapterChain',
      'runStorySync',
      'saveBase64Image',
      'saveModelConfig',
      'saveProjectMeta',
      'saveResearchConfig',
      'saveTaskPreset',
      'saveUserPreferences',
      // E10.4 W1：在线解析生态（关键词发现——shell handler W1 占位、W2 落实现）。
      'searchOnlineSources',
      'searchProject',
      'setAgentSessionBehaviorMode',
      'setAgentSessionMode',
      'setAgentSessionParticipationGear',
      'setPackageEnabled',
      'setSkillEnabled',
      'showItemInFolder',
      'storeAttachmentDescription',
      'streamAgentMessage',
      'syncChaptersMeta',
      'syncField',
      'syncProjectMeta',
      'toggleFieldLock',
      'touchProjectRegistration',
      'truncateAgentSession',
      'unwatchProject',
      'updateAsset',
      // Story 10.1 Wave D：材料库管理面（E10.2a += update-name）。
      'updateMaterialName',
      'updateMaterialProvenance',
      'updateTaskStatus',
      'upsertAsset',
      'upsertTask',
      // 09-12 usage-panel（子5 W3）：应用内用量面两通道（usage:overview / usage:clear）。
      'usageClear',
      'usageOverview',
      'watchProject',
      'wordCount',
      'worldOverview',
      'worldSliceDetail',
      'worldSubjectDetail',
      'writeFile',
      'writeLog',
    ]);
  });

  it('does not expose any apiKey-bearing function on the renderer surface', () => {
    // The whitelisted IPC handlers move slot pairs (profileId, modelId) across
    // IPC; apiKey lives in desktop main's safeStorage and is decrypted only
    // there. Renderer never sees it.
    const apiKeys = Object.keys(exposedDesktopApi).filter((key) => /apiKey/i.test(key));
    expect(apiKeys).toEqual([]);
  });
});

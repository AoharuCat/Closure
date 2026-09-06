import { ipcMain, BrowserWindow } from 'electron';
import {
  createWorkflowRuntime,
  setGenerateTextFn,
  setTaskSlotResolver,
  setContextPolicyProvider,
  setExecuteToolFn,
  registerBuiltinTools,
  listSkillPackages,
  setPackageEnabled,
  setSkillEnabled,
  updateSessionStatus,
  type WorkflowRuntime,
  type CreateSessionInput,
  type ExecuteSkillRequest,
  type GenerateTextFn,
  type ExecuteToolFn,
} from '@orison/desktop-agent';
import { handleGenerateText, handleGenerateTextStream, resolveModel } from './modelGatewayIpc';
import { installAgentImagePartsCore } from './agentImageParts';
import { prepareVisionImage } from '../research/visionAnalysis';
import { readModelConfigFromDisk, readTaskModelSlots, readUserPreferencesFromDisk } from './configIpc';
import { handleToolExecute } from './toolExecution';
import { normalizeProjectKey } from './pathGuard';
import { getLogger } from '../logger';
import { resolveModelInfo } from '@orison/shared-contracts';

const logger = getLogger();

let runtime: WorkflowRuntime;

/**
 * Story 4.0：expose the singleton agent runtime so co-registered dogfood IPC
 * (closure:run-chapter-chain) can call `runChapterChain` without re-creating it.
 * Lazily resolved inside handler invocation — registerAgentIpc runs before any
 * invoke (registerAllIpc order), so the runtime is initialised by then.
 */
export function getAgentRuntime(): WorkflowRuntime {
  if (!runtime) {
    throw new Error('agent runtime not initialised — registerAgentIpc must run first');
  }
  return runtime;
}

/**
 * In-flight stream abort controllers, keyed by sessionId, for agent:abort-run.
 *
 * dogfood T1 CR-T1-022：值是 **Set**（同 session 重叠 invoke 各持一个 controller）——旧单槽
 * `Map<sessionId, AbortController>` 在第二次 invoke 时覆盖、先退者 delete，幸存 run 失 abort
 * 通道。abort-run abort 全部；finally 只删自己的那个（空集才删键——启动对账的
 * `has(sessionId)`「活跃流」判据语义不变：非空集 = 活跃）。
 */
const streamAbortControllers = new Map<string, Set<AbortController>>();

function registerStreamAbortController(sessionId: string, controller: AbortController): void {
  const set = streamAbortControllers.get(sessionId);
  if (set) set.add(controller);
  else streamAbortControllers.set(sessionId, new Set([controller]));
}

function unregisterStreamAbortController(sessionId: string, controller: AbortController): void {
  const set = streamAbortControllers.get(sessionId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) streamAbortControllers.delete(sessionId);
}

// ─── dogfood T1 Stage 3（design §5.4 D4）：per-project 单 run 注册表 ───
//
// 同项目同时只允许一个 run（两会话同项目 run 竞争 project.yaml/章节文件/git 提交 +
// 渲染层键控前的单槽互顶雷区）；跨项目自由并行。key = normalizeProjectKey(projectPath)
// （pathGuard 同款 resolve + win32 大小写归一——防 `C:\a` / `c:/a/` 双 key 漏闸）。
// 闸点 = agent:stream-message + closureChainIpc 两链 IPC 入口 + agent:execute-skill（子
// agent 派发经父 run 同项目，不另拦）+ agent:compact-session（手动压缩也发 LLM 摘要调用，
// trellis-check 补接——占用时 false + warn 而非结构化 rejected，布尔契约通道）；**释放 =
// 各入口 handler 的 finally（经 acquire 返回的 handle.release）**。注册表纯内存——崩溃后
// 随进程消亡，无持久锁死。
//
// dogfood T1 CR-T1-012/021（租约引用计数）：旧「同 sessionId 即放行 + release 按
// sessionId 整键删除」两缺陷——① 同 session 重叠 invoke（cancelAgent 后立刻重发 /
// write_chapter paused → resume 与 leader 收尾并发）先退者的 finally 会释放后者的租约；
// ② runState.beginRun 抛错路的 finally 仍释放第一路租约。现改为 **handle 记账**：
// acquire 返 `{ok:true, release}`，内部按 (projectKey, leaseId) 引用计数；同 sessionId
// 重入 refCount+1；release 幂等只衰减一次，归零才真删键。调用方一律 `finally { release() }`，
// 不再持 sessionId 二次释放。

type ProjectRunLease = { sessionId: string; projectPath: string };

type ProjectRunLeaseEntry = {
  lease: ProjectRunLease;
  /** 活跃句柄数（同 sessionId 重叠 invoke 各持一个）——归零才真释放。 */
  refCount: number;
};

const projectActiveRuns = new Map<string, ProjectRunLeaseEntry>();

/**
 * 链 IPC（closure:run-chapter-chain）的租约 id 前缀——dogfood 路径无 leader 会话，stub
 * parent 在 gate 之后才创建（拒绝时不留半成品 session）。CR-T1-020：**每次 invoke 生成
 * 唯一 id**（`${CHAIN_RUN_LEASE_ID}:${uuid}`）——旧常量 id 会让同项目两条并发链第二路
 * 恒放行 + 先完成者 finally 删掉后者租约。前缀保留（`chain-run:closure:`）供 UI 识别
 * 「链占用」形态（toast 换文案不提供跳转钮——stub 会话不在会话列表，跳转必失败）。
 */
export const CHAIN_RUN_LEASE_ID = 'chain-run:closure';

export type ProjectRunGateResult =
  | { ok: true; release: () => void }
  | { ok: false; held: ProjectRunLease };

/** 无项目归属（不应发生）时的空句柄——不闸，保持既有行为。 */
function noopRelease(): void { /* no-op */ }

export function acquireProjectRun(projectPath: string | undefined, sessionId: string): ProjectRunGateResult {
  if (!projectPath) return { ok: true, release: noopRelease };
  const key = normalizeProjectKey(projectPath);
  const entry = projectActiveRuns.get(key);
  if (entry && entry.lease.sessionId !== sessionId) {
    return { ok: false, held: entry.lease };
  }
  if (entry) entry.refCount += 1;
  else projectActiveRuns.set(key, { lease: { sessionId, projectPath }, refCount: 1 });
  let released = false;
  return {
    ok: true,
    // CR-T1-021：句柄幂等（双 finally / 手滑双调不二次衰减）+ 只衰减自己那一份。
    release: () => {
      if (released) return;
      released = true;
      const current = projectActiveRuns.get(key);
      if (!current || current.lease.sessionId !== sessionId) return;
      current.refCount -= 1;
      if (current.refCount <= 0) projectActiveRuns.delete(key);
    },
  };
}

/**
 * 诊断/测试：强制释放某项目键上该会话的**全部**引用（整键删除）。正常路径一律走
 * `acquire().release`——本函数只用于测试复位与对账兜底。
 */
export function releaseProjectRun(projectPath: string | undefined, sessionId: string): void {
  if (!projectPath) return;
  const key = normalizeProjectKey(projectPath);
  const entry = projectActiveRuns.get(key);
  if (entry && entry.lease.sessionId === sessionId) {
    projectActiveRuns.delete(key);
  }
}

/** 测试/诊断：当前注册表快照（只读；值为 {lease, refCount} 结构）。 */
export function getProjectActiveRuns(): ReadonlyMap<string, ProjectRunLeaseEntry> {
  return projectActiveRuns;
}

/**
 * D4 启动对账：注册表在内存（启动恒空，无持久锁死）；磁盘 status='running' 的崩溃残留
 * 会话会让 runtime 的 mode-setter 永拒（`session.status === 'running'` guard）+ UI 磁盘
 * 兜底误显运行——逐项目核对归位 idle 并清非活跃注册表项。registerAgentIpc 时异步跑
 * （vitest 环境跳过——测试直调本函数驱动，避免测试进程触真实 machine db）。
 */
export async function reconcileStaleProjectRuns(): Promise<void> {
  try {
    const { listProjects } = await import('../db/projectRepository');
    const projects = listProjects().filter((p) => p.path && !p.deletedAt);
    for (const project of projects) {
      const sessions = runtime.listSessions(project.path!).sessions;
      for (const s of sessions) {
        if (s.status !== 'running') continue;
        if (streamAbortControllers.has(s.id)) continue; // 本进程活跃流（直调场景）
        const live = runtime.getSession(s.id, project.path!);
        if (live && live.status === 'running') {
          updateSessionStatus(s.id, 'idle');
          logger.info(
            { sessionId: s.id, projectPath: project.path },
            'projectRunGate: stale running session reconciled to idle',
          );
        }
      }
    }
    for (const [key, entry] of [...projectActiveRuns]) {
      if (!streamAbortControllers.has(entry.lease.sessionId)) {
        projectActiveRuns.delete(key);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'projectRunGate: stale-run reconciliation failed (non-fatal)');
  }
}

let registered = false;

export function registerAgentIpc(getWin: () => BrowserWindow | null) {
  // Handlers register once for the app lifetime; a recreated window is resolved
  // lazily via getWin. Re-registering the same channel would throw.
  if (registered) {
    return;
  }
  registered = true;

  // Dogfood T1 Stage 1（流式缝）：按 callbacks 有无分派。只有显式传 onDelta 的
  // 调用方走流式路径（generateTextStream）；既有全部调用点（runLoop / 链节点 /
  // summarizer——都不传）原样留在非流式路径，零回归（design §2）。渲染层直调的
  // model:generate-text IPC 维持非流式不动。
  // dogfood R2 #7：body 原样过缝——request.lane（child/链车道 'background'）随 body
  // 进入两 handler，由 modelGatewayIpc 透传到 ProtocolCallContext（车道选窗 240s +
  // 有界回退；缺席 = interactive 60s 红线原样）。
  const generateTextImpl: GenerateTextFn = async (body, abort, callbacks) => {
    const result = callbacks?.onDelta
      ? await handleGenerateTextStream(body as any, abort, callbacks.onDelta)
      : await handleGenerateText(body as any, abort);
    return result as any;
  };
  setGenerateTextFn(generateTextImpl);

  // 09-01 附件 B3（design §2.3）：agentImageParts 防环注入内核装配——prepareImage
  // （visionAnalysis）/ resolveModelRef（modelGatewayIpc）/ readModelConfig（configIpc）
  // 三者都在既有依赖环上，经此处装配（mirror setGenerateTextFn 注入形态；wiring 由
  // agentIpcStreamDispatch.test 钉死）。CR-003a（决议 a）：转述进度广播发射器——mirror
  // notifyUI 的全窗 webContents.send 广播形态，专用通道 'image-relay-progress'、载荷
  // { current, total }（单窗口 app 无需 session 定向）；直传路/缓存全命中不发，UI 消费
  // 面后置按此载荷形态接入。
  installAgentImagePartsCore({
    prepareImage: prepareVisionImage,
    resolveModelRef: resolveModel,
    readModelConfig: readModelConfigFromDisk,
    notifyRelayProgress: (progress) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('image-relay-progress', progress));
    },
  });

  // C3.2 task-model routing: inject the slot resolver next to the generate
  // seam (mirror of setGenerateTextFn — the agent runtime never reads disk
  // config itself). The closure queries readTaskModelSlots per resolve — an
  // mtime+size-gated read (CR-004) whose semantics stay "fresh": a slot change
  // in settings rewrites the sidecar and takes effect on the next dialogue
  // turn / next chain assembly without a restart. A missing/invalid sidecar
  // yields undefined → provider default sentinel → shell auto-pick (the
  // pre-routing path).
  setTaskSlotResolver((slot) => readTaskModelSlots()?.[slot]);

  // S4b（task 08-25 design §4.1，thinking-controls）：压缩红线策略注入——mirror
  // setTaskSlotResolver 的注入形态（agent 运行时按 ADR-2 不读盘，shell 注入现读闭包）。
  // readUserPreferencesFromDisk 每次现读（configIpc 现有读法，无进程级缓存）→ 用户改红线
  // 下一次 send 生效；preferences 缺 contextCompaction 时读路径回默认 95（configIpc 归一）。
  setContextPolicyProvider(() => readUserPreferencesFromDisk().contextCompaction);

  const executeToolImpl: ExecuteToolFn = async (toolId, params, ctx) => {
    return handleToolExecute({
      toolId,
      params: params as Record<string, unknown>,
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      abort: ctx.abort,
    });
  };
  setExecuteToolFn(executeToolImpl);

  registerBuiltinTools();

  // S4b（task 08-25 design §3.2）：runtime 无 stream 车道的方法（manualCompactSession 的
  // compaction 事件）经 onRuntimeEvent 广播——mirror streamMessage 的 sendEvent 形态
  //（agent:stream-event + sessionId/projectPath 附加字段，UI 全局监听同一通道消费）。
  // projectPath 每事件现查（手动压缩低频，getSession 内存 LRU 查询零盘 IO）。
  runtime = createWorkflowRuntime({
    onRuntimeEvent: (sessionId, event) => {
      try {
        const projectPath = runtime.getSession(sessionId)?.projectPath;
        getWin()?.webContents.send('agent:stream-event', { ...event, sessionId, projectPath });
      } catch {
        // Window may have been closed — mirror sendEvent 容错
      }
    },
  });

  // D4 启动对账（design §5.4 补强③）：stale 'running' 归位 idle + 清注册表。测试环境
  // 跳过（reconcileStaleProjectRuns 直调驱动），防 registerAgentIpc 的测试触真实 db。
  if (process.env.NODE_ENV !== 'test') {
    void reconcileStaleProjectRuns();
  }

  // ─── Request/Response handlers ───

  // Use the single shared `runtime` for the whole session lifecycle. Previously
  // create-session built a *separate* runtime carrying externalSkillRoots, while
  // get-session/execute-skill/stream-message used this module-level one — two
  // divergent instances with their own session caches and skill registries, so
  // external skills listed but wouldn't execute. The runtime's listSkills /
  // executeSkillByName / buildRuntimeSystemPrompt already load per-project
  // externalSkillRoots via loadRuntimeConfig, so a single instance suffices.
  ipcMain.handle('agent:create-session', async (_event, input: CreateSessionInput) => {
    return runtime.createSession(input);
  });

  ipcMain.handle('agent:get-session', async (_event, id: string, projectPath?: string) => {
    return runtime.getSession(id, projectPath) ?? null;
  });

  ipcMain.handle('agent:set-session-mode', async (_event, sessionId: string, projectPath: string | undefined, mode: 'readonly' | 'suggest' | 'auto') => {
    const session = runtime.getSession(sessionId, projectPath);
    if (!session) return { ok: false };
    const ok = runtime.setSessionPermissionMode(sessionId, mode);
    return { ok };
  });

  // Story 3.1: set leader runLoop behavior mode (normal/discuss/plan).
  ipcMain.handle('agent:set-session-behavior-mode', async (_event, sessionId: string, projectPath: string | undefined, behaviorMode: 'normal' | 'discuss' | 'plan') => {
    // CR-workbench-interaction-core-003: validate at the IPC boundary — TS
    // annotations are erased at runtime, so without this an invalid/garbage
    // behaviorMode would be persisted to session meta + disk (loadSession only
    // defaults on undefined, not on junk).
    if (behaviorMode !== 'normal' && behaviorMode !== 'discuss' && behaviorMode !== 'plan') {
      return { ok: false };
    }
    const session = runtime.getSession(sessionId, projectPath);
    if (!session) return { ok: false };
    const ok = runtime.setSessionBehaviorMode(sessionId, behaviorMode);
    return { ok };
  });

  // Story 3.5: set leader participation gear (smart/steer/balanced/hands_off) +
  // balanced 档圈类别 / hands_off trustAdjudication。mirror set-session-behavior-mode 的
  // IPC 边界校验（CR-003 教训：TS 注解运行时擦除，垃圾值会持久化到 session meta + 磁盘）。
  // runtime setter 另有第二防线（运行时 enum 校验）。
  // CR-011：空 `[]` 在 IPC/runtime/UI 三处都被拒（mirror zod .min(1)——空数组不属任一状态）。
  ipcMain.handle(
    'agent:set-session-participation-gear',
    async (
      _event,
      sessionId: string,
      projectPath: string | undefined,
      gear: string,
      options?: { balancedAskCategories?: string[]; trustAdjudication?: boolean },
    ) => {
      const VALID_GEARS = ['smart', 'steer', 'balanced', 'hands_off'];
      const VALID_CATEGORIES = ['protagonist_safety', 'information_gap', 'direction_turn'];
      if (typeof gear !== 'string' || !VALID_GEARS.includes(gear)) {
        return { ok: false };
      }
      if (
        options?.balancedAskCategories !== undefined &&
        (!Array.isArray(options.balancedAskCategories) ||
          options.balancedAskCategories.length < 1 ||
          !options.balancedAskCategories.every((c) => typeof c === 'string' && VALID_CATEGORIES.includes(c)))
      ) {
        return { ok: false };
      }
      if (options?.trustAdjudication !== undefined && typeof options.trustAdjudication !== 'boolean') {
        return { ok: false };
      }
      const session = runtime.getSession(sessionId, projectPath);
      if (!session) return { ok: false };
      const ok = runtime.setSessionParticipationGear(
        sessionId,
        gear as 'smart' | 'steer' | 'balanced' | 'hands_off',
        options as { balancedAskCategories?: ('protagonist_safety' | 'information_gap' | 'direction_turn')[]; trustAdjudication?: boolean } | undefined,
      );
      return { ok };
    },
  );

  ipcMain.handle('agent:list-sessions', async (_event, projectPath?: string) => {
    return runtime.listSessions(projectPath);
  });

  ipcMain.handle('agent:delete-session', async (_event, id: string, projectPath?: string) => {
    return runtime.deleteSession(id, projectPath);
  });

  // 从此截断（dogfood 2026-08-21）：丢弃 messageId 及其后全部（内存+JSONL+索引）。
  // 纯对话尾巴闸门在 runtime 内核（session.ts）——含工具痕迹/运行中拒绝。
  ipcMain.handle('agent:truncate-session', async (_event, sessionId: string, messageId: string) => {
    return runtime.truncateSessionFromMessage(sessionId, messageId);
  });

  ipcMain.handle('agent:resolve-confirmation', async (_event, sessionId: string, callId: string, approved: boolean) => {
    return runtime.resolveConfirmation(sessionId, callId, approved);
  });

  ipcMain.handle('agent:list-skills', async (_event, projectPath: string) => {
    return runtime.listSkills(projectPath);
  });

  // dogfood T1 CR-T1-032：第四 run 车道补 D4 同款闸（skill 执行也是同项目 run——与
  // stream-message/链入口共享 projectActiveRuns 注册表，防孤儿键绕闸）。会话缺失时不闸
  // （既有 'session not found' throw 路径不变）。拒绝形态 mirror stream-message 的
  // 结构化拒绝（status:'rejected' + code + 占用者）。
  ipcMain.handle('agent:execute-skill', async (_event, sessionId: string, skillName: string, request?: string | ExecuteSkillRequest) => {
    const session = runtime.getSession(sessionId);
    const gate = session
      ? acquireProjectRun(session.projectPath, sessionId)
      : ({ ok: true as const, release: noopRelease });
    if (!gate.ok) {
      logger.info(
        { projectPath: session?.projectPath, sessionId, heldBy: gate.held.sessionId },
        'agent execute-skill rejected: another run active in this project',
      );
      return {
        status: 'rejected',
        code: 'project_run_active',
        heldBySessionId: gate.held.sessionId,
        projectPath: gate.held.projectPath,
      };
    }
    try {
      return await runtime.executeSkillByName(sessionId, skillName, request);
    } finally {
      gate.release();
    }
  });

  ipcMain.handle('agent:list-continuations', async (_event, sessionId: string) => {
    return runtime.listContinuations(sessionId);
  });

  ipcMain.handle('agent:restore-continuation', async (_event, sessionId: string, continuationId: string) => {
    return runtime.restoreContinuation(sessionId, continuationId);
  });

  ipcMain.handle('agent:abort-run', async (_event, sessionId: string) => {
    // dogfood R2 #105 R2.5：用户显式中断（UI 停止钮）入口留痕——修前服务端 abort 路径全线零日志，
    // 「链为何中断」无从诊断。此行是区分「用户主动停」vs「链被动被掐」的关键证据（只记一行，
    // 其余不动）。
    logger.info({ sessionId }, 'agent:abort-run requested (UI stop)');
    // Abort the IPC-level controllers too, so streamMessage is interrupted even
    // outside the runtime's own run window (defense-in-depth on top of abortRun).
    // CR-T1-022：Set 形态——同 session 重叠 invoke 的全部 controller 一并 abort。
    for (const controller of streamAbortControllers.get(sessionId) ?? []) {
      controller.abort();
    }
    return runtime.abortRun(sessionId);
  });

  // 08-25 上下文压缩三触发之「手动」入口（thinking-controls design §3.2）：leader 工具条
  // 「压缩上下文」按钮 → 本通道 → runtime 侧单次摘要压缩（红线 ② / 顶满 ③ 自动触发在
  // runtime 内部，不经此通道）。
  //
  // 防御式 seam 调用：`manualCompactSession(sessionId, opts?): Promise<boolean>` 由
  // agent 包 S4 落地（CR-005 起 opts.windowTokens = dialogue 档模型 registry 窗口，见下方
  // 调用位），本 handler 先行接线——方法缺位 → false + warn（不 throw，UI 可按
  // false 呈现「不可用」）。命名注记：runtime 既有 legacy 纯函数成员叫 `compactSession`
  // （确定性压缩，返回 CompactedConversation），S4 侧新方法定名 `manualCompactSession`
  // 避开同名冲突——因此这里用 type-erased 访问（方法未落地时 WorkflowRuntime 类型上无此
  // 成员，直接属性访问 typecheck 不过）+ 结果 boolean 守卫防形态漂移。
  //
  // D4 per-project run 闸（trellis-check 发现的漏接车道）：手动压缩发起一次 LLM 摘要调用
  // ——同项目链/流/skill 在途时并发跑压缩违反「同项目同时只允一个 run」不变式。占用 →
  // **false + warn**（本通道契约是布尔（模式 A），不抛 IPC rejection；渲染层拿 false 无从
  // 区分拒绝与不可用，日志是唯一可观测面，故 warn 而非 info）。会话缺失时不闸（seam 自身
  // 的 false 路径覆盖——mirror stream-message / execute-skill）。seam 内部的「同 session
  // running 拒绝」是另一层（idle-only 语义），与本项目级外层闸不冗余。释放 = finally 经
  // acquire 句柄（CR-T1-021 引用计数）。
  ipcMain.handle('agent:compact-session', async (_event, sessionId: string) => {
    const manualCompactSession = (runtime as {
      manualCompactSession?: (sessionId: string, opts?: { windowTokens?: number }) => unknown;
    }).manualCompactSession;
    if (typeof manualCompactSession !== 'function') {
      logger.warn(
        { sessionId },
        'agent compact-session: runtime manualCompactSession not wired up — returning false',
      );
      return false;
    }
    const session = runtime.getSession(sessionId);
    const gate = session
      ? acquireProjectRun(session.projectPath, sessionId)
      : { ok: true as const, release: noopRelease };
    if (!gate.ok) {
      logger.warn(
        { projectPath: session?.projectPath, sessionId, heldBy: gate.held.sessionId },
        'agent compact-session rejected: another run active in this project — returning false',
      );
      return false;
    }
    try {
      // CR-005（08-25 BMad CR）：窗口解析——dialogue 档 assignment（经既有 slot resolver
      // 单源 readTaskModelSlots，与 setTaskSlotResolver 注入闭包同一读口）的 registry
      // limits.contextWindow。无指派 / 未知模型（无 limits）→ 不传（seam 回落缺省目标
      // = 现行为——固定 500K 目标治不了小窗模型，压缩 true 返回后下次请求照样 400）。
      const dialogueAssignment = readTaskModelSlots()?.dialogue;
      const windowTokens = dialogueAssignment
        ? resolveModelInfo(dialogueAssignment.modelId).limits?.contextWindow
        : undefined;
      const result = await manualCompactSession.call(
        runtime,
        sessionId,
        windowTokens !== undefined ? { windowTokens } : undefined,
      );
      if (typeof result !== 'boolean') {
        // Shape-drift guard for the parallel-landing window: whatever the seam
        // returns must be this channel's boolean contract — never leak a wrong
        // payload to the renderer.
        logger.warn(
          { sessionId },
          'agent compact-session: runtime manualCompactSession returned a non-boolean — treating as not wired',
        );
        return false;
      }
      return result;
    } catch (err) {
      // Expected user-visible failures (missing session, compaction refused)
      // come back as `false` per the seam contract; a throw here is a mode-A
      // boundary — surface false + warn rather than an IPC rejection (the
      // renderer button must not error-toast on a normal miss).
      logger.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'agent compact-session: runtime manualCompactSession threw — returning false',
      );
      return false;
    } finally {
      gate.release();
    }
  });

  // ─── Skill package management ───

  ipcMain.handle('agent:list-skill-packages', async (_event, projectPath?: string) => {
    return listSkillPackages(projectPath);
  });

  ipcMain.handle('agent:set-package-enabled', async (_event, packageName: string, enabled: boolean) => {
    await setPackageEnabled(packageName, enabled);
    return { ok: true };
  });

  ipcMain.handle('agent:set-skill-enabled', async (_event, packageName: string, skillName: string, enabled: boolean) => {
    await setSkillEnabled(packageName, skillName, enabled);
    return { ok: true };
  });

  // ─── Streaming handler ───

  ipcMain.handle('agent:stream-message', async (_event, input: { sessionId: string; content: string; attachments?: unknown[] }) => {
    const abortController = new AbortController();

    // dogfood T1 Stage 2（design §3.1 / r7 坑 2）：事件 payload 补 projectPath——store 级全局
    // 监听项目隔离的硬前提。会话不在内存时 streamMessage 自身会抛 'session not found'，此处
    // 仅 best-effort 解析一次（每事件零重复查询）。Preload/UI 消费不动（additive 字段）。
    const session = runtime.getSession(input.sessionId);
    const projectPath = session?.projectPath;

    // dogfood T1 Stage 3（design §5.4 D4）：同项目单 run 闸——占用时结构化拒绝（含占用
    // 会话 id + 项目路径，UI toast + 一键跳转）。会话缺失时不闸（既有 'session not found'
    // error 路径不变）。**释放 = finally（经 acquire 返回的 handle——CR-T1-021 引用计数：
    // 同 session 重叠 invoke 先退者只衰减自己那份，不再误删后者租约）**。
    let gateRelease: (() => void) | null = null;
    if (session) {
      const gate = acquireProjectRun(projectPath, input.sessionId);
      if (!gate.ok) {
        logger.info(
          { projectPath, sessionId: input.sessionId, heldBy: gate.held.sessionId },
          'agent stream rejected: another run active in this project',
        );
        return {
          status: 'rejected',
          code: 'project_run_active',
          heldBySessionId: gate.held.sessionId,
          projectPath: gate.held.projectPath,
        };
      }
      gateRelease = gate.release;
    }

    // Track per session so agent:abort-run can cancel an in-flight stream.
    // 闸后注册：D4 拒绝路径无流在途——提前注册会泄漏 entry（finally 不覆盖早退 return），
    // 且 streamAbortControllers.has 被启动对账当「活跃流」判据，泄漏即误判。
    // CR-T1-022：Set 形态追加（非整键覆盖）——同 session 重叠 invoke 各持通道。
    registerStreamAbortController(input.sessionId, abortController);

    const sendEvent = (event: { type: string; data: unknown }) => {
      try {
        getWin()?.webContents.send('agent:stream-event', { ...event, sessionId: input.sessionId, projectPath });
      } catch {
        // Window may have been closed
      }
    };

    try {
      await runtime.streamMessage({
        sessionId: input.sessionId,
        content: input.content,
        attachments: input.attachments as Parameters<typeof runtime.streamMessage>[0]['attachments'],
        abortSignal: abortController.signal,
        sendEvent,
      });
      return { status: 'completed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAbortError(err)) {
        return { status: 'aborted', message };
      }
      // dogfood T1 CR-T1-013：同 session 重叠 invoke 撞 runtime runState 的
      // SessionRunAlreadyActiveError（agent 包 runState.ts 导出——未从包入口导出，此处按
      // 消息前缀判别，mirror workflow.ts isSessionNotFoundError 的消息判等先例）——它是
      // 「已有 run」语义非失败：返结构化 busy 结果（UI 按「已占用」处理），**不发 error
      // 事件**（旧通用分支会误 purge 渲染层在流占位 + 误显错误横幅）。
      if (message.startsWith('run already active for session')) {
        logger.info(
          { sessionId: input.sessionId },
          'agent stream rejected: session already has an active run (overlapping invoke)',
        );
        return {
          status: 'rejected',
          code: 'session_run_active',
          heldBySessionId: input.sessionId,
          projectPath,
        };
      }
      logger.error({ err: message, sessionId: input.sessionId }, 'agent stream error');
      sendEvent({ type: 'error', data: { message } });
      return { status: 'error', message };
    } finally {
      gateRelease?.();
      unregisterStreamAbortController(input.sessionId, abortController);
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

import type { PermissionService } from './permission';
import { createChildSession } from './sessionTree';
import type { WorkflowRuntime } from './workflow';
import type { SessionState } from '../types';
import type { RunStateStore } from './runState';
import { getDefaultRunStateStore } from './runState';
import type { BgTaskOutcome } from './bgTasks';
import { evictSession, updateStatus } from '../agent/session';

export interface SubagentDispatchInput {
  parentSessionId: string;
  role: string;
  prompt: string;
  complete: (context: {
    session: SessionState;
    permission: PermissionService;
    prompt: string;
    role: string;
  }) => Promise<{ content: string }>;
}

export interface SubagentResult {
  childSessionId: string;
  role: string;
  content: string;
  status: 'completed';
}

export interface SubagentDispatchOutput {
  session: SessionState;
  permission: PermissionService;
  result: SubagentResult;
}

// ── 09-21-subagent-bg-decouple（design §1.2 / §2）：后台派发面 ──
//
// dispatchBackground 与同步 dispatch 同一条 child runLoop 路径（createChildSession + narrowPermission
// + complete 回调内跑 runLoop），差异三点（design 定案）：
// ① 调用方不 await——handle 同步返回，complete 的 promise 由 caller（BgTaskRegistry）持有；
// ② finally **豁免 evictSession**——子会话保留至会话删除/项目关闭（可检视 + 结果引用 + 计量归因），
//    内存压力由既有 session LRU 承担（running 态永不淘汰，session.ts evictOldSessions）；
// ③ 子 run 走自身 sessionId 的 beginRun/completeRun|failRun|markAborted 生命周期（D2——agent:abort-run
//    按 sessionId 定位的既有通道直接可停后台子 run）。
//
// 🔑 abort 隔离：`input.signal` 由 caller（BgTaskRegistry.dispatchBg 持有的独立 AbortController）提供，
// **不得**传 leader turn 的 ctx.abort（design §2——leader run abort ≠ 后台子 agent 死）。beginRun 把该
// 外部信号链入 store 自建 controller，runLoop 用 store 返回的信号——如此 registry.cancel（外部链）与
// agent:abort-run(childSessionId)（store 链）两条路径都能停掉子 runLoop，终态在 outcome 统一收敛。

export interface SubagentDispatchBackgroundInput {
  parentSessionId: string;
  role: string;
  prompt: string;
  /** 独立取消信号（BgTaskRegistry 持有的 controller；非 leader turn ctx.abort——见上 🔑）。 */
  signal: AbortSignal;
  complete: (context: {
    session: SessionState;
    permission: PermissionService;
    prompt: string;
    role: string;
    /** runState.beginRun 返回的运行信号——runLoop 必须用它（store 链 abort-run 通道可达）。 */
    signal: AbortSignal;
  }) => Promise<{ content: string }>;
}

/** 后台子 run 终态（outcome 承诺永不 reject——错误/取消都折进 status，与 BgTaskOutcome 对齐）。 */
export type SubagentBackgroundOutcome = BgTaskOutcome;

export interface SubagentBackgroundHandle {
  session: SessionState;
  permission: PermissionService;
  childSessionId: string;
  /** 子 run 终态 promise（resolved with outcome，永不 reject）。 */
  outcome: Promise<SubagentBackgroundOutcome>;
}

export interface SubagentRuntime {
  dispatch(input: SubagentDispatchInput): Promise<SubagentDispatchOutput>;
  /** 后台派发（additive，design §1.2）：同步返 handle，子 run 不阻塞调用方、完成不 evict。 */
  dispatchBackground(input: SubagentDispatchBackgroundInput): SubagentBackgroundHandle;
}

export interface SubagentRuntimeOptions {
  runtime: WorkflowRuntime;
  narrowPermission: (parentSession: SessionState) => PermissionService;
  /**
   * 子 run 生命周期 store（D2：beginRun/completeRun 走 child 自身 sessionId）。缺省
   * getDefaultRunStateStore()——既有测试构造（不传）零回归。
   */
  runState?: RunStateStore;
}

// isAbortError 的本地镜像（workflow.ts:4697 同款两行判据）——workflow.ts import 本模块
// （createSubagentRuntime），反向 import 会成环；两行谓词复制 + 注释锚点，词表演进须同步。
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
  return {
    async dispatch(input) {
      const parentSession = options.runtime.getSession(input.parentSessionId);
      if (!parentSession) {
        throw new Error(`session "${input.parentSessionId}" not found`);
      }

      const childSession = createChildSession({
        parentId: parentSession.id,
        agentName: input.role,
      });

      const permission = options.narrowPermission(parentSession);
      // CR-12：complete 回调抛非 abort 错时 evictSession 须仍执行，否则 child session 残留。
      // try/finally 保证无论 complete 成功/抛错（含 runChain 内部 error），child session 都被清理。
      let completed: { content: string };
      try {
        completed = await input.complete({
          session: childSession,
          permission,
          prompt: input.prompt,
          role: input.role,
        });
      } finally {
        evictSession(childSession.id);
      }

      return {
        session: childSession,
        permission,
        result: {
          childSessionId: childSession.id,
          role: input.role,
          content: completed.content,
          status: 'completed',
        },
      };
    },

    dispatchBackground(input) {
      const parentSession = options.runtime.getSession(input.parentSessionId);
      if (!parentSession) {
        throw new Error(`session "${input.parentSessionId}" not found`);
      }

      const childSession = createChildSession({
        parentId: parentSession.id,
        agentName: input.role,
      });

      const permission = options.narrowPermission(parentSession);
      const runState = options.runState ?? getDefaultRunStateStore();
      // D2：子 run 走自身 sessionId 生命周期。beginRun 把 caller 的独立信号链入 store controller
      // （外部 abort → store 跟随），runLoop 用 store 返回信号（store.abortRun 亦可独立停）。
      // beginRun 冲突不可能：新 child session id 唯一（design §1.2）。
      const runAbortSignal = runState.beginRun(childSession.id, input.signal);
      // session 级 status 置 running：LRU「running 永不淘汰」护住后台子会话内存驻留 + 会话元数据如实。
      updateStatus(childSession.id, 'running');

      const outcome: Promise<SubagentBackgroundOutcome> = input
        .complete({
          session: childSession,
          permission,
          prompt: input.prompt,
          role: input.role,
          signal: runAbortSignal,
        })
        .then(
          (completed): SubagentBackgroundOutcome => {
            runState.completeRun(childSession.id);
            updateStatus(childSession.id, 'completed');
            return { status: 'completed', content: completed.content };
          },
          (err): SubagentBackgroundOutcome => {
            if (isAbortError(err)) {
              runState.markAborted(childSession.id);
              updateStatus(childSession.id, 'aborted');
              return { status: 'aborted' };
            }
            const message = err instanceof Error ? err.message : String(err);
            runState.failRun(childSession.id, message);
            updateStatus(childSession.id, 'error', message);
            return { status: 'failed', error: message };
          },
        );

      // 后台路径：不 await complete、无 finally evict（同步路径的 CR-12 清理语义在此**刻意豁免**
      // ——子会话保留供检视/结果引用；终态由上方 outcome 链收口，无泄漏路径）。
      return {
        session: childSession,
        permission,
        childSessionId: childSession.id,
        outcome,
      };
    },
  };
}

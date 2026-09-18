import { randomUUID } from 'node:crypto';
import type {
  ChainNodeDef,
  CheckpointStage,
  RunChainDeps,
  RunChainOptions,
  RunSnapshot,
  RunSnapshotSummary,
} from '../contracts/run';
import { ChainAbortedError } from '../contracts/run';
import { logger } from '../logger';
import { isOptimizerFailedSignal, OPTIMIZER_FAILED_KEY } from '../nodes/revision-optimizer-node';
import { isLintSourceMechanicallyConfirmed } from '../nodes/chapter-nodes';
import type { PlanReviewFinding } from '../nodes/brief-reviewer-node';
import type { ArcBeat, EscalateFinding, NovelStorySyncPayload } from '@orison/shared-contracts';
import { arcBeatSchema, archiveIssueSchema, compileReportSchema, researchSuspensionSchema, storyTimeDriftWarningSchema, REVIEW_ATTRIBUTION_VALUES } from '@orison/shared-contracts';

// ── CR 批（09-13 chain-flow-restructure review findings）：escalate-pause 裁决 accept 续跑的终稿
//    checkpoint 补发标记（artifact 形态随 chainSnapshot 持久——补发过一次后 resume 不再补发，防死环）。──
export const FINAL_CHECKPOINT_SUPPLEMENTED_KEY = 'final_checkpoint_supplemented';

/**
 * CR-2a①：escalate-pause 源于**规划环**（A2 灰区 / 规划环 cap 耗尽）时的裁决材料载荷。
 *
 * 自审环灰区走既有 `escalateFindings`（review.latest dimensions 抽取）——规划环灰区的裁决材料是
 * plan_review 的 findings（六维审核发现，保真不截断），入口层（write_chapter gate / IPC 裁决编排）
 * 据 `loopLabel: 'plan'` 识别规划环 pause 并分派。deliverable 豁免 context isolation（同 escalateFindings）。
 */
export interface PlanEscalatePayload {
  verdict: 'escalate';
  /** 环标签（当前唯一 'plan'——自审环灰区不产本载荷）。 */
  loopLabel: 'plan';
  summary: string;
  findings: PlanReviewFinding[];
}

// RunSnapshotSummary 契约本体在 contracts/run.ts；本批（CR-2a① / CR-11）的 additive 字段经 module
// augmentation 落本文件（FindingsPayload 族：裁决/观测 deliverable）。镜像 shared ipc.ts
// RunChapterChainSummary 的平行 type 由消费侧（write_chapter gate / IPC 层）各自同步。
declare module '../contracts/run' {
  interface RunSnapshotSummary {
    /** CR-2a①：escalate-pause 源于规划环时的裁决材料（入口层 gate 据 loopLabel 分派裁决编排）。 */
    planEscalate?: PlanEscalatePayload;
    /** CR-11：brief-reviewer graceful 跳过标记（「未审核」≠「审核通过」——leader 引导行/观测面消费）。 */
    planReviewSkipped?: boolean;
  }
}

// ── Story 4.0 写章战术链段：runChain 驱动器（design §4.1 / implement.md 4.2/4.3）──
//
// runChain = subgraph 战术层执行器（ADR-17 两层分层）：顺序驱动 ChainNodeDef[] 节点，经 RunSnapshot.artifacts
// 流转 artifact，挂 checkpoint（brief/draft/verdict + revision-guard 动态），through 节点判回环 verdict 后
// 驱动链内回环（auto_revise/revise → pointer 跳回环 from 续跑，上限 cap，超限强制 escalate-pause）。
//
// **不升一等概念**（spec line 126）：简单顺序驱动 + 声明式 loops 数组（双环并存），不建完整图引擎。
// 证明比裸 subgraph 好后再升。
//
// 链流程重排（09-13 W1a）核心语义变化：
// - **链内回环取代 break 交 leader**（翻 7.4 候选④）：auto_revise 不再以 status='auto_revise_pending'
//   break 出主循环交 leader 驱动 redo——环体（新链 C1-C7 含意图编译 + 保义护栏）在链内收敛，leader 只在
//   escalate-pause / stage checkpoint pause 介入。7.4 候选④反对的是「裸改稿不过护栏」，新环体含编译 +
//   护栏，反对理由消失。`auto_revise_pending` 状态退役。
// - **loops 数组化**：单 revisionLoop → 多环并存（规划环 [brief-compiler→brief-reviewer] cap 2 + 自审环
//   [revision-optimizer→route] cap 3）。两环 verdict 各读 through 产物（plan_review verdict 词表 /
//   route_decision decision 词表），readLoopVerdict 单源词汇映射（纯机械，范式判据 ✓——判决值归 LLM）。
// - **escalate-pause 统一机制**（R4b）：through 判 escalate / 环 cap 超限 → status='paused' +
//   run.escalatePause=true + persist（onCheckpoint 通道，pause 决策忽略——escalate-pause 无条件）。与
//   stage 人审暂停共用 paused 形态但 resume 路径不同：裁决 accept → resume 续跑 / revise → resume redo
//   回环；入口层（write_chapter）据 summary.escalatePause 分派裁决编排。
// - **环计数按 runChain 调用独立**：人审 redo / escalate 裁决 revise 重入 = 新 runChain 调用 → 计数归零
//   （design §2 M3 拍板：人已花注意力，重启预算；跨人审累计无意义）。
// - **optimizer_failed 信号消费（W1c 契约）**：C1 revision-optimizer 编译失败产 `optimizer_failed`
//   artifact → 失败圈的 through 判决强制升级 escalate-pause（R6① 永不假 pass）。信号圈作用域：
//   环 from 节点开跑时清上圈残留（新圈三入口统一：首圈 / 回环 / resume-redo）。
// - **CR 批（09-13 review findings）**：
//   - CR-1 环入口机械断路器：连续两圈入口指纹相同（draft.initial.text 未变 + guard 同判）= 确定性
//     空转 → 按 cap 超限矩阵短路 escalate（省每圈 ~7 节点 LLM 空烧；纯代码判据零 LLM）。
//   - CR-10 未知 verdict 不假 pass：through 节点产出词表外判决值 → escalate-pause（不再防御透传
//     前进——透传 = 把未知判决当 pass 跑完 E 段，违「永不假 pass」红线）。
//   - CR-3a escalate-accept 续跑补发终稿 checkpoint：route escalate-pause 裁决 accept 后 route 已在
//     completedNodes（终稿 checkpoint 结构性跳过）→ resume 入口补发一次 stage='final'（suggest/
//     readonly 档人审终稿；auto 档 continue 零行为差），标记 artifact 防补发死环。
//   - CR-2a 规划环灰区裁决材料：cap 耗尽不再 stub 覆写 plan_review（findings 保真），summarize 投影
//     planEscalate 载荷（loopLabel='plan'）+ planReviewSkipped 观测标记。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：runChain 本身是纯代码编排（机械分派），
// 不做语义判断——回环 verdict 归 LLM（through 节点判），runChain 只机械执行 LLM 判定（跳回环体 /
// escalate-pause / 终态前进）。brief 编译节点的 #6 汇编也是纯代码（别处）。
//
// context isolation（ADR-17）：runChain 返完整 RunSnapshot，但 runChapterChain（Step 5）只把
// summarizeRunSnapshot(snapshot) 回给 leader（不灌内部 trace）。
//
// expected_downstream_consumers:
// - Story 4.0 Step 5：runChapterChain（workflow.ts）dispatchSubagent complete 回调调 runChain。
// - Story 4.3：onCheckpoint 扩 pause 行为（半自动模式配置）。
// - 链流程重排 W1c/W1d：brief-reviewer-node / revision-optimizer-node 节点工厂 + 双环装配。
//
/**
 * 顺序驱动链段节点（design §4.1）。
 *
 * 流程：
 * 1. 初始化 RunSnapshot（artifacts = initialArtifacts 浅拷贝；pendingNodes = chain ids 减 resumed）。
 * 2. （resume）跳过 resumedCompletedNodes 的连续 completed 前缀（initialArtifacts 须含其产出）。
 * 3. 顺序跑每节点：
 *    - abort 预检：signal.aborted → status='aborted' + onCheckpoint 持久 + 抛 ChainAbortedError。
 *    - DAG 依赖检查：contract.requiredArtifactKeys 缺失 → status='blocked' + errors 记录 + break。
 *    - node.run({run, requirement}) → {stateKey, artifact}。
 *    - error artifact 检查（artifact.error===true，Step 2 flag）→ status='error' + errors 记录 + break（链段不崩）。
 *    - 写 run.artifacts[stateKey]=artifact + completedNodes 记录。
 *    - **through 节点回环处理（loops 任一 through 命中 pointer，先于 checkpoint staging）**：
 *      verdict=loop 家族（auto_revise/revise）且环 cap 内 → pointer 跳回环 from + continue（链内回环，
 *      不 fire checkpoint——非暂停形态）；cap 超限 → 强制 escalate（覆写 through verdict artifact + errors
 *      记录）→ escalate-pause。verdict=escalate 家族 → escalate-pause（route 词表 escalate_user 先经 onAccept
 *      产 chapter_accept 裁决材料）。verdict=accept_as_truth → **终稿 checkpoint fire**（checkpointStage
 *      'final'，W2——onAccept 已移 E 段完成后；pause → break，否则自然前进 E 段）。verdict=pass（规划环）→
 *      落穿 generic staging 正常前进。
 *    - checkpoint stage（brief/draft，以及非 through 节点的 final/verdict）→ **await** onCheckpoint(stage, run)；
 *      返 {action:'pause'} → status='paused' + currentNodeId 停该 checkpoint 节点 + break（design §3.2 / §2 Option A，Story 4.3）。
 *      **through 节点的终稿 checkpoint 不在此 fire**——accept 路径在上方回环处理段终态处理后 fire
 *      （CR-08-02-autonomy-modes-001，防 readonly 模式 final pause 抢断终态处理致 silent data loss）。
 *
 * escalate-pause（灰区裁决暂停，R4b 统一机制）：
 * - 触发：through 判 escalate 家族（route=escalate_user / plan_review=escalate）/ 环 cap 超限强制 escalate。
 * - 动作：route 词表先 onAccept 产 chapter_accept（裁决材料，D4 v2 对称）→ persist（onCheckpoint 通道，
 *   pause 决策忽略）→ status='paused' + escalatePause=true + break（currentNodeId 停 through 节点）。
 * - resume 语义（入口层分派）：裁决 accept → resume 续跑（旧链无剩节点即完成；新链续 D→E→F）；
 *   裁决 revise → resume redo 回环（feedback 注入）；auto 档 auto-trust → 链内直接继续（不暂停的档位
 *   处置在入口层 hardEscalatePolicy，chainRunner 只提供暂停形态）。
 *
 * abort/resume（design §4.1 / §4.6）：
 * - abort：signal.aborted → status='aborted' + onCheckpoint(lastStage, run)（让 Step 5 持久 chainSnapshot）
 *   + 抛 ChainAbortedError（携 snapshot，runChapterChain catch 后可读 .snapshot）。
 * - resume：resumedCompletedNodes 跳过已完成节点（节点重跑须 idempotent——LLM 节点重跑产出可能不同，4.0 接受）。
 *   4.0 in-memory 持久（resume 跨 abort 不跨进程重启）；disk 持久 follow-up（design §4.6 记档）。
 */
export async function runChain(opts: RunChainOptions, deps: RunChainDeps): Promise<RunSnapshot> {
  const { chain, initialArtifacts, requirement } = opts;

  // ── loops 索引校验（启动时一次，链流程重排 W1a：单环 → 多环数组）──
  const loops = (opts.loops ?? []).map((loop, i) => {
    const fromIdx = chain.findIndex((c) => c.id === loop.from);
    const throughIdx = chain.findIndex((c) => c.id === loop.through);
    if (fromIdx < 0 || throughIdx < 0) {
      throw new Error(
        `runChain: loops[${i}].from("${loop.from}") or .through("${loop.through}") not found in chain`,
      );
    }
    if (fromIdx > throughIdx) {
      throw new Error(
        `runChain: loops[${i}].from index (${fromIdx}) must be <= through index (${throughIdx}); re-order chain so the loop body is a contiguous forward slice`,
      );
    }
    if (loop.cap < 0) {
      throw new Error(`runChain: loops[${i}].cap must be >= 0 (got ${loop.cap})`);
    }
    return { fromIdx, throughIdx, cap: loop.cap, count: 0, throughId: loop.through };
  });
  // through 节点命中表（pointer → 环）。多环 through 互异（装配约束），Map 单射。
  const loopByThroughIdx = new Map<number, (typeof loops)[number]>();
  for (const loop of loops) loopByThroughIdx.set(loop.throughIdx, loop);
  // 环 from 节点集合（圈作用域信号清理触发点——新圈开始的三种入口统一：首圈 / 回环 / resume-redo）。
  const loopFromIdxSet = new Set<number>(loops.map((l) => l.fromIdx));
  // CR-1（环入口机械断路器）：环 from index → 环对象（多环 from 互异——装配约束环体为互不重叠的连续
  // 前向切片，Map 单射）。
  const loopByFromIdx = new Map<number, (typeof loops)[number]>(loops.map((l) => [l.fromIdx, l]));
  // CR-1：每环上一圈**入口指纹**（draft.initial.text + revision_guard.verdict）——同指纹再入环 =
  // 上一圈确定性零进展（纯代码判据，不加 LLM 调用）。
  const lapEntryFingerprints = new Map<number, { draftText: string; guardVerdict: string | undefined }>();

  const completedSet = new Set<string>(opts.resumedCompletedNodes ?? []);

  const run: RunSnapshot = {
    runId: randomUUID(),
    status: 'running',
    currentNodeId: null,
    projectPath: deps.sessionContext.projectPath,
    completedNodes: [...completedSet],
    pendingNodes: chain.map((c) => c.id).filter((id) => !completedSet.has(id)),
    artifacts: { ...initialArtifacts },
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
    errors: [],
  };

  let lastCheckpointStage: CheckpointStage | undefined;

  // abort 预检（signal 已 abort，如 resume 一个被取消的链段）
  if (deps.signal.aborted) {
    run.status = 'aborted';
    emitAbortCheckpoint(run, lastCheckpointStage, opts, deps.sessionContext.id);
    throw new ChainAbortedError(run);
  }

  let pointer = 0;
  // resume：跳过已完成节点
  while (pointer < chain.length && completedSet.has(chain[pointer].id)) pointer++;

  // ── CR-3a：escalate-pause 裁决 accept 续跑 → 补发终稿 checkpoint（AC2b「C7 的进 D」）──
  //
  // C7 escalate-pause 时 route-agent 已进 completedNodes；裁决 accept → resume 续跑会跳过 completed
  // 前缀直入 E 段——stage='final' 的终稿 checkpoint（挂在 route 节点）结构性不再触发，suggest/readonly
  // 档用户在裁决 accept 后永远见不到终稿卡。补发判定（全机械）：
  // - resume 上下文（终稿 def 在已完成前缀内——redo 腿 pointer 停更早天然不触发；首跑 pointer=0 同理）；
  // - route 终态为 escalate_user（escalate-pause accept 续跑的充要指纹；plan 环灰区无 route_decision
  //   不触发；自然终稿 pause 的 decision=accept_as_truth 不触发）；
  // - 未补发过（标记 artifact 先置再 fire——onCheckpoint 闭包内的 persistChainSnapshot 持久本 run，
  //   补发 pause 后的 resume 据标记跳过，防「补发→accept→resume→再补发」死环）。
  // pause 与否归 onCheckpoint 闭包单源（decideCheckpointPause：suggest=['final']/readonly 含 → pause；
  // auto=[] → continue 零行为差，仅多一次 persist）。
  {
    const finalIdx = chain.findIndex(
      (c) => c.checkpointStage === 'final' || c.checkpointStage === 'verdict',
    );
    const finalDef = finalIdx >= 0 ? chain[finalIdx] : undefined;
    const supplementRoute = recordOf(run.artifacts['route_decision']) as
      | { decision?: string }
      | undefined;
    if (
      finalDef?.checkpointStage !== undefined &&
      finalIdx < pointer &&
      completedSet.has(finalDef.id) &&
      supplementRoute?.decision === 'escalate_user' &&
      run.artifacts[FINAL_CHECKPOINT_SUPPLEMENTED_KEY] === undefined &&
      opts.onCheckpoint
    ) {
      run.artifacts[FINAL_CHECKPOINT_SUPPLEMENTED_KEY] = true;
      run.currentNodeId = finalDef.id;
      lastCheckpointStage = finalDef.checkpointStage;
      const decision = await opts.onCheckpoint(finalDef.checkpointStage, run);
      if (decision?.action === 'pause') {
        run.status = 'paused';
        return run;
      }
    }
  }

  while (pointer < chain.length) {
    // abort 中途检查（每节点前）
    if (deps.signal.aborted) {
      run.status = 'aborted';
      emitAbortCheckpoint(run, lastCheckpointStage, opts, deps.sessionContext.id);
      throw new ChainAbortedError(run);
    }

    const def = chain[pointer];
    run.currentNodeId = def.id;

    // ── 圈作用域信号清理（W1c 契约：optimizer_failed 只在产它的圈内有效）──
    // 环 from 节点开跑 = 新圈开始（首圈 / 回环 / resume-redo 入口统一在此）→ 清上圈残留失败信号，
    // 防陈旧信号把后续圈的 through 判决误升级（mirror「stale 清理不变式」：节点有重跑入口就要清
    // 上一轮申报类 artifact）。过渡期旧链（revision-optimizer-node 不在链上）恒 no-op。
    if (loopFromIdxSet.has(pointer)) {
      if (run.artifacts[OPTIMIZER_FAILED_KEY] !== undefined) {
        delete run.artifacts[OPTIMIZER_FAILED_KEY];
      }
      // ── CR-1：环入口机械断路器（确定性空转短路）──
      // 唤醒条件（纯代码判据，零 LLM）：本圈入口指纹（draft.initial.text + revision_guard.verdict）
      // 与上一圈入口指纹相同 = 上一圈改稿零进展且 guard 同判（典型：auto 档 soft-violation 回退改前稿
      // 后，lint/review/route 对未变草稿每圈重判同一 verdict）。LLM 非确定性下重跑同输入或有新产出，
      // 但「草稿未变 + guard 同判」两圈连续 = 改稿路径结构性失效，再跑只是烧 cap 内每圈 ~7 节点 LLM。
      // 短路处置 = 按 cap 超限已定矩阵走（同 errors 语义 'loop cap' + through 节点 id——入口层
      // capExhausted/lintUnresolved 两支〔去味已过→采信+标环未收敛；未过→终弃〕照常分派）。
      // 只对自审环生效（through 现值为 auto_revise 才比对——规划环体内无 draft，指纹恒 undefined）。
      const entryLoop = loopByFromIdx.get(pointer);
      if (entryLoop) {
        const throughDef = chain[entryLoop.throughIdx];
        const throughStateKey =
          throughDef.node.contract?.producedArtifactKeys?.[0] ?? throughDef.id;
        const { value: throughValue } = readLoopVerdict(run.artifacts[throughStateKey]);
        const fp = revisionLapFingerprint(run);
        const prev = lapEntryFingerprints.get(pointer);
        if (
          throughValue === 'auto_revise' &&
          fp !== undefined &&
          prev !== undefined &&
          fp.draftText === prev.draftText &&
          fp.guardVerdict === prev.guardVerdict
        ) {
          run.currentNodeId = throughDef.id;
          run.artifacts[throughStateKey] = {
            decision: 'escalate_user',
            reason: '环内修订未改变草稿且 guard 同判（确定性空转）——按环超限矩阵短路升级',
          };
          // CR 批 CR-3：覆写后重发快照——上一圈 wrapper 已按原始 verdict（auto_revise）发过帧，
          // 不重发则时间线末帧 stale（重发由 workflow 按形态表投影覆写后的 artifact）。
          emitVerdictOverwritten(run, opts, throughDef.id, throughStateKey);
          pushError(
            run,
            `loop cap short-circuit (deterministic stall: draft.initial.text unchanged + revision_guard verdict "${fp.guardVerdict ?? ''}" repeated) at "${throughDef.id}"; forced escalate`,
          );
          await enterEscalatePause(run, throughDef, true, opts);
          break;
        }
        if (fp !== undefined) lapEntryFingerprints.set(pointer, fp);
      }
    }

    // ── DAG 依赖检查（requiredArtifactKeys 缺失 → blocked + break）──
    const required = def.node.contract?.requiredArtifactKeys ?? [];
    const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(run.artifacts, k));
    if (missing.length > 0) {
      run.status = 'blocked';
      const blockedMessage = `node "${def.id}" blocked: missing required artifacts [${missing.join(', ')}]`;
      pushError(run, blockedMessage);
      // 09-13 子2 W3（M4）：blocked 终态产出快照通用行——节点 run 不被调（装配层包装看不到），
      // 此处先于 onNodeDone 发（AC2「artifact 先于 node-done」顺序对 blocked 同样成立）。
      // CR 批 CR-2：mirror safeEmit——发射失败（dead IPC 等）静默 + 低噪日志，不让 blocked
      // 流程 reject（否则 blocked run 上抛 + 哨兵不发，UI 卡 running——其他发射点都有 safeEmit）。
      try {
        opts.onNodeBlocked?.(def.id, blockedMessage);
      } catch (err) {
        logger.debug(
          { nodeId: def.id, err: err instanceof Error ? err.message : String(err) },
          'runChain: onNodeBlocked emit failed (ignored — blocked flow continues)',
        );
      }
      // dogfood T1 Stage 6：blocked 也是该节点的终态（UI 步进条 errorNode 呈现）。
      opts.onNodeDone?.(def.id, 'blocked');
      break;
    }

    // ── 跑节点（CR-6：节点 sync throw 防御——非 AbortError → synthesize error artifact，统一走下方
    //    error-artifact 簿记路径，链段不崩）──
    let result: { stateKey: string; artifact: unknown };
    try {
      result = await def.node.run({ run, requirement });
    } catch (err) {
      // abort（节点内部取消，如 generate 被 signal abort）→ 走统一 abort 路径（status='aborted' +
      // onCheckpoint 持久 + ChainAbortedError，与 signal.aborted 预检一致——runChapterChain catch 后返 aborted summary）
      if (isAbortError(err)) {
        run.status = 'aborted';
        emitAbortCheckpoint(run, lastCheckpointStage, opts, deps.sessionContext.id);
        throw new ChainAbortedError(run);
      }
      const msg = err instanceof Error ? err.message : String(err);
      // synthesize error artifact（用节点 producedArtifactKeys[0] 或 def.id 作 stateKey）；不在此 pushError，
      // 让下方 isErrorArtifact 路径统一簿记一次（避免 throw + error-artifact 双记）。
      const errorStateKey = def.node.contract?.producedArtifactKeys?.[0] ?? def.id;
      result = {
        stateKey: errorStateKey,
        artifact: { error: true, nodeId: def.id, message: `threw: ${msg}` },
      };
    }

    // ── error artifact 检查（createLlmNode 兜底产出 / brief-compiler safeParse 失败 / CR-6 throw synthesize）──
    // artifact.error===true → 链段不崩，status='error' + 单条 errors 记录 + break。
    if (isErrorArtifact(result.artifact)) {
      run.artifacts[result.stateKey] = result.artifact;
      run.status = 'error';
      const msg = (result.artifact as { message?: string }).message ?? 'unknown error';
      pushError(run, `node "${def.id}" error: ${msg}`);
      // dogfood T1 Stage 6：error artifact 也是该节点的终态（throw 合成路径同走此处）。
      opts.onNodeDone?.(def.id, 'error');
      break;
    }

    // ── 写 artifact + completedNodes（去重，闭环重跑不重复 push）──
    run.artifacts[result.stateKey] = result.artifact;
    if (!completedSet.has(def.id)) {
      completedSet.add(def.id);
      run.completedNodes.push(def.id);
    }
    run.pendingNodes = run.pendingNodes.filter((id) => id !== def.id);
    // dogfood T1 Stage 6：节点成功边界（artifact 写入 + completedNodes 记录后、checkpoint staging 前）
    // fire 步进回调——每个节点都 fire（非仅 checkpoint 节点），UI 步进条数据源。
    opts.onNodeDone?.(def.id, 'done');

    // ── through 节点回环处理（loops 任一 through 命中 pointer；链流程重排 W1a）──
    // 先于 checkpoint staging：回环跳步不 fire checkpoint（链内回环非暂停形态）；escalate-pause 自带
    // persist；pass-through 落穿 staging 让规划环 through 的 brief 停点照常 fire。readLoopVerdict 词汇
    // 映射纯机械（范式判据 ✓——verdict 值本身归 through 节点 LLM 判）。
    const activeLoop = loopByThroughIdx.get(pointer);
    if (activeLoop) {
      const { kind, value } = readLoopVerdict(result.artifact);
      const routeVocab = value === 'auto_revise' || value === 'accept_as_truth' || value === 'escalate_user';

      // W1c 契约（W1a 环机制消费）：optimizer_failed 信号在 → 失败圈的 through 判决强制升级
      // escalate-pause（R6① 永不假 pass 不静默——C1 意图编译失败的机械标记，该圈的改稿不可信，
      // 判决（含 accept）不可采信）。信号圈作用域：from 节点开跑时已清上圈残留（见主循环顶部），
      // 在此读到 = 本圈失败。
      if (isOptimizerFailedSignal(run.artifacts[OPTIMIZER_FAILED_KEY])) {
        run.artifacts[result.stateKey] = routeVocab
          ? { decision: 'escalate_user', reason: 'revision-optimizer 编译失败（optimizer_failed），升级裁决' }
          : { verdict: 'escalate', reason: 'revision-optimizer 编译失败（optimizer_failed），升级裁决' };
        // CR 批 CR-3：覆写后重发快照（wrapper 已按原始 verdict 发帧，不重发则时间线末帧 stale）。
        emitVerdictOverwritten(run, opts, def.id, result.stateKey);
        pushError(run, `revision intent compile failed (optimizer_failed) at "${def.id}"; forced escalate`);
        await enterEscalatePause(run, def, routeVocab, opts);
        break;
      }

      // CR-10（永不假 pass 红线）：through 节点产出未知/缺失 verdict 值——旧「防御透传正常前进」会把
      // 未知判决当 pass 跑完整个 E 段（无 checkpoint/onAccept/escalate、垃圾 routeDecision 上报）= 假
      // pass。改为响错进 escalate-pause（升级裁决人可见），错误信息标注未知值。词汇归属按 artifact
      // 实际携带字段定（.decision 在 → route 词表；否则 plan 词表——未知值不在任一词表内，routeVocab
      // 值判对它恒 false）。
      if (kind === undefined) {
        const escalateRouteVocab = routeVocab || speaksRouteVocab(result.artifact);
        pushError(run, `unknown loop verdict "${value}" at through node "${def.id}" → forced escalate`);
        run.artifacts[result.stateKey] = escalateRouteVocab
          ? { decision: 'escalate_user', reason: `through 节点产出未知判决值 "${value}"，升级裁决` }
          : { verdict: 'escalate', reason: `through 节点产出未知判决值 "${value}"，升级裁决` };
        // CR 批 CR-3：覆写后重发快照（wrapper 已按原始 verdict 发帧，不重发则时间线末帧 stale）。
        emitVerdictOverwritten(run, opts, def.id, result.stateKey);
        await enterEscalatePause(run, def, escalateRouteVocab, opts);
        break;
      }

      if (kind === 'loop') {
        // auto_revise（自审环）/ revise（规划环）→ 链内回环（翻 7.4 候选④：不再 break 交 leader——
        // 新链环体含意图编译 + 保义护栏，链内收敛；cap 内 → pointer 跳回环 from 续跑）。
        if (activeLoop.count < activeLoop.cap) {
          activeLoop.count += 1;
          // W2：自审环（route 词表）回环盖戳迭代数——终稿 checkpoint 载荷（reviewSummary.loopCount）
          // 与 hardEscalate 上报消费。规划环计数不进（终稿卡只关自审环收敛轮数）。
          if (routeVocab) run.revisionCount = activeLoop.count;
          pointer = activeLoop.fromIdx;
          continue;
        }
        // cap 超限 → 强制 escalate（ADR-17「超限升级」防死循环）。词汇随环：自审环（route 词表）→
        // 'escalate_user'；规划环（plan_review 词表）→ 'escalate'。覆写 through verdict artifact +
        // errors 记录（机械信号可观测），落进 escalate-pause。
        if (routeVocab) {
          run.artifacts[result.stateKey] = {
            decision: 'escalate_user',
            reason: `loop cap (${activeLoop.cap}) reached; escalating to user`,
          };
        } else {
          // CR-2a②：规划环 cap 耗尽不再用 {verdict, reason} 两字段 stub 整体覆写 plan_review——
          // findings[] 是裁决材料（保真不截断，六维审核发现随裁决载荷上报），cap 原因并入 summary；
          // verdict 机械归一 escalate。skipped 等既有字段一并保留（spread）。
          const prevPlan = recordOf(result.artifact) ?? {};
          const prevSummary = typeof prevPlan.summary === 'string' ? prevPlan.summary : '';
          const capNote = `规划环回环上限（cap ${activeLoop.cap}）耗尽，升级裁决`;
          run.artifacts[result.stateKey] = {
            ...prevPlan,
            verdict: 'escalate',
            summary: prevSummary.length > 0 ? `${prevSummary}；${capNote}` : capNote,
          };
        }
        // CR 批 CR-3：覆写后重发快照（wrapper 已按原始 verdict 发帧，不重发则时间线末帧 stale）。
        emitVerdictOverwritten(run, opts, def.id, result.stateKey);
        pushError(run, `loop cap (${activeLoop.cap}) reached at "${def.id}"; forced escalate`);
        await enterEscalatePause(run, def, routeVocab, opts);
        break;
      }

      if (kind === 'escalate') {
        // 灰区 escalate（route=escalate_user / plan_review=escalate）→ escalate-pause（R4b 统一机制）。
        // route 词表先 onAccept 产 chapter_accept（裁决材料，D4 v2 对称——cap-escalate 与 LLM escalate
        // 同形）；persist-before-pause（onCheckpoint 通道，pause 决策忽略——escalate-pause 无条件；入口层
        // 据 summary.escalatePause 分派裁决 resume：accept → 续跑 / revise → redo 回环）。
        await enterEscalatePause(run, def, value === 'escalate_user', opts);
        break;
      }

      if (kind === 'accept') {
        // accept_as_truth（自审环终态）→ **终稿 checkpoint**（链流程重排 W2：route-agent checkpointStage
        // 'final'——route accept 后、E 段提取前唯一人审点；旧 'verdict' 兼容 mock 链）。fire 时机 =
        // accept 终态处理后（CR-08-02-autonomy-modes-001 时序防御：终态处理先行，pause 抢断不丢终态
        // 副作用）；pause → break（suggest=['final']/readonly=['brief','final'] 档停），否则自然前进 E 段
        // （auto 档零停）。
        //
        // **onAccept 不在此调**（W2 落盘拆两步 F1b：onAccept 移 E 段完成时——chapter_accept candidate
        // 须含人改后正文〔终稿 checkpoint 的 editedDraft 经 resume 腿覆写 draft.initial 后才组 candidate〕；
        // 终稿 pause 时刻候选缺省，resume-accept 腿跑完 E 由完成时 onAccept 统一产出）。
        if (def.checkpointStage === 'final' || def.checkpointStage === 'verdict') {
          lastCheckpointStage = def.checkpointStage;
          const finalDecision = opts.onCheckpoint
            ? await opts.onCheckpoint(def.checkpointStage, run)
            : undefined;
          if (finalDecision?.action === 'pause') {
            run.status = 'paused';
            break;
          }
        }
        // 自然前进（pointer += 1 在主循环尾部）。
      }
      // kind === 'pass'（规划环 pass-through）→ 落穿 generic staging 正常前进（undefined 未知 verdict
      // 已在上方 CR-10 分支 escalate-pause，不再「防御透传」假 pass 前进）。
    }

    // ── checkpoint staging（brief/draft，以及非 through 节点的 verdict；design §4.6 / CR-13 显式声明）──
    // CR-13：用 def.checkpointStage 显式声明（取代 nodeId 子串推断——子串匹配脆弱，未来节点 id 含
    // 'brief'/'draft'/'route' 子串会假触发）。链装配（chapter-chain.ts）按 design §4.6 标注；mock 链
    // 测试在 ChainNodeDef 上声明 checkpointStage。
    //
    // Story 4.3 Step 2（design §3.2 D2）：onCheckpoint 升 async 返 CheckpointDecision。返 {action:'pause'}
    // → status='paused' + currentNodeId 停该 checkpoint 节点（已在 :124 设）+ break + 返 snapshot
    // （runChapterChain 检测 paused summary → 交还 leader → 人响应后 resume 续跑，CR-2 读回 chainSnapshot
    // 跳过已完成节点，idempotent ADR-17）。返 {action:'continue'} / 无 onCheckpoint → 续跑（全自动零回归 = 4.0）。
    // 范式判据（ADR-3）：pause 决策纯代码机械判（policy.pauseStages.includes），非 LLM 语义判断。
    //
    // CR-08-02-autonomy-modes-001（critical，三 reviewer 独立确认）：through 节点（route-agent）的终稿
    // checkpoint（W2 起 checkpointStage='final'，旧 'verdict' 兼容）**不在此通用 staging 触发**——accept
    // 路径已在上方回环处理段终态处理后 fire。否则 readonly（微操）模式 route 返任何决策时 final pause 在
    // 终态处理前抢先 break → escalate-pause 永不执行 → resume-continue 时 route 在 completedNodes 前缀
    // 跳过 → 终态永不补跑 → silent data loss（escalate 裁决丢）。非 through 节点的 'verdict'/'final'
    // （无 loops 场景，如 mock 链测试）仍在此 fire（零回归）。
    const stage = def.checkpointStage;
    const isThroughNode = activeLoop !== undefined;
    if (stage && !((stage === 'final' || stage === 'verdict') && isThroughNode)) {
      lastCheckpointStage = stage;
      const decision = opts.onCheckpoint ? await opts.onCheckpoint(stage, run) : undefined;
      if (decision?.action === 'pause') {
        run.status = 'paused';
        break;
      }
    }

    pointer += 1;
  }

  // Story 4.3 Step 2 / 链流程重排 W1a：pause 退出（stage 人审暂停 + escalate-pause 两形态）——保留
  // currentNodeId 在暂停节点（runChapterChain 据此经 chain 解析 pausedStage 填 summary〔escalate-pause
  // 除外——workflow 侧 gate〕，resume 据 completedNodes 续跑）。不 null（与 completed/aborted 区分：
  // paused 链段仍「在」该节点等人响应 / 裁决）。design §3.2 / §2 Option A。
  if (run.status === 'paused') {
    return run;
  }

  // 跑完所有节点未触 route 终止 → 正常完成
  if (run.status === 'running') {
    run.status = 'completed';
    // 链流程重排 W2（R4c 落盘拆两步 F1b）：onAccept 移 **E 段完成后**调用——chapter_accept candidate
    // 须含人改后正文（终稿 checkpoint 的 editedDraft 经 resume 腿已覆写 draft.initial）。gate：route
    // 终态 accept（终稿已定）才产候选——escalate 路径的候选在 enterEscalatePause 已产（裁决材料，
    // 随 snapshot artifacts 存活到 resume 腿）；无 route 的 mock 链完成不产（零回归）。
    const completedRoute = recordOf(run.artifacts['route_decision']) as { decision?: string } | undefined;
    if (completedRoute?.decision === 'accept_as_truth' && opts.onAccept) {
      const acceptResult = opts.onAccept(run, { nowISO: opts.nowISO ?? '' });
      if (acceptResult && 'chapterId' in acceptResult) {
        run.artifacts['chapter_accept'] = acceptResult;
      }
    }
  }
  run.currentNodeId = null;
  return run;
}

/**
 * 抽 RunSnapshot 摘要（context isolation，design §4.3 / ADR-17）。
 *
 * **只抽** {status, routeDecision, reviewVerdict, draftTitle/wordCount/text, errors, paused payload}——**不抽内部 trace /
 * 全量 artifacts**（防 leader 长程上下文爆炸）。runChapterChain（Step 5）只把此 summary 回给 leader。
 *
 * CR-15a 落地公理：`draftText`（初稿/修订稿正文）**是 deliverable 非 internal trace**——读者/dogfood
 * 须能检视产出正文（[[project-prose-landing-axiom]]），故 prose 豁免 context isolation。reviewer 原 wording
 * 「摘要剥 text 是把 deliverable 隔掉了」修正：剥内部 trace（scene_graph/chapter_brief/story.sync），
 * 不剥正文。持久化正文到 chapter .md（CR-15b）defer 4.1/chapter-integration。
 *
 * CR-3：删 revision.output 死 fallback——targeted-revision 节点 overwrite draft.initial（design §4 决断），
 * 链段不再产 revision.output artifact；旧 fallback 是 dormant 遗留（STATE_KEY_MAP 的 'revision.output'
 * 是 legacy DEFAULT_CHAIN 映射，链段用节点契约 producedArtifactKeys，见 registry.ts 注释）。
 *
 * Story 4.3 Step 2（design §3.4）：`status='paused'` 时抽 pause-review payload——`pausedStage`（从 pauseHint
 * 传入；summarize 无 chain 上下文，runChapterChain 持 chain 据 currentNodeId 经 checkpointStage 解析后透传，
 * honors「从 currentNodeId/checkpointStage 推」）+ `draftContent`（draft checkpoint 的正文，豁免 isolation 同
 * CR-15a）+ `briefContent`（brief checkpoint 的 chapter_brief）。非 paused 缺省（零回归）。
 *
 * @param pauseHint Story 4.3：paused summary 的 pausedStage 来源（runChapterChain 解析；缺省 → pausedStage
 *   undefined，仍产 draftContent/briefContent 若 artifact 在）。
 */
export function summarizeRunSnapshot(
  snapshot: RunSnapshot,
  pauseHint?: { pausedStage?: CheckpointStage },
): RunSnapshotSummary {
  const routeDecision = recordOf(snapshot.artifacts['route_decision']) as
    | { decision?: string; reason?: string; deviation?: boolean }
    | undefined;
  const review = recordOf(snapshot.artifacts['review.latest']);
  const draft = recordOf(snapshot.artifacts['draft.initial']);
  // CR-2a① / CR-11：plan_review artifact（brief-reviewer 产——verdict/summary/findings/skipped）。
  const planReview = recordOf(snapshot.artifacts['plan_review']) as
    | { verdict?: unknown; summary?: unknown; findings?: unknown; skipped?: unknown }
    | undefined;
  // 4.1 Step 4（CR-15b）：chapter_accept = accept 持久化载荷（onAccept 产，design §3.5）。deliverable 非 trace，
  // 同 draftText 豁免 context isolation——入口层（IPC/leader）据此持久化 chapters/*.md + project.yaml。
  const chapterAccept = snapshot.artifacts['chapter_accept'];

  const summary: RunSnapshotSummary = {
    status: snapshot.status,
    routeDecision:
      routeDecision?.decision !== undefined
        ? {
            decision: routeDecision.decision,
            reason: routeDecision.reason ?? '',
            // dogfood R2 #107 / R1.1c：deviation 投影——no-chapter 自动建章时入口层补产
            // storyDecisions 需要（buildAcceptStoryDecisions 单源；修前 summary 只有 decision+reason，
            // 补产只能静默降级不登记——用户拍板不降级）。只在 true 时带（false/缺省省略，零噪音）。
            ...(routeDecision.deviation === true ? { deviation: true } : {}),
          }
        : undefined,
    reviewVerdict: typeof review?.verdict === 'string' ? review.verdict : undefined,
    draftTitle: typeof draft?.title === 'string' ? draft.title : undefined,
    draftWordCount: typeof draft?.wordCount === 'number' ? draft.wordCount : undefined,
    draftText: typeof draft?.text === 'string' ? draft.text : undefined,
    errors: snapshot.errors ?? [],
  };
  if (chapterAccept && typeof chapterAccept === 'object' && !Array.isArray(chapterAccept)) {
    summary.chapter_accept = chapterAccept as RunSnapshotSummary['chapter_accept'];
  }
  // Story 4.6：route=escalate_user 时抽 Reader-Audit 灰区 findings grounding（quote/location/severity），
  // 供裁决器子 agent 初审 + 用户裁决。escalateFindings 是「用户裁决所需 deliverable」同 draftText/chapter_accept
  // 豁免 context isolation（非内部 trace）。非 escalate 缺省。
  if (routeDecision?.decision === 'escalate_user') {
    const escalateFindings = extractEscalateFindings(review);
    if (escalateFindings) summary.escalateFindings = escalateFindings;
  }
  // 链流程重排（09-13 W1a）：escalate-pause 标记投影（status='paused' 时区分「stage 人审暂停」与
  // 「灰区裁决暂停」两条 resume 路径——入口层据此分派裁决编排，R4b）。非 escalate-pause 缺省。
  if (snapshot.status === 'paused' && snapshot.escalatePause === true) {
    summary.escalatePause = true;
  }
  // CR-2a①：planEscalate 载荷——escalatePause 源于**规划环**（A2 灰区 / 规划环 cap 耗尽）时上报规划
  // 审核裁决材料。判据（全机械）：escalate-pause + plan_review.verdict=escalate + route_decision 非
  // escalate_user（route 未跑 = 规划环先行灰区；route 灰区走既有 escalateFindings 载荷不重复报）。
  // findings 保真透传（plan_review 六维发现——CR-2a② cap 耗尽不再 stub 覆写后此处拿到全量），
  // 逐条防御性窄化（坏条目丢好条目留，mirror per-element 哲学）。入口层 gate 据 loopLabel='plan'
  // 识别规划环 pause 分派裁决编排（跨簇契约字段，勿改名）。
  if (
    snapshot.status === 'paused' &&
    snapshot.escalatePause === true &&
    routeDecision?.decision !== 'escalate_user' &&
    planReview?.verdict === 'escalate'
  ) {
    const findings: PlanReviewFinding[] = Array.isArray(planReview.findings)
      ? planReview.findings.flatMap((f): PlanReviewFinding[] => {
          const rec = recordOf(f);
          if (!rec) return [];
          return [
            {
              dimension: typeof rec.dimension === 'string' ? rec.dimension : '',
              // 值域窄化（'hard'|'soft' 外的坏值降 'soft'——mirror 节点 normalizePlanReviewSeverity
              // 保守缺省：severity 是分流标记非回环主信号）。
              severity: rec.severity === 'hard' ? 'hard' : 'soft',
              grounding: typeof rec.grounding === 'string' ? rec.grounding : '',
              note: typeof rec.note === 'string' ? rec.note : '',
            },
          ];
        })
      : [];
    summary.planEscalate = {
      verdict: 'escalate',
      loopLabel: 'plan',
      summary: typeof planReview.summary === 'string' ? planReview.summary : '',
      findings,
    };
  }
  // CR-11：plan-review skipped 投影——brief-reviewer LLM 失败 graceful 跳过（skipped:true）时「本章
  // 未过规划审核」须对 leader/观测面可见（引导行/统计消费；「未审核」≠「审核通过」，永不假 pass）。
  // 任意 status 下带 plan_review.skipped=true 即投影（观测 deliverable，非终态专属）。
  if (planReview?.skipped === true) {
    summary.planReviewSkipped = true;
  }
  // Story 2.2 WP-E（链流程重排 W3 收尾时序）：route 终态（accept_as_truth / escalate_user 采信续跑后）
  // 抽 story.sync 反哺 patches——deliverable 非 internal trace（同 chapter_accept/escalateFindings 豁免
  // context isolation），write_chapter applier 据此转 story_sync_apply 落盘。**空 patches 不抽**（零痕迹，
  // summary 不带空载荷）；E9 提取段在终稿后一次跑——auto_revise 环内回环不产终态 summary（非终态零抽取），
  // escalate-pause 滞留时 E9 未跑无 artifact（resume 采信续跑完成才到此抽取）。
  // 抽取是纯机械投影（field 过滤归 applier 的安全门），不判「这条 patch 该不该收」。
  if (
    (routeDecision?.decision === 'accept_as_truth' || routeDecision?.decision === 'escalate_user')
  ) {
    const storySync = recordOf(snapshot.artifacts['story.sync']);
    if (
      storySync &&
      Array.isArray(storySync.patches) &&
      storySync.patches.length > 0 &&
      typeof storySync.summary === 'string' &&
      storySync.summary.length > 0
    ) {
      summary.storySync = {
        runId: typeof storySync.runId === 'string' ? storySync.runId : snapshot.runId,
        chapterId: typeof storySync.chapterId === 'string' ? storySync.chapterId : '',
        summary: storySync.summary,
        patches: storySync.patches as NovelStorySyncPayload['patches'],
      };
    }
  }
  // Story 8.2：本章写时声明的弧节拍透传（源 artifacts['arc_emergence'].beats，arc-emergence-node 产）。
  // deliverable 非 internal trace（同 escalateFindings 豁免 context isolation）——write_chapter post-settle
  // 据此做关口判定（detectVolumeClosure：卷弧 close beat → arc-audit-agent 大审）。**恒设**（含空数组——
  // dispatch prompt 契约「无则空数组」：零节拍是停滞检测要看见的信号非零痕迹）；artifact 缺（旧链 /
  // bypass 路径）→ 空数组。逐条 arcBeatSchema safeParse 守性（坏条目丢好条目留，mirror per-element 哲学）。
  {
    const arcEmergence = recordOf(snapshot.artifacts['arc_emergence']) as { beats?: unknown } | undefined;
    const rawBeats = arcEmergence && Array.isArray(arcEmergence.beats) ? arcEmergence.beats : [];
    const beats: ArcBeat[] = rawBeats.flatMap((b) => {
      const parsed = arcBeatSchema.safeParse(b);
      return parsed.success ? [parsed.data] : [];
    });
    summary.arcEmergenceBeats = beats;
  }
  // Story 8.4 Step 3（A7 档案议题通道）：出发核查 verdict 的 archive_issues 透传（设定卡过时/矛盾——
  // deliverable 非 internal trace，同 escalateFindings 豁免 context isolation；write_chapter output 呈现
  // 给 leader/用户对话解决）。逐条 archiveIssueSchema safeParse 守性（坏条目丢好条目留，mirror
  // arcEmergenceBeats per-element 哲学）；空/缺不抽（零痕迹）。
  {
    const researchBrief = recordOf(snapshot.artifacts['research_brief']) as
      | { verdict?: { archive_issues?: unknown } }
      | undefined;
    const rawIssues =
      researchBrief?.verdict && Array.isArray(researchBrief.verdict.archive_issues)
        ? researchBrief.verdict.archive_issues
        : [];
    const archiveIssues = rawIssues.flatMap((i) => {
      const parsed = archiveIssueSchema.safeParse(i);
      return parsed.success ? [parsed.data] : [];
    });
    if (archiveIssues.length > 0) summary.archiveIssues = archiveIssues;
  }
  // Story 8.4 C2（design §3.3）：storyTime 漂移 warning 透传（源 artifacts['storytime_drift'].warnings，
  // storytime-drift-node 产——chapter-summary 链位旁守卫；mirror archiveIssues 透传形态：deliverable 非
  // internal trace，write_chapter 文案行呈现进 3.3 校验议题通道）。逐条 storyTimeDriftWarningSchema
  // safeParse 守性（坏条目丢好条目留，mirror arcEmergenceBeats per-element 哲学）；空/缺不抽（零噪音）。
  {
    const drift = recordOf(snapshot.artifacts['storytime_drift']) as { warnings?: unknown } | undefined;
    const rawWarnings = drift !== undefined && Array.isArray(drift.warnings) ? drift.warnings : [];
    const driftWarnings = rawWarnings.flatMap((w) => {
      const parsed = storyTimeDriftWarningSchema.safeParse(w);
      return parsed.success ? [parsed.data] : [];
    });
    if (driftWarnings.length > 0) summary.driftWarnings = driftWarnings;
  }
  // Story 8.4 B1（design §2.1）：热层编译报告透出（源 artifacts['compile_report']，brief-compiler-node
  // 汇总点产；mirror 章摘要 tokenEstimate 先例——观测 deliverable 豁免 context isolation）。safeParse 守形
  // （坏形态防御性丢，mirror researchSuspension 抽取模式）；artifact 缺（旧链 / bypass 路径）→ 缺省零痕迹。
  {
    const rawReport = recordOf(snapshot.artifacts['compile_report']);
    if (rawReport !== undefined) {
      const parsedReport = compileReportSchema.safeParse(rawReport);
      if (parsedReport.success) summary.compileReport = parsedReport.data;
    }
  }
  // 链流程重排 W3（R2 去味门禁真判决）：终轮 review.latest 中存在 L2 确认的 lint 来源条目
  // （finding.source==='lint' 且 severity=block/warn——info 是观察非缺陷）→ 去味未清。W2 的 raw
  // lint_report 命中计数（机械代理）退役——「命中≠定罪」，判真伪归 multi-review L2（yaml 契约：清单
  // 来源真阳携带 source:'lint'），本信号只驱动 hardEscalate='auto' 的 cap 超限两支终弃/采信分派。
  // 判源不判义（范式判据 ✓）；review 缺 / parse 失败 fallback（dimensions=[]）/ L2 无 lint 确认 → 不设
  // （门禁过——保守采信语义，无确证缺陷不终弃）。
  if (hasConfirmedLintFinding(snapshot.artifacts['review.latest'], snapshot.artifacts['lint_report'])) {
    summary.lintUnresolved = true;
  }
  // 链流程重排 W2（R4c / AC2c）：E 段提取失败章标——route accept 已过（route-agent 在 completedNodes）
  // 但链 status='error'（E 节点 error 中断，唯一可能位置：route 之后只剩 E 段）。终稿已定但衍生状态
  // 未提取——入口层据此 post-hoc 落正文 + 章标 stale + 指引 re-extract（W4）。redo 腿 route-agent 已
  // 移除出 completedNodes（route 重跑中）不误报。纯代码机械判（completedNodes 集合查询）。
  if (
    snapshot.status === 'error' &&
    routeDecision?.decision === 'accept_as_truth' &&
    Array.isArray(snapshot.completedNodes) &&
    snapshot.completedNodes.includes('route-agent') &&
    typeof draft?.text === 'string' &&
    draft.text.length > 0
  ) {
    summary.derivationStale = true;
  }
  // Story 4.3 Step 2（design §3.4）：paused summary 抽 pause-review payload。draftContent/briefContent 豁免
  // context isolation（同 CR-15a prose / 4.6 escalateFindings 是 deliverable 非 internal trace）。draftContent
  // 源 draft.initial.text（同 draftText 源，仅 paused 时作 review 载荷抽）；briefContent 源 chapter_brief artifact。
  // 链流程重排 W1a：escalate-pause 不抽 stage 载荷（其 resume 路径是裁决分派非 ChapterReviewPanel 三动作，
  // 载荷 = escalateFindings + chapter_accept；pausedStage 保持缺省防 UI 误路由 stage 审阅卡）。
  if (snapshot.status === 'paused' && snapshot.escalatePause !== true) {
    summary.pausedStage = pauseHint?.pausedStage;
    if (typeof draft?.text === 'string') summary.draftContent = draft.text;
    const briefArtifact = snapshot.artifacts['chapter_brief'];
    if (briefArtifact !== undefined) summary.briefContent = briefArtifact;
    // Story 7.2：revision-guard pause（soft-violation）抽 revision_guard artifact 作 art-mode 卡载荷。
    // deliverable 非 trace（同 draftContent/escalateFindings 豁免 context isolation）。pausedStage 非
    // revision-guard 时 revision_guard 可能在（clean/skipped）但不作 pause 载荷抽（仅 soft-violation pause 才需）。
    if (pauseHint?.pausedStage === 'revision-guard') {
      const guardArtifact = snapshot.artifacts['revision_guard'];
      if (guardArtifact && typeof guardArtifact === 'object' && !Array.isArray(guardArtifact)) {
        summary.revisionGuard = guardArtifact as RunSnapshotSummary['revisionGuard'];
      }
    }
    // Story 8.4 Step 4（A8）：出发核查挂起 pause 抽挂起载荷（矛盾/偏离明细或缺漏清单——用户决断所需
    // 证据，deliverable 豁免 context isolation 同 escalateFindings）。safeParse 守形（载荷由 writer-node
    // 机械构造，坏形态防御性丢——status 仍 paused，文案退 draft 通用 pause；挂起 ≠ 错误，errors 不计）。
    {
      const research = recordOf(snapshot.artifacts['research_brief']) as
        | { suspended?: unknown }
        | undefined;
      if (research?.suspended !== undefined) {
        const parsed = researchSuspensionSchema.safeParse(research.suspended);
        if (parsed.success) summary.researchSuspension = parsed.data;
      }
    }
    // 链流程重排 W2（R3 终稿 checkpoint 载荷，plan-review M5 字段级清单）：终稿 pause 抽审读摘要 +
    // lint 终态报告——终稿卡据此呈现「AI 自审收敛了几轮、结论如何、去味终态」。verdict = review.latest
    // 审读结论；reasons = route 理由 + 审读 summary（机械投影）；loopCount = snapshot.revisionCount
    // （自审环迭代数，缺省 0）；capExhausted = errors 含 loop cap（终稿 pause 恒 false，保守带出供
    // 消费面同构）。lint digest 见 formatLintReportDigest。
    if (pauseHint?.pausedStage === 'final') {
      const reasons = [routeDecision?.reason, typeof review?.summary === 'string' ? review.summary : '']
        .filter((r): r is string => typeof r === 'string' && r.length > 0);
      summary.reviewSummary = {
        verdict: typeof review?.verdict === 'string' ? review.verdict : '',
        reasons,
        loopCount: typeof snapshot.revisionCount === 'number' ? snapshot.revisionCount : 0,
        capExhausted: (snapshot.errors ?? []).some((e) => e.includes('loop cap')),
      };
      summary.lintReport = formatLintReportDigest(snapshot.artifacts['lint_report']);
    }
  }
  return summary;
}

/**
 * Story 4.3 Step 2：从链定义解析某节点 id 的 checkpointStage（runChapterChain 检测 status='paused' 后，据
 * snapshot.currentNodeId（停在 checkpoint 节点）经 chain 映射出 pausedStage，传给 summarizeRunSnapshot 作
 * pauseHint）。
 *
 * honors design §3.4「pausedStage 从 currentNodeId/checkpointStage 推」——summarize 无 chain 上下文，故
 * runChapterChain（持 chain）解析后以 pauseHint 传值（不耦合 summarize 到具体节点 id 子串，守 CR-13 精神）。
 * 无匹配 / 节点无 checkpointStage → undefined（defensive：pause 只在 checkpoint 节点触发，正常必有匹配）。
 */
export function resolveCheckpointStage(
  chain: ChainNodeDef[],
  nodeId: string | null,
): CheckpointStage | undefined {
  if (!nodeId) return undefined;
  return chain.find((c) => c.id === nodeId)?.checkpointStage;
}

// ── helpers ──

/** error artifact 判定（Step 2 createLlmNode 兜底产出 {error:true,...}；链段不崩，标记 + break）。 */
function isErrorArtifact(artifact: unknown): boolean {
  return Boolean(artifact && typeof artifact === 'object' && (artifact as { error?: unknown }).error === true);
}

/** AbortError 判定（节点内部取消传播；mirror createLlmNode.isAbortError）。 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError';
}

/**
 * 链流程重排（09-13 W1a）：从 through 节点产出读回环 verdict（多环词表单源映射）。
 *
 * 两环 verdict artifact 各有词表：route_decision 用 `.decision`（auto_revise / accept_as_truth /
 * escalate_user——route-agent.yaml 契约）；plan_review 用 `.verdict`（pass / revise / escalate——
 * brief-reviewer 契约，W1c 落地）。本函数把两词表归一为回环处置族：
 * - 'loop'：auto_revise / revise → 回环体重跑（cap 内）。
 * - 'escalate'：escalate_user / escalate → escalate-pause（灰区裁决）。
 * - 'accept'：accept_as_truth → 自审环终态（onAccept + verdict checkpoint）。
 * - 'pass'：pass → 规划环 pass-through（正常前进）。
 * - undefined：字段缺 / 未知值 → **不再防御透传**（CR-10：透传前进 = 把未知判决当 pass 跑完 E 段
 *   = 假 pass 违红线）——caller（through 处理段）响错进 escalate-pause。
 *
 * 范式判据（ADR-3）：纯字符串→处置族的机械映射；「判什么值」归 through 节点 LLM（route 判决 /
 * brief-reviewer 审核裁决），runChain 只执行。
 */
function readLoopVerdict(artifact: unknown): { kind: 'loop' | 'escalate' | 'accept' | 'pass' | undefined; value: string } {
  const rec = recordOf(artifact);
  const value =
    typeof rec?.decision === 'string' && rec.decision.length > 0
      ? rec.decision
      : typeof rec?.verdict === 'string' && rec.verdict.length > 0
        ? rec.verdict
        : '';
  switch (value) {
    case 'auto_revise':
    case 'revise':
      return { kind: 'loop', value };
    case 'escalate_user':
    case 'escalate':
      return { kind: 'escalate', value };
    case 'accept_as_truth':
      return { kind: 'accept', value };
    case 'pass':
      return { kind: 'pass', value };
    default:
      return { kind: undefined, value };
  }
}

/**
 * through artifact 是否说 route 词表（`.decision` 字段在场）——CR-10 未知 verdict 强制升级时定
 * 覆写词汇用（未知值不在任一词表，routeVocab 值判恒 false；按 artifact 实际携带字段归属）。
 */
function speaksRouteVocab(artifact: unknown): boolean {
  const rec = recordOf(artifact);
  return rec !== undefined && typeof rec.decision === 'string' && rec.decision.length > 0;
}

/**
 * CR-1 环入口机械断路器的圈指纹：draft.initial.text（正文本体）+ revision_guard.verdict（护栏判定）。
 * 纯机械读取（范式判据 ✓——不做任何语义判断）；draft.initial.text 非串（未产/坏形态）→ undefined
 * （不判——规划环体内无 draft 天然豁免）。
 */
function revisionLapFingerprint(
  run: RunSnapshot,
): { draftText: string; guardVerdict: string | undefined } | undefined {
  const draft = recordOf(run.artifacts['draft.initial']);
  if (!draft || typeof draft.text !== 'string') return undefined;
  const guard = recordOf(run.artifacts['revision_guard']);
  return {
    draftText: draft.text,
    guardVerdict:
      guard !== undefined && typeof guard.verdict === 'string' ? guard.verdict : undefined,
  };
}

/**
 * 链流程重排（09-13 W1a R4b）：escalate-pause 统一入口（灰区 / 环 cap 超限强制 escalate 共用）。
 *
 * 动作序列：
 * 1. route 词表（escalate_user 家族）先 onAccept 产 chapter_accept（裁决材料候选，D4 v2 对称——
 *    cap-escalate 与 LLM escalate 同形；规划环词表无此步——plan 灰区无章候选语义）。
 * 2. persist-before-pause：经 onCheckpoint（through 节点的 checkpointStage，缺省 'verdict'）触发
 *    persistChainSnapshot（workflow.ts onCheckpoint 闭包 persist 副作用；decision 忽略——escalate-pause
 *    无条件，与 stage 人审暂停的 policy 判定无关）。
 * 3. status='paused' + escalatePause=true（currentNodeId 已停在 through 节点，caller break）。
 */
async function enterEscalatePause(
  run: RunSnapshot,
  def: ChainNodeDef,
  routeVocab: boolean,
  opts: RunChainOptions,
): Promise<void> {
  if (routeVocab && opts.onAccept) {
    const acceptResult = opts.onAccept(run, { nowISO: opts.nowISO ?? '' });
    if (acceptResult && 'chapterId' in acceptResult) {
      run.artifacts['chapter_accept'] = acceptResult;
    }
  }
  if (opts.onCheckpoint) {
    await opts.onCheckpoint(def.checkpointStage ?? 'verdict', run);
  }
  run.status = 'paused';
  run.escalatePause = true;
}

/** 安全取 record（过滤非对象/数组）。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * CR 批 CR-3：through verdict 强制覆写分支（环 cap 超限 / optimizer_failed 强制升级 / CR-10
 * 未知 verdict / CR-1 空转断路）改写 through 产物后的快照重发钩——携带覆写后的 result 调
 * `opts.onVerdictOverwritten`（workflow 注入：经 emitChainNodeArtifactFor 按发射形态表重投影
 * 转 chain-node-artifact 帧——时间线末帧姿态与真实终态一致，wrapper 已发的原始 verdict 帧
 * 如 auto_revise 不再 stale）。回调缺省 no-op（mock 链零回归）；发射失败由消费方 helper
 * 内部兜底（不破链）。
 */
function emitVerdictOverwritten(
  run: RunSnapshot,
  opts: RunChainOptions,
  nodeId: string,
  stateKey: string,
): void {
  if (!opts.onVerdictOverwritten) return;
  opts.onVerdictOverwritten(nodeId, run, { stateKey, artifact: run.artifacts[stateKey] });
}

/**
 * 链流程重排 W2：lint_report artifact 防御性读取（summary 计数 + issues 摘录面；坏形态 → undefined，
 * 消费侧按「无报告」处理）。纯机械投影。
 */
function readLintReport(
  artifact: unknown,
): {
  degraded?: boolean;
  summary: { total: number; high: number; medium: number; low: number };
  issues: Array<{ level?: unknown; title?: unknown; match?: unknown; detail?: unknown }>;
} | undefined {
  const rec = recordOf(artifact);
  if (!rec) return undefined;
  const summary = recordOf(rec.summary) as Record<string, unknown> | undefined;
  if (!summary) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const issues = Array.isArray(rec.issues)
    ? rec.issues.flatMap((i) => {
        const r = recordOf(i);
        return r ? [{ level: r.level, title: r.title, match: r.match, detail: r.detail }] : [];
      })
    : [];
  return {
    ...(rec.degraded === true ? { degraded: true } : {}),
    summary: {
      total: num(summary.total),
      high: num(summary.high),
      medium: num(summary.medium),
      low: num(summary.low),
    },
    issues,
  };
}

/**
 * 链流程重排 W3（R2 去味门禁真判决）：review.latest 是否含 L2 确认的 lint 来源未清条目。
 *
 * 机械判据（判源不判义，范式判据 ADR-3）：dimensions[].findings[] 中 source==='lint'（Reader-Audit
 * 对 lintReport 静态命中清单判真时按 yaml 契约携带的来源标记）且 severity ∈ {block, warn}（info 是
 * 观察非缺陷）→ true。「真伪判断」已由 multi-review L2 完成（静态命中 ≠ 定罪），本函数只读结果标记。
 * review 缺 / dimensions 非 array / 无 lint 确认条目 → false（门禁过——保守采信语义）。
 * CR-5（09-13 CR 修复批）：source 标记须过 isLintSourceMechanicallyConfirmed 机械交叉核对
 * （chapter-nodes 单源 helper——quote/ruleId 对 lint_report 匹配），防 LLM 自报标签直通豁免面；
 * 未核对通过的 lint 声明条目按 agent 来源处理（不计入 lint 门禁信号）。
 */
function hasConfirmedLintFinding(reviewArtifact: unknown, lintReportArtifact?: unknown): boolean {
  const review = recordOf(reviewArtifact);
  if (!review || !Array.isArray(review.dimensions)) return false;
  for (const dim of review.dimensions) {
    const d = recordOf(dim);
    if (!d || !Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      const finding = recordOf(f);
      if (!finding) continue;
      if (finding.source !== 'lint') continue;
      if (finding.severity === 'block' || finding.severity === 'warn') {
        if (!isLintSourceMechanicallyConfirmed(finding, lintReportArtifact)) continue;
        return true;
      }
    }
  }
  return false;
}

/** lint digest 高优命中摘录上限（防终稿卡载荷膨胀；命中形态样例非全量）。 */
const LINT_DIGEST_ISSUE_CAP = 5;

/**
 * 链流程重排 W2（R2 去味门禁）：lint 终态报告 digest（终稿卡 ChapterReviewMetadata.lintReport 源）。
 * 纯机械投影——命中计数 + 高优（high/medium）命中摘录（规则标签 + 命中原句）；degraded = 引擎缺位
 * 占位说明（诚实标注「未扫描」非假零命中）。渲染归子3，本 digest 是载荷非排版。
 */
function formatLintReportDigest(artifact: unknown): string {
  const lint = readLintReport(artifact);
  if (!lint) return '';
  if (lint.degraded === true) {
    return 'lint 引擎缺位（rulesets 装载失败）——本章无去味终态扫描。';
  }
  const { total, high, medium, low } = lint.summary;
  if (total === 0) return '去味终态：0 命中（干净）。';
  const lines = [`去味终态：${total} 条命中（high ${high} / medium ${medium} / low ${low}）。`];
  const top = lint.issues
    .filter((i) => i.level === 'high' || i.level === 'medium')
    .slice(0, LINT_DIGEST_ISSUE_CAP);
  for (const issue of top) {
    const title = typeof issue.title === 'string' ? issue.title : '';
    const match = typeof issue.match === 'string' ? issue.match : '';
    const detail = typeof issue.detail === 'string' ? issue.detail : '';
    lines.push(`  · [${String(issue.level)}] ${title}："${match}"${detail ? `（${detail}）` : ''}`.trimEnd());
  }
  if (high + medium > LINT_DIGEST_ISSUE_CAP) {
    lines.push(`  · ……等 high/medium 共 ${high + medium} 条。`);
  }
  return lines.join('\n');
}

/**
 * Story 4.6：route=escalate_user 时从 Reader-Audit `review.latest.dimensions[].findings` 抽灰区 findings。
 *
 * 过滤 severity=block|warn（drop info 噪声——info 非灰区不需裁决器/用户关注）+ grounding 硬要求（quote/
 * location/explanation 缺则跳过，mirror reviewOutputSchema .min(1)）+ 控量 ≤8（防裁决器 prompt 爆）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：纯机械投影（过滤 + 字段抽取），不判「finding 多严重」
 * （归裁决器 LLM）。
 *
 * Story 8.4 Step 6（A11）：attribution 三态（审核对照归因）随字段透传——裁决器/用户判「正文 vs 计划哪个好」
 * 需知问题出在哪层（执行漏可改稿 / 规划盲需补查 / 计划层缺口须改上游）。枚举单源 shared
 * REVIEW_ATTRIBUTION_VALUES（值外字面量机械丢弃不透传——下游 EscalateFinding type 即契约）。
 */
function extractEscalateFindings(reviewArt: unknown): EscalateFinding[] | undefined {
  const review = recordOf(reviewArt);
  if (!review || !Array.isArray(review.dimensions)) return undefined;
  const findings: EscalateFinding[] = [];
  for (const dim of review.dimensions) {
    const d = recordOf(dim);
    if (!d || !Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      const finding = recordOf(f);
      if (!finding) continue;
      const severity = finding.severity;
      if (severity !== 'block' && severity !== 'warn') continue; // drop info 噪声
      const quote = typeof finding.quote === 'string' ? finding.quote : '';
      const location = typeof finding.location === 'string' ? finding.location : '';
      const explanation = typeof finding.explanation === 'string' ? finding.explanation : '';
      if (!quote || !location || !explanation) continue; // grounding 硬要求（CR-Edge-6：quote/location/explanation 空串均跳过——reviewOutputSchema 对 explanation 无 .min(1)，抽取严于 schema 是有意的 grounding 要求）
      if (findings.length >= 8) return findings; // 控量（防裁决器 prompt 爆）
      const attribution = REVIEW_ATTRIBUTION_VALUES.find((v) => v === finding.attribution);
      findings.push({
        severity,
        quote,
        location,
        explanation,
        ...(typeof finding.subClass === 'string' ? { subClass: finding.subClass } : {}),
        ...(attribution !== undefined ? { attribution } : {}),
      });
    }
  }
  return findings.length > 0 ? findings : undefined;
}

/** 累积错误到 run.errors（additive，不覆盖）。 */
function pushError(run: RunSnapshot, message: string): void {
  if (!run.errors) run.errors = [];
  run.errors.push(message);
}

/**
 * abort 时持久 checkpoint（design §4.1/§4.6）。
 * 调 onCheckpoint（若提供 + 有 lastStage）让 Step 5 runChapterChain 把 chainSnapshot 写入 RunStateStore
 * （resume 恢复 artifacts + completedNodes）。无 lastStage（abort 在任何 checkpoint 前）→ 不调（无 stage 可持久）。
 *
 * Story 4.3 Step 2：onCheckpoint 已升 async 返 CheckpointDecision，但 abort 路径**不能 await**（紧接着 throw
 * ChainAbortedError）。fire-and-forget：persistChainSnapshot 体同步执行（runState.setChainSnapshot 同步），
 * 故在 async 闭包 yield 前已完成持久（与 4.0 fire-and-forget 行为一致）。`void` 弃 Promise（决策被忽略——abort 中，
 * pause/continue 无意义）。design §6 「onCheckpoint async：保留 fire-and-forget 兜底」。
 */
function emitAbortCheckpoint(
  run: RunSnapshot,
  lastStage: CheckpointStage | undefined,
  opts: RunChainOptions,
  sessionId: string,
): void {
  // dogfood R2 #105 R2.5：abort 出口留痕（sessionId + 中断时节点 + 最近 checkpoint stage）——
  // 修前 abort 路径全线零日志（「中断原因未上日志」诊断盲区）。只记不重试，abort 语义不变。
  // sessionId = 链段 child session（runChain 作用域唯一 id 源）；projectPath 是跨层日志（workflow
  // 守卫/收口日志）可对齐的 join key。
  logger.info(
    { sessionId, projectPath: run.projectPath, currentNodeId: run.currentNodeId, lastCheckpointStage: lastStage },
    'chapter chain aborted — emitting checkpoint for resume',
  );
  if (lastStage && opts.onCheckpoint) {
    void opts.onCheckpoint(lastStage, run);
  }
}

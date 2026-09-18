import type { LintChapterReport, ReusableAgentNodeContract } from '@orison/shared-contracts';
import type { AgentNode, NodeResult, NodeRunInput } from '../contracts/run';
import {
  getLintEngine,
  LINT_UPSTREAM_COMMIT,
  LINT_UPSTREAM_REPO,
  type LintEngine,
} from '../lint/lintEngine';
import { LLMLINT_VERSION } from '../lint/vendor/llmlint/src/version';
import { logger } from '../logger';

// ── C1.2 R6（design §3.1）：lint-node 链段静态扫描节点（纯代码，无 LLM / 无 db / 无文件写）──
//
// chapter-chain 链段纯代码节点（mirror emotion-verify-node / storytime-drift-node 先例）：
// 读 `draft.initial`（revision-guard splice 后落定的终版章正文）→ llmlint 静态引擎（vendored，
// regex 词法 + density 密度指纹 + handler 算法，零 LLM）扫描 → 产 `lint_report` artifact
// （review=agent 桶 LintChapterReport，喂 multi-review L2 叙事特征维作 L1 同族软信号，design §3.2）。
//
// **链位理由（design §3.1；链流程重排 W1d 后 = 自审环 C4）**：挂 revision-guard-agent 紧后、
// multi-review 前——
// 1. draft.initial 在 revision-guard splice 后才落定（段落级模式），此前扫的是「改前整章+改后段」
//    混合形态，非终版正文。
// 2. **每圈跑**（提取段后移后本节点在自审环体 [revision-optimizer..route] 内）：auto_revise 每圈
//    重扫改后稿（lint_report 覆盖重写零副作用——纯函数 over artifacts），终圈 report 即终稿去味
//    终态（C7 route 出环门禁 / 终稿 checkpoint 载荷的数据源，W3 落判据）。
//
// **范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）**：本节点 = 纯代码确定性定位
// （静态规则扫文字痕迹，不理解意义）；命中真假与修复方向 = 语义判断，归 multi-review L2 / 作者
// （「locate with rules, fix with judgment」，规则命中 ≠ 定罪）。
//
// graceful（mirror Reader-Audit L1「失败降级不崩链」先例，chapter-nodes.ts:540）：引擎缺位
// （getLintEngine null——rulesets 装载失败）/ draft 缺位 / 扫描异常 → 空 report 降级，链照跑
// （lint 是增强软信号非硬约束，降级只意味着本章无 lint 软信号，multi-review 回 stylometry-only 现状）。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror emotion-verify / storytime-drift 先例，经
// createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]。**不写库不写文件**——链段内
// lint_report 是链段 artifact（RunSnapshot 流转）；终稿持久账归 write_chapter post-settle
// （`.orison/lint/<chapterId>.json`，design §3.3）。
//
// ⚠ 生产 rulesets 路径注意（check 验收留本 story）：lintEngine 默认经 import.meta.url 定位
// vendored rulesets（dev/test 下正确；生产 Electron 打包下可能失配——与 agentPrompt.ts 同款已知
// 问题）。**本节点不硬编码路径**，保持引擎缺省初始化；生产 packaging 的显式路径解析归 Step 7
// shell lintIpc wiring（loadLintEngine(config) 显式传路径），届时引擎缺位 → 本节点空 report 降级不崩。
//
// expected_downstream_consumers（interface-contracts 纪律）：
// - multi-review L2（Story C1.2 §3.2）：Reader-Audit composite 机会主义读 lint_report →
//   agent 桶聚合封顶投影注入 L2 prompt（规则不单独定罪）。
// - write_chapter post-settle（§3.3）：独立重扫终稿账（不经本 artifact，避免 redo 中间态污染）。

/** 节点产出 artifact key（链段，mirror route_decision / storytime_drift 形态，非 creative field）。 */
export const LINT_REPORT_KEY = 'lint_report';

const LINT_NODE_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'lint-node',
  displayName: 'Lint Static Scan Node',
  inputSchemaName: 'lintScanInput',
  outputSchemaName: 'lintChapterReport',
  // draft.initial 必填门：lint 扫的是终版章正文，无正文即无扫描意义。链位上 draft-writer /
  // revision-guard（idx 1-2）恒先产 draft.initial，链段实际运行不会 blocked；bypass 直测路径
  // 缺 draft 时 run() 内 graceful 降级空 report（不依赖 chainRunner 拦截）。
  requiredArtifactKeys: ['draft.initial'],
  producedArtifactKeys: [LINT_REPORT_KEY],
  // 纯代码扫描无副作用（引擎只读 vendored 静态数据；无 'none' 项，最小诚实面用空数组，mirror
  // storytime-drift-node sideEffects: [] 先例）。
  sideEffects: [],
};

/**
 * 降级空 report（schema 合法形态——引擎缺位/异常/draft 缺位时产，链照跑）。
 *
 * degraded: true（CR-007）：**issues 空 ≠ 干净章**——本 report 是降级产物，消费侧（C1.3 统计、
 * ±20% 篇幅护栏基线）必须排除；visibleChars 诚实保 0（引擎没跑不算字数，不用真跑结果才有的
 * 字数伪造完整）。upstream 填静态溯源常量（描述 vendored 规则库来源，非装载成功声明）；
 * 消费侧 lintReport 投影 findings 空 → L2 跳过 lint 段。
 */
function emptyLintChapterReport(chapterId: string): LintChapterReport {
  return {
    chapterId,
    issues: [],
    densityIssues: [],
    summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: 0 },
    upstream: { repo: LINT_UPSTREAM_REPO, commit: LINT_UPSTREAM_COMMIT, ruleVersion: LLMLINT_VERSION },
    degraded: true,
  };
}

/** lint-node deps（可选注入，mirror Reader-Audit DI seams——生产缺省走 getLintEngine 单例）。 */
export interface LintNodeDeps {
  /** 引擎装载器（测试注入 null/坏引擎验降级路径）；缺省 getLintEngine（进程级单例）。 */
  getEngine?: () => Promise<LintEngine | null>;
}

/**
 * 从 chapter_brief_input artifact 解析 chapterId（episodeId，mirror emotion-verify /
 * storytime-drift resolveEpisodeId——同形内联第 N 消费者，保持内联不抽公共件）。缺 → 'chain'
 * （report schema 要求非空 chapterId；链段内无更优章节标识时用链段兜底标识）。
 */
function resolveChapterId(chapterBriefInput: unknown): string {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return 'chain';
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return 'chain';
}

/**
 * 构造 lint 静态扫描节点（纯代码，无 LLM，design §3.1）。
 *
 * run 流程：
 *  1. 解析 chapterId（chapter_brief_input.episodeId → LintChapterReport.chapterId 定位锚）。
 *  2. 读 `draft.initial`.text（revision-guard splice 后终版正文）；缺/空 → 空 report 降级。
 *  3. `await getLintEngine()`（**async**：loadRules 走 node:fs/promises，单例缓存一次装载）；
 *     null（rulesets 装载失败）→ 空 report 降级。
 *  4. scanText（全量桶）→ filterByReview('agent')（design §2「scan 一次、投影两次」：链段内消费
 *     agent 桶；report 面全量桶归 post-settle / lintIpc 独立重扫）→ 产 `lint_report`。
 *
 * 全程 try/catch 兜底（mirror Reader-Audit L1 E1 哲学）：任何异常 → 空 report，永不 error
 * artifact / 永不阻断链（lint 是增强非硬约束）。
 */
export function createLintNode(deps: LintNodeDeps = {}): AgentNode {
  const getEngine = deps.getEngine ?? getLintEngine;
  return {
    contract: LINT_NODE_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;
      const chapterId = resolveChapterId(run.artifacts['chapter_brief_input']);

      try {
        // ── 1-2. draft.initial 正文（终版，revision-guard splice 后）──
        const draft = run.artifacts['draft.initial'];
        const text =
          draft && typeof draft === 'object' && !Array.isArray(draft)
            ? String((draft as { text?: unknown }).text ?? '')
            : '';
        if (!text) {
          logger.warn(
            { nodeId: 'lint-node', runId: run.runId },
            'lint-node: draft.initial text missing/empty → degrade to empty lint_report (chain continues)',
          );
          return { stateKey: LINT_REPORT_KEY, artifact: emptyLintChapterReport(chapterId) };
        }

        // ── 3. 引擎（async 单例；null = rulesets 装载失败 → 降级）──
        const engine = await getEngine();
        if (!engine) {
          logger.warn(
            { nodeId: 'lint-node', runId: run.runId },
            'lint-node: lint engine unavailable (rulesets load failed?) → degrade to empty lint_report (chain continues)',
          );
          return { stateKey: LINT_REPORT_KEY, artifact: emptyLintChapterReport(chapterId) };
        }

        // ── 4. 扫描 + agent 桶投影 → lint_report artifact（链段，非 creative field）──
        const full = engine.scanText(text, { chapterId });
        const agentBucket = engine.filterByReview(full, 'agent');
        return { stateKey: LINT_REPORT_KEY, artifact: agentBucket };
      } catch (err) {
        // defensive：引擎调用/投影异常 → 空 report（违「不崩链」承诺须兜底，mirror emotion-verify
        // runEmotionVerify try/catch 先例）。
        logger.warn(
          {
            nodeId: 'lint-node',
            runId: run.runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'lint-node: scan threw → degrade to empty lint_report (chain continues)',
        );
        return { stateKey: LINT_REPORT_KEY, artifact: emptyLintChapterReport(chapterId) };
      }
    },
  };
}

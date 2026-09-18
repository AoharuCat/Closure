import type {
  ChainNodeArtifactData,
  ChainNodeArtifactSummary,
  ChainToolEventData,
  ChainNodeDonePauseKind,
} from './chainStreamBuffer';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子2 CR 批（CR-6）：UI 镜像漂移守卫——双文件 fixture 对拍（UI 侧副本）。
//
// 本文件是 agent 侧 fixture（apps/desktop/agent/test/fixtures/chainObservabilitySamples.ts，
// 注解锚 agent 类型单源）的**逐字节镜像副本**，注解锚本包镜像类型（chainStreamBuffer.ts）。
// 本文件在 src/ 内 → ui tsconfig（include src/**）即编译 gate；deep-equal 对拍测试在 agent
// 侧 test/chain-observability-mirror.test.ts（agent vitest 跨包加载本文件——type-only
// import 擦除后纯数据，零运行时依赖）。
//
// 漂移链：agent 类型改 → agent fixture 注解红（agent typecheck）→ fixture 数据改 →
// 对拍红（≠本副本）→ 本副本同步改 → 本注解红（ui 镜像 stale）→ 镜像同步。反向（本包镜像
// 改）同理对称。⚠ 两文件数据必须保持 deep-equal——改任一侧先读另一侧。
// ─────────────────────────────────────────────────────────────────────────────

export const ARTIFACT_SUMMARY_SAMPLES: readonly ChainNodeArtifactSummary[] = [
  { kind: 'brief-card', brief: { goal: '抵达 B 城', tone: '紧张' } },
  {
    kind: 'items',
    label: 'physical 轴提取：3 条状态变化 · 1 主体',
    items: ['char:lin /位置 replace——林昭抵达 B 城'],
    total: 3,
  },
  {
    kind: 'findings',
    verdict: 'revise',
    summary: '开篇意象重复',
    findings: [{ label: 'consistency/memory', severity: 'block', quote: '黄昏的荒野', note: '开篇意象重复' }],
    total: 1,
  },
  { kind: 'route-decision', decision: 'escalate_user', reason: '视角丢失灰区' },
  { kind: 'line', line: '整章交付《第二章 B 城》：2800 字' },
];

export const ARTIFACT_DATA_SAMPLES: readonly ChainNodeArtifactData[] = [
  // 纯代码位（无流）= seq -1（计数器算术零点）；line kind 通用行形态。
  { nodeId: 'brief-compiler-node', role: 'brief-compiler-node', seq: -1, summary: { kind: 'line', line: 'x' } },
  // 开流位（环重跑第二圈）= seq ≥0；items kind 截断形态（items 封顶 / total 保全量）。
  {
    nodeId: 'draft-writer-agent',
    role: 'draft-writer-agent',
    seq: 2,
    summary: {
      kind: 'items',
      label: 'Promise 涌现登记：60 项（已落盘）',
      items: ['add_beat · b1'],
      total: 60,
    },
  },
];

export const TOOL_EVENT_SAMPLES: readonly ChainToolEventData[] = [
  // ok + resultCount（发射侧恒携带——输出字符数恒档）。
  { nodeId: 'draft-writer-agent', toolName: 'query_story', inputSummary: '{"query":"林昭","topK":5}', resultCount: 1200, status: 'ok' },
  // error 且 resultCount 缺席形态（消费面容错档——事件类型 optional）。
  { nodeId: 'draft-writer-agent', toolName: 'no_such_tool', inputSummary: '{}', status: 'error' },
];

export const PAUSE_KIND_SAMPLES: readonly ChainNodeDonePauseKind[] = [
  'final',
  'escalate',
  'brief',
  'draft',
  'revision-guard',
];

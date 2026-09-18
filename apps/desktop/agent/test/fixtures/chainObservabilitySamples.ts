import type {
  ChainNodeArtifactData,
  ChainNodeArtifactSummary,
  ChainToolEventData,
  ChainNodeDonePauseKind,
} from '../../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子2 CR 批（CR-6）：UI 镜像漂移守卫——双文件 fixture 对拍（agent 侧锚）。
//
// 三新类型（ChainNodeArtifactSummary / ChainToolEventData / ChainNodeDonePauseKind）在
// client/ui/src/shared/store/chainStreamBuffer.ts 是手抄镜像（UI 包不依赖 agent 包——
// 跨包 import 会拖 agent 类型图进 ui tsc，pino/zod-to-json-schema 等 ui 缺依赖）。此前同步
// 仅注释承诺；本对拍机制钉死：
//
// - **本文件** = agent 类型单源侧样本（本注解即编译锚；gate = tsconfig.fixtures.json，
//   挂 agent package typecheck script——agent 主 tsconfig 不含 test/，须专用 gate）。
// - **UI 侧副本** = client/ui/src/shared/store/chainObservabilityMirror.samples.ts
//   （注解锚 ui 镜像类型；ui tsconfig 含 src/** 全量，天然 gate）。
// - **对拍测试** = test/chain-observability-mirror.test.ts（deep-equal——两侧任一漂移即红，
//   强制两文件同步改）。
//
// 数据要求：纯 JSON 形（跨包加载 structured-clone 安全）、覆盖五 kind + tool（±resultCount）
// + 全五 pauseKind + artifact data（seq -1 / ≥0 两档）。改任一侧顺序：先改本文件（agent
// 类型 gate 红）→ 对拍红 → 同步 ui 副本 → ui 镜像类型 gate（镜像 stale 则编译红）。
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

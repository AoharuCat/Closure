// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子3 W5（design §1.3/§4）：审阅相位纯投影层。
//
// 组件与测试共用同一实现（零复制粘贴）。纯函数、无 store 依赖。
//
// - `resolveReviewPauseKind`：观察链 paused 时按数据键派生暂停卡形态（design §4.2「卡随
//   pauseKind 切换」）。**pauseKind 事件字段不持久化**（chainTimeline/chainStreamBuffer 的
//   事件面 W2 起只透传不存——哨兵 pauseKind 五值与数据键一一对应：stage='final'→final、
//   researchSuspension→挂起、stage='brief'→brief、stage='revision-guard'→guard、
//   escalate-pause 无 pausedReview 但 escalateFindingsBySession 有键→escalate）。
//   两键皆缺 = stub 链（dogfood 直跑链——降级卡兜底）。
// - `countEditRegions`：终稿手改计数（「携 N 处手改」——纯 UI 计数非 diff 渲染）。行级贪心
//   对齐（mirror SideBySideDiff computeDiff 的 lookahead-10 先例），连续变更行并作一处——
//   散点多段手改各计一处。O(n·10) 行扫描无 DP 表（整章规模安全，无长度闸需求）。
// - `synthesizeEscalateFeedback`：escalate 勾选合成结构化 feedback（D-d——固定中文：
//   LLM 载荷非 UI 铬件，mirror write-chapter 中文反馈串先例）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ChapterReviewMetadata } from '@orison/shared-contracts';
import type { EscalateFindingsEntry, EscalateFindingsItem } from '../../shared/store/chainTimeline';

/** 审阅相位暂停卡形态（design §4.2 五暂卡 + stub 降级 + CR-10 临时 pending 占位）。 */
export type ReviewPauseKind = 'final' | 'escalate' | 'brief' | 'suspension' | 'guard' | 'draft' | 'stub' | 'pending';

/**
 * CR-10（09-18 CR 批 B）：pending 窗宽——哨兵 paused 帧先于 chapter_review metadata 到达的
 * 传输窗（生产链两帧几乎同至；stub 车道永无 metadata）。超窗仍归 stub。
 */
export const PENDING_PAUSE_WINDOW_MS = 8000;

/**
 * 观察链 paused 时的卡片形态派生。未 paused → null（相位机不进审阅）。
 *
 * escalate 键的空 items = 「已审核」锚点（chainTimeline 路由语义——后续空审核结果让旧卡降级），
 * 不构成待裁决载荷 → 归 stub 降级卡。pausedReview 优先于 escalateFindings（chapter_review 与
 * findings 是同一 write_chapter 结果上的互斥 metadata；CR-003 清 stale 面维持互斥）。
 *
 * CR-10：两键皆缺且链**刚**从 running 转 paused（updatedAt 距今 < 窗宽）→ 临时 `pending`
 * （chapter_review metadata 大概率在途——渲染「正在准备审阅…」占位，防生产链 stub 卡瞬闪）；
 * 超窗仍未到 = 真 stub 链（dogfood 直跑车道，无 checkpoint 事件面）→ 降级卡。窗口参数缺席
 * （旧调用方/测试）保持纯键判定不猜时间——back-compat 恒 stub。
 */
export function resolveReviewPauseKind(input: {
  paused: boolean;
  pausedReview: ChapterReviewMetadata | undefined;
  escalateFindings: EscalateFindingsEntry | undefined;
  /** paused 链的 run.updatedAt（哨兵 paused 帧时间戳；缺席 = 窗口不可判，不进 pending）。 */
  pausedUpdatedAt?: number;
  /** 当前时钟（调用方 Date.now()——纯函数不取墙钟，测试可注）。 */
  now?: number;
}): ReviewPauseKind | null {
  if (!input.paused) return null;
  const review = input.pausedReview;
  if (review) {
    if (review.stage === 'final') return 'final';
    if (review.researchSuspension !== undefined) return 'suspension';
    if (review.stage === 'brief') return 'brief';
    if (review.stage === 'revision-guard') return 'guard';
    return 'draft'; // legacy draft/verdict 快照（链重排后停点退役，旧载荷防御）
  }
  if (input.escalateFindings && input.escalateFindings.items.length > 0) return 'escalate';
  const { pausedUpdatedAt, now } = input;
  if (pausedUpdatedAt !== undefined && now !== undefined) {
    const since = now - pausedUpdatedAt;
    if (Number.isFinite(since) && since >= 0 && since < PENDING_PAUSE_WINDOW_MS) return 'pending';
  }
  return 'stub';
}

/**
 * 终稿手改计数：edited vs original 的变更处数（连续变更块 = 一处）。
 * 全等 → 0。行级贪心对齐（lookahead-10，computeDiff 同款启发式——无 DP 表，整章规模安全）。
 */
export function countEditRegions(original: string, edited: string): number {
  if (original === edited) return 0;
  const a = original.split('\n');
  const b = edited.split('\n');
  let i = 0;
  let j = 0;
  let regions = 0;
  let inRegion = false;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      inRegion = false;
      continue;
    }
    // lookahead：本行在对方序列近处出现 → 跳过的行按删除/插入计（成块收敛）。
    let foundI = -1;
    let foundJ = -1;
    for (let k = 1; k < 10; k++) {
      if (i + k < a.length && a[i + k] === b[j]) { foundI = i + k; break; }
      if (j + k < b.length && a[i] === b[j + k]) { foundJ = j + k; break; }
    }
    if (foundI > 0) {
      while (i < foundI) {
        i++;
        if (!inRegion) { regions++; inRegion = true; }
      }
    } else if (foundJ > 0) {
      while (j < foundJ) {
        j++;
        if (!inRegion) { regions++; inRegion = true; }
      }
    } else {
      if (i < a.length) i++;
      if (j < b.length) j++;
      if (!inRegion) { regions++; inRegion = true; }
    }
  }
  return regions;
}

/**
 * escalate 勾选合成结构化 feedback（design §4.2 / D-d「勾选即意见」）。
 *
 * 格式：`#N [quote 摘] 接受为真相；#M [quote 摘] 修订` + 补充说明尾行（有则）。忽略项与未勾项
 * 不出现（忽略 = 不给 AI 该条的处置信息——redo 后该 finding 语义上仍成立由作者自担）。
 * quote 截断 30 字（feedback 是 LLM 载荷非展示面，保可辨识即可）。
 */
export function synthesizeEscalateFeedback(
  items: EscalateFindingsItem[],
  picks: Array<'accept' | 'revise' | 'ignore' | undefined>,
  supplement: string,
): string {
  const parts: string[] = [];
  items.forEach((item, idx) => {
    const pick = picks[idx];
    if (pick !== 'accept' && pick !== 'revise') return;
    const quote = item.quote.length > 30 ? `${item.quote.slice(0, 30)}…` : item.quote;
    parts.push(`#${idx + 1} [${quote}] ${pick === 'accept' ? '接受为真相' : '修订'}`);
  });
  const base = parts.join('；');
  const extra = supplement.trim();
  return extra ? `${base}\n补充说明：${extra}` : base;
}

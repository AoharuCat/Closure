/**
 * 手艺卡/蒸馏管线管理面 API shell（E10.2b W5）——mirror shared/api/materials.ts：一切
 * IPC 经 preload 桥 `window.orisonDesktop` 走，组件/slice 只调本文件（module-structure
 * invariant：IPC 走 shared/api）。
 *
 * 契约单源：packages/shared-contracts/src/ipc.ts「E10.2b Wave 1」段（11 invoke 通道 +
 * craft:distill-progress 推送；载荷类型全从 @orison/shared-contracts import）。
 *
 * 🔑 **窄投影 belt（W5 三层同步收口后的形态）**：十一方法已全量落进 OrisonDesktopApi +
 * preload（W5 合入后本文件曾用的「过渡 seam 本地声明」已收编——Pick 现锚定全部 11 invoke
 * 方法）。保留窄投影类型不直接用 OrisonDesktopApi 整体：组件/slice 经本文件编译期只看见
 * 手艺面方法面（防误用邻界面）；方法缺失**显式报错**（mirror worldState.ts #5+#102+#210
 * 纪律——绝不 `?? null` 伪装成「成功但空」），错误消息稳定，测试断言全等勿改文案。
 */
import type {
  CraftCard,
  CraftCardListInput,
  CraftCardPatchInput,
  CraftCardPatchResult,
  CraftCardReviewInput,
  CraftCardReviewResult,
  CraftCardSummary,
  CraftDistillLedger,
  CraftDistillProgressEvent,
  CraftDistillRunInput,
  CraftDistillRunResult,
  CraftDistillStatusInput,
  CraftMergeReview,
  CraftMergeReviewListInput,
  CraftMergeReviewResolveInput,
  CraftMergeReviewResolveResult,
  CraftTerm,
  CraftTermApproveResult,
  CraftTermListInput,
  CraftTermMergeInput,
  CraftTermMergeResult,
  OrisonDesktopApi,
} from '@orison/shared-contracts';

/**
 * 手艺面桥投影（窄投影 belt——详文件头注记）：11 invoke 方法全量 Pick 自 OrisonDesktopApi
 * （签名漂移由 W7 全树 typecheck 收口）+ progress 订阅面（on* 前缀 mirror onMaterialChanged）。
 */
type CraftBridgeFace = Pick<
  OrisonDesktopApi,
  | 'craftDistillRun'
  | 'craftDistillStatus'
  | 'craftCardList'
  | 'craftCardGet'
  | 'craftCardPatch'
  | 'craftCardReview'
  | 'craftMergeReviewList'
  | 'craftMergeReviewResolve'
  | 'craftTermList'
  | 'craftTermApprove'
  | 'craftTermMerge'
> & {
  /** craft:distill-progress 推送订阅（preload 包装——返回退订函数，只移除本监听器）。 */
  onCraftDistillProgress(callback: (event: CraftDistillProgressEvent) => void): () => void;
};

/** 调用时取桥（勿模块级捕获——测试在 beforeEach 里装 window.orisonDesktop，晚于模块加载）。 */
function craftBridge(): CraftBridgeFace {
  return window.orisonDesktop as unknown as CraftBridgeFace;
}

export function listCraftCards(input: CraftCardListInput): Promise<CraftCardSummary[]> {
  const bridge = craftBridge();
  if (!bridge?.craftCardList) throw new Error('desktop bridge unavailable');
  return bridge.craftCardList(input);
}

export function getCraftCard(cardId: string): Promise<CraftCard | null> {
  const bridge = craftBridge();
  if (!bridge?.craftCardGet) throw new Error('desktop bridge unavailable');
  return bridge.craftCardGet({ cardId });
}

export function patchCraftCardApi(input: CraftCardPatchInput): Promise<CraftCardPatchResult> {
  const bridge = craftBridge();
  if (!bridge?.craftCardPatch) throw new Error('desktop bridge unavailable');
  return bridge.craftCardPatch(input);
}

export function reviewCraftCardApi(input: CraftCardReviewInput): Promise<CraftCardReviewResult> {
  const bridge = craftBridge();
  if (!bridge?.craftCardReview) throw new Error('desktop bridge unavailable');
  return bridge.craftCardReview(input);
}

export function listCraftMergeReviews(
  input: CraftMergeReviewListInput,
): Promise<CraftMergeReview[]> {
  const bridge = craftBridge();
  if (!bridge?.craftMergeReviewList) throw new Error('desktop bridge unavailable');
  return bridge.craftMergeReviewList(input);
}

export function resolveCraftMergeReviewApi(
  input: CraftMergeReviewResolveInput,
): Promise<CraftMergeReviewResolveResult> {
  const bridge = craftBridge();
  if (!bridge?.craftMergeReviewResolve) throw new Error('desktop bridge unavailable');
  return bridge.craftMergeReviewResolve(input);
}

export function listCraftTerms(input: CraftTermListInput): Promise<CraftTerm[]> {
  const bridge = craftBridge();
  if (!bridge?.craftTermList) throw new Error('desktop bridge unavailable');
  return bridge.craftTermList(input);
}

export function approveCraftTermApi(termId: string): Promise<CraftTermApproveResult> {
  const bridge = craftBridge();
  if (!bridge?.craftTermApprove) throw new Error('desktop bridge unavailable');
  return bridge.craftTermApprove({ termId });
}

export function mergeCraftTermApi(input: CraftTermMergeInput): Promise<CraftTermMergeResult> {
  const bridge = craftBridge();
  if (!bridge?.craftTermMerge) throw new Error('desktop bridge unavailable');
  return bridge.craftTermMerge(input);
}

export function runCraftDistillApi(input: CraftDistillRunInput): Promise<CraftDistillRunResult> {
  const bridge = craftBridge();
  if (!bridge?.craftDistillRun) throw new Error('desktop bridge unavailable');
  return bridge.craftDistillRun(input);
}

export function getCraftDistillStatus(input: CraftDistillStatusInput): Promise<CraftDistillLedger[]> {
  const bridge = craftBridge();
  if (!bridge?.craftDistillStatus) throw new Error('desktop bridge unavailable');
  return bridge.craftDistillStatus(input);
}

/**
 * craft:distill-progress 订阅（slice 引导期挂）。桥缺面（旧 preload / shell wave 未合）
 * 返回 null——slice 静默跳过（mirror materialsSlice onMaterialChanged 桥缺面形态），
 * 读侧兜底 = distill-status 拉取 + 打开 force 补偿。
 */
export function subscribeCraftDistillProgress(
  callback: (event: CraftDistillProgressEvent) => void,
): (() => void) | null {
  const bridge = craftBridge();
  if (typeof bridge?.onCraftDistillProgress !== 'function') return null;
  try {
    return bridge.onCraftDistillProgress(callback);
  } catch {
    // 半残桥吞错可重试（mirror subscribeWorldEvents #12）。
    return null;
  }
}

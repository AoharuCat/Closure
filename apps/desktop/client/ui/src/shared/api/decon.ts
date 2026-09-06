/**
 * 拆解管线控制面 API shell（E10.3b W6）——mirror shared/api/craft.ts：一切 IPC 经 preload 桥
 * `window.orisonDesktop` 走，组件/slice 只调本文件（module-structure invariant：IPC 走
 * shared/api）。
 *
 * 契约单源：packages/shared-contracts/src/ipc.ts「E10.3a W6」+「E10.3b W1」段（十 invoke 通道
 * + decon:progress 推送；载荷类型全从 @orison/shared-contracts import——preload sandbox 纪律
 * 同 craft.ts）。十方法已全量落 OrisonDesktopApi + preload（并行 W5 波合入后本文件曾用的
 * 「过渡 seam 本地声明」已收编——Pick 直锚，签名漂移由全树 typecheck 收口）。
 */
import type {
  DeconApproveReviewInput,
  DeconApproveReviewResult,
  DeconConfirmRerunInput,
  DeconConfirmRerunResult,
  DeconCreateInput,
  DeconCreateResult,
  DeconDeleteResult,
  DeconExportStyleInput,
  DeconExportStyleResult,
  DeconJob,
  DeconJobDetail,
  DeconListInput,
  DeconProductsInput,
  DeconProductsResult,
  DeconProgressEvent,
  DeconReportsInput,
  DeconReportsResult,
  DeconStartInput,
  DeconStartResult,
  DeconTransitionResult,
  OrisonDesktopApi,
} from '@orison/shared-contracts';

/**
 * 拆书面桥投影（窄投影 belt——详文件头注记）：十 invoke 方法全量 Pick 自 OrisonDesktopApi
 * （签名漂移由全树 typecheck 收口）+ progress 订阅面（on* 前缀 mirror onMaterialChanged）。
 * 方法缺失显式报错（mirror craft.ts 纪律——绝不 `?? null` 伪装「成功但空」）。
 */
type DeconBridgeFace = Pick<
  OrisonDesktopApi,
  | 'deconCreate'
  | 'deconStart'
  | 'deconPause'
  | 'deconCancel'
  | 'deconDelete'
  | 'deconGet'
  | 'deconList'
  | 'deconApproveReview'
  | 'deconConfirmRerun'
  | 'deconProducts'
  | 'deconReports'
  | 'deconExportStyle'
> & {
  /** decon:progress 推送订阅（preload 包装——返回退订函数，只移除本监听器）。 */
  onDeconProgress(callback: (event: DeconProgressEvent) => void): () => void;
};

/** 调用时取桥（勿模块级捕获——测试在 beforeEach 里装 window.orisonDesktop，晚于模块加载）。 */
function deconBridge(): DeconBridgeFace {
  return window.orisonDesktop as unknown as DeconBridgeFace;
}

export function createDecon(input: DeconCreateInput): Promise<DeconCreateResult> {
  const bridge = deconBridge();
  if (!bridge?.deconCreate) throw new Error('desktop bridge unavailable');
  return bridge.deconCreate(input);
}

export function startDecon(input: DeconStartInput): Promise<DeconStartResult> {
  const bridge = deconBridge();
  if (!bridge?.deconStart) throw new Error('desktop bridge unavailable');
  return bridge.deconStart(input);
}

export function pauseDecon(jobId: string): Promise<DeconTransitionResult> {
  const bridge = deconBridge();
  if (!bridge?.deconPause) throw new Error('desktop bridge unavailable');
  return bridge.deconPause({ jobId });
}

export function cancelDecon(jobId: string): Promise<DeconTransitionResult> {
  const bridge = deconBridge();
  if (!bridge?.deconCancel) throw new Error('desktop bridge unavailable');
  return bridge.deconCancel({ jobId });
}

export function deleteDecon(jobId: string): Promise<DeconDeleteResult> {
  const bridge = deconBridge();
  if (!bridge?.deconDelete) throw new Error('desktop bridge unavailable');
  return bridge.deconDelete({ jobId });
}

export function getDecon(jobId: string): Promise<DeconJobDetail | null> {
  const bridge = deconBridge();
  if (!bridge?.deconGet) throw new Error('desktop bridge unavailable');
  return bridge.deconGet({ jobId });
}

export function listDeconJobs(input: DeconListInput = {}): Promise<DeconJob[]> {
  const bridge = deconBridge();
  if (!bridge?.deconList) throw new Error('desktop bridge unavailable');
  return bridge.deconList(input);
}

export function approveDeconReview(input: DeconApproveReviewInput): Promise<DeconApproveReviewResult> {
  const bridge = deconBridge();
  if (!bridge?.deconApproveReview) throw new Error('desktop bridge unavailable');
  return bridge.deconApproveReview(input);
}

/** stale 确认重跑（W7 小补③——刷新指纹 + 复位产物后 shell 侧自动 start 续跑）。 */
export function confirmRerunDecon(input: DeconConfirmRerunInput): Promise<DeconConfirmRerunResult> {
  const bridge = deconBridge();
  if (!bridge?.deconConfirmRerun) throw new Error('desktop bridge unavailable');
  return bridge.deconConfirmRerun(input);
}

export function fetchDeconProducts(input: DeconProductsInput): Promise<DeconProductsResult> {
  const bridge = deconBridge();
  if (!bridge?.deconProducts) throw new Error('desktop bridge unavailable');
  return bridge.deconProducts(input);
}

export function fetchDeconReports(input: DeconReportsInput): Promise<DeconReportsResult> {
  const bridge = deconBridge();
  if (!bridge?.deconReports) throw new Error('desktop bridge unavailable');
  return bridge.deconReports(input);
}

export function exportDeconStyle(input: DeconExportStyleInput): Promise<DeconExportStyleResult> {
  const bridge = deconBridge();
  if (!bridge?.deconExportStyle) throw new Error('desktop bridge unavailable');
  return bridge.deconExportStyle(input);
}

/**
 * decon:progress 订阅（slice 引导期挂）。桥缺面（旧 preload / 壳波未合）返回 null——slice
 * 静默跳过（mirror craft.ts subscribeCraftDistillProgress），读侧兜底 = decon:list/get 拉取 +
 * 打开 force 补偿。
 */
export function subscribeDeconProgress(
  callback: (event: DeconProgressEvent) => void,
): (() => void) | null {
  const bridge = deconBridge();
  if (typeof bridge?.onDeconProgress !== 'function') return null;
  try {
    return bridge.onDeconProgress(callback);
  } catch {
    // 半残桥吞错可重试（mirror subscribeWorldEvents 纪律）。
    return null;
  }
}

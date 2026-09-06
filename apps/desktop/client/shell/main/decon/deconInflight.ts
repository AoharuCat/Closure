// ── E10.3a（task 09-05，CR-1）：在途拆解管线注册表——零依赖叶子模块 ──
//
// 进程内模块级 Map（mirror agentIpc projectActiveRuns 先例——内存注册表 + 启动对账，无持久
// 锁死）。独立成叶子的原因：deconJob（状态机）与 deconRun（管线共用面）都要消费，注册表住
// 任一侧都会成环（deconRun→deconJob→deconRun）。
//
// 消费面：
// - **start 判别「真在途 vs 假 running」**：job.status='running' 且注册表有项 = 后台管线真在跑
//   （no-op 不重派——防双管线并发重复烧 LLM）；无项 = kill/崩溃/异常吞掉的残留旗标——对账翻
//   paused 后可重启（AC2 的 IPC 路径）。
// - **delete/materials:delete 握手**：在途管线先经 cancel() 置取消旗标（管线在下一相位边界停；
//   job 行已删时 cost 回写抛 DeconJobGoneError 静默退出，不复活行）。
// - runDeconPassSequence 注册/释放（registerInflightDeconPipeline 返回 release，finally 调）。

/** 在途管线句柄（cancel 置旗标——管线在相位边界自查）。 */
export interface DeconPipelineHandle {
  cancel(): void;
}

const inflightDeconPipelines = new Map<string, DeconPipelineHandle>();

/**
 * 管线注册（runDeconPassSequence 专用——返回 release；同 jobId 已有在途返回 null，
 * 调用方拒绝派第二条管线）。
 */
export function registerInflightDeconPipeline(jobId: string, handle: DeconPipelineHandle): (() => void) | null {
  if (inflightDeconPipelines.has(jobId)) return null;
  inflightDeconPipelines.set(jobId, handle);
  return () => {
    // 幂等 release：只删自己那次注册（句柄同一性判别——后注册者不会被前者的 release 误删）。
    if (inflightDeconPipelines.get(jobId) === handle) inflightDeconPipelines.delete(jobId);
  };
}

/** 查询：jobId 是否有在途管线（startDeconJob 的「真在途」判别面）。 */
export function isDeconPipelineInflight(jobId: string): boolean {
  return inflightDeconPipelines.has(jobId);
}

/** 取消在途管线（返回是否确有在途——无在途为幂等 no-op）。 */
export function cancelInflightDeconPipeline(jobId: string): boolean {
  const handle = inflightDeconPipelines.get(jobId);
  if (handle === undefined) return false;
  handle.cancel();
  return true;
}

/**
 * E10.3a（task 09-05）W6：`decon:progress` 推送事件发射器（shell → renderer）。
 *
 * 拆解 pass 相位（p1a/p1b/p1c/p2 + child B 预留 p3a…p6）+ 终态（done/failed/capped/stale/paused）
 * 经本通道全窗广播（运行阶段可见性硬要求，memory feedback-run-phase-visibility）。载荷契约 =
 * shared-contracts `DeconProgressEvent`；通道常量 = channels.ts zod-free 叶子
 * DECON_PROGRESS_CHANNEL。
 *
 * 广播形态 mirror craftDistillNotify.ts / materialNotify.ts（BrowserWindow.getAllWindows 全窗
 * 遍历 + per-window try/catch）：发射点在 deconIpc 的管线编排层，无 getMainWindow 注入面。
 *
 * **NEVER throws（best-effort 契约红线）**：send 失败只 warn 不抛、绝不阻拆解管线（台账
 * pass_state/job 行是真相，事件可丢）；连 logger 本身不可用也吞掉。UI 读侧兜底 = decon:get
 * 拉取（事件可丢是设计内行为，spec/ui/state-management 事件刷新三件套）。
 */
import { BrowserWindow } from 'electron';
import { DECON_PROGRESS_CHANNEL, type DeconProgressEvent } from '@orison/shared-contracts';
import { getLogger } from '../logger';

/** 广播失败记 warn（自身再包一层 try——logger 不可用时吞掉，best-effort 契约）。 */
function logDeconProgressFailure(err: unknown, event: DeconProgressEvent): void {
  try {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), event },
      'decon:progress broadcast failed - continuing (best-effort)',
    );
  } catch {
    // logger 不可用（mock 缺面 / 启动早期）——绝不向上抛。
  }
}

/**
 * 向全部窗口广播拆解进度。NEVER throws。
 *
 * per-window try/catch：单窗 send 失败只记 warn，其余窗口照发（一个死窗口不拖累其他订阅者）。
 */
export function sendDeconProgress(event: DeconProgressEvent): void {
  let windows: BrowserWindow[];
  try {
    windows = BrowserWindow.getAllWindows();
  } catch (err) {
    logDeconProgressFailure(err, event);
    return;
  }
  for (const win of windows) {
    try {
      win.webContents.send(DECON_PROGRESS_CHANNEL, event);
    } catch (err) {
      logDeconProgressFailure(err, event);
    }
  }
}

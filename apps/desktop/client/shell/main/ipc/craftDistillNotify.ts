/**
 * E10.2b（task 09-05）W3.4：`craft:distill-progress` 推送事件发射器（shell → renderer）。
 *
 * 蒸馏运行相位（extracting/categorizing/dedup/landing）+ 耗时 + 终态（done/failed）经本通道
 * 全窗广播（运行阶段可见性硬要求，design §0）。载荷契约 = shared-contracts
 * `CraftDistillProgressEvent`（W1）；通道常量 = channels.ts zod-free 叶子（W1）。
 *
 * 广播形态 mirror materialNotify.ts（BrowserWindow.getAllWindows 全窗遍历 + per-window
 * try/catch）：发射点在蒸馏管线（craftDistillPipeline 相位推进处），无 getMainWindow 注入面；
 * 广播不需要窗口懒解析。
 *
 * **NEVER throws（best-effort 契约红线，mirror materialNotify / worldNotify）**：send 失败只
 * warn 不抛、绝不阻蒸馏管线（台账/卡是真相，事件可丢）；连 logger 本身不可用也吞掉。UI 读侧
 * 兜底 = distill-status 拉取（事件可丢是设计内行为，spec/ui/state-management 事件刷新三件套）。
 */
import { BrowserWindow } from 'electron';
import {
  CRAFT_DISTILL_PROGRESS_CHANNEL,
  type CraftDistillProgressEvent,
} from '@orison/shared-contracts';
import { getLogger } from '../logger';

/** 广播失败记 warn（自身再包一层 try——logger 不可用时吞掉，best-effort 契约）。 */
function logCraftDistillProgressFailure(err: unknown, event: CraftDistillProgressEvent): void {
  try {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), event },
      'craft:distill-progress broadcast failed - continuing (best-effort)',
    );
  } catch {
    // logger 不可用（mock 缺面 / 启动早期）——绝不向上抛。
  }
}

/**
 * 向全部窗口广播蒸馏进度。NEVER throws。
 *
 * per-window try/catch：单窗 send 失败只记 warn，其余窗口照发（一个死窗口不拖累其他订阅者）。
 */
export function sendCraftDistillProgress(event: CraftDistillProgressEvent): void {
  let windows: BrowserWindow[];
  try {
    windows = BrowserWindow.getAllWindows();
  } catch (err) {
    logCraftDistillProgressFailure(err, event);
    return;
  }
  for (const win of windows) {
    try {
      win.webContents.send(CRAFT_DISTILL_PROGRESS_CHANNEL, event);
    } catch (err) {
      logCraftDistillProgressFailure(err, event);
    }
  }
}

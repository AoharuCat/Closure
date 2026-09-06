/**
 * Story 10.1 Wave D（F-23）：`material:changed` 推送事件发射器（shell → renderer）。
 *
 * 材料变更广播单列本通道的原因：既有 `file:changed`（toolNotify）负载是 project 作用域
 * （携带 projectPath），全局材料车道（~/.orison/materials/）无 projectPath 可挂——材料
 * 变更（批量导入/重摄取/删除/provenance 后补/watcher 登记）统一走本通道，负载
 * `{scope, projectId?, materialId?, reason}` 双车道通用。
 *
 * 广播形态 mirror worldNotify.ts（BrowserWindow.getAllWindows 全窗口遍历 + per-window
 * try/catch）：发射点在 IPC handler 层，无 getMainWindow 注入面；广播不需要窗口懒解析。
 *
 * **NEVER throws（best-effort 契约红线，mirror worldNotify）**：send 失败只 warn 不抛、
 * 绝不阻写路径（写事务/登记已提交，通知失败不能反过来把写报成失败）；连 logger 本身
 * 不可用（测试 mock 缺面 / 启动早期）也吞掉。UI 读侧兜底 = 材料页打开边沿 force 重拉
 * （事件可丢是设计内行为，spec/ui/state-management 事件刷新三件套）。
 *
 * 触发点：materials:import（逐份）/ materials:reingest / materials:delete /
 * materials:update-provenance / materials:update-name（E10.2a 标题编辑，reason='name-updated'）
 * （materialIpc.ts）+ watcher flush（materialWatcher.ts——register
 * 成功→reingested〔不用 imported，避免误增 UI 导入进度计数〕/ orphaned→deleted /
 * derived 重索引与 backfill→reindexed）。
 */
import { BrowserWindow } from 'electron';
import { MATERIAL_CHANGED_CHANNEL, type MaterialChangedEvent } from '@orison/shared-contracts';
import { getLogger } from '../logger';

/** 广播失败记 warn（自身再包一层 try——logger 不可用时吞掉，best-effort 契约）。 */
function logMaterialChangedFailure(err: unknown, event: MaterialChangedEvent): void {
  try {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), event },
      'material:changed broadcast failed - continuing (best-effort)',
    );
  } catch {
    // logger 不可用（mock 缺面 / 启动早期）——绝不向上抛。
  }
}

/**
 * 向全部窗口广播材料变更。NEVER throws。
 *
 * per-window try/catch：单窗 send 失败只记 warn，其余窗口照发（一个死窗口不拖累其他订阅者）。
 */
export function sendMaterialChanged(event: MaterialChangedEvent): void {
  let windows: BrowserWindow[];
  try {
    windows = BrowserWindow.getAllWindows();
  } catch (err) {
    logMaterialChangedFailure(err, event);
    return;
  }
  for (const win of windows) {
    try {
      win.webContents.send(MATERIAL_CHANGED_CHANNEL, event);
    } catch (err) {
      logMaterialChangedFailure(err, event);
    }
  }
}

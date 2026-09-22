/**
 * 任务档预设 API shell（C3.2 W2 多套预设）。Mirror `shared/api/usagePanel.ts`
 * ——每个 IPC 调用都走 `window.orisonDesktop`（UI 纪律：features 组件不直碰桥，
 * boundary rule 收口点）。
 *
 * 四通道载荷契约单源 shared-contracts `contracts/model.ts` taskPreset* 段；
 * save/apply/delete 是模式 A 类型化结果（预期内用户失败不 throw）。桥缺席 →
 * null（调用方跳过/置空列表）。
 */
import type { TaskPresetMutationResult, TaskPresetSummary } from '@orison/shared-contracts';

/** Read the preload bridge at call time (not module load) so tests that install
 *  a fake `window.orisonDesktop` per-case see it. Mirrors how slices access it. */
function api() {
  return window.orisonDesktop;
}

/** 预设清单（坏档 shell 侧 warn 跳过不出现在列表）；桥缺席/失败 → null。 */
export async function listTaskPresets(): Promise<TaskPresetSummary[] | null> {
  try {
    const bridge = api();
    if (!bridge?.listTaskPresets) return null;
    return await bridge.listTaskPresets();
  } catch {
    return null;
  }
}

/** 存当前全部任务档为命名预设（同名覆盖——两段式确认归调用方 UI）。 */
export async function saveTaskPreset(name: string): Promise<TaskPresetMutationResult | null> {
  try {
    const bridge = api();
    if (!bridge?.saveTaskPreset) return null;
    return await bridge.saveTaskPreset({ name });
  } catch {
    return null;
  }
}

/** 整组应用预设（shell 走既有保存路径写 task-models.yaml + 落 activePreset）。 */
export async function applyTaskPreset(name: string): Promise<TaskPresetMutationResult | null> {
  try {
    const bridge = api();
    if (!bridge?.applyTaskPreset) return null;
    return await bridge.applyTaskPreset({ name });
  } catch {
    return null;
  }
}

/** 删除预设档（删到活动档时 shell 同步清 activePreset，当前指派不动）。 */
export async function deleteTaskPreset(name: string): Promise<TaskPresetMutationResult | null> {
  try {
    const bridge = api();
    if (!bridge?.deleteTaskPreset) return null;
    return await bridge.deleteTaskPreset({ name });
  } catch {
    return null;
  }
}

/**
 * 材料库管理面 API shell（Story 10.1 Wave D）——mirror shared/api/worldState.ts：一切
 * IPC 经 preload 桥 `window.orisonDesktop` 走，组件/slice 只调本文件（module-structure
 * invariant：IPC 走 shared/api）。
 *
 * 六 invoke（契约单源 packages/shared-contracts/src/ipc.ts「Story 10.1 Wave D」段）+
 * material:changed 事件订阅面（slice 的 subscribeMaterialEvents 直接挂桥，mirror
 * worldState.ts 注记——保持 hook-free 的模块级订阅）。
 *
 * 桥缺失显式报错（mirror worldState.ts #5+#102+#210 纪律）：throw
 * `Error('desktop bridge unavailable')`——绝不 `?? null` 伪装成「成功但空」（假空态/
 * 永久骨架）。错误消息稳定，测试断言全等，勿改文案。
 */
import type {
  MaterialDeleteResult,
  MaterialDetail,
  MaterialProvenancePatchInput,
  MaterialProvenancePatchResult,
  MaterialReingestResult,
  MaterialsImportInput,
  MaterialsImportResult,
  MaterialsListInput,
  MaterialSummary,
  MaterialUpdateNameInput,
  MaterialUpdateNameResult,
} from '@orison/shared-contracts';

/** 调用时取桥（勿模块级捕获——测试在 beforeEach 里装 window.orisonDesktop，晚于模块加载）。 */
function api() {
  return window.orisonDesktop;
}

export function listMaterials(input: MaterialsListInput): Promise<MaterialSummary[]> {
  const bridge = api();
  if (!bridge?.listMaterials) throw new Error('desktop bridge unavailable');
  return bridge.listMaterials(input);
}

export function getMaterialDetail(materialId: string): Promise<MaterialDetail | null> {
  const bridge = api();
  if (!bridge?.getMaterial) throw new Error('desktop bridge unavailable');
  return bridge.getMaterial({ materialId });
}

export function deleteMaterial(materialId: string): Promise<MaterialDeleteResult> {
  const bridge = api();
  if (!bridge?.deleteMaterial) throw new Error('desktop bridge unavailable');
  return bridge.deleteMaterial({ materialId });
}

export function reingestMaterial(materialId: string): Promise<MaterialReingestResult> {
  const bridge = api();
  if (!bridge?.reingestMaterial) throw new Error('desktop bridge unavailable');
  return bridge.reingestMaterial({ materialId });
}

export function importMaterials(input: MaterialsImportInput): Promise<MaterialsImportResult> {
  const bridge = api();
  if (!bridge?.importMaterials) throw new Error('desktop bridge unavailable');
  return bridge.importMaterials(input);
}

export function updateMaterialProvenance(
  input: MaterialProvenancePatchInput,
): Promise<MaterialProvenancePatchResult> {
  const bridge = api();
  if (!bridge?.updateMaterialProvenance) throw new Error('desktop bridge unavailable');
  return bridge.updateMaterialProvenance(input);
}

/**
 * 材料显示名编辑（E10.2a，design §3.1）——`materials:update-name`：name 列更新
 * （materialId 路径身份不变）。照 updateMaterialProvenance 的 api 形态（桥缺失显式报错）。
 */
export function updateMaterialName(input: MaterialUpdateNameInput): Promise<MaterialUpdateNameResult> {
  const bridge = api();
  if (!bridge?.updateMaterialName) throw new Error('desktop bridge unavailable');
  return bridge.updateMaterialName(input);
}

/** 拖入 File → 绝对路径（Electron 37 无 File.path；桥收口——store 不直碰 window）。 */
export function pathForImportFile(file: File): string {
  return window.orisonDesktop?.pathForFile?.(file) ?? '';
}

/**
 * 在系统文件管理器中显示（reveal）。**注意**：shell 侧 assertSafePath 只允许项目内路径
 * ——全局车道（~/.orison/materials/，未 allowPath）会被静默拒绝，调用方须备 clipboard
 * 兜底（copyMaterialPath）。
 */
export function revealInFolder(fullPath: string): void {
  window.orisonDesktop?.showItemInFolder?.(fullPath);
}

/** 派生/原件路径复制到剪贴板（全局车道 reveal/open 被路径闸拒时的兜底呈现）。 */
export async function copyMaterialPath(fullPath: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(fullPath);
    return true;
  } catch {
    return false;
  }
}

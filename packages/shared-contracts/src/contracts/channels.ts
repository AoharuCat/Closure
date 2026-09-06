// ── dogfood R2 #99：推送通道名单源叶子模块（zod-free）──
//
// 背景：preload（sandbox:true）只能 require('electron')——任何值导入把 zod
// （其 bundle 顶层 require("node:crypto")）经 contracts barrel 拖进 preload
// bundle 都会让 preload 整体崩溃、window.orisonDesktop 消失、全 app IPC 静默
// 哑掉（08-30 #92 commit 实录，08-28 前的常驻老窗口不重跑 preload 故未炸）。
// 因此 IPC 推送通道名常量放在本**零依赖叶子模块**：preload 深导入
// `@orison/shared-contracts/contracts/channels` 只内联本文件，不触 zod。
// 守卫：shell 测试 preload-sandbox-imports 对 preload 值导入闭包静态断言。
//
// ⚠️ 本文件禁 import 任何东西（含 type-only 以外的相对模块）——加了就会
// 重新打开 sandbox 崩溃面。shell 侧消费面仍走 barrel（world-panel re-export）。
export const WORLD_CHANGED_CHANNEL = 'world:changed';

// Story 10.1 Wave D（F-23）：材料变更推送通道。file:changed 是 project 作用域（负载带
// projectPath）——全局材料车道（~/.orison/materials/）无 projectPath 可挂，材料变更广播
// 单列本通道（invoke 通道不进 enum 同 world:changed 先例；preload 经本叶子深导入取值）。
export const MATERIAL_CHANGED_CHANNEL = 'material:changed';

// E10.2b（task 09-05 Wave 1）：蒸馏进度推送通道（相位 + 耗时 + materialId——运行阶段
// 可见性硬要求）。invoke 通道不进 desktopIpcSchema enum 同 material:changed 先例；
// preload 经本叶子深导入取值（zod-free 纪律同上）。
export const CRAFT_DISTILL_PROGRESS_CHANNEL = 'craft:distill-progress';

// E10.3a（task 09-05）W6：拆解管线进度推送通道（jobId + pass 相位——运行阶段可见性
// 硬要求，mirror craft:distill-progress）。best-effort 可丢，读侧兜底 = decon:get 拉取；
// invoke 通道不进 enum 同先例，preload 经本叶子深导入取值。
export const DECON_PROGRESS_CHANNEL = 'decon:progress';

/**
 * 小残留 a（dogfood R4）：toast 渲染层级锁——toast 容器必须高于 app modal 遮罩。
 *
 * 根因（真机取证）：窗口高 ≲850px 时模型配置页校验 toast 落在设置对话框面板之下——
 * 旧阶梯 `--z-notification(1200) < --z-confirm-dialog(1300)`（注释原文「must sit above
 * toasts」），toast 被遮罩整体盖死（零反馈，用户只见「点什么都没发生」）；且点击命中
 * 遮罩还会关掉整个设置对话框。修法 = 两 token 位次互换（瞬时反馈可见性 > 遮罩盖 toast），
 * 唯一消费者面：--z-notification 只有 .toast-container；--z-confirm-dialog 是
 * confirm-dialog-overlay / topbar-new-dialog-overlay / materials 弹层。
 *
 * jsdom 不算 CSS 层叠——锁只能落在**源码面**（mirror structureCssLock.test.ts 的
 * scales.css token 位次锁先例）：token 数值序 + toast 容器挂载 token 两处钉死。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const scalesCss = readFileSync(resolve(here, '../src/shared/styles/scales.css'), 'utf8');
const componentsCss = readFileSync(resolve(here, '../src/shared/styles/base/components.css'), 'utf8');

/** token 数值（行首 token 定义行形态锚定：`^\s*--name:`——CR-09-20-dogfood-11：非锚定
 * 首匹配会被注释里的「token: 数字」提及 spoof，如迁移注记/历史值记录）。 */
function zOf(name: string): number {
  const m = scalesCss.match(new RegExp(`^\\s*--${name}:\\s*(\\d+)`, 'm'));
  expect(m, `--${name} defined numerically in scales.css`).not.toBeNull();
  return Number(m![1]);
}

describe('toast 层级锁（dogfood R4 小残留 a：toast 高于 app modal 遮罩）', () => {
  it('token 位次：--z-notification > --z-confirm-dialog（toasts stay readable above modals）', () => {
    const notification = zOf('z-notification');
    const confirmDialog = zOf('z-confirm-dialog');
    expect(
      notification,
      'toast 层必须高于 modal 遮罩层——回退即复发「设置对话框盖死校验 toast」（dogfood R4 小残留 a）',
    ).toBeGreaterThan(confirmDialog);
  });

  it('toast 容器挂 --z-notification（不落裸数字、不旁落其他 token）', () => {
    const block = componentsCss.match(/\.toast-container\s*\{([^}]*)\}/);
    expect(block, '.toast-container rule present in components.css').not.toBeNull();
    expect(block![1]).toContain('z-index: var(--z-notification)');
  });

  it('pointer-events 契约：容器 pass-through + toast 本体可命中（点击落 toast 不漏进遮罩）', () => {
    // CR-09-20-dogfood-5 核实结论（证据在 components.css 源码面）：.toast-container 为
    // `pointer-events: none`（pass-through 是刻意设计——容器空区不拦截下方元素），而
    // `.toast` 子元素带 `pointer-events: auto`（点击命中测试照常生效）。两者组合 =
    // toast 抬到遮罩之上（上一断言）时，点按 toast 命中 toast 自身而非透传到 modal
    // 遮罩——遮罩不会被误触关掉。故不补容器级 auto（那会让容器盒子拦住下方点击，
    // 破坏 pass-through 设计），只把这对契约锁进测试。
    const container = componentsCss.match(/\.toast-container\s*\{([^}]*)\}/);
    const toast = componentsCss.match(/(?<![\w-])\.toast\s*\{([^}]*)\}/);
    expect(container, '.toast-container rule present in components.css').not.toBeNull();
    expect(toast, '.toast rule present in components.css').not.toBeNull();
    expect(container![1]).toContain('pointer-events: none');
    expect(toast![1]).toContain('pointer-events: auto');
  });
});

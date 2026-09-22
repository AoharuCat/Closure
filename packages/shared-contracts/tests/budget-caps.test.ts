import { describe, expect, it } from 'vitest';
import {
  BUDGET_CNY_MAX,
  clampBudgetCny,
  normalizeBudgetCaps,
  validateBudgetCapsForSave,
} from '../src';

// C3.2 W3：月度预算双键 clamp 族矩阵（must-fix#4——preferences 无 zod schema 面，
// soft ≤ hard 校验落本纯函数族：读侧 lenient 钳平 + save 侧响亮校验，两函数同源）。

describe('clampBudgetCny（单键钳）', () => {
  it('有限正数原样 / 带上界钳回', () => {
    expect(clampBudgetCny(20)).toBe(20);
    expect(clampBudgetCny(0.5)).toBe(0.5);
    expect(clampBudgetCny(2_000_000)).toBe(BUDGET_CNY_MAX);
  });

  it('NaN / Infinity / 非数 / 零 / 负 → undefined（键不设——缺席语义非 0，CR-18 同族）', () => {
    expect(clampBudgetCny(undefined)).toBeUndefined();
    expect(clampBudgetCny(NaN)).toBeUndefined();
    expect(clampBudgetCny(Infinity)).toBeUndefined();
    expect(clampBudgetCny('20')).toBeUndefined(); // flat YAML 手改字符串形态
    expect(clampBudgetCny(null)).toBeUndefined();
    expect(clampBudgetCny(0)).toBeUndefined();
    expect(clampBudgetCny(-5)).toBeUndefined();
  });
});

describe('normalizeBudgetCaps（读侧 lenient 跨字段钳）', () => {
  it('双线合法 → 原样 + 无钳平旗', () => {
    expect(normalizeBudgetCaps(10, 20)).toEqual({ softCny: 10, hardCny: 20, softClampedToHard: false });
  });

  it('仅软线 / 仅硬线各自合法（单线语义）', () => {
    expect(normalizeBudgetCaps(10, undefined)).toEqual({ softCny: 10, hardCny: undefined, softClampedToHard: false });
    expect(normalizeBudgetCaps(undefined, 20)).toEqual({ softCny: undefined, hardCny: 20, softClampedToHard: false });
  });

  it('双线全缺 → 双 undefined（不设）', () => {
    expect(normalizeBudgetCaps(undefined, undefined)).toEqual({ softCny: undefined, hardCny: undefined, softClampedToHard: false });
  });

  it('soft > hard → 以 hard 为准钳平 + 钳平旗（调用方 warn；不炸面板不炸 gate）', () => {
    expect(normalizeBudgetCaps(30, 20)).toEqual({ softCny: 20, hardCny: 20, softClampedToHard: true });
    expect(normalizeBudgetCaps(21.5, 20)).toEqual({ softCny: 20, hardCny: 20, softClampedToHard: true });
  });

  it('soft == hard 合法（等值不算病态）', () => {
    expect(normalizeBudgetCaps(20, 20)).toEqual({ softCny: 20, hardCny: 20, softClampedToHard: false });
  });

  it('非法单键 = 不设（垃圾值不参与跨字段比较）', () => {
    expect(normalizeBudgetCaps('abc', 20)).toEqual({ softCny: undefined, hardCny: 20, softClampedToHard: false });
    expect(normalizeBudgetCaps(10, 'abc')).toEqual({ softCny: 10, hardCny: undefined, softClampedToHard: false });
  });
});

describe('validateBudgetCapsForSave（save 侧响亮校验——文案单源）', () => {
  it('合法（含单线/缺省/等值）→ null', () => {
    expect(validateBudgetCapsForSave(10, 20)).toBeNull();
    expect(validateBudgetCapsForSave(10, undefined)).toBeNull();
    expect(validateBudgetCapsForSave(undefined, 20)).toBeNull();
    expect(validateBudgetCapsForSave(undefined, undefined)).toBeNull();
    expect(validateBudgetCapsForSave(20, 20)).toBeNull();
  });

  it('soft > hard → 错误描述中文化人话且含两线数值（CR-6：IPC rejection 直达用户，不留开发串）', () => {
    const violation = validateBudgetCapsForSave(30, 20);
    // CR-6 定谳文案形态：「软线金额（¥30）须不大于硬线金额（¥20）」——数值双在、
    // 开发键名（budgetSoftCny/budgetHardCny）不进用户可见面。
    expect(violation).toContain('软线金额');
    expect(violation).toContain('硬线金额');
    expect(violation).toContain('30');
    expect(violation).toContain('20');
    expect(violation).not.toContain('budgetSoftCny');
  });
});

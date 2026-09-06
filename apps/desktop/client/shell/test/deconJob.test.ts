import { describe, expect, it } from 'vitest';
import { DECON_JOB_STATUSES } from '@orison/shared-contracts';
import {
  DECON_JOB_ACTIONS,
  applyDeconJobTransition,
  decideDeconPassReentry,
  deconFingerprintMismatch,
} from '../main/decon/deconJob';
import type { DeconPassState } from '@orison/shared-contracts';

// E10.3a W2：job 状态机转移矩阵 + 双指纹失配 + pass 断点重入判定（纯函数面）。
// AC2（断点）/AC3（capped）/AC12（stale）的状态半边。

function passState(over: Partial<DeconPassState> = {}): DeconPassState {
  return {
    jobId: 'decon-000000000001',
    pass: 'p1b',
    unit: '3',
    status: 'done',
    outputRef: 'facts:3',
    outputHash: `sha256:${'a'.repeat(64)}`,
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

describe('applyDeconJobTransition（转移矩阵）', () => {
  it('start：pending/paused → running', () => {
    expect(applyDeconJobTransition('pending', 'start')).toEqual({ ok: true, status: 'running' });
    expect(applyDeconJobTransition('paused', 'start')).toEqual({ ok: true, status: 'running' });
  });

  it('retry：failed/capped → running（调预算后续跑 / 失败重试）', () => {
    expect(applyDeconJobTransition('failed', 'retry')).toEqual({ ok: true, status: 'running' });
    expect(applyDeconJobTransition('capped', 'retry')).toEqual({ ok: true, status: 'running' });
  });

  it('pause/cap/fail/finish：running → 各自目标态', () => {
    expect(applyDeconJobTransition('running', 'pause')).toEqual({ ok: true, status: 'paused' });
    expect(applyDeconJobTransition('running', 'cap')).toEqual({ ok: true, status: 'capped' });
    expect(applyDeconJobTransition('running', 'fail')).toEqual({ ok: true, status: 'failed' });
    expect(applyDeconJobTransition('running', 'finish')).toEqual({ ok: true, status: 'done' });
  });

  it('stale：非终态 + done 可转（F-02——done 产物锚定旧基面同样不可沿用）；cancelled 不可 stale', () => {
    for (const from of ['pending', 'running', 'paused', 'capped', 'done'] as const) {
      expect(applyDeconJobTransition(from, 'stale')).toEqual({ ok: true, status: 'stale' });
    }
    expect(applyDeconJobTransition('cancelled', 'stale').ok).toBe(false);
    expect(applyDeconJobTransition('failed', 'stale').ok).toBe(false);
  });

  it('cancel：pending/running/paused/capped 可取消；done/failed/stale/cancelled 不可', () => {
    for (const from of ['pending', 'running', 'paused', 'capped'] as const) {
      expect(applyDeconJobTransition(from, 'cancel')).toEqual({ ok: true, status: 'cancelled' });
    }
    for (const from of ['done', 'failed', 'stale', 'cancelled'] as const) {
      expect(applyDeconJobTransition(from, 'cancel').ok).toBe(false);
    }
  });

  it('confirm-rerun：stale → pending（用户确认重跑）；其他态拒绝', () => {
    expect(applyDeconJobTransition('stale', 'confirm-rerun')).toEqual({ ok: true, status: 'pending' });
    expect(applyDeconJobTransition('running', 'confirm-rerun').ok).toBe(false);
  });

  it('非法转移带结构化 from/action（不 throw——模式 A 类型化失败）', () => {
    const r = applyDeconJobTransition('done', 'pause');
    expect(r).toEqual({ ok: false, error: 'invalid-transition', from: 'done', action: 'pause' });
  });

  it('矩阵覆盖度：每个声明的 action × 每个状态无未定义行为（全笛卡尔零 throw）', () => {
    for (const action of DECON_JOB_ACTIONS) {
      for (const status of DECON_JOB_STATUSES) {
        expect(() => applyDeconJobTransition(status, action)).not.toThrow();
      }
    }
  });

  it('done×start 不在矩阵内（幂等 no-op 是 startDeconJob 特判非转移——防矩阵误开 done 重跑后门）', () => {
    expect(applyDeconJobTransition('done', 'start').ok).toBe(false);
  });
});

describe('deconFingerprintMismatch（双指纹失配）', () => {
  const job = { materialContentHash: `sha256:${'a'.repeat(64)}`, derivedHash: `sha256:${'b'.repeat(64)}` };

  it('双一致 → false', () => {
    expect(deconFingerprintMismatch(job, { materialContentHash: job.materialContentHash, derivedHash: job.derivedHash })).toBe(false);
  });

  it('原件指纹变（重摄取）→ true', () => {
    expect(
      deconFingerprintMismatch(job, { materialContentHash: `sha256:${'c'.repeat(64)}`, derivedHash: job.derivedHash }),
    ).toBe(true);
  });

  it('派生指纹变（人工校对）→ true', () => {
    expect(
      deconFingerprintMismatch(job, { materialContentHash: job.materialContentHash, derivedHash: `sha256:${'d'.repeat(64)}` }),
    ).toBe(true);
  });
});

describe('decideDeconPassReentry（断点重入）', () => {
  it('无状态行 → rerun（首次）', () => {
    expect(decideDeconPassReentry(null, `sha256:${'a'.repeat(64)}`)).toBe('rerun');
  });

  it('done + 产物现值一致 → skip（不重付 LLM）', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    expect(decideDeconPassReentry(passState({ outputHash: hash }), hash)).toBe('skip');
  });

  it('done + 产物漂移（hash 不一致 / 产物缺失）→ rerun（stale 产物不静默沿用）', () => {
    const state = passState({ outputHash: `sha256:${'a'.repeat(64)}` });
    expect(decideDeconPassReentry(state, `sha256:${'e'.repeat(64)}`)).toBe('rerun');
    expect(decideDeconPassReentry(state, null)).toBe('rerun');
  });

  it('capped → capped-hold（保留挂起态等预算调整，不静默截断）', () => {
    expect(decideDeconPassReentry(passState({ status: 'capped' }), null)).toBe('capped-hold');
  });

  it('pending/running（崩溃残留）/failed → rerun（幂等重入重做）', () => {
    for (const status of ['pending', 'running', 'failed'] as const) {
      expect(decideDeconPassReentry(passState({ status }), `sha256:${'a'.repeat(64)}`)).toBe('rerun');
    }
  });
});

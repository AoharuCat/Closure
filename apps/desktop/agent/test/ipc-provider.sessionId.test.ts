import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  __clearGenerateTextSeamForTest,
  generate,
  setGenerateTextFn,
  type GenerateTextFn,
  type GenerateTextRequest,
} from '../src/provider/ipc-provider';
import type { SessionMessage } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// C3.1 计量台账 W3（sessionId 三跳第二跳装配钉）：GenerateOptions.sessionId 既有
//（CR-44，此前仅 debug 溯源不过 wire）——本文件钉 generate() 拼 body 时
// `request.sessionId = opts.sessionId?.trim() || undefined` 的单点注入：
//   - 带 id → seam 收到的 body.request.sessionId 原值到达（wire schema additive 字段，
//     协议入口 withLedgerCallContext 归一落 ctx 后由 wrapper 落 session_id 列）；
//   - '' / whitespace-only / undefined → 不占位（两态纪律 mirror taskType——CR-7 复核
//     trim 后判空，有效值落 trim 后形态）。
// 删掉拼装行即红（mirror agentIpcTaskSlotWiring 的「删接线即红」钉法）。
// 第三跳（协议入口归一 → ledger 列）由 model-protocols usageLedgerAttemptMetering +
// shell usageLedgerWiring 两级测试覆盖。
// C3.1 复核 CR-10：afterAll 复位 seam——模块级单例不跨文件泄漏到断言「未初始化」
// 态的用例（mirror __clearBridgeSeamsForTest 形态）。
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES: SessionMessage[] = [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }];
const SIGNAL = new AbortController().signal;

function installSeam(impl: GenerateTextFn) {
  const seam = vi.fn<GenerateTextFn>(impl);
  setGenerateTextFn(seam);
  return seam;
}

afterAll(() => {
  __clearGenerateTextSeamForTest();
});

describe('ipc-provider sessionId 三跳第二跳（C3.1 W3 装配钉）', () => {
  it('opts.sessionId 在场 → body.request.sessionId 原值到达 seam（与 taskType/sessionKey 并存）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));

    await generate(MESSAGES, 'SYS', [], SIGNAL, {
      sessionId: 'sess-leader-1',
      sessionKey: 'dialogue:sess-leader-1',
      taskType: 'dialogue',
    });

    expect(seam).toHaveBeenCalledTimes(1);
    const body = seam.mock.calls[0][0] as GenerateTextRequest;
    expect(body.request.sessionId).toBe('sess-leader-1');
    // 邻接字段不受影响（mirror taskType 三跳先例的共存形态）。
    expect(body.request.sessionKey).toBe('dialogue:sess-leader-1');
    expect(body.request.taskType).toBe('dialogue');
  });

  it("opts.sessionId = '' → 不占位（两态纪律：'' 归一为缺席，拼装侧兜 zod parse 豁免缝）", async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));

    await generate(MESSAGES, 'SYS', [], SIGNAL, { sessionId: '' });

    const body = seam.mock.calls[0][0] as GenerateTextRequest;
    expect(body.request.sessionId).toBeUndefined();
  });

  it('opts.sessionId = whitespace-only → 不占位；有值落 trim 后形态（CR-7 复核 trim 后判空）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));

    await generate(MESSAGES, 'SYS', [], SIGNAL, { sessionId: '   ' });
    const wsBody = seam.mock.calls[0][0] as GenerateTextRequest;
    expect(wsBody.request.sessionId).toBeUndefined();

    await generate(MESSAGES, 'SYS', [], SIGNAL, { sessionId: '  sess-pad  ' });
    const padBody = seam.mock.calls[1][0] as GenerateTextRequest;
    expect(padBody.request.sessionId).toBe('sess-pad');
  });

  it('opts.sessionId 缺省 → request.sessionId undefined（未接装配点照旧，ABSENT 组）', async () => {
    const seam = installSeam(async () => ({ text: 'ok', finishReason: 'stop' }));

    await generate(MESSAGES, 'SYS', [], SIGNAL);

    const body = seam.mock.calls[0][0] as GenerateTextRequest;
    expect(body.request.sessionId).toBeUndefined();
  });
});

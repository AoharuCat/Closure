import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldTriggerCompaction,
  isProjectionOverflow,
  updateCalibrationRatio,
  clampRedlinePercent,
  resolveContextWindowTokens,
  CONTEXT_WINDOW,
  COMPACTION_TRIGGER_RATIO,
  DEFAULT_REDLINE_PERCENT,
  CONTEXT_REPLY_RESERVE_TOKENS,
  IMAGE_TOKEN_BUDGET,
} from '../src/context/tokenEstimator';
import type { SessionMessage } from '../src/types';

describe('tokenEstimator', () => {
  it('estimates tokens for English text', () => {
    const text = 'Hello world, this is a test.';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(text.length / 3.5));
  });

  it('estimates tokens for Chinese text', () => {
    const text = '这是一段中文测试文本，用于验证token估算的准确性。';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates message tokens including tool calls', () => {
    const messages: SessionMessage[] = [
      { id: '1', role: 'user', content: 'Read the file', createdAt: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'I will read it.',
        toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"src/index.ts"}' }],
        createdAt: 2,
      },
      {
        id: '3',
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc1', toolName: 'read_file', output: 'const x = 1;' }],
        createdAt: 3,
      },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  // dogfood T1 Stage 4（design §6.3 / r3）：reasoning 计入预算——深度思考可与正文等长，
  // 不计会低估 compaction 触发线（summarizer 决策漂移）。
  it('counts reasoning length toward the estimate (compaction budget)', () => {
    const base: SessionMessage[] = [
      { id: '1', role: 'assistant', content: '正文', createdAt: 1 },
    ];
    const withReasoning: SessionMessage[] = [
      { id: '1', role: 'assistant', content: '正文', reasoning: '深度思考'.repeat(200), createdAt: 1 },
    ];
    const baseTokens = estimateMessagesTokens(base);
    const withReasoningTokens = estimateMessagesTokens(withReasoning);
    expect(withReasoningTokens).toBeGreaterThan(baseTokens);
  });

  it('triggers compaction when over threshold', () => {
    // S4a（task 08-25）：缺省红线 0.75 → 95%（用户拍板行为变化）——阈值锚点换
    // DEFAULT_REDLINE_PERCENT；到达即触发（>= 语义，非严格大于）。
    const systemTokens = 1000;
    const messagesTokens = CONTEXT_WINDOW * (DEFAULT_REDLINE_PERCENT / 100); // exactly at threshold
    expect(shouldTriggerCompaction(systemTokens, messagesTokens)).toBe(true);
  });

  it('does not trigger compaction when under threshold', () => {
    const systemTokens = 1000;
    const messagesTokens = 100_000;
    expect(shouldTriggerCompaction(systemTokens, messagesTokens)).toBe(false);
  });

  it('respects calibration ratio', () => {
    const systemTokens = 1000;
    const messagesTokens = 500_000;
    // With ratio 1.0, total = 501,000 < 950,000 (S4a 缺省 95%) → no trigger
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 1.0)).toBe(false);
    // With ratio 2.0, total = 1,002,000 > 950,000 → trigger
    //（S4a 前阈值 750K，ratio 1.6 即触发；缺省红线抬到 95% 后本例改 2.0——行为变化有因更新）
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 2.0)).toBe(true);
  });

  it('accepts injected window/redline (S4a parameterized triggers)', () => {
    const systemTokens = 0;
    const messagesTokens = 160_000;
    // 200K 窗口（如 GLM-5.1）× 80% 红线 = 160K → 到达即触发。
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 1.0, 200_000, 80)).toBe(true);
    // 同估算在 1M 缺省窗口下远未到红线 → 不触发。
    expect(shouldTriggerCompaction(systemTokens, messagesTokens, 1.0)).toBe(false);
  });

  it('detects projection overflow (trigger ③: estimate + reply reserve > window)', () => {
    // 窗口 100K、预留 32,768：估算 68,000 + 32,768 > 100,000 → 溢出。
    expect(isProjectionOverflow(68_000, 1.0, 100_000)).toBe(true);
    // 估算 60,000 + 32,768 < 100,000 → 塞得下。
    expect(isProjectionOverflow(60_000, 1.0, 100_000)).toBe(false);
    expect(CONTEXT_REPLY_RESERVE_TOKENS).toBeGreaterThan(0);
  });

  it('clamps redline percent and resolves window defensively', () => {
    expect(clampRedlinePercent(undefined)).toBe(DEFAULT_REDLINE_PERCENT);
    expect(clampRedlinePercent(Number.NaN)).toBe(DEFAULT_REDLINE_PERCENT);
    expect(clampRedlinePercent(10)).toBe(50);   // 低于下限 → 50
    expect(clampRedlinePercent(150)).toBe(100); // 高于上限 → 100
    expect(clampRedlinePercent(80)).toBe(80);
    expect(resolveContextWindowTokens(undefined)).toBe(CONTEXT_WINDOW);
    expect(resolveContextWindowTokens(-5)).toBe(CONTEXT_WINDOW);
    expect(resolveContextWindowTokens(Number.NaN)).toBe(CONTEXT_WINDOW);
    expect(resolveContextWindowTokens(200_000)).toBe(200_000);
    // 历史锚点：S4 前固定触发线 0.75 保留为导出常量（不再是缺省）。
    expect(COMPACTION_TRIGGER_RATIO).toBe(0.75);
  });

  it('updates calibration ratio with EMA', () => {
    const ratio = updateCalibrationRatio(1.0, 1000, 800);
    // observed = 1000/800 = 1.25
    // new = 1.0 * 0.8 + 1.25 * 0.2 = 0.8 + 0.25 = 1.05
    expect(ratio).toBeCloseTo(1.05, 5);
  });

  it('ignores invalid values in calibration', () => {
    expect(updateCalibrationRatio(1.0, 0, 800)).toBe(1.0);
    expect(updateCalibrationRatio(1.0, 1000, 0)).toBe(1.0);
    expect(updateCalibrationRatio(1.0, -1, 100)).toBe(1.0);
  });

  // task 09-01 B 波 B2（R2.3b / 复查 M2，AC12b）：image parts 不在 content 字符串里，
  // 估算对 `m.images` 逐图加固定预算——红线/投影判定、校准环（贴图会话后续纯文本轮
  // 不再被系统性抬高的 ratio 过早压缩）、summarizer 决策三处口径一并修复。
  describe('image token budget（B2 R2.3b / 复查 M2）', () => {
    const baseMsg: SessionMessage = { id: '1', role: 'user', content: '看图', createdAt: 1 };

    it('IMAGE_TOKEN_BUDGET 常量锚点 = 2,500（归一后保守上界，design §2.3b）', () => {
      expect(IMAGE_TOKEN_BUDGET).toBe(2_500);
    });

    it('单图：估算 = 无图基线 + 恰好一份固定预算（≥ 每图预算，AC12b）', () => {
      const base = estimateMessagesTokens([baseMsg]);
      const withOne = estimateMessagesTokens([
        { ...baseMsg, images: [{ path: 'inbox/images/a.png', b64hash: 'h1', name: 'a' }] },
      ]);
      expect(withOne).toBe(base + IMAGE_TOKEN_BUDGET);
      expect(withOne).toBeGreaterThanOrEqual(IMAGE_TOKEN_BUDGET);
    });

    it('多图：逐图线性加算（3 图 = 基线 + 3×预算），图间互不干扰', () => {
      const base = estimateMessagesTokens([baseMsg]);
      const withThree = estimateMessagesTokens([
        {
          ...baseMsg,
          images: [
            { path: 'inbox/images/1.png', b64hash: 'b1', name: '一' },
            { path: 'inbox/images/2.png', b64hash: 'b2', name: '二' },
            { path: 'inbox/images/3.png', b64hash: 'b3', name: '三' },
          ],
        },
      ]);
      expect(withThree).toBe(base + 3 * IMAGE_TOKEN_BUDGET);
    });

    it('images 空数组 = 无字段消息零变化（防御：不产 0×预算以外的差异）', () => {
      const base = estimateMessagesTokens([baseMsg]);
      expect(estimateMessagesTokens([{ ...baseMsg, images: [] }])).toBe(base);
    });

    it('无 images 的既有消息零变化（回归：字段缺席不触发任何加算）', () => {
      const messages: SessionMessage[] = [
        { id: '1', role: 'user', content: '正文', createdAt: 1 },
        { id: '2', role: 'assistant', content: '回答', createdAt: 2 },
      ];
      // 与逐字段手算等值（content 估算 + 每消息 4 framing）——images 加算路径零参与。
      const expected = messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
      expect(estimateMessagesTokens(messages)).toBe(expected);
    });

    it('图预算进红线口径：贴图消息把估算顶过触发线（三触发消费同一估算）', () => {
      // 构造：正文估算极小 + 384 图（384×2500 = 960,000 ≥ 950,000 缺省红线）→ 触发。
      const manyImages = Array.from({ length: 384 }, (_, i) => ({
        path: `inbox/images/${i}.png`,
        b64hash: `h${i}`,
        name: `${i}`,
      }));
      const tokens = estimateMessagesTokens([{ ...baseMsg, images: manyImages }]);
      expect(shouldTriggerCompaction(0, tokens)).toBe(true);
      // 同估算去掉图 → 远低于触发线（对照：预算本身即差值来源）。
      const noImages = estimateMessagesTokens([baseMsg]);
      expect(shouldTriggerCompaction(0, noImages)).toBe(false);
    });
  });
});

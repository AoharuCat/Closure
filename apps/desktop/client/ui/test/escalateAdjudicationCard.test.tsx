/**
 * 09-13 子3 W5（design §4.2 / D-d）：escalate 灰区裁决卡（EscalateAdjudicationCard）测试。
 *
 * 覆盖：
 * - 数据源 = escalateFindingsBySession[sid]（勿读 chapter_review metadata——F5 定谳）渲染
 *   findings（severity 色分/quote/subClass）+ 补充说明框。
 * - 勾选路由：全接受 → reviewAcceptFinal(undefined, sid)（resume accept——StoryDecision 登记
 *   在服务侧单源，UI 零登记代码）；含修订 → reviewRedo(合成 feedback, sid)；全未勾或全忽略 →
 *   提交禁用。
 * - 合成 feedback 格式（synthesizeEscalateFeedback 单源——reviewPhaseHelpers.test 已钉格式；
 *   此处断言接线透传 + 补充说明并入）。
 * - 再点同钮 = 取消勾选（三态互斥可回退）；放弃 → reviewAbort(sid)。
 */
import { act, cleanup, screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EscalateAdjudicationCard } from '../src/features/writing/EscalateAdjudicationCard';
import { useAppStore } from '../src/shared/store/appStore';
import type { EscalateFindingsEntry } from '../src/shared/store/chainTimeline';

const ENTRY: EscalateFindingsEntry = {
  source: 'reader-audit',
  route: 'escalate_user',
  chapterId: 'ch_001',
  items: [
    {
      severity: 'block',
      subClass: '设定矛盾',
      quote: '林晚秋知道保险柜密码',
      location: '第3场',
      explanation: '与第7章知情圈设定冲突',
    },
    {
      severity: 'warn',
      subClass: '叙事机会',
      quote: '瞒了七年的翻转线',
      location: '第5场',
      explanation: '若接受为真相可开启翻转线',
    },
  ],
  at: 1,
};

/** null = 无条目（键缺席形态）；缺省 = ENTRY。显式传 null 勿传 undefined（默认参陷阱）。 */
function seed(entry: EscalateFindingsEntry | null = ENTRY) {
  useAppStore.setState({
    resolvedLocale: 'en-US',
    escalateFindingsBySession: entry ? { 'sess-esc': entry } : {},
    reviewResumingBySession: {},
    reviewAcceptFinal: vi.fn().mockResolvedValue(undefined),
    reviewRedo: vi.fn().mockResolvedValue(undefined),
    reviewAbort: vi.fn().mockResolvedValue(undefined),
  } as any);
}

const getActions = () => useAppStore.getState() as unknown as {
  reviewAcceptFinal: ReturnType<typeof vi.fn>;
  reviewRedo: ReturnType<typeof vi.fn>;
  reviewAbort: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  seed();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pickBtn = (itemIdx: number, choice: 'accept' | 'revise' | 'ignore') =>
  screen.getAllByRole('group')[itemIdx]
    ?.querySelector(`.writing-escalate-pc-btn--${choice}`) as HTMLElement;

describe('EscalateAdjudicationCard — 渲染 + 路由（D-d）', () => {
  it('渲染 findings（数据源 = escalateFindingsBySession）+ 空勾选提交禁用', () => {
    render(<EscalateAdjudicationCard sessionId="sess-esc" />);

    expect(screen.getByText('设定矛盾')).toBeTruthy();
    expect(screen.getByText(/与第7章知情圈设定冲突/)).toBeTruthy();
    expect(screen.getByText('「林晚秋知道保险柜密码」')).toBeTruthy();
    // 全未勾 → 提交禁用 + 提示。
    expect(screen.getByRole('button', { name: /Submit picks/ })).toBeDisabled();
    expect(screen.getByText(/none picked or all ignored/)).toBeTruthy();
  });

  it('条目缺席（无 escalateFindings 键）→ 渲染空（不猜数据）', () => {
    seed(null);
    const { container } = render(<EscalateAdjudicationCard sessionId="sess-esc" />);
    expect(container.querySelector('.writing-escalate')).toBeNull();
  });

  it('全接受 → reviewAcceptFinal(undefined, sid, 合成 feedback)（勾选意见随 accept 携带——服务侧登记 escalate_accepted 可知条目）', async () => {
    render(<EscalateAdjudicationCard sessionId="sess-esc" />);

    await userEvent.click(pickBtn(0, 'accept'));
    await userEvent.click(pickBtn(1, 'accept'));

    const submit = screen.getByRole('button', { name: /Submit picks/ });
    expect(submit).toBeEnabled();
    expect(submit.textContent).toContain('2 accepted');
    expect(submit.textContent).toContain('0 revised');

    await userEvent.click(submit);
    const call = getActions().reviewAcceptFinal.mock.calls[0];
    expect(call[0]).toBeUndefined();
    expect(call[1]).toBe('sess-esc');
    expect(String(call[2])).toContain('#1');
    expect(String(call[2])).toContain('接受为真相');
    expect(getActions().reviewRedo).not.toHaveBeenCalled();
  });

  it('全接受 + supplement 非空 → reviewAcceptFinal 第三参携带合成 feedback（CR-5：不静默丢用户输入）', async () => {
    render(<EscalateAdjudicationCard sessionId="sess-esc" />);

    await userEvent.click(pickBtn(0, 'accept'));
    await userEvent.click(pickBtn(1, 'accept'));
    await userEvent.type(screen.getByPlaceholderText(/Supplement/), '以正文为准，翻转线接受');

    await userEvent.click(screen.getByRole('button', { name: /Submit picks/ }));
    const call = getActions().reviewAcceptFinal.mock.calls[0];
    expect(call[0]).toBeUndefined();
    expect(call[1]).toBe('sess-esc');
    expect(String(call[2])).toContain('以正文为准，翻转线接受');
    expect(String(call[2])).toContain('接受为真相');
  });

  it('含修订 → reviewRedo(合成 feedback, sid)——勾选即意见 + 补充说明并入', async () => {
    render(<EscalateAdjudicationCard sessionId="sess-esc" />);

    await userEvent.click(pickBtn(0, 'accept'));
    await userEvent.click(pickBtn(1, 'revise'));
    await userEvent.type(
      screen.getByPlaceholderText(/Supplement/),
      '维持设定',
    );

    await userEvent.click(screen.getByRole('button', { name: /Submit picks/ }));

    expect(getActions().reviewRedo).toHaveBeenCalledTimes(1);
    const [feedback, sid] = getActions().reviewRedo.mock.calls[0] as [string, string];
    expect(sid).toBe('sess-esc');
    expect(feedback).toBe(
      '#1 [林晚秋知道保险柜密码] 接受为真相；#2 [瞒了七年的翻转线] 修订\n补充说明：维持设定',
    );
    expect(getActions().reviewAcceptFinal).not.toHaveBeenCalled();
  });

  it('全忽略 → 提交禁用（忽略不构成裁决）；再点同钮可取消勾选回退', async () => {
    render(<EscalateAdjudicationCard sessionId="sess-esc" />);

    await userEvent.click(pickBtn(0, 'ignore'));
    await userEvent.click(pickBtn(1, 'ignore'));
    expect(screen.getByRole('button', { name: /Submit picks/ })).toBeDisabled();

    // 取消第二条忽略 → 改勾修订 → 可提交。
    await userEvent.click(pickBtn(1, 'ignore'));
    await userEvent.click(pickBtn(1, 'revise'));
    expect(screen.getByRole('button', { name: /Submit picks/ })).toBeEnabled();
  });

  it('放弃 → reviewAbort(sid)；reviewResuming 在途全钮禁用', async () => {
    render(<EscalateAdjudicationCard sessionId="sess-esc" />);
    await userEvent.click(screen.getByRole('button', { name: /Abort chapter/ }));
    expect(getActions().reviewAbort).toHaveBeenCalledWith('sess-esc');

    // 在途：勾选钮 + 提交 + 放弃全禁用。
    act(() => {
      useAppStore.setState({ reviewResumingBySession: { 'sess-esc': true } } as any);
    });
    expect(pickBtn(0, 'accept')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Submit picks/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Abort chapter/ })).toBeDisabled();
  });
});

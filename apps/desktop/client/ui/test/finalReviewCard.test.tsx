/**
 * 09-13 子3 W5（design §4.1 + mockup §2）：终稿审阅卡（FinalReviewCard）测试。
 *
 * 覆盖（CR-18 interim final 分支自 ChapterReviewPanel 随迁 + W5 升级断言）：
 * - 渲染面：自审摘要折叠区（reviewSummary verdict/reasons/loops + lintReport pre 直出；
 *   载荷缺席如实行）/ editable 编辑器（mock textarea 承 onChange）/ 字数实时 / 动作三钮。
 * - 手改追踪：编辑 → dirty 指示 + 接受钮「携 N 处手改」；无变化 → accept 无 editedDraft；
 *   手改清空正文 → 接受禁用 + invalid 提示。
 * - 打回面板（D-c 意见必填）：空意见提交禁用 / chips 点填 / 提交 → reviewRedo(feedback, sid)。
 * - 放弃确认弹层 → reviewAbort(sid)。
 * - 接受动作 slice 化：reviewAcceptFinal(editedDraft?, sid) 转发（和解分支在
 *   chapterReviewSlice.test.ts 的 reviewAcceptFinal 块覆盖——组件只转发）。
 * - 选区精修（新交互形态）：选区 → 浮层 → 指令卡（quote 预填 + 粗指令）→ compileIntent 参数
 *   （draftText = 当前编辑器文本）；compiledIntent → RevisionIntentConfirmCard → 确认转发
 *   confirmRedoWithIntent。
 * - 新审阅轮次（pausedReview 引用变化）→ 编辑器重挂（epoch）+ 本地手改态清。
 *
 * TiptapEditor mock 成受控 textarea（onChange 直调——jsdom 无 ProseMirror；en locale 真实 i18n）。
 */
import { act, cleanup, screen, render, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinalReviewCard } from '../src/features/writing/FinalReviewCard';
import { useAppStore } from '../src/shared/store/appStore';
import type { ChapterReviewMetadata, RevisionIntent } from '@orison/shared-contracts';

// Mock TiptapEditor：受控形态——content 显初值，textarea onChange 直调（模拟手改）。
vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '', onChange, onSelectionChange }: {
    content?: string;
    onChange?: (v: string) => void;
    onSelectionChange?: (s: { text: string; from: number; to: number } | null) => void;
  }) => (
    <div data-testid="mock-tiptap" data-content={content}>
      <textarea
        aria-label="mock-editor"
        onChange={(e) => onChange?.(e.target.value)}
      />
      <button
        type="button"
        aria-label="mock-select"
        onClick={() => onSelectionChange?.({ text: '被选中的文字。', from: 3, to: 10 })}
      />
    </div>
  ),
}));

const DRAFT = '第一段原文。\n\n第二段原文保持。';
const finalMeta: ChapterReviewMetadata = {
  type: 'chapter_review',
  stage: 'final',
  chapterId: 'ch_001',
  draftContent: DRAFT,
  resumeOptions: ['accept', 'redo', 'abort'],
  reviewSummary: { verdict: 'accept', reasons: ['硬伤已闭合', '节奏已补'], loopCount: 2, capExhausted: false },
  lintReport: '去味终态：3 命中（高优 1）。',
};

const SAMPLE_INTENT: RevisionIntent = {
  change: { summary: '把犹豫写得更克制' },
  lockedItems: [],
  rationale: { source: 'user-directive', note: '用户选段指挥精修' },
  provenance: { rawUserInstruction: '指令', compilerNote: '锁定无' },
};

function seedActions() {
  useAppStore.setState({
    resolvedLocale: 'en-US',
    pausedReviewBySession: {},
    reviewResumingBySession: {},
    reviewSelectionBySession: {},
    compiledIntentBySession: {},
    intentCompilingBySession: {},
    intentCompileErrorBySession: {},
    reviewAcceptFinal: vi.fn().mockResolvedValue(undefined),
    reviewRedo: vi.fn().mockResolvedValue(undefined),
    reviewAbort: vi.fn().mockResolvedValue(undefined),
    // setReviewSelection / clearCompiledIntent 用真实实现（选区浮层/确认卡取消链路走真 store
    // ——mock 会静默吞写入，浮层永现不了）。
    compileIntent: vi.fn().mockResolvedValue(undefined),
    confirmRedoWithIntent: vi.fn().mockResolvedValue(undefined),
  } as any);
}

beforeEach(() => {
  seedActions();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function seedFinal(meta: ChapterReviewMetadata = finalMeta) {
  useAppStore.setState({
    pausedReviewBySession: { 'sess-final': meta },
  } as any);
}

const getActions = () => useAppStore.getState() as unknown as {
  reviewAcceptFinal: ReturnType<typeof vi.fn>;
  reviewRedo: ReturnType<typeof vi.fn>;
  reviewAbort: ReturnType<typeof vi.fn>;
  compileIntent: ReturnType<typeof vi.fn>;
  confirmRedoWithIntent: ReturnType<typeof vi.fn>;
};

describe('FinalReviewCard — 渲染面', () => {
  it('自审摘要折叠区（verdict/reasons 计数/loops + lintReport pre 直出）+ 编辑器初值 + 动作三钮', () => {
    seedFinal();
    const { container } = render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    expect(screen.getByText('AI self-review summary')).toBeTruthy();
    // 摘要行：verdict 元素 + 理由计数 + 圈数（折叠行 + 展开体两处——getAll）。
    expect(container.querySelector('.writing-final-summary-v')?.textContent).toBe('accept');
    expect(screen.getByText('2 reasons')).toBeTruthy();
    expect(screen.getByText('Anti-slop lint report')).toBeTruthy();
    expect(screen.getAllByText('Self-review converged in 2 laps · under cap').length).toBe(2);
    // lintReport digest 直出（degraded 占位串同路径——如实显示）。
    expect(screen.getByText('去味终态：3 命中（高优 1）。')).toBeTruthy();
    // 编辑器初值 + 动作。
    expect(screen.getByTestId('mock-tiptap').getAttribute('data-content')).toBe(DRAFT);
    expect(screen.getByRole('button', { name: 'Accept & continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send back/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Abort chapter/ })).toBeTruthy();
  });

  it('载荷缺席 reviewSummary → 如实行（不造数）', () => {
    seedFinal({ ...finalMeta, reviewSummary: undefined, lintReport: undefined });
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);
    expect(screen.getAllByText(/no self-review summary/).length).toBeGreaterThan(0);
  });
});

describe('FinalReviewCard — 手改追踪', () => {
  it('编辑 → dirty 指示 + 接受钮「携 N 处手改」→ reviewAcceptFinal(editedText, sid)', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    const editor = screen.getByLabelText('mock-editor');
    // 单段改词（countEditRegions = 1 处）。
    fireEvent.change(editor, { target: { value: '第一段已改。\n\n第二段原文保持。' } });

    expect(screen.getByText('Unaccepted manual edits')).toBeTruthy();
    // CR-18a：en 文案措辞规避复数（"manual edits: {n}"）——1 处不再渲染 "1 manual edits"。
    expect(screen.getByRole('button', { name: 'Accept & continue · manual edits: 1' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Accept & continue/ }));
    expect(getActions().reviewAcceptFinal).toHaveBeenCalledWith('第一段已改。\n\n第二段原文保持。', 'sess-final');
  });

  it('无变化 → accept 不携 editedDraft（IPC 无载荷 = 接受 AI 原稿）', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    await userEvent.click(screen.getByRole('button', { name: 'Accept & continue' }));
    expect(getActions().reviewAcceptFinal).toHaveBeenCalledWith(undefined, 'sess-final');
  });

  it('手改清空正文 → 接受禁用 + invalid 提示（清空出口 = 放弃，contracts 空白串防线同源）', () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    fireEvent.change(screen.getByLabelText('mock-editor'), { target: { value: '   ' } });

    expect(screen.getByText(/Edited text is empty/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accept & continue/ })).toBeDisabled();
    expect(getActions().reviewAcceptFinal).not.toHaveBeenCalled();
  });

  it('新审阅轮次（pausedReview 引用变化 = redo 后新终稿）→ 本地手改态清 + 编辑器重挂新内容', () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);
    fireEvent.change(screen.getByLabelText('mock-editor'), { target: { value: '手改未提交' } });
    expect(screen.getByText('Unaccepted manual edits')).toBeTruthy();

    // redo 后新终稿（同 sid 新对象）。
    actSetPaused({ ...finalMeta, draftContent: '重写后的新终稿。' });

    expect(screen.queryByText('Unaccepted manual edits')).toBeNull();
    expect(screen.getByTestId('mock-tiptap').getAttribute('data-content')).toBe('重写后的新终稿。');
  });
});

describe('FinalReviewCard — 打回面板（D-c 意见必填）', () => {
  it('空意见 → 提交禁用；chips 点填 → 提交 → reviewRedo(feedback, sid) + 面板收起', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    await userEvent.click(screen.getByRole('button', { name: /Send back/ }));
    const submit = screen.getByRole('button', { name: /Send back \(whole chapter\)/ });
    expect(submit).toBeDisabled();

    // chips 点填（空则置入）。
    await userEvent.click(screen.getByRole('button', { name: /Back half rushes/ }));
    expect(screen.getByPlaceholderText(/Describe why/)).toHaveValue('Back half rushes');
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(getActions().reviewRedo).toHaveBeenCalledWith('Back half rushes', 'sess-final');
    // 面板收起 + 意见清（重开为空）。
    expect(screen.queryByRole('button', { name: /Send back \(whole chapter\)/ })).toBeNull();
  });

  it('再次点 chip → 追加分号（方向累积）', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    await userEvent.click(screen.getByRole('button', { name: /Send back/ }));
    await userEvent.click(screen.getByRole('button', { name: /Back half rushes/ }));
    await userEvent.click(screen.getByRole('button', { name: /More scene description/ }));

    const area = screen.getByPlaceholderText(/Describe why/) as HTMLTextAreaElement;
    expect(area.value).toContain('；');
  });
});

describe('FinalReviewCard — 放弃确认', () => {
  it('确认弹层 → 确认放弃 → reviewAbort(sid)；取消不动', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    await userEvent.click(screen.getByRole('button', { name: /Abort chapter/ }));
    expect(screen.getByText('Abort this chapter?')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(getActions().reviewAbort).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Abort chapter/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm abort' }));
    expect(getActions().reviewAbort).toHaveBeenCalledWith('sess-final');
  });
});

describe('FinalReviewCard — 选区精修（W4 键控 API 新交互形态）', () => {
  it('选区 → 浮层 → 指令卡（quote 预填）→ 编译（draftText = 当前编辑器文本）→ 确认卡转发', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);

    // 手改后再选区——compileIntent 的 draftText 应为编辑后文本（选区与 doc 同源）。
    fireEvent.change(screen.getByLabelText('mock-editor'), { target: { value: '手改后的正文。' } });
    fireEvent.click(screen.getByLabelText('mock-select'));

    expect(screen.getByRole('button', { name: 'Refine by instruction' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Refine by instruction' }));

    // 指令卡：quote 预填 + 粗指令输入。
    expect(screen.getByText('被选中的文字。')).toBeTruthy();
    const input = screen.getByPlaceholderText(/Instruct on the selected passage/);
    await userEvent.type(input, '把犹豫写得更克制');

    await userEvent.click(screen.getByRole('button', { name: /Compile intent/ }));
    expect(getActions().compileIntent).toHaveBeenCalledWith(
      '被选中的文字。',
      '把犹豫写得更克制',
      3,
      10,
      '手改后的正文。',
      undefined,
      'sess-final',
    );

    // compiledIntent 落 store → 确认卡（共用组件）→ 确认转发 confirmRedoWithIntent。
    actSetState({ compiledIntentBySession: { 'sess-final': SAMPLE_INTENT } });
    expect(screen.getByRole('button', { name: 'Confirm and redo' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and redo' }));
    expect(getActions().confirmRedoWithIntent).toHaveBeenCalledWith(SAMPLE_INTENT, 'sess-final');
  });

  it('编译失败 → 显错不清卡（graceful）', async () => {
    seedFinal();
    render(<FinalReviewCard sessionId="sess-final" chapterTitle={null} />);
    fireEvent.click(screen.getByLabelText('mock-select'));
    await userEvent.click(screen.getByRole('button', { name: 'Refine by instruction' }));

    actSetState({ intentCompileErrorBySession: { 'sess-final': 'optimizer 超时' } });
    expect(screen.getByText(/optimizer 超时/)).toBeTruthy();
  });
});

/** store 突变包 act（React 警告洁净——组件订阅 store 需批处理边界）。 */
function actSetState(partial: Record<string, unknown>) {
  act(() => {
    useAppStore.setState(partial as any);
  });
}

function actSetPaused(meta: ChapterReviewMetadata) {
  act(() => {
    useAppStore.setState({ pausedReviewBySession: { 'sess-final': meta } } as any);
  });
}

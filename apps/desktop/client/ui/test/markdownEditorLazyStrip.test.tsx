/**
 * CR-12（dogfood R3 修复批 CR patch）：MarkdownEditor 章标记剥离惰性化。
 *
 * 剥离是全文扫描（R3 实书 1.4MB / 98 标记），此前 useRef 初始化器 + JSX 内联 prop
 * 每个 render 都重跑——autoSave debounce 期每次序列化回写都重复触发。修后按编辑器
 * seed 身份（`${file.id}:${revision}`——与 TiptapEditor mount key 同源）缓存一次：
 * mount 捕获；tab 切换 / 外部重载（key 换代）重捕获；纯编辑 re-render 复用零重扫。
 *
 * 断言工具：partial-mock chapter-markers 模块（实际实现包 spy 计数
 * stripChapterMarkers 调用次数）。行为等价（剥/拼双射、回拼保标记）由
 * markdownEditorMarkers / chapterMarkers 套件钉住，此处只钉「每 seed 一次」。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/utils/chapter-markers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/utils/chapter-markers')>();
  return { ...actual, stripChapterMarkers: vi.fn(actual.stripChapterMarkers) };
});

vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '', onChange }: { content?: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="Mock Tiptap"
      value={content}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

import { useAppStore } from '../src/shared/store/appStore';
import { MarkdownEditor } from '../src/features/editor/file-editor/MarkdownEditor';
import { stripChapterMarkers } from '../src/shared/utils/chapter-markers';
import { stripFrontmatter } from '../src/shared/utils/frontmatter';
import type { FileTab } from '../src/shared/store/fileTabsSlice';

const stripSpy = vi.mocked(stripChapterMarkers);

function makeTab(id: string, path: string, content: string): FileTab {
  return { id, path, name: path.split('/').pop() ?? path, content, savedContent: content, kind: 'text' };
}

/** Mirror FileEditor: select the tab from the live store so edits re-render. */
function Harness({ path }: { path: string }) {
  const file = useAppStore((s) => s.openFiles.find((f) => f.path === path));
  if (!file) return null;
  return <MarkdownEditor file={file} />;
}

function getEditor(container: HTMLElement): HTMLTextAreaElement {
  const ta = container.querySelector('textarea[aria-label="Mock Tiptap"]');
  expect(ta).toBeTruthy();
  return ta as HTMLTextAreaElement;
}

const M0 = '<!-- mat-chapter index=0 title="书名页" method=regex confidence=high -->';
const M1 = '<!-- mat-chapter index=1 title="预付200万日元" method=regex confidence=high -->';
const DERIVED = `${M0}\r\n书名：无法告白：\r\nbook_id=7546823812877143065\r\n\r\n${M1}\r\n\r\n预付200万日元\r\n正文第一段。\r\n`;
const DERIVED_PATH = '/demo/materials/.derived/无法告白：.md';
const OTHER_PATH = '/demo/materials/.derived/另一本.md';

beforeEach(() => {
  stripSpy.mockClear();
  (window as any).orisonDesktop = {
    writeFile: vi.fn(async () => true),
  };
  useAppStore.setState({
    openFiles: [],
    activeFilePath: null,
    resolvedLocale: 'en-US',
    currentProject: { name: 'Demo', path: '/demo', type: 'novel' },
  } as any);
});

afterEach(cleanup);

describe('MarkdownEditor 章标记剥离惰性化（CR-12）', () => {
  it('mount 捕获一次；纯编辑 re-render（autoSave debounce 形态）零重扫', () => {
    // 预取编辑器 body（本调用进 spy——清零后 mount 计数从零起）。
    const emitted = stripChapterMarkers(stripFrontmatter(DERIVED)).body;
    stripSpy.mockClear();
    useAppStore.setState({ openFiles: [makeTab('tab-1', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    expect(stripSpy).toHaveBeenCalledTimes(1);

    // 编辑序列化回写 → store 更新 → re-render（每击键 debounce tick 同型）。
    const ta = getEditor(container);
    for (const text of [emitted, `${emitted}多一段。`, `${emitted}再多一段。`]) {
      fireEvent.change(ta, { target: { value: text } });
    }
    expect(stripSpy).toHaveBeenCalledTimes(1); // 复用 seed 快照，零重扫

    // 行为等价 belt：回拼仍携带全部标记（memo 源无 stale）。
    const tab = useAppStore.getState().openFiles.find((f) => f.path === DERIVED_PATH)!;
    expect(tab.content).toContain(M0);
    expect(tab.content).toContain(M1);
  });

  it('外部重载（revision 换代）恰重捕获一次，后续编辑继续复用', async () => {
    useAppStore.setState({ openFiles: [makeTab('tab-2', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    expect(stripSpy).toHaveBeenCalledTimes(1);
    expect(getEditor(container).value).toContain('book_id');

    const M9 = '<!-- mat-chapter index=9 title="新章" method=manual -->';
    const disk = `${M9}\n新章标题\n新正文。\n`;
    act(() => {
      useAppStore.setState((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === DERIVED_PATH ? { ...f, content: disk, savedContent: disk, externalState: undefined } : f,
        ),
      }) as any);
    });

    await waitFor(() => expect(getEditor(container).value).toContain('新章标题'));
    expect(stripSpy).toHaveBeenCalledTimes(2); // mount + reload seed，不多不少

    // 重载后的编辑继续复用新 seed（不再重扫）。
    fireEvent.change(getEditor(container), { target: { value: '新章标题\n改动' } });
    expect(stripSpy).toHaveBeenCalledTimes(2);
    const tab = useAppStore.getState().openFiles.find((f) => f.path === DERIVED_PATH)!;
    expect(tab.content).toBe(`${M9}\n新章标题\n改动`);
  });

  it('tab 切换（file.id 换代）恰重捕获一次', () => {
    const other = `${M0}\n另一本书。\n`;
    useAppStore.setState({
      openFiles: [makeTab('tab-3', DERIVED_PATH, DERIVED), makeTab('tab-4', OTHER_PATH, other)],
    } as any);

    const { container, rerender } = render(<Harness path={DERIVED_PATH} />);
    expect(stripSpy).toHaveBeenCalledTimes(1);

    rerender(<Harness path={OTHER_PATH} />);
    expect(getEditor(container).value).toContain('另一本书。');
    expect(stripSpy).toHaveBeenCalledTimes(2);
  });
});

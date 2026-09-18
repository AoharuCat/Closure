/**
 * dogfood R3 / R10（C1）：派生 .md 章标记的富文本编辑往返。
 *
 * 覆盖（mirror markdownEditorFrontmatter 测试形态 + implement.md W3a）：
 * - 加载剥离：带 mat-chapter 标记行的派生 .md 进 MarkdownEditor，编辑区不含
 *   标记行；打开即干净（content === savedContent，不因标记误标 dirty）。
 * - 编辑回拼逐字节保序：CRLF 标记行原文回拼（parse→re-stringify 禁止）——
 *   未编辑正文 round-trip 后 tab 全文与盘上原文字节一致。
 * - autoSave 红线：saveFile 落盘内容必含全部标记行（丢标记 = 章界崩坏 →
 *   重摄取 0 章假态 + 拆书 F12 竞态，回到要防的事故链）。
 * - 锚删除语义：用户删掉某章锚行 → 该标记不落盘（残章语义交重摄取）。
 * - 序列化 gap 丢失（tier 3 回落）：编辑器输出剥掉首标记前空行 → 标记仍回拼。
 * - 外部重载重捕获：标记随新盘上内容重捕获，后续编辑回拼新标记。
 * - frontmatter 共存：剥（frontmatter→markers）/ 拼（markers→frontmatter）顺序固定。
 *
 * TiptapEditor mock 成受控 textarea（jsdom 不支持 ProseMirror；onChange 即编辑器
 * emit 的 body-only markdown——LF、无标记）。store 用真实 useAppStore setState 注入。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/shared/store/appStore';
import { MarkdownEditor } from '../src/features/editor/file-editor/MarkdownEditor';
import { stripChapterMarkers } from '../src/shared/utils/chapter-markers';
import { stripFrontmatter } from '../src/shared/utils/frontmatter';
import type { FileTab } from '../src/shared/store/fileTabsSlice';

vi.mock('../src/features/editor/TiptapEditor', () => ({
  TiptapEditor: ({ content = '', onChange }: { content?: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="Mock Tiptap"
      value={content}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

function makeTab(id: string, path: string, content: string): FileTab {
  // kind:'text' — reconcileExternalFile/saveFile gate on it.
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

function getTab(path: string): FileTab {
  const tab = useAppStore.getState().openFiles.find((f) => f.path === path);
  expect(tab).toBeTruthy();
  return tab as FileTab;
}

/** R3 实样形态（CRLF、首标记直贴内容行、次标记带空行 gap）。 */
const M0 = '<!-- mat-chapter index=0 title="书名页" method=regex confidence=high -->';
const M1 = '<!-- mat-chapter index=1 title="预付200万日元" method=regex confidence=high -->';
const DERIVED = `${M0}\r\n书名：无法告白：\r\nbook_id=7546823812877143065\r\n\r\n${M1}\r\n\r\n预付200万日元\r\n正文第一段。\r\n`;
const DERIVED_PATH = '/demo/materials/.derived/无法告白：.md';

beforeEach(() => {
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

describe('MarkdownEditor mat-chapter 标记处理（R10）', () => {
  it('feeds the editor the body only and opens clean (no marker-line dirty flag)', () => {
    useAppStore.setState({ openFiles: [makeTab('tab-1', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    const ta = getEditor(container);
    expect(ta.value).not.toContain('mat-chapter');
    expect(ta.value).toContain('book_id=7546823812877143065');
    expect(ta.value).toContain('预付200万日元');
    // Full-text tab model: marker lines live in the tab, not the editor, so
    // opening does not mark the file dirty.
    expect(getTab(DERIVED_PATH).content).toBe(DERIVED);
    expect(getTab(DERIVED_PATH).content === getTab(DERIVED_PATH).savedContent).toBe(true);
  });

  it('unchanged body round-trips to the byte-exact original (CRLF markers preserved)', () => {
    useAppStore.setState({ openFiles: [makeTab('tab-2', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    const ta = getEditor(container);
    // The editor emits its body unchanged — splice must restore the original
    // byte-for-byte, including both CRLF marker lines.
    const emitted = stripChapterMarkers(stripFrontmatter(DERIVED)).body;
    fireEvent.change(ta, { target: { value: emitted } });

    expect(getTab(DERIVED_PATH).content).toBe(DERIVED);
  });

  it('autosave red line: saveFile writes every marker line to disk', async () => {
    useAppStore.setState({ openFiles: [makeTab('tab-3', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    const ta = getEditor(container);
    // LF-normalized serialization with an edit (what TipTap emits).
    fireEvent.change(ta, {
      target: { value: '书名：无法告白：\nbook_id=7546823812877143065\n\n预付200万日元\n编辑后的正文。' },
    });

    const ok = await useAppStore.getState().saveFile(DERIVED_PATH);
    expect(ok).toBe(true);

    const writeArg = (window.orisonDesktop.writeFile as any).mock.calls[0][1];
    // Both chapter markers survive, byte-exact CRLF lines and all.
    expect(writeArg).toContain(`${M0}\r\n`);
    expect(writeArg).toContain(`${M1}\r\n`);
    expect(writeArg).toContain('编辑后的正文。');
    expect(writeArg.startsWith(`${M0}\r\n`)).toBe(true);
  });

  it('a marker whose anchor line the user deleted is not written back', async () => {
    useAppStore.setState({ openFiles: [makeTab('tab-4', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    const ta = getEditor(container);
    // 第二章锚行（预付200万日元）被删。
    fireEvent.change(ta, { target: { value: '书名：无法告白：\nbook_id=7546823812877143065\n\n编辑后的正文。' } });

    await useAppStore.getState().saveFile(DERIVED_PATH);
    const writeArg = (window.orisonDesktop.writeFile as any).mock.calls[0][1];
    expect(writeArg).toContain(M0);
    expect(writeArg).not.toContain(M1);
  });

  it('serialization dropping the leading gap still re-splices the head marker (tier 3)', async () => {
    // 首标记后带空行 gap 的形态：TipTap 序列化会 trim 掉开头空行。
    const md = `${M0}\n\n书名：无法告白：\n\n正文。\n`;
    useAppStore.setState({ openFiles: [makeTab('tab-5', DERIVED_PATH, md)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    const ta = getEditor(container);
    fireEvent.change(ta, { target: { value: '书名：无法告白：\n\n正文。' } });

    await useAppStore.getState().saveFile(DERIVED_PATH);
    const writeArg = (window.orisonDesktop.writeFile as any).mock.calls[0][1];
    expect(writeArg.startsWith(`${M0}\n`)).toBe(true);
    expect(writeArg).toContain('书名：无法告白：');
  });

  it('external reload re-captures the markers from the new disk content', async () => {
    useAppStore.setState({ openFiles: [makeTab('tab-6', DERIVED_PATH, DERIVED)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    expect(getEditor(container).value).toContain('book_id');

    // Reingest rewrote the derived file: fewer/different markers now.
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
    const fresh = getEditor(container);
    expect(fresh.value).not.toContain('mat-chapter');

    // Subsequent edits re-splice the NEW markers.
    fireEvent.change(fresh, { target: { value: '新章标题\n改动' } });
    expect(getTab(DERIVED_PATH).content).toBe(`${M9}\n新章标题\n改动`);
  });

  it('front-matter and markers coexist with a fixed strip/splice order', async () => {
    const frontmatter = '---\r\nsource: derived\r\n---\r\n';
    const md = `${frontmatter}${M0}\r\n书名：无法告白：\r\n`;
    useAppStore.setState({ openFiles: [makeTab('tab-7', DERIVED_PATH, md)] } as any);

    const { container } = render(<Harness path={DERIVED_PATH} />);
    const ta = getEditor(container);
    expect(ta.value).not.toContain('---');
    expect(ta.value).not.toContain('source:');
    expect(ta.value).not.toContain('mat-chapter');
    expect(ta.value).toContain('书名：无法告白：');

    fireEvent.change(ta, { target: { value: '书名：无法告白：\n改动' } });
    await useAppStore.getState().saveFile(DERIVED_PATH);
    const writeArg = (window.orisonDesktop.writeFile as any).mock.calls[0][1];
    // front-matter first, then the spliced body with its marker line.
    expect(writeArg.startsWith(frontmatter)).toBe(true);
    expect(writeArg).toContain(`${M0}\r\n`);
  });
});

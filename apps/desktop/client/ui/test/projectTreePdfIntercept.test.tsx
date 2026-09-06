import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectTree } from '../src/features/project-tree/ProjectTree';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import { translate } from '../src/shared/i18n/useI18n';

// 09-01-agent-chat-attachments A5（R1.4 / AC5）：ProjectTree.handleSelect 原本只有
// 图片 / docx 分支，其余一切（含 pdf）落到文本读取路径——二进制按 UTF-8 读 = 乱码 tab。
// 本文件锁两个行为：.pdf 点击被拦截（不开 tab + info toast 指引拖入对话框）、
// .md 仍走原文本打开路径（回归）。

// zustand spy 纪律（spec/ui/testing.md）：toast 为全文件 no-op stub，文件级单 spy
// 一次设定 + beforeEach mockClear；不在测试体内 spyOn。
const showToastSpy = vi.spyOn(useToastStore.getState(), 'showToast').mockImplementation(() => {});

describe('ProjectTree pdf 点击拦截', () => {
  beforeEach(() => {
    localStorage.clear();
    showToastSpy.mockClear();
    useAppStore.setState({
      currentProject: null,
      openFiles: [],
      activeFilePath: null,
      mainView: 'files',
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  function seedProject(entries: { name: string; path: string }[]) {
    (window as any).orisonDesktop = {
      readDirectory: vi.fn(() => Promise.resolve(entries.map((e) => ({ ...e, isDir: false })))),
      readFile: vi.fn((p: string) => Promise.resolve(`text-of:${p}`)),
      watchProject: vi.fn(),
      unwatchProject: vi.fn(),
    };
    useAppStore.setState({
      currentProject: { projectId: 'p1', name: 'P', path: '/proj', type: 'novel' },
    } as any);
  }

  it('点击 .pdf 不走文本读取、不开 tab，弹 info toast 指引（AC5）', async () => {
    seedProject([{ name: 'outline.pdf', path: '/outline.pdf' }]);
    render(<ProjectTree />);
    fireEvent.click(await screen.findByText('outline.pdf'));

    // 未落文本读取路径（现状会把二进制按 UTF-8 读成乱码）
    expect((window as any).orisonDesktop.readFile).not.toHaveBeenCalled();
    // 不开任何 tab
    expect(useAppStore.getState().openFiles).toEqual([]);
    // 友好提示：i18n 消息（按 store 当前 locale 解析）+ info 档
    const locale = useAppStore.getState().resolvedLocale;
    expect(showToastSpy).toHaveBeenCalledTimes(1);
    expect(showToastSpy).toHaveBeenCalledWith(translate(locale, 'projectTree.pdfNoPreview'), 'info');
  });

  it('.md 仍走原文本打开路径（回归）', async () => {
    seedProject([{ name: 'note.md', path: '/note.md' }]);
    render(<ProjectTree />);
    fireEvent.click(await screen.findByText('note.md'));

    expect((window as any).orisonDesktop.readFile).toHaveBeenCalledWith('/proj/note.md');
    await waitFor(() => {
      const tabs = useAppStore.getState().openFiles;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        path: '/proj/note.md',
        name: 'note.md',
        content: 'text-of:/proj/note.md',
        kind: 'text',
      });
    });
    expect(showToastSpy).not.toHaveBeenCalled();
  });
});

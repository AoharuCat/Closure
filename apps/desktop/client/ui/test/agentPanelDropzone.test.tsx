/**
 * 09-01 A4（task 09-01-agent-chat-attachments R1.3/AC4）：AgentPanel 对话区拖拽进件。
 *
 * - 判据 = dataTransfer.files 非空才处理（内部拖拽章卡/大纲条目/结构槽位 files 恒空，
 *   天然过滤）；files 为空时零 preventDefault（fireEvent 返回值 = dispatchEvent 布尔，
 *   false 才是「被 preventDefault」）——不伤既有交互。
 * - 文档白名单（.txt/.md/.markdown/.docx/.pdf）→ 直调 A3 的 uploadInboxFiles（按钮
 *   上传同路径同结果，AC4）；pathForFile 换绝对路径 + importFiles 白名单 + resolve
 *   挂载全在 action 内，本体行为由 agentInboxAttachments.test.tsx 覆盖，不在此重测。
 * - 图片扩展名 → B4 的 uploadChatImages（canvas 预检压缩 → inbox/images/，本体行为
 *   由 agentChatImages.test.tsx 覆盖，不在此重测——09-01 B4 drop 分支接管）。
 * - 白名单外 → 拒收 toast（i18n，含文件名）。
 * - 拖入悬停 → 容器视觉反馈类；dragleave / drop 清除（抖动处理 mirror AssetsPanel）。
 *
 * uploadInboxFiles / uploadChatImages 经 store state 注入缝 stub（ui/testing.md vitest4
 * 纪律——不做测试体内 spyOn store action；全文件皆 stub 场景走 setState 注入缝）。
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

let uploadInboxFiles: ReturnType<typeof vi.fn>;
let uploadChatImages: ReturnType<typeof vi.fn>;

function seedStore(overrides: Record<string, unknown> = {}) {
  // 两段式 seed（agentPanelManualCompact.test 先例）：先落 currentProject（触发
  // projectSubscription 真切换重置），尘埃落定后再补会话态——一次性 setState 会被
  // 订阅内的重置同步清掉。
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project', type: 'novel' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'en-US',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    agentMessages: [],
    agentSkills: [],
    agentSkillError: null,
    loadAgentSkills: vi.fn().mockResolvedValue(undefined),
    skillPackages: [],
    skillPackagesLoading: false,
    loadSkillPackages: vi.fn().mockResolvedValue(undefined),
    toggleSkillPackage: vi.fn(),
    toggleSkill: vi.fn(),
    agentParticipationGear: 'smart',
    pendingAttachments: [],
    attachmentUploadStates: {},
    uploadInboxFiles, // 注入缝：drop 路径契约 = 「调它 + 传 doc File[]」。
    uploadChatImages, // 注入缝（B4）：drop 图片分支契约 = 「调它 + 传 image File[]」。
    ...overrides,
  } as any);
}

function mainEl(): HTMLElement {
  const el = document.querySelector('.agent-panel-main');
  if (!el) throw new Error('agent-panel-main not rendered');
  return el;
}

/** drop/dragOver 构造（jsdom 无可靠 DataTransfer——fireEvent 落普通属性，chapterWorkbench 先例）。 */
function dtWith(files: File[]): { dataTransfer: { files: File[] } } {
  return { dataTransfer: { files } };
}

function toastMessages(): string[] {
  return useToastStore.getState().toasts.map((t) => t.message);
}

beforeEach(() => {
  uploadInboxFiles = vi.fn().mockResolvedValue(undefined);
  uploadChatImages = vi.fn().mockResolvedValue(undefined);
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  (window as any).orisonDesktop = { abortAgentRun: vi.fn() };
});

afterEach(() => cleanup());

describe('AgentPanel 对话区拖拽进件（A4 文档分支，R1.3/AC4）', () => {
  it('白名单文档 drop → uploadInboxFiles 收到文档 File[]（与按钮上传同路径，AC4）+ preventDefault + 清悬停态', () => {
    seedStore();
    render(<AgentPanel />);

    fireEvent.dragOver(mainEl(), dtWith([new File(['x'], 'a.md')]));
    expect(mainEl().className).toContain('agent-panel-main--dragging');

    const doc1 = new File(['大纲'], '大纲.docx');
    const doc2 = new File(['笔记'], '笔记.markdown');
    // dispatchEvent 布尔语义：false = 被 preventDefault（drop 必须拦下浏览器默认开文件）。
    expect(fireEvent.drop(mainEl(), dtWith([doc1, doc2]))).toBe(false);

    expect(uploadInboxFiles).toHaveBeenCalledTimes(1);
    expect(uploadInboxFiles).toHaveBeenCalledWith([doc1, doc2]);
    expect(mainEl().className).not.toContain('agent-panel-main--dragging');
    expect(toastMessages()).toHaveLength(0);
  });

  it('files 为空（内部拖拽形态）→ 零处理零 preventDefault（不伤既有交互）', () => {
    seedStore();
    render(<AgentPanel />);

    // true = 未被 preventDefault（dragover 不放行 → 真浏览器 drop 本就不触发）。
    expect(fireEvent.dragOver(mainEl(), dtWith([]))).toBe(true);
    expect(mainEl().className).not.toContain('agent-panel-main--dragging');

    expect(fireEvent.drop(mainEl(), dtWith([]))).toBe(true);
    expect(uploadInboxFiles).not.toHaveBeenCalled();
  });

  it('图片扩展名 → uploadChatImages 收到 image File[]（B4 分支接管，与按钮/粘贴同 action），不进文档路径', () => {
    seedStore();
    render(<AgentPanel />);

    const png = new File(['x'], '截图.png');
    const gif = new File(['y'], '动图.gif');
    expect(fireEvent.drop(mainEl(), dtWith([png, gif]))).toBe(false);

    expect(uploadChatImages).toHaveBeenCalledTimes(1);
    expect(uploadChatImages).toHaveBeenCalledWith([png, gif]);
    expect(uploadInboxFiles).not.toHaveBeenCalled();
    expect(toastMessages()).toHaveLength(0); // 真实进件路径无占位/拒收 toast
  });

  it('白名单外扩展名 → 拒收 toast 含文件名与图片格式面（CR-020），不进上传路径', () => {
    seedStore();
    render(<AgentPanel />);

    fireEvent.drop(mainEl(), dtWith([new File(['x'], 'tool.exe')]));
    const messages = toastMessages();
    expect(messages.some((m) => m.includes('tool.exe'))).toBe(true);
    // CR-020：拒收文案补「或图片」——与实际接受面（文档白名单 + 图片白名单）一致。
    expect(messages.some((m) => m.includes('PNG / JPG / WEBP / GIF'))).toBe(true);
    expect(uploadInboxFiles).not.toHaveBeenCalled();
  });

  it('混合批次三分流：文档/图片各走各 action、其余拒收 toast（三支互不吞并）', () => {
    seedStore();
    render(<AgentPanel />);

    const doc = new File(['a'], 'a.txt');
    const img = new File(['i'], 'p.jpg');
    fireEvent.drop(mainEl(), dtWith([doc, img, new File(['x'], 'b.zip')]));

    expect(uploadInboxFiles).toHaveBeenCalledTimes(1);
    expect(uploadInboxFiles).toHaveBeenCalledWith([doc]);
    expect(uploadChatImages).toHaveBeenCalledTimes(1);
    expect(uploadChatImages).toHaveBeenCalledWith([img]);
    const messages = toastMessages();
    // 唯一 toast = 白名单外拒收（文档/图片是真实进件路径，反馈走各自 chip 状态机）。
    expect(messages).toHaveLength(1);
    expect(messages.some((m) => m.includes('b.zip'))).toBe(true);
  });

  it('dragleave 清悬停态（抖动处理 mirror AssetsPanel：dragging 态 + onDragLeave）', () => {
    seedStore();
    render(<AgentPanel />);

    fireEvent.dragOver(mainEl(), dtWith([new File(['x'], 'a.md')]));
    expect(mainEl().className).toContain('agent-panel-main--dragging');

    fireEvent.dragLeave(mainEl());
    expect(mainEl().className).not.toContain('agent-panel-main--dragging');
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';

// 09-01 A3（task 09-01-agent-chat-attachments）：AgentInput 上传入口 + inbox 材料
// 段 + chip 状态机 + description 异步回填 + M3 项目切换守卫。
//
// 覆盖：菜单两新段渲染 / accept 面 / uploading→parsing→ready|error 流转 / Send 门控
// （parsing 禁用） / importFiles 白名单转发（AC2 拒收 toast） / AC6f 哈希命中零 LLM
// / AC6g similar 复用零调用 + fresh 走生成 / AC6e 回填成功-失败-已发送三态 / AC6i
// inbox 材料段点击挂载 / M3 切项目清状态 + 在途回调不串项目。

import { AgentInput } from '../src/features/agent-panel/AgentInput';
import { useAppStore } from '../src/shared/store/appStore';
import {
  INBOX_UPLOAD_ACCEPT,
  NON_UTF8_ATTACHMENT_ADVISORY,
  classifyImportRejections,
  flattenInboxMaterials,
  shouldSkipAttachmentDescription,
} from '../src/shared/api/inboxAttachments';
import { useToastStore } from '../src/shared/store/toastStore';

const modelConfig: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
      models: [
        { id: 'gpt-4o', alias: 'GPT-4o', capability: 'text', enabled: true },
      ],
    },
  ],
};

const PROJECT_PATH = 'I:/echo/project';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: PROJECT_PATH, type: 'novel' },
  } as any);
  useAppStore.setState({
    resolvedLocale: 'en-US',
    modelConfig,
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    novelChapters: [],
    openFiles: [],
    pendingAttachments: [],
    attachmentUploadStates: {},
    pendingToolConfirmBySession: {},
    pendingPassageResolveBySession: {},
    draftPreset: null,
    ...overrides,
  } as any);
}

type Bridge = Record<string, any>;

function installBridge(overrides: Bridge = {}): Bridge {
  const bridge: Bridge = {
    abortAgentRun: vi.fn(),
    pathForFile: vi.fn((file: File) => `I:/外部/${file.name}`),
    importFiles: vi.fn(async () => ({ imported: [] as string[], rejected: [] as string[] })),
    resolveInboxAttachment: vi.fn(async () => ({ ok: false, error: 'boom' })),
    storeAttachmentDescription: vi.fn(async () => ({ ok: true, contentHash: 'sha256:x' })),
    generateText: vi.fn(async () => ({ model: 'm', text: '一份北境世界观设定大纲' })),
    readFile: vi.fn(async () => '第一章 北境的风……（正文）'),
    readDirectory: vi.fn(async () => [] as unknown[]),
    createAgentSession: vi.fn(async () => ({
      id: 'session-new',
      agentName: 'writer',
      projectPath: PROJECT_PATH,
      status: 'idle',
      messages: [],
    })),
    streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
    listAgentSessions: vi.fn(async () => ({ sessions: [] })),
    ...overrides,
  };
  (window as any).orisonDesktop = bridge;
  return bridge;
}

/** resolve ok 载荷构造器（默认 exact 命中带旧描述——AC6f 形态）。 */
function resolveOk(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    contentHash: 'sha256:abc',
    mtime: 1_700_000_000_000,
    preview: '北境设定预览',
    description: '旧描述',
    describedAt: 1_699_000_000_000,
    derivedPath: 'inbox/大纲.md',
    reused: 'exact',
    ...over,
  };
}

async function flushAsync(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => { setTimeout(r, 0); });
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Ask the agent/) as HTMLTextAreaElement;
}

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
});

describe('AgentInput attach menu — upload section + inbox materials segment', () => {
  it('renders the upload section with hidden multi-file input carrying the whitelist accept face', async () => {
    seedStore();
    installBridge();
    render(<AgentInput />);

    await userEvent.click(screen.getByTitle('Attach'));

    expect(screen.getByText('Upload files…')).toBeDefined();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(INBOX_UPLOAD_ACCEPT);
  });

  it('lazily lists inbox materials when the menu opens (derived .md of a docx sibling deduped)', async () => {
    seedStore();
    installBridge({
      readDirectory: vi.fn(async (dir: string) => {
        if (dir.endsWith('/inbox')) {
          return [
            { name: '大纲.docx', path: '/大纲.docx', isDir: false },
            { name: '大纲.md', path: '/大纲.md', isDir: false },
            { name: '独立笔记.md', path: '/独立笔记.md', isDir: false },
            { name: 'logo.svg', path: '/logo.svg', isDir: false },
          ];
        }
        return [];
      }),
    });
    render(<AgentInput />);

    await userEvent.click(screen.getByTitle('Attach'));

    // 派生 .md（大纲.md ← 大纲.docx）去重；独立 .md 保留；白名单外（svg）不列。
    await waitFor(() => {
      expect(screen.getByText('大纲.docx')).toBeDefined();
      expect(screen.getByText('独立笔记.md')).toBeDefined();
    });
    expect(screen.queryByText('大纲.md')).toBeNull();
    expect(screen.queryByText('logo.svg')).toBeNull();
  });

  it('clicking an inbox material attaches it via the resolve protocol with zero LLM calls (AC6i + AC6f)', async () => {
    seedStore();
    const bridge = installBridge({
      readDirectory: vi.fn(async (dir: string) => {
        if (dir.endsWith('/inbox')) {
          return [{ name: '大纲.docx', path: '/大纲.docx', isDir: false }];
        }
        return [];
      }),
      resolveInboxAttachment: vi.fn(async () => resolveOk({ derivedPath: 'inbox/大纲.md' })),
    });
    render(<AgentInput />);

    await userEvent.click(screen.getByTitle('Attach'));
    await userEvent.click(await screen.findByText('大纲.docx'));

    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    const att = useAppStore.getState().pendingAttachments[0];
    expect(att).toMatchObject({
      type: 'file',
      id: 'inbox/大纲.md',
      label: '大纲.docx',
      preview: '北境设定预览',
      description: '旧描述',
      describedAt: 1_699_000_000_000,
      fileMtime: 1_700_000_000_000,
    });
    expect(bridge.generateText).not.toHaveBeenCalled();
    // 命中即挂：状态机收敛为 ready（键 = 附件 id）。
    expect(useAppStore.getState().attachmentUploadStates['inbox/大纲.md']).toMatchObject({ state: 'ready' });
  });
});

describe('upload flow state machine (uploading → parsing → ready | error)', () => {
  it('imports into inbox/ with the shell-enforced whitelist, then attaches with full metadata and backfills a fresh description', async () => {
    seedStore();
    const bridge = installBridge({
      importFiles: vi.fn(async () => ({ imported: ['/inbox/大纲.md'], rejected: [] })),
      resolveInboxAttachment: vi.fn(async () => resolveOk({ description: undefined, describedAt: undefined, reused: false })),
    });

    const file = new File(['内容'], '大纲.md');
    await useAppStore.getState().uploadInboxFiles([file]);

    // AC2/R1.5：白名单随 importFiles 传 shell 侧强制（不信 renderer 过滤）。
    expect(bridge.importFiles).toHaveBeenCalledWith(
      PROJECT_PATH,
      'inbox',
      ['I:/外部/大纲.md'],
      ['.txt', '.md', '.markdown', '.docx', '.pdf'],
    );
    // 前导斜杠剥除（resolve filePath 须无前导 /——path.resolve 逃逸守卫）。
    expect(bridge.resolveInboxAttachment).toHaveBeenCalledWith({ projectPath: PROJECT_PATH, filePath: 'inbox/大纲.md' });

    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    const att = useAppStore.getState().pendingAttachments[0] as any;
    expect(att.id).toBe('inbox/大纲.md');
    expect(att.label).toBe('大纲.md');
    expect(att.preview).toBe('北境设定预览');
    expect(att.fileMtime).toBe(1_700_000_000_000);
    expect(useAppStore.getState().attachmentUploadStates['inbox/大纲.md']).toMatchObject({ state: 'ready' });

    // fresh → description 异步回填（dialogue 档缺省 = default 哨兵；输入 ~8K 截取）。
    await waitFor(() => {
      expect(att.description ?? (useAppStore.getState().pendingAttachments[0] as any).description).toBe('一份北境世界观设定大纲');
    });
    expect(bridge.generateText).toHaveBeenCalledTimes(1);
    const payload = bridge.generateText.mock.calls[0][0];
    expect(payload.ref).toEqual({ keyId: 'default', modelId: 'default' });
    expect(payload.request.messages[0].content).toContain('第一章 北境的风');
    // 生成成功写回 sidecar（下次直命中）。CR-013：携带 capturedMtime（= resolve 返回
    // mtime，shell 比对现盘更新即拒——TOCTOU 守卫载荷）。
    await waitFor(() => {
      expect(bridge.storeAttachmentDescription).toHaveBeenCalledWith({
        projectPath: PROJECT_PATH,
        filePath: 'inbox/大纲.md',
        description: '一份北境世界观设定大纲',
        capturedMtime: 1_700_000_000_000,
      });
    });
  });

  it('rejects non-whitelist picks with an explicit toast and keeps the chip explicit (AC2)', async () => {
    seedStore();
    const bridge = installBridge({
      importFiles: vi.fn(async () => ({ imported: ['/inbox/ok.md'], rejected: ['bad.exe'] })),
      resolveInboxAttachment: vi.fn(async () => resolveOk({ derivedPath: 'inbox/ok.md' })),
    });

    await useAppStore.getState().uploadInboxFiles([
      new File(['a'], 'ok.md'),
      new File(['b'], 'bad.exe'),
    ]);

    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    // 拒收 toast 明示（inbox/ 无残留——imported 只有合法件）。
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('bad.exe'))).toBe(true);
    });
    expect(bridge.importFiles).toHaveBeenCalledWith(
      PROJECT_PATH, 'inbox', ['I:/外部/ok.md', 'I:/外部/bad.exe'],
      ['.txt', '.md', '.markdown', '.docx', '.pdf'],
    );
  });

  it('scanned PDF resolves to an error chip with the scanned guidance kind; the original stays untouched (AC3)', async () => {
    seedStore();
    installBridge({
      importFiles: vi.fn(async () => ({ imported: ['/inbox/扫描.pdf'], rejected: [] })),
      resolveInboxAttachment: vi.fn(async () => ({ ok: false, error: '扫描件', kind: 'scanned' })),
    });

    await useAppStore.getState().uploadInboxFiles([new File(['x'], '扫描.pdf')]);

    const states = useAppStore.getState().attachmentUploadStates;
    const entry = Object.values(states)[0];
    expect(entry).toMatchObject({ state: 'error', errorKind: 'scanned', label: '扫描.pdf' });
    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
  });

  // CR-018：拒收带原因形态消费——toast 三档文案 + error chip errorKind 三档对位
  //（SH-a 定型形态：裸名=扩展名拒收 / `name (超过 50MB 上限)` / `name (超过单批 100 个上限)`）。
  it('distinguishes the three rejection tiers in toast copy and error chip kinds (CR-018 / AC2)', async () => {
    seedStore();
    installBridge({
      importFiles: vi.fn(async () => ({
        imported: ['/inbox/ok.md'],
        rejected: [
          'bad.exe',
          '超大.docx (超过 50MB 上限)',
          '第101个.md (超过单批 100 个上限)',
        ],
      })),
      resolveInboxAttachment: vi.fn(async () => resolveOk({ derivedPath: 'inbox/ok.md' })),
    });

    await useAppStore.getState().uploadInboxFiles([
      new File(['a'], 'ok.md'),
      new File(['b'], 'bad.exe'),
      new File(['c'], '超大.docx'),
      new File(['d'], '第101个.md'),
    ]);

    await waitFor(() => {
      expect(useAppStore.getState().pendingAttachments).toHaveLength(1);
    });
    // toast：三档文案各自点名（en locale——tier 键文案可辨）。
    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages.some((m) => m.includes('bad.exe') && m.includes('TXT / MD / DOCX / PDF'))).toBe(true);
    expect(messages.some((m) => m.includes('超大.docx') && m.includes('50 MB'))).toBe(true);
    expect(messages.some((m) => m.includes('第101个.md') && m.includes('100-per-batch'))).toBe(true);
    // chip：errorKind 按拒收裸名对位三档（AgentInput tooltip 文案分流的数据源）。
    const entries = Object.values(useAppStore.getState().attachmentUploadStates);
    expect(entries.find((e) => e.label === 'bad.exe')).toMatchObject({ state: 'error', errorKind: 'rejected-format' });
    expect(entries.find((e) => e.label === '超大.docx')).toMatchObject({ state: 'error', errorKind: 'rejected-size' });
    expect(entries.find((e) => e.label === '第101个.md')).toMatchObject({ state: 'error', errorKind: 'rejected-batch' });
  });

  it('removing an in-flight chip discards the attach when resolve later completes', async () => {
    seedStore();
    const gate = deferred<Record<string, unknown>>();
    installBridge({
      importFiles: vi.fn(async () => ({ imported: ['/inbox/大纲.md'], rejected: [] })),
      resolveInboxAttachment: vi.fn(() => gate.promise),
    });

    const run = useAppStore.getState().uploadInboxFiles([new File(['x'], '大纲.md')]);
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().attachmentUploadStates).length).toBeGreaterThan(0);
    });
    const uploadId = Object.keys(useAppStore.getState().attachmentUploadStates)[0];
    useAppStore.getState().removeAttachmentUpload(uploadId);

    gate.resolve(resolveOk());
    await run;
    await flushAsync();

    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });
});

describe('send gating while uploads are in flight', () => {
  it('disables Send during parsing and re-enables once the entry leaves the in-flight phases', async () => {
    seedStore({ attachmentUploadStates: { 'upload-x': { state: 'parsing', label: 'x.pdf' } } });
    installBridge();
    render(<AgentInput />);
    await userEvent.type(textarea(), 'hello');

    const sendBtn = screen.getByTitle('Send') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);

    useAppStore.setState({ attachmentUploadStates: { 'upload-x': { state: 'error', label: 'x.pdf' } } });
    await waitFor(() => {
      expect((screen.getByTitle('Send') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

describe('hash-identity reuse tiers (AC6f / AC6g)', () => {
  it('renamed / re-attached same-content file hits the cache exactly — zero LLM calls (AC6f)', async () => {
    seedStore();
    const bridge = installBridge({
      resolveInboxAttachment: vi.fn(async () => resolveOk({ derivedPath: 'inbox/改名后.md' })),
    });

    await useAppStore.getState().attachInboxMaterial('inbox/改名后.md', '改名后.md');

    const att = useAppStore.getState().pendingAttachments[0] as any;
    expect(att.id).toBe('inbox/改名后.md');
    expect(att.description).toBe('旧描述');
    expect(bridge.generateText).not.toHaveBeenCalled();
    expect(bridge.storeAttachmentDescription).not.toHaveBeenCalled();
  });

  it('similar reuse makes zero LLM calls while a fresh sibling generates once (AC6g two tiers)', async () => {
    seedStore();
    const bridge = installBridge({
      resolveInboxAttachment: vi.fn()
        .mockResolvedValueOnce(resolveOk({ reused: 'similar', derivedPath: 'inbox/小改.md' }))
        .mockResolvedValueOnce(resolveOk({ description: undefined, describedAt: undefined, reused: false, derivedPath: 'inbox/大改.md' })),
    });

    await useAppStore.getState().attachInboxMaterial('inbox/小改.md', '小改.md');
    await useAppStore.getState().attachInboxMaterial('inbox/大改.md', '大改.md');
    await flushAsync();

    expect(bridge.generateText).toHaveBeenCalledTimes(1);
    const [att1, att2] = useAppStore.getState().pendingAttachments as any[];
    // 小改（≥80% 相似）：复用旧描述 + 原 generatedAt 不刷新。
    expect(att1.description).toBe('旧描述');
    expect(att1.describedAt).toBe(1_699_000_000_000);
    // 大改（fresh）：异步生成回填。
    await waitFor(() => {
      expect(att2.description ?? (useAppStore.getState().pendingAttachments[1] as any).description)
        .toBe('一份北境世界观设定大纲');
    });
  });
});

describe('description async backfill three states (AC6e)', () => {
  it('failure degrades silently to preview-only — no error surface, send unaffected', async () => {
    seedStore();
    const bridge = installBridge({
      resolveInboxAttachment: vi.fn(async () => resolveOk({ description: undefined, describedAt: undefined, reused: false })),
      generateText: vi.fn(async () => { throw new Error('provider down'); }),
    });

    await useAppStore.getState().attachInboxMaterial('inbox/大纲.md', '大纲.md');
    await flushAsync();

    const att = useAppStore.getState().pendingAttachments[0] as any;
    expect(att.description).toBeUndefined();
    expect(att.preview).toBe('北境设定预览');
    expect(useAppStore.getState().agentError).toBeNull();
    expect(bridge.storeAttachmentDescription).not.toHaveBeenCalled();
  });

  // CR-010①②：resolve 带解析备注（非 UTF-8/GBK，preview 被编码检测抑制为空）→ 附件
  // preview 填机器提示文案（指针块「预览:」行保门控成立）+ ready 条目带备注首项
  //（chip tooltip 消费）。
  it('notes + suppressed preview → advisory preview text + note carried on the ready entry (CR-010①②)', async () => {
    seedStore();
    installBridge({
      resolveInboxAttachment: vi.fn(async () => resolveOk({
        preview: '',
        notes: ['疑似非 UTF-8 编码（GBK/GB18030 等）——已按 UTF-8 解码，正文可能出现乱码；建议先转存为 UTF-8 后重新解析。'],
      })),
    });
    render(<AgentInput />);

    await useAppStore.getState().attachInboxMaterial('inbox/大纲.md', '大纲.md');

    const att = useAppStore.getState().pendingAttachments[0] as any;
    expect(att.preview).toBe(NON_UTF8_ATTACHMENT_ADVISORY);
    expect(att.preview).toContain('GBK');
    expect(att.preview).toContain('parse_document');
    expect(useAppStore.getState().attachmentUploadStates['inbox/大纲.md']).toMatchObject({
      state: 'ready',
      note: '疑似非 UTF-8 编码（GBK/GB18030 等）——已按 UTF-8 解码，正文可能出现乱码；建议先转存为 UTF-8 后重新解析。',
    });
    // ready file chip tooltip = 备注首项（用户侧提示面）。
    await waitFor(() => {
      const chip = document.querySelector('.agent-attachment-chip') as HTMLElement;
      expect(chip).not.toBeNull();
      expect(chip.getAttribute('title')).toContain('GBK');
    });
  });

  // CR-010①：备注在场但 preview 正常（端点降级等非编码备注）→ preview 原样，不覆盖。
  it('notes with a normal preview leave the preview untouched (advisory only fills the suppressed case)', async () => {
    seedStore();
    installBridge({
      resolveInboxAttachment: vi.fn(async () => resolveOk({
        preview: '北境设定预览',
        notes: ['解析端点失败（timeout），已降级内置 PDF 文本层提取'],
      })),
    });

    await useAppStore.getState().attachInboxMaterial('inbox/大纲.pdf', '大纲.pdf');

    const att = useAppStore.getState().pendingAttachments[0] as any;
    expect(att.preview).toBe('北境设定预览');
    expect(useAppStore.getState().attachmentUploadStates['inbox/大纲.md']).toMatchObject({ state: 'ready' });
  });

  // CR-010③：生成输入乱码（U+FFFD ≥3%）→ 跳过 description 生成（preview-only 降级，
  // 防 LLM 对乱码编造定性）——renderer 侧检测。
  it('garbled material (U+FFFD ratio ≥3%) skips description generation entirely (CR-010③)', async () => {
    seedStore();
    const bridge = installBridge({
      resolveInboxAttachment: vi.fn(async () => resolveOk({ description: undefined, describedAt: undefined, reused: false })),
      readFile: vi.fn(async () => '正'.repeat(90) + '�'.repeat(10)), // 10% ≥ 3%
    });

    await useAppStore.getState().attachInboxMaterial('inbox/大纲.md', '大纲.md');
    await flushAsync(8);

    expect(bridge.generateText).not.toHaveBeenCalled();
    expect(bridge.storeAttachmentDescription).not.toHaveBeenCalled();
    const att = useAppStore.getState().pendingAttachments[0] as any;
    expect(att.description).toBeUndefined();
    // preview（机器提示/正常预览）兜底不受影响。
    expect(att.preview).toBe('北境设定预览');
  });
});

// CR-009：clearAttachments 连带清 ready 态条目（MB 级 thumbDataUrl 孤儿驻留）——在途与
// error 指引条目不受影响（在途回调由条目缺失守卫自理，error chip 是用户可见提示面）。
describe('clearAttachments sweeps ready upload entries (CR-009)', () => {
  it('removes ready entries alongside pending attachments; in-flight and error entries survive', () => {
    seedStore({
      pendingAttachments: [
        { type: 'file', id: 'inbox/a.md', label: 'a.md' },
        { type: 'image', id: 'inbox/images/x.png', label: 'x.png', path: 'inbox/images/x.png', b64hash: 'h' },
      ],
      attachmentUploadStates: {
        'inbox/a.md': { state: 'ready', label: 'a.md' },
        'inbox/images/x.png': { state: 'ready', label: 'x.png', variant: 'image', thumbDataUrl: 'data:image/png;base64,AAAA' },
        'upload-y': { state: 'parsing', label: 'y.pdf' },
        'upload-z': { state: 'error', label: 'z.pdf', errorKind: 'scanned' },
      },
    });
    installBridge();

    useAppStore.getState().clearAttachments();

    expect(useAppStore.getState().pendingAttachments).toEqual([]);
    expect(Object.keys(useAppStore.getState().attachmentUploadStates).sort()).toEqual(['upload-y', 'upload-z']);
  });
});

describe('project-switch isolation (M3 / AC6b)', () => {
  it('clears uploadStates on switch and drops an in-flight resolve instead of bleeding into the new project', async () => {
    seedStore();
    const gate = deferred<Record<string, unknown>>();
    installBridge({
      resolveInboxAttachment: vi.fn(() => gate.promise),
    });

    const run = useAppStore.getState().attachInboxMaterial('inbox/大纲.md', '大纲.md');
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().attachmentUploadStates)).toHaveLength(1);
    });

    // 在途切项目（path 变化 → projectSubscription → resetAgentForProjectSwitch）。
    useAppStore.setState({
      currentProject: { projectId: 'p2', name: 'Other', path: 'I:/other/project', type: 'novel' },
    } as any);

    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);

    gate.resolve(resolveOk());
    await run;
    await flushAsync();

    // 旧项目的产物不进新项目视图。
    expect(useAppStore.getState().pendingAttachments).toHaveLength(0);
    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });

  it('newAgentSession also clears the upload state machine', async () => {
    seedStore({ attachmentUploadStates: { 'upload-x': { state: 'parsing', label: 'x.pdf' } } });
    installBridge();

    await useAppStore.getState().newAgentSession();

    expect(useAppStore.getState().attachmentUploadStates).toEqual({});
  });
});

describe('flattenInboxMaterials (pure helper)', () => {
  it('flattens nested dirs, filters the whitelist, and dedupes derived .md beside docx/pdf originals', () => {
    const entries = [
      { name: '大纲.docx', path: '/大纲.docx', isDir: false },
      { name: '大纲.md', path: '/大纲.md', isDir: false },
      { name: 'sub', path: '/sub', isDir: true, children: [
        { name: 'report.pdf', path: '/sub/report.pdf', isDir: false },
        { name: 'report.md', path: '/sub/report.md', isDir: false },
        { name: 'notes.txt', path: '/sub/notes.txt', isDir: false },
      ] },
      { name: 'image.png', path: '/image.png', isDir: false },
    ];
    const out = flattenInboxMaterials(entries as any);
    expect(out.map((f) => f.rel)).toEqual([
      'inbox/大纲.docx',
      'inbox/sub/report.pdf',
      'inbox/sub/notes.txt',
    ]);
  });

  // CR-015：去重键 = rel 全路径 stem——子目录同名材料不再被根级原件误隐藏
  //（`inbox/sub/大纲.md` vs 根级 `大纲.docx`）。
  it('dedupes by rel full-path stem: a sub-directory .md survives a same-name root-level docx (CR-015)', () => {
    const entries = [
      { name: '大纲.docx', path: '/大纲.docx', isDir: false },
      { name: 'sub', path: '/sub', isDir: true, children: [
        { name: '大纲.md', path: '/sub/大纲.md', isDir: false },
      ] },
    ];
    const out = flattenInboxMaterials(entries as any);
    expect(out.map((f) => f.rel)).toEqual(['inbox/大纲.docx', 'inbox/sub/大纲.md']);
  });
});

describe('classifyImportRejections (CR-018 pure helper)', () => {
  it('splits the three settled rejection forms and strips reason suffixes to bare names', () => {
    expect(classifyImportRejections([
      'bad.exe',
      'big.pdf (超过 50MB 上限)',
      'extra.md (超过单批 100 个上限)',
    ])).toEqual({
      format: ['bad.exe'],
      tooLarge: ['big.pdf'],
      batchLimit: ['extra.md'],
    });
  });

  it('bare names without a known reason suffix fall back to the format tier; junk entries skipped', () => {
    expect(classifyImportRejections(['odd.zip', ''])).toEqual({
      format: ['odd.zip'],
      tooLarge: [],
      batchLimit: [],
    });
  });
});

describe('shouldSkipAttachmentDescription (CR-010③ pure helper)', () => {
  it('skips at U+FFFD ratio ≥3% measured on the 8K generation window', () => {
    expect(shouldSkipAttachmentDescription('正'.repeat(96) + '�'.repeat(4))).toBe(true); // 4%
    expect(shouldSkipAttachmentDescription('正'.repeat(97) + '�'.repeat(3))).toBe(true); // 3% == 阈（≥）
    expect(shouldSkipAttachmentDescription('正'.repeat(98) + '�'.repeat(2))).toBe(false); // 2%
    expect(shouldSkipAttachmentDescription('')).toBe(false);
  });

  it('measures only the 8K window — garbling beyond it does not block generation', () => {
    // 8K 干净前窗 + 窗外全乱码：生成输入（前 8K）不乱 → 不拦。
    expect(shouldSkipAttachmentDescription('正'.repeat(8000) + '�'.repeat(8000))).toBe(false);
  });
});

/**
 * 「材料」页组件测试（Story 10.1 Wave D）。
 *
 * 覆盖：
 * - 列表渲染：行徽章（格式 / 来源类别 / 质量 / low-confidence 琥珀徽章
 *   data-low-confidence——F-09 章界挂起检索照常；method='none' 伪章中性 chip 不挂琥珀
 *   徽章——CR-015；failed 红徽章 + parseNotes 锚——CR-030/CR-012）；
 * - scope 切换：tab 态 + 无项目时 project tab 禁用 + 页面 data-materials-scope 锚；
 * - 导入回报：materialsImportFeedback 三档拒收分类呈现（rejectedKind 键 + 拒收清单）；
 * - 删除流：行删除钮 → 全局确认框（confirmStore）→ 确认 → 桥 deleteMaterial + toast；
 * - provenance 表单：medium 下拉受控词表 + **回声抑制保草稿**（编辑中 detail 服务器刷新
 *   不覆写草稿）+ blur 落盘（updateMaterialProvenance 桥 partial patch）。
 *
 * mock 形态照 spec/ui/testing.md + settingPage.test.tsx 谱：真实 useAppStore 两步落种 +
 * useI18n mock（t 返回键名——断言不依赖翻译文案）+ hand-made vi.fn 挂桥 + data-* 锚。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    t: (key: string) => key,
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { MaterialsPage } from '../src/features/materials/MaterialsPage';
import { useAppStore } from '../src/shared/store/appStore';
import { useConfirmStore } from '../src/shared/store/confirmStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { Material, MaterialSummary } from '@orison/shared-contracts';

// ── fixtures ──

function summaryFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'project',
    projectId: '00001',
    kind: 'prose',
    name: 'novel',
    format: 'txt',
    medium: 'novel_text',
    tier: 'unspecified',
    author: null,
    lang: null,
    originDate: null,
    sourcePath: 'materials/novel.txt',
    status: 'ready',
    charCount: 12000,
    chapterCount: 4,
    chapterMethod: 'regex',
    chapterConfidence: 'high',
    scanned: false,
    nonUtf8: false,
    parseNotes: [],
    ingestedAt: '2026-09-02T08:00:00.000Z',
    ...over,
  };
}

function materialFixture(over: Partial<Material> = {}): Material {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'project',
    projectId: '00001',
    kind: 'prose',
    name: 'novel',
    format: 'txt',
    provenance: {
      medium: 'novel_text',
      tier: 'unspecified',
      sourcePath: 'materials/novel.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-02T08:00:00.000Z',
      author: '原作者甲',
      lang: null,
      originDate: null,
      description: null,
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: 12000,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters: [],
    chunkSpans: [],
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: 'ready',
    ...over,
  };
}

// ── 桥 mock（文件级单 mock）──

const listMaterialsSpy = vi.fn(async (): Promise<MaterialSummary[]> => []);
const getMaterialSpy = vi.fn(async () => ({
  material: materialFixture(),
  derivedAbsPath: 'C:/proj-1/materials/.derived/novel.md',
  sourceAbsPath: 'C:/proj-1/materials/novel.txt',
}));
const deleteMaterialSpy = vi.fn(async () => ({ ok: true, removedSourceFile: true, removedDerivedFile: true }));
const updateProvenanceSpy = vi.fn(async () => ({ ok: true, material: materialFixture() }));
const readFileSpy = vi.fn(async () => null);
const pathForFileSpy = vi.fn(() => '');

function installBridge() {
  (window as any).orisonDesktop = {
    listMaterials: listMaterialsSpy,
    getMaterial: getMaterialSpy,
    deleteMaterial: deleteMaterialSpy,
    reingestMaterial: vi.fn(async () => ({ ok: true, outcome: 'reused', materialId: 'mat-aaaaaaaaaaaa' })),
    importMaterials: vi.fn(),
    updateMaterialProvenance: updateProvenanceSpy,
    onMaterialChanged: () => () => {},
    pathForFile: pathForFileSpy,
    readFile: readFileSpy,
    showItemInFolder: vi.fn(),
  };
}

/** 两步落种（mirror settingPage.test.tsx：先 currentProject 触发项目订阅 reset，后落数据）。 */
function seedState(over: Record<string, unknown> = {}, withProject = true) {
  useAppStore.setState({
    ...(withProject
      ? { currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' } }
      : { currentProject: null }),
    resolvedLocale: 'zh-CN',
    agentPanelOpen: false,
    mainView: 'page',
    activePage: 'materials',
  } as any);
  useAppStore.setState({
    materialsScope: 'project',
    materialsListLoadedFor: withProject ? 'project:00001' : null,
    materialsList: [],
    materialsListLoading: false,
    materialsListError: null,
    materialDetail: null,
    materialDetailId: null,
    materialDetailLoading: false,
    materialDetailError: null,
    materialsImporting: false,
    materialsImportProgress: null,
    materialsImportFeedback: null,
    ...over,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  useToastStore.setState({ toasts: [] });
  useConfirmStore.setState({ confirmOpen: false, confirmOptions: null, confirmResolve: null });
});

afterEach(() => {
  cleanup();
  delete (window as any).orisonDesktop;
});

describe('材料页渲染（徽章 / scope / 导入回报）', () => {
  it('行徽章：格式 + 来源类别 + low-confidence 琥珀徽章（F-09）+ 质量警告双徽章', () => {
    seedState({
      materialsList: [
        summaryFixture(),
        summaryFixture({
          materialId: 'mat-bbbbbbbbbbbb',
          name: '讲义一',
          format: 'pdf',
          medium: 'criticism',
          status: 'low-confidence',
          chapterConfidence: 'low',
          chapterMethod: 'llm-fallback',
          chapterCount: 0,
          scanned: true,
        }),
      ],
    });
    const { container } = render(<MaterialsPage />);
    expect(container.querySelector('[data-material-id="mat-aaaaaaaaaaaa"]')).not.toBeNull();
    expect(container.querySelector('[data-material-id="mat-bbbbbbbbbbbb"]')).not.toBeNull();
    // 格式徽章 + 来源类别（i18n mock 的 t 回落键名 → mediumLabel 走未知值原样路径，
    // 断言 raw 词表值 'criticism' 在场即证 chip 渲染；真实 i18n 齐平由 materialsI18n 守卫）。
    expect(container.textContent).toContain('materials.format.pdf');
    expect(container.textContent).toContain('criticism');
    // 质量警告（scanned）+ low-confidence 琥珀徽章。
    expect(container.textContent).toContain('materials.quality.scanned');
    const lowBadge = container.querySelector('[data-low-confidence="true"]');
    expect(lowBadge).not.toBeNull();
    expect(lowBadge!.textContent).toContain('materials.chapter.lowConfidenceBadge');
    // 高置信行呈现 method·confidence 组合（无琥珀徽章）。
    expect(container.textContent).toContain('materials.chapter.method.regex');
  });

  it('method=none 伪章：中性「未分章」chip 不挂琥珀徽章；status=low-confidence 仍挂（CR-015）', () => {
    seedState({
      materialsList: [
        summaryFixture({
          materialId: 'mat-cccccccccccc',
          status: 'ready',
          chapterMethod: 'none',
          chapterConfidence: 'low',
          chapterCount: 1,
        }),
        summaryFixture({
          materialId: 'mat-dddddddddddd',
          status: 'low-confidence',
          chapterMethod: 'none',
          chapterConfidence: 'low',
          chapterCount: 1,
        }),
      ],
    });
    const { container } = render(<MaterialsPage />);
    // 伪章常态行（F-09 终态）：无琥珀徽章，中性 method chip 呈现「未分章」。
    const noneRow = container.querySelector('[data-material-id="mat-cccccccccccc"]')!;
    expect(noneRow.querySelector('[data-low-confidence="true"]')).toBeNull();
    expect(noneRow.textContent).toContain('materials.chapter.method.none');
    // status='low-confidence'（登记行显式挂起）不受 method=none 豁免——仍挂徽章。
    const lowRow = container.querySelector('[data-material-id="mat-dddddddddddd"]')!;
    expect(lowRow.querySelector('[data-low-confidence="true"]')).not.toBeNull();
  });

  it('failed 行：红徽章 + parseNotes 锚（CR-030/CR-012——「质量正常」不与失败并排）', () => {
    seedState({
      materialsList: [
        summaryFixture({
          status: 'failed',
          scanned: false,
          nonUtf8: false,
          parseNotes: ['LLM 兜底挂起：候选行 320 超预算 300', 'PDF 端点探活失败，降级内置文本层'],
        }),
      ],
    });
    const { container } = render(<MaterialsPage />);
    const failedBadge = container.querySelector('[data-failed="true"]');
    expect(failedBadge).not.toBeNull();
    expect(failedBadge!.textContent).toContain('materials.quality.failed');
    // 失败行不再并排「质量正常」（矛盾态）。
    expect(container.textContent).not.toContain('materials.quality.ok');
    // parseNotes 服务器原文入 DOM 锚 = 质量 tooltip 组料单源（CR-012 契约兑现）。
    const notesAnchor = container.querySelector('[data-quality-notes]');
    expect(notesAnchor).not.toBeNull();
    expect(notesAnchor!.getAttribute('data-quality-notes')).toContain('候选行 320 超预算 300');
    expect(notesAnchor!.getAttribute('data-quality-notes')).toContain('PDF 端点探活失败');
  });

  it('parseNotes 空的质量行无锚（tooltip 缺席不打扰）', () => {
    seedState({ materialsList: [summaryFixture()] });
    const { container } = render(<MaterialsPage />);
    expect(container.querySelector('[data-quality-notes]')).toBeNull();
    expect(container.textContent).toContain('materials.quality.ok');
  });

  it('scope tabs：切换写 store + data 锚；无项目时 project tab 禁用 + 提示', () => {
    seedState({ materialsList: [summaryFixture()] });
    const { container } = render(<MaterialsPage />);
    expect(container.querySelector('[data-materials-scope="project"]')).not.toBeNull();
    const globalTab = screen.getByRole('tab', { name: 'materials.scope.global' });
    fireEvent.click(globalTab);
    expect(useAppStore.getState().materialsScope).toBe('global');

    cleanup();
    seedState({}, false);
    const dead = render(<MaterialsPage />).container;
    const projectTab = dead.querySelector('[role="tab"][aria-disabled], button[disabled]');
    expect(projectTab).not.toBeNull();
    expect(dead.textContent).toContain('materials.scope.projectDisabledHint');
  });

  it('import accept 面含字幕三扩展（10.2a W4.4——白名单 UI 面与 shell 强制面同步）', () => {
    seedState({ materialsList: [summaryFixture()] });
    const { container } = render(<MaterialsPage />);
    const input = container.querySelector('input.materials-fileinput') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const accept = (input!.getAttribute('accept') ?? '').split(',').map((s) => s.trim());
    // 既有五格式 + 字幕三扩展全在（缺项 = UI 过滤面落后 shell 白名单——用户拖不进新格式）。
    for (const ext of ['.txt', '.md', '.markdown', '.docx', '.pdf', '.epub', '.srt', '.ass', '.vtt']) {
      expect(accept).toContain(ext);
    }
  });

  it('导入回报：六档拒收分类 + 拒收/失败清单呈现（key 带 idx——CR-027）', () => {
    seedState({
      materialsImportFeedback: {
        ok: true as const,
        imported: [
          { name: 'a.txt', relPath: 'a.txt', materialId: 'mat-aaaaaaaaaaaa', outcome: 'registered' as const },
        ],
        rejected: [
          { name: 'b.mp4', kind: 'unsupported-format' as const },
          { name: 'c.zip', kind: 'unsupported-format' as const },
          { name: 'd.pdf', kind: 'too-large' as const },
          { name: 'e.txt', kind: 'batch-overflow' as const },
          { name: 'foo.md', kind: 'stem-conflict' as const },
          { name: 'secret.txt', kind: 'sensitive' as const },
          { name: 'gone.txt', kind: 'missing' as const },
        ],
        failed: [{ name: 'f.txt', relPath: 'f.txt', reason: '摄取失败：parse-failed' }],
      },
    });
    const { container } = render(<MaterialsPage />);
    const feedback = container.querySelector('[data-materials-import-feedback="true"]');
    expect(feedback).not.toBeNull();
    // 六档分类文案键（i18n mock → 键名锚；同名同类拒收项两份共存——CR-027 key 带 idx 防冲突）。
    expect(feedback!.textContent).toContain('materials.import.rejectedKind.unsupported-format');
    expect(feedback!.textContent).toContain('materials.import.rejectedKind.too-large');
    expect(feedback!.textContent).toContain('materials.import.rejectedKind.batch-overflow');
    expect(feedback!.textContent).toContain('materials.import.rejectedKind.stem-conflict');
    expect(feedback!.textContent).toContain('materials.import.rejectedKind.sensitive');
    expect(feedback!.textContent).toContain('materials.import.rejectedKind.missing');
    const rejectedList = container.querySelector('[data-rejected-list="true"]')!;
    expect(rejectedList.children).toHaveLength(7);
    expect(rejectedList.querySelectorAll('li')[0]!.textContent).toContain('b.mp4');
    expect(rejectedList.querySelectorAll('li')[1]!.textContent).toContain('c.zip');
    expect(container.querySelector('[data-failed-list="true"]')!.textContent).toContain('f.txt');
  });

  it('进度条：importing + progress 呈现 done/total', () => {
    seedState({ materialsImporting: true, materialsImportProgress: { done: 2, total: 5 } });
    const { container } = render(<MaterialsPage />);
    const progress = container.querySelector('[data-import-progress="2/5"]');
    expect(progress).not.toBeNull();
    expect(progress!.textContent).toContain('materials.import.progress');
  });

  it('拖入零可解析路径 → pathUnavailable 警告；零文件空拖静默（CR-026）', () => {
    seedState({ materialsList: [] });
    pathForFileSpy.mockReturnValue('');
    const { container } = render(<MaterialsPage />);
    const dropzone = container.querySelector('[data-materials-dropzone="true"]')!;
    // 拖了文件但一条绝对路径都没解析到 → toast 警告（此前静默无反馈）。
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(useToastStore.getState().toasts[0]?.message).toContain('materials.toast.pathUnavailable');
    // 零文件 drop（jsdom 误触发形态）不打扰。
    fireEvent.drop(dropzone, { dataTransfer: { files: [] } });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});

describe('删除流（D8：确认弹窗归 UI，IPC 不二次确认）', () => {
  it('删除钮 → 全局确认 → 确认 → 桥 deleteMaterial + 成功 toast', async () => {
    seedState({ materialsList: [summaryFixture()] });
    render(<MaterialsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'materials.action.delete' }));
    // 确认框弹起（confirmStore）——确认后删除继续。
    expect(useConfirmStore.getState().confirmOpen).toBe(true);
    await act(async () => {
      useConfirmStore.getState().resolveConfirm(true);
    });
    await waitFor(() => {
      expect(deleteMaterialSpy).toHaveBeenCalledWith({ materialId: 'mat-aaaaaaaaaaaa' });
    });
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.message).toContain('materials.toast.deleted');
    });
  });

  it('取消确认 → 零 IPC', async () => {
    seedState({ materialsList: [summaryFixture()] });
    render(<MaterialsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'materials.action.delete' }));
    await act(async () => {
      useConfirmStore.getState().resolveConfirm(false);
    });
    expect(deleteMaterialSpy).not.toHaveBeenCalled();
  });
});

describe('provenance 表单（F-05 五字段 + 回声抑制保草稿）', () => {
  it('打开表单 → 服务器值装载 → 编辑不被 detail 刷新覆写 → blur 落盘 partial patch', async () => {
    seedState({ materialsList: [summaryFixture()] });
    const { container } = render(<MaterialsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'materials.action.editProvenance' }));

    // 表单装载（getMaterial 桥回 detail）——author 服务器值入输入框。
    const authorInput = await waitFor(() => {
      const el = container.querySelector('[data-provenance-field="author"]') as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => {
      expect(authorInput.value).toBe('原作者甲');
    });

    // 编辑（dirty）→ 模拟 material:changed 驱动的 detail 刷新（服务器旧值）——草稿不被覆写。
    fireEvent.change(authorInput, { target: { value: '新作者' } });
    act(() => {
      useAppStore.setState({
        materialDetail: {
          material: materialFixture(), // 服务器仍是旧值「原作者甲」
          derivedAbsPath: null,
          sourceAbsPath: null,
        },
      } as any);
    });
    expect(authorInput.value).toBe('新作者'); // 🔙 回声抑制：编辑中不重置基线

    // blur 落盘：只 patch 改动字段（partial——author only）。
    fireEvent.blur(authorInput);
    await waitFor(() => {
      expect(updateProvenanceSpy).toHaveBeenCalledWith({
        materialId: 'mat-aaaaaaaaaaaa',
        patch: { author: '新作者' },
      });
    });
  });

  it('medium 下拉：受控词表渲染 + change 即落盘', async () => {
    seedState({ materialsList: [summaryFixture()] });
    const { container } = render(<MaterialsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'materials.action.editProvenance' }));
    const select = await waitFor(() => {
      const el = container.querySelector('[data-provenance-field="medium"]') as HTMLSelectElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => {
      expect(select.value).toBe('novel_text');
    });
    // 词表含 V1 六值 + R1 预留五值。
    for (const m of ['novel_text', 'lecture', 'interview', 'criticism', 'wiki', 'other', 'game_files', 'video']) {
      expect(container.textContent).toContain(`materials.medium.${m}`);
    }
    fireEvent.change(select, { target: { value: 'lecture' } });
    await waitFor(() => {
      expect(updateProvenanceSpy).toHaveBeenCalledWith({
        materialId: 'mat-aaaaaaaaaaaa',
        patch: { medium: 'lecture' },
      });
    });
  });
});

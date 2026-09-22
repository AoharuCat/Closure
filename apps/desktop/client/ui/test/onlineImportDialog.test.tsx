/**
 * 「在线导入」弹窗组件测试（E10.4 W4，mirror materialsPage.test.tsx 谱）。
 *
 * 覆盖（implement.md W4 测试清单）：
 * - 两 tab 渲染矩阵：URL 直贴 pane（url 输入 + scope 选择默认全局 + 类别四档下拉）/
 *   关键词搜索 pane（query + 搜索钮）；tab 切换互斥呈现；
 * - 类别 → medium/tier 映射断言：四档类别各选一轮，预填提示锚（data-online-category-hint）
 *   逐一呈现 `materials.medium.*` / `materials.tier.*` 预期值（**写侧权威 = shell
 *   categoryToProvenanceDefaults**，W2 已测落库映射；此处守 UI 提示镜像不同步漂移）；
 * - URL 导入：http(s) 预检（非 http(s) toast bad-url 零 IPC）+ 成功行（registered/reused
 *   + truncated 徽章）+ 失败分类呈现（六档契约 + invalid-input + 未知码原样锚）；
 * - 勾选批量：搜索结果行渲染（wiki/web 来源徽章 + snippet + url）+ categoryHint 预填批量
 *   类别 + 勾选两条批量导入（逐 URL 各调一次）；
 * - 列表刷新：批终局 belt 重拉（listMaterials 再调）+ project 车道带 projectId。
 *
 * mock 形态照 spec/ui/testing.md：真实 useAppStore 两步落种 + useI18n mock（t 返回键名）+
 * hand-made vi.fn 挂桥 + data-* 锚断言（不依赖翻译文案）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  // t 带参时序列化参数（mirror 真 translate 的插值语义——类别预填提示断言依赖
  // {medium}/{tier} 值在 DOM 出现；无参回落键名，既有键名锚断言不受影响）。
  useI18n: (locale: string) => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params === undefined) return key;
      const pairs = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`);
      return `${key}:${pairs.join(',')}`;
    },
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { MaterialsPage } from '../src/features/materials/MaterialsPage';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type { MaterialsImportOnlineResult, OnlineSourceHit } from '@orison/shared-contracts';

// ── 桥 mock（文件级单 mock）──

const listMaterialsSpy = vi.fn(async (): Promise<unknown[]> => []);
const importOnlineSpy = vi.fn(async (): Promise<MaterialsImportOnlineResult> => ({
  ok: true,
  materialId: 'mat-online00001',
  outcome: 'registered',
  name: '页面标题',
  sourcePath: 'materials/online/x.md',
  truncated: false,
}));
const searchOnlineSpy = vi.fn(async (): Promise<OnlineSourceHit[]> => []);

function installBridge() {
  (window as any).orisonDesktop = {
    listMaterials: listMaterialsSpy,
    importOnlineMaterial: importOnlineSpy,
    searchOnlineSources: searchOnlineSpy,
    onMaterialChanged: () => () => {},
  };
}

/** 两步落种（materialsSlice 状态随真实 store；global 车道默认——弹窗 scope 预填同源）。 */
function seedState(over: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' },
    resolvedLocale: 'zh-CN',
    agentPanelOpen: false,
    mainView: 'page',
    activePage: 'materials',
  } as any);
  useAppStore.setState({
    materialsScope: 'global',
    materialsListLoadedFor: 'global:',
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

/** 打开弹窗（材料页工具区钮 → data-materials-online-import）。 */
function openDialog() {
  const view = render(<MaterialsPage />);
  fireEvent.click(view.container.querySelector('[data-materials-online-import="true"]')!);
  return view;
}

async function openSearchTabWithHits(container: HTMLElement) {
  fireEvent.click(screen.getByRole('tab', { name: 'materials.online.tabSearch' }));
  fireEvent.change(container.querySelector('[data-online-query="true"]') as HTMLInputElement, {
    target: { value: '明日方舟 批评' },
  });
  fireEvent.click(container.querySelector('[data-online-search="true"]')!);
  // 搜索 settle（成功出 hits / 失败出错误——搜索钮恢复可点即 settle，两路径共用）。
  await waitFor(() => {
    expect((container.querySelector('[data-online-search="true"]') as HTMLButtonElement).disabled).toBe(false);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  delete (window as any).orisonDesktop;
});

const HITS_FIXTURE: OnlineSourceHit[] = [
  {
    title: '明日方舟',
    url: 'https://zh.moegirl.org.cn/明日方舟',
    snippet: '手机游戏《明日方舟》及其衍生作品的词条页面。',
    source: 'wiki:moegirl',
    categoryHint: 'community-wiki',
  },
  {
    title: '叙事批评一则',
    url: 'https://example.com/critique/arknights',
    snippet: '从信息差操控看主线叙事结构。',
    source: 'web',
  },
];

describe('两 tab 渲染矩阵', () => {
  it('URL 直贴 pane：url 输入 + scope 默认全局 + 类别四档下拉 + 导入钮；缺输入禁用', () => {
    seedState();
    const { container } = openDialog();
    expect(container.querySelector('[data-online-dialog="true"]')).not.toBeNull();
    expect(container.querySelector('[data-online-pane="url"]')).not.toBeNull();
    expect(container.querySelector('[data-online-pane="search"]')).toBeNull();
    expect(container.querySelector('[data-online-url-input="true"]')).not.toBeNull();
    const scope = container.querySelector('[data-online-scope="true"]') as HTMLSelectElement;
    expect(scope.value).toBe('global');
    const category = container.querySelector('[data-online-category="url"]') as HTMLSelectElement;
    // 类别四档词表（契约 MATERIAL_ONLINE_CATEGORIES 全量——缺档 = 新类别导不进）。
    const options = Array.from(category.options).map((o) => o.value);
    expect(options).toEqual(['community-wiki', 'criticism', 'author-interview', 'other']);
    expect(category.value).toBe('community-wiki'); // 预填百科社区（URL 直贴最常见入口）
    const importBtn = container.querySelector('[data-online-import="url"]') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true); // 空输入禁用
  });

  it('tab 切换：搜索 pane 呈现 query + 搜索钮；切回 URL pane 互斥', async () => {
    seedState();
    const { container } = openDialog();
    fireEvent.click(screen.getByRole('tab', { name: 'materials.online.tabSearch' }));
    expect(container.querySelector('[data-online-pane="search"]')).not.toBeNull();
    expect(container.querySelector('[data-online-pane="url"]')).toBeNull();
    expect(container.querySelector('[data-online-query="true"]')).not.toBeNull();
    expect(container.querySelector('[data-online-search="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'materials.online.tabUrl' }));
    expect(container.querySelector('[data-online-pane="url"]')).not.toBeNull();
    expect(container.querySelector('[data-online-pane="search"]')).toBeNull();
  });
});

describe('类别 → medium/tier 预填映射（UI 提示镜像；落库权威 = shell W2）', () => {
  const MAPPING_MATRIX = [
    ['community-wiki', 'materials.medium.wiki', 'materials.tier.community'],
    ['criticism', 'materials.medium.criticism', 'materials.tier.criticism'],
    ['author-interview', 'materials.medium.interview', 'materials.tier.original'],
    ['other', 'materials.medium.other', 'materials.tier.unspecified'],
  ] as const;

  it('四档类别各选一轮：提示锚逐一呈现预期 medium/tier（映射漂移即红）', () => {
    seedState();
    const { container } = openDialog();
    const category = container.querySelector('[data-online-category="url"]') as HTMLSelectElement;
    const hint = () => container.querySelector('[data-online-category-hint="url"]')!;
    for (const [value, mediumKey, tierKey] of MAPPING_MATRIX) {
      fireEvent.change(category, { target: { value } });
      expect(category.value).toBe(value);
      expect(hint().textContent).toContain(mediumKey);
      expect(hint().textContent).toContain(tierKey);
    }
  });
});

describe('URL 直贴导入', () => {
  it('非 http(s) 输入 → toast bad-url，零 IPC', () => {
    seedState();
    const { container } = openDialog();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ftp://example.com/page' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    expect(useToastStore.getState().toasts[0]?.message).toContain('materials.online.failureKind.bad-url');
    expect(importOnlineSpy).not.toHaveBeenCalled();
  });

  it('成功导入：桥收 {url, scope:global, category} 全参 + 结果行 registered；批终局 belt 重拉清单', async () => {
    seedState();
    const { container } = openDialog();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://zh.moegirl.org.cn/明日方舟' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    await waitFor(() => {
      expect(importOnlineSpy).toHaveBeenCalledWith({
        url: 'https://zh.moegirl.org.cn/明日方舟',
        scope: 'global',
        category: 'community-wiki',
      });
    });
    const row = await waitFor(() => {
      const el = container.querySelector('[data-online-result="https://zh.moegirl.org.cn/明日方舟"]');
      expect(el).not.toBeNull();
      expect(el!.getAttribute('data-online-result-status')).toBe('ok');
      return el!;
    });
    expect(row.textContent).toContain('materials.online.outcome.registered');
    // 批终局 belt 重拉（事件可丢兜底——listMaterials 再调）。
    await waitFor(() => {
      expect(listMaterialsSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  it('reused 幂等行 + truncated 徽章（诚实标注）', async () => {
    importOnlineSpy.mockResolvedValueOnce({
      ok: true,
      materialId: 'mat-online00001',
      outcome: 'reused',
      name: '词条',
      sourcePath: 'materials/online/x.md',
      truncated: true,
    });
    seedState();
    const { container } = openDialog();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://zh.moegirl.org.cn/初音未来' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    const row = await waitFor(() => {
      const el = container.querySelector('[data-online-result="https://zh.moegirl.org.cn/初音未来"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row.textContent).toContain('materials.online.outcome.reused');
    expect(container.querySelector('[data-online-truncated="true"]')).not.toBeNull();
    expect(container.querySelector('[data-online-truncated="true"]')!.textContent).toContain(
      'materials.online.resultTruncated',
    );
  });

  it('orphaned 态呈现（成功联合三态全覆盖——W2 gate：类型在，呈现面不漏分支）', async () => {
    importOnlineSpy.mockResolvedValueOnce({
      ok: true,
      materialId: 'mat-online00002',
      outcome: 'orphaned',
      name: '词条',
      sourcePath: 'materials/online/x.md',
      truncated: false,
    });
    seedState();
    const { container } = openDialog();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/orphaned' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    const row = await waitFor(() => {
      const el = container.querySelector('[data-online-result="https://example.com/orphaned"]');
      expect(el).not.toBeNull();
      expect(el!.getAttribute('data-online-result-status')).toBe('ok');
      return el!;
    });
    expect(row.textContent).toContain('materials.online.outcome.orphaned');
  });

  it('失败分类矩阵：契约六档 + invalid-input 逐档呈现（未知码原样锚不推测）', async () => {
    seedState();
    const { container } = openDialog();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    const kinds = [
      'bad-url',
      'fetch-failed',
      'empty-content',
      'oversize',
      'stem-conflict',
      'ingest-failed',
      'invalid-input',
      'future-unknown-kind',
    ];
    for (const kind of kinds) {
      importOnlineSpy.mockResolvedValueOnce({ ok: false, error: kind as never, message: `细节-${kind}` });
      fireEvent.change(input, { target: { value: `https://example.com/${kind}` } });
      fireEvent.click(container.querySelector('[data-online-import="url"]')!);
      await waitFor(() => {
        const row = container.querySelector(`[data-online-result="https://example.com/${kind}"]`);
        expect(row).not.toBeNull();
        expect(row!.getAttribute('data-online-result-status')).toBe('failed');
      });
      const kindAnchor = container.querySelector(`[data-online-failure-kind="${kind}"]`);
      expect(kindAnchor).not.toBeNull();
      expect(kindAnchor!.textContent).toContain(`materials.online.failureKind.${kind}`);
      expect(container.querySelector(`[data-online-result="https://example.com/${kind}"]`)!.textContent).toContain(
        `细节-${kind}`,
      );
    }
    expect(importOnlineSpy).toHaveBeenCalledTimes(kinds.length);
  });
});

describe('关键词搜索 + 勾选批量导入', () => {
  it('搜索结果行渲染（wiki/web 徽章 + snippet + url）+ categoryHint 预填批量类别', async () => {
    searchOnlineSpy.mockResolvedValueOnce(HITS_FIXTURE);
    seedState();
    const { container } = openDialog();
    await openSearchTabWithHits(container);
    await waitFor(() => {
      expect(container.querySelector('[data-online-hits="true"]')).not.toBeNull();
    });
    expect(searchOnlineSpy).toHaveBeenCalledWith({ query: '明日方舟 批评' });
    // 两行结果 + 来源徽章二态。
    expect(container.querySelectorAll('[data-online-hit]').length).toBe(2);
    expect(container.querySelector('[data-online-hit-source="wiki"]')).not.toBeNull();
    expect(container.querySelector('[data-online-hit-source="web"]')).not.toBeNull();
    expect(container.querySelector('[data-online-hit="https://zh.moegirl.org.cn/明日方舟"]')!.textContent).toContain(
      '手机游戏',
    );
    // categoryHint（wiki 行带 community-wiki 提示）→ 批量类别预填。
    const batchCategory = container.querySelector('[data-online-category="batch"]') as HTMLSelectElement;
    expect(batchCategory.value).toBe('community-wiki');
  });

  it('搜索失败：行内错误呈现（searchFailed），不残留旧结果', async () => {
    searchOnlineSpy.mockRejectedValueOnce(new Error('网络不可达'));
    seedState();
    const { container } = openDialog();
    await openSearchTabWithHits(container);
    const errEl = container.querySelector('[data-online-search-error="true"]');
    expect(errEl).not.toBeNull();
    expect(errEl!.textContent).toContain('materials.online.searchFailed');
    expect(errEl!.textContent).toContain('网络不可达');
    expect(container.querySelector('[data-online-hits="true"]')).toBeNull();
  });

  it('勾选两条批量导入：逐 URL 各调一次（batch 类别全参）+ 批终局 belt 重拉', async () => {
    searchOnlineSpy.mockResolvedValueOnce(HITS_FIXTURE);
    seedState();
    const { container } = openDialog();
    await openSearchTabWithHits(container);
    fireEvent.click(container.querySelector('[data-online-hit-check="https://zh.moegirl.org.cn/明日方舟"]')!);
    fireEvent.click(container.querySelector('[data-online-hit-check="https://example.com/critique/arknights"]')!);
    const batchBtn = container.querySelector('[data-online-import="batch"]') as HTMLButtonElement;
    expect(batchBtn.textContent).toContain('materials.online.importChecked');
    fireEvent.click(batchBtn);
    await waitFor(() => {
      expect(importOnlineSpy).toHaveBeenCalledTimes(2);
    });
    expect(importOnlineSpy).toHaveBeenNthCalledWith(1, {
      url: 'https://zh.moegirl.org.cn/明日方舟',
      scope: 'global',
      category: 'community-wiki',
    });
    expect(importOnlineSpy).toHaveBeenNthCalledWith(2, {
      url: 'https://example.com/critique/arknights',
      scope: 'global',
      category: 'community-wiki',
    });
    // 批终局 belt 重拉（清单刷新走既有链 + belt）。
    await waitFor(() => {
      expect(listMaterialsSpy.mock.calls.length).toBeGreaterThan(0);
    });
    // 逐条结果行终态（两条都成功）。
    await waitFor(() => {
      expect(
        container.querySelector('[data-online-result="https://example.com/critique/arknights"]')?.getAttribute(
          'data-online-result-status',
        ),
      ).toBe('ok');
    });
  });
});

describe('scope 车道（默认全局；项目车道带 projectId）', () => {
  it('scope 切项目车道：调用携带 registry projectId', async () => {
    seedState();
    const { container } = openDialog();
    const scope = container.querySelector('[data-online-scope="true"]') as HTMLSelectElement;
    fireEvent.change(scope, { target: { value: 'project' } });
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/a' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    await waitFor(() => {
      expect(importOnlineSpy).toHaveBeenCalledWith({
        url: 'https://example.com/a',
        scope: 'project',
        category: 'community-wiki',
        projectId: '00001',
      });
    });
  });

  it('无打开项目 + scope=project：选项禁用 + 导入前守卫 toast（零 IPC）', async () => {
    seedState({ currentProject: null });
    const { container } = openDialog();
    const scope = container.querySelector('[data-online-scope="true"]') as HTMLSelectElement;
    const projectOption = scope.querySelector('option[value="project"]') as HTMLOptionElement;
    expect(projectOption.disabled).toBe(true);
    // 直接改值（jsdom 允许改禁用 option）→ 守卫拦在 IPC 前。
    fireEvent.change(scope, { target: { value: 'project' } });
    expect(container.querySelector('[data-online-project-dead="true"]')).not.toBeNull();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/b' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    expect(importOnlineSpy).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]?.message).toContain('materials.online.needProject');
  });
});

describe('CR-12/13/14 守卫（批量上限 / 输入保留 / busy 期关闭禁用）', () => {
  it('CR-12：勾选超 20 条 → batchOverflow toast 拦截（max=20 shared 常量）零 IPC', async () => {
    const hits: OnlineSourceHit[] = Array.from({ length: 25 }, (_, i) => ({
      title: `t${i}`,
      url: `https://example.com/hit-${i}`,
      snippet: '',
      source: 'web' as const,
    }));
    searchOnlineSpy.mockResolvedValueOnce(hits);
    seedState();
    const { container } = openDialog();
    await openSearchTabWithHits(container);
    await waitFor(() => {
      expect(container.querySelector('[data-online-hits="true"]')).not.toBeNull();
    });
    for (const hit of hits) {
      fireEvent.click(container.querySelector(`[data-online-hit-check="${hit.url}"]`)!);
    }
    fireEvent.click(container.querySelector('[data-online-import="batch"]')!);
    const toast = useToastStore.getState().toasts[0]?.message ?? '';
    expect(toast).toContain('materials.online.batchOverflow');
    expect(toast).toContain('max=20'); // mock t 序列化插值——上限 20（shared 常量）如实呈现
    expect(importOnlineSpy).not.toHaveBeenCalled();
  });

  it('CR-13：早退路径（无项目 + project 车道）不清已输入 URL', async () => {
    seedState({ currentProject: null });
    const { container } = openDialog();
    const scope = container.querySelector('[data-online-scope="true"]') as HTMLSelectElement;
    fireEvent.change(scope, { target: { value: 'project' } });
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/keep-me' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.message).toContain('materials.online.needProject');
    });
    expect(importOnlineSpy).not.toHaveBeenCalled();
    // 输入保留（旧实现先 setUrlInput('') 再守卫——早退静默丢输入）。
    expect((input as HTMLInputElement).value).toBe('https://example.com/keep-me');
  });

  it('CR-14：busy 期关闭禁用——close 钮 disabled + backdrop 点击不关（批次继续到终局）', async () => {
    let release!: (v: MaterialsImportOnlineResult) => void;
    importOnlineSpy.mockImplementationOnce(
      () =>
        new Promise<MaterialsImportOnlineResult>((resolve) => {
          release = resolve;
        }),
    );
    seedState();
    const { container } = openDialog();
    const input = container.querySelector('[data-online-url-input="true"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/slow' } });
    fireEvent.click(container.querySelector('[data-online-import="url"]')!);
    await waitFor(() => {
      expect(importOnlineSpy).toHaveBeenCalledTimes(1);
    });
    // busy 中：close 钮 disabled；backdrop press+click 不触发 dismiss。
    const closeBtn = container.querySelector('[data-online-close="true"]') as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    const overlay = container.querySelector('[data-online-dialog="true"]')!;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(container.querySelector('[data-online-dialog="true"]')).not.toBeNull();
    // 批次继续：释放挂起导入 → 结果行 ok 终态（关窗守卫不误杀批次）。
    release({
      ok: true,
      materialId: 'mat-online00009',
      outcome: 'registered',
      name: '慢页',
      sourcePath: 'materials/online/slow.md',
      truncated: false,
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-online-result="https://example.com/slow"]')?.getAttribute('data-online-result-status'),
      ).toBe('ok');
    });
    // 终局后关闭恢复。
    expect((container.querySelector('[data-online-close="true"]') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(container.querySelector('[data-online-close="true"]')!);
    expect(container.querySelector('[data-online-dialog="true"]')).toBeNull();
  });
});

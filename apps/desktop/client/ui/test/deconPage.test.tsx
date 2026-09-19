/**
 * 「拆书」页组件测试（E10.3b W6——jsdom + mock IPC；handler 真身归 W5 壳波）。
 *
 * 覆盖（dispatch W6 清单）：
 * - 列表渲染（材料名解析 + 状态徽章）+ 选中 job → 详情装载（decon:get）+ pass 进度聚合行
 *   + running 横幅（progress 事件驱动——当前 pass + elapsed）；
 * - 闸门暂停态：paused + review pending → 闸门卡（词典/实体展示）+ 确认按钮 →
 *   approve-review + start（确认即续跑——design §6）+ toast；
 * - craft 闸门：pending craft → decon:products 全量拉取 + p4 findings 按维分组渲染；
 * - 五 tab 切换：章评列表（meta）→ 单取全文（decon:reports kind+unit）；
 * - 导出禁用态：无当前项目 → 风格导出按钮 disabled；有项目 + payload → 写前确认列节 →
 *   decon:export-style；
 * - capped 横幅 + 调预算续跑（budget 面 + decon:start 带 budget）；
 * - 新建向导：材料选择（F-12 过滤提示）→ 深度档预填 → create 回执预估卡 → start。
 *
 * mock 形态照 spec/ui/testing.md + craftPage.test.tsx 谱：useI18n mock（t 返回键名）+
 * hand-made vi.fn 挂桥 + data-* 锚 + 真实 useAppStore 两步落种。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/i18n/useI18n', () => ({
  useI18n: (locale: string) => ({
    // 插值形 mock：键名 + 变量值拼接（实体名/书名/节名等插值面可断言）。
    t: (key: string, vars?: Record<string, string | number>) =>
      key + (vars !== undefined ? `:${Object.values(vars).join(',')}` : ''),
    tArray: () => [],
    ready: true,
  }),
  translate: (locale: string, key: string) => key,
  detectSystemLocale: () => 'zh-CN',
  availableLocales: ['zh-CN', 'en-US'],
}));

import { DeconPage } from '../src/features/decon/DeconPage';
import { useAppStore } from '../src/shared/store/appStore';
import { useConfirmStore } from '../src/shared/store/confirmStore';
import { useToastStore } from '../src/shared/store/toastStore';
import type {
  DeconCreateInput,
  DeconJob,
  DeconJobDetail,
  DeconProductRow,
  MaterialSummary,
} from '@orison/shared-contracts';

// ── fixtures ──

function jobFixture(over: Partial<DeconJob> = {}): DeconJob {
  return {
    jobId: 'decon-aaaaaaaaaaaa',
    materialRef: 'global:mat-aaaaaaaaaaaa',
    tier: 'fine',
    dimensions: ['qingxu'],
    status: 'running',
    budget: { totalTokens: null, perPass: {} },
    cost: { totalTokens: 12345, calls: 8, byPass: {}, estimated: true },
    materialContentHash: `sha256:${'a'.repeat(64)}`,
    derivedHash: `sha256:${'b'.repeat(64)}`,
    error: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...over,
  };
}

function detailFixture(over: Partial<DeconJobDetail> = {}): DeconJobDetail {
  return {
    job: jobFixture(),
    passStates: [
      { jobId: 'decon-aaaaaaaaaaaa', pass: 'p1b', unit: '0', status: 'done', outputRef: 'facts:0', outputHash: null, updatedAt: '2026-09-05T00:00:00.000Z' },
      { jobId: 'decon-aaaaaaaaaaaa', pass: 'p1b', unit: '1', status: 'done', outputRef: 'facts:1', outputHash: null, updatedAt: '2026-09-05T00:00:00.000Z' },
      { jobId: 'decon-aaaaaaaaaaaa', pass: 'p1b', unit: '2', status: 'running', outputRef: null, outputHash: null, updatedAt: '2026-09-05T00:00:00.000Z' },
      { jobId: 'decon-aaaaaaaaaaaa', pass: 'p2', unit: 'world', status: 'done', outputRef: 'canon:world', outputHash: null, updatedAt: '2026-09-05T00:00:00.000Z' },
    ],
    // CR-1 拍板 B：章标标签表（缺省空表 = 旧载荷形态——UI 回落「材料第 N 章」）。
    chapterLabels: {},
    fresh: true,
    canon: [],
    dictionary: null,
    entities: [],
    reviews: [],
    reportCounts: {},
    ...over,
  };
}

function materialFixture(over: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    materialId: 'mat-aaaaaaaaaaaa',
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '小说一',
    format: 'txt',
    medium: 'novel',
    tier: 'unspecified',
    author: null,
    lang: null,
    originDate: null,
    sourcePath: 'materials/novel.txt',
    status: 'ready',
    charCount: 120000,
    chapterCount: 40,
    chapterMethod: 'regex',
    chapterConfidence: 'high',
    scanned: false,
    nonUtf8: false,
    parseNotes: [],
    ingestedAt: '2026-09-05T08:00:00.000Z',
    ...over,
  };
}

// ── 桥 mock（文件级单 mock）──

const listJobsSpy = vi.fn(async (): Promise<DeconJob[]> => [jobFixture()]);
const getJobSpy = vi.fn(async (): Promise<DeconJobDetail | null> => detailFixture());
const createSpy = vi.fn(async (_input: DeconCreateInput) => ({
  ok: true as const,
  job: jobFixture({ jobId: 'decon-cccccccccccc' }),
  // 真实数据形态（CR-18）：继承 pass（p1a）不在 byPass——estimateDeconCost 对 p1Reusable 省行，
  // UI 侧按 inheritedP1 旗标合成注记行。
  inheritedP1: { p1a: true, p1b: false, p1c: false },
  estimate: { totalTokens: 999999, byPass: { p3a: 999999 } },
}));
const startSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'running' }), noop: false }));
const pauseSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'paused' }) }));
const cancelSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'cancelled' }) }));
const deleteSpy = vi.fn(async () => ({ ok: true as const }));
const approveReviewSpy = vi.fn(async () => ({
  ok: true as const,
  review: {
    jobId: 'decon-aaaaaaaaaaaa',
    checkpoint: 'dictionary' as const,
    status: 'approved' as const,
    note: null,
    updatedAt: '2026-09-05T00:00:00.000Z',
  },
}));
// E10.3b W7 小补③：stale 确认重跑（shell 侧 confirm+start 一体——单次 invoke）。
const confirmRerunSpy = vi.fn(async () => ({ ok: true as const, job: jobFixture({ status: 'running' }) }));
const productsSpy = vi.fn(async (): Promise<{ fresh: boolean; products: DeconProductRow[] }> => ({
  fresh: true,
  products: [],
}));
const reportsSpy = vi.fn(async () => ({ fresh: true, list: [], report: null }));
const exportStyleSpy = vi.fn(async () => ({ ok: true as const, writtenSections: ['voice', 'syntax'] }));
const listMaterialsSpy = vi.fn(async (): Promise<MaterialSummary[]> => [materialFixture()]);
const craftCardListSpy = vi.fn(async () => []);

function installBridge() {
  (window as any).orisonDesktop = {
    deconList: listJobsSpy,
    deconGet: getJobSpy,
    deconCreate: createSpy,
    deconStart: startSpy,
    deconPause: pauseSpy,
    deconCancel: cancelSpy,
    deconDelete: deleteSpy,
    deconApproveReview: approveReviewSpy,
    deconConfirmRerun: confirmRerunSpy,
    deconProducts: productsSpy,
    deconReports: reportsSpy,
    deconExportStyle: exportStyleSpy,
    onDeconProgress: () => () => {},
    listMaterials: listMaterialsSpy,
    craftCardList: craftCardListSpy,
  };
}

/** 两步落种（mirror craftPage.test.tsx）：先项目/页面态，后 decon 数据面。 */
function seedState(decon: Record<string, unknown> = {}) {
  useAppStore.setState({
    currentProject: null,
    resolvedLocale: 'zh-CN',
    mainView: 'page',
    activePage: 'decon',
    agentPanelOpen: false,
  } as any);
  useAppStore.setState({
    deconWizardOpen: false,
    deconSelectedJobId: null,
    deconOutputTab: 'reading',
    deconJobsLoaded: false,
    deconJobs: [],
    deconJobsLoading: false,
    deconJobsError: null,
    deconDetail: null,
    deconDetailLoading: false,
    deconDetailError: null,
    deconProgress: {},
    deconProducts: {},
    deconProductsLoading: false,
    deconReportMetas: [],
    deconReportMetasLoadedFor: null,
    deconReportsLoading: false,
    deconReportContent: null,
    deconReportContentKey: null,
    deconReportContentLoading: false,
    ...decon,
  } as any);
}

function lastToast(): { message: string; level: string } | undefined {
  const toasts = useToastStore.getState().toasts;
  return toasts.length > 0 ? toasts[toasts.length - 1] : undefined;
}

function query(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  installBridge();
  useToastStore.setState({ toasts: [] });
  useConfirmStore.setState({ confirmOpen: false, confirmOptions: null, confirmResolve: null });
});

afterEach(() => {
  cleanup();
});

/** 选中 job 并等详情落场。 */
async function openJob(detail: DeconJobDetail = detailFixture()) {
  getJobSpy.mockResolvedValue(detail);
  seedState({
    deconJobs: [detail.job],
    deconJobsLoaded: true,
    deconSelectedJobId: detail.job.jobId,
  });
  await act(async () => {
    render(<DeconPage />);
  });
  await waitFor(() => {
    expect(document.querySelector(`[data-decon-panel="${detail.job.jobId}"]`)).not.toBeNull();
  });
}

describe('列表 + 详情装载', () => {
  it('job 行渲染（材料名解析 + 状态徽章）→ 点击装载详情 + pass 聚合行', async () => {
    seedState({ deconJobs: [jobFixture()], deconJobsLoaded: true });
    await act(async () => {
      render(<DeconPage />);
    });
    // 材料名解析（listMaterials mock 返回「小说一」）。
    await waitFor(() => {
      expect(query('[data-decon-job="decon-aaaaaaaaaaaa"] .decon-jobrow-name').textContent).toContain('小说一');
    });
    expect(query('[data-decon-job-status="running"]')).toBeTruthy();
    fireEvent.click(query('[data-decon-job="decon-aaaaaaaaaaaa"]'));
    await waitFor(() => {
      expect(getJobSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-decon-panel="decon-aaaaaaaaaaaa"]')).not.toBeNull();
    });
    // pass 聚合：p1b 2/3 + p2 1/1。
    expect(query('[data-decon-pass="p1b"]').textContent).toContain('2/3');
    expect(query('[data-decon-pass="p2"]').textContent).toContain('1/1');
    // 报告 meta 拉取（列表面）。
    expect(reportsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
  });

  it('running 横幅 = progress 事件驱动（当前 pass + elapsed）+ 暂停动作；章号材料相对引用（C5/F19 零序号算术）/arcs 专项键（CR-17 progress 路径）', async () => {
    await openJob(detailFixture());
    await act(async () => {
      useAppStore.setState({
        deconProgress: {
          'decon-aaaaaaaaaaaa': { jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p3a', unit: '12', elapsedMs: 65000 },
        },
      } as any);
    });
    expect(query('[data-decon-banner="running"]').textContent).toContain('decon.banner.running');
    // C5/F19：0 基 '12' → 「材料第 12 章」（原始 index——不再 +1 冒充书内章号）。
    expect(query('[data-decon-progress-current="p3a"]').textContent).toContain('decon.unit.materialChapter:12');
    // running 态动作排：暂停在位。
    expect(query('[data-decon-action="pause"]')).toBeTruthy();
    // p3b 单行哨兵 unit（'arcs'）走专项键——progress 路径不再泄漏字面量（CR-17）。
    await act(async () => {
      useAppStore.setState({
        deconProgress: {
          'decon-aaaaaaaaaaaa': { jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p3b', unit: 'arcs', elapsedMs: 65000 },
        },
      } as any);
    });
    expect(query('[data-decon-progress-current="p3b"]').textContent).toContain('decon.unit.arcs');
  });
});

describe('人审闸门（design §6——闸门暂停优先 + 确认即续跑）', () => {
  it('dictionary 闸门：实体/词典展示 + note 软提示（CR-10）+ 确认 → approve-review（壳内自动续跑——UI 零二次 start，CR-3）+ toast', async () => {
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'paused' }),
        dictionary: {
          materialRef: 'global:mat-aaaaaaaaaaaa',
          derivedHash: `sha256:${'b'.repeat(64)}`,
          entries: [{ name: '林拾', type: 'person', confidence: 0.9 }],
        },
        entities: [
          {
            materialRef: 'global:mat-aaaaaaaaaaaa',
            derivedHash: `sha256:${'b'.repeat(64)}`,
            canonicalName: '林拾',
            type: 'person',
            aliases: [],
            mentions: [],
            audit: { sources: [], droppedAliases: 0 },
            mentionsTotal: 12,
            mentionsTruncated: false,
          },
        ],
        reviews: [
          { jobId: 'decon-aaaaaaaaaaaa', checkpoint: 'dictionary', status: 'pending', note: null, updatedAt: '2026-09-05T00:00:00.000Z' },
        ],
      }),
    );
    // 闸门卡 + 横幅（gate-paused 优先于 paused）+ note 软提示（闸门暂停事件的 note 面——CR-10）。
    await act(async () => {
      useAppStore.setState({
        deconProgress: {
          'decon-aaaaaaaaaaaa': { jobId: 'decon-aaaaaaaaaaaa', status: 'paused', pass: null, note: '待人工确认：词典与实体（P1c 产物）' },
        },
      } as any);
    });
    expect(query('[data-decon-banner="gate-paused"]')).toBeTruthy();
    expect(query('[data-decon-banner-note]').textContent).toContain('待人工确认：词典与实体');
    expect(query('[data-decon-gate="dictionary"]')).toBeTruthy();
    expect(query('[data-decon-gate-dictionary="1"]')).toBeTruthy();
    expect(query('[data-decon-gate-entities="1"]').textContent).toContain('林拾');
    fireEvent.click(query('[data-decon-action="approve-review"]'));
    await waitFor(() => {
      expect(approveReviewSpy).toHaveBeenCalledWith({
        jobId: 'decon-aaaaaaaaaaaa',
        checkpoint: 'dictionary',
      });
    });
    // CR-3：壳 handler 唯一 start 所有者——UI 零二次 start（approve 即壳内自动续跑）。
    expect(startSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.toast.gateApproved');
    });
  });

  it('截断提示（CR-11）：词典/实体超 50 条 → 「+N 条未展示」提示行', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ name: `词条${i}`, type: 'concept', confidence: 0.8 }));
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'paused' }),
        dictionary: {
          materialRef: 'global:mat-aaaaaaaaaaaa',
          derivedHash: `sha256:${'b'.repeat(64)}`,
          entries,
        },
        entities: [],
        reviews: [
          { jobId: 'decon-aaaaaaaaaaaa', checkpoint: 'dictionary', status: 'pending', note: null, updatedAt: '2026-09-05T00:00:00.000Z' },
        ],
      }),
    );
    expect(query('[data-decon-gate-dictionary="60"]')).toBeTruthy();
    expect(query('[data-decon-truncated="10"]').textContent).toContain('decon.review.truncatedHint');
  });

  it('craft 闸门：products 按茎拉取（passStem p4——CR-8 通道前缀过滤）+ p4 findings 按维分组渲染（payload 形态守卫；style 行排除归 UI）', async () => {
    productsSpy.mockResolvedValueOnce({
      fresh: true,
      products: [
        {
          jobId: 'decon-aaaaaaaaaaaa',
          pass: 'p4:qingxu',
          unit: 'ch:1',
          payload: {
            findings: [
              {
                insight: '爽点间隔稳定在两章内',
                elaboration: '主角每次受压后两章内兑现回报。',
                evidence: [{ paraRange: { start: 3, end: 5 }, quote: '他笑了。' }],
                craftHint: { category: 'qingxu', tags: ['爽点'] },
              },
            ],
            synthesis: '小结',
          },
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
        {
          jobId: 'decon-aaaaaaaaaaaa',
          pass: 'p4:style',
          unit: 'all',
          payload: { sections: {} }, // style 维不进 findings 分组（通道层不裁剪——UI 消费面滤）
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
      ],
    });
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'paused', tier: 'fine', dimensions: ['qingxu'] }),
        reviews: [
          { jobId: 'decon-aaaaaaaaaaaa', checkpoint: 'craft', status: 'pending', note: null, updatedAt: '2026-09-05T00:00:00.000Z' },
        ],
      }),
    );
    await waitFor(() => {
      expect(productsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', passStem: 'p4' });
    });
    await waitFor(() => {
      expect(query('[data-decon-gate="craft"]')).toBeTruthy();
    });
    const finding = query('[data-decon-finding="qingxu:0"]');
    expect(finding.textContent).toContain('爽点间隔稳定在两章内');
    expect(finding.textContent).toContain('他笑了。');
    expect(finding.textContent).toContain('craft.category.qingxu');
  });

  it('用户暂停（无 pending review）→ paused 横幅 + 继续动作（不显闸门卡）', async () => {
    await openJob(detailFixture({ job: jobFixture({ status: 'paused' }) }));
    expect(query('[data-decon-banner="paused"]')).toBeTruthy();
    expect(document.querySelector('[data-decon-gate]')).toBeNull();
    expect(query('[data-decon-action="resume"]')).toBeTruthy();
  });
});

describe('产出阅读五 tab', () => {
  it('章评列表（meta）→ 单取全文（decon:reports kind+unit）+ 锚点区（CR-25——CR-1 真实章标/段落区间/引文有则显示）', async () => {
    reportsSpy.mockResolvedValue({
      fresh: true,
      list: [
        { kind: 'chapter_review', unit: 'ch:1', dimension: null, updatedAt: '2026-09-05T00:00:00.000Z' },
        { kind: 'chapter_review', unit: 'ch:2', dimension: null, updatedAt: '2026-09-05T00:00:00.000Z' },
      ],
      report: null,
    });
    // CR-1 拍板 B：章评行与锚点区消费 chapterLabels 真实章标（材料 index 1/2）。
    await openJob(detailFixture({ chapterLabels: { 1: '第 2 章遇袭', 2: '第 3 章夜雨' } }));
    fireEvent.click(query('[data-decon-tab="chapters"]'));
    await waitFor(() => {
      expect(query('[data-decon-report-row="chapter_review:ch:1"]')).toBeTruthy();
    });
    expect(query('[data-decon-report-row="chapter_review:ch:2"]')).toBeTruthy();
    reportsSpy.mockResolvedValueOnce({
      fresh: true,
      list: [],
      report: {
        jobId: 'decon-aaaaaaaaaaaa',
        kind: 'chapter_review',
        unit: 'ch:1',
        contentMd: '# 第 1 章导读\n这章做对了什么…',
        anchors: [
          // 章号材料 index 0 基（CR-1 拍板 B：呈现用 chapterLabels 真实章标，缺键回落材料第 N 章）。
          { chapterIndex: 1, charStart: 0, charEnd: 120, paraStart: 3, paraEnd: 5 },
          // 带引文摘要（「有则显示」面——契约行今日无 quote，防御读兼容）。
          { chapterIndex: 2, charStart: 40, charEnd: 80, paraStart: 1, paraEnd: 2, quote: '刀光落在她肩上的一瞬' },
        ],
        dimension: null,
        updatedAt: '2026-09-05T00:00:00.000Z',
      } as never,
    });
    fireEvent.click(query('[data-decon-report-row="chapter_review:ch:1"]'));
    await waitFor(() => {
      expect(reportsSpy).toHaveBeenLastCalledWith({
        jobId: 'decon-aaaaaaaaaaaa',
        kind: 'chapter_review',
        unit: 'ch:1',
      });
    });
    await waitFor(() => {
      expect(query('.decon-reportmd').textContent).toContain('第 1 章导读');
    });
    // 锚点区（E2E「锚点可追」落物）：章标/段落区间行 + 引文摘要。
    expect(query('[data-decon-report-anchors="2"]')).toBeTruthy();
    const anchor0 = query('[data-decon-anchor="0"]');
    expect(anchor0.textContent).toContain('decon.output.anchorRow');
    // CR-1：章标 = chapterLabels 真实章标（材料 index 1）——非 index 算术。
    expect(anchor0.textContent).toContain('第 2 章遇袭');
    expect(anchor0.textContent).toContain('3,5'); // 段落区间插值。
    expect(query('[data-decon-anchor="1"]').textContent).toContain('刀光落在她肩上的一瞬');
  });

  it('canon tab：U2/F17 人读卡片（按域字段 + null 折叠 + anchors/provenance 摘要）+「AI 视图」开关回 JSON', async () => {
    const span = { chapterIndex: 1, charStart: 0, charEnd: 120, paraStart: 3, paraEnd: 5 };
    const provenance = { source: 'decon' as const, materialId: 'mat-aaaaaaaaaaaa', bookTitle: '小说一' };
    await openJob(
      detailFixture({
        canon: [
          {
            jobId: 'decon-aaaaaaaaaaaa',
            domain: 'character',
            name: '林拾',
            payload: {
              evidence: 'inferred',
              portrait: {
                identity: '高中生侦探',
                speechPattern: '说话简短',
                abilities: null,
                neverDo: '不杀人',
                traits: [
                  { name: '重情', mutability: 'immutable', note: '为友涉险' },
                  { name: '成长', mutability: 'evolvable' },
                ],
              },
              aliases: ['小林'],
              mentions: { chapters: [0, 3], total: 12, entries: [] },
            },
            anchors: [span],
            provenance,
            updatedAt: '2026-09-05T00:00:00.000Z',
          } as never,
          {
            jobId: 'decon-aaaaaaaaaaaa',
            domain: 'rule',
            name: '灵气复苏',
            payload: { evidence: 'exact', statement: '三十年前灵气复苏' },
            anchors: [span],
            provenance,
            updatedAt: '2026-09-05T00:00:00.000Z',
          } as never,
        ] as never,
      }),
    );
    fireEvent.click(query('[data-decon-tab="canon"]'));
    await waitFor(() => {
      expect(query('[data-decon-canon-entry="林拾"]')).toBeTruthy();
    });
    const entry = query('[data-decon-canon-entry="林拾"]');
    // 按域字段卡片：画像字段 + 特质行（可变性 chip + note）+ 别名 + 出场章数。
    expect(entry.textContent).toContain('高中生侦探');
    expect(entry.textContent).toContain('重情');
    expect(entry.textContent).toContain('decon.canonCard.traitImmutable');
    expect(entry.textContent).toContain('为友涉险');
    expect(entry.textContent).toContain('小林');
    expect(entry.textContent).toContain('decon.canonCard.mentions');
    // 证据档 chip + anchors/provenance 摘要行。
    expect(query('[data-decon-canon-evidence="inferred"]').textContent).toContain('decon.canonCard.evidenceInferred');
    expect(entry.textContent).toContain('decon.canonCard.anchorsCount:1');
    expect(entry.textContent).toContain('小说一');
    // null 字段折叠（abilities 不渲染）+ rule 域 statement 字段卡。
    expect(entry.querySelector('[data-decon-canon-field="abilities"]')).toBeNull();
    expect(query('[data-decon-canon-entry="灵气复苏"]').textContent).toContain('三十年前灵气复苏');
    // 「AI 视图」开关：开 → JSON 直出（同人消费面）。
    fireEvent.click(query('[data-decon-canon-view="human"]'));
    expect(query('[data-decon-canon-view]').getAttribute('data-decon-canon-view')).toBe('ai');
    expect(query('[data-decon-canon-entry="林拾"]').querySelector('.decon-canonentry-payload')).not.toBeNull();
    expect(query('[data-decon-canon-entry="林拾"]').querySelector('[data-decon-canon-field="identity"]')).toBeNull();
  });

  it('F18：粗拆档风格 tab 无 style_report → 回落 p3b stats 行 styleStats 三数字摘要 + 细拆解锁说明', async () => {
    productsSpy.mockResolvedValue({
      fresh: true,
      products: [
        {
          jobId: 'decon-aaaaaaaaaaaa',
          pass: 'p3b',
          unit: 'stats',
          payload: {
            book: { chapterCount: 98 },
            arcs: [],
            styleStats: {
              sentenceChars: { count: 42000, min: 2, avg: 18.4, max: 96, sigma: 9.1 },
              paragraphChars: { count: 5600, min: 10, avg: 132.7, max: 890, sigma: 80.2 },
              dialogueLineRatio: 0.42,
            },
          },
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
      ],
    });
    reportsSpy.mockResolvedValue({ fresh: true, list: [], report: null });
    await openJob(detailFixture({ job: jobFixture({ status: 'done', tier: 'coarse', dimensions: [] }) }));
    fireEvent.click(query('[data-decon-tab="style"]'));
    await waitFor(() => {
      expect(productsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', pass: 'p3b' });
    });
    await waitFor(() => {
      expect(query('[data-decon-style-stats]')).toBeTruthy();
    });
    const stats = query('[data-decon-style-stats]');
    expect(stats.textContent).toContain('decon.output.styleSentenceLabel');
    expect(query('[data-decon-style-stat="sentence"]').textContent).toContain('decon.output.styleDistribution:42000,18,96');
    expect(query('[data-decon-style-stat="dialogue"]').textContent).toContain('decon.output.styleDialogueRatio:42');
    expect(query('[data-decon-style-needs-fine]').textContent).toContain('decon.output.styleNeedsFine');
  });

  it('风格导出禁用态：无当前项目 → disabled + 提示', async () => {
    await openJob();
    fireEvent.click(query('[data-decon-tab="style"]'));
    const btn = query('[data-decon-action="export-style"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(query('[data-decon-style-export]').textContent).toContain('decon.output.styleExportNoProject');
  });

  it('风格导出全链：payload 节清单写前确认 → decon:export-style', async () => {
    productsSpy.mockResolvedValueOnce({
      fresh: true,
      products: [
        {
          jobId: 'decon-aaaaaaaaaaaa',
          pass: 'p4:style',
          unit: 'all',
          payload: {
            sections: { voice: '声音画像', stats: '统计', excerpt: '节选', appendix: '附录' },
            excerptAnchors: [],
            bookTitle: '小说一',
            materialId: 'mat-aaaaaaaaaaaa',
          },
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
      ],
    });
    reportsSpy.mockResolvedValue({
      fresh: true,
      list: [{ kind: 'style_report', unit: 'all', dimension: 'style', updatedAt: '2026-09-05T00:00:00.000Z' }],
      report: null,
    });
    await openJob();
    // openJob 的 seedState 会落 currentProject: null——项目态在其后设（导出门开）。
    await act(async () => {
      useAppStore.setState({
        currentProject: { projectId: '00001', name: 'P1', path: '/proj-1', type: 'novel' },
      } as any);
    });
    fireEvent.click(query('[data-decon-tab="style"]'));
    const btn = query('[data-decon-action="export-style"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => {
      expect(productsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', pass: 'p4:style' });
    });
    // 写前确认（列节）——手动放行 confirm 槽。
    await waitFor(() => {
      expect(useConfirmStore.getState().confirmOptions?.title).toBe('decon.output.styleExportConfirmTitle');
    });
    expect(useConfirmStore.getState().confirmOptions?.message).toContain('voice');
    await act(async () => {
      useConfirmStore.getState().resolveConfirm(true);
    });
    await waitFor(() => {
      expect(exportStyleSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', projectId: '00001' });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toContain('decon.output.styleExportDone');
    });
  });
});

describe('capped 挂起 + 调预算续跑', () => {
  it('capped 横幅（提示调预算）+ budget 面应用 → decon:start 带 budget', async () => {
    await openJob(detailFixture({ job: jobFixture({ status: 'capped', error: '预算用尽' }) }));
    expect(query('[data-decon-banner="capped"]')).toBeTruthy();
    fireEvent.click(query('[data-decon-action="resume-budget"]'));
    fireEvent.change(query('[data-decon-field="resume-budget"]'), { target: { value: '500000' } });
    fireEvent.click(query('[data-decon-action="budget-apply"]'));
    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledWith({
        jobId: 'decon-aaaaaaaaaaaa',
        budget: { totalTokens: 500000 },
      });
    });
  });
});

describe('failed 续跑动线（C7/F11/CR-8——后端 decon:start 对 failed→retry，UI 露出主按钮）', () => {
  it('failed 态失败点在 p1b（存在非 done 章号行）→「从{章标}继续」（章标 = chapterLabels 真实章标——CR-1）→ decon:start；删除降次按钮样式', async () => {
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'failed', error: '第 3 章提取输出因 token 上限截断——已挂起' }),
        passStates: [
          ...['0', '1', '2'].map((u) => ({
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p1b',
            unit: u,
            status: 'done' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: '2026-09-05T00:00:00.000Z',
          })),
          {
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p1b',
            unit: '3',
            status: 'failed' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: '2026-09-05T00:00:00.000Z',
          },
        ],
        // CR-1 拍板 B：落点章 3 的真实章标（无简介伪章书里 index 3 = 书内第 3 章）。
        chapterLabels: { 0: '简介（卷首）', 3: '第 3 章 古碑微光' },
      }),
    );
    const btn = query('[data-decon-action="resume"]') as HTMLButtonElement;
    // 落点 = 最大 done(2) + 1 = 3——章标用 chapterLabels 真实章标（非「材料第 3 章」）。
    expect(btn.textContent).toContain('decon.action.resumeFromChapter');
    expect(btn.textContent).toContain('第 3 章 古碑微光');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    });
    // U35：删除降次按钮（破坏性兜底非主 CTA）。
    expect(query('[data-decon-action="delete"]').className).toContain('decon-action--secondary');
  });

  it('CR-8：失败点在后续 pass（p1b 章号行全 done）→ 中性「继续拆解」不假造章号；缺章标表回落「材料第 N 章」', async () => {
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'failed', error: 'p2 域归纳截断' }),
        passStates: [
          ...['0', '1'].map((u) => ({
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p1b',
            unit: u,
            status: 'done' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: '2026-09-05T00:00:00.000Z',
          })),
          {
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p2',
            unit: 'world',
            status: 'failed' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: '2026-09-05T00:00:00.000Z',
          },
        ],
      }),
    );
    const btn = query('[data-decon-action="resume"]') as HTMLButtonElement;
    expect(btn.textContent).toContain('decon.action.resumeDecon');
    expect(btn.textContent).not.toContain('decon.action.resumeFromChapter');
  });

  it('CR-8/CR-1 回落：失败点在 p1b 首章（零 done）且无章标表 →「从材料第 0 章继续」（首章即重入点，不假造 null）', async () => {
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'failed', error: '第 1 章提取失败' }),
        passStates: [
          {
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p1b',
            unit: '0',
            status: 'failed' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: '2026-09-05T00:00:00.000Z',
          },
        ],
      }),
    );
    const btn = query('[data-decon-action="resume"]') as HTMLButtonElement;
    expect(btn.textContent).toContain('decon.action.resumeFromChapter');
    expect(btn.textContent).toContain('decon.unit.materialChapter:0');
  });

  it('U17/U7：列表行 failed error 截断行 + createdAt 时间戳（非 failed 态无 error 行）', async () => {
    seedState({
      deconJobs: [
        jobFixture({ status: 'failed', error: '第 3 章提取输出因 token 上限截断（finishReason=length）——已挂起，不落半程产物' }),
        jobFixture({ jobId: 'decon-bbbbbbbbbbbb', status: 'running' }),
      ],
      deconJobsLoaded: true,
    });
    await act(async () => {
      render(<DeconPage />);
    });
    const errorRow = query('[data-decon-job-error]');
    expect(errorRow.textContent).toContain('第 3 章提取输出因 token 上限截断');
    // 时间戳两行都在（数据面纯渲染——decon:list 行的 createdAt）。
    expect(query('[data-decon-job-created="2026-09-05T00:00:00.000Z"]').textContent).not.toBe('');
    // 非 failed 态无 error 行。
    expect(document.querySelector('[data-decon-job="decon-bbbbbbbbbbbb"] [data-decon-job-error]')).toBeNull();
  });
});

describe('U4 总进度条（当前 pass done/total + 第 N/M 章 + 诚实 ETA）', () => {
  it('running 事件 pass 命中 passStates 聚合 → 主条 done/total + ETA（≥3 done 线性外推）+ 当前相位 第 N（共 M）', async () => {
    const base = Date.parse('2026-09-05T08:00:00.000Z');
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'running' }),
        passStates: [
          ...[0, 1, 2, 3].map((i) => ({
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p1b',
            unit: String(i),
            status: 'done' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: new Date(base + i * 60_000).toISOString(),
          })),
          ...['4', '5'].map((u) => ({
            jobId: 'decon-aaaaaaaaaaaa',
            pass: 'p1b',
            unit: u,
            status: 'pending' as const,
            outputRef: null,
            outputHash: null,
            updatedAt: new Date(base).toISOString(),
          })),
        ],
      }),
    );
    await act(async () => {
      useAppStore.setState({
        deconProgress: {
          'decon-aaaaaaaaaaaa': { jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p1b', unit: '4', elapsedMs: 30_000 },
        },
      } as any);
    });
    const bar = query('[data-decon-progress-total="p1b"]');
    // 主条 4/6 + ETA（4 done × 60s 间隔 × 剩余 2 = 2m）。
    expect(bar.textContent).toContain('decon.progress.total:4,6');
    expect(bar.textContent).toContain('decon.progress.eta:2m00s');
    // CR-19：pass 覆盖辅行（p1b 4/6 未完 → 已完成 0/1）。
    expect(query('[data-decon-progress-passes="0/1"]').textContent).toContain('decon.progress.passCoverage');
    // 当前相位行「材料第 4 章（共 6）」。
    const current = query('[data-decon-progress-current="p1b"]');
    expect(current.textContent).toContain('decon.progress.unitOfTotal:decon.unit.materialChapter:4,6');
  });

  it('ETA 样本不足（done < 3）省略；非 running 无总条', async () => {
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'running' }),
        passStates: ['0', '1'].map((u) => ({
          jobId: 'decon-aaaaaaaaaaaa',
          pass: 'p1b',
          unit: u,
          status: 'done' as const,
          outputRef: null,
          outputHash: null,
          updatedAt: '2026-09-05T08:00:00.000Z',
        })),
      }),
    );
    await act(async () => {
      useAppStore.setState({
        deconProgress: {
          'decon-aaaaaaaaaaaa': { jobId: 'decon-aaaaaaaaaaaa', status: 'running', pass: 'p1b', unit: '2', elapsedMs: 5_000 },
        },
      } as any);
    });
    expect(query('[data-decon-progress-total="p1b"]').textContent).not.toContain('decon.progress.eta');
    // 非 running（无 live running 事件）不渲染总条。
    await act(async () => {
      useAppStore.setState({ deconProgress: {} } as any);
    });
    expect(document.querySelector('[data-decon-progress-total]')).toBeNull();
  });
});

describe('F15/U3/U34：done 后自动开首报告 + 完成横幅「打开读法」', () => {
  it('done + meta 装载 → 自动开首份读法（latch 防切 tab 重置劫持）；横幅按钮强制开', async () => {
    reportsSpy.mockResolvedValue({
      fresh: true,
      list: [
        { kind: 'book_reading', unit: 'all', dimension: null, updatedAt: '2026-09-05T00:00:00.000Z' },
        { kind: 'chapter_review', unit: 'ch:1', dimension: null, updatedAt: '2026-09-05T00:00:00.000Z' },
      ],
      report: {
        jobId: 'decon-aaaaaaaaaaaa',
        kind: 'book_reading',
        unit: 'all',
        contentMd: '# 书级读法\n全书骨架…',
        anchors: [],
        dimension: null,
        updatedAt: '2026-09-05T00:00:00.000Z',
      },
    });
    await openJob(detailFixture({ job: jobFixture({ status: 'done' }) }));
    // CR-19：pass 覆盖辅行——默认 fixture p2 1/1 已完 + p1b 2/3 未完 → 已完成 1/2。
    expect(query('[data-decon-progress-passes="1/2"]').textContent).toContain('decon.progress.passCoverage');
    // 自动开首报告（reading 默认 tab——正文落场）。
    await waitFor(() => {
      expect(reportsSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa', kind: 'book_reading', unit: 'all' });
    });
    await waitFor(() => {
      expect(query('[data-decon-report-md]').textContent).toContain('书级读法');
    });
    // U34：完成横幅「打开读法」按钮在位。
    expect(query('[data-decon-action="open-reading"]')).toBeTruthy();
    // latch：切章评 tab（自动开章评首篇）再切回 reading——book_reading 不重置重取。
    const readingFetches = () =>
      reportsSpy.mock.calls.filter((c) => (c[0] as { kind?: string }).kind === 'book_reading').length;
    const beforeSwitch = readingFetches();
    fireEvent.click(query('[data-decon-tab="chapters"]'));
    await waitFor(() => {
      expect(reportsSpy.mock.calls.some((c) => (c[0] as { kind?: string }).kind === 'chapter_review')).toBe(true);
    });
    fireEvent.click(query('[data-decon-tab="reading"]'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(readingFetches()).toBe(beforeSwitch);
    // 横幅按钮（用户显式动作）不受 latch 约束——强制开首份读法。
    fireEvent.click(query('[data-decon-action="open-reading"]'));
    await waitFor(() => {
      expect(readingFetches()).toBe(beforeSwitch + 1);
    });
  });

  it('U5：reading 正文空态 hint（belt）+ 粗拆档 chapters/scenes 空态注明档位解锁', async () => {
    reportsSpy.mockResolvedValue({ fresh: true, list: [], report: null });
    await openJob(detailFixture({ job: jobFixture({ status: 'done', tier: 'coarse', dimensions: [] }) }));
    // reading 有 metas 空（readingEmpty 空态）——hint 在正文区（无 metas → 空态文案不显 hint）。
    fireEvent.click(query('[data-decon-tab="chapters"]'));
    await waitFor(() => {
      expect(query('[data-decon-coarse-locked]').textContent).toContain('decon.output.coarseLockedHint');
    });
  });
});

describe('stale 确认重跑（W7 小补③——不再引导「删除后重拆」）', () => {
  it('stale 横幅 + 确认重跑按钮 → decon:confirm-rerun + toast', async () => {
    await openJob(
      detailFixture({
        job: jobFixture({ status: 'stale', error: '材料已变更' }),
        fresh: false,
        freshReason: 'stale',
      }),
    );
    expect(query('[data-decon-banner="stale"]')).toBeTruthy();
    expect(query('[data-decon-status="stale"]')).toBeTruthy();
    const btn = query('[data-decon-action="confirm-rerun"]') as HTMLButtonElement;
    expect(btn.textContent).toContain('decon.action.confirmRerun');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => {
      expect(confirmRerunSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.toast.confirmRerunStarted');
    });
  });

  it('非 stale 态不显确认重跑按钮（动作只随 stale 横幅出现）', async () => {
    await openJob(detailFixture({ job: jobFixture({ status: 'done' }) }));
    expect(document.querySelector('[data-decon-action="confirm-rerun"]')).toBeNull();
  });
});

describe('手艺卡跳转区', () => {
  it('done job → craft 卡计数 + 跳转（openCraftForMaterial + setActivePage craft）', async () => {
    craftCardListSpy.mockResolvedValueOnce([
      { cardId: 'card-aaaaaaaaaaaa' },
    ] as any);
    await openJob(detailFixture({ job: jobFixture({ status: 'done' }) }));
    await waitFor(() => {
      expect(craftCardListSpy).toHaveBeenCalledWith({ materialId: 'mat-aaaaaaaaaaaa' });
    });
    await waitFor(() => {
      expect(query('[data-decon-craft-zone]').textContent).toContain('decon.output.craftZoneCount');
    });
    fireEvent.click(query('[data-decon-action="jump-craft"]'));
    await waitFor(() => {
      expect(useAppStore.getState().activePage).toBe('craft');
      expect(useAppStore.getState().craftMaterialFilter).toBe('mat-aaaaaaaaaaaa');
    });
  });
});

describe('新建向导（F-12 过滤 + 深度档预填 + 预估卡）', () => {
  it('排除提示（low-confidence/零章）+ deep 预填 + create → 预估卡 → start', async () => {
    listMaterialsSpy.mockResolvedValue([
      materialFixture(),
      materialFixture({ materialId: 'mat-bbbbbbbbbbbb', name: '坏分章', chapterConfidence: 'low' }),
    ]);
    seedState({ deconJobs: [], deconJobsLoaded: true });
    await act(async () => {
      render(<DeconPage />);
    });
    fireEvent.click(query('[data-decon-action="new-job"]'));
    await waitFor(() => {
      expect(query('[data-decon-wizard]')).toBeTruthy();
    });
    // F-12：排除提示（1 份 low-confidence）。
    await waitFor(() => {
      expect(query('[data-decon-material-excluded="1"]')).toBeTruthy();
    });
    // 选材料 + 深度档（预填全 12）。
    fireEvent.change(query('[data-decon-field="material"]'), { target: { value: 'mat-aaaaaaaaaaaa' } });
    fireEvent.click(query('[data-decon-tier="deep"]'));
    expect(document.querySelectorAll('[data-decon-dim].is-active').length).toBe(12);
    fireEvent.click(query('[data-decon-action="create"]'));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith({
        materialId: 'mat-aaaaaaaaaaaa',
        tier: 'deep',
        dimensions: expect.arrayContaining(['huoke', 'qingxu']),
        reviewCheckpoints: true,
      });
    });
    // 预估卡（byPass 明细 + P1 复用标记——CR-18 真实形态：byPass 无 p1a 行，注记行由
    // inheritedP1 旗标合成，tokens=0 + 徽章）。
    await waitFor(() => {
      expect(query('[data-decon-estimate]')).toBeTruthy();
    });
    expect(query('[data-decon-estimate-pass="p1a"]').textContent).toContain('decon.wizard.estimateInherited');
    expect(query('[data-decon-estimate-pass="p3a"]')).toBeTruthy();
    expect(query('[data-decon-estimate-total="999999"]')).toBeTruthy();
    fireEvent.click(query('[data-decon-action="start"]'));
    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledWith({ jobId: 'decon-cccccccccccc' });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.toast.started');
    });
    // 向导关闭。
    await waitFor(() => {
      expect(document.querySelector('[data-decon-wizard]')).toBeNull();
    });
  });

  it('预算非法不静默吞（CR-23）：非正数 → 提示 + 不 create；留空仍合法（NaN 分支纯函数单源直测——input type=number 对非法串恒回落空串，fireEvent 造不出）', async () => {
    listMaterialsSpy.mockResolvedValue([materialFixture()]);
    seedState({ deconJobs: [], deconJobsLoaded: true });
    await act(async () => {
      render(<DeconPage />);
    });
    fireEvent.click(query('[data-decon-action="new-job"]'));
    await waitFor(() => {
      expect(query('[data-decon-wizard]')).toBeTruthy();
    });
    // 材料列表异步装载：选项未渲染前 change 落空（select.value 恒 ''→ materialId 空
    // → canCreate 假 → 无 toast 无 create，表现为 budgetInvalid 断言扑空）。
    await waitFor(() => {
      expect(
        document.querySelector('[data-decon-field="material"] option[value="mat-aaaaaaaaaaaa"]'),
      ).toBeTruthy();
    });
    fireEvent.change(query('[data-decon-field="material"]'), { target: { value: 'mat-aaaaaaaaaaaa' } });
    fireEvent.click(query('[data-decon-tier="deep"]'));
    // 非正数预算 → budgetInvalid 提示 + 不 create（NaN 分支同 showToast 路径——deconView
    // parseDeconBudgetInput 直测覆盖）。
    fireEvent.change(query('[data-decon-field="budget"]'), { target: { value: '-5' } });
    fireEvent.click(query('[data-decon-action="create"]'));
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.wizard.budgetInvalid');
      expect(lastToast()?.level).toBe('warning');
    });
    expect(createSpy).not.toHaveBeenCalled();
    // 留空仍合法（无预算起跑）——非法门不误伤空值路径。
    fireEvent.change(query('[data-decon-field="budget"]'), { target: { value: '' } });
    fireEvent.click(query('[data-decon-action="create"]'));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ materialId: 'mat-aaaaaaaaaaaa' }));
    });
  });

  it('粗拆档只显风格维（拍板②）+ 未选维度 create 置灰（coarse 空选合法——改验 fine 0 选非法）', async () => {
    seedState({ deconJobs: [], deconJobsLoaded: true });
    await act(async () => {
      render(<DeconPage />);
    });
    fireEvent.click(query('[data-decon-action="new-job"]'));
    await waitFor(() => {
      expect(query('[data-decon-wizard]')).toBeTruthy();
    });
    // 默认 coarse：维度区只有 style。
    await waitFor(() => {
      expect(document.querySelectorAll('[data-decon-dim]').length).toBe(1);
    });
    expect(query('[data-decon-dim="style"]')).toBeTruthy();
    // 切 fine：13 维全显，0 选 → 非法 → create 置灰。
    fireEvent.click(query('[data-decon-tier="fine"]'));
    expect(document.querySelectorAll('[data-decon-dim]').length).toBe(13);
    expect(query('[data-decon-dim-invalid="true"]')).toBeTruthy();
    expect((query('[data-decon-action="create"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('删除确认', () => {
  it('删除 → 确认对话框放行 → decon:delete + toast', async () => {
    await openJob();
    fireEvent.click(query('[data-decon-action="delete"]'));
    await waitFor(() => {
      expect(useConfirmStore.getState().confirmOptions?.title).toBe('decon.deleteConfirmTitle');
    });
    await act(async () => {
      useConfirmStore.getState().resolveConfirm(true);
    });
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith({ jobId: 'decon-aaaaaaaaaaaa' });
    });
    await waitFor(() => {
      expect(lastToast()?.message).toBe('decon.toast.deleted');
    });
  });
});

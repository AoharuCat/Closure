/**
 * 09-12 子5（应用内用量面板）：UsageSettingsPage 渲染矩阵（design §5 / §9.7）。
 *
 * 覆盖：三态（加载/错误/加载完成）/ 聚合瓦片数字与格式化 / ¥ 小字与「仅供参考」+
 * 无价隐藏 / per-model 金额列（无单价行金额 cell 空——不硬造 0）/ 按档位 NULL 组
 * 「未标注」/ 最近调用 NULL token cell「—」+ error_kind 徽标 + 流式首字耗时 / 外链
 * 三链接点击与如实标注 / 清空 confirm 流（确认 → usageClear → 重拉；取消 → 不清）/
 * 空态 / 保留天数可编辑输入（blur 落盘 / 越界钳制 / 非数回显 / 回声抑制 / 失败回滚）。
 *
 * t 用真实 yaml 装配（translate zh-CN 通道——键值即断言文案）；IPC 边界 mock
 * window.orisonDesktop（usageOverview/usageClear/openExternal/loadUserPreferences/
 * saveUserPreferences）。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageOverview } from '@orison/shared-contracts';
import { ConfirmDialog } from '../src/shared/components/ConfirmDialog';
import {
  UsageSettingsPage,
  formatCost,
  formatLatency,
  formatTime,
} from '../src/features/usage/UsageSettingsPage';
import { formatTokenCount } from '../src/shared/utils/numberFormat';
import { useConfirmStore } from '../src/shared/store/confirmStore';
import { useToastStore } from '../src/shared/store/toastStore';
import { useAppStore } from '../src/shared/store/appStore';
import { translate } from '../src/shared/i18n/useI18n';

const t = (key: string, vars?: Record<string, string | number>) => translate('zh-CN', key, vars);

// ConfirmDialog 内部走 useI18n（locale 取 store resolvedLocale）——对齐 zh-CN 断言文案。
beforeEach(() => {
  useAppStore.setState({ resolvedLocale: 'zh-CN' } as any);
});

/** 最近调用首行的固定时刻（formatTime 显式格式断言锚——本地时区构造与格式化同源）。 */
const RECENT_TS = new Date(2026, 8, 13, 9, 5).getTime();

const overviewFixture: UsageOverview = {
  today: {
    calls: 3, failedCalls: 1,
    inputTokens: 1200, outputTokens: 340, thinkingTokens: 90, cacheReadTokens: 40,
    totalTokens: 1670, estimatedCost: 0.01234,
  },
  last7d: {
    calls: 12, failedCalls: 2,
    inputTokens: 9000, outputTokens: 2100, thinkingTokens: 300, cacheReadTokens: 500,
    totalTokens: 11900,
  },
  total: {
    calls: 42, failedCalls: 5,
    inputTokens: 123456, outputTokens: 23456, thinkingTokens: 789, cacheReadTokens: 1024,
    totalTokens: 147625, estimatedCost: 1.5,
  },
  month: {
    calls: 15, failedCalls: 1,
    inputTokens: 30000, outputTokens: 8000, thinkingTokens: 200, cacheReadTokens: 300,
    totalTokens: 38500, estimatedCost: 0.8,
  },
  byModel: [
    {
      keyIds: ['key-a'], modelId: 'model-pro', protocol: 'openai-compatible',
      calls: 8, failedCalls: 1,
      inputTokens: 5000, outputTokens: 1500, thinkingTokens: 200, cacheReadTokens: 400,
      totalTokens: 7100, estimatedCost: 0.25,
    },
    {
      keyIds: ['key-b', 'key-c'], modelId: 'model-free', protocol: 'antigravity-cli',
      calls: 4, failedCalls: 1,
      inputTokens: 4000, outputTokens: 600, thinkingTokens: 100, cacheReadTokens: 100,
      totalTokens: 4800,
    },
  ],
  byTask: [
    { taskType: 'writer-draft', calls: 6, failedCalls: 0, inputTokens: 4000, outputTokens: 1000, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 5000 },
    { taskType: null, calls: 2, failedCalls: 1, inputTokens: 500, outputTokens: 100, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 600 },
  ],
  recent: [
    {
      id: 3, ts: RECENT_TS + 1000, protocol: 'openai-compatible', keyId: 'k-img', modelId: 'img-model',
      taskType: 'image-gen', sessionKey: null,
      stream: false, success: true, errorKind: null, errorMessage: null,
      inputTokens: null, outputTokens: null, thinkingTokens: null, cacheReadTokens: null,
      totalTokens: null, latencyMs: 800, firstDeltaMs: null,
      imageCount: 2,
    },
    {
      id: 2, ts: RECENT_TS, protocol: 'antigravity-cli', keyId: 'k1', modelId: 'agy-model',
      taskType: 'writer-draft', sessionKey: 'chain:1:writer',
      stream: true, success: true, errorKind: null, errorMessage: null,
      inputTokens: 100, outputTokens: 50, thinkingTokens: 10, cacheReadTokens: 0,
      totalTokens: 160, latencyMs: 1500, firstDeltaMs: 320,
      imageCount: null,
    },
    {
      id: 1, ts: RECENT_TS - 1000, protocol: 'openai-compatible', keyId: 'k1', modelId: 'http-model',
      taskType: null, sessionKey: null,
      stream: false, success: false, errorKind: 'quota', errorMessage: '402 quota exceeded',
      inputTokens: null, outputTokens: null, thinkingTokens: null, cacheReadTokens: null,
      totalTokens: null, latencyMs: 420, firstDeltaMs: null,
      imageCount: null,
    },
  ],
  retentionDays: 90,
};

let usageOverviewMock: ReturnType<typeof vi.fn>;
let usageClearMock: ReturnType<typeof vi.fn>;
let openExternalMock: ReturnType<typeof vi.fn>;
let loadPrefsMock: ReturnType<typeof vi.fn>;
let savePrefsMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  usageOverviewMock = vi.fn();
  usageClearMock = vi.fn();
  openExternalMock = vi.fn();
  loadPrefsMock = vi.fn();
  savePrefsMock = vi.fn();
  window.localStorage.clear();
  // toast store 是模块级 zustand 单例——跨用例残留会污染计数断言（C3.2 W3 预算通知）。
  useToastStore.setState({ toasts: [] });
  (window as any).orisonDesktop = {
    usageOverview: (...args: unknown[]) => usageOverviewMock(...(args as [])),
    usageClear: (...args: unknown[]) => usageClearMock(...(args as [])),
    openExternal: (...args: unknown[]) => openExternalMock(...(args as [])),
    loadUserPreferences: (...args: unknown[]) => loadPrefsMock(...(args as [])),
    saveUserPreferences: (...args: unknown[]) => savePrefsMock(...(args as [])),
  };
});

afterEach(() => {
  cleanup();
  useConfirmStore.setState({ confirmOpen: false, confirmOptions: null, confirmResolve: null });
});

function renderPage() {
  return render(
    <>
      <UsageSettingsPage t={t} />
      <ConfirmDialog />
    </>,
  );
}

describe('UsageSettingsPage 三态', () => {
  it('加载态：overview 未返回前显示加载提示', () => {
    usageOverviewMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('加载中…')).not.toBeNull();
  });

  it('错误态：overview 返回 null（桥缺席/失败）→ 加载失败提示', async () => {
    usageOverviewMock.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText('用量数据加载失败。')).not.toBeNull();
  });

  it('空态：全部调用数为 0 → 空提示，表格不渲染', async () => {
    usageOverviewMock.mockResolvedValue({
      ...overviewFixture,
      today: { ...overviewFixture.today, calls: 0 },
      last7d: { ...overviewFixture.last7d, calls: 0 },
      total: { ...overviewFixture.total, calls: 0 },
      byModel: [],
      byTask: [],
      recent: [],
    });
    renderPage();
    expect(await screen.findByText((_, el) => (el?.textContent ?? '').startsWith('还没有调用记录'))).not.toBeNull();
    expect(screen.queryByText('按模型分解（近 7 日）')).toBeNull();
  });
});

describe('UsageSettingsPage 聚合与分解（加载完成）', () => {
  beforeEach(() => {
    usageOverviewMock.mockResolvedValue(overviewFixture);
  });

  it('聚合瓦片：千分位 tokens 大数字 + 调用/失败 + 细分 + ¥ 小字带「仅供参考」', async () => {
    renderPage();
    expect(await screen.findByText('今日')).not.toBeNull();
    expect(screen.getByText('1,670')).not.toBeNull(); // 今日 tokens
    expect(screen.getByText('147,625')).not.toBeNull(); // 累计 tokens
    expect(screen.getByText('3 次调用 · 失败 1 次')).not.toBeNull();
    expect(screen.getByText('42 次调用 · 失败 5 次')).not.toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).toContain('输入 1,200');
    expect(text).toContain('思考 90');
    expect(text).toContain('估算费用 ≈ 0.0123');
    expect(screen.getAllByText('仅供参考').length).toBeGreaterThan(0);
  });

  it('per-model 表：有价行金额 cell 显示换算值，无价行金额 cell 空（不硬造 0）', async () => {
    renderPage();
    expect(await screen.findByText('model-pro')).not.toBeNull();
    const pricedRow = screen.getByText('model-pro').closest('tr')!;
    expect(within(pricedRow).getByText('0.25')).not.toBeNull();
    const unpricedRow = screen.getByText('model-free').closest('tr')!;
    expect(within(unpricedRow).getAllByRole('cell').at(-1)!.textContent).toBe('');
    // ¥ 口径小字（四条）在表下呈现。
    expect(document.body.textContent).toContain('思考 token 按输出价折算');
  });

  it('按档位表：taskType 原文 + NULL 组「未标注」', async () => {
    renderPage();
    // writer-draft 同时出现在档位表与最近调用的档位 cell——复数匹配。
    expect((await screen.findAllByText('writer-draft')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('未标注').length).toBeGreaterThan(0);
  });

  it('CR-4：最近调用表 tokens 细分四列（input/output/thinking/cacheRead）+ 时间显式格式（CR-13）', async () => {
    renderPage();
    expect(await screen.findByText('agy-model')).not.toBeNull();
    const okRow = screen.getByText('agy-model').closest('tr')!;
    // 成功行：四细分 + total 各就位（列序对齐 byModel 表头族）。
    const cells = within(okRow).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual([
      formatTime(RECENT_TS), // CR-13：弃 toLocaleString 的显式 YYYY-MM-DD HH:mm
      'Antigravity CLI', // protocolColumn（protocolLabel 映射）
      'agy-model',
      'writer-draft',
      '100', '50', '10', '0', // in / out / thinking / cacheRead
      '160',
      '1.5s · 首字 320ms',
      '成功',
    ]);
    // 失败行：五个 token cell 全 NULL → 「—」+ title 未上报（CR-18 行级形态）。
    const failRow = screen.getByText('http-model').closest('tr')!;
    expect(within(failRow).getAllByTitle('未上报')).toHaveLength(5);
    for (const cell of within(failRow).getAllByTitle('未上报')) {
      expect(cell.textContent).toBe('—');
    }
  });

  it('CR-2：全 NULL token 窗口 → 瓦片主数字「?」+ 未上报 title；细分行各段「?」（不显示假 0）', async () => {
    usageOverviewMock.mockResolvedValue({
      ...overviewFixture,
      today: {
        calls: 1, failedCalls: 1,
        inputTokens: null, outputTokens: null, thinkingTokens: null, cacheReadTokens: null,
        totalTokens: null,
      },
    });
    renderPage();
    await screen.findByText('今日');
    const tiles = screen.getAllByTestId('usage-tile');
    const todayTile = tiles[0]!;
    const value = within(todayTile).getByText('?')!;
    expect(value.getAttribute('title')).toBe('未上报');
    expect(within(todayTile).getByText(/输入 \?/)).not.toBeNull();
    // 调用数照常显示（未知的是 token，不是调用）。
    expect(within(todayTile).getByText('1 次调用 · 失败 1 次')).not.toBeNull();
  });

  it('CR-3：byModel 折叠行——多键 keyIds 摘要「N 个密钥」+ title 全键；单键原样', async () => {
    renderPage();
    expect(await screen.findByText('model-free')).not.toBeNull();
    const multiRow = screen.getByText('model-free').closest('tr')!;
    expect(within(multiRow).getByText(/2 个密钥/)).not.toBeNull();
    expect(within(multiRow).getByText('model-free').getAttribute('title')).toBe('key-b · key-c · model-free');
    const singleRow = screen.getByText('model-pro').closest('tr')!;
    expect(within(singleRow).getByText(/key-a/)).not.toBeNull();
  });

  it('CR-13：聚合瓦片 section 标签中性（「用量概览」，非「累计」）', async () => {
    renderPage();
    await screen.findByText('今日');
    const section = document.querySelector('section.usage-tiles');
    expect(section?.getAttribute('aria-label')).toBe('用量概览');
  });

  it('CR-16：近 7 日窗空（全旧记录场景）→ byModel/byTask 空态提示，不渲染 header-only 空表', async () => {
    usageOverviewMock.mockResolvedValue({
      ...overviewFixture,
      byModel: [],
      byTask: [],
    });
    renderPage();
    await screen.findByText('今日');
    // total.calls > 0（非整页空态）但两分解表空——空态提示（recentEmpty 同款文案）×2。
    expect(screen.queryAllByText('暂无调用记录。').length).toBeGreaterThanOrEqual(2);
    // 两 section 内均无 table（header-only 空表不渲染；recent 表的「档位」列不受影响）。
    expect(document.querySelector('section[aria-label="按模型分解（近 7 日）"]')?.querySelector('table')).toBeNull();
    expect(document.querySelector('section[aria-label="按档位分解（近 7 日）"]')?.querySelector('table')).toBeNull();
  });

  it('最近调用：error_kind 徽标 + 摘要 title / 流式首字耗时（NULL cell 断言归 CR-4 用例）', async () => {
    renderPage();
    expect(await screen.findByText('agy-model')).not.toBeNull();
    expect(screen.getByTitle('402 quota exceeded').textContent).toBe('quota');
    // 成功行（流式）：耗时 1.5s + 首字 320ms。
    expect(screen.getByText((_, el) => el?.className === 'usage-table-num' && el.textContent === '1.5s · 首字 320ms')).not.toBeNull();
    // 生图行（id 3）加入后成功 chip 有两处——复数断言。
    expect(screen.getAllByText('成功').length).toBe(2);
  });

  it('C3.1 M3：生图行张数 cell——imageCount 有值才显示「×N 张」；token 列如实「—」；非生图行不显示', async () => {
    renderPage();
    expect(await screen.findByText('img-model')).not.toBeNull();
    const imgRow = screen.getByText('img-model').closest('tr')!;
    expect(within(imgRow).getByText('×2 张')).not.toBeNull();
    // 图像 API 无 token 信号：五个 token cell 全「—」（CR-18 行级形态照旧）。
    expect(within(imgRow).getAllByTitle('未上报')).toHaveLength(5);
    // 非生图行（imageCount NULL）不渲染张数。
    const okRow = screen.getByText('agy-model').closest('tr')!;
    expect(within(okRow).queryByText(/×\d+ 张/)).toBeNull();
  });

  it('外链组：三链接点击走 openExternal（URL 常量）+ 标注如实（不含 Antigravity / 无网页通道）', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('月度 AI 积分（Google One）')).not.toBeNull();
    await user.click(screen.getByText('月度 AI 积分（Google One）'));
    await user.click(screen.getByText('5 小时/周窗口查看指引'));
    await user.click(screen.getByText('Gemini 聊天用量设置'));
    expect(openExternalMock).toHaveBeenNthCalledWith(1, 'https://one.google.com/ai/activity');
    expect(openExternalMock).toHaveBeenNthCalledWith(2, 'https://antigravity.google/docs/cli/commands/usage/');
    expect(openExternalMock).toHaveBeenNthCalledWith(3, 'https://gemini.google.com/');
    const text = document.body.textContent ?? '';
    expect(text).toContain('不含 Antigravity');
    expect(text).toContain('没有网页查询通道');
    expect(text).toContain('不含 5 小时/周窗口');
  });

  it('ToS 风险备注行渲染（共享组件，文案单源 settings.cliTosRiskNote）', async () => {
    renderPage();
    await screen.findByText('今日');
    expect(screen.getByText(translate('zh-CN', 'settings.cliTosRiskNote'))).not.toBeNull();
  });

  it('保留天数输入在位：初值 = overview.retentionDays；清空钮在位', async () => {
    renderPage();
    await screen.findByText('今日');
    // C3.2 W3 起页面有三枚 number 输入——按 id 定位保留天数框。
    expect((document.getElementById('usage-retention-days-input') as HTMLInputElement).value).toBe('90');
    expect(screen.getByText('天')).not.toBeNull();
    expect(screen.getByRole('button', { name: '清空全部记录' })).not.toBeNull();
  });

  it('清空 confirm 流：确认 → usageClear → 重拉 overview + toast', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('今日');
    expect(usageOverviewMock).toHaveBeenCalledTimes(1);
    usageClearMock.mockResolvedValue({ ok: true, deleted: 7 });

    await user.click(screen.getByRole('button', { name: '清空全部记录' }));
    // 确认对话框出现（danger 变体，confirm 钮复用「清空全部记录」文案——scoped 查询）。
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '清空全部记录' }));

    expect(usageClearMock).toHaveBeenCalledTimes(1);
    // 清空后重拉 overview。
    await vi.waitFor(() => expect(usageOverviewMock).toHaveBeenCalledTimes(2));
  });

  it('清空 confirm 流：取消 → 不清空不刷新', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('今日');
    await user.click(screen.getByRole('button', { name: '清空全部记录' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(usageClearMock).not.toHaveBeenCalled();
    expect(usageOverviewMock).toHaveBeenCalledTimes(1);
  });
});

describe('保留天数输入（blur 落盘 / 越界钳制 / 回声抑制）', () => {
  beforeEach(() => {
    usageOverviewMock.mockResolvedValue(overviewFixture);
    // 盘面偏好基线：saveUserPreferences 是全量覆盖写，载荷须携盘面既有字段。
    loadPrefsMock.mockResolvedValue({ theme: 'dark', locale: 'zh-CN', usageRetentionDays: 90 });
  });

  function retentionInput(): HTMLInputElement {
    // C3.2 W3 起页面有三枚 number 输入（保留天数 + 预算软/硬线）——按 id 定位非 role。
    return document.getElementById('usage-retention-days-input') as HTMLInputElement;
  }

  it('blur 落盘：改 30 → saveUserPreferences 整对象单字段覆盖 + 重拉 overview + 回显新值', async () => {
    usageOverviewMock
      .mockResolvedValueOnce(overviewFixture)
      .mockResolvedValue({ ...overviewFixture, retentionDays: 30 });
    renderPage();
    await screen.findByText('今日');
    fireEvent.change(retentionInput(), { target: { value: '30' } });
    fireEvent.blur(retentionInput());
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    const payload = savePrefsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.usageRetentionDays).toBe(30);
    // 整对象整存：盘面既有偏好随载荷同行（shell 全量覆盖写，缺键会打回默认）。
    expect(payload.theme).toBe('dark');
    await vi.waitFor(() => expect(usageOverviewMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(retentionInput().value).toBe('30'));
  });

  it('越界钳制：5 → 摔回 7（带内反馈行出现）；9999 → 摔回 730', async () => {
    usageOverviewMock
      .mockResolvedValueOnce(overviewFixture)
      .mockResolvedValueOnce({ ...overviewFixture, retentionDays: 7 })
      .mockResolvedValue({ ...overviewFixture, retentionDays: 730 });
    renderPage();
    await screen.findByText('今日');
    fireEvent.change(retentionInput(), { target: { value: '5' } });
    expect(screen.getByText(t('usagePanel.retentionRangeWarn'))).not.toBeNull();
    fireEvent.blur(retentionInput());
    await vi.waitFor(() => expect(retentionInput().value).toBe('7'));
    await vi.waitFor(() =>
      expect((savePrefsMock.mock.calls[0]?.[0] as Record<string, unknown>)?.usageRetentionDays).toBe(7),
    );
    fireEvent.change(retentionInput(), { target: { value: '9999' } });
    fireEvent.blur(retentionInput());
    await vi.waitFor(() => expect(retentionInput().value).toBe('730'));
    await vi.waitFor(() =>
      expect(
        (savePrefsMock.mock.calls[1]?.[0] as Record<string, unknown>)?.usageRetentionDays,
      ).toBe(730),
    );
  });

  it('空输入：blur 回存量显示，零保存', async () => {
    renderPage();
    await screen.findByText('今日');
    fireEvent.change(retentionInput(), { target: { value: '' } });
    expect(screen.getByText(t('usagePanel.retentionInvalidWarn'))).not.toBeNull();
    fireEvent.blur(retentionInput());
    expect(retentionInput().value).toBe('90');
    expect(savePrefsMock).not.toHaveBeenCalled();
  });

  it('回声抑制：保存成功回显（重拉返回新值）不触发二次保存；未变再 blur 零 IPC', async () => {
    usageOverviewMock
      .mockResolvedValueOnce(overviewFixture)
      .mockResolvedValue({ ...overviewFixture, retentionDays: 30 });
    renderPage();
    await screen.findByText('今日');
    fireEvent.change(retentionInput(), { target: { value: '30' } });
    fireEvent.blur(retentionInput());
    await vi.waitFor(() => expect(retentionInput().value).toBe('30'));
    await vi.waitFor(() => expect(usageOverviewMock).toHaveBeenCalledTimes(2));
    fireEvent.blur(retentionInput());
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
  });

  it('保存失败：error toast + 回存量显示（不丢原值）', async () => {
    renderPage();
    await screen.findByText('今日');
    savePrefsMock.mockRejectedValue(new Error('disk full'));
    fireEvent.change(retentionInput(), { target: { value: '30' } });
    fireEvent.blur(retentionInput());
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(retentionInput().value).toBe('90'));
    expect(
      useToastStore.getState().toasts.some(
        (x) => x.message === t('usagePanel.retentionSaveFailed') && x.level === 'error',
      ),
    ).toBe(true);
  });

  it('CR-9：失败回滚用 ref 最新值——await 期间外部重拉翻新 prop 后，失败不 clobber 新值', async () => {
    let rejectSave!: (err: Error) => void;
    savePrefsMock.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    usageOverviewMock
      .mockResolvedValueOnce(overviewFixture) // 初次加载：retentionDays 90
      .mockResolvedValue({ ...overviewFixture, retentionDays: 45 }); // 手动刷新重拉：45
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('今日');
    // blur 提交 30 → save 悬挂（pending）；期间用户手动刷新 → prop 翻新 45 → 回显 45。
    fireEvent.change(retentionInput(), { target: { value: '30' } });
    fireEvent.blur(retentionInput());
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await vi.waitFor(() => expect(retentionInput().value).toBe('45'));
    // save 失败落地：回滚必须读 ref 最新值 45（旧闭包 value=90 会把输入打回陈旧值）。
    rejectSave(new Error('disk full'));
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    expect(retentionInput().value).toBe('45');
    // C3.2 W3 注记：toast store 前不跨用例清理，本断言一直靠上一用例泄漏的同文案 toast
    // 假绿——重置后暴露 save 拒绝链（race→finally→catch→commit）比 waitFor 首查多几个
    // 微任务跳。waitFor 等待 toast 落店 = 用例本意（失败面 toast 如实呈现）。
    await vi.waitFor(() =>
      expect(
        useToastStore.getState().toasts.some(
          (x) => x.message === t('usagePanel.retentionSaveFailed') && x.level === 'error',
        ),
      ).toBe(true),
    );
  });
});

describe('纯格式化 helper（确定性，不依赖环境 locale）', () => {
  it('formatTokenCount 千分位分组', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1234567)).toBe('1,234,567');
  });

  it('formatCost 最多 4 位小数去尾零，整数不带点', () => {
    expect(formatCost(100)).toBe('100');
    expect(formatCost(0.5)).toBe('0.5');
    expect(formatCost(0.01234)).toBe('0.0123');
    expect(formatCost(1.5000001)).toBe('1.5');
  });

  it('formatLatency：<1s 毫秒 / ≥1s 一位小数秒', () => {
    expect(formatLatency(999)).toBe('999ms');
    expect(formatLatency(1500)).toBe('1.5s');
  });

  it('formatTime：显式 YYYY-MM-DD HH:mm（CR-13——弃 toLocaleString，不依赖环境 locale）', () => {
    // 本地时区构造 + 本地 getter 格式化——同源无时区漂移；分钟补零。
    expect(formatTime(new Date(2026, 8, 13, 9, 5).getTime())).toBe('2026-09-13 09:05');
    expect(formatTime(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02 23:59');
  });
});

// ── C3.2 W3 月度预算（软警硬拦）：状态条 / 截断守卫 / 过线一次性通知 / 双线输入 ──

function budgetFixture(budget: import('@orison/shared-contracts').BudgetStatus): UsageOverview {
  return { ...overviewFixture, budget };
}

function budgetInput(kind: 'soft' | 'hard'): HTMLInputElement {
  const id = kind === 'soft' ? 'usage-budget-soft-input' : 'usage-budget-hard-input';
  return document.getElementById(id) as HTMLInputElement;
}

describe('UsageSettingsPage 月度预算（C3.2 W3）', () => {
  it('无配置（budget ABSENT）：未设置提示 + 双输入空 + 零通知', async () => {
    usageOverviewMock.mockResolvedValue(overviewFixture);
    renderPage();
    expect(await screen.findByText(t('usagePanel.budgetNotSet'))).not.toBeNull();
    expect(budgetInput('soft').value).toBe('');
    expect(budgetInput('hard').value).toBe('');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('soft 态：状态 chip + 本月已用 + 双线进度（过线填充标记）+ 输入回显', async () => {
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ softCny: 0.5, hardCny: 2, state: 'soft', monthSpentCny: 0.8 }),
    );
    renderPage();
    expect(await screen.findByText(t('usagePanel.budgetStateSoft'))).not.toBeNull();
    expect(screen.getByText(t('usagePanel.budgetMonthSpent', { amount: '0.8' }))).not.toBeNull();
    const lines = screen.getAllByTestId('usage-budget-line');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.getAttribute('data-crossed')).toBe('soft'); // 软线过线
    expect(lines[1]!.getAttribute('data-crossed')).toBeNull(); // 硬线未过
    expect(budgetInput('soft').value).toBe('0.5');
    expect(budgetInput('hard').value).toBe('2');
  });

  it('hard 态 + windowTruncated：截断守卫文案常显（不静默）+ 仅硬线一条进度', async () => {
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ hardCny: 2, state: 'hard', monthSpentCny: 2.5, windowTruncated: true }),
    );
    renderPage();
    expect(await screen.findByText(t('usagePanel.budgetStateHard'))).not.toBeNull();
    expect(screen.getByText(t('usagePanel.budgetTruncatedNote'))).not.toBeNull();
    expect(screen.getAllByTestId('usage-budget-line')).toHaveLength(1);
  });

  it('过线一次性通知：soft toast 恰一次 + localStorage 键（月份段+线别+cap）+ 重拉不重复', async () => {
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ softCny: 0.5, state: 'soft', monthSpentCny: 0.8 }),
    );
    renderPage();
    await screen.findByText(t('usagePanel.budgetStateSoft'));
    await vi.waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some(
            (x) =>
              x.message === t('usagePanel.budgetSoftToast', { amount: '0.8' }) && x.level === 'info',
          ),
      ).toBe(true),
    );
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(window.localStorage.getItem(`budgetNotified:${monthKey}:soft:0.5`)).toBe('1');
    // 手动刷新重拉（同态）→ 键已落位 → 不重复 toast。
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await vi.waitFor(() => expect(usageOverviewMock).toHaveBeenCalledTimes(2));
    const softToasts = useToastStore
      .getState()
      .toasts.filter((x) => x.message === t('usagePanel.budgetSoftToast', { amount: '0.8' }));
    expect(softToasts).toHaveLength(1);
  });

  it('ok 态零通知 + 双线输入 blur 落盘（读改写载荷保留原偏好键）', async () => {
    loadPrefsMock.mockResolvedValue({ theme: 'dark', locale: 'zh-CN', usageRetentionDays: 90 });
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ softCny: 5, hardCny: 20, state: 'ok', monthSpentCny: 0.8 }),
    );
    renderPage();
    await screen.findByText(t('usagePanel.budgetStateOk'));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    fireEvent.change(budgetInput('hard'), { target: { value: '15' } });
    fireEvent.blur(budgetInput('hard'));
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    const payload = savePrefsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.theme).toBe('dark'); // 整对象读改写——原偏好键不丢
    expect(payload.budgetHardCny).toBe(15);
    expect(payload.budgetSoftCny).toBe(5);
  });

  it('soft > hard 响亮拒写：内联 warn + 不落盘；改回合法后保存成功', async () => {
    loadPrefsMock.mockResolvedValue({ theme: 'dark', budgetSoftCny: 5, budgetHardCny: 20 });
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ softCny: 5, hardCny: 20, state: 'ok', monthSpentCny: 0.8 }),
    );
    renderPage();
    await screen.findByText(t('usagePanel.budgetStateOk'));
    fireEvent.change(budgetInput('soft'), { target: { value: '30' } });
    expect(screen.getByText(t('usagePanel.budgetSoftRangeWarn'))).not.toBeNull();
    fireEvent.blur(budgetInput('soft'));
    expect(savePrefsMock).not.toHaveBeenCalled(); // 响亮拒写（warn 常显 + 不提交）
    fireEvent.change(budgetInput('soft'), { target: { value: '10' } });
    fireEvent.blur(budgetInput('soft'));
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    const payload = savePrefsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.budgetSoftCny).toBe(10);
  });

  it('清线：输入留空 blur → 该线 undefined 落盘（空 = 不设，另一线不动）', async () => {
    loadPrefsMock.mockResolvedValue({ budgetSoftCny: 5, budgetHardCny: 20 });
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ softCny: 5, hardCny: 20, state: 'ok', monthSpentCny: 0.8 }),
    );
    renderPage();
    await screen.findByText(t('usagePanel.budgetStateOk'));
    fireEvent.change(budgetInput('hard'), { target: { value: '' } });
    fireEvent.blur(budgetInput('hard'));
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    const payload = savePrefsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.budgetHardCny).toBeUndefined();
    expect(payload.budgetSoftCny).toBe(5);
  });

  it('CR-13: 0/负数内联拒——warn 常显 + blur 不落盘回存量（shell clamp 面会把非正数静默清线）', async () => {
    loadPrefsMock.mockResolvedValue({ budgetSoftCny: 5, budgetHardCny: 20 });
    usageOverviewMock.mockResolvedValue(
      budgetFixture({ softCny: 5, hardCny: 20, state: 'ok', monthSpentCny: 0.8 }),
    );
    renderPage();
    await screen.findByText(t('usagePanel.budgetStateOk'));

    // 硬线输 0：意图「全拦」会被 clamp 面变「无执行」——表单面拦下。
    fireEvent.change(budgetInput('hard'), { target: { value: '0' } });
    expect(screen.getByText(t('usagePanel.budgetPositiveWarn'))).not.toBeNull();
    fireEvent.blur(budgetInput('hard'));
    expect(savePrefsMock).not.toHaveBeenCalled();
    // blur 回存量显示。
    expect((budgetInput('hard') as HTMLInputElement).value).toBe('20');

    // 软线输负数：同款拦截。
    fireEvent.change(budgetInput('soft'), { target: { value: '-3' } });
    expect(screen.getByText(t('usagePanel.budgetPositiveWarn'))).not.toBeNull();
    fireEvent.blur(budgetInput('soft'));
    expect(savePrefsMock).not.toHaveBeenCalled();
    expect((budgetInput('soft') as HTMLInputElement).value).toBe('5');

    // 改回正数后正常落盘。
    fireEvent.change(budgetInput('soft'), { target: { value: '4' } });
    expect(screen.queryByText(t('usagePanel.budgetPositiveWarn'))).toBeNull();
    fireEvent.blur(budgetInput('soft'));
    await vi.waitFor(() => expect(savePrefsMock).toHaveBeenCalledTimes(1));
    const payload = savePrefsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.budgetSoftCny).toBe(4);
  });
});

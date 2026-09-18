import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LintApplyFixResult,
  LintFullReport,
  LintModelProbeResult,
  LintScanFullResult,
} from '@orison/shared-contracts';
import { rmBestEffort } from './rmBestEffort';

const {
  handle,
  getLintEngine,
  aggregateFullReport,
  writeLintChapterLedger,
  projectLintReportForL2,
  resolveTaskModel,
  assignmentThinkingControl,
  assignmentFallbackChain,
  resolveModel,
  handleGenerateText,
  readModelConfigFromDisk,
  loadProject,
  assertSafePath,
  warn,
  info,
  error,
  ModelResolutionError,
} = vi.hoisted(() => ({
  handle: vi.fn(),
  getLintEngine: vi.fn(),
  aggregateFullReport: vi.fn(),
  writeLintChapterLedger: vi.fn(async () => true),
  projectLintReportForL2: vi.fn(),
  resolveTaskModel: vi.fn(),
  // S4c：lintIpc classify 携思考策略——mock 归一函数（真实现由 agent 包 wiring 测试钉）；
  // 缺省 vi.fn 返 undefined = 未配思考 → 请求不带 thinking 键（auto，字节级不变）。
  assignmentThinkingControl: vi.fn(),
  assignmentFallbackChain: vi.fn(() => undefined),
  resolveModel: vi.fn(),
  handleGenerateText: vi.fn(),
  readModelConfigFromDisk: vi.fn(),
  loadProject: vi.fn(),
  assertSafePath: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  // CR-19（09-12 子2 CR 批）：classify 预检撤除后「没配模型」的 distinct 降级日志按
  // ModelResolutionError 甄别（真形态 = modelGatewayIpc 的 resolveModel 纯配置失败类型；
  // 此处镜像类供 mock 面注入）。
  ModelResolutionError: class ModelResolutionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ModelResolutionError';
    }
  },
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle },
}));

// Mock the agent package surface lintIpc consumes (engine + ledger + L2 projection +
// resolveTaskModel——CR-026 slot 解析单源). Mocking the module root keeps the heavy
// runtime graph out of this unit test; engine behaviors are pinned by the agent
// package's own lintEngine tests.
vi.mock('@orison/desktop-agent', () => ({
  getLintEngine,
  aggregateFullReport,
  writeLintChapterLedger,
  projectLintReportForL2,
  resolveTaskModel,
  assignmentThinkingControl,
  assignmentFallbackChain,
}));
vi.mock('../main/ipc/configIpc', () => ({ readModelConfigFromDisk }));
// 09-12 子2（复核 H1 重接）：classify 经网关环入口——mock 面加 handleGenerateText。
// CR-19（09-12 子2 CR 批）：classify 预检撤除（不再跑 resolveModel——单源解析在环内
// per-attempt）；resolveModel 保留在 mock 面（model-probe 测试面）；ModelResolutionError
// 镜像类随 mock 注入（classify 失败点按它甄别 distinct 降级日志）。
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveModel,
  handleGenerateText,
  ModelResolutionError,
}));
vi.mock('../main/ipc/pathGuard', () => ({ assertSafePath }));
vi.mock('@orison/desktop-local-bff', () => ({ loadProject }));
// CR-020：logger mock 补 error——lintIpc 的模式 A 错误路径（loadProject threw / apply-fix failed）
// 走 getLogger().error，缺方法即 TypeError 假失败。
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info, error }) }));

// Real node:fs against an in-repo temp dir (sibling of the existing test-tmp
// dirs; rm + recreate per suite run).
const fs = await import('node:fs');
const path = await import('node:path');
const { registerLintIpc } = await import('../main/ipc/lintIpc');

const PROJECT_DIR = path.join(process.cwd(), 'test-tmp-lint-ipc', 'proj');

function chapterFile(id: string, contentFile: string, title?: string) {
  return { id, ...(title ? { title } : {}), sections: [{ content_file: contentFile }] };
}

function makeDoc(chapters: unknown[]) {
  return { novel: { chapters } } as Record<string, unknown>;
}

function fakeEngine() {
  const autoFix = vi.fn(
    ({ text }: { text: string; chapterId: string; filePath: string }) => {
      const changed = text.includes('MARKER');
      return {
        patches: changed ? [{ ruleId: 'mechanical-zero-width' }] : [],
        fixedText: text.replace(/MARKER/g, ''),
        changed,
      };
    },
  );
  return {
    upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
    scanText: vi.fn((text: string, opts: { chapterId: string }) => ({
      chapterId: opts.chapterId,
      issues: [],
      densityIssues: [],
      summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: text.length },
      upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
    })),
    filterByReview: vi.fn((report: unknown) => report),
    projectAutoFixes: autoFix,
  };
}

/**
 * 删除形态投影（mirror lintEngine.projectAutoFixes 的真实行为）：MARKER → 确定性删除，
 * 补丁 replacements=[''] 且 span 起止同位（上游 applyAutoFixWithChanges 对纯删除产
 * from===to 最终区间 → projectAutoFixes 的 Math.max(from, to-1) 收缩到起始位）。
 */
function engineWithDeletionSpans() {
  const engine = fakeEngine();
  engine.projectAutoFixes.mockImplementation(
    ({ text, chapterId, filePath }: { text: string; chapterId: string; filePath: string }) => {
      const changed = text.includes('MARKER');
      const column = text.indexOf('MARKER') + 1;
      return {
        patches: changed
          ? [
              {
                chapterId,
                filePath,
                ruleId: 'mechanical-zero-width',
                span: { line: 1, column, endLine: 1, endColumn: column },
                replacements: [''],
              },
            ]
          : [],
        fixedText: text.replace(/MARKER/g, ''),
        changed,
      };
    },
  );
  return engine;
}

/** aggregateFullReport mock：透传章数组 + 简单 stats。 */
function mockAggregate() {
  aggregateFullReport.mockImplementation(
    (chapters: unknown[]) =>
      ({
        chapters,
        generatedAt: '2026-08-21T00:00:00.000Z',
        stats: {
          chapters: (chapters as unknown[]).length,
          total: 0,
          high: 0,
          medium: 0,
          low: 0,
          densityIssues: 0,
        },
      }) as LintFullReport,
  );
}

const sampleFullReport = (): LintFullReport => ({
  chapters: [],
  generatedAt: '2026-08-21T00:00:00.000Z',
  stats: { chapters: 0, total: 0, high: 0, medium: 0, low: 0, densityIssues: 0 },
});

function writeFullReport(report: LintFullReport) {
  fs.mkdirSync(path.join(PROJECT_DIR, '.orison', 'lint'), { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_DIR, '.orison', 'lint', 'full-report.json'),
    JSON.stringify(report),
    'utf-8',
  );
}

function projectLintProjection() {
  projectLintReportForL2.mockReturnValue({
    findings: [{ ruleId: 'r1', title: 't', count: 1, excerpts: ['a'] }],
    densityIssues: [],
    truncated: false,
  });
}

describe('lintIpc', () => {
  // 捕获注册时提交的 handler（beforeEach clearAllMocks 会清 handle.mock.calls——
  // 注册只发生一次，先固化引用再清）。
  let scanFull: (input: unknown) => Promise<LintScanFullResult>;
  let classify: (input: unknown) => Promise<{
    verdicts: Array<{ ruleId: string; truePositiveRatio: number; note?: string }>;
    degraded: boolean;
  }>;
  let applyFix: (input: unknown) => Promise<LintApplyFixResult>;
  let modelProbe: (input: unknown) => Promise<LintModelProbeResult>;

  beforeAll(() => {
    registerLintIpc();
    expect(handle.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['lint:scan-full', 'lint:classify', 'lint:apply-fix', 'lint:model-probe']),
    );
    const byChannel = new Map(
      handle.mock.calls.map(
        ([channel, fn]) => [channel as string, fn as (e: unknown, input: unknown) => Promise<unknown>],
      ),
    );
    // 包装成 (input) => fn(_, input)——handler 首参是 ipc event（未用）。
    const bind = <T,>(channel: string) => {
      const fn = byChannel.get(channel)!;
      return (input: unknown) => fn(undefined, input) as Promise<T>;
    };
    scanFull = bind<LintScanFullResult>('lint:scan-full');
    classify = bind('lint:classify');
    applyFix = bind<LintApplyFixResult>('lint:apply-fix');
    modelProbe = bind<LintModelProbeResult>('lint:model-probe');
    fs.mkdirSync(path.join(PROJECT_DIR, 'chapters'), { recursive: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    assertSafePath.mockImplementation(() => {});
    resolveTaskModel.mockReturnValue(undefined); // CR-026：缺省未配置档位 → default 哨兵自动选择
    assignmentThinkingControl.mockReturnValue(undefined); // S4c：缺省无思考策略 → 请求不带 thinking 键
    rmBestEffort(path.join(PROJECT_DIR, '.orison'));
    fs.writeFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_001.md'), '正文MARKER一', 'utf-8');
    fs.writeFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_002.md'), '正文二', 'utf-8');
  });

  afterAll(() => {
    rmBestEffort(path.join(process.cwd(), 'test-tmp-lint-ipc'));
  });

  it('registers all four lint channels', () => {
    expect(typeof scanFull).toBe('function');
    expect(typeof classify).toBe('function');
    expect(typeof applyFix).toBe('function');
    expect(typeof modelProbe).toBe('function');
  });

  // ── CR-014：判档探测 shell 单源（review-judge 档解析 + resolveModel 成功即 true）──

  it('model-probe: review-judge 档可解析 → available:true（纯配置解析，零 LLM 调用）', async () => {
    resolveTaskModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    readModelConfigFromDisk.mockReturnValue({ keys: [{ id: 'k1', models: [{ id: 'm1', enabled: true }] }] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });

    expect(await modelProbe(undefined)).toEqual({ available: true });
    // 与 classify 同一解析链（单源）——不发任何网络请求。
    expect(resolveTaskModel).toHaveBeenCalledWith('review-judge');
    expect(handleGenerateText).not.toHaveBeenCalled();
  });

  it('model-probe: resolveModel 抛错（无启用模型）→ available:false，不抛（模式 A）', async () => {
    resolveTaskModel.mockReturnValue(undefined); // 档未配置 → default 哨兵自动选择
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockImplementation(() => {
      throw new Error('no enabled model');
    });

    expect(await modelProbe(undefined)).toEqual({ available: false });
  });

  it('scan-full: enumerates landed chapters, skips traversal + missing files (counted in skipped), aggregates and persists', async () => {
    loadProject.mockReturnValue(
      makeDoc([
        chapterFile('ch_001', 'chapters/ch_001.md', '第一章'),
        chapterFile('ch_002', 'chapters/ch_002.md'),
        // 越界 content_file → skip（mirror batch-tools / runBackfill 防御）
        chapterFile('ch_bad', '../outside.md'),
        // 未落盘（文件不存在）→ skip
        chapterFile('ch_missing', 'chapters/ch_999.md'),
        // 无 sections → skip
        { id: 'ch_nosec' },
      ]),
    );
    const engine = fakeEngine();
    getLintEngine.mockResolvedValue(engine);
    mockAggregate();

    const result = await scanFull({ projectPath: PROJECT_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 越界/未落盘章被跳过；落盘两章入扫描。
    expect(result.chapterFiles).toHaveLength(2);
    expect(result.chapterFiles.map((c) => c.chapterId)).toEqual(['ch_001', 'ch_002']);
    expect(result.chapterFiles[0]!.title).toBe('第一章');
    expect(result.chapterFiles[1]!.title).toBe('ch_002'); // 无 title 回退 chapterId
    expect(engine.scanText).toHaveBeenCalledTimes(2);
    // dry-run fix 投影透出（MARKER 章 1 条）。
    expect(result.fixPatches).toHaveLength(1);
    // CR-011：跳章不再静默——每类跳章入 skipped 返回（稳定 reason 码，UI 可消费）。
    expect(result.skipped).toEqual([
      { chapterId: 'ch_bad', reason: 'escapes-project-dir' },
      { chapterId: 'ch_missing', reason: 'not-landed' },
      { chapterId: 'ch_nosec', reason: 'no-content-file' },
    ]);
    // full-report 落盘。
    expect(fs.existsSync(path.join(PROJECT_DIR, '.orison', 'lint', 'full-report.json'))).toBe(true);
  });

  it('scan-full: 多 section 章跟随 batch 先例只扫 sections[0]，多余 section 入 skipped + warn（CR-011）', async () => {
    loadProject.mockReturnValue({
      novel: {
        chapters: [
          {
            id: 'ch_multi',
            title: '多节章',
            sections: [
              { content_file: 'chapters/ch_001.md' },
              { content_file: 'chapters/ch_002.md' },
              { content_file: 'chapters/ch_999.md' },
              {}, // 无 content_file 的空 section 不计（无正文被忽略）
            ],
          },
        ],
      },
    } as Record<string, unknown>);
    const engine = fakeEngine();
    getLintEngine.mockResolvedValue(engine);
    mockAggregate();

    const result = await scanFull({ projectPath: PROJECT_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chapterFiles).toHaveLength(1);
    expect(result.chapterFiles[0]!.filePath.endsWith('ch_001.md')).toBe(true); // sections[0] canonical
    expect(engine.scanText).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual([
      {
        chapterId: 'ch_multi',
        reason: 'multi-section',
        note: '2 extra section(s) with content_file not scanned',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ chapterId: 'ch_multi', extraSections: 2 }),
      expect.stringContaining('multi-section'),
    );
  });

  it('scan-full: deletion-class fix patches carry collapsed spans（确认面「删除」标注的 span 契约）', async () => {
    loadProject.mockReturnValue(makeDoc([chapterFile('ch_001', 'chapters/ch_001.md')]));
    getLintEngine.mockResolvedValue(engineWithDeletionSpans());
    mockAggregate();

    const result = await scanFull({ projectPath: PROJECT_DIR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fixPatches).toHaveLength(1);
    const patch = result.fixPatches[0]!;
    expect(patch.replacements).toEqual(['']);
    expect(patch.span.endLine).toBe(patch.span.line);
    expect(patch.span.endColumn).toBe(patch.span.column);
  });

  it('scan-full: engine unavailable → 模式 A error code', async () => {
    loadProject.mockReturnValue(makeDoc([]));
    getLintEngine.mockResolvedValue(null);
    const result = await scanFull({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ ok: false, error: 'engine-unavailable', message: expect.any(String) });
  });

  // ── CR-003：章文件编码探测读（decodeFileToUtf8——project:read-file 同款）──
  // 盲读 utf-8 会把 GBK/UTF-16/BOM 章读成 mojibake（U+FFFD），apply-fix 重写即永久损坏。

  it('scan-full: GBK 章文件按编码探测解码（不再 mojibake）（CR-003）', async () => {
    loadProject.mockReturnValue(makeDoc([chapterFile('ch_gbk', 'chapters/ch_gbk.md')]));
    // '中文' 的 GBK 字节序列（D6 D0 CE C4）——中文 .txt 在 Windows 常为 GBK。
    fs.writeFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_gbk.md'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    const engine = fakeEngine();
    getLintEngine.mockResolvedValue(engine);
    mockAggregate();

    const result = await scanFull({ projectPath: PROJECT_DIR });

    expect(result.ok).toBe(true);
    expect(engine.scanText).toHaveBeenCalledTimes(1);
    expect(engine.scanText.mock.calls[0]![0]).toBe('中文'); // 解码干净，非 U+FFFD 串
  });

  it('scan-full: UTF-8 BOM 章文件剥 BOM 后入扫描（CR-003）', async () => {
    loadProject.mockReturnValue(makeDoc([chapterFile('ch_bom', 'chapters/ch_bom.md')]));
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'chapters', 'ch_bom.md'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf-8')]),
    );
    const engine = fakeEngine();
    getLintEngine.mockResolvedValue(engine);
    mockAggregate();

    await scanFull({ projectPath: PROJECT_DIR });

    expect(engine.scanText.mock.calls[0]![0]).toBe('正文'); // 无 U+FEFF 前缀
  });

  it('apply-fix: GBK 章读入解码 + 写回恒 UTF-8（修后自然归整，无 U+FFFD 固化）（CR-003）', async () => {
    loadProject.mockReturnValue(makeDoc([chapterFile('ch_gbk', 'chapters/ch_gbk.md')]));
    // '中文MARKER'：中文 = GBK 字节，MARKER = ASCII（GBK 对 ASCII 透明）。
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'chapters', 'ch_gbk.md'),
      Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('MARKER', 'ascii')]),
    );
    getLintEngine.mockResolvedValue(engineWithDeletionSpans());

    const patches = [
      {
        chapterId: 'ch_gbk',
        filePath: 'chapters/ch_gbk.md',
        ruleId: 'mechanical-zero-width',
        span: { line: 1, column: 3, endLine: 1, endColumn: 3 },
        replacements: [''],
      },
    ];
    const result = await applyFix({ projectPath: PROJECT_DIR, patches });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ chapterId: 'ch_gbk', written: true, changes: 1 });
    // 写回 UTF-8：按 utf-8 读回即干净正文（MARKER 被确定性删除）。
    expect(fs.readFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_gbk.md'), 'utf-8')).toBe('中文');
  });

  // ── CR-010：章级 try/catch 全覆盖——单章抛错不吞前章结果，handler 永不 reject（模式 A）──

  it('scan-full: 第二章 scanText 抛错 → 前章结果保留 + 该章入 skipped(scan-failed)（CR-010）', async () => {
    loadProject.mockReturnValue(
      makeDoc([
        chapterFile('ch_001', 'chapters/ch_001.md'),
        chapterFile('ch_002', 'chapters/ch_002.md'),
      ]),
    );
    const engine = fakeEngine();
    engine.scanText.mockImplementation((text: string, opts: { chapterId: string }) => {
      if (opts.chapterId === 'ch_002') throw new Error('engine boom');
      return {
        chapterId: opts.chapterId,
        issues: [],
        densityIssues: [],
        summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: text.length },
        upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
      };
    });
    getLintEngine.mockResolvedValue(engine);
    mockAggregate();

    const result = await scanFull({ projectPath: PROJECT_DIR });

    expect(result.ok).toBe(true); // 不 reject
    if (!result.ok) return;
    expect(aggregateFullReport).toHaveBeenCalledTimes(1);
    expect((aggregateFullReport.mock.calls[0]![0] as unknown[]).length).toBe(1); // 前章保留
    expect(result.skipped).toEqual([{ chapterId: 'ch_002', reason: 'scan-failed' }]);
  });

  it('apply-fix: 第二章 projectAutoFixes 抛错 → 前章已写结果保留 + 该章 note=chapter-error（CR-010）', async () => {
    loadProject.mockReturnValue(
      makeDoc([
        chapterFile('ch_001', 'chapters/ch_001.md'),
        chapterFile('ch_002', 'chapters/ch_002.md'),
      ]),
    );
    const engine = engineWithDeletionSpans();
    const originalImpl = engine.projectAutoFixes.getMockImplementation()!;
    engine.projectAutoFixes.mockImplementation(
      (args: { text: string; chapterId: string; filePath: string }) => {
        if (args.chapterId === 'ch_002') throw new Error('replay boom');
        return originalImpl(args);
      },
    );
    getLintEngine.mockResolvedValue(engine);
    mockAggregate();

    const patches = [
      {
        chapterId: 'ch_001',
        filePath: 'chapters/ch_001.md',
        ruleId: 'mechanical-zero-width',
        span: { line: 1, column: 3, endLine: 1, endColumn: 3 },
        replacements: [''],
      },
      {
        chapterId: 'ch_002',
        filePath: 'chapters/ch_002.md',
        ruleId: 'mechanical-zero-width',
        span: { line: 1, column: 1, endLine: 1, endColumn: 1 },
        replacements: [''],
      },
    ];
    const result = await applyFix({ projectPath: PROJECT_DIR, patches });

    expect(result.ok).toBe(true); // 不 reject、不整单失败
    if (!result.ok) return;
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ chapterId: 'ch_001', written: true }); // 前章保留
    expect(result.results[1]).toMatchObject({
      chapterId: 'ch_002',
      written: false,
      note: 'chapter-error',
    });
    // 前章文件确已写回（MARKER 删除）。
    expect(fs.readFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_001.md'), 'utf-8')).toBe('正文一');
  });

  it('scan-full: missing projectPath → no-project；loadProject null → project-not-found', async () => {
    expect(await scanFull({})).toEqual({ ok: false, error: 'no-project' });
    loadProject.mockReturnValue(null);
    getLintEngine.mockResolvedValue(fakeEngine());
    expect(await scanFull({ projectPath: PROJECT_DIR })).toMatchObject({
      ok: false,
      error: 'project-not-found',
    });
  });

  it('classify: no full-report on disk → degraded (never throws)', async () => {
    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ verdicts: [], degraded: true });
    expect(handleGenerateText).not.toHaveBeenCalled();
  });

  it('classify: 没配模型（环入口 ModelResolutionError）→ degraded + distinct 降级日志，不重试（CR-19 预检撤除后失败点甄别）', async () => {
    writeFullReport(sampleFullReport());
    projectLintProjection();
    // CR-19：预检已撤——「没配模型」经环入口同步抛（resolveModel 在环内 per-attempt
    // 权威解析，纯配置失败零网络）。mock 面注入镜像类形态。
    handleGenerateText.mockRejectedValue(new ModelResolutionError("Model ref points to unknown key 'default'"));

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ verdicts: [], degraded: true });
    // 环入口确实被调（单次）且失败后不再重试（调用失败非 JSON 解析失败——design §4）。
    expect(handleGenerateText).toHaveBeenCalledTimes(1);
    // distinct 日志路径保持（原预检的日志语义收编到失败点）。
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('unknown key') }),
      'lintIpc classify: no model resolvable (review-judge slot / auto-pick) → degraded',
    );
    // 预检撤除的回归锚：classify 不再跑第二遍 resolveModel（双解析 TOCTOU 消除）。
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('classify: fenced JSON parsed → verdicts kept; hallucinated ruleIds dropped; review-judge 档经 resolveTaskModel 单源解析（CR-026）', async () => {
    writeFullReport(sampleFullReport());
    projectLintReportForL2.mockReturnValue({
      findings: [
        { ruleId: 'r1', title: 't1', count: 3, excerpts: ['a'] },
        { ruleId: 'r2', title: 't2', count: 1, excerpts: ['b'] },
      ],
      densityIssues: [],
      truncated: false,
    });
    // CR-026：agent 包 resolveTaskModel（agentIpc setTaskSlotResolver 注入的同一解析函数）返档位 ref。
    resolveTaskModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    readModelConfigFromDisk.mockReturnValue({
      keys: [{ id: 'k1', models: [{ id: 'm1', enabled: true }] }],
    });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    handleGenerateText.mockResolvedValue({
      model: 'm1',
      text:
        '```json\n{"verdicts":[{"ruleId":"r1","truePositiveRatio":0.8,"note":"删填充词"},' +
        '{"ruleId":"r2","truePositiveRatio":1.5,"note":"超界夹取"},' +
        '{"ruleId":"hallucinated","truePositiveRatio":1,"note":"应被丢弃"}]}\n```',
    });

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result.degraded).toBe(false);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.find((v) => v.ruleId === 'r2')!.truePositiveRatio).toBe(1);
    expect(result.verdicts.find((v) => v.ruleId === 'hallucinated')).toBeUndefined();
    // 档位解析经 agent 包 resolveTaskModel('review-judge') 单源（不再手写 config.taskModels 复刻）。
    expect(resolveTaskModel).toHaveBeenCalledWith('review-judge');
    // CR-19：预检撤除——classify 面零 resolveModel 调用（真实解析单源在环内 per-attempt）。
    expect(resolveModel).not.toHaveBeenCalled();
    // 覆盖完整（r1+r2）→ 不带 partial 标记。
    expect((result as { partial?: boolean }).partial).toBeUndefined();
    // maxTokens 提至 8192（CR-012：4096 对 25 规则组会截断）——环入口 payload.request 形态。
    expect(handleGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ maxTokens: 8192 }) }),
    );
  });

  // S4c（08-25 design「lintIpc review-judge 同链」）：classify 直调面携 review-judge 档思考
  // 策略——assignment 单次解析，ref 与 thinking 同源；归一函数 mock（真实现由 agent 包
  // wiring 测试钉），本处钉「assignmentThinkingControl(assignment) 的返回进了请求体」+ 未配不带键。
  it('classify: review-judge 档思考策略 → 请求体含 thinking（S4c 同链注入）；未配 → 不带键', async () => {
    writeFullReport(sampleFullReport());
    projectLintReportForL2.mockReturnValue({
      findings: [{ ruleId: 'r1', title: 't1', count: 2, excerpts: ['a'] }],
      densityIssues: [],
      truncated: false,
    });
    resolveTaskModel.mockReturnValue({ keyId: 'k1', modelId: 'm1', thinking: 'high' });
    readModelConfigFromDisk.mockReturnValue({
      keys: [{ id: 'k1', models: [{ id: 'm1', enabled: true }] }],
    });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    assignmentThinkingControl.mockReturnValue({ level: 'high' });
    handleGenerateText.mockResolvedValue({ model: 'm1', text: '{"verdicts":[]}' });

    let result = await classify({ projectPath: PROJECT_DIR });
    expect(result.degraded).toBe(false);
    // 归一函数吃到完整 assignment（thinking 键在场）。
    expect(assignmentThinkingControl).toHaveBeenCalledWith({ keyId: 'k1', modelId: 'm1', thinking: 'high' });
    // 请求体带 thinking（两次调用同携——重试不丢策略）——环入口 payload.request 形态。
    expect(handleGenerateText).toHaveBeenCalledTimes(1);
    expect(handleGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ thinking: { level: 'high' } }) }),
    );

    // 未配思考（归一返 undefined）→ 请求体无 thinking 键（auto，字节级不变）。
    handleGenerateText.mockClear();
    assignmentThinkingControl.mockReturnValue(undefined);
    handleGenerateText.mockResolvedValue({ model: 'm1', text: '{"verdicts":[]}' });
    result = await classify({ projectPath: PROJECT_DIR });
    expect(result.degraded).toBe(false);
    const request = (handleGenerateText.mock.calls[0][0] as { request: Record<string, unknown> }).request;
    expect('thinking' in request).toBe(false);
  });

  it('classify: verdicts 空数组（解析成功）→ 诚实空成功 degraded:false，不重试（CR-012）', async () => {
    writeFullReport(sampleFullReport());
    projectLintProjection();
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    handleGenerateText.mockResolvedValue({ model: 'm1', text: '{"verdicts":[]}' });

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ verdicts: [], degraded: false });
    expect(handleGenerateText).toHaveBeenCalledTimes(1); // 已成功解析——重试即误重试
  });

  it('classify: verdicts 全为清单外 ruleId（全幻觉被滤）→ 诚实空成功，不重试（CR-012）', async () => {
    writeFullReport(sampleFullReport());
    projectLintProjection();
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    handleGenerateText.mockResolvedValue({
      model: 'm1',
      text: '{"verdicts":[{"ruleId":"made-up","truePositiveRatio":1,"note":"幻觉"}]}',
    });

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ verdicts: [], degraded: false });
    expect(handleGenerateText).toHaveBeenCalledTimes(1);
  });

  it('classify: finishReason=length 截断 → 直接 degraded，不重试（CR-012）', async () => {
    writeFullReport(sampleFullReport());
    projectLintProjection();
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    // 即便残余恰好是合法 JSON，截断输出不可信（verdicts 可能只覆盖前半清单）。
    handleGenerateText.mockResolvedValue({
      model: 'm1',
      finishReason: 'length',
      text: '{"verdicts":[{"ruleId":"r1","truePositiveRatio":0.8,"note":"被切断的前半"}]}',
    });

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ verdicts: [], degraded: true });
    expect(handleGenerateText).toHaveBeenCalledTimes(1); // 同参数重跑大概率再截——不重试
  });

  it('classify: verdicts 覆盖不足 → partial=true（additive 标记，C1.3 消费）（CR-012）', async () => {
    writeFullReport(sampleFullReport());
    projectLintReportForL2.mockReturnValue({
      findings: [
        { ruleId: 'r1', title: 't1', count: 2, excerpts: ['a'] },
        { ruleId: 'r2', title: 't2', count: 1, excerpts: ['b'] },
      ],
      densityIssues: [],
      truncated: false,
    });
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    handleGenerateText.mockResolvedValue({
      model: 'm1',
      text: '{"verdicts":[{"ruleId":"r1","truePositiveRatio":0.8,"note":"漏了 r2"}]}',
    });

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result.degraded).toBe(false);
    expect(result.verdicts).toHaveLength(1);
    expect((result as { partial?: boolean }).partial).toBe(true);
  });

  it('classify: density-only 稿（零 findings）也进 LLM，density 规则 verdict 不被当幻觉丢弃（CR-013）', async () => {
    writeFullReport(sampleFullReport());
    projectLintReportForL2.mockReturnValue({
      findings: [],
      densityIssues: [{ ruleId: 'density.x', hits: 30, perKilo: 9, samples: ['新的开始'] }],
      truncated: false,
    });
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    handleGenerateText.mockResolvedValue({
      model: 'm1',
      text: '{"verdicts":[{"ruleId":"density.x","truePositiveRatio":0.9,"note":"密度真阳"}]}',
    });

    const result = await classify({ projectPath: PROJECT_DIR });
    // 密度指纹即无可判对象进 LLM（旧逻辑 findings 空即诚实空跳过——CR-013 修正）。
    expect(handleGenerateText).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(false);
    expect(result.verdicts).toEqual([
      { ruleId: 'density.x', truePositiveRatio: 0.9, note: '密度真阳' },
    ]);
  });

  it('classify: garbage output retried once, still garbage → degraded', async () => {
    writeFullReport(sampleFullReport());
    projectLintProjection();
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    resolveModel.mockReturnValue({ keyId: 'k1', modelId: 'm1' });
    handleGenerateText.mockResolvedValue({ model: 'm1', text: '这不是 JSON' });

    const result = await classify({ projectPath: PROJECT_DIR });
    expect(result).toEqual({ verdicts: [], degraded: true });
    expect(handleGenerateText).toHaveBeenCalledTimes(2); // 解析失败一次重试（design §4）
  });

  it('apply-fix: invalid patches → invalid-patches（模式 A）', async () => {
    const result = await applyFix({ projectPath: PROJECT_DIR, patches: [{ chapterId: '' }] });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe('invalid-patches');
  });

  it('apply-fix: replays deterministic fixes, writes chapter + ledger + full-report refresh', async () => {
    loadProject.mockReturnValue(
      makeDoc([
        chapterFile('ch_001', 'chapters/ch_001.md'),
        chapterFile('ch_002', 'chapters/ch_002.md'),
      ]),
    );
    getLintEngine.mockResolvedValue(engineWithDeletionSpans());
    mockAggregate();
    // 既有 full-report（两章旧账）。
    writeFullReport({
      chapters: [
        {
          chapterId: 'ch_001',
          issues: [],
          densityIssues: [],
          summary: { total: 5, high: 5, medium: 0, low: 0, visibleChars: 10 },
          upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
        },
        {
          chapterId: 'ch_002',
          issues: [],
          densityIssues: [],
          summary: { total: 0, high: 0, medium: 0, low: 0, visibleChars: 10 },
          upstream: { repo: 'r', commit: 'c', ruleVersion: 'v' },
        },
      ],
      generatedAt: '2026-08-20T00:00:00.000Z',
      stats: { chapters: 2, total: 5, high: 5, medium: 0, low: 0, densityIssues: 0 },
    });

    const patches = [
      {
        chapterId: 'ch_001',
        filePath: 'chapters/ch_001.md',
        ruleId: 'mechanical-zero-width',
        span: { line: 1, column: 3, endLine: 1, endColumn: 3 },
        replacements: [''],
      },
    ];
    const result = await applyFix({ projectPath: PROJECT_DIR, patches });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ chapterId: 'ch_001', written: true, changes: 1 });
    // 章文件已按当前正文重放结果写回（MARKER 被确定性删除）。
    expect(fs.readFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_001.md'), 'utf-8')).toBe('正文一');
    // 章账刷新单源调用。
    expect(writeLintChapterLedger).toHaveBeenCalledWith({
      projectPath: PROJECT_DIR,
      chapterId: 'ch_001',
      text: '正文一',
    });
    // full-report 已刷新（stats 重算，章数保持 2）。
    const refreshed = JSON.parse(
      fs.readFileSync(path.join(PROJECT_DIR, '.orison', 'lint', 'full-report.json'), 'utf-8'),
    ) as LintFullReport;
    expect(refreshed.stats.chapters).toBe(2);
    // CR-018：generatedAt 语义 = 最后一次全稿扫描时间——apply-fix 刷新保留原时间戳
    // （aggregateFullReport mock 会盖 2026-08-21，原报告是 2026-08-20，须以前者落盘）。
    expect(refreshed.generatedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('apply-fix: nothing left to fix → written false, file untouched', async () => {
    loadProject.mockReturnValue(makeDoc([chapterFile('ch_002', 'chapters/ch_002.md')]));
    getLintEngine.mockResolvedValue(engineWithDeletionSpans());

    const patches = [
      {
        chapterId: 'ch_002',
        filePath: 'chapters/ch_002.md',
        ruleId: 'mechanical-zero-width',
        span: { line: 1, column: 1, endLine: 1, endColumn: 1 },
        replacements: [''],
      },
    ];
    const result = await applyFix({ projectPath: PROJECT_DIR, patches });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ chapterId: 'ch_002', written: false, changes: 0 });
    expect(fs.readFileSync(path.join(PROJECT_DIR, 'chapters', 'ch_002.md'), 'utf-8')).toBe('正文二');
    expect(writeLintChapterLedger).not.toHaveBeenCalled();
  });
});

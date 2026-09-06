/**
 * parse_document handler tests (Story 3.6 WP6, R10 / design D11).
 *
 * ZERO network — config loader / probe / endpoint parser / pdf+docx kernels
 * are injectable stubs. Locks the dispatch matrix:
 *
 *   - pdf: endpoint-first (configured + probe ok + endpoint ok → endpoint
 *     via); endpoint failure / dead probe / unconfigured → builtin pdfjs with
 *     the failure recorded as a 备注; scanned verdict → vision-path hint
 *     (analyze_image + 配置端点) instead of near-empty text; thin pages note.
 *   - docx: ALWAYS local mammoth — the endpoint is NOT tried even when
 *     configured (deliberate local-first, design D11).
 *   - txt/md: direct-read.
 *   - capping (default 32K / clamp 64K) + provenance (来源/解析 via).
 *   - path safety: project-relative resolve + assertWithinProject THROWS on
 *     escape (mirror imageHandlers pattern B); missing file / unsupported
 *     kind / corrupt parse degrade friendly (R8).
 *
 * Plus one REAL-kernel pass: a hand-built PDF fixture through the default
 * pdf extractor (no stub) — an in-file integration of handler + docParsing.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocParserConfig } from '@orison/shared-contracts';

const { handle, safeStorage, setProxy, reindexAll, reindexAllCraft, reindexAllAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  setProxy: vi.fn().mockResolvedValue(undefined),
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  reindexAllAssetCards: vi.fn(),
  reindexAllSettingMd: vi.fn(),
  getProjectById: vi.fn(),
  getProject: vi.fn(),
  getDb: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  session: { defaultSession: { setProxy } },
  net: { fetch: vi.fn() },
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAllAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import type { EndpointParseResult } from '../main/research/docParserAdapters';
import type { DocParserProbeResult } from '../main/research/docParserConfig';
import type { PdfTextExtraction } from '../main/research/docParsing';
import {
  PARSE_DOC_DEFAULT_MAX_CHARS,
  PARSE_DOC_MAX_CHARS_LIMIT,
  PARSE_VIA_LABELS,
  coerceParseDocParams,
  createParseDocumentHandler,
  parseDocumentHandler,
  type ParseDocumentHandlerDeps,
} from '../main/ipc/toolHandlers/parseDocumentHandlers';
import { buildPdfFixture } from './fixtures/documentFixtures';

// ── Fixtures / helpers ──

const UNCONFIGURED: DocParserConfig = {};
const CONFIGURED_MINERU: DocParserConfig = { type: 'mineru', baseUrl: 'http://127.0.0.1:8000' };

const PROBE_OK: DocParserProbeResult = { ok: true, kind: 'mineru' };
const PROBE_DEAD: DocParserProbeResult = { ok: false, kind: 'mineru', detail: '端点健康检查返回 HTTP 503' };

const TEXT_PDF: PdfTextExtraction = {
  kind: 'text',
  pages: 3,
  text: '# 第一章\n正文内容。',
  avgCharsPerPage: 400,
  scannedPages: [],
};
const THIN_PAGE_PDF: PdfTextExtraction = { ...TEXT_PDF, scannedPages: [2] };
const SCANNED_PDF: PdfTextExtraction = {
  kind: 'scanned',
  pages: 5,
  text: '',
  avgCharsPerPage: 2,
  scannedPages: [1, 2, 3, 4, 5],
};

let projectDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  setProxy.mockReset().mockResolvedValue(undefined);
  getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'parse-doc-handler-'));
});

afterEach(() => {
  rmBestEffort(projectDir);
});

function ctx(params: Record<string, unknown>) {
  return { params, projectDir, sessionId: 's1', abort: new AbortController().signal };
}

function writeFile(name: string, content: string | Buffer): string {
  writeFileSync(path.join(projectDir, name), content);
  return name;
}

interface HandlerOverrides {
  config?: DocParserConfig;
  probe?: DocParserProbeResult;
  endpoint?: EndpointParseResult;
  pdf?: PdfTextExtraction;
  /** Omit to keep the default (stubbed) pdf extractor; pass 'real' for the real kernel. */
  realPdf?: boolean;
}

function handler(overrides: HandlerOverrides = {}) {
  const deps: ParseDocumentHandlerDeps = {
    loadConfig: () => overrides.config ?? UNCONFIGURED,
    probe: vi.fn(async () => overrides.probe ?? PROBE_OK),
    parseEndpoint: vi.fn(async (): Promise<EndpointParseResult> => overrides.endpoint ?? { ok: false, error: 'unused' }),
    extractPdf: overrides.realPdf ? undefined : vi.fn(async () => overrides.pdf ?? TEXT_PDF),
    extractDocx: vi.fn(async () => '角色卡正文（mammoth 提取）'),
  };
  const h = createParseDocumentHandler(deps);
  return { h, deps: deps as Required<ParseDocumentHandlerDeps> & { probe: ReturnType<typeof vi.fn>; parseEndpoint: ReturnType<typeof vi.fn>; extractPdf?: ReturnType<typeof vi.fn>; extractDocx: ReturnType<typeof vi.fn> } };
}

// ── Param coercion ──

describe('coerceParseDocParams', () => {
  it('trims filePath, rejects blanks/non-strings, clamps maxChars into [1, 64000]', () => {
    expect(coerceParseDocParams({ filePath: ' a.pdf ' })).toEqual({ filePath: 'a.pdf', maxChars: undefined });
    expect(coerceParseDocParams({ filePath: '   ' }).filePath).toBeUndefined();
    expect(coerceParseDocParams({ filePath: 9 }).filePath).toBeUndefined();
    expect(coerceParseDocParams({ filePath: 'a.pdf', maxChars: 99_999 }).maxChars).toBe(PARSE_DOC_MAX_CHARS_LIMIT);
    expect(coerceParseDocParams({ filePath: 'a.pdf', maxChars: 0 }).maxChars).toBe(1);
    expect(PARSE_DOC_DEFAULT_MAX_CHARS).toBe(32_000);
    expect(PARSE_DOC_MAX_CHARS_LIMIT).toBe(64_000);
  });
});

// ── txt/md (direct read) ──

describe('parse_document — txt/md direct read', () => {
  it('reads utf-8 content with via=direct-read + provenance line', async () => {
    const { h } = handler();
    const result = await h(ctx({ filePath: writeFile('设定.md', '# 设定标题\n正文') }));
    expect(result.output).toContain('# 设定标题');
    expect(result.output).toContain('来源: 设定.md');
    expect(result.output).toContain(PARSE_VIA_LABELS['direct-read']);
    expect(result.metadata).toMatchObject({ via: 'direct-read', kind: 'text', truncated: false });
  });

  it('strips a leading BOM', async () => {
    const { h } = handler();
    const result = await h(ctx({ filePath: writeFile('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf-8')])) }));
    expect(result.output.startsWith('正文')).toBe(true);
  });
});

// ── PDF dispatch matrix ──

describe('parse_document — pdf dispatch', () => {
  it('unconfigured → builtin pdfjs (probe + endpoint never called)', async () => {
    const { h, deps } = handler({ config: UNCONFIGURED });
    const file = writeFile('doc.pdf', '%PDF-fixture');
    const result = await h(ctx({ filePath: file }));

    expect(result.metadata).toMatchObject({ via: 'builtin-pdfjs', kind: 'pdf', pages: 3 });
    expect(result.output).toContain('# 第一章');
    expect(result.output).toContain('页数: 3');
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.parseEndpoint).not.toHaveBeenCalled();
  });

  it('configured + probe ok + endpoint ok → endpoint markdown wins', async () => {
    const { h } = handler({
      config: CONFIGURED_MINERU,
      probe: PROBE_OK,
      endpoint: { ok: true, markdown: '# MinerU OCR 结果', via: 'endpoint-mineru' },
    });
    const result = await h(ctx({ filePath: writeFile('doc.pdf', '%PDF-fixture') }));

    expect(result.metadata).toMatchObject({ via: 'endpoint-mineru', kind: 'pdf' });
    expect(result.output).toContain('# MinerU OCR 结果');
    expect(result.output).toContain(PARSE_VIA_LABELS['endpoint-mineru']);
  });

  it('endpoint FAILURE degrades to builtin with the failure recorded as a 备注', async () => {
    const { h, deps } = handler({
      config: CONFIGURED_MINERU,
      probe: PROBE_OK,
      endpoint: { ok: false, error: 'MinerU 端点响应中未找到可用的 md_content 字段' },
    });
    const result = await h(ctx({ filePath: writeFile('doc.pdf', '%PDF-fixture') }));

    expect(result.metadata).toMatchObject({ via: 'builtin-pdfjs' });
    expect(result.output).toContain('解析端点失败');
    expect(result.output).toContain('已降级内置 PDF 文本层提取');
    expect(deps.parseEndpoint).toHaveBeenCalledTimes(1);
  });

  it('probe FAILURE skips the endpoint entirely (builtin + probe note)', async () => {
    const { h, deps } = handler({ config: CONFIGURED_MINERU, probe: PROBE_DEAD });
    const result = await h(ctx({ filePath: writeFile('doc.pdf', '%PDF-fixture') }));

    expect(result.metadata).toMatchObject({ via: 'builtin-pdfjs' });
    expect(result.output).toContain('解析端点探活失败');
    expect(result.output).toContain('HTTP 503');
    expect(deps.parseEndpoint).not.toHaveBeenCalled();
  });

  it('endpoint THROW (not {ok:false}) still degrades to builtin', async () => {
    const { h } = handler({ config: CONFIGURED_MINERU, probe: PROBE_OK });
    const throwing = createParseDocumentHandler({
      loadConfig: () => CONFIGURED_MINERU,
      probe: async () => PROBE_OK,
      parseEndpoint: async () => {
        throw new Error('boom');
      },
      extractPdf: async () => TEXT_PDF,
    });
    const result = await throwing(ctx({ filePath: writeFile('doc.pdf', '%PDF-fixture') }));
    expect(result.metadata).toMatchObject({ via: 'builtin-pdfjs' });
    expect(result.output).toContain('解析端点失败');
    void h;
  });

  it('scanned verdict → vision-path hint, no near-empty正文', async () => {
    const { h } = handler({ pdf: SCANNED_PDF });
    const result = await h(ctx({ filePath: writeFile('scan.pdf', '%PDF-fixture') }));

    expect(result.metadata).toMatchObject({ scanned: true, pages: 5, via: 'builtin-pdfjs' });
    expect(result.output).toContain('疑似扫描件');
    expect(result.output).toContain('5 页');
    expect(result.output).toContain('analyze_image');
    expect(result.output).toContain('MinerU / docling');
  });

  it('scanned verdict ALSO carries the endpoint-failure note (degrade chain visible)', async () => {
    const { h } = handler({
      config: CONFIGURED_MINERU,
      probe: PROBE_OK,
      endpoint: { ok: false, error: 'HTTP 500' },
      pdf: SCANNED_PDF,
    });
    const result = await h(ctx({ filePath: writeFile('scan.pdf', '%PDF-fixture') }));
    expect(result.output).toContain('疑似扫描件');
    expect(result.output).toContain('解析端点失败');
  });

  it('thin pages are flagged while the doc stays a text doc', async () => {
    const { h } = handler({ pdf: THIN_PAGE_PDF });
    const result = await h(ctx({ filePath: writeFile('mixed.pdf', '%PDF-fixture') }));
    expect(result.metadata).toMatchObject({ via: 'builtin-pdfjs', scannedPages: [2] });
    expect(result.output).toContain('第 2 页疑似扫描页');
  });

  it('builtin PDF kernel FAILURE → friendly corrupt-file output (never a throw)', async () => {
    const { h } = handler({});
    const failing = createParseDocumentHandler({
      loadConfig: () => UNCONFIGURED,
      extractPdf: async () => {
        throw new Error('Invalid PDF structure');
      },
      extractDocx: async () => '',
    });
    void h;
    const result = await failing(ctx({ filePath: writeFile('bad.pdf', 'garbage') }));
    expect(result.output).toContain('PDF 解析失败');
    expect(result.output).toContain('支持的格式');
  });
});

// ── DOCX (local-first) ──

describe('parse_document — docx local-first', () => {
  it('parses via builtin mammoth; endpoint NEVER tried even when configured', async () => {
    const { h, deps } = handler({ config: CONFIGURED_MINERU, probe: PROBE_OK, endpoint: { ok: true, markdown: 'endpoint result', via: 'endpoint-mineru' } });
    const result = await h(ctx({ filePath: writeFile('角色.docx', Buffer.from('docx-bytes')) }));

    expect(result.metadata).toMatchObject({ via: 'builtin-mammoth', kind: 'docx' });
    expect(result.output).toContain('角色卡正文（mammoth 提取）');
    expect(result.output).toContain(PARSE_VIA_LABELS['builtin-mammoth']);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.parseEndpoint).not.toHaveBeenCalled();
  });

  it('corrupt docx → friendly failure', async () => {
    const failing = createParseDocumentHandler({
      loadConfig: () => UNCONFIGURED,
      extractPdf: async () => TEXT_PDF,
      extractDocx: async () => {
        throw new Error('bad zip');
      },
    });
    const result = await failing(ctx({ filePath: writeFile('bad.docx', Buffer.from('garbage')) }));
    expect(result.output).toContain('DOCX 解析失败');
  });

  it('docx 空文本（trim 后无内容）→ parse-failed 拒（CR-014：不产空文本派生）', async () => {
    // 防 sha256('') 跨文件伪命中：两份不同的空文本文档哈希相同，会误复用彼此的
    // 描述/派生身份（09-01 inbox 附件 CR patch）。
    const empty = createParseDocumentHandler({
      loadConfig: () => UNCONFIGURED,
      extractPdf: async () => TEXT_PDF,
      extractDocx: async () => '  \n\t ',
    });
    const result = await empty(ctx({ filePath: writeFile('blank.docx', Buffer.from('docx-bytes')) }));
    expect(result.output).toContain('文档无可提取文本');
    expect(result.metadata).toMatchObject({ error: '文档无可提取文本', kind: 'docx' });
  });
});

// ── Capping ──

describe('parse_document — capping', () => {
  it('caps at maxChars with the truncation tail', async () => {
    const { h } = handler({});
    const long = 'x'.repeat(1_000);
    const result = await h(ctx({ filePath: writeFile('long.txt', long), maxChars: 100 }));
    expect(result.metadata).toMatchObject({ truncated: true, chars: expect.any(Number) });
    expect(result.output).toContain('已截断');
    expect(result.output).toContain('仅保留前 100]');
  });
});

// ── Failure paths ──

describe('parse_document — failure paths', () => {
  it('missing/blank filePath → friendly invalid-params (never a throw)', async () => {
    const { h } = handler();
    expect((await h(ctx({}))).output).toContain('参数无效');
    expect((await h(ctx({ filePath: '  ' }))).output).toContain('参数无效');
  });

  it('missing file → friendly', async () => {
    const { h } = handler();
    const result = await h(ctx({ filePath: 'nope.pdf' }));
    expect(result.output).toContain('文件不存在');
  });

  it('unsupported extension → friendly with the supported list', async () => {
    const { h } = handler();
    const result = await h(ctx({ filePath: writeFile('sheet.xlsx', Buffer.from('xlsx')) }));
    expect(result.output).toContain('不支持的文档格式');
    expect(result.output).toContain('PDF / DOCX / TXT / MD / EPUB');
  });

  it('corrupt epub → structured parse-failed degrade（Story 10.1 Wave B：epub 已支持，坏档不冒充成功）', async () => {
    const { h } = handler();
    const result = await h(ctx({ filePath: writeFile('bad.epub', Buffer.from('not a zip')) }));
    expect(result.output).toContain('EPUB 解析失败');
    expect(result.output).toContain('已损坏或加密');
  });

  it('path escape THROWS (mirror imageHandlers pattern B — not a graceful case)', async () => {
    const { h } = handler();
    await expect(h(ctx({ filePath: '../outside.pdf' }))).rejects.toThrow(/escapes project directory/);
    await expect(h(ctx({ filePath: path.resolve(os.tmpdir(), 'evil.pdf') }))).rejects.toThrow(
      /escapes project directory/,
    );
  });
});

// ── REAL kernel pass (handler + real pdfjs on a hand-built PDF) ──

describe('parse_document — real pdfjs integration pass', () => {
  // Real-kernel tests get a raised timeout: the first call pays pdfjs module +
  // worker init, which exceeds the 5s default under turbo's parallel package
  // load (flaked as a pre-existing timeout under `pnpm test` on loaded machines;
  // passes in isolation). 30s leaves ample headroom without masking a hang.
  it('unconfigured pdf → real text layer extracted end to end', async () => {
    const text = 'Hello Closure research page with enough body text to clear the scan threshold';
    const { h } = handler({ config: UNCONFIGURED, realPdf: true });
    const file = writeFile('real.pdf', buildPdfFixture([text]));
    const result = await h(ctx({ filePath: file }));

    expect(result.metadata).toMatchObject({ via: 'builtin-pdfjs', kind: 'pdf', pages: 1, truncated: false });
    expect(result.output).toContain('Hello Closure');
  }, 30_000);

  it('real scanned fixture → vision-path hint end to end', async () => {
    const { h } = handler({ config: UNCONFIGURED, realPdf: true });
    const file = writeFile('real-scan.pdf', buildPdfFixture(['']));
    const result = await h(ctx({ filePath: file }));

    expect(result.metadata).toMatchObject({ scanned: true, pages: 1 });
    expect(result.output).toContain('疑似扫描件');
    expect(result.output).toContain('analyze_image');
  }, 30_000);
});

// ── Default export sanity ──

describe('parseDocumentHandler default export', () => {
  it('is a function (registered by toolExecution as parse_document)', async () => {
    expect(typeof parseDocumentHandler).toBe('function');
  });
});

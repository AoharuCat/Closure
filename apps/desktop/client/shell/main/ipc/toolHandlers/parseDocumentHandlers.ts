/**
 * parse_document tool handler (Story 3.6 WP6, R10 / design D11).
 *
 * `parse_document {filePath, maxChars?}` — parse an in-project document to
 * Markdown, endpoint-first with builtin fallback:
 *
 *   - PDF  : configured docParser endpoint (sidecar + /health probe ok) is
 *     tried FIRST (MinerU/docling OCR+layout quality, design D11); endpoint
 *     failure/unconfigured/dead-probe degrades to the builtin pdfjs text
 *     layer with the failure recorded as a note. A scanned verdict (avg
 *     <50 chars/page) returns the vision-path hint (analyze_image or
 *     configure an endpoint) instead of near-empty text.
 *   - DOCX : ALWAYS local mammoth (extractDocxText) — mammoth's raw-text
 *     quality is sufficient for research use and the parse is free/offline;
 *     the endpoint tier is reserved for PDF where OCR/layout actually matter
 *     (deliberate local-first call, NOT an oversight).
 *   - txt/md : direct utf-8 read.
 *   - EPUB : builtin jszip extraction (Story 10.1 Wave B, via='builtin-epub') —
 *     pure local, never the endpoint tier. Corrupt/encrypted → structured
 *     parse-failed; image-heavy epub degrades honestly (ok:true + scanned flag
 *     + note) per prd R1「扫描图 epub 诚实降级标注」.
 *
 * Path safety (mirror imageHandlers): `filePath` is project-RELATIVE; the
 * resolved path must stay inside projectDir (`assertWithinProject` throws on
 * escape — pattern B, an LLM probing ../../etc/passwd is an invariant
 * violation, not a graceful-degrade case). Everything ELSE never throws
 * (R8): missing file, unsupported kind, corrupt parse, dead endpoint all
 * degrade to friendly outputs.
 *
 * Reached via the unified toolExecution channel (agent-side remoteToolProxy
 * registration in agent/src/tool/builtin.ts — id `parse_document`). All
 * network/FS lives here in the shell (agent 纯编排零网络,
 * spec/agent/agent-tools.md injection boundary). classifyTool defaults to
 * 'read' (readonly/suggest/auto).
 *
 * Params are hand-coerced — no zod in this package (mirror wikiHandlers /
 * fetchHandlers coerce helpers); the agent-side tool definition carries the
 * zod surface the LLM sees.
 *
 * Testability: `createParseDocumentHandler` accepts injectable config loader
 * / probe / endpoint parser / pdf+docx extractors — unit tests run with ZERO
 * network (the real pdfjs/mammoth kernels are covered separately in
 * docParsing.test.ts with real fixture buffers).
 *
 * ── A 波 09-01（task 09-01-agent-chat-attachments design §1.2/§1.2c）──
 *
 * 解析管线抽成共享内核 {@link parseDocumentToMarkdown}（tool handler 与 inbox
 * 附件 IPC 双消费；内核保持与 tool 响应无耦合的纯函数形态——Epic 10.1 摄取
 * 基座是同一内核的第二个未来消费者，L5）。同文件收三个 inbox 附件 IPC
 * （`project:parse-inbox-doc` / `project:resolve-inbox-attachment` /
 * `project:store-attachment-description`），描述哈希身份缓存落
 * `.orison/attachment-meta.json`（main/research/attachmentMeta.ts）。
 */
import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DocParserConfig } from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { assertSafePath, assertWithinProject } from '../pathGuard';
import { notifyUI } from '../toolNotify';
import { getLogger } from '../../logger';
import {
  NON_UTF8_SUSPECT_RATIO,
  SCANNED_PAGE_CHAR_THRESHOLD,
  classifyDocumentKind,
  decodeTextDocument,
  extractDocxText,
  extractEpubText,
  extractPdfTextLayer,
  utf8ReplacementCharRatio,
  type DocumentKind,
  type EpubTextExtraction,
  type PdfTextExtraction,
} from '../../research/docParsing';
import { parseViaEndpoint, type EndpointParseResult } from '../../research/docParserAdapters';
import { probeDocParser, readDocParserConfig, type DocParserProbeResult } from '../../research/docParserConfig';
import {
  ATTACHMENT_SAMPLE_MAX_CHARS,
  findExactEntry,
  findSimilarEntry,
  loadAttachmentMeta,
  saveAttachmentMeta,
  withAttachmentMetaLock,
} from '../../research/attachmentMeta';
import { capFetchedText } from './fetchHandlers';
import type { ToolHandler, ToolExecuteResponse } from './types';

// ── Constants ──

export const PARSE_DOC_DEFAULT_MAX_CHARS = 32_000;
export const PARSE_DOC_MAX_CHARS_LIMIT = 64_000;
/**
 * PDF size ceiling (P4, CR 2026-08-15): a >100MB PDF read into the main
 * process (then multipart-copied for the endpoint, or text-layer-paged by
 * pdfjs) is a friendly-reject — the user should split it or point the
 * docParser endpoint at it directly.
 */
export const PARSE_PDF_MAX_BYTES = 100 * 1024 * 1024;

/** Machine-readable provenance labels (design D11 + dispatch 6.4 + Story 10.1 Wave B). */
export type ParseDocVia =
  | 'endpoint-mineru'
  | 'endpoint-docling'
  | 'endpoint-custom'
  | 'builtin-pdfjs'
  | 'builtin-mammoth'
  | 'builtin-epub'
  | 'direct-read';

export const PARSE_VIA_LABELS: Record<ParseDocVia, string> = {
  'endpoint-mineru': '端点 MinerU',
  'endpoint-docling': '端点 docling',
  'endpoint-custom': '端点 custom',
  'builtin-pdfjs': '内置 PDF 文本层',
  'builtin-mammoth': '内置 mammoth',
  'builtin-epub': '内置 EPUB 解包',
  'direct-read': '直读',
};

/** Mime defaults per kind (only used for the endpoint multipart upload). */
const PDF_MIME = 'application/pdf';

// ── Param coercion (no zod in this package — mirror wikiHandlers) ──

export function coerceParseDocParams(params: Record<string, unknown>): { filePath?: string; maxChars?: number } {
  const filePath = typeof params.filePath === 'string' && params.filePath.trim() ? params.filePath.trim() : undefined;
  let maxChars: number | undefined;
  if (typeof params.maxChars === 'number' && Number.isFinite(params.maxChars)) {
    maxChars = Math.min(Math.max(Math.round(params.maxChars), 1), PARSE_DOC_MAX_CHARS_LIMIT);
  }
  return { filePath, maxChars };
}

// ── Output builders (never a throw) ──

function buildSuccess(args: {
  filePath: string;
  via: ParseDocVia;
  content: string;
  maxChars: number;
  kind: DocumentKind;
  pages?: number;
  scannedPages?: number[];
  notes?: string[];
}): ToolExecuteResponse {
  const { text, truncated } = capFetchedText(args.content, args.maxChars);
  const lines = [text, '', '---', `来源: ${args.filePath}（解析: ${PARSE_VIA_LABELS[args.via]}）`];
  if (args.pages !== undefined) lines.push(`页数: ${args.pages}`);
  for (const note of args.notes ?? []) lines.push(`备注: ${note}`);
  return {
    title: `parse_document: ${args.filePath.slice(0, 40)}`,
    output: lines.join('\n'),
    metadata: {
      via: args.via,
      kind: args.kind,
      chars: text.length,
      truncated,
      pages: args.pages,
      scannedPages: args.scannedPages,
    },
  };
}

function buildScannedOutput(args: {
  filePath: string;
  pages: number;
  scannedPages: number[];
  avgCharsPerPage: number;
  notes: string[];
}): ToolExecuteResponse {
  const lines = [
    `该 PDF 疑似扫描件（共 ${args.pages} 页，文本层平均 ${Math.round(args.avgCharsPerPage)} 字符/页，低于 ${SCANNED_PAGE_CHAR_THRESHOLD} 的判定阈值）——内置文本层提取拿不到可用内容，未返回正文。`,
    '建议二选一：',
    '- 在设置「研究与视觉」配置文档解析端点（MinerU / docling，带 OCR 能力）后重试 parse_document；',
    '- 将 PDF 页面截图保存到项目内，用 analyze_image 逐页视觉识别（视觉模型未配置时会返回手动分析导出协议）。',
  ];
  for (const note of args.notes) lines.push(`备注: ${note}`);
  return {
    title: `parse_document: ${args.filePath.slice(0, 40)}`,
    output: lines.join('\n'),
    metadata: {
      via: 'builtin-pdfjs',
      kind: 'pdf',
      scanned: true,
      pages: args.pages,
      scannedPages: args.scannedPages,
      avgCharsPerPage: Math.round(args.avgCharsPerPage),
    },
  };
}

function buildFailureOutput(filePath: string, message: string, extra?: Record<string, unknown>): ToolExecuteResponse {
  return {
    title: `parse_document: ${filePath.slice(0, 40)}`,
    output: `${message}\n支持的格式：PDF / DOCX / TXT / MD / EPUB。请确认文件路径正确且文件未损坏。`,
    metadata: { error: message, ...extra },
  };
}

// ── Shared parse core (A2 内核抽取，design §1.2) ──

export interface ParseDocumentHandlerDeps {
  /** Endpoint config loader (default: sidecar readDocParserConfig, never throws). */
  loadConfig?: () => DocParserConfig;
  /** Endpoint health probe (default: probeDocParser). */
  probe?: (opts?: { force?: boolean; signal?: AbortSignal }) => Promise<DocParserProbeResult>;
  /** Endpoint parser (default: parseViaEndpoint; tests inject stubs). */
  parseEndpoint?: typeof parseViaEndpoint;
  /** PDF text-layer kernel (default: extractPdfTextLayer). */
  extractPdf?: typeof extractPdfTextLayer;
  /** DOCX kernel (default: extractDocxText). */
  extractDocx?: typeof extractDocxText;
  /** EPUB kernel (default: extractEpubText; Story 10.1 Wave B). */
  extractEpub?: typeof extractEpubText;
}

/**
 * 共享解析内核的结构化产出——`parse_document` tool handler（映射成带截断与
 * 来源行的 ToolExecuteResponse）与 inbox 附件 IPC（派生 .md / preview / 哈希
 * 身份）双消费。**纯函数形态，与 tool 响应零耦合**（Epic 10.1 摄取基座复用
 * 预期，L5）：content 为**全量**解析文本，截断策略由调用方各自决定。
 */
export type ParseDocumentResult =
  | {
      ok: true;
      content: string;
      via: ParseDocVia;
      kind: DocumentKind;
      pages?: number;
      scannedPages?: number[];
      notes: string[];
      /** text kind only：U+FFFD 替换率超阈（转换提示已在 notes 里，机器位供附件 preview 抑制）。 */
      nonUtf8?: true;
      /** epub only（Story 10.1 Wave B）：扫描图 epub 降级标注——文本可提取但严重缺失，诚实返回非拒收。 */
      scanned?: true;
    }
  | {
      ok: false;
      reason: 'missing' | 'empty' | 'unsupported' | 'too-large-pdf' | 'read-failed' | 'parse-failed';
      /** 人话错误首行（与 tool 路径历史输出逐字一致）。 */
      error: string;
      kind?: DocumentKind;
      bytes?: number;
    }
  | {
      ok: false;
      reason: 'scanned';
      /** 扫描件判定首行（IPC 侧续接指引文案；tool 侧由 buildScannedOutput 重建完整提示）。 */
      error: string;
      pages: number;
      scannedPages: number[];
      avgCharsPerPage: number;
      notes: string[];
    };

/**
 * Parse an in-project document to Markdown text (endpoint-first PDF → local
 * mammoth docx → utf-8 text). Path safety: `filePath` is project-relative;
 * escape throws (`assertWithinProject`, pattern B). Everything else degrades
 * to a structured `{ok:false}` result — never throws (R8).
 */
export async function parseDocumentToMarkdown(
  projectDir: string,
  filePath: string,
  deps: ParseDocumentHandlerDeps = {},
  opts: { abort?: AbortSignal } = {},
): Promise<ParseDocumentResult> {
  const loadConfig = deps.loadConfig ?? readDocParserConfig;
  const probe = deps.probe ?? ((o?: { force?: boolean; signal?: AbortSignal }) => probeDocParser(o));
  const parseEndpoint = deps.parseEndpoint ?? parseViaEndpoint;
  const extractPdf = deps.extractPdf ?? extractPdfTextLayer;
  const extractDocx = deps.extractDocx ?? extractDocxText;
  const extractEpub = deps.extractEpub ?? extractEpubText;

  // PDF branch: endpoint-first (configured + probed healthy), builtin fallback
  // with the failure recorded, scanned verdict → structured scanned result.
  async function parsePdfBranch(input: {
    filePath: string;
    fullPath: string;
    buffer: Buffer;
    abort?: AbortSignal;
  }): Promise<ParseDocumentResult> {
    const notes: string[] = [];

    // 1) Endpoint tier — only for PDF, only when configured AND healthy.
    let config: DocParserConfig = {};
    try {
      config = loadConfig();
    } catch {
      // Config read failure → unconfigured (builtin path).
    }
    if (config.type && config.baseUrl) {
      let probeResult: DocParserProbeResult;
      try {
        probeResult = await probe({ signal: input.abort });
      } catch (err) {
        probeResult = { ok: false, detail: errMsg(err) };
      }
      if (probeResult.ok) {
        let endpointResult: EndpointParseResult;
        try {
          // P4: the handler's already-read buffer rides along — the endpoint
          // adapter must not read the same PDF a second time.
          endpointResult = await parseEndpoint(config, input.fullPath, path.basename(input.filePath), PDF_MIME, {
            signal: input.abort,
            buffer: input.buffer,
          });
        } catch (err) {
          endpointResult = { ok: false, error: errMsg(err) };
        }
        if (endpointResult.ok) {
          return { ok: true, content: endpointResult.markdown, via: endpointResult.via, kind: 'pdf', notes };
        }
        notes.push(`解析端点失败（${endpointResult.error}），已降级内置 PDF 文本层提取`);
      } else {
        notes.push(`解析端点探活失败（${probeResult.detail ?? '未知原因'}），已降级内置 PDF 文本层提取`);
      }
    }

    // 2) Builtin tier — pdfjs text layer (+ scanned detection).
    let extraction: PdfTextExtraction;
    try {
      extraction = await extractPdf(input.buffer);
    } catch (err) {
      return {
        ok: false,
        reason: 'parse-failed',
        kind: 'pdf',
        error: `PDF 解析失败：${errMsg(err)}（文件可能已损坏或加密）`,
      };
    }

    if (extraction.kind === 'scanned') {
      return {
        ok: false,
        reason: 'scanned',
        pages: extraction.pages,
        scannedPages: extraction.scannedPages,
        avgCharsPerPage: extraction.avgCharsPerPage,
        notes,
        error: `该 PDF 疑似扫描件（共 ${extraction.pages} 页，文本层平均 ${Math.round(extraction.avgCharsPerPage)} 字符/页，低于 ${SCANNED_PAGE_CHAR_THRESHOLD} 的判定阈值）——内置文本层提取拿不到可用内容。`,
      };
    }
    if (extraction.scannedPages.length > 0) {
      notes.push(`第 ${extraction.scannedPages.join('、')} 页疑似扫描页（无文本层），这些页内容可能缺失。`);
    }
    return {
      ok: true,
      content: extraction.text,
      via: 'builtin-pdfjs',
      kind: 'pdf',
      pages: extraction.pages,
      scannedPages: extraction.scannedPages,
      notes,
    };
  }

  // Path safety: project-relative resolve + containment (throws on escape —
  // mirror imageHandlers; an escaped path is an invariant violation, not a
  // graceful-degrade case).
  const fullPath = path.resolve(projectDir, filePath);
  assertWithinProject(projectDir, fullPath);

  let fileSize: number;
  try {
    fileSize = (await stat(fullPath)).size;
  } catch {
    return { ok: false, reason: 'missing', error: `文件不存在或无法访问：${filePath}` };
  }
  if (fileSize === 0) {
    return { ok: false, reason: 'empty', error: `文件为空：${filePath}` };
  }

  const kind = classifyDocumentKind(filePath);
  if (kind === 'unsupported') {
    return {
      ok: false,
      reason: 'unsupported',
      kind,
      error: `不支持的文档格式：${path.extname(filePath) || '(无扩展名)'}`,
    };
  }
  // P4: >100MB PDFs are a friendly reject BEFORE reading a single byte.
  if (kind === 'pdf' && fileSize > PARSE_PDF_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large-pdf',
      kind,
      bytes: fileSize,
      error: `PDF 过大（${Math.round(fileSize / 1024 / 1024)}MB，超过 ${Math.round(PARSE_PDF_MAX_BYTES / 1024 / 1024)}MB 上限）。请拆分文档，或直接在 MinerU/docling 端点的界面中解析该文件。`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(fullPath);
  } catch (err) {
    return { ok: false, reason: 'read-failed', error: `读取文件失败：${errMsg(err)}` };
  }

  try {
    switch (kind) {
      case 'pdf':
        return await parsePdfBranch({ filePath, fullPath, buffer, abort: opts.abort });
      case 'docx':
        // Local-first BY DESIGN (module doc): mammoth quality is enough for
        // research text extraction and costs zero network — the endpoint
        // tier stays reserved for PDF (OCR/layout), so it is not tried here.
        try {
          const text = await extractDocx(buffer);
          // CR-014（09-01 CR patch）：docx 空文本守卫——trim 后无内容按 parse-failed
          // 拒。防「空派生 .md 的 sha256('') 跨文件伪命中」：两份不同的空文本文档
          // 哈希相同，会误复用彼此的描述/派生身份。PDF 空文本层已有 scanned 判定
          // （<50 字/页），不动。
          if (!text.trim()) {
            return { ok: false, reason: 'parse-failed', kind, error: '文档无可提取文本' };
          }
          return { ok: true, content: text, via: 'builtin-mammoth', kind, notes: [] };
        } catch (err) {
          return { ok: false, reason: 'parse-failed', kind, error: `DOCX 解析失败：${errMsg(err)}（文件可能已损坏）` };
        }
      case 'text': {
        // P20: heavy U+FFFD presence = the file is almost certainly not
        // utf-8 — decode still proceeds (best effort) but the note tells
        // the author to convert instead of trusting mojibake.
        const notes: string[] = [];
        const nonUtf8 = utf8ReplacementCharRatio(buffer) > NON_UTF8_SUSPECT_RATIO;
        if (nonUtf8) {
          notes.push('疑似非 UTF-8 编码（GBK/GB18030 等）——已按 UTF-8 解码，正文可能出现乱码；建议先转存为 UTF-8 后重新解析。');
        }
        return {
          ok: true,
          content: decodeTextDocument(buffer),
          via: 'direct-read',
          kind,
          notes,
          ...(nonUtf8 ? { nonUtf8: true as const } : {}),
        };
      }
      case 'epub': {
        // Story 10.1 Wave B（design §4.1）：恒本地 jszip（端点档保留给 PDF——epub 无 OCR 面）。
        // 坏档/加密 → 结构化 parse-failed；扫描图 epub → ok + scanned 降级标注（诚实非拒收）；
        // 空文本守卫 mirror docx CR-014（防近空文本冒充成功 + sha256('') 跨文件伪命中）。
        let extraction: EpubTextExtraction;
        try {
          extraction = await extractEpub(buffer);
        } catch (err) {
          return { ok: false, reason: 'parse-failed', kind, error: `EPUB 解析失败：${errMsg(err)}（文件可能已损坏或加密）` };
        }
        if (!extraction.text.trim()) {
          return { ok: false, reason: 'parse-failed', kind, error: 'EPUB 无可提取文本' };
        }
        const notes = [...extraction.notes];
        if (extraction.kind === 'scanned') {
          notes.push(
            `EPUB 疑似扫描图版本（${extraction.documents} 个文档平均 ${Math.round(extraction.avgCharsPerDoc)} 字符/个，低于 ${SCANNED_PAGE_CHAR_THRESHOLD} 判定阈值）——正文以图片为主，文本内容可能严重缺失。`,
          );
        }
        return {
          ok: true,
          content: extraction.text,
          via: 'builtin-epub',
          kind,
          notes,
          ...(extraction.kind === 'scanned' ? { scanned: true as const } : {}),
        };
      }
      default:
        return { ok: false, reason: 'parse-failed', kind, error: `不支持的文档格式：${kind}` };
    }
  } catch (err) {
    // Belt-and-suspenders (R8): branch helpers never throw, but an
    // unforeseen failure must still degrade to a friendly result.
    getLogger().warn({ err: errMsg(err), filePath }, 'parse_document: unexpected failure');
    return { ok: false, reason: 'parse-failed', kind, error: `解析失败：${errMsg(err)}` };
  }
}

// ── Tool handler（共享内核的首个消费者；输出与 Story 3.6 逐字零漂移）──

export function createParseDocumentHandler(deps: ParseDocumentHandlerDeps = {}): ToolHandler {
  return async ({ params, projectDir, abort }) => {
    const coerced = coerceParseDocParams(params);
    if (!coerced.filePath) {
      return {
        title: 'parse_document',
        output: '参数无效，请提供要解析的文档路径（filePath 字符串，项目内相对路径，如 research/设定集.pdf）。',
        metadata: { error: 'invalid-params' },
      };
    }
    const filePath = coerced.filePath;
    const maxChars = coerced.maxChars ?? PARSE_DOC_DEFAULT_MAX_CHARS;

    const result = await parseDocumentToMarkdown(projectDir, filePath, deps, { abort });
    if (result.ok) {
      return buildSuccess({
        filePath,
        via: result.via,
        content: result.content,
        maxChars,
        kind: result.kind,
        pages: result.pages,
        scannedPages: result.scannedPages,
        notes: result.notes,
      });
    }
    if (result.reason === 'scanned') {
      return buildScannedOutput({
        filePath,
        pages: result.pages,
        scannedPages: result.scannedPages,
        avgCharsPerPage: result.avgCharsPerPage,
        notes: result.notes,
      });
    }
    const extra: Record<string, unknown> | undefined =
      result.kind !== undefined || result.bytes !== undefined
        ? {
            ...(result.kind !== undefined ? { kind: result.kind } : {}),
            ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
          }
        : undefined;
    return buildFailureOutput(filePath, result.error, extra);
  };
}

// Default handler wired into toolExecution (id aligns with the agent-side
// remoteToolProxy registration in agent/src/tool/builtin.ts).
export const parseDocumentHandler: ToolHandler = createParseDocumentHandler();

// ═══════════════════════════════════════════════════════════════════
// A 波 09-01：inbox 附件 IPC（design §1.2 预解析 + §1.2c 哈希身份）
// ═══════════════════════════════════════════════════════════════════

/** 附件 preview 截取长度（单行化后开头 ~200 字，R1.2b）。 */
export const INBOX_PREVIEW_MAX_CHARS = 200;

// ── IPC 载荷契约（canonical 类型源 = shared-contracts `ipc.ts`；本段为 shell 侧
//    手动 keep-in-sync 镜像，preload/index.ts 直接 import canonical 类型（无本地镜像））──

export interface ParseInboxDocInput {
  projectPath: string;
  /** inbox/ 内项目相对路径（docx/pdf 预解析派生 .md；txt/md preview-only）。 */
  filePath: string;
}

export type ParseInboxDocResult =
  | { ok: true; markdownPath: string; preview: string; via: ParseDocVia; notes: string[] }
  | { ok: false; error: string; kind?: 'scanned' };

export interface ResolveInboxAttachmentInput {
  projectPath: string;
  filePath: string;
}

export interface ResolveInboxAttachmentOk {
  ok: true;
  /** `sha256:<hex>`——内容身份（派生 .md 优先，txt/md 原件）。 */
  contentHash: string;
  /** 原件 mtime（epoch ms）——附件携带 fileMtime 供 staleness 判定。 */
  mtime: number;
  preview: string;
  /** 命中缓存的描述；fresh 未生成时缺省。 */
  description?: string;
  /** 描述生成时间（epoch ms）＝sidecar 条目 generatedAt。 */
  describedAt?: number;
  /** 附件指针指向的材料路径（docx/pdf = 派生 .md；txt/md = 原件）。 */
  derivedPath: string;
  reused: 'exact' | 'similar' | false;
  /** 解析备注透传（CR-010）：非 UTF-8 转换提示等；无备注时省略。 */
  notes?: string[];
}

export type ResolveInboxAttachmentResult = ResolveInboxAttachmentOk | { ok: false; error: string; kind?: 'scanned' };

export interface StoreAttachmentDescriptionInput {
  projectPath: string;
  filePath: string;
  /** LLM 生成的一句话定性（UI 侧生成完毕后回写落缓存）。 */
  description: string;
  /** 描述生成时所见 mtime（= resolve 返回的 mtime）——TOCTOU 守卫（CR-013）；
   *  缺省 = 守卫不启用。 */
  capturedMtime?: number;
}

export type StoreAttachmentDescriptionResult = { ok: true; contentHash: string } | { ok: false; error: string };

export interface InboxAttachmentIpcHandlers {
  parseInboxDoc: (input: ParseInboxDocInput) => Promise<ParseInboxDocResult>;
  resolveInboxAttachment: (input: ResolveInboxAttachmentInput) => Promise<ResolveInboxAttachmentResult>;
  storeAttachmentDescription: (input: StoreAttachmentDescriptionInput) => Promise<StoreAttachmentDescriptionResult>;
}

export interface InboxAttachmentIpcDeps extends ParseDocumentHandlerDeps {
  /** 时钟注入（generatedAt 可测）。 */
  now?: () => number;
  /** file:changed 通知注入（默认 notifyUI；测试用 spy）。 */
  notify?: (event: { type: 'file:changed'; projectPath: string; path: string }) => void;
}

// ── 内部 helper ──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha256Content(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/** 项目相对路径统一 posix 斜杠（IPC 出参/事件路径形态）。 */
function toRelPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** preview：内容开头 ~200 字单行化；非 UTF-8 高替率时抑制（''——不喂乱码，提示走 notes）。 */
function buildPreview(content: string, nonUtf8: boolean): string {
  if (nonUtf8) return '';
  return content.replace(/\s+/g, ' ').trim().slice(0, INBOX_PREVIEW_MAX_CHARS);
}

/** 附件材料（resolve / store / parse 三 IPC 的共同中间态）。 */
type InboxMaterial =
  | {
      ok: true;
      kind: 'pdf' | 'docx' | 'text';
      via: ParseDocVia | undefined;
      content: string;
      preview: string;
      notes: string[];
      mtimeMs: number;
      /** 附件指针指向的材料路径（docx/pdf = 派生 .md；txt/md = 原件）。 */
      pointerRelPath: string;
      originalRelPath: string;
      derivedOf: string | null;
    }
  | { ok: false; error: string; kind?: 'scanned' };

/** 把内核结果映射成 IPC 失败形态（scanned 续接 UI 指引文案）。 */
function mapCoreFailure(result: Extract<ParseDocumentResult, { ok: false }>): { ok: false; error: string; kind?: 'scanned' } {
  if (result.reason === 'scanned') {
    return {
      ok: false,
      kind: 'scanned',
      error:
        `${result.error}建议在设置「研究与视觉」配置文档解析端点（MinerU / docling，带 OCR 能力），` +
        '或将 PDF 页面截图交给识图模型识别；原件已保留在项目中。',
    };
  }
  return { ok: false, error: result.error };
}

/**
 * 派生附件材料：txt/md = preview-only 直读原件（不写派生 .md）；docx/pdf =
 * 解析全量文本写 `inbox 旁同名 .md`（atomicWrite）+ 写盘后 notifyUI
 * `file:changed`（复查 M4——树确定性刷新，不依赖平台 watcher 差异）。
 * 派生目标已存在时先过 CR-005 覆盖守卫（溯源在案 + 内容回声，见写盘段注释）。
 *
 * `reparseStaleOnly`：resolve/store 走「派生件新鲜即读盘」（原件 mtime ≤ 派生
 * .md mtime 时不重解析，纯代码廉价路径）；parse-inbox-doc 传 false（上传进件
 * 即时解析，总是走内核 + 写盘）。
 */
async function deriveInboxMaterial(
  projectDir: string,
  filePath: string,
  deps: ParseDocumentHandlerDeps,
  opts: { reparseStaleOnly: boolean; notify: (event: { type: 'file:changed'; projectPath: string; path: string }) => void },
): Promise<InboxMaterial> {
  const kind = classifyDocumentKind(filePath);
  if (kind === 'unsupported') {
    return { ok: false, error: `不支持的附件格式：${path.extname(filePath) || '(无扩展名)'}（支持 TXT / MD / DOCX / PDF）` };
  }
  if (kind === 'epub') {
    // Story 10.1 Wave B：解析内核已支持 epub，但 inbox 附件白名单维持 09-01 契约
    // （txt/md/docx/pdf）——epub 的消费面是材料管线（materials/ 车道），不在对话框附件。
    return { ok: false, error: '不支持的附件格式：.epub（支持 TXT / MD / DOCX / PDF；EPUB 请放入 materials/ 材料目录）' };
  }

  const fullPath = path.resolve(projectDir, filePath);
  assertWithinProject(projectDir, fullPath);

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(fullPath)).mtimeMs;
  } catch {
    return { ok: false, error: `文件不存在或无法访问：${filePath}` };
  }

  const originalRel = toRelPosix(filePath);

  if (kind === 'text') {
    // preview-only：直挂原件指针，不写派生 .md、不发事件。
    const result = await parseDocumentToMarkdown(projectDir, filePath, deps);
    if (!result.ok) return mapCoreFailure(result);
    return {
      ok: true,
      kind,
      via: result.via,
      content: result.content,
      preview: buildPreview(result.content, result.nonUtf8 === true),
      notes: result.notes,
      mtimeMs,
      pointerRelPath: originalRel,
      originalRelPath: originalRel,
      derivedOf: null,
    };
  }

  // pdf/docx：派生 .md = 同目录同名（去扩展名 + .md）。
  const ext = path.extname(filePath);
  const derivedRel = toRelPosix(filePath.slice(0, filePath.length - ext.length) + '.md');
  const derivedFull = path.resolve(projectDir, derivedRel);
  assertWithinProject(projectDir, derivedFull);

  if (opts.reparseStaleOnly && existsSync(derivedFull)) {
    let derivedMtimeMs: number | undefined;
    try {
      derivedMtimeMs = (await stat(derivedFull)).mtimeMs;
    } catch {
      derivedMtimeMs = undefined;
    }
    if (derivedMtimeMs !== undefined && mtimeMs <= derivedMtimeMs) {
      // 派生件新鲜：直接读盘（原件未动过，零解析成本；via 不再可知——resolve
      // 契约不含 via，只有总是走内核的 parse-inbox-doc 会回填它）。
      try {
        const content = await readFile(derivedFull, 'utf-8');
        return {
          ok: true,
          kind,
          via: undefined,
          content,
          preview: buildPreview(content, false),
          notes: [],
          mtimeMs,
          pointerRelPath: derivedRel,
          originalRelPath: originalRel,
          derivedOf: originalRel,
        };
      } catch {
        // 读盘失败（罕见）→ 落到重解析路径重建派生件。
      }
    }
  }

  const result = await parseDocumentToMarkdown(projectDir, filePath, deps);
  if (!result.ok) return mapCoreFailure(result);

  // CR-005（09-01 CR patch）：派生目标已存在 → 仅「可验证为本管线自本原件派生」才
  // 允许覆盖（防 renderer 借三 IPC 覆盖用户既有 .md）。两因子验证：① sidecar 有
  // derivedOf === originalRel 的条目（溯源在案）；② 该条目 contentHash 与盘上现有
  // 内容一致（内容回声——落盘后未被手改）。缺一即视为非自派生拒写。唯一豁免：现有
  // 内容与新解析逐字一致（覆盖为 no-op，无数据可损，直接复用不写盘不发事件）。
  if (existsSync(derivedFull)) {
    const existing = await readFile(derivedFull, 'utf-8').catch(() => null);
    if (existing === result.content) {
      return {
        ok: true,
        kind,
        via: result.via,
        content: result.content,
        preview: buildPreview(result.content, false),
        notes: result.notes,
        mtimeMs,
        pointerRelPath: derivedRel,
        originalRelPath: originalRel,
        derivedOf: originalRel,
      };
    }
    const provenance = loadAttachmentMeta(projectDir).entries.find((e) => e.derivedOf === originalRel);
    const verified =
      existing !== null && provenance !== undefined && provenance.contentHash === sha256Content(existing);
    if (!verified) {
      return {
        ok: false,
        error:
          `派生文件 ${derivedRel} 已存在，且无法确认它是本附件的解析产物` +
          '（描述缓存无该原件的派生记录，或该文件内容已被手动修改）。为防止覆盖已有文件已拒绝写入——' +
          '请先在文件树中删除或重命名该 .md 后重试。',
      };
    }
  }
  atomicWriteFileSync(derivedFull, result.content, 'utf-8');
  opts.notify({ type: 'file:changed', projectPath: projectDir, path: `/${derivedRel}` });
  return {
    ok: true,
    kind,
    via: result.via,
    content: result.content,
    preview: buildPreview(result.content, false),
    notes: result.notes,
    mtimeMs,
    pointerRelPath: derivedRel,
    originalRelPath: originalRel,
    derivedOf: originalRel,
  };
}

function coerceInboxInput(input: unknown): {
  projectPath?: string;
  filePath?: string;
  description?: string;
  capturedMtime?: number;
} {
  if (input === null || typeof input !== 'object') return {};
  const { projectPath, filePath, description, capturedMtime } = input as {
    projectPath?: unknown;
    filePath?: unknown;
    description?: unknown;
    capturedMtime?: unknown;
  };
  return {
    projectPath: typeof projectPath === 'string' && projectPath.trim() ? projectPath.trim() : undefined,
    filePath: typeof filePath === 'string' && filePath.trim() ? filePath.trim() : undefined,
    description: typeof description === 'string' ? description.trim() : undefined,
    capturedMtime:
      typeof capturedMtime === 'number' && Number.isFinite(capturedMtime) ? capturedMtime : undefined,
  };
}

/** inbox 前缀拒收统一错误（CR-005）。 */
const INBOX_ONLY_ERROR = '仅支持 inbox/ 内文件（filePath 需为 inbox/ 下的项目相对路径）。';

/**
 * inbox/ 前缀守卫（CR-005，09-01 CR patch）：剥前导斜杠、反斜杠归一后必须落在
 * inbox/ 内。词法归一（posix.normalize）后 `inbox/../x` 一类「带前缀的逃逸」不再
 * 以 inbox/ 开头——同样拒；renderer 传错路径是预期失败（模式 A：ok:false）而非
 * invariant 违反，挡在 assertWithinProject 之前（后者对 IPC 入口退居 belt）。返回
 * 归一后的 posix 相对路径；非 inbox 内返回 null。
 */
function normalizeInboxFilePath(filePath: string): string | null {
  const rel = filePath.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (!rel.startsWith('inbox/')) return null;
  const normalized = path.posix.normalize(rel);
  if (!normalized.startsWith('inbox/') || normalized === 'inbox/') return null;
  return normalized;
}

// ── IPC 工厂（deps 注入，零网络可测）──

export function createInboxAttachmentIpc(deps: InboxAttachmentIpcDeps = {}): InboxAttachmentIpcHandlers {
  const now = deps.now ?? (() => Date.now());
  const notify = deps.notify ?? ((event: { type: 'file:changed'; projectPath: string; path: string }) => notifyUI(event));

  return {
    /**
     * `project:parse-inbox-doc`——上传进件即预解析（design D-B eager）：docx/pdf
     * 解析出派生 .md 落盘 + file:changed；txt/md preview-only。maxChars 不截断
     * （落盘材料非上下文，read_file 侧自有限额；端点 8MB 响应闸仍兜）。
     * filePath 强制 inbox/ 前缀（CR-005——renderer 传错路径是预期失败，ok:false）。
     */
    async parseInboxDoc(rawInput: ParseInboxDocInput): Promise<ParseInboxDocResult> {
      const input = coerceInboxInput(rawInput);
      if (!input.projectPath || !input.filePath) {
        return { ok: false, error: '参数无效：需要 projectPath 与 filePath（inbox 内项目相对路径）。' };
      }
      assertSafePath(input.projectPath);
      const inboxPath = normalizeInboxFilePath(input.filePath);
      if (!inboxPath) return { ok: false, error: INBOX_ONLY_ERROR };
      const material = await deriveInboxMaterial(input.projectPath, inboxPath, deps, {
        reparseStaleOnly: false,
        notify,
      });
      if (!material.ok) return material;
      return {
        ok: true,
        markdownPath: material.pointerRelPath,
        preview: material.preview,
        via: material.via ?? 'direct-read',
        notes: material.notes,
      };
    },

    /**
     * `project:resolve-inbox-attachment`——挂附件协议（design §1.2c）：
     * stat mtime → docx/pdf 原件晚于派生 .md 先重解析 → 内容哈希 →
     * 精确命中（复用描述，更新 lastSeenPath）→ shingle ≥80% 相似命中
     * （更新 hash/sample，**generatedAt 不动**）→ 双 miss 返 fresh
     * （description 缺省，UI 生成后经 store-attachment-description 回写）。
     *
     * CR patch（09-01）：filePath 强制 inbox/ 前缀（CR-005）；sidecar 读-改-写
     * 全程过锁（CR-008）；解析备注（非 UTF-8 转换提示等）透传 notes（CR-010）；
     * 既有条目 derivedOf 不被 null 盲覆（CR-017——溯源字段防系统性丢失）。
     */
    async resolveInboxAttachment(rawInput: ResolveInboxAttachmentInput): Promise<ResolveInboxAttachmentResult> {
      const input = coerceInboxInput(rawInput);
      if (!input.projectPath || !input.filePath) {
        return { ok: false, error: '参数无效：需要 projectPath 与 filePath（inbox 内项目相对路径）。' };
      }
      assertSafePath(input.projectPath);
      const inboxPath = normalizeInboxFilePath(input.filePath);
      if (!inboxPath) return { ok: false, error: INBOX_ONLY_ERROR };
      const projectPath = input.projectPath;
      const material = await deriveInboxMaterial(projectPath, inboxPath, deps, {
        reparseStaleOnly: true,
        notify,
      });
      if (!material.ok) return material;

      const contentHash = sha256Content(material.content);
      const sample = material.content.slice(0, ATTACHMENT_SAMPLE_MAX_CHARS);

      // CR-008：load→mutate→save 全程持锁（per-project 串行，防并发 last-write-wins
      // 丢条目——当前段内全同步，锁为结构保证）。
      const hit = await withAttachmentMetaLock(projectPath, () => {
        const meta = loadAttachmentMeta(projectPath);
        const exact = findExactEntry(meta.entries, contentHash);
        if (exact) {
          exact.lastSeenPath = material.originalRelPath;
          // CR-017：溯源字段只在「本附件确是 docx/pdf 原件」时刷新（改名重挂带新原件
          // 路径）；挂派生 .md / txt（derivedOf = null）不盲覆——防在案溯源被清空。
          if (material.derivedOf !== null) exact.derivedOf = material.derivedOf;
          saveAttachmentMeta(projectPath, meta);
          return { reused: 'exact' as const, description: exact.description, describedAt: exact.generatedAt };
        }
        const similar = findSimilarEntry(meta.entries, sample);
        if (similar) {
          // 相似命中：条目迁移到新内容身份（hash/sample/lastSeenPath），
          // generatedAt 保持原值——描述仍算「生成于原时间」（R1.2c）。
          similar.contentHash = contentHash;
          similar.sample = sample;
          similar.lastSeenPath = material.originalRelPath;
          if (material.derivedOf !== null) similar.derivedOf = material.derivedOf;
          saveAttachmentMeta(projectPath, meta);
          return { reused: 'similar' as const, description: similar.description, describedAt: similar.generatedAt };
        }
        return { reused: false as const };
      });

      return {
        ok: true,
        contentHash,
        mtime: material.mtimeMs,
        preview: material.preview,
        ...(hit.reused !== false && hit.description ? { description: hit.description } : {}),
        ...(hit.reused !== false && hit.describedAt ? { describedAt: hit.describedAt } : {}),
        derivedPath: material.pointerRelPath,
        reused: hit.reused,
        // CR-010：解析备注透传——preview 被编码检测抑制为空时，UI 靠它说明原因
        //（非 UTF-8 转换引导可达）；无备注省略。
        ...(material.notes.length > 0 ? { notes: material.notes } : {}),
      };
    },

    /**
     * `project:store-attachment-description`——fresh 描述生成完毕的回写面。
     * 哈希/sample 全部**现算**（不信任 renderer 传入的 hash——载荷不信任、
     * 盘上内容权威，mirror settingMd accept 重放纪律）；同 hash 条目存在则
     * 更新（描述重生成刷新 generatedAt），否则新建。
     *
     * CR patch（09-01）：filePath 强制 inbox/ 前缀（CR-005）；`capturedMtime`
     * TOCTOU 守卫——描述生成期间原件 mtime 前进则拒绝回写（CR-013，防过期描述
     * 挂到新内容哈希、staleness 判定恒假）；sidecar 读-改-写全程过锁（CR-008）；
     * 既有条目 derivedOf 不盲写（CR-017——溯源字段仅新条目落，防「挂派生 .md 回写」
     * 把在案原件溯源清空）。
     */
    async storeAttachmentDescription(rawInput: StoreAttachmentDescriptionInput): Promise<StoreAttachmentDescriptionResult> {
      const input = coerceInboxInput(rawInput);
      if (!input.projectPath || !input.filePath || !input.description) {
        return { ok: false, error: '参数无效：需要 projectPath、filePath 与非空 description。' };
      }
      assertSafePath(input.projectPath);
      const inboxPath = normalizeInboxFilePath(input.filePath);
      if (!inboxPath) return { ok: false, error: INBOX_ONLY_ERROR };
      const projectPath = input.projectPath;
      const description = input.description;
      const material = await deriveInboxMaterial(projectPath, inboxPath, deps, {
        reparseStaleOnly: true,
        notify,
      });
      if (!material.ok) return { ok: false, error: material.error };

      // CR-013：现盘 mtime 晚于描述生成时所见（capturedMtime = resolve 返回的
      // mtime）→ 描述已过时，拒绝回写。缺省 = 守卫不启用（additive）。
      if (input.capturedMtime !== undefined && material.mtimeMs > input.capturedMtime) {
        return { ok: false, error: '文件已变更，描述已过时' };
      }

      const contentHash = sha256Content(material.content);
      // CR-008：load→mutate→save 全程持锁。
      const saved = await withAttachmentMetaLock(projectPath, () => {
        const meta = loadAttachmentMeta(projectPath);
        const existing = findExactEntry(meta.entries, contentHash);
        if (existing) {
          // CR-017：同哈希更新 description/generatedAt/sample/lastSeenPath；
          // derivedOf **不盲写**（见上注）。
          existing.description = description;
          existing.generatedAt = now();
          existing.lastSeenPath = material.originalRelPath;
          existing.sample = material.content.slice(0, ATTACHMENT_SAMPLE_MAX_CHARS);
        } else {
          meta.entries.push({
            contentHash,
            lastSeenPath: material.originalRelPath,
            derivedOf: material.derivedOf,
            description,
            generatedAt: now(),
            sample: material.content.slice(0, ATTACHMENT_SAMPLE_MAX_CHARS),
          });
        }
        return saveAttachmentMeta(projectPath, meta);
      });
      if (!saved) {
        return { ok: false, error: '附件描述缓存写入失败（缓存可再生，重新挂载附件时会重新生成描述）。' };
      }
      return { ok: true, contentHash };
    },
  };
}

/**
 * 注册三只 inbox 附件 IPC（registerAllIpc 恰调一次；同 channel 二次
 * ipcMain.handle 会抛错——spec/shell/ipc-handlers.md 注册纪律）。
 */
export function registerInboxAttachmentIpc(): void {
  const handlers = createInboxAttachmentIpc();
  ipcMain.handle('project:parse-inbox-doc', (_e, input: unknown) => handlers.parseInboxDoc(input as ParseInboxDocInput));
  ipcMain.handle(
    'project:resolve-inbox-attachment',
    (_e, input: unknown) => handlers.resolveInboxAttachment(input as ResolveInboxAttachmentInput),
  );
  ipcMain.handle(
    'project:store-attachment-description',
    (_e, input: unknown) => handlers.storeAttachmentDescription(input as StoreAttachmentDescriptionInput),
  );
}

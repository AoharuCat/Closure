/**
 * Builtin document-parsing fallback (Story 3.6 WP6, R10 / design D11).
 *
 * The NO-endpoint path of `parse_document` (and the degrade target when a
 * configured endpoint fails): pure local extraction with zero network —
 *
 *   - PDF  : pdfjs-dist LEGACY build text layer (`getTextContent()` per page,
 *     items joined in page order). Per-page non-whitespace char count under
 *     {@link SCANNED_PAGE_CHAR_THRESHOLD} marks an image-only page; a whole
 *     document averaging under the threshold is reported as `kind:'scanned'` —
 *     the handler then steers to the vision path (analyze_image) or to a
 *     configured MinerU/docling endpoint instead of returning near-empty text.
 *   - DOCX : mammoth `extractRawText` (already a shell dep, 1.9.0). docx is
 *     parsed LOCALLY even when an endpoint is configured — mammoth's raw-text
 *     quality is sufficient for research use and the parse is free/offline;
 *     the endpoint tier is reserved for PDF (where OCR/layout actually matter).
 *   - txt/md : direct utf-8 read (BOM stripped) — done inline by the handler.
 *   - EPUB : jszip + xhtml→text (Story 10.1 Wave B / prd R1-D4). Stored-zip
 *     walk: META-INF/container.xml → OPF spine order → block-level tags to
 *     paragraph breaks (`<br>` = inline single-\n line breaks, CR-004) + tag
 *     strip. Corrupt archive / DRM encryption manifest /
 *     missing container|OPF → typed throw (handler degrades to a structured
 *     parse-failed). An image-heavy epub (avg non-ws chars per spine text
 *     document under SCANNED_PAGE_CHAR_THRESHOLD) is honestly degraded: the
 *     extractable text is returned WITH a scanned verdict (quality signal),
 *     not rejected. ToC/nav chapter-boundary priors are a recorded follow-up
 *     (plan F-17) — spine order + the chapter-splitting regex covers V1.
 *
 * All functions are pure Node (no electron import) — table-testable under plain
 * vitest with fixture buffers. The HANDLER (parseDocumentHandlers.ts) owns the
 * never-throws contract (R8); these kernels throw typed errors on corrupt
 * input for the handler to catch and degrade.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse as parseHtml } from 'node-html-parser';

// ── Document-kind dispatch (pure, exported for tests) ──

export type DocumentKind = 'pdf' | 'docx' | 'text' | 'epub' | 'unsupported';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** EPUB mime（OPC 包；分类与端点无关——epub 恒走内置 jszip 路径，纯代码无网络）。 */
export const EPUB_MIME = 'application/epub+zip';

/**
 * Map a file name (+ optional declared mime) to the parse dispatch kind.
 * Extension wins over a lying/absent content type — for a local file the name
 * is the more reliable signal; the mime only fills in when known.
 */
export function classifyDocumentKind(fileName: string, mime?: string): DocumentKind {
  const ext = path.extname(fileName).toLowerCase();
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (ext === '.pdf' || m === 'application/pdf') return 'pdf';
  if (ext === '.docx' || m === DOCX_MIME) return 'docx';
  if (ext === '.txt' || ext === '.md' || ext === '.markdown' || m === 'text/plain' || m === 'text/markdown') {
    return 'text';
  }
  if (ext === '.epub' || m === EPUB_MIME) return 'epub';
  return 'unsupported';
}

/** Decode a txt/md buffer as utf-8, stripping a leading BOM if present. */
export function decodeTextDocument(buffer: Buffer): string {
  const text = buffer.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Replacement-char (U+FFFD) ratio among the utf-8-decoded characters (P20,
 * CR 2026-08-15): Node's utf-8 decoder substitutes every undecodable byte
 * sequence with U+FFFD, so a high ratio means the file is almost certainly
 * NOT utf-8 (GBK/GB18030 read as utf-8 = silent mojibake) — the handler adds
 * a conversion hint instead of handing the LLM garbage.
 */
export const NON_UTF8_SUSPECT_RATIO = 0.03;

export function utf8ReplacementCharRatio(buffer: Buffer): number {
  const text = buffer.toString('utf-8');
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count / text.length;
}

// ── Scanned-document detection (design D11) ──

/**
 * Per-page AND whole-document threshold: a page whose text layer carries fewer
 * non-whitespace characters than this is treated as image-only; a document
 * AVERAGING under it is a scanned PDF (no usable text layer at all).
 */
export const SCANNED_PAGE_CHAR_THRESHOLD = 50;

// ── PDF text layer (pdfjs-dist legacy build) ──

export interface PdfTextExtraction {
  kind: 'text' | 'scanned';
  pages: number;
  /** Page-order concatenated text layer (meaningful only for kind='text'). */
  text: string;
  /** Whole-document average of non-whitespace chars per page (scan verdict). */
  avgCharsPerPage: number;
  /** 1-based page numbers under the per-page threshold (image-only pages). */
  scannedPages: number[];
}

/**
 * Extract the PDF text layer page by page. Throws on a corrupt/undecodable PDF
 * or a zero-page document — the handler catches and degrades friendly (R8).
 * The pdfjs module is imported dynamically so it stays out of every consumer's
 * load path (only PDF parses pay the import cost).
 */
export async function extractPdfTextLayer(buffer: Buffer): Promise<PdfTextExtraction> {
  // Legacy build = the Node-compatible bundle (no DOM/canvas assumptions).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Standard-14 font data (Helvetica & co): pdf.js wants it for glyph
    // mapping on non-embedded fonts; without it extraction still works for
    // WinAnsi text but logs a warning — resolve the bundled dir when we can.
    standardFontDataUrl: resolveStandardFontDataUrl(),
  });
  try {
    const doc = await task.promise;
    if (doc.numPages <= 0) throw new Error('PDF 无可读页面');

    const perPage: string[] = [];
    const scannedPages: number[] = [];
    let totalChars = 0;
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        let pageText = '';
        for (const item of content.items) {
          if ('str' in item && typeof item.str === 'string') pageText += item.str;
          if ('hasEOL' in item && item.hasEOL) pageText += '\n';
        }
        perPage.push(pageText);
        const chars = pageText.replace(/\s+/g, '').length;
        totalChars += chars;
        if (chars < SCANNED_PAGE_CHAR_THRESHOLD) scannedPages.push(pageNum);
      } finally {
        page.cleanup();
      }
    }

    const avgCharsPerPage = totalChars / doc.numPages;
    return {
      kind: avgCharsPerPage < SCANNED_PAGE_CHAR_THRESHOLD ? 'scanned' : 'text',
      pages: doc.numPages,
      text: perPage.join('\n\n').trim(),
      avgCharsPerPage,
      scannedPages,
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/**
 * Locate pdfjs-dist's bundled `standard_fonts/` dir as a URL-ish string
 * (forward slashes + trailing slash — pdf.js validates exactly that shape).
 * Best-effort: any failure returns undefined and extraction continues with
 * pdf.js's built-in glyph fallbacks (verified: WinAnsi text extracts fine).
 */
function resolveStandardFontDataUrl(): string | undefined {
  try {
    let pkgPath: string | undefined;
    try {
      // vitest / ESM: import.meta.url is this module's file URL.
      pkgPath = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
    } catch {
      // electron-vite CJS bundle: __dirname points at dist/main (or the source
      // dir in dev); pdfjs-dist is externalized so it resolves from there.
      if (typeof __dirname === 'string') {
        pkgPath = createRequire(path.join(__dirname, 'main.cjs')).resolve('pdfjs-dist/package.json');
      }
    }
    if (!pkgPath) return undefined;
    const dir = path.join(path.dirname(pkgPath), 'standard_fonts');
    if (!existsSync(dir)) return undefined;
    return `${dir.split(path.sep).join('/')}/`;
  } catch {
    return undefined;
  }
}

// ── DOCX (mammoth, local-first — see module doc for the rationale) ──

/**
 * Extract raw text from a DOCX buffer via mammoth `extractRawText`. Dynamic
 * import + default interop mirrors projectMetaIpc.convertDocxToMarkdown
 * (mammoth is CJS; the shim survives both vitest ESM and the built bundle).
 * Throws on a corrupt docx — the handler degrades friendly.
 */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammothMod = await import('mammoth');
  const mammoth = (mammothMod as { default?: unknown }).default ?? mammothMod;
  const { value } = await (mammoth as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  }).extractRawText({ buffer });
  return value;
}

// ── EPUB (jszip + node-html-parser, Story 10.1 Wave B / design §4.1) ──

/** spine 文本文档（xhtml/html）之外的内容类型不计入扫描判定分母（图片/CSS/字体非正文文档）。 */
const EPUB_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/xhtml+xml', 'text/html']);

/**
 * spine 中**已知合法的非正文**内容类型（图片/字体/样式/导航/媒体——跳过属正常，不 note）。
 * 未知/缺 media-type 的 spine item 可能是被静默丢掉的章内容——必须 note（CR-022）。
 */
const EPUB_KNOWN_NON_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'text/css',
  'application/x-dtbncx+xml', // NCX 目录（EPUB2 nav）
  'application/oebps-page-map+xml',
  'application/smil+xml', // 媒体-overlay 朗读同步
  'application/vnd.ms-opentype',
  'application/font-woff',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-woff',
  'font/woff',
  'font/woff2',
]);
const EPUB_KNOWN_NON_TEXT_MEDIA_PREFIXES = ['image/', 'audio/', 'video/'];

/** 已知非正文（合法跳过）；未知/缺失返回 false（须 note，防章内容静默丢失）。 */
function isKnownNonTextMediaType(mediaType: string): boolean {
  return (
    EPUB_TEXT_MEDIA_TYPES.has(mediaType) ||
    EPUB_KNOWN_NON_TEXT_MEDIA_TYPES.has(mediaType) ||
    EPUB_KNOWN_NON_TEXT_MEDIA_PREFIXES.some((p) => mediaType.startsWith(p))
  );
}

/** 不产正文的元素（head 内 title 与 epub 内嵌脚本/样式全部跳过）。 */
const EPUB_SKIP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'head', 'title', 'svg', 'noscript', 'template',
]);

/**
 * 块级标签族：进入/离开各 flush 一行（块间以空行分隔——与 chunkChapter/splitChapters 的
 * 「段落 = 空行分块」基面一致，epub 材料 downstream 的段落号/分章正则吃到同构布局）。
 */
const EPUB_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'details', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul',
]);

/**
 * 防解压炸弹上限（Story 10.1 Wave B 防御面）：累计提取正文超过该字符量的 spine 文档不再
 * 读取，诚实 note「已截断」——50MB zip 可膨胀出数 GB 文本，主进程不可无界物化。
 */
export const EPUB_MAX_TEXT_CHARS = 20_000_000;

/**
 * UTF-8 每个 UTF-16 code unit 的最大字节数（CJK 3 字节/字；4 字节码点拆两个 unit = 2 字节/
 * unit）：声明解压字节 > cap×3 ⇒ 文本字符必然超 cap——CR-020 inflate 前预检的无假阳性阈值。
 */
const EPUB_UTF8_MAX_BYTES_PER_UNIT = 3;

/** node-html-parser 节点的最小结构面（避免依赖其内部类型导出形状）。 */
interface HtmlNodeLike {
  nodeType: number;
  tagName?: string;
  text?: string;
  childNodes: HtmlNodeLike[];
  getAttribute?(name: string): string | undefined;
}

/**
 * xhtml/html → 归一化文本：**块级标签**进出各段落边界（段间空行 \n\n——与 chunkChapter/
 * splitChapters 的「段落 = 空行分块」基面一致）；**`<br>` 是行内断行**（单 \n 收当前行——
 * 地址/诗句的密集折行属同一段，不额外段落化，CR-004）；行内文本空白折叠、实体已解码
 * （node-html-parser 的 `.text` 自带解码，实证）。注释节点不出现在 childNodes（实证），无需特判；
 * XML 声明/DOCTYPE 会以文本节点漏出（实证），入口先剥。
 */
function epubHtmlToText(html: string): string {
  const cleaned = html.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const root = parseHtml(cleaned) as unknown as HtmlNodeLike;
  const paragraphs: string[][] = []; // 段落 = 行列表（行间 \n、段间 \n\n）。
  let lines: string[] = [];
  let current = '';
  const flushLine = () => {
    const collapsed = current.replace(/\s+/g, ' ').trim();
    if (collapsed) lines.push(collapsed);
    current = '';
  };
  const flushParagraph = () => {
    flushLine();
    if (lines.length > 0) paragraphs.push(lines);
    lines = [];
  };
  const visit = (node: HtmlNodeLike): void => {
    if (node.nodeType === 3) {
      current += node.text ?? '';
      return;
    }
    if (node.nodeType !== 1) return; // 注释/声明等（注释实证不出现在 childNodes，belt）
    const tag = (node.tagName ?? '').toLowerCase();
    if (EPUB_SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      flushLine(); // 行内断行：只收当前行，段落继续（不制造段间空行）。
      return;
    }
    const isBlock = EPUB_BLOCK_TAGS.has(tag);
    if (isBlock) flushParagraph(); // 块级进：先收外层开着的段（嵌套块各自成段）
    for (const child of node.childNodes) visit(child);
    if (isBlock) flushParagraph();
  };
  visit(root);
  flushParagraph();
  return paragraphs.map((ls) => ls.join('\n')).join('\n\n');
}

export interface EpubTextExtraction {
  kind: 'text' | 'scanned';
  /** spine 顺序拼接的正文文本（kind='scanned' 时仍携带可提取部分——降级标注非拒收）。 */
  text: string;
  /** spine 中的文本文档（xhtml/html）数（扫描判定的分母）。 */
  documents: number;
  /** 每文档平均非空白字符数（扫描图判定）。 */
  avgCharsPerDoc: number;
  /** 结构性备注（spine 引用缺失 / 解压截断等，人读）。 */
  notes: string[];
}

/** OPF manifest 条目（href 已按 OPF 目录解析为 zip 内路径）。 */
interface EpubManifestItem {
  zipPath: string;
  mediaType: string;
}

/** jszip 条目的最小结构面（避免依赖其类型导出形状——interop 形态跨 CJS/ESM 稳定）。 */
interface EpubZipEntryLike {
  async(type: 'string'): Promise<string>;
}

/** jszip 实例的最小结构面。 */
interface EpubZipLike {
  file(name: string): EpubZipEntryLike | null;
}

/**
 * 条目**声明**的解压尺寸（字节；中央目录元数据，inflate 前可得——jszip 内部 `_data.
 * uncompressedSize`，公开 API 不暴露故试探性读取）。缺省/未知/异常形态返回 null，不阻塞
 * 主流程（CR-020 解压炸弹预检的尽力面；真防线是提取后累计上限）。
 */
function declaredUncompressedSize(entry: EpubZipEntryLike): number | null {
  const data = (entry as { _data?: unknown })._data;
  const size = (data as { uncompressedSize?: unknown } | null | undefined)?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

/**
 * Extract EPUB text in spine order. Throws typed errors on a corrupt archive,
 * a DRM encryption manifest, or missing container/OPF/empty-spine structures —
 * the handler catches and degrades to a structured parse-failed result.
 * Bomb defense (CR-020): per-entry declared-size pre-check before inflate +
 * streamed accumulate-and-break after each entry (never materialize the corpus
 * past the cap); URI-encoded container full-path tolerated (CR-021); spine
 * items with unknown/missing media-type are skipped WITH a note (CR-022).
 */
export async function extractEpubText(
  buffer: Buffer,
  opts: { maxTextChars?: number } = {},
): Promise<EpubTextExtraction> {
  // CR-020 测试缝：上限可注入（生产恒 EPUB_MAX_TEXT_CHARS——注入只为小上限覆盖同一防线）。
  const maxTextChars = opts.maxTextChars ?? EPUB_MAX_TEXT_CHARS;
  // 动态引入 mirror pdfjs/mammoth（只让 epub 解析路径付 jszip 加载成本）。
  const jszipMod = await import('jszip');
  const JSZip = ((jszipMod as { default?: unknown }).default ?? jszipMod) as {
    loadAsync(data: Buffer): Promise<EpubZipLike>;
  };
  let zip: EpubZipLike;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new Error(`zip 结构损坏（${err instanceof Error ? err.message : String(err)}）`);
  }

  if (zip.file('META-INF/encryption.xml')) {
    throw new Error('含加密清单（DRM 保护），无法本地解析');
  }

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('缺少 META-INF/container.xml（EPUB 结构不完整）');
  }
  const container = await containerFile.async('string');
  const containerRoot = parseHtml(container) as unknown as HtmlNodeLike;
  const seekRootfile = (node: HtmlNodeLike): string | null => {
    if (node.nodeType === 1 && (node.tagName ?? '').toLowerCase() === 'rootfile') {
      const fp = node.getAttribute?.('full-path');
      const mt = node.getAttribute?.('media-type');
      if (fp && (!mt || mt === 'application/oebps-package+xml')) return fp;
    }
    for (const child of node.childNodes) {
      const found = seekRootfile(child);
      if (found !== null) return found;
    }
    return null;
  };
  const opfPath = seekRootfile(containerRoot);
  if (opfPath === null) {
    throw new Error('container.xml 未声明 OPF 包路径');
  }

  let resolvedOpfPath = opfPath;
  let opfFile = zip.file(opfPath);
  if (!opfFile) {
    // CR-021：full-path 可能是 URI 编码形态（`OEBPS/My%20Book/content.opf`）——按原样未命中
    // 时 decode 再试一次；坏编码保持原样走缺档报错。**命中后以解码路径为基**（manifest href
    // 相对 OPF 目录解析——用编码形态会拼出 `%20` 幽灵目录）。
    try {
      const decodedOpfPath = decodeURIComponent(opfPath);
      if (decodedOpfPath !== opfPath) {
        resolvedOpfPath = decodedOpfPath;
        opfFile = zip.file(decodedOpfPath);
      }
    } catch {
      // 坏 URI 编码：维持未命中（下面统一报缺 OPF）。
    }
  }
  if (!opfFile) {
    throw new Error(`缺少 OPF 包文件（${opfPath}）`);
  }
  const opf = await opfFile.async('string');
  const opfRoot = parseHtml(opf) as unknown as HtmlNodeLike;
  const opfDir = path.posix.dirname(resolvedOpfPath);

  // manifest：id → zip 内绝对路径（href 相对 OPF 目录解析 + URI 解码）。
  const manifest = new Map<string, EpubManifestItem>();
  const collectItems = (node: HtmlNodeLike): void => {
    if (node.nodeType === 1 && (node.tagName ?? '').toLowerCase() === 'item') {
      const id = node.getAttribute?.('id');
      const href = node.getAttribute?.('href');
      const mediaType = node.getAttribute?.('media-type') ?? '';
      if (id && href) {
        let decoded = href;
        try {
          decoded = decodeURIComponent(href);
        } catch {
          // 坏 URI 编码按原样使用（宽容——OPF 罕见形态不整体拒收）。
        }
        manifest.set(id, {
          zipPath: path.posix.normalize(path.posix.join(opfDir === '.' ? '' : opfDir, decoded)),
          mediaType,
        });
      }
    }
    for (const child of node.childNodes) collectItems(child);
  };
  collectItems(opfRoot);

  // spine：按文档序收集 idref。
  const spineIdrefs: string[] = [];
  const collectSpine = (node: HtmlNodeLike): void => {
    if (node.nodeType === 1 && (node.tagName ?? '').toLowerCase() === 'itemref') {
      const idref = node.getAttribute?.('idref');
      if (idref) spineIdrefs.push(idref);
    }
    for (const child of node.childNodes) collectSpine(child);
  };
  collectSpine(opfRoot);
  if (spineIdrefs.length === 0) {
    throw new Error('OPF spine 为空（无可读文档）');
  }

  const notes: string[] = [];
  const docs: string[] = [];
  let totalChars = 0;
  let missingRefs = 0;
  let truncated = false;
  for (const idref of spineIdrefs) {
    const item = manifest.get(idref);
    if (!item) {
      missingRefs += 1;
      continue;
    }
    if (!EPUB_TEXT_MEDIA_TYPES.has(item.mediaType)) {
      // 图片/CSS/字体等已知非正文 = 合法跳过；未知/缺 media-type 可能是被静默丢掉的章
      // 内容——note 记档不静默（CR-022）。
      if (!isKnownNonTextMediaType(item.mediaType)) {
        notes.push(`spine item ${idref} media-type ${item.mediaType || 'none'} skipped`);
      }
      continue;
    }
    const docFile = zip.file(item.zipPath);
    if (!docFile) {
      missingRefs += 1;
      continue;
    }
    // CR-020 预检：中央目录**声明**的解压字节 > cap×3（UTF-8 每 UTF-16 unit 最多 3 字节——
    // CJK；4 字节代理对拆两 unit=2）⇒ 文本字符数必然超 cap（数学下界，跳过无假阳性）→ 不
    // inflate 直接停读。声明介于 cap 与 cap×3 的条目可能合法（CJK 密集）——放行由下方提取后
    // 累计防线截断（有界物化 ≤ cap×3 字符，可控）；声明不可得（null）同样退由累计防线兜底。
    const declaredBytes = declaredUncompressedSize(docFile);
    const declaredBombLimit = maxTextChars * EPUB_UTF8_MAX_BYTES_PER_UNIT;
    if (declaredBytes !== null && declaredBytes > declaredBombLimit) {
      truncated = true;
      notes.push(`spine 文档 ${item.zipPath} 声明解压 ${declaredBytes} 字节超过 ${declaredBombLimit} 字节防炸上限，已跳过解压（防解压炸弹）。`);
      break;
    }
    const docText = epubHtmlToText(await docFile.async('string'));
    docs.push(docText);
    totalChars += docText.replace(/\s+/g, '').length;
    if (totalChars > maxTextChars) {
      truncated = true;
      break; // 解压炸弹防线：超上限即停读（诚实截断，非静默）。
    }
  }
  if (missingRefs > 0) {
    notes.push(`spine 有 ${missingRefs} 项引用在 manifest 中缺失或文件不存在，已跳过。`);
  }
  if (truncated) {
    notes.push(`解压文本超过 ${maxTextChars} 字符上限，已截断至前 ${docs.length} 个文档。`);
  }
  if (docs.length === 0) {
    throw new Error(missingRefs > 0 ? 'spine 无可读文本文档（引用全部缺失）' : 'spine 无文本文档（xhtml/html）');
  }

  const text = docs
    .filter((d) => d.trim() !== '')
    .join('\n\n')
    .trim();
  const avgCharsPerDoc = totalChars / docs.length;
  return {
    kind: avgCharsPerDoc < SCANNED_PAGE_CHAR_THRESHOLD ? 'scanned' : 'text',
    text,
    documents: docs.length,
    avgCharsPerDoc,
    notes,
  };
}

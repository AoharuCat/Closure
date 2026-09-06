/**
 * Builtin document-parsing kernel tests (Story 3.6 WP6, R10 / design D11).
 *
 * REAL kernels, REAL fixtures — no mocking of pdfjs/mammoth:
 *
 *   - PDF fixtures are hand-built minimal valid PDFs (xref offsets computed
 *     by the builder), parsed by the actual pdfjs-dist legacy build — locks
 *     the real extraction path incl. per-page item joining + the scanned
 *     verdict math (dispatch: 手写最小合法 PDF 单页 Hello 文本).
 *   - DOCX fixture is a hand-built minimal OOXML package (STORE-method zip
 *     with hand-computed CRC32 — no zip dep in the repo) parsed by the real
 *     mammoth.
 *
 * ZERO network. Covers classifyDocumentKind dispatch + BOM strip + the
 * scan matrix (text page / scanned page / mixed doc average verdict).
 * Fixture builders live in test/fixtures/documentFixtures.ts (shared with
 * parseDocumentHandlers.test.ts).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EPUB_MAX_TEXT_CHARS,
  NON_UTF8_SUSPECT_RATIO,
  SCANNED_PAGE_CHAR_THRESHOLD,
  classifyDocumentKind,
  decodeTextDocument,
  extractDocxText,
  extractEpubText,
  extractPdfTextLayer,
  utf8ReplacementCharRatio,
} from '../main/research/docParsing';
import { buildDocxFixture, buildEpubFixture, buildPdfFixture } from './fixtures/documentFixtures';

// ── classifyDocumentKind ──

describe('classifyDocumentKind', () => {
  it('maps extensions first', () => {
    expect(classifyDocumentKind('a/b/设定集.pdf')).toBe('pdf');
    expect(classifyDocumentKind('角色卡.docx')).toBe('docx');
    expect(classifyDocumentKind('notes.txt')).toBe('text');
    expect(classifyDocumentKind('设定.md')).toBe('text');
    expect(classifyDocumentKind('readme.markdown')).toBe('text');
  });

  it('extension wins over a lying mime; mime fills in when informative', () => {
    expect(classifyDocumentKind('scan.pdf', 'text/plain')).toBe('pdf');
    expect(classifyDocumentKind('noext', 'application/pdf')).toBe('pdf');
    expect(classifyDocumentKind('noext', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(classifyDocumentKind('noext', 'text/plain')).toBe('text');
    // Story 10.1 Wave B：epub 进分类（jszip 内置路径；端点档恒不涉）。
    expect(classifyDocumentKind('noext', 'application/epub+zip')).toBe('epub');
  });

  it('uppercase extensions + unsupported kinds', () => {
    expect(classifyDocumentKind('DOC.PDF')).toBe('pdf');
    expect(classifyDocumentKind('book.epub')).toBe('epub');
    expect(classifyDocumentKind('BOOK.EPUB')).toBe('epub');
    expect(classifyDocumentKind('data.xlsx')).toBe('unsupported');
    expect(classifyDocumentKind('archive.zip')).toBe('unsupported');
  });
});

// ── decodeTextDocument ──

describe('decodeTextDocument', () => {
  it('utf-8 decode + leading BOM strip', () => {
    expect(decodeTextDocument(Buffer.from('设定文档', 'utf-8'))).toBe('设定文档');
    expect(decodeTextDocument(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 后正文', 'utf-8')]))).toBe('BOM 后正文');
  });
});

// ── P20 (CR 2026-08-15): non-UTF-8 detection via replacement-char ratio ──

describe('utf8ReplacementCharRatio (P20 mojibake detector)', () => {
  it('clean utf-8 (incl. CJK) → ratio 0; empty buffer → 0', () => {
    expect(utf8ReplacementCharRatio(Buffer.from('设定文档正文', 'utf-8'))).toBe(0);
    expect(utf8ReplacementCharRatio(Buffer.alloc(0))).toBe(0);
  });

  it('a GBK-style body read as utf-8 decodes to heavy U+FFFD → ratio above the 3% suspect line', () => {
    // GBK 编码的中文（每汉字 2 字节，多数非合法 utf-8 序列）。
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd5, 0xfd, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]);
    const ratio = utf8ReplacementCharRatio(gbk);
    expect(ratio).toBeGreaterThan(NON_UTF8_SUSPECT_RATIO);
  });

  it('a single stray byte among healthy text stays BELOW the line (no false alarm)', () => {
    const buf = Buffer.concat([Buffer.from('正常的长文本内容，包含足量的合法 UTF-8 字符。'.repeat(4), 'utf-8'), Buffer.from([0xff])]);
    expect(utf8ReplacementCharRatio(buf)).toBeLessThanOrEqual(NON_UTF8_SUSPECT_RATIO);
  });
});

// ── extractPdfTextLayer (REAL pdfjs on hand-built fixtures) ──

// Real-kernel tests get a raised timeout (mirror parseDocumentHandlers.test.ts):
// the first call pays pdfjs module + worker init, which exceeds the 5s default
// under turbo's parallel package load (observed flaking under `pnpm test`);
// passes in isolation. 30s leaves ample headroom without masking a hang.
describe('extractPdfTextLayer', () => {
  it('single text page: extracts the string, kind=text, no scanned pages', async () => {
    const text = 'Hello Closure research page with enough body text to clear the scan threshold';
    const extraction = await extractPdfTextLayer(buildPdfFixture([text]));
    expect(extraction.kind).toBe('text');
    expect(extraction.pages).toBe(1);
    expect(extraction.scannedPages).toEqual([]);
    expect(extraction.text).toContain('Hello Closure');
    expect(extraction.avgCharsPerPage).toBe(text.replace(/\s+/g, '').length);
  }, 30_000);

  it('a SHORT single page (avg < threshold) is honestly judged scanned', async () => {
    // 12 non-ws chars/page < 50 → the whole-doc average rule fires — this is
    // the documented behavior, not a bug (thin text layer ≈ scanned).
    const extraction = await extractPdfTextLayer(buildPdfFixture(['Hello Closure']));
    expect(extraction.avgCharsPerPage).toBe('Hello Closure'.replace(/\s+/g, '').length);
    expect(extraction.kind).toBe('scanned');
  }, 30_000);

  it('scanned verdict: empty content stream → 0 chars/page → kind=scanned', async () => {
    const extraction = await extractPdfTextLayer(buildPdfFixture(['']));
    expect(extraction.kind).toBe('scanned');
    expect(extraction.pages).toBe(1);
    expect(extraction.scannedPages).toEqual([1]);
    expect(extraction.avgCharsPerPage).toBe(0);
  }, 30_000);

  it('mixed doc: page average ≥ threshold keeps kind=text, thin pages listed', async () => {
    // Page 1 carries well over 2× the threshold so the DOC average stays ≥50
    // even though page 2 is image-only.
    const longText = `page one ${'A'.repeat(SCANNED_PAGE_CHAR_THRESHOLD * 3)}`;
    const extraction = await extractPdfTextLayer(buildPdfFixture([longText, '']));
    expect(extraction.avgCharsPerPage).toBeGreaterThanOrEqual(SCANNED_PAGE_CHAR_THRESHOLD);
    expect(extraction.kind).toBe('text');
    expect(extraction.pages).toBe(2);
    expect(extraction.scannedPages).toEqual([2]);
    expect(extraction.text).toContain('page one');
  }, 30_000);

  it('two thin text pages average under the threshold → doc-level scanned verdict', async () => {
    const extraction = await extractPdfTextLayer(buildPdfFixture(['short', 'tiny']));
    expect(extraction.avgCharsPerPage).toBeLessThan(SCANNED_PAGE_CHAR_THRESHOLD);
    expect(extraction.kind).toBe('scanned');
  }, 30_000);

  it('multi-page text is joined in page order', async () => {
    const extraction = await extractPdfTextLayer(
      buildPdfFixture([`${'A'.repeat(60)}`, `${'B'.repeat(60)}`]),
    );
    expect(extraction.kind).toBe('text');
    expect(extraction.text.startsWith('A'.repeat(60))).toBe(true);
    expect(extraction.text.indexOf('B'.repeat(60))).toBeGreaterThan(0);
  }, 30_000);

  it('corrupt bytes throw (handler degrades friendly)', async () => {
    await expect(extractPdfTextLayer(Buffer.from('this is not a pdf at all', 'utf-8'))).rejects.toThrow();
  }, 30_000);
});

// ── extractDocxText (REAL mammoth on a hand-built docx) ──

describe('extractDocxText', () => {
  it('extracts the paragraph text from a minimal docx package', async () => {
    const text = await extractDocxText(buildDocxFixture('Hello Closure 设定文档正文'));
    expect(text).toContain('Hello Closure 设定文档正文');
  });

  it('corrupt docx throws (handler degrades friendly)', async () => {
    await expect(extractDocxText(Buffer.from('not a zip'))).rejects.toThrow();
  });
});

// ── pdfjs standard-font data dir resolution (best-effort helper path) ──

describe('pdfjs runtime resolution sanity', () => {
  it('pdfjs-dist standard_fonts exists in node_modules (standardFontDataUrl resolves)', () => {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    expect(pkgPath).toBeTruthy();
    expect(existsSync(path.join(path.dirname(pkgPath), 'standard_fonts'))).toBe(true);
  });
});

// ── extractEpubText（Story 10.1 Wave B，REAL jszip + node-html-parser on hand-built epubs）──
//
// fixtures 自制（AC11 版权红线）：STORE-method zip（documentFixtures.buildEpubFixture），
// zip 条目逆序落盘——提取必须按 OPF spine 阅读序而非 zip 存储序。

describe('extractEpubText', () => {
  const LONG_BODY = (heading: string, filler: string) =>
    `<h1>${heading}</h1><p>${filler}</p><p>第二段正文与实体：A &amp; B &#x4e2d;文。</p><p>末段收尾。</p>`;

  it('好档：多文档按 spine 顺序拼接 + 块级断行 + 实体解码 + kind=text', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [
          { href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) },
          { href: 'c2.xhtml', body: LONG_BODY('第二章', '雨'.repeat(80)) },
          { href: 'c3.xhtml', body: LONG_BODY('第三章', '风'.repeat(80)) },
        ],
      }),
    );
    expect(extraction.kind).toBe('text');
    expect(extraction.documents).toBe(3);
    expect(extraction.notes).toEqual([]);
    // spine 顺序：第一章在第二章前（zip 逆序落盘，非按 spine 会反序）。
    const lines = extraction.text.split('\n\n');
    expect(lines[0]).toBe('第一章');
    expect(extraction.text.indexOf('第一章')).toBeLessThan(extraction.text.indexOf('第二章'));
    expect(extraction.text.indexOf('第二章')).toBeLessThan(extraction.text.indexOf('第三章'));
    // 实体解码 + 块级断行：h1/p 各自成段。
    expect(lines).toContain('第二段正文与实体：A & B 中文。');
    // head/title 跳过（正文只来自 body）。
    expect(extraction.text).not.toContain('fixture');
  }, 30_000);

  it('坏 zip：typed throw（handler 降级结构化 parse-failed）', async () => {
    await expect(extractEpubText(Buffer.from('this is not an epub at all', 'utf-8'))).rejects.toThrow(/zip 结构损坏/);
  });

  it('加密 epub（META-INF/encryption.xml）：typed throw（DRM 不硬读）', async () => {
    await expect(
      extractEpubText(
        buildEpubFixture({
          documents: [{ href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) }],
          encrypted: true,
        }),
      ),
    ).rejects.toThrow(/加密/);
  });

  it('扫描图 epub：每文档平均非空白字符低于阈值 → kind=scanned（文本仍返回——降级标注非拒收）', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [
          { href: 'p1.xhtml', body: '<p>图</p><img src="a.png"/>' },
          { href: 'p2.xhtml', body: '<p>注</p><img src="b.png"/>' },
        ],
      }),
    );
    expect(extraction.documents).toBe(2);
    expect(extraction.avgCharsPerDoc).toBeLessThan(SCANNED_PAGE_CHAR_THRESHOLD);
    expect(extraction.kind).toBe('scanned');
    // 文本仍返回（诚实降级——材料侧标 scanned 质量信号，AC8）。
    expect(extraction.text).toContain('图');
    expect(extraction.text).toContain('注');
  }, 30_000);

  it('缺 container.xml：typed throw（结构坏档）', async () => {
    await expect(
      extractEpubText(
        buildEpubFixture({
          documents: [{ href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) }],
          omitContainer: true,
        }),
      ),
    ).rejects.toThrow(/container\.xml/);
  }, 30_000);

  it('spine 引用缺失（manifest 外 idref）：跳过 + note（不整体拒收）', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [{ href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) }],
        danglingSpineIdrefs: ['ghost-ref'],
      }),
    );
    expect(extraction.kind).toBe('text');
    expect(extraction.documents).toBe(1); // 幽灵引用不计文档数
    expect(extraction.notes.join('\n')).toContain('1 项引用');
    expect(extraction.text).toContain('第一章');
  }, 30_000);

  // ── CR 修复批（2026-09-02 BMad CR）──

  it('`<br>` = 行内断行（单 \\n）不额外段落化；块级标签才 \\n\\n 段落分隔（CR-004）', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [
          {
            href: 'addr.xhtml',
            body: '<p>上海市徐汇区<br/>某路 100 弄<br/>3 号楼 502 室</p><p>下一处地址</p>',
          },
        ],
      }),
    );
    const paras = extraction.text.split('\n\n');
    expect(paras).toEqual([
      '上海市徐汇区\n某路 100 弄\n3 号楼 502 室', // br 密集折行 = 同段三行（地址/诗句形态）
      '下一处地址', // 块级 <p> 边界 = 段落空行分隔
    ]);
  }, 30_000);

  it('fixture 形态（CR-016）：mimetype 固定首位未压缩条目（EPUB 规范）；其余逆序落盘仍按 spine 提取', async () => {
    const buf = buildEpubFixture({
      documents: [
        { href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) },
        { href: 'c2.xhtml', body: LONG_BODY('第二章', '雨'.repeat(80)) },
      ],
    });
    // 首个本地文件头（30 字节固定段）：名字段 = mimetype、method=STORE（未压缩）、
    // 数据体紧跟（'application/epub+zip' 未压缩可直读）。
    expect(buf.readUInt16LE(26)).toBe('mimetype'.length);
    expect(buf.slice(30, 30 + 'mimetype'.length).toString('latin1')).toBe('mimetype');
    expect(buf.readUInt16LE(8)).toBe(0); // method: store
    expect(buf.slice(38, 38 + 'application/epub+zip'.length).toString('latin1')).toBe('application/epub+zip');
    // mimetype 之后的条目仍逆序：spine 序提取不受存储序影响的证明保持成立。
    const extraction = await extractEpubText(buf);
    expect(extraction.text.indexOf('第一章')).toBeLessThan(extraction.text.indexOf('第二章'));
  }, 30_000);

  it('单条目声明解压尺寸超上限（CR-020）：inflate 前预检跳过——不物化解压炸弹，诚实 note', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [
          { href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) },
          {
            href: 'bomb.xhtml',
            body: '<p>小体量但谎报巨解压尺寸</p>',
            declaredUncompressedSize: EPUB_MAX_TEXT_CHARS * 3 + 1, // 声明字节 > cap×3 防炸阈（真实常量）
          },
        ],
      }),
    );
    expect(extraction.documents).toBe(1); // 炸弹条目未解压、不计文档
    expect(extraction.text).toContain('第一章');
    expect(extraction.text).not.toContain('谎报');
    expect(extraction.notes.join('\n')).toContain('跳过解压');
  }, 30_000);

  it('实际累计超上限（CR-020）：逐文档累计即停——截断于超限文档、后续不读（诚实 note）', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [
          { href: 'a.xhtml', body: `<p>${'墨'.repeat(80)}</p>` },
          { href: 'b.xhtml', body: `<p>${'雨'.repeat(80)}</p>` },
          { href: 'c.xhtml', body: `<p>${'风'.repeat(80)}</p>` },
          { href: 'd.xhtml', body: `<p>${'雪'.repeat(80)}</p>` },
        ],
      }),
      { maxTextChars: 200 }, // 测试缝注入小上限：a(80)+b(80)≤200；+c(80)=240>200 → 截断于 c
    );
    expect(extraction.documents).toBe(3);
    expect(extraction.text).toContain('风'); // 超限文档本身已物化（先物化后累计）……
    expect(extraction.text).not.toContain('雪'); // ……但其后的 d 不再读
    expect(extraction.notes.join('\n')).toContain('已截断');
  }, 30_000);

  it('container.xml full-path URI 编码（%20）：decode 后命中 OPF（CR-021）', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        opfZipPath: 'OEBPS/My Book/content.opf', // zip 内实际条目（含空格）
        containerFullPath: 'OEBPS/My%20Book/content.opf', // container 声明（URI 编码形态）
        documents: [{ href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) }],
      }),
    );
    expect(extraction.kind).toBe('text');
    expect(extraction.text).toContain('第一章');
  }, 30_000);

  it('spine 未知/缺 media-type：不静默丢——note 记 skipped；已知非正文（图片）静默跳过（CR-022）', async () => {
    const extraction = await extractEpubText(
      buildEpubFixture({
        documents: [
          { href: 'c1.xhtml', body: LONG_BODY('第一章', '墨'.repeat(80)) },
          { href: 'weird.xhtml', body: '<p>神秘格式内容</p>', mediaType: 'application/octet-stream' },
          { href: 'nomt.xhtml', body: '<p>未声明类型</p>', mediaType: '' },
          { href: 'cover.png', body: '', mediaType: 'image/png' },
        ],
      }),
    );
    expect(extraction.documents).toBe(1); // 只有 c1 是可读文本文档
    const notes = extraction.notes.join('\n');
    expect(notes).toContain('spine item doc1 media-type application/octet-stream skipped');
    expect(notes).toContain('spine item doc2 media-type none skipped');
    expect(notes).not.toContain('image/png'); // 已知非正文 = 合法跳过，不 note
    expect(extraction.text).toContain('第一章');
  }, 30_000);
});

/**
 * Hand-built binary document fixtures for the WP6 parsing tests (Story 3.6)
 * + Story 10.1 Wave B epub fixtures.
 *
 *   - `buildPdfFixture` — minimal valid PDFs (xref offsets computed by the
 *     builder) parsed by the REAL pdfjs-dist legacy build.
 *   - `buildDocxFixture` — minimal OOXML package as a STORE-method zip with
 *     hand-computed CRC32s (no zip-writer dep in the repo) parsed by the REAL
 *     mammoth. Multi-line text becomes one `w:p` per non-empty line (CR-032
 *     material-chain fixtures need multi-paragraph docx).
 *   - `buildEpubFixture` — minimal EPUB (container/OPF/spine/xhtml) as the
 *     same STORE-method zip, parsed by the REAL jszip + node-html-parser path.
 *     The `mimetype` entry is pinned FIRST and uncompressed (EPUB spec —
 *     CR-016); all OTHER entries are written in REVERSE document order to
 *     prove the extractor follows the OPF spine, not the zip order.
 *
 * Extracted from docParsing.test.ts so parseDocumentHandlers.test.ts /
 * materialIngest.test.ts can share the builders without re-running the
 * docParsing suites (importing a *.test.ts from another test file duplicates
 * its tests into that file's run).
 */
import path from 'node:path';

// ── PDF fixture builder ──

/**
 * Build a minimal valid PDF whose pages carry the given text-layer strings.
 * An EMPTY string renders an empty content stream (an image-only/scanned page
 * from the text layer's point of view). Objects: 1=Catalog 2=Pages, then
 * page/content pairs (3,4),(5,6)…, last object = the /F1 Helvetica font.
 *
 * Long text is wrapped at 70 chars/line — pdf.js v6 text extraction CLIPS
 * glyphs beyond the 612pt MediaBox (verified: a 109-char single line yields
 * only the 70 chars that fit), so one-line fixtures would under-count.
 *
 * NOTE: PDF literal strings in a Type1/WinAnsi content stream carry
 * single-byte encodings — CJK cannot ride them without an embedded CID font,
 * so fixtures use ASCII. (Production CJK PDFs embed fonts; pdf.js handles
 * those — fixtures only lock OUR join/threshold logic.)
 */
export function buildPdfFixture(pageTexts: string[]): Buffer {
  const wrapText = (text: string): string[] => {
    if (text.length === 0) return [];
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += 70) lines.push(text.slice(i, i + 70));
    return lines;
  };
  const streamFor = (text: string): string =>
    wrapText(text)
      .map((line, idx) => `BT /F1 12 Tf 72 ${720 - idx * 20} Td (${line}) Tj ET`)
      .join('\n');

  const n = pageTexts.length;
  const kids = Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  const addObj = (num: number, content: string) => {
    offsets[num] = body.length;
    body += `${num} 0 obj\n${content}\nendobj\n`;
  };

  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pageTexts.forEach((text, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const fontNum = 3 + n * 2;
    addObj(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    const stream = streamFor(text);
    addObj(contentNum, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  addObj(3 + n * 2, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const totalObjects = 3 + n * 2;
  const xrefOffset = body.length;
  body += `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjects; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer << /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

// ── DOCX fixture builder (minimal OOXML package, STORE-method zip) ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a minimal valid .docx as a STORE-method zip with hand-computed CRC32s
 * — the three parts mammoth minimally needs. Multi-line `text` maps to one
 * `w:p` paragraph per non-empty line (mammoth joins paragraphs with blank
 * lines → the original blank-line structure round-trips).
 */
export function buildDocxFixture(text: string): Buffer {
  const paragraphs = text.split('\n').filter((line) => line !== '');
  const paragraphXml = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const parts: Array<{ name: string; data: Buffer }> = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
        'utf-8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
        'utf-8',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphXml}</w:body>
</w:document>`,
        'utf-8',
      ),
    },
  ];
  return buildStoredZip(parts);
}

// ── STORE-method zip builder（docx/epub fixture 共用底座）──

/** 一个 zip 条目；declaredUncompressedSize 覆盖中央目录**声明**的解压尺寸（解压炸弹用例）。 */
interface StoredZipPart {
  name: string;
  data: Buffer;
  /**
   * 谎报的解压尺寸（仅作用于 uncompressedSize 字段——compressedSize 保持如实，jszip
   * loadAsync 按其切片压缩字节不受影响；条目本身永不被解压，谎言只在元数据面）。
   */
  declaredUncompressedSize?: number;
}

/**
 * Minimal valid zip (STORE method, hand-computed CRC32 — no zip-writer dep).
 * Entries are written in the given order; directory entries are NOT emitted
 * (readers resolve `META-INF/container.xml` without a `META-INF/` entry).
 */
function buildStoredZip(parts: StoredZipPart[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf-8');
    const crc = crc32(part.data);
    const declaredSize = part.declaredUncompressedSize ?? part.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(part.data.length, 18); // compressed size（如实）
    local.writeUInt32LE(declaredSize, 22); // uncompressed size（可谎报）
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, name, part.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(part.data.length, 20); // compressed size（如实）
    cd.writeUInt32LE(declaredSize, 24); // uncompressed size（可谎报）
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + part.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ── EPUB fixture builder（Story 10.1 Wave B）──

export interface EpubFixtureDocument {
  /** spine href（相对 OPF 目录，如 'chapter1.xhtml'——manifest 自动登记）。 */
  href: string;
  /** xhtml <body> 内文（原始 HTML——段落/实体/块级标签随用例自定）。 */
  body: string;
  /** manifest 声明的 media-type 覆盖（缺省 application/xhtml+xml——CR-022 未知类型用例）。 */
  mediaType?: string;
  /** 中央目录谎报的解压尺寸（缺省如实——CR-020 解压炸弹用例：小 body + 巨尺寸声明）。 */
  declaredUncompressedSize?: number;
}

export interface EpubFixtureOptions {
  /** spine 文档（顺序即阅读顺序；zip 内以**逆序**落盘以证明按 spine 而非 zip 序读取）。 */
  documents: EpubFixtureDocument[];
  /** OPF 在 zip 内的实际路径（缺省 'OEBPS/content.opf'）；文档 href 相对该目录落盘。 */
  opfZipPath?: string;
  /**
   * container.xml 声明的 full-path（缺省 = opfZipPath）。传 URI 编码形态（如
   * 'OEBPS/My%20Book/content.opf'）即测 CR-021 容错——实际条目名用解码后的 opfZipPath。
   */
  containerFullPath?: string;
  /** 加 META-INF/encryption.xml（DRM 加密档用例）。 */
  encrypted?: boolean;
  /** 不写 META-INF/container.xml（结构坏档用例）。 */
  omitContainer?: boolean;
  /** spine 尾部追加 manifest 外 idref（引用缺失降级用例——跳过 + note，不整体拒收）。 */
  danglingSpineIdrefs?: string[];
}

/** 包一层合法 xhtml 文档（head/title 属应跳过面——正文只应来自 body）。 */
function wrapXhtml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>fixture</title></head><body>${body}</body></html>`;
}

/**
 * Build a minimal valid EPUB: mimetype + container.xml → OPF（manifest + spine
 * in the GIVEN document order）+ one xhtml file per document. Zip entry order:
 * `mimetype` pinned FIRST (EPUB 规范：必须是首个未压缩〔STORE〕条目，CR-016)；其余条目
 * 逆序落盘——spine 序提取不受存储序影响的证明仍成立。
 */
export function buildEpubFixture(options: EpubFixtureOptions): Buffer {
  const {
    documents,
    opfZipPath = 'OEBPS/content.opf',
    containerFullPath,
    encrypted = false,
    omitContainer = false,
    danglingSpineIdrefs = [],
  } = options;
  const opfDir = path.posix.dirname(opfZipPath);
  const docZipPath = (href: string) => path.posix.join(opfDir === '.' ? '' : opfDir, href);
  const manifestItems = documents
    .map(
      (d, i) =>
        `<item id="doc${i}" href="${d.href}" media-type="${d.mediaType ?? 'application/xhtml+xml'}"/>`,
    )
    .join('');
  const spineRefs = [...documents.map((_, i) => `<itemref idref="doc${i}"/>`), ...danglingSpineIdrefs.map((id) => `<itemref idref="${id}"/>`)].join('');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata/><manifest>${manifestItems}</manifest><spine>${spineRefs}</spine>
</package>`;

  const parts: StoredZipPart[] = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf-8') },
  ];
  if (!omitContainer) {
    parts.push({
      name: 'META-INF/container.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${containerFullPath ?? opfZipPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
        'utf-8',
      ),
    });
  }
  if (encrypted) {
    parts.push({
      name: 'META-INF/encryption.xml',
      data: Buffer.from('<?xml version="1.0"?><enc:EncryptedData/>', 'utf-8'),
    });
  }
  parts.push({ name: opfZipPath, data: Buffer.from(opf, 'utf-8') });
  for (const doc of documents) {
    parts.push({
      name: docZipPath(doc.href),
      data: Buffer.from(wrapXhtml(doc.body), 'utf-8'),
      ...(doc.declaredUncompressedSize !== undefined
        ? { declaredUncompressedSize: doc.declaredUncompressedSize }
        : {}),
    });
  }
  // mimetype 固定首位（规范），其余逆序：zip 存储序 ≠ spine 阅读序（提取器必须按 OPF spine 走）。
  const [mimetypePart, ...rest] = parts;
  return buildStoredZip([mimetypePart, ...rest.reverse()]);
}

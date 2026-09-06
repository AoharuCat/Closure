/**
 * inbox 附件 IPC 测试（A 波 09-01，design §1.2/§1.2c）。
 *
 * 注入工厂照抄 parseDocumentHandlers.test.ts:29-73（vi.hoisted + Deps 注入，
 * 零网络）+ 真 temp 目录 fs。覆盖面（implement.md A2 测试项）：
 *
 *   - parse-inbox-doc：docx/pdf/txt 三 kind（txt preview-only 不写派生 .md）、
 *     scanned 指引、路径逃逸拒收、file:changed 通知断言、preview 内容断言、
 *     非 UTF-8（GBK）提示不喂乱码、不支持的格式 / 参数无效。
 *   - resolve-inbox-attachment 协议三态：mtime 触发重解析（派生 .md 新鲜则零
 *     解析直读）、exact（含改名命中）、similar（条目 hash/sample 更新 +
 *     generatedAt 不动）、fresh。
 *   - store-attachment-description：回写落 sidecar、generatedAt = now、
 *     回写后 resolve 精确命中；载荷不信任（哈希 shell 现算）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { PdfTextExtraction } from '../main/research/docParsing';
import {
  createInboxAttachmentIpc,
  type InboxAttachmentIpcDeps,
  type InboxAttachmentIpcHandlers,
} from '../main/ipc/toolHandlers/parseDocumentHandlers';
import { loadAttachmentMeta } from '../main/research/attachmentMeta';
import { allowPath } from '../main/ipc/pathGuard';
import { rmBestEffort } from './rmBestEffort';

// ── Fixtures / helpers ──

const FIXED_NOW = 1_725_000_000_000;

const TEXT_PDF: PdfTextExtraction = {
  kind: 'text',
  pages: 2,
  text: '# PDF 大纲\n第一章内容。',
  avgCharsPerPage: 400,
  scannedPages: [],
};
const SCANNED_PDF: PdfTextExtraction = {
  kind: 'scanned',
  pages: 5,
  text: '',
  avgCharsPerPage: 2,
  scannedPages: [1, 2, 3, 4, 5],
};

const DOCX_TEXT = 'DOCX 角色卡正文（mammoth 提取）。';

interface IpcOverrides {
  pdf?: PdfTextExtraction;
  docxText?: string;
}

function makeIpc(overrides: IpcOverrides = {}) {
  const notify = vi.fn();
  const now = vi.fn(() => FIXED_NOW);
  const extractPdf = vi.fn(async () => overrides.pdf ?? TEXT_PDF);
  const extractDocx = vi.fn(async () => overrides.docxText ?? DOCX_TEXT);
  const deps: InboxAttachmentIpcDeps = {
    loadConfig: () => ({}),
    probe: async () => ({ ok: false, detail: '未配置' }),
    parseEndpoint: async () => ({ ok: false, error: 'unused' }),
    extractPdf,
    extractDocx,
    now,
    notify,
  };
  const handlers: InboxAttachmentIpcHandlers = createInboxAttachmentIpc(deps);
  return { handlers, notify, now, extractPdf, extractDocx };
}

function sha256Of(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/** 确定性伪随机文本（跨 seed 零 5-gram 重叠，mirror attachmentMeta.test.ts）。 */
function lcgText(n: number, seed: number): string {
  let state = (seed >>> 0) || 1;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(0x4e00 + (state % 5000));
  }
  return out;
}

let projectDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'inbox-attach-ipc-'));
  allowPath(projectDir); // assertSafePath 授权（mirror closureChainIpc.test.ts 模式）
});

afterEach(() => {
  rmBestEffort(projectDir);
});

function writeFile(rel: string, content: string | Buffer): string {
  const full = path.join(projectDir, rel);
  // 生产路径 inbox/ 由 import-files 先建（design §1.1）；测试侧等价补建父目录。
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return rel;
}

describe('project:parse-inbox-doc', () => {
  it('txt：preview-only 直挂原件指针（不写派生 .md、不发 file:changed）', async () => {
    const { handlers, notify } = makeIpc();
    writeFile('inbox/大纲.txt', '第一行设定\n第二行设定\n第三行设定');
    const result = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/大纲.txt' });

    expect(result).toMatchObject({ ok: true, markdownPath: 'inbox/大纲.txt', via: 'direct-read' });
    expect(result.ok && result.preview).toBe('第一行设定 第二行设定 第三行设定');
    expect(existsSync(path.join(projectDir, 'inbox/大纲.md'))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('txt：preview 单行化且截到 ~200 字', async () => {
    const { handlers } = makeIpc();
    const long = Array.from({ length: 60 }, (_, i) => `第${i}行内容`).join('\n');
    writeFile('inbox/长文.txt', long);
    const result = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/长文.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview).not.toContain('\n');
    expect(result.preview.length).toBeLessThanOrEqual(200);
    expect(result.preview.startsWith('第0行内容 第1行内容')).toBe(true);
  });

  it('docx：解析派生 inbox/<原名>.md 落盘 + file:changed（import-files 先例形态）', async () => {
    const { handlers, notify } = makeIpc();
    writeFile('inbox/角色卡.docx', Buffer.from('docx-bytes'));
    const result = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });

    expect(result).toMatchObject({ ok: true, markdownPath: 'inbox/角色卡.md', via: 'builtin-mammoth' });
    expect(readFileSync(path.join(projectDir, 'inbox/角色卡.md'), 'utf-8')).toBe(DOCX_TEXT);
    expect(notify).toHaveBeenCalledWith({ type: 'file:changed', projectPath: projectDir, path: '/inbox/角色卡.md' });
  });

  it('pdf：内置文本层解析派生 .md（via=builtin-pdfjs）', async () => {
    const { handlers, notify } = makeIpc();
    writeFile('inbox/设定.pdf', '%PDF-fixture');
    const result = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/设定.pdf' });

    expect(result).toMatchObject({ ok: true, markdownPath: 'inbox/设定.md', via: 'builtin-pdfjs' });
    expect(readFileSync(path.join(projectDir, 'inbox/设定.md'), 'utf-8')).toContain('PDF 大纲');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('扫描件 PDF：ok:false + kind=scanned 指引（配 docParser 端点/识图模型），原件保留、不写派生件', async () => {
    const { handlers, notify } = makeIpc({ pdf: SCANNED_PDF });
    writeFile('inbox/扫描件.pdf', '%PDF-fixture');
    const result = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/扫描件.pdf' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('scanned');
    expect(result.error).toContain('疑似扫描件');
    expect(result.error).toContain('MinerU / docling');
    expect(result.error).toContain('识图模型');
    expect(result.error).toContain('原件已保留');
    expect(existsSync(path.join(projectDir, 'inbox/扫描件.pdf'))).toBe(true);
    expect(existsSync(path.join(projectDir, 'inbox/扫描件.md'))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('路径逃逸 / 非 inbox 路径 → ok:false 前缀拒收（CR-005；assertWithinProject 退居 belt）', async () => {
    const { handlers } = makeIpc();
    // CR-005 后三 IPC 入口强制 inbox/ 前缀：'../x'、绝对路径、'inbox/../x'（归一逃逸）
    // 一律 ok:false（renderer 传错路径是预期失败，模式 A），不再走 throw 路径。
    for (const bad of ['../outside.txt', path.resolve(os.tmpdir(), 'evil.txt'), 'inbox/../大纲.md']) {
      const r = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('仅支持 inbox/ 内文件');
    }
  });

  it('非 UTF-8（GBK）txt：preview 抑制为空 + 转换提示进 notes（不喂乱码）', async () => {
    const { handlers } = makeIpc();
    // 「设定」的 GBK 字节（C9 E8 B6 A8）× 30——按 UTF-8 解码 = 近全替换符。
    const gbkBytes: number[] = [];
    for (let i = 0; i < 30; i += 1) gbkBytes.push(0xc9, 0xe8, 0xb6, 0xa8);
    writeFile('inbox/gbk.txt', Buffer.from(gbkBytes));
    const result = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/gbk.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview).toBe('');
    expect(result.notes.join('\n')).toContain('疑似非 UTF-8');
    expect(result.notes.join('\n')).toContain('建议先转存为 UTF-8');
  });

  it('不支持的格式 / 文件不存在 / 参数无效 → ok:false 友好错误', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/book.epub', Buffer.from('zip'));
    const unsupported = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/book.epub' });
    expect(unsupported).toMatchObject({ ok: false });
    expect(!unsupported.ok && unsupported.error).toContain('不支持的附件格式');

    const missing = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/nope.docx' });
    expect(!missing.ok && missing.error).toContain('文件不存在');

    const invalid = await handlers.parseInboxDoc({ projectPath: '', filePath: '' });
    expect(!invalid.ok && invalid.error).toContain('参数无效');
  });
});

describe('project:resolve-inbox-attachment 协议（design §1.2c）', () => {
  it('fresh：双 miss 返 reused:false（无 description），不写 sidecar', async () => {
    const { handlers } = makeIpc();
    const content = lcgText(2_000, 42);
    writeFile('inbox/新大纲.md', content);
    const result = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/新大纲.md' });

    expect(result).toMatchObject({
      ok: true,
      contentHash: sha256Of(content),
      reused: false,
      derivedPath: 'inbox/新大纲.md',
    });
    expect(result.ok && result.description).toBeUndefined();
    expect(result.ok && result.describedAt).toBeUndefined();
    expect(existsSync(path.join(projectDir, '.orison/attachment-meta.json'))).toBe(false);
  });

  it('store：回写 sidecar（hash/sample shell 现算、generatedAt=now），随后 resolve 精确命中', async () => {
    const { handlers } = makeIpc();
    const content = lcgText(2_000, 42);
    writeFile('inbox/大纲.md', content);

    const stored = await handlers.storeAttachmentDescription({
      projectPath: projectDir,
      filePath: 'inbox/大纲.md',
      description: '二战背景的群像大纲',
    });
    expect(stored).toMatchObject({ ok: true, contentHash: sha256Of(content) });

    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries).toHaveLength(1);
    expect(meta.entries[0]).toMatchObject({
      contentHash: sha256Of(content),
      lastSeenPath: 'inbox/大纲.md',
      derivedOf: null,
      description: '二战背景的群像大纲',
      generatedAt: FIXED_NOW,
      sample: content.slice(0, 8_000),
    });

    const resolved = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/大纲.md' });
    expect(resolved).toMatchObject({
      ok: true,
      reused: 'exact',
      description: '二战背景的群像大纲',
      describedAt: FIXED_NOW,
      contentHash: sha256Of(content),
    });
  });

  it('改名重传：同内容不同文件名 → 哈希精确命中（身份跟内容走）+ lastSeenPath 更新', async () => {
    const { handlers } = makeIpc();
    const content = lcgText(2_000, 42);
    writeFile('inbox/原名.md', content);
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/原名.md', description: '定性' });

    writeFile('inbox/改名后.md', content);
    const resolved = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/改名后.md' });
    expect(resolved).toMatchObject({ ok: true, reused: 'exact', description: '定性', describedAt: FIXED_NOW });

    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries[0]!.lastSeenPath).toBe('inbox/改名后.md');
  });

  it('similar（小改 ≥80%）：复用描述，条目迁移新 hash/sample，generatedAt 不动', async () => {
    const { handlers } = makeIpc();
    const base = lcgText(2_000, 42);
    writeFile('inbox/大纲.md', base);
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/大纲.md', description: '原描述' });

    // 小幅修改：保留开头 + 追加 ~20% 新内容（Jaccard ≈ 0.83 ≥ 0.8）。
    const edited = base + lcgText(400, 777);
    writeFile('inbox/大纲.md', edited);
    const resolved = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/大纲.md' });

    expect(resolved).toMatchObject({
      ok: true,
      reused: 'similar',
      description: '原描述',
      describedAt: FIXED_NOW, // 相似命中不刷新 generatedAt（R1.2c）
      contentHash: sha256Of(edited),
    });

    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries).toHaveLength(1); // 迁移而非新建
    expect(meta.entries[0]).toMatchObject({
      contentHash: sha256Of(edited),
      sample: edited.slice(0, 8_000),
      generatedAt: FIXED_NOW, // 不随相似命中刷新
    });

    // 迁移后再 resolve 同内容 → 精确命中（下次零差分）。
    const again = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/大纲.md' });
    expect(again).toMatchObject({ ok: true, reused: 'exact' });
  });

  it('大幅改写（<80%）→ fresh（不误复用旧描述）', async () => {
    const { handlers } = makeIpc();
    const base = lcgText(2_000, 42);
    writeFile('inbox/大纲.md', base);
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/大纲.md', description: '旧描述' });

    const rewritten = base.slice(0, 600) + lcgText(1_400, 999);
    writeFile('inbox/大纲.md', rewritten);
    const resolved = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/大纲.md' });
    expect(resolved).toMatchObject({ ok: true, reused: false });
    expect(resolved.ok && resolved.description).toBeUndefined();
  });

  it('mtime 协议：docx 原件晚于派生 .md → resolve 重解析并更新派生件（+ file:changed）', async () => {
    const { handlers, notify, extractDocx } = makeIpc({ docxText: '第一版内容' });
    writeFile('inbox/角色卡.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    expect(extractDocx).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(projectDir, 'inbox/角色卡.md'), 'utf-8')).toBe('第一版内容');
    // CR-005：重解析覆盖派生件需 sidecar 溯源在案（两因子验证之一）——先回写一条
    // 描述建立 provenance 记录（生产流 A3 中 description 回写本就在解析后即发生）。
    await handlers.storeAttachmentDescription({
      projectPath: projectDir,
      filePath: 'inbox/角色卡.docx',
      description: '角色设定',
    });

    // 原件 mtime 推到未来 → 派生件过期 → resolve 触发重解析。
    const future = new Date(Date.now() + 10_000);
    utimesSync(path.join(projectDir, 'inbox/角色卡.docx'), future, future);

    const v2 = makeIpc({ docxText: '第二版内容（原件已改）' });
    const before = v2.extractDocx.mock.calls.length;
    const resolved = await v2.handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    expect(v2.extractDocx.mock.calls.length).toBe(before + 1);
    expect(resolved).toMatchObject({ ok: true, derivedPath: 'inbox/角色卡.md', contentHash: sha256Of('第二版内容（原件已改）') });
    expect(readFileSync(path.join(projectDir, 'inbox/角色卡.md'), 'utf-8')).toBe('第二版内容（原件已改）');
    expect(v2.notify).toHaveBeenCalledWith({ type: 'file:changed', projectPath: projectDir, path: '/inbox/角色卡.md' });
    void notify;
  });

  it('派生件新鲜：resolve 零解析直读派生 .md（extract 不再被调）', async () => {
    const { handlers, extractDocx } = makeIpc();
    writeFile('inbox/角色卡.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    const callsAfterParse = extractDocx.mock.calls.length;

    const resolved = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    expect(extractDocx.mock.calls.length).toBe(callsAfterParse); // 未重解析
    expect(resolved).toMatchObject({ ok: true, reused: false, derivedPath: 'inbox/角色卡.md', contentHash: sha256Of(DOCX_TEXT) });
  });

  it('resolve 扫描件 / store 参数无效 → ok:false', async () => {
    const { handlers } = makeIpc({ pdf: SCANNED_PDF });
    writeFile('inbox/扫描件.pdf', '%PDF-fixture');
    const scanned = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/扫描件.pdf' });
    expect(scanned).toMatchObject({ ok: false, kind: 'scanned' });

    const badStore = await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/扫描件.pdf', description: '   ' });
    expect(!badStore.ok && badStore.error).toContain('参数无效');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CR patch（09-01 SH-a）：CR-005 前缀/覆盖守卫 · CR-008 串行 · CR-010 notes
// · CR-013 TOCTOU · CR-014 docx 空文本 · CR-017 溯源不盲覆
// ═══════════════════════════════════════════════════════════════════

describe('CR-005：inbox/ 前缀守卫（三入口一致）', () => {
  it('非 inbox 前缀 / 归一逃逸 / 纯目录段 → ok:false 仅支持 inbox/ 内文件', async () => {
    const { handlers } = makeIpc();
    const badPaths = [
      'chapters/第一章.md',
      '设定/世界观.md',
      'inbox',
      'inbox/',
      'inbox/../大纲.md',
      '../outside.txt',
      path.resolve(os.tmpdir(), 'evil.docx'),
    ];
    for (const filePath of badPaths) {
      const r = await handlers.parseInboxDoc({ projectPath: projectDir, filePath });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('仅支持 inbox/ 内文件');
    }
    const r2 = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'chapters/x.md' });
    expect(!r2.ok && r2.error).toContain('仅支持 inbox/ 内文件');
    const r3 = await handlers.storeAttachmentDescription({
      projectPath: projectDir,
      filePath: 'chapters/x.md',
      description: 'd',
    });
    expect(!r3.ok && r3.error).toContain('仅支持 inbox/ 内文件');
  });

  it('前导斜杠 / 内部点段归一后放行（返回归一 posix 路径）', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/斜杠.txt', '内容一行');
    const r = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: '/inbox/斜杠.txt' });
    expect(r).toMatchObject({ ok: true, markdownPath: 'inbox/斜杠.txt' });

    writeFile('inbox/点段.txt', '内容两行');
    const r2 = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/./点段.txt' });
    expect(r2).toMatchObject({ ok: true, markdownPath: 'inbox/点段.txt' });
  });
});

describe('CR-005：派生目标覆盖守卫（防 renderer 覆盖用户既有 .md）', () => {
  it('既有 .md 非本管线派生（sidecar 冷 + 内容不符）→ 拒写；内容原样保留、无事件', async () => {
    const { handlers, notify } = makeIpc();
    writeFile('inbox/笔记.docx', Buffer.from('docx-bytes'));
    writeFile('inbox/笔记.md', '用户手写的笔记——不是派生文件');
    const r = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/笔记.docx' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('无法确认');
    expect(r.error).toContain('拒绝写入');
    expect(readFileSync(path.join(projectDir, 'inbox/笔记.md'), 'utf-8')).toBe('用户手写的笔记——不是派生文件');
    expect(notify).not.toHaveBeenCalled();
  });

  it('溯源在案 + 盘上未手改 → 原件更新后的重解析放行覆盖（mtime 协议与守卫共存）', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/角色卡.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/角色卡.docx', description: '角色设定' });

    const future = new Date(Date.now() + 10_000);
    utimesSync(path.join(projectDir, 'inbox/角色卡.docx'), future, future);
    const v2 = makeIpc({ docxText: '第二版（原件已改）' });
    const r = await v2.handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });

    expect(r).toMatchObject({ ok: true, contentHash: sha256Of('第二版（原件已改）') });
    expect(readFileSync(path.join(projectDir, 'inbox/角色卡.md'), 'utf-8')).toBe('第二版（原件已改）');
  });

  it('溯源在案但 .md 被手改（内容回声不符）→ 拒写保护用户改动', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/角色卡.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/角色卡.docx', description: '角色设定' });
    // 用户随后手改派生 .md（在案 hash 不再回声盘上内容）+ 原件前进触发重解析。
    writeFile('inbox/角色卡.md', '用户手改后的角色卡');
    const future = new Date(Date.now() + 10_000);
    utimesSync(path.join(projectDir, 'inbox/角色卡.docx'), future, future);

    const r = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/角色卡.docx' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('拒绝写入');
    expect(readFileSync(path.join(projectDir, 'inbox/角色卡.md'), 'utf-8')).toBe('用户手改后的角色卡');
  });

  it('no-op 豁免：既有内容与新解析逐字一致（sidecar 冷）→ ok 且不写盘不发事件', async () => {
    const { handlers, notify } = makeIpc();
    writeFile('inbox/大纲.docx', Buffer.from('docx-bytes'));
    writeFile('inbox/大纲.md', DOCX_TEXT); // 与解析输出逐字一致
    const r = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/大纲.docx' });

    expect(r).toMatchObject({ ok: true, markdownPath: 'inbox/大纲.md' });
    expect(readFileSync(path.join(projectDir, 'inbox/大纲.md'), 'utf-8')).toBe(DOCX_TEXT);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('CR-008：sidecar 读-改-写串行（resolve/store 入口过锁）', () => {
  it('并发 store 不同文件：两批条目全数落盘（无 last-write-wins 丢条目）', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/a.md', lcgText(2_000, 21));
    writeFile('inbox/b.md', lcgText(2_000, 22));
    await Promise.all([
      handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/a.md', description: 'A 定性' }),
      handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/b.md', description: 'B 定性' }),
    ]);
    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries).toHaveLength(2);
    expect(meta.entries.map((e) => e.description).sort()).toEqual(['A 定性', 'B 定性']);
  });
});

describe('CR-010：resolve 透传 notes（非 UTF-8 提示可达）', () => {
  it('GBK txt：preview 抑制为空 + notes 携带转换提示', async () => {
    const { handlers } = makeIpc();
    const gbkBytes: number[] = [];
    for (let i = 0; i < 30; i += 1) gbkBytes.push(0xc9, 0xe8, 0xb6, 0xa8);
    writeFile('inbox/gbk.txt', Buffer.from(gbkBytes));
    const r = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/gbk.txt' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview).toBe('');
    expect(r.notes?.join('\n')).toContain('疑似非 UTF-8');
  });

  it('无备注时 notes 键省略（additive 形态）', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/普通.md', lcgText(2_000, 13));
    const r = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/普通.md' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('notes' in r).toBe(false);
  });
});

describe('CR-013：storeAttachmentDescription TOCTOU 守卫', () => {
  it('现盘 mtime 晚于 capturedMtime → 拒绝回写（文件已变更，描述已过时）', async () => {
    const { handlers } = makeIpc();
    const content = lcgText(2_000, 11);
    writeFile('inbox/大纲.md', content);
    const r = await handlers.storeAttachmentDescription({
      projectPath: projectDir,
      filePath: 'inbox/大纲.md',
      description: '过期描述',
      capturedMtime: 1,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('文件已变更，描述已过时');
    // 拒写后 sidecar 不落盘（过期描述不得进缓存）。
    expect(existsSync(path.join(projectDir, '.orison/attachment-meta.json'))).toBe(false);
  });

  it('capturedMtime ≥ 现盘 → 正常回写；缺省 = 守卫不启用（additive 回归）', async () => {
    const { handlers } = makeIpc();
    const content = lcgText(2_000, 12);
    writeFile('inbox/大纲.md', content);
    const current = statSync(path.join(projectDir, 'inbox/大纲.md')).mtimeMs;

    const guarded = await handlers.storeAttachmentDescription({
      projectPath: projectDir,
      filePath: 'inbox/大纲.md',
      description: '新描述',
      capturedMtime: current,
    });
    expect(guarded).toMatchObject({ ok: true, contentHash: sha256Of(content) });

    const legacy = await handlers.storeAttachmentDescription({
      projectPath: projectDir,
      filePath: 'inbox/大纲.md',
      description: '再次描述',
    });
    expect(legacy).toMatchObject({ ok: true });
  });
});

describe("CR-014：docx 空文本守卫（防 sha256('') 跨文件伪命中）", () => {
  it('extractDocx 返回纯空白 → parse-failed 拒、不落空派生 .md', async () => {
    const { handlers } = makeIpc({ docxText: '   \n\t  ' });
    writeFile('inbox/空文档.docx', Buffer.from('docx-bytes'));
    const r = await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/空文档.docx' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('文档无可提取文本');
    expect(existsSync(path.join(projectDir, 'inbox/空文档.md'))).toBe(false);
  });
});

describe('CR-017：溯源字段不盲覆（derivedOf 防系统性丢失）', () => {
  it('store 挂派生 .md 回写（derivedOf=null）不清空在案原件溯源；lastSeenPath 同哈希照常刷新', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/大纲.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/大纲.docx' });
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/大纲.docx', description: '定性 v1' });

    // 附件指针指向派生 .md（material.derivedOf = null）重生成描述——derivedOf 保持原件路径。
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/大纲.md', description: '定性 v2' });

    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries).toHaveLength(1);
    expect(meta.entries[0]!.derivedOf).toBe('inbox/大纲.docx');
    expect(meta.entries[0]!.lastSeenPath).toBe('inbox/大纲.md');
    expect(meta.entries[0]!.description).toBe('定性 v2');
  });

  it('resolve exact 命中：挂派生 .md（derivedOf=null）同样不清空在案溯源', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/大纲.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/大纲.docx' });
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/大纲.docx', description: '定性' });

    const r = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/大纲.md' });
    expect(r).toMatchObject({ ok: true, reused: 'exact', description: '定性' });

    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries[0]!.derivedOf).toBe('inbox/大纲.docx');
    expect(meta.entries[0]!.lastSeenPath).toBe('inbox/大纲.md');
  });

  it('resolve exact 命中：docx 原件改名重挂 → derivedOf 刷新为新原件路径（溯源保鲜）', async () => {
    const { handlers } = makeIpc();
    writeFile('inbox/旧名.docx', Buffer.from('docx-bytes'));
    await handlers.parseInboxDoc({ projectPath: projectDir, filePath: 'inbox/旧名.docx' });
    await handlers.storeAttachmentDescription({ projectPath: projectDir, filePath: 'inbox/旧名.docx', description: '定性' });

    // 同内容改名重传（哈希身份跟内容走）→ exact 命中 + derivedOf 刷新到新原件。
    writeFile('inbox/新名.docx', Buffer.from('docx-bytes'));
    const r = await handlers.resolveInboxAttachment({ projectPath: projectDir, filePath: 'inbox/新名.docx' });
    expect(r).toMatchObject({ ok: true, reused: 'exact', description: '定性' });

    const meta = loadAttachmentMeta(projectDir);
    expect(meta.entries[0]!.derivedOf).toBe('inbox/新名.docx');
  });
});

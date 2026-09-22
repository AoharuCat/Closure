/**
 * Story 10.1 Wave D：materialIpc（材料库管理面六通道）测试。
 *
 *   - materials:list 双 scope 车道过滤 + MaterialSummary 投影形状；坏参 throw（模式 B）。
 *   - materials:get 全行 + 派生/原件绝对路径；未知 id → null。
 *   - materials:delete **D8 四清**：原件 + 派生 .md + 登记行 + 双车道 chunk 行全清，
 *     .orison/history 快照兜底（项目车道落 <project>/.orison/history；全局车道落
 *     materials 根下 .orison/history），**二进制原件原字节快照**（CR-024——docx 走
 *     REAL mammoth 全链登记后删除，快照字节与原件全等），material:changed 广播埋点。
 *   - materials:import 拒收分类六档（格式 / 超 50MB / 超 250 批量 / **stem 冲突**
 *     〔CR-001——同批 + 磁盘既有两路〕/ **敏感源**〔CR-023——symlink/junction 经
 *     realpath 解析后命中〕/ **源缺失**〔CR-011〕）+ 部分成功语义 + uniquePath 重名避让 +
 *     逐份 imported 广播；AC7 批量规模（250 实拷 + 1 溢出）。
 *   - materials:update-provenance 五字段 patch（缺省不动 / null 清空 / 坏 medium 拒）+
 *     **COALESCE 不清既有值**（patch 后重摄取 registerMaterial 保用户策展——F-05 闭环）。
 *   - E10.2a：description 后补（patch 往返 / 空串归 null / 重摄取防清闭环 F-03）+
 *     materials:update-name 标题编辑（校验态 / UPDATE 落库 / name-updated 广播 /
 *     materialId 路径身份不变）。
 *   - materials:reingest 内容变更重摄取幂等回执。
 *
 * mock 形态 mirror materialIndexer.test.ts：electron app.getPath → TEST_HOME、
 * modelGatewayIpc resolveEmbeddingModel → null（FTS-only，零网络）、REAL
 * parseDocumentToMarkdown（txt 直读 / docx mammoth）。fixtures 全自制样文（AC11 版权红线）。
 */
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-material-ipc');
const PROJECT_DIR = path.join(TEST_HOME, 'my-project');
const SOURCES_DIR = path.join(TEST_HOME, 'sources');

// home 单源 = os.homedir()：与 electron getPath mock 同一 TEST_HOME——真 ~/.orison 零触碰。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const withHome = { ...actual, homedir: () => TEST_HOME };
  return { ...withHome, default: withHome };
});
vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));
vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
// E10.4 W2：在线拉取/搜索核心 partial mock（纯函数面保真；网络半由用例注入 stub 结果）。
const fetchOnlinePageAsMarkdownMock = vi.hoisted(() => vi.fn());
const searchOnlineSourcesCoreMock = vi.hoisted(() => vi.fn());
vi.mock('../main/ipc/toolHandlers/onlineMaterial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/ipc/toolHandlers/onlineMaterial')>();
  return {
    ...actual,
    fetchOnlinePageAsMarkdown: fetchOnlinePageAsMarkdownMock,
    searchOnlineSourcesCore: searchOnlineSourcesCoreMock,
  };
});

import { createMaterialIpcHandlers, registerMaterialIpc } from '../main/ipc/materialIpc';
import { sendMaterialChanged } from '../main/ipc/materialNotify';
import { getMaterialRow, registerMaterial } from '../main/db/materialIndexer';
import { onlineStemForUrl, onlineTruncationNote } from '../main/ipc/toolHandlers/onlineMaterial';
import { closeDb, getDb } from '../main/db/index';
import { ensureProject, getProject } from '../main/db/projectRepository';
import { allowPath } from '../main/ipc/pathGuard';
import { __clearMaterialLLMCoreForTest } from '../main/ipc/toolHandlers/materialIngest';
import { buildDocxFixture } from './fixtures/documentFixtures';
import { MATERIAL_DESCRIPTION_MAX_CHARS, MATERIAL_NAME_MAX_CHARS } from '@orison/shared-contracts';
import type { MaterialChangedEvent } from '@orison/shared-contracts';
import { rmBestEffort } from './rmBestEffort';

// better-sqlite3 ABI gate（mirror materialIndexer.test.ts）：plain-Node vitest 下 skip。
let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

const GLOBAL_MATERIALS = path.join(TEST_HOME, '.orison', 'materials');

function clean() {
  closeDb();
  rmBestEffort(TEST_HOME);
}

/** 4 章等长样文（正则 high 置信形态；mirror materialIndexer.test）。 */
function chapteredNovel(chapters = 4, bodyLen = 120): string {
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return Array.from({ length: chapters }, (_, i) => {
    const heading = `第${numerals[i]}章 风起之${i}`;
    const body = `${'墨'.repeat(bodyLen)}。\n\n${'雨'.repeat(bodyLen)}。`;
    return `${heading}\n\n${body}`;
  }).join('\n\n');
}

function writeProjectSource(rel: string, content: string): string {
  const full = path.join(PROJECT_DIR, 'materials', rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

function writeGlobalSource(rel: string, content: string): string {
  const full = path.join(GLOBAL_MATERIALS, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

function writeSourceFile(name: string, content: string): string {
  mkdirSync(SOURCES_DIR, { recursive: true });
  const full = path.join(SOURCES_DIR, name);
  writeFileSync(full, content, 'utf-8');
  return full;
}

/** 稀疏超限文件（ftruncate 到 50MB+1——零拷贝代价过大小闸）。 */
function writeSparseOversize(name: string): string {
  mkdirSync(SOURCES_DIR, { recursive: true });
  const full = path.join(SOURCES_DIR, name);
  const fd = openSync(full, 'w');
  ftruncateSync(fd, 50 * 1024 * 1024 + 1);
  closeSync(fd);
  return full;
}

function materialEntryRows(materialId: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare("SELECT * FROM closure_entry WHERE source_kind='material' AND chapter_id LIKE ? ESCAPE '\\'")
    .all(`${materialId}.ch%`) as Array<Record<string, unknown>>;
}

describe.skipIf(!sqliteUsable)('materialIpc handlers (Story 10.1 Wave D)', () => {
  let PID: string;
  const notifySpy = vi.fn<(event: MaterialChangedEvent) => void>();
  const handlers = createMaterialIpcHandlers({ notify: (e) => notifySpy(e) });

  beforeAll(() => {
    clean();
    mkdirSync(path.join(TEST_HOME, '.orison', 'data'), { recursive: true });
    mkdirSync(PROJECT_DIR, { recursive: true });
    ensureProject({
      name: 'Test',
      type: 'novel',
      localFingerprint: path.resolve(PROJECT_DIR),
      path: path.resolve(PROJECT_DIR),
    });
    PID = getProject(path.resolve(PROJECT_DIR))!.projectId;
    allowPath(path.resolve(PROJECT_DIR)); // pathGuard 允许根（resolveProjectLane assertSafePath 面）
    getDb();
  });
  afterAll(clean);

  beforeEach(() => {
    __clearMaterialLLMCoreForTest();
    notifySpy.mockClear();
    getDb().exec('DELETE FROM closure_material');
    getDb().exec("DELETE FROM closure_entry WHERE source_kind='material'");
    getDb().exec("DELETE FROM closure_craft_entry WHERE source_kind='material_chunk'");
    rmSync(path.join(PROJECT_DIR, 'materials'), { recursive: true, force: true });
    rmSync(path.join(PROJECT_DIR, '.orison', 'history'), { recursive: true, force: true });
    rmSync(GLOBAL_MATERIALS, { recursive: true, force: true });
    rmSync(SOURCES_DIR, { recursive: true, force: true });
  });

  it('materials:list 双 scope 过滤 + MaterialSummary 投影形状', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    writeGlobalSource('lecture.txt', '写作课讲义正文。');
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const gr = await registerMaterial({ scope: 'global' }, 'lecture.txt');
    expect(pr.outcome).toBe('registered');
    expect(gr.outcome).toBe('registered');

    const projectRows = await handlers.listMaterials({ scope: 'project', projectId: PID });
    expect(projectRows).toHaveLength(1);
    const row = projectRows[0]!;
    expect(row.materialId).toBe(pr.materialId);
    expect(row.scope).toBe('project');
    expect(row.projectId).toBe(PID);
    expect(row.name).toBe('novel');
    expect(row.format).toBe('txt');
    expect(row.medium).toBe('other');
    expect(row.tier).toBe('unspecified');
    expect(row.chapterCount).toBe(4);
    expect(row.chapterMethod).toBe('regex');
    expect(row.chapterConfidence).toBe('high');
    expect(row.status).toBe('ready');
    expect(row.scanned).toBe(false);
    expect(row.charCount).toBeGreaterThan(0);
    expect(row.ingestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 摘要投影：无 chapters/chunkSpans 大数组键。
    expect('chapters' in row).toBe(false);
    expect('chunkSpans' in row).toBe(false);

    const globalRows = await handlers.listMaterials({ scope: 'global' });
    expect(globalRows).toHaveLength(1);
    expect(globalRows[0]!.materialId).toBe(gr.materialId);
    expect(globalRows[0]!.scope).toBe('global');

    // 坏参 = 模式 B throw（mirror worldIpc Zod-at-boundary 形态）。
    await expect(handlers.listMaterials({ scope: 'project' })).rejects.toThrow(/projectId/);
    await expect(handlers.listMaterials({})).rejects.toThrow(/scope/);
  });

  it('materials:get 全行 + 派生/原件绝对路径；未知 id → null', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const detail = await handlers.getMaterial({ materialId: pr.materialId! });
    expect(detail).not.toBeNull();
    expect(detail!.material.materialId).toBe(pr.materialId);
    expect(detail!.material.chapters).toHaveLength(4);
    expect(detail!.derivedAbsPath).toBe(path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md'));
    expect(detail!.sourceAbsPath).toBe(path.join(PROJECT_DIR, 'materials', 'novel.txt'));
    expect(existsSync(detail!.derivedAbsPath!)).toBe(true);

    expect(await handlers.getMaterial({ materialId: 'mat-000000000000' })).toBeNull();
  });

  it('materials:delete 项目车道 D8 四清 + history 快照 + 广播', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const materialId = pr.materialId!;
    expect(materialEntryRows(materialId).length).toBeGreaterThan(0);

    const res = await handlers.deleteMaterial({ materialId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.removedSourceFile).toBe(true);
    expect(res.removedDerivedFile).toBe(true);

    // 四清：原件 + 派生 .md + 登记行 + chunk 行。
    expect(existsSync(path.join(PROJECT_DIR, 'materials', 'novel.txt'))).toBe(false);
    expect(existsSync(path.join(PROJECT_DIR, 'materials', '.derived', 'novel.md'))).toBe(false);
    expect(getMaterialRow(materialId)).toBeNull();
    expect(materialEntryRows(materialId)).toHaveLength(0);

    // history 快照兜底（原件 txt 是文本 ext → 快照；<project>/.orison/history/materials/novel.txt/）。
    const histDir = path.join(PROJECT_DIR, '.orison', 'history', 'materials', 'novel.txt');
    expect(existsSync(histDir)).toBe(true);
    const snaps = readdirSync(histDir);
    expect(snaps.length).toBeGreaterThanOrEqual(1);

    // 广播埋点。
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', projectId: PID, materialId, reason: 'deleted' }),
    );

    // 再删 → not-found（幂等回报，非静默成功）。
    const again = await handlers.deleteMaterial({ materialId });
    expect(again).toEqual({ ok: false, error: 'not-found' });
  });

  it('materials:delete 全局车道四清（快照落 materials 根下 .orison/history）', async () => {
    writeGlobalSource('lecture.txt', '写作课讲义正文，含足够内容。');
    const gr = await registerMaterial({ scope: 'global' }, 'lecture.txt');
    const materialId = gr.materialId!;

    const res = await handlers.deleteMaterial({ materialId });
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(GLOBAL_MATERIALS, 'lecture.txt'))).toBe(false);
    expect(existsSync(path.join(GLOBAL_MATERIALS, '.derived', 'lecture.md'))).toBe(false);
    expect(getMaterialRow(materialId)).toBeNull();
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM closure_craft_entry WHERE source_kind='material_chunk' AND craft_id LIKE ? ESCAPE '\\'")
        .get(`mat:${materialId}.ch%`),
    ).toEqual({ n: 0 });
    // 全局车道快照落根下 .orison/history（同「根下 .orison 安全网」形态）。
    expect(existsSync(path.join(GLOBAL_MATERIALS, '.orison', 'history', 'lecture.txt'))).toBe(true);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', materialId, reason: 'deleted' }),
    );
  });

  it('materials:import 三档拒收分类 + 部分成功 + uniquePath + 逐份广播', async () => {
    const good = writeSourceFile('novel.txt', chapteredNovel(3));
    const bad1 = writeSourceFile('trailer.mp4', 'binary-ish');
    const bad2 = writeSparseOversize('huge.txt');

    const res = await handlers.importMaterials({
      scope: 'project',
      projectId: PID,
      absolutePaths: [good, bad1, bad2],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imported).toHaveLength(1);
    expect(res.imported[0]!.name).toBe('novel.txt');
    expect(res.imported[0]!.relPath).toBe('novel.txt');
    expect(res.imported[0]!.materialId).toMatch(/^mat-[0-9a-f]{12}$/);
    // 三档分类（格式 / 大小）——kind 机器可读，UI 按档分文案。
    expect(res.rejected).toEqual(
      expect.arrayContaining([
        { name: 'trailer.mp4', kind: 'unsupported-format' },
        { name: 'huge.txt', kind: 'too-large' },
      ]),
    );
    expect(res.rejected).toHaveLength(2);
    expect(res.failed).toHaveLength(0);
    // 拷入 + 登记落地。
    expect(existsSync(path.join(PROJECT_DIR, 'materials', 'novel.txt'))).toBe(true);
    expect(getMaterialRow(res.imported[0]!.materialId!)).not.toBeNull();
    // 逐份 imported 广播（进度可见）。
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', projectId: PID, reason: 'imported' }),
    );

    // 同名再导入 → uniquePath 重名序号（novel-1.txt）。
    const again = await handlers.importMaterials({ scope: 'project', projectId: PID, absolutePaths: [good] });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.imported[0]!.relPath).toBe('novel-1.txt');
  });

  it('materials:import 批量 250 上限（AC7 独立上限）+ 溢出整批回报', async () => {
    // 250 份微型样文实拷（AC7 批量规模真验）+ 1 份溢出。
    const many: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      many.push(writeSourceFile(`bulk-${String(i).padStart(3, '0')}.txt`, `第${i}节\n\n样文正文。`));
    }
    const overflow = writeSourceFile('overflow.txt', '溢出件。');
    const res = await handlers.importMaterials({
      scope: 'global',
      absolutePaths: [...many, overflow],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imported).toHaveLength(250);
    expect(res.rejected).toEqual([{ name: 'overflow.txt', kind: 'batch-overflow' }]);
    expect(res.failed).toHaveLength(0);
    expect(notifySpy).toHaveBeenCalledTimes(250);
  }, 60_000);

  it('materials:import 同 stem 异扩展拒收 stem-conflict（CR-001）——同批 + 磁盘既有 + 同扩展豁免', async () => {
    // 同批：foo.txt + foo.md → 派生 .md 镜像 `.derived/foo.md` 同路径互覆写——后到者拒收。
    const fooTxt = writeSourceFile('foo.txt', chapteredNovel(3));
    const fooMd = writeSourceFile('foo.md', chapteredNovel(3));
    const res = await handlers.importMaterials({
      scope: 'project',
      projectId: PID,
      absolutePaths: [fooTxt, fooMd],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imported.map((i) => i.name)).toEqual(['foo.txt']);
    expect(res.rejected).toEqual([{ name: 'foo.md', kind: 'stem-conflict' }]);
    expect(existsSync(path.join(PROJECT_DIR, 'materials', 'foo.md'))).toBe(false);

    // 同 stem **同**扩展不受 stem-conflict 拦（走 uniquePath 重名序号——既有语义保持）。
    const sameExt = await handlers.importMaterials({
      scope: 'project',
      projectId: PID,
      absolutePaths: [fooTxt, fooTxt],
    });
    expect(sameExt.ok).toBe(true);
    if (!sameExt.ok) return;
    expect(sameExt.rejected).toEqual([]);
    expect(sameExt.imported.map((i) => i.relPath)).toEqual(['foo-1.txt', 'foo-2.txt']);

    // 磁盘既有（未登记也拦——覆盖「拷入成功登记失败/watcher 待自愈」窗口与手工放入件）：
    // materials/ 根已有 novel.txt，导入 novel.pdf → 拒收。
    writeProjectSource('novel.txt', chapteredNovel(2));
    const novelPdf = writeSourceFile('novel.pdf', 'pdf-bytes（拒收于拷入前，内容不解析）');
    const disk = await handlers.importMaterials({
      scope: 'project',
      projectId: PID,
      absolutePaths: [novelPdf],
    });
    expect(disk.ok).toBe(true);
    if (!disk.ok) return;
    expect(disk.rejected).toEqual([{ name: 'novel.pdf', kind: 'stem-conflict' }]);
    expect(disk.imported).toHaveLength(0);
  });

  it('materials:import 敏感源 symlink/junction 经 realpath 解析后拒收 sensitive（CR-011/023）', async () => {
    // isSensitiveImportSource 的 deny 清单以 os.homedir() 为基——spy 到 TEST_HOME
    //（realpath 归一，防 8.3 短路径/macOS /var 两形态失配）。
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(realpathSync(TEST_HOME));
    try {
      const sshDir = path.join(TEST_HOME, '.ssh');
      mkdirSync(sshDir, { recursive: true });
      writeFileSync(path.join(sshDir, 'secret.txt'), 'top secret', 'utf-8');
      // 链接目录进拖拽源（win32 junction 免管理员；unix symlink）——path.resolve 不解析，
      // 修复前凭「链接自身路径不在清单」绕过敏感门（CR-023 实测锚）。
      mkdirSync(SOURCES_DIR, { recursive: true }); // beforeEach 清过——symlink 需父目录在
      const linkDir = path.join(SOURCES_DIR, 'sec-link');
      symlinkSync(sshDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
      const viaLink = path.join(linkDir, 'secret.txt');
      expect(existsSync(viaLink)).toBe(true);

      const res = await handlers.importMaterials({
        scope: 'project',
        projectId: PID,
        absolutePaths: [viaLink],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rejected).toEqual([{ name: 'secret.txt', kind: 'sensitive' }]);
      expect(res.imported).toHaveLength(0);
      // 未拷入材料库（敏感内容零落盘）。
      expect(existsSync(path.join(PROJECT_DIR, 'materials', 'secret.txt'))).toBe(false);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('materials:import 源消失（TOCTOU）拒收 missing（CR-011——不复用 unsupported-format）', async () => {
    const res = await handlers.importMaterials({
      scope: 'project',
      projectId: PID,
      absolutePaths: [path.join(SOURCES_DIR, 'gone.txt')],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected).toEqual([{ name: 'gone.txt', kind: 'missing' }]);
    expect(res.failed).toHaveLength(0);
  });

  it('materials:delete 二进制原件原字节快照兜底（CR-024——docx 全链登记→删除→快照全等）', async () => {
    const docx = buildDocxFixture('二进制删除快照样文');
    const full = path.join(PROJECT_DIR, 'materials', 'sample.docx');
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, docx);
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'sample.docx');
    expect(pr.outcome).toBe('registered');

    const res = await handlers.deleteMaterial({ materialId: pr.materialId! });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(full)).toBe(false);

    // localHistory 的 TEXT_EXT_RE 排除 docx——本路径原字节直拷补齐（确认弹窗承诺成立）。
    const histDir = path.join(PROJECT_DIR, '.orison', 'history', 'materials', 'sample.docx');
    expect(existsSync(histDir)).toBe(true);
    const snaps = readdirSync(histDir).sort();
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(path.join(histDir, snaps[snaps.length - 1]!)).equals(docx)).toBe(true);
    // 派生 .md（文本面）仍走既有 localHistory 快照。
    expect(existsSync(path.join(PROJECT_DIR, '.orison', 'history', 'materials', '.derived'))).toBe(true);
  });

  it('materials:import 坏参 / 未注册 projectId', async () => {
    expect(await handlers.importMaterials({ scope: 'project', absolutePaths: ['C:/x.txt'] })).toEqual(
      expect.objectContaining({ ok: false, error: 'unregistered' }),
    );
    expect(await handlers.importMaterials({ scope: 'global', absolutePaths: [] })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-input' }),
    );
    expect(await handlers.importMaterials({ scope: 'project', projectId: '99999', absolutePaths: ['C:/x.txt'] })).toEqual(
      expect.objectContaining({ ok: false, error: 'unregistered' }),
    );
  });

  it('materials:update-provenance 五字段 patch + COALESCE 重摄取不清既有值（F-05 闭环）', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const materialId = pr.materialId!;

    // patch：缺省字段不动（只给 medium + author）。
    const res = await handlers.updateProvenance({ materialId, patch: { medium: 'novel_text', author: '原作者甲' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.material.provenance.medium).toBe('novel_text');
    expect(res.material.provenance.author).toBe('原作者甲');
    expect(res.material.provenance.tier).toBe('unspecified'); // 缺省不动
    expect(res.material.provenance.lang).toBeNull();

    // 🔑 COALESCE 闭环：patch 后重摄取（watcher/reingest 同路）不清用户策展值。
    const re = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    expect(re.outcome).toBe('reused');
    const afterReingest = getMaterialRow(materialId)!;
    expect(afterReingest.provenance.medium).toBe('novel_text');
    expect(afterReingest.provenance.author).toBe('原作者甲');

    // null 清空 + tier 改档。
    const res2 = await handlers.updateProvenance({ materialId, patch: { author: null, tier: 'community', lang: 'zh' } });
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.material.provenance.author).toBeNull();
    expect(res2.material.provenance.tier).toBe('community');
    expect(res2.material.provenance.lang).toBe('zh');

    // 坏 patch 拒（空 medium）+ 未知材料 not-found。
    expect(await handlers.updateProvenance({ materialId, patch: { medium: '  ' } })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-patch' }),
    );
    expect(await handlers.updateProvenance({ materialId: 'mat-000000000000', patch: { author: 'x' } })).toEqual(
      expect.objectContaining({ ok: false, error: 'not-found' }),
    );
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ materialId, reason: 'provenance-updated' }),
    );
  });

  it('materials:update-provenance description 后补（E10.2a）：patch 往返 + 空串归 null + 重摄取防清闭环', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const materialId = pr.materialId!;
    expect(getMaterialRow(materialId)!.provenance.description).toBeNull(); // 摄取期缺省 null

    // 后补简介（多行文本——patch 面与 author 三字段同型）。
    const res = await handlers.updateProvenance({
      materialId,
      patch: { description: 'B 站经验视频：如何铺垫情绪与信息差' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.material.provenance.description).toBe('B 站经验视频：如何铺垫情绪与信息差');
    expect(getMaterialRow(materialId)!.provenance.description).toBe('B 站经验视频：如何铺垫情绪与信息差');

    // 🔑 F-03 防清闭环：后补后重摄取（watcher/reingest 同路）——preserveCuratedProvenance
    // 保留用户简介（description 与 author/medium 同列 COALESCE，F-03）。
    const re = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    expect(re.outcome).toBe('reused');
    expect(getMaterialRow(materialId)!.provenance.description).toBe('B 站经验视频：如何铺垫情绪与信息差');

    // 空串 / 纯空白归 null（表单空输入语义，同 author 三字段）。
    const cleared = await handlers.updateProvenance({ materialId, patch: { description: '   ' } });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.material.provenance.description).toBeNull();
    // 显式 null 同效（清空语义）。
    const explicitNull = await handlers.updateProvenance({ materialId, patch: { description: null } });
    expect(explicitNull.ok).toBe(true);
    expect(getMaterialRow(materialId)!.provenance.description).toBeNull();

    // 坏类型拒（invalid-patch——rawInput unknown 面的运行时防御）。
    expect(await handlers.updateProvenance({ materialId, patch: { description: 42 } })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-patch' }),
    );

    // CR-6：简介长度上限三处齐的 handler 面（单源 MATERIAL_DESCRIPTION_MAX_CHARS）——
    // 恰上限字数合法；+1 字 invalid-input（mirror update-name 超长档；textarea maxLength
    // 是 UX 面，paste/程序调用仍可超，handler 是权威闸）。
    const exactLen = await handlers.updateProvenance({
      materialId,
      patch: { description: '简'.repeat(MATERIAL_DESCRIPTION_MAX_CHARS) },
    });
    expect(exactLen.ok).toBe(true);
    expect(
      await handlers.updateProvenance({
        materialId,
        patch: { description: '简'.repeat(MATERIAL_DESCRIPTION_MAX_CHARS + 1) },
      }),
    ).toEqual(expect.objectContaining({ ok: false, error: 'invalid-input' }));
  });

  it('materials:update-name 标题编辑（E10.2a）：校验态（空/超长/缺字段）+ UPDATE 落库 + name-updated 广播 + materialId 不变', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const materialId = pr.materialId!;

    // 合法改名（trim 生效）：name 列更新，materialId 路径身份不变（design §3.1）。
    const res = await handlers.updateName({ materialId, name: '  我的视频标题  ' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.material.name).toBe('我的视频标题');
    expect(res.material.materialId).toBe(materialId);
    expect(getMaterialRow(materialId)!.name).toBe('我的视频标题');
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', projectId: PID, materialId, reason: 'name-updated' }),
    );

    // 边界：恰 MATERIAL_NAME_MAX_CHARS 字合法；+1 字 invalid-input（上限单源 shared-contracts）。
    const exact = await handlers.updateName({ materialId, name: '标'.repeat(MATERIAL_NAME_MAX_CHARS) });
    expect(exact.ok).toBe(true);
    expect(await handlers.updateName({ materialId, name: '标'.repeat(MATERIAL_NAME_MAX_CHARS + 1) })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-input' }),
    );

    // 空白 / 缺 name / 非字符串（rawInput unknown 面运行时防御）/ 未知材料 not-found。
    expect(await handlers.updateName({ materialId, name: '   ' })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-input' }),
    );
    expect(await handlers.updateName({ materialId })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-input' }),
    );
    expect(await handlers.updateName({ materialId, name: 42 })).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-input' }),
    );
    expect(await handlers.updateName({ materialId: 'mat-000000000000', name: 'x' })).toEqual(
      expect.objectContaining({ ok: false, error: 'not-found' }),
    );
    // 校验失败零广播（notifySpy 上面的合法路径已计入——此处只验失败面不新增）。
    const callsBefore = notifySpy.mock.calls.length;
    await handlers.updateName({ materialId, name: '' });
    expect(notifySpy.mock.calls.length).toBe(callsBefore);
  });

  it('materials:reingest 内容变更重摄取 + 未知材料', async () => {
    writeProjectSource('novel.txt', chapteredNovel());
    const pr = await registerMaterial({ scope: 'project', projectDir: PROJECT_DIR }, 'novel.txt');
    const materialId = pr.materialId!;
    const hashBefore = getMaterialRow(materialId)!.contentHash;

    // 原件未变 → reused（沿用存档章界）。
    const same = await handlers.reingestMaterial({ materialId });
    expect(same).toEqual({ ok: true, outcome: 'reused', materialId });

    // 🔑 标题防清（E10.2a 收口 patch）：用户改题后经最重路径验证——
    expect((await handlers.updateName({ materialId, name: '我的视频标题' })).ok).toBe(true);

    // 内容变更 → 重摄取（outcome registered + hash 变化）。
    writeProjectSource('novel.txt', chapteredNovel(5));
    const changed = await handlers.reingestMaterial({ materialId });
    expect(changed).toEqual({ ok: true, outcome: 'registered', materialId });
    expect(getMaterialRow(materialId)!.contentHash).not.toBe(hashBefore);
    expect(getMaterialRow(materialId)!.chapters).toHaveLength(5);
    // 完整重摄取不清用户标题（既有 name ≠ stem 必为策展值——materialId 路径身份、
    // 同路径 stem 恒定；mirror preserveCuratedProvenance 哲学）。
    expect(getMaterialRow(materialId)!.name).toBe('我的视频标题');
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ materialId, reason: 'reingested' }),
    );

    expect(await handlers.reingestMaterial({ materialId: 'mat-000000000000' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('registerMaterialIpc 注册零抛（ipcMain mock 收七个通道）', () => {
    expect(() => registerMaterialIpc()).not.toThrow();
    expect(typeof sendMaterialChanged).toBe('function');
  });

  // ── E10.4 W2：materials:import-online / materials:search-online ──

  describe('E10.4 在线导入与关键词发现（W2）', () => {
    const WIKI_URL = 'https://zh.moegirl.org.cn/明日方舟';

    /** 在线抽取成功 fixture（onlineMaterial.fetchOnlinePageAsMarkdown 的 partial mock 返回值）。 */
    function extractionFixture(overrides: Record<string, unknown> = {}) {
      return {
        ok: true as const,
        content: chapteredNovel(3),
        truncated: false,
        originalChars: chapteredNovel(3).length,
        title: '明日方舟',
        finalUrl: WIKI_URL,
        author: null,
        originDate: null,
        ...overrides,
      };
    }

    function globalChunkRowCount(materialId: string): number {
      return (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM closure_craft_entry WHERE source_kind='material_chunk' AND craft_id LIKE ? ESCAPE '\\'",
          )
          .get(`mat:${materialId}.ch%`) as { n: number }
      ).n;
    }

    beforeEach(() => {
      fetchOnlinePageAsMarkdownMock.mockReset();
      searchOnlineSourcesCoreMock.mockReset();
    });

    it('快乐路径（全局车道，community-wiki）：落盘 materials/online/ + provenance 预填 + 双车道 chunk + 广播', async () => {
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture());
      const res = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const fileName = res.sourcePath; // 全局车道 sourcePath 恒等车道内相对路径
      expect(fileName).toMatch(/^online\/明日方舟-[0-9a-f]{8}\.md$/);
      expect(res.outcome).toBe('registered');
      expect(res.truncated).toBe(false);
      expect(res.name).toBe('明日方舟');

      // 落盘：原件（抽取文本即原件）+ 派生 .md（分章标记）。
      expect(existsSync(path.join(GLOBAL_MATERIALS, res.sourcePath))).toBe(true);
      expect(existsSync(path.join(GLOBAL_MATERIALS, '.derived', 'online', path.basename(res.sourcePath)))).toBe(true);

      // 登记行：provenance 预填（P2 seam）+ 页面标题显示名。
      const row = getMaterialRow(res.materialId)!;
      expect(row).not.toBeNull();
      expect(row!.provenance.medium).toBe('wiki');
      expect(row!.provenance.tier).toBe('community');
      expect(row!.provenance.via).toBe('web-fetch');
      expect(row!.provenance.url).toBe(WIKI_URL);
      expect(row!.name).toBe('明日方舟');
      expect(row!.status).toBe('ready');

      // 全局车道 chunk 行（query_craft 检索面——AC1 消费断言）。
      expect(globalChunkRowCount(res.materialId)).toBeGreaterThan(0);

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'global', projectId: null, materialId: res.materialId, reason: 'imported' }),
      );
    });

    it('同 URL 重导：内容未变 → reused 幂等（AC4）；内容变更 → reingest 语义且行刷新', async () => {
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture());
      const first = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const hashBefore = getMaterialRow(first.materialId)!.contentHash;

      // 内容未变 → reused（幂等 skip，不重复烧登记）。
      const again = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(again).toMatchObject({ ok: true, outcome: 'reused', materialId: first.materialId });
      // CR-15：reused 如实广播（'reingested' 对未变内容语义误导；additive enum，UI refresh-only）。
      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ materialId: first.materialId, reason: 'reused' }),
      );
      expect(getMaterialRow(first.materialId)!.contentHash).toBe(hashBefore);

      // 内容变更 → registered（reingest 语义）：派生与 hash 刷新，行仍单条。
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture({ content: chapteredNovel(5), title: '明日方舟' }));
      const changed = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(changed).toMatchObject({ ok: true, outcome: 'registered', materialId: first.materialId });
      expect(getMaterialRow(first.materialId)!.contentHash).not.toBe(hashBefore);
      expect(getMaterialRow(first.materialId)!.chapters).toHaveLength(5);
      const listed = await handlers.listMaterials({ scope: 'global' });
      expect(listed.filter((m) => m.materialId === first.materialId)).toHaveLength(1);
    });

    it('类别→medium/tier 映射矩阵（R3 四档，各 URL 独立材料行）', async () => {
      const cases: Array<{ category: string; url: string; medium: string; tier: string }> = [
        { category: 'community-wiki', url: 'https://zh.moegirl.org.cn/阿米娅', medium: 'wiki', tier: 'community' },
        { category: 'criticism', url: 'https://example.com/review/arknights', medium: 'criticism', tier: 'criticism' },
        { category: 'author-interview', url: 'https://example.com/interview/writer', medium: 'interview', tier: 'original' },
        { category: 'other', url: 'https://example.com/misc/page', medium: 'other', tier: 'unspecified' },
      ];
      for (const c of cases) {
        fetchOnlinePageAsMarkdownMock.mockResolvedValue(
          extractionFixture({ finalUrl: c.url, title: '页面标题' }),
        );
        const res = await handlers.importOnlineMaterial({ url: c.url, scope: 'global', category: c.category });
        expect(res.ok).toBe(true);
        if (!res.ok) continue;
        const row = getMaterialRow(res.materialId)!;
        expect(row!.provenance.medium).toBe(c.medium);
        expect(row!.provenance.tier).toBe(c.tier);
      }
    });

    it('长页截断如实（W2 接线半）：IPC 行 truncated + quality.parseNotes 截断注记 + author/originDate 预填', async () => {
      // 抽取半（truncated 标记/尾注内容/元数据提取）归 onlineMaterial.test.ts；本用例钉
      // IPC 登记半的 extraParseNotes 与 provenanceOverrides 条件展开接线（author/originDate
      // 取到才写的 spread 分支——快乐路径 author:null 只盖缺席侧）。
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture({
        truncated: true,
        originalChars: 450_000,
        author: '考据作者',
        originDate: '2024-05-01',
      }));
      const res = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.truncated).toBe(true);
      const row = getMaterialRow(res.materialId)!;
      expect(row).not.toBeNull();
      // extraParseNotes 单源注记落 quality.parseNotes（截断 parseNote 持久面之一——后续
      // 重解析按解析面重建会冲掉，best-effort 面已注记于 seam 注释）。
      expect(row!.quality.parseNotes).toContain(onlineTruncationNote(450_000));
      expect(row!.provenance.author).toBe('考据作者');
      expect(row!.provenance.originDate).toBe('2024-05-01');
    });

    it('P2 竞态 belt：watcher 式默认 provenance 重登记不清预填（COALESCE 半）', async () => {
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture());
      const res = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // 模拟 watcher 对落盘事件的晚到 registerMaterial（无 overrides——默认 provenance 产物）。
      // CR-17 据实钉死（判定链 materialIngest :1214-1233）：登记行已在（首登完成）+ 原件未变
      // + 派生 .md 往返稳定 → REUSE 裁决 outcome='reused' 单一确定；'registered' 臂需要内容
      // 变更或派生人工编辑（reingest-skipped-manual 折叠进 registered），本场景两者皆无。
      const watcherLike = await registerMaterial({ scope: 'global' }, res.sourcePath);
      expect(watcherLike.outcome).toBe('reused');
      const row = getMaterialRow(res.materialId)!;
      // 预填保留（tier/medium/url 非 null 既有值 COALESCE 优先；标题名策展防清）。
      expect(row!.provenance.tier).toBe('community');
      expect(row!.provenance.medium).toBe('wiki');
      expect(row!.provenance.url).toBe(WIKI_URL);
      expect(row!.name).toBe('明日方舟');
      // via 是管线事实字段（恒取本轮解析路径）——watcher 重解析按设计落本轮值，非预填流失。
      expect(row!.provenance.via).not.toBe('web-fetch');
    });

    it('sha8 撞库加宽（CR-4）：stem 已占且登记行 provenance.url 异源 → hash 加宽派生异 stem', async () => {
      const collideUrl = 'https://example.com/collide-target';
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture({ finalUrl: collideUrl }));
      // 预置：stem8 已被另一页占（模拟真 sha8 撞库/同 stem 异页）——文件在、登记行 url 异源。
      const stem8 = onlineStemForUrl(collideUrl);
      mkdirSync(path.join(GLOBAL_MATERIALS, 'online'), { recursive: true });
      writeFileSync(path.join(GLOBAL_MATERIALS, 'online', `${stem8}.md`), chapteredNovel(3), 'utf-8');
      const prior = await registerMaterial({ scope: 'global' }, `online/${stem8}.md`, {
        provenanceOverrides: { url: 'https://other.example/elsewhere' },
      });
      expect(prior.outcome).toBe('registered');

      const res = await handlers.importOnlineMaterial({ url: collideUrl, scope: 'global', category: 'other' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // 加宽：stem12（异 stem 异 materialId——不覆写先登页）。
      expect(res.sourcePath).toMatch(/^online\/.+-[0-9a-f]{12}\.md$/);
      expect(res.sourcePath).not.toBe(`online/${stem8}.md`);
      expect(getMaterialRow(res.materialId)!.provenance.url).toBe(collideUrl);
      // 先登页的行与文件原样保留（两条材料并存——按 sourcePath 各认一条）。
      expect(existsSync(path.join(GLOBAL_MATERIALS, 'online', `${stem8}.md`))).toBe(true);
      const listed = await handlers.listMaterials({ scope: 'global' });
      expect(listed.some((m) => m.sourcePath === `online/${stem8}.md`)).toBe(true);
      expect(listed.some((m) => m.materialId === res.materialId)).toBe(true);
      expect(listed).toHaveLength(2);
    });

    it('stem-conflict TOCTOU 复查（CR-5）：拉取窗口内出现的异扩展占位件 → 写盘前拦下', async () => {
      mkdirSync(path.join(GLOBAL_MATERIALS, 'online'), { recursive: true });
      const stem = onlineStemForUrl(WIKI_URL);
      // 拉取 stub 在 fetch 窗口内落占位件（模拟 watcher/手工在窗口内放入同 stem 异扩展件）——
      // 先于拉取的 cheap 检查过门，写盘前复查接住。
      fetchOnlinePageAsMarkdownMock.mockImplementation(async () => {
        writeFileSync(path.join(GLOBAL_MATERIALS, 'online', `${stem}.txt`), '窗口内出现', 'utf-8');
        return extractionFixture();
      });
      const res = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(res).toMatchObject({ ok: false, error: 'stem-conflict' });
    });

    it('失败分类：invalid-input / unregistered / 拉取半透传 / stem-conflict（先于拉取早退）', async () => {
      // invalid-input 三形态。
      expect(
        await handlers.importOnlineMaterial({ scope: 'global', category: 'other' }),
      ).toMatchObject({ ok: false, error: 'invalid-input' });
      expect(
        await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'not-a-category' }),
      ).toMatchObject({ ok: false, error: 'invalid-input' });
      expect(
        await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'project', category: 'other' }),
      ).toMatchObject({ ok: false, error: 'invalid-input' });

      // unregistered：项目车道 projectId 解析不出。
      expect(
        await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'project', projectId: '99999', category: 'other' }),
      ).toMatchObject({ ok: false, error: 'unregistered' });

      // 拉取半失败分类透传（bad-url/fetch-failed/empty-content/oversize 来自 onlineMaterial）。
      for (const error of ['bad-url', 'fetch-failed', 'empty-content', 'oversize'] as const) {
        fetchOnlinePageAsMarkdownMock.mockResolvedValue({ ok: false, error, message: `${error} 说明文案` });
        const res = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
        expect(res).toMatchObject({ ok: false, error });
      }

      // stem-conflict：online/ 内同 stem 异扩展既有件（派生 .md 镜像互覆写风险）——先于拉取早退。
      const stem = onlineStemForUrl(WIKI_URL);
      mkdirSync(path.join(GLOBAL_MATERIALS, 'online'), { recursive: true });
      const conflictAbs = path.join(GLOBAL_MATERIALS, 'online', `${stem}.txt`);
      writeFileSync(conflictAbs, '同名异扩展既有件', 'utf-8');
      fetchOnlinePageAsMarkdownMock.mockResolvedValue(extractionFixture());
      fetchOnlinePageAsMarkdownMock.mockClear(); // 早退断言基线（前轮失败分类用例已触达过 mock）
      const conflict = await handlers.importOnlineMaterial({ url: WIKI_URL, scope: 'global', category: 'community-wiki' });
      expect(conflict).toMatchObject({ ok: false, error: 'stem-conflict' });
      // 早退：拉取核心未被触达（stem 只依赖 URL）。
      expect(fetchOnlinePageAsMarkdownMock).not.toHaveBeenCalled();
    });

    it('materials:search-online：空 query 模式 B throw；有效入参透传合并核心', async () => {
      await expect(handlers.searchOnlineSources({ query: '   ' })).rejects.toThrow(/query/);
      await expect(handlers.searchOnlineSources(null)).rejects.toThrow(/query/);

      const hit = { title: '明日方舟', url: WIKI_URL, snippet: '词条', source: 'wiki:moegirl-cn', categoryHint: 'community-wiki' };
      searchOnlineSourcesCoreMock.mockResolvedValue([hit]);
      const out = await handlers.searchOnlineSources({ query: ' 明日方舟 ', limit: 5 });
      expect(out).toEqual([hit]);
      expect(searchOnlineSourcesCoreMock).toHaveBeenCalledWith({ query: '明日方舟', limit: 5 });
    });
  });
});

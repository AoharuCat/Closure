import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// R4：路径校验强度对齐（findings F10/F4b 的入面前置）。
//
// 旧形态：`list_files` 只校验顶层 dirPath、递归体用 statSync（跟随 symlink）；
// `searchProjectFiles` 内部零路径校验、statSync + readFileSync 全程跟随。
// ⇒ 项目内若有指向项目外的目录链接，会把项目外条目列出去、把项目外文件内容搜进来；
// 而 `read_file` 走 assertWithinProject → isSafePath（realpath 前缀比对）不穿墙。
//
// 现形态（统一规则）：两处递归体对每个子项——目录下钻前判一次界（isSafePath 同源，
// realpath 前缀比对）；文件项先 lstat（不跟随），非链接项在已判界目录之下必然界内
//（免付逐文件 realpath）；**符号链接一律不列不钻**（界外不暴露 / 界内不重复不循环一条规则）。
// 跳过项计入 metadata.skipped（批量操作单项越界不打断整体，与三件 never-throws 取向一致）。
//
// 链接形态：优先 junction（Windows 上无需开发者模式/提权），退 'dir' 符号链接；
// 两者都不可用则由 linkCapable() 统一跳过用例。
//
// 夹具注意：根目录**原地保留**只清内容，且一律以 realpath 规范形作路径基准——
// Windows `%TEMP%` 是 8.3 短名（`C:\Users\CHILLI~1\…`），删根重建会让同一路径在
// 短名/长名两形态间漂移，`isSafePath` 两侧 realpath 形态不一致 → 界内项被误判越界。
//
// ⚠ 夹具陷阱（两条，均已踩过）：
// 1. `rmSync(link, { recursive: true })` 对 junction/symlink **会跟随并删掉目标内容**
//    （Windows junction 语义）——链接能力探针的目标绝不能取 projectRoot，否则清掉整个夹具。
//    本文件用一次性 mkdtemp 根 + 每例只清内容来规避。
// 2. 路径基准必须同源：夹具根取短名形态、被检项经 realpath 变长名形态时，前缀比对
//    恒假 → 全项被判越界跳过（伪装成「界内不误伤」用例失败）。故根路径一律先 realpath。
// ─────────────────────────────────────────────────────────────────────────────

const { degradeMentionLedgerForChapterFile, notifyUI } = vi.hoisted(() => ({
  degradeMentionLedgerForChapterFile: vi.fn(async () => undefined),
  notifyUI: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/tmp', isPackaged: false },
}));
vi.mock('../main/db/mentionLedgerDegrade', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../main/db/mentionLedgerDegrade')>()),
  degradeMentionLedgerForChapterFile,
}));
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI }));

import {
  listFilesHandler,
  searchHandler,
  searchProjectFiles,
  searchProjectFilesWithStats,
} from '../main/ipc/toolHandlers/fileHandlers';

const TEST_DIR = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orison-symlink-')));

const projectRoot = () => path.join(TEST_DIR, 'proj');

function createDirLink(target: string, linkPath: string): boolean {
  for (const type of ['junction', 'dir'] as const) {
    try {
      symlinkSync(target, linkPath, type);
      return true;
    } catch {
      /* 换下一种形态；Windows 提权未开时 'dir' 会 EPERM，Linux 上 'junction' 无效 */
    }
  }
  return false;
}

function write(rel: string, content: string) {
  const fp = path.join(projectRoot(), rel);
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, content, 'utf-8');
}

/** 写项目**外**（夹具根下、与 proj 平级）的内容——穿墙目标件的落点。 */
function writeOutside(rel: string, content: string) {
  const fp = path.join(TEST_DIR, rel);
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, content, 'utf-8');
}

function rmBestEffort(target: string) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort：Windows 句柄竞态 EPERM */
  }
}

function ctx() {
  return {
    params: {} as Record<string, unknown>,
    projectDir: projectRoot(),
    sessionId: 's1',
    abort: new AbortController().signal,
  };
}

/** 每例清空夹具根内容（根目录原地保留，防 8.3 短名/长名形态漂移）。 */
function resetFixture() {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(projectRoot(), { recursive: true });
    return;
  }
  for (const name of readdirSync(TEST_DIR)) {
    if (name === 'proj') continue; // 链接/外部目录另清，顺序无关（rmSync 不跟随 junction）
    rmBestEffort(path.join(TEST_DIR, name));
  }
  rmBestEffort(path.join(TEST_DIR, 'proj'));
  mkdirSync(projectRoot(), { recursive: true });
}

/**
 * 项目内建一个指向项目外的目录链接。项目外目录里放一个含同款 needle 的文件——
 * 旧实现会把它列出来 / 搜进去。目标目录先落地：junction 不校验目标存在性，
 * 但只有目标真的存在才算测到穿墙形态（断链另有用例）。
 */
function makeEscapingLink(name: string): boolean {
  writeOutside(`outside-${name}/secret.txt`, `needle escaped-${name}`);
  return createDirLink(path.join(TEST_DIR, `outside-${name}`), path.join(projectRoot(), `link-${name}`));
}

/** 目录链接能力探测（junction / 'dir'）——模块加载时判定一次（探针只在 TEST_DIR 内）。 */
let canLinkDir: boolean | undefined;
function linkCapable(): boolean {
  if (canLinkDir === undefined) {
    // 探针目标**不能**是 projectRoot：rmSync(probe, {recursive:true}) 对 junction 会
    // 穿透删除目标内容（Windows junction 语义），拿 projectRoot 当目标 = 清空整个夹具。
    mkdirSync(path.join(TEST_DIR, 'link-target'), { recursive: true });
    const probe = path.join(TEST_DIR, 'link-probe');
    canLinkDir = createDirLink(path.join(TEST_DIR, 'link-target'), probe);
    rmBestEffort(probe);
  }
  return canLinkDir;
}

// 链接用例的**可见**跳过判据（CR：治前形态 `if (!linkCapable()) return;` 让受限主机上
// 整条路径校验修复「零覆盖报绿」——vitest 报告里与真跑过无法区分）。skipIf 在收集期
// 求值：不支持链接的主机上这些用例显式落 skipped（报告可见），支持的主机照常真跑。
const LINK_SUPPORTED = linkCapable();

describe('项目内只读三件 — 符号链接界内判定强度对齐（R4）', () => {
  beforeEach(() => {
    resetFixture();
  });

  it.skipIf(!LINK_SUPPORTED)('list_files 递归形态不列出指向项目外的目录链接', async () => {
    expect(makeEscapingLink('list')).toBe(true);

    const res = await listFilesHandler({ ...ctx(), params: { recursive: true } });

    expect(res.output).not.toContain('escaped-list');
    expect(res.output.split('\n').filter(Boolean)).not.toContain('link-list/');
    expect(res.metadata).toMatchObject({ skipped: 1 });
  });

  it.skipIf(!LINK_SUPPORTED)('list_files 非递归形态同样不列出越界链接', async () => {
    expect(makeEscapingLink('list-flat')).toBe(true);

    const res = await listFilesHandler({ ...ctx(), params: {} });

    expect(res.output.split('\n').filter(Boolean)).not.toContain('link-list-flat');
    expect(res.metadata).toMatchObject({ skipped: 1 });
  });

  it.skipIf(!LINK_SUPPORTED)('searchProjectFiles 不返回项目外文件内容，跳过计数可观测', () => {
    write('insider.md', 'needle inside-project');
    expect(makeEscapingLink('search')).toBe(true);

    const { results, skipped } = searchProjectFilesWithStats(projectRoot(), 'needle');

    expect(results.map((r) => r.path.replace(/\\/g, '/'))).toEqual(['insider.md']);
    expect(results.map((r) => r.text)).not.toContain('needle escaped-search');
    expect(skipped).toBe(1);
  });

  it.skipIf(!LINK_SUPPORTED)('search 工具 handler 不返回项目外命中，metadata.skipped 计数正确', async () => {
    expect(makeEscapingLink('handler')).toBe(true);

    const res = await searchHandler({ ...ctx(), params: { query: 'needle' } });

    expect(res.output).toBe('未找到匹配的内容。');
    expect(res.metadata).toMatchObject({ count: 0, skipped: 1 });
  });

  it.skipIf(!LINK_SUPPORTED)('搜索面板共享内核（searchProjectFiles）形态：越界内容不回流', () => {
    write('visible.txt', 'needle visible');
    expect(makeEscapingLink('panel')).toBe(true);

    // UI 侧栏搜索面板走同一内核（project:search IPC），对外返回类型不变。
    const hits = searchProjectFiles(projectRoot(), 'needle');

    expect(hits.map((h) => h.path.replace(/\\/g, '/'))).toEqual(['visible.txt']);
  });

  it('项目内普通子目录仍可下钻（界内不误伤）', async () => {
    write('chapters/one.md', 'needle nested');
    mkdirSync(path.join(projectRoot(), 'empty-dir'), { recursive: true });

    const listRes = await listFilesHandler({ ...ctx(), params: { recursive: true } });
    expect(listRes.output).toContain('chapters/one.md');
    expect(listRes.output).toContain('empty-dir/');
    expect(listRes.metadata).toMatchObject({ skipped: 0 });

    const res = await searchHandler({ ...ctx(), params: { query: 'needle' } });
    expect(res.output.replace(/\\/g, '/')).toContain('chapters/one.md:1: needle nested');
    expect(res.metadata).toMatchObject({ count: 1, skipped: 0 });
  });

  it.skipIf(!LINK_SUPPORTED)('指向项目内的链接同样不列不钻（统一规则），真实路径仍正常', async () => {
    write('real/inside.md', 'needle inside-link');
    expect(createDirLink(path.join(projectRoot(), 'real'), path.join(projectRoot(), 'alias'))).toBe(true);

    const listRes = await listFilesHandler({ ...ctx(), params: { recursive: true } });
    const listed = listRes.output.split('\n').filter(Boolean);
    // 真实路径照常列出；链接不列、不钻（不产生 alias/… 前缀的重复结果）
    expect(listed).toContain('real/');
    expect(listed).toContain('real/inside.md');
    expect(listed.filter((p) => p.startsWith('alias'))).toEqual([]);
    expect(listRes.metadata).toMatchObject({ skipped: 1 });

    const res = await searchHandler({ ...ctx(), params: { query: 'needle' } });
    // 链接不下钻 ⇒ 只经真实路径命中一次（重复结果 = 链接路径那份不会出现）
    expect(res.metadata).toMatchObject({ count: 1, skipped: 1 });
    expect(res.output.replace(/\\/g, '/')).toContain('real/inside.md:1: needle inside-link');
  });

  it.skipIf(!LINK_SUPPORTED)('自指链接不无限递归：遍历正常终止且计数正确', async () => {
    write('loop/inside.md', 'needle loop');
    // A/L → A 自指：若下钻链接，walk/searchDir 会永不终止（前缀无限增长）
    expect(createDirLink(path.join(projectRoot(), 'loop'), path.join(projectRoot(), 'loop', 'self'))).toBe(true);

    const listRes = await listFilesHandler({ ...ctx(), params: { recursive: true } });
    const listed = listRes.output.split('\n').filter(Boolean);
    expect(listed).toContain('loop/');
    expect(listed).toContain('loop/inside.md');
    expect(listed.filter((p) => p.startsWith('loop/self'))).toEqual([]);
    expect(listRes.metadata).toMatchObject({ skipped: 1 });

    const res = await searchHandler({ ...ctx(), params: { query: 'needle' } });
    expect(res.metadata).toMatchObject({ count: 1, skipped: 1 });
  });

  it.skipIf(!LINK_SUPPORTED)('互指链接（A/mutual → B，B/mutual → A）同样不递归', async () => {
    write('loop/inside.md', 'needle loop');
    mkdirSync(path.join(projectRoot(), 'a'), { recursive: true });
    mkdirSync(path.join(projectRoot(), 'b'), { recursive: true });
    expect(createDirLink(path.join(projectRoot(), 'b'), path.join(projectRoot(), 'a', 'mutual'))).toBe(true);
    expect(createDirLink(path.join(projectRoot(), 'a'), path.join(projectRoot(), 'b', 'mutual'))).toBe(true);

    const mutualList = await listFilesHandler({ ...ctx(), params: { recursive: true } });
    const mutualListed = mutualList.output.split('\n').filter(Boolean);
    expect(mutualListed.filter((p) => p.includes('mutual'))).toEqual([]);
    expect(mutualList.metadata).toMatchObject({ skipped: 2 }); // 两个互指链接项各计一次
    expect(mutualListed).toContain('loop/inside.md');
    expect(mutualListed).toContain('a/');
    expect(mutualListed).toContain('b/');
  });

  it.skipIf(!LINK_SUPPORTED)('断链（dangling link）不打断遍历，计为跳过', async () => {
    write('ok.md', 'needle ok');
    const linkPath = path.join(projectRoot(), 'dangling');
    expect(createDirLink(path.join(TEST_DIR, 'does-not-exist'), linkPath)).toBe(true);
    expect(statSync(linkPath, { throwIfNoEntry: false })).toBeUndefined(); // 确认是断链

    const listRes = await listFilesHandler({ ...ctx(), params: { recursive: true } });
    expect(listRes.output).toContain('ok.md');
    expect(listRes.metadata).toMatchObject({ skipped: 1 });

    const res = await searchHandler({ ...ctx(), params: { query: 'needle' } });
    expect(res.output).toContain('ok.md:1: needle ok');
  });

  it.skipIf(!LINK_SUPPORTED)('夹具前提：目录链接在 lstat 下可辨识（statSync 可跟随）', () => {
    mkdirSync(path.join(TEST_DIR, 'link-target'), { recursive: true });
    const link = path.join(TEST_DIR, 'link-follow');
    expect(createDirLink(path.join(TEST_DIR, 'link-target'), link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(link).isDirectory()).toBe(true);
  });
});

/**
 * 附件任务 A1：`project:import-files` additive 扩参 `allowedExtensions`（白名单在
 * shell 侧强制，不信 renderer 过滤）+ `project:word-count` 排除 inbox/（design
 * D-H：字数概览语义 = 项目产出，inbox 是外部参考材料）。
 * 附件任务 B3：`project:save-base64-image` 白名单加 `inbox/images` + additive `notify`
 *（chat 进件路径传 true → file:changed；默认不开防白触发资产页重载，复查 M4）。
 *
 * handler 级直测（真 fs / 真 pathGuard，tmp 目录）。electron 只 mock ipcMain +
 * BrowserWindow.getAllWindows（notifyUI 经它推 tool:event——styleInputHandlers.test.ts
 * 同形态）；initRepo mock 掉（本文件不触 git，防真 isomorphic-git 负载，
 * projectCreateGitInit.test.ts 同款）。
 */
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmBestEffort } from './rmBestEffort';

const { handle, send, initRepo } = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
  initRepo: vi.fn(async () => ({ initialized: true })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
}));
vi.mock('../main/ipc/gitIpc', () => ({ initRepo }));

import { registerProjectFileIpc } from '../main/ipc/projectFileIpc';
import { initProjectsRoot } from '../main/ipc/pathGuard';

// 尾段必须是 Closure（initProjectsRoot 语义：documents 参数 + '/Closure'），mirror
// projectCreateGitInit.test.ts 的根构造。sources 放 Closure 根之外（模拟项目外部的
// 待上传文件；import 源路径只过启发式校验，不要求落在 allowedRoots 内）。
const BASE_TMP = path.join(process.cwd(), 'test-tmp-project-file-ipc');
const PROJECT_DIR = path.join(BASE_TMP, 'Closure', 'proj');
const SOURCES_DIR = path.join(BASE_TMP, 'sources');
const INBOX_DIR = path.join(PROJECT_DIR, 'inbox');

/** handler 首参是 ipc event（unused），测试传 {} 占位（mirror projectCreateGitInit 调用形）。 */
function importFilesHandler(): (
  event: unknown,
  projectDir: string,
  targetRelDir: string,
  sourcePaths: string[],
  allowedExtensions?: string[],
) => Promise<unknown> {
  const call = handle.mock.calls.find((c) => c[0] === 'project:import-files');
  if (!call) throw new Error('project:import-files handler not registered');
  return call[1] as unknown as (...args: unknown[]) => Promise<unknown>;
}

function wordCountHandler(): (event: unknown, projectDir: string) => Promise<number> {
  const call = handle.mock.calls.find((c) => c[0] === 'project:word-count');
  if (!call) throw new Error('project:word-count handler not registered');
  return call[1] as unknown as (event: unknown, projectDir: string) => Promise<number>;
}

function saveBase64Handler(): (
  event: unknown,
  projectDir: string,
  input: { b64Json: string; mimeType: string; directory: string; fileName?: string; notify?: boolean },
) => Promise<{ relativePath: string; fullPath: string; fileName: string }> {
  const call = handle.mock.calls.find((c) => c[0] === 'project:save-base64-image');
  if (!call) throw new Error('project:save-base64-image handler not registered');
  return call[1] as unknown as (
    event: unknown,
    projectDir: string,
    input: { b64Json: string; mimeType: string; directory: string; fileName?: string; notify?: boolean },
  ) => Promise<{ relativePath: string; fullPath: string; fileName: string }>;
}

function writeSource(name: string, content: string): string {
  const p = path.join(SOURCES_DIR, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/** 稀疏造 >50MB 文件：ftruncate 扩展不写实际内容，statSync().size 即目标长度。 */
function writeOversizeSource(name: string): string {
  const p = path.join(SOURCES_DIR, name);
  const fd = openSync(p, 'w');
  try {
    ftruncateSync(fd, 50 * 1024 * 1024 + 1);
  } finally {
    closeSync(fd);
  }
  return p;
}

/** notifyUI 推出的 file:changed 相对路径（BrowserWindow.getAllWindows → webContents.send）。 */
function fileChangedPaths(): string[] {
  return send.mock.calls
    .filter((c) => (c[1] as { type?: string } | undefined)?.type === 'file:changed')
    .map((c) => (c[1] as { path: string }).path);
}

describe('project:import-files — allowedExtensions additive 扩参（A1）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    // initProjectsRoot 语义 = documents 参数 + '/Closure'，故传 BASE_TMP（root 即
    // BASE_TMP/Closure——mirror projectCreateGitInit 传 dirname(TEST_ROOT) 的等价形）。
    initProjectsRoot(BASE_TMP);
    mkdirSync(SOURCES_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('不传 allowedExtensions：任意扩展名照旧拷入（既有调用零变化回归）', async () => {
    const handler = importFilesHandler();
    const md = writeSource('a.md', '# 正文');
    const exe = writeSource('b.exe', 'MZ');

    const result = await handler({}, PROJECT_DIR, 'inbox', [md, exe]);

    // 返回形态 = string[]（既有契约逐字节一致）；.exe 不受任何扩展名检查照常拷入。
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(['/inbox/a.md', '/inbox/b.exe']);
    expect(existsSync(path.join(INBOX_DIR, 'a.md'))).toBe(true);
    expect(existsSync(path.join(INBOX_DIR, 'b.exe'))).toBe(true);
    expect(fileChangedPaths()).toEqual(['/inbox/a.md', '/inbox/b.exe']);
  });

  it('传入白名单：非白名单拒收（文件名入 rejected）、合法文件照常拷入（部分成功）', async () => {
    const handler = importFilesHandler();
    const md = writeSource('a.md', '大纲正文');
    const pdf = writeSource('b.pdf', '%PDF-1.4');
    const exe = writeSource('evil.exe', 'MZ');
    const svg = writeSource('image.svg', '<svg/>');

    const result = await handler({}, PROJECT_DIR, 'inbox', [md, exe, pdf, svg], [
      '.txt',
      '.md',
      '.markdown',
      '.docx',
      '.pdf',
    ]);

    expect(result).toEqual({
      imported: ['/inbox/a.md', '/inbox/b.pdf'],
      rejected: ['evil.exe', 'image.svg'],
    });
    // 合法文件落盘；被拒文件 inbox/ 无残留（PRD AC2）。
    expect(existsSync(path.join(INBOX_DIR, 'a.md'))).toBe(true);
    expect(existsSync(path.join(INBOX_DIR, 'b.pdf'))).toBe(true);
    expect(existsSync(path.join(INBOX_DIR, 'evil.exe'))).toBe(false);
    expect(existsSync(path.join(INBOX_DIR, 'image.svg'))).toBe(false);
    // file:changed 只为成功拷入的文件发（被拒条目零事件）。
    expect(fileChangedPaths()).toEqual(['/inbox/a.md', '/inbox/b.pdf']);
  });

  it('白名单归一：无前导点条目与大写扩展名文件均命中（md ≡ .md ≡ .MD）', async () => {
    const handler = importFilesHandler();
    const upper = writeSource('NOTE.MD', '大写扩展名');

    const result = await handler({}, PROJECT_DIR, 'inbox', [upper], ['md', '.PDF']);

    expect(result).toEqual({ imported: ['/inbox/NOTE.MD'], rejected: [] });
    expect(existsSync(path.join(INBOX_DIR, 'NOTE.MD'))).toBe(true);
  });

  it('传空数组 = 未启用（additive：空白名单不升级为全拒，返回旧形态）', async () => {
    const handler = importFilesHandler();
    const exe = writeSource('c.exe', 'MZ');

    const result = await handler({}, PROJECT_DIR, 'inbox', [exe], []);

    expect(result).toEqual(['/inbox/c.exe']);
  });

  it('大小闸（CR-018）：附件路径下 >50MB 的白名单内文件列入 rejected 带原因（不再静默）', async () => {
    const handler = importFilesHandler();
    const big = writeOversizeSource('big.pdf');

    const result = await handler({}, PROJECT_DIR, 'inbox', [big], ['.pdf']);

    // CR-018：allowedExtensions 启用时大小拒收明确提示（AC2）——`文件名 (原因)` 形态。
    expect(result).toEqual({ imported: [], rejected: ['big.pdf (超过 50MB 上限)'] });
    expect(existsSync(path.join(INBOX_DIR, 'big.pdf'))).toBe(false);
    expect(fileChangedPaths()).toEqual([]);
  });

  it('大小闸（不传参）：文件树老路径 >50MB 仍静默跳过（零变化回归）', async () => {
    const handler = importFilesHandler();
    const big = writeOversizeSource('old.pdf');

    const result = await handler({}, PROJECT_DIR, 'inbox', [big]);

    expect(result).toEqual([]);
    expect(existsSync(path.join(INBOX_DIR, 'old.pdf'))).toBe(false);
  });

  it('大小拒收与合法拷入混合：部分成功语义（合法照拷 + 超限带原因入 rejected）', async () => {
    const handler = importFilesHandler();
    const ok = writeSource('a.md', '大纲正文');
    const big = writeOversizeSource('big.docx');

    const result = await handler({}, PROJECT_DIR, 'inbox', [ok, big], ['.md', '.docx']);

    expect(result).toEqual({ imported: ['/inbox/a.md'], rejected: ['big.docx (超过 50MB 上限)'] });
    expect(existsSync(path.join(INBOX_DIR, 'a.md'))).toBe(true);
    expect(existsSync(path.join(INBOX_DIR, 'big.docx'))).toBe(false);
  });

  it('批量闸（CR-018）：附件路径下 >100 溢出条目列入 rejected 带原因（单批前 100 照常）', async () => {
    const handler = importFilesHandler();
    const paths: string[] = [];
    for (let i = 0; i < 105; i++) {
      paths.push(writeSource(`f${String(i).padStart(3, '0')}.md`, `第${i}份`));
    }

    const result = await handler({}, PROJECT_DIR, 'inbox', paths, ['.md']);
    const { imported, rejected } = result as { imported: string[]; rejected: string[] };

    expect(imported).toHaveLength(100);
    expect(imported).toContain('/inbox/f000.md');
    expect(imported).not.toContain('/inbox/f104.md');
    // CR-018：第 101 个起不再静默丢弃——带原因列入 rejected（AC2 明确提示）。
    expect(rejected).toEqual([
      'f100.md (超过单批 100 个上限)',
      'f101.md (超过单批 100 个上限)',
      'f102.md (超过单批 100 个上限)',
      'f103.md (超过单批 100 个上限)',
      'f104.md (超过单批 100 个上限)',
    ]);
  });
});

describe('project:word-count — 排除 inbox/（A1，design D-H）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('inbox/ 下的 .md/.txt 不计入总字数，项目正文照计', async () => {
    const handler = wordCountHandler();
    mkdirSync(path.join(PROJECT_DIR, '章节'), { recursive: true });
    mkdirSync(path.join(PROJECT_DIR, '设定'), { recursive: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    writeFileSync(path.join(PROJECT_DIR, '章节', '第一章.md'), '正文字数六个', 'utf-8');
    writeFileSync(path.join(PROJECT_DIR, '设定', '世界观.md'), '设定四字', 'utf-8');
    writeFileSync(path.join(INBOX_DIR, '大纲.md'), '外部材料不计入总字数', 'utf-8');
    writeFileSync(path.join(INBOX_DIR, 'notes.txt'), '附件二字', 'utf-8');

    const total = await handler({}, PROJECT_DIR);

    // 6 + 4 = 10；inbox 下的 .md/.txt（含各级子目录）全部剪枝。
    expect(total).toBe(10);
  });

  it('前缀锚定：非根级同名目录与根级同名文件不受影响', async () => {
    const handler = wordCountHandler();
    mkdirSync(path.join(PROJECT_DIR, '资料', 'inbox'), { recursive: true });
    writeFileSync(path.join(PROJECT_DIR, '资料', 'inbox', 'x.md'), '锚定', 'utf-8');
    writeFileSync(path.join(PROJECT_DIR, 'inbox.md'), '同名文件', 'utf-8');

    const total = await handler({}, PROJECT_DIR);

    // 2 + 4 = 6：只有根级 /inbox 目录被剪枝。
    expect(total).toBe(6);
  });
});

describe('project:save-base64-image — inbox/images 白名单 + additive notify（B 波 B3）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('notify 默认不开：既有消费者（AssetsPanel/ImageGenEditor）零事件零变化回归', async () => {
    const handler = saveBase64Handler();

    const result = await handler({}, PROJECT_DIR, {
      b64Json: Buffer.from('legacy-bytes').toString('base64'),
      mimeType: 'image/png',
      directory: 'assets/images',
      fileName: 'legacy.png',
    });

    expect(result.relativePath).toBe('assets/images/legacy.png');
    expect(existsSync(path.join(PROJECT_DIR, 'assets', 'images', 'legacy.png'))).toBe(true);
    // 落盘成功但零 file:changed（复查 M4：无差别加事件会白触发资产页全量重载）。
    expect(fileChangedPaths()).toEqual([]);
  });

  it('notify:true + inbox/images：落盘 + file:changed（chat 进件路径，不用 image:created）', async () => {
    const handler = saveBase64Handler();

    const result = await handler({}, PROJECT_DIR, {
      b64Json: Buffer.from('chat-image-bytes').toString('base64'),
      mimeType: 'image/png',
      directory: 'inbox/images',
      fileName: '截图.png',
      notify: true,
    });

    expect(result.relativePath).toBe('inbox/images/截图.png');
    expect(existsSync(path.join(INBOX_DIR, 'images', '截图.png'))).toBe(true);
    expect(fileChangedPaths()).toEqual(['/inbox/images/截图.png']);
  });

  it('非白名单 directory 仍拒收（守卫沿用）', async () => {
    const handler = saveBase64Handler();

    await expect(
      handler({}, PROJECT_DIR, {
        b64Json: Buffer.from('x').toString('base64'),
        mimeType: 'image/png',
        directory: 'chapters',
        fileName: 'evil.png',
      }),
    ).rejects.toThrow('Invalid image directory');
  });
});

// ── W2 多系统支持（R1/R2）：命名单源拒绝面 + move-file 守卫 + rename-entry 大小写放行 ──

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = handle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`${channel} handler not registered`);
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

describe('project:create-directory — 命名单源拒绝面（R1/FS#1/#10）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('Windows 保留名拒绝：报错带违规原因，盘上零残留', async () => {
    const handler = handlerFor('project:create-directory');

    await expect(handler({}, PROJECT_DIR, 'con')).rejects.toThrow('reserved');
    await expect(handler({}, PROJECT_DIR, 'NUL.md')).rejects.toThrow('reserved');
    expect(existsSync(path.join(PROJECT_DIR, 'con'))).toBe(false);
  });

  it('非法字符拒绝（含穿越分隔符）：报错带违规原因', async () => {
    const handler = handlerFor('project:create-directory');

    await expect(handler({}, PROJECT_DIR, '报告:卷一')).rejects.toThrow('illegal-char');
    await expect(handler({}, PROJECT_DIR, 'a/b')).rejects.toThrow('illegal-char');
    await expect(handler({}, PROJECT_DIR, 'a\\b')).rejects.toThrow('illegal-char');
  });

  // CR-7：`..` 在命名单源 assert 之前显式早拒——否则落进 trailing-dot-space 的
  // 巧合归类，穿越意图的报错文案误导；空名/纯空白名单源按设计返 null（空名判定
  // 属调用方），本通道早拒防 join 结果静默变父目录（旧缺陷 = 对空名假成功返回
  // 父路径，不落新盘面——rejects 断言即完整证明）。
  it('空名 / 纯空白名 / `..` 早拒：报错文案明确（CR-7）', async () => {
    const handler = handlerFor('project:create-directory');

    await expect(handler({}, PROJECT_DIR, '')).rejects.toThrow('项目名称为空');
    await expect(handler({}, PROJECT_DIR, '   ')).rejects.toThrow('项目名称为空');
    await expect(handler({}, PROJECT_DIR, '..')).rejects.toThrow('相对路径段');
  });

  it('项目名超长拒绝（帽 60）：报错带 too-long', async () => {
    const handler = handlerFor('project:create-directory');

    await expect(handler({}, PROJECT_DIR, '长'.repeat(61))).rejects.toThrow('too-long');
  });

  it('合法中文名放行：目录落盘 + 返回绝对路径（既有主链零变化回归）', async () => {
    const handler = handlerFor('project:create-directory');

    const result = (await handler({}, PROJECT_DIR, '无法告白')) as string;

    expect(result).toBe(path.resolve(path.join(PROJECT_DIR, '无法告白')));
    expect(existsSync(path.join(PROJECT_DIR, '无法告白'))).toBe(true);
  });

  it('恰 60 字符项目名在帽内放行（边界不误伤）', async () => {
    const handler = handlerFor('project:create-directory');

    const name = '书'.repeat(60);
    await handler({}, PROJECT_DIR, name);
    expect(existsSync(path.join(PROJECT_DIR, name))).toBe(true);
  });
});

describe('project:create-entry — 命名单源拒绝面（R1/FS#2，boolean 契约）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('保留名 / 非法字符 / 超长 → false，盘上零残留', async () => {
    const handler = handlerFor('project:create-entry');

    expect(await handler({}, path.join(PROJECT_DIR, 'con'), false)).toBe(false);
    expect(await handler({}, path.join(PROJECT_DIR, 'a:b.md'), true)).toBe(false);
    expect(await handler({}, path.join(PROJECT_DIR, `${'长'.repeat(81)}.md`), false)).toBe(false);
    expect(existsSync(path.join(PROJECT_DIR, 'con'))).toBe(false);
    expect(existsSync(path.join(PROJECT_DIR, 'a:b.md'))).toBe(false);
  });

  it('合法中文名放行：文件落盘返回 true（既有主链零变化回归）', async () => {
    const handler = handlerFor('project:create-entry');

    expect(await handler({}, path.join(PROJECT_DIR, '第一章.md'), false)).toBe(true);
    expect(existsSync(path.join(PROJECT_DIR, '第一章.md'))).toBe(true);
  });
});

describe('project:move-file — 目标已存在守卫（R2/FS#4，mirror rename-entry）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('目标已存在 → 报错拒移：源文件不被吞（POSIX 静默覆盖面关闭）', async () => {
    const handler = handlerFor('project:move-file');
    const tempFile = path.join(PROJECT_DIR, 'temp', 'x.png');
    const assetFile = path.join(PROJECT_DIR, 'assets', 'images', 'y.png');
    mkdirSync(path.dirname(tempFile), { recursive: true });
    mkdirSync(path.dirname(assetFile), { recursive: true });
    writeFileSync(tempFile, 'source-bytes', 'utf-8');
    writeFileSync(assetFile, 'asset-bytes', 'utf-8');

    await expect(handler({}, PROJECT_DIR, '/temp/x.png', '/assets/images/y.png')).rejects.toThrow(
      'Move target already exists',
    );
    // 数据零损：源原样在位，目标内容未被覆盖。
    expect(readFileSync(tempFile, 'utf-8')).toBe('source-bytes');
    expect(readFileSync(assetFile, 'utf-8')).toBe('asset-bytes');
  });

  it('目标不存在 → 照常移动并返回目标路径（既有主链零变化回归）', async () => {
    const handler = handlerFor('project:move-file');
    const tempFile = path.join(PROJECT_DIR, 'temp', 'x.png');
    mkdirSync(path.dirname(tempFile), { recursive: true });
    writeFileSync(tempFile, 'img-bytes', 'utf-8');

    const result = (await handler({}, PROJECT_DIR, '/temp/x.png', '/assets/images/y.png')) as string;

    expect(result).toBe(path.join(PROJECT_DIR, 'assets', 'images', 'y.png'));
    expect(existsSync(path.join(PROJECT_DIR, 'assets', 'images', 'y.png'))).toBe(true);
    expect(existsSync(tempFile)).toBe(false);
  });

  // CR-3（mirror rename-entry）：大小写不敏感 fs（win32/mac）上 existsSync 会命中
  // 源自身——`x.png` 移到 `X.png` 被误拒。守卫对大小写等价形态放行（门 = 非
  // linux）；linux 上目标本就不存在、同测试经既有守卫直过，三平台同断言成立。
  it('纯大小写移动（x.png → X.png）放行：不被大小写不敏感 existsSync 误拒（CR-3）', async () => {
    const handler = handlerFor('project:move-file');
    const tempFile = path.join(PROJECT_DIR, 'temp', 'x.png');
    mkdirSync(path.dirname(tempFile), { recursive: true });
    writeFileSync(tempFile, 'img-bytes', 'utf-8');

    const result = (await handler({}, PROJECT_DIR, '/temp/x.png', '/temp/X.png')) as string;

    expect(result).toBe(path.join(PROJECT_DIR, 'temp', 'X.png'));
    // 新大小写形态可访问（不反向断言旧形态消失——大小写不敏感 fs 上 x.png 与
    // X.png 同指一个文件，mirror rename-entry 测试形态）。
    expect(existsSync(path.join(PROJECT_DIR, 'temp', 'X.png'))).toBe(true);
  });
});

// CR-4/CR-3 联动钉面：大小写等价放行门 = 非 linux（win32 NTFS + macOS APFS 默认
// 都不区分大小写）；linux 大小写敏感语义不随修复漂移——异名大小写在 linux 是真实
// 兄弟，守卫必须不放行（两个 rename 通道各钉一条）。
describe.skipIf(process.platform !== 'linux')('linux 门——大小写异名是真实兄弟，守卫不放行（CR-3/CR-4）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('project:rename-entry：a.md → A.md 且 A.md 真实存在 → false（A.md 不被覆盖）', async () => {
    const handler = handlerFor('project:rename-entry');
    writeFileSync(path.join(PROJECT_DIR, 'a.md'), '甲', 'utf-8');
    writeFileSync(path.join(PROJECT_DIR, 'A.md'), '甲大写', 'utf-8');

    expect(await handler({}, path.join(PROJECT_DIR, 'a.md'), path.join(PROJECT_DIR, 'A.md'))).toBe(false);
    expect(readFileSync(path.join(PROJECT_DIR, 'A.md'), 'utf-8')).toBe('甲大写');
  });

  it('project:move-file：temp/x.png → temp/X.png 且 X.png 真实存在 → 报错拒移', async () => {
    const handler = handlerFor('project:move-file');
    mkdirSync(path.join(PROJECT_DIR, 'temp'), { recursive: true });
    writeFileSync(path.join(PROJECT_DIR, 'temp', 'x.png'), 'lower-bytes', 'utf-8');
    writeFileSync(path.join(PROJECT_DIR, 'temp', 'X.png'), 'upper-bytes', 'utf-8');

    await expect(handler({}, PROJECT_DIR, '/temp/x.png', '/temp/X.png')).rejects.toThrow(
      'Move target already exists',
    );
    expect(readFileSync(path.join(PROJECT_DIR, 'temp', 'X.png'), 'utf-8')).toBe('upper-bytes');
    expect(readFileSync(path.join(PROJECT_DIR, 'temp', 'x.png'), 'utf-8')).toBe('lower-bytes');
  });
});

describe('project:rename-entry — 纯大小写改名放行（R2/CR-4，大小写不敏感 fs 修复）', () => {
  beforeEach(() => {
    handle.mockReset();
    send.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmBestEffort(BASE_TMP);
    initProjectsRoot(BASE_TMP);
    mkdirSync(PROJECT_DIR, { recursive: true });
    registerProjectFileIpc();
  });

  afterEach(() => {
    rmBestEffort(BASE_TMP);
  });

  it('纯大小写改名（第一章.md → 第一章.MD）放行：不被大小写不敏感 existsSync 误拒', async () => {
    const handler = handlerFor('project:rename-entry');
    const file = path.join(PROJECT_DIR, '第一章.md');
    writeFileSync(file, '正文', 'utf-8');

    expect(await handler({}, file, path.join(PROJECT_DIR, '第一章.MD'))).toBe(true);
    // 改名后以新大小写形态可访问（POSIX 大小写敏感 fs 上本就直接走既有守卫放行）。
    expect(existsSync(path.join(PROJECT_DIR, '第一章.MD'))).toBe(true);
    expect(readFileSync(path.join(PROJECT_DIR, '第一章.MD'), 'utf-8')).toBe('正文');
  });

  it('真实异名目标已存在仍拒改（守卫沿用，防 POSIX 静默覆盖）', async () => {
    const handler = handlerFor('project:rename-entry');
    writeFileSync(path.join(PROJECT_DIR, 'a.md'), '甲', 'utf-8');
    writeFileSync(path.join(PROJECT_DIR, 'b.md'), '乙', 'utf-8');

    expect(await handler({}, path.join(PROJECT_DIR, 'a.md'), path.join(PROJECT_DIR, 'b.md'))).toBe(false);
    expect(readFileSync(path.join(PROJECT_DIR, 'b.md'), 'utf-8')).toBe('乙');
  });
});

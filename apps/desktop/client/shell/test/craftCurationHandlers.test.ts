/**
 * save_craft_doc shell handler tests (Story 3.6 WP9 / R5-R6).
 *
 * Covers: frontmatter shape (id/craft_type/tags/source=URL+检索日期/source_note, verified
 * via a craftMd round-trip parse — the WRITE side must mirror the READ consumer),
 * strict-whitelist slug sanitize (path-escape neutralization), conflict -2 suffix
 * (never overwrite — both file-existence and craft_id-scan faces), direct reindex
 * call, reindex-failure degradation (file stays saved), missing-param rejection.
 * Runs on a throwaway craft-KB dir via _setCraftKbUserDirForTest (mirror
 * closureCraftIndexer.test.ts); reindexCraftDoc is stubbed (its DB integration
 * has its own suite).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-craft-curation');

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
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../main/db/closureCraftIndexer', () => ({
  reindexCraftDoc: vi.fn(async () => undefined),
}));

import { reindexCraftDoc } from '../main/db/closureCraftIndexer';
import {
  saveCraftDocHandler,
  slugifyCraftDoc,
  buildCraftSource,
  ensureTitleHeading,
  coerceSaveCraftDocParams,
} from '../main/ipc/toolHandlers/craftCurationHandlers';
import { _setCraftKbUserDirForTest, getCraftKbUserDir } from '../main/db/craftKbPaths';
import { parseCraftMd, deriveCraftId } from '../main/db/craftMd';

const CRAFT_DIR = path.join(TEST_HOME, '.orison', 'craft-kb');
const RESEARCH_DIR = path.join(CRAFT_DIR, 'research');

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj', // unused (global KB) — handler must not depend on it
  sessionId: 's1',
  abort: new AbortController().signal,
});

function clean() {
  _setCraftKbUserDirForTest(null);
  rmBestEffort(TEST_HOME);
}

beforeAll(() => {
  clean();
  _setCraftKbUserDirForTest(CRAFT_DIR);
  mkdirSync(RESEARCH_DIR, { recursive: true });
});
afterEach(() => {
  vi.mocked(reindexCraftDoc).mockClear();
  vi.mocked(reindexCraftDoc).mockImplementation(async () => undefined);
});
afterAll(clean);

describe('slugifyCraftDoc（严格白名单 sanitize）', () => {
  it('CJK 保留成可读 slug；非法字符归一为 -', () => {
    expect(slugifyCraftDoc('阿米娅 角色研究')).toBe('阿米娅-角色研究');
    expect(slugifyCraftDoc('Amiya: Character <Notes>')).toBe('Amiya-Character-Notes');
  });

  it('路径逃逸被中和——分隔符不可能存活（防 ../）', () => {
    expect(slugifyCraftDoc('../../evil')).toBe('evil');
    expect(slugifyCraftDoc('a/b\\c')).toBe('a-b-c');
    expect(slugifyCraftDoc('..\\..\\win')).toBe('win');
  });

  it('.md 扩展剥除；空/全非法回退 untitled；Windows 保留名加后缀；长度 cap', () => {
    expect(slugifyCraftDoc('foo.md')).toBe('foo');
    expect(slugifyCraftDoc('???')).toBe('untitled');
    expect(slugifyCraftDoc('con')).toBe('con-doc');
    expect(slugifyCraftDoc('x'.repeat(200))).toHaveLength(80);
  });
});

describe('provenance / body 纯函数', () => {
  it('buildCraftSource：URL + 检索日期 ISO 拼串；无 URL 落 agent 策展标注', () => {
    const d = new Date('2026-08-15T10:00:00Z');
    expect(buildCraftSource('https://zh.moegirl.org.cn/阿米娅', d))
      .toBe('https://zh.moegirl.org.cn/阿米娅 | 检索 2026-08-15');
    expect(buildCraftSource(undefined, d)).toBe('agent 研究策展 | 检索 2026-08-15');
  });

  it('ensureTitleHeading：无 H1 前插标题；有 H1 原样保留', () => {
    expect(ensureTitleHeading('T', '正文')).toBe('# T\n\n正文');
    expect(ensureTitleHeading('T', '# 已有标题\n正文')).toBe('# 已有标题\n正文');
  });

  it('coerceSaveCraftDocParams：trim 空串归 undefined；tags 过滤空项', () => {
    const p = coerceSaveCraftDocParams({
      craft_type: ' shuangdian ', title: '', content: '正文',
      tags: ['爽点', ' ', 42, '先抑后扬'],
    });
    expect(p.craft_type).toBe('shuangdian');
    expect(p.title).toBeUndefined();
    expect(p.tags).toEqual(['爽点', '先抑后扬']);
  });
});

describe('saveCraftDocHandler 写入 + 索引闭环', () => {
  it('happy path：写 research/<slug>.md + frontmatter（craftMd round-trip 验真）+ 直接 reindex', async () => {
    const res = await saveCraftDocHandler(ctx({
      craft_type: 'shuangdian',
      title: '先抑后扬三段式',
      content: '## 结构\n即时爽点 → 累积爽点 → 终极爽点。',
      tags: ['爽点', '结构'],
      sourceUrl: 'https://example.com/craft',
      sourceNote: 'CC BY-NC-SA 3.0 转载整理',
    }));
    expect(res.output).toContain('已策展入全局 craft KB');
    expect(res.output).toContain('query_craft 即刻可检回');
    expect(res.metadata).toMatchObject({ ok: true, craftId: '先抑后扬三段式', craftType: 'shuangdian', indexed: true });

    const filePath = (res.metadata as { filePath: string }).filePath;
    expect(filePath.startsWith(RESEARCH_DIR)).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    // WRITE side mirrors the READ consumer: parse back via craftMd.
    const { frontmatter, body } = parseCraftMd(readFileSync(filePath, 'utf-8'));
    expect(frontmatter.id).toBe('先抑后扬三段式');
    expect(frontmatter.craft_type).toBe('shuangdian');
    expect(frontmatter.tags).toEqual(['爽点', '结构']);
    expect(frontmatter.source).toBe('https://example.com/craft | 检索 ' + new Date().toISOString().slice(0, 10));
    expect(body.startsWith('# 先抑后扬三段式\n')).toBe(true); // H1 prepend（无 H1 正文）
    expect(body).toContain('即时爽点');
    expect(deriveCraftId(path.basename(filePath), frontmatter)).toBe('先抑后扬三段式');

    expect(reindexCraftDoc).toHaveBeenCalledWith(filePath, 'user');
  });

  it('冲突不覆盖：同名文件已存在 -> -2 后缀 + 原文件内容保持', async () => {
    const first = await saveCraftDocHandler(ctx({ craft_type: 'qiaoduan', title: '桥段笔记', content: '原内容' }));
    const firstPath = (first.metadata as { filePath: string }).filePath;
    const second = await saveCraftDocHandler(ctx({ craft_type: 'qiaoduan', title: '桥段笔记', content: '新内容' }));
    expect((second.metadata as { craftId: string }).craftId).toBe('桥段笔记-2');
    expect((second.metadata as { filePath: string }).filePath).not.toBe(firstPath);
    // 原文件未被覆盖
    expect(readFileSync(firstPath, 'utf-8')).toContain('原内容');
    expect(readFileSync(firstPath, 'utf-8')).not.toContain('新内容');
  });

  it('craft_id 撞车（KB 其他位置同 id 文档，scan 面）-> 后缀避让（user-override-bundled 防误遮）', async () => {
    // 顶层已有一份 id: dup-id 的用户文档（research/ 之外，文件名不同）。
    writeFileSync(path.join(CRAFT_DIR, 'other.md'), '---\nid: dup-id\ncraft_type: qiaoduan\n---\n# 既有', 'utf-8');
    const res = await saveCraftDocHandler(ctx({
      craft_type: 'qiaoduan', title: 'x', content: 'c', filename: 'dup-id.md',
    }));
    expect((res.metadata as { craftId: string }).craftId).toBe('dup-id-2');
  });

  it('必填缺失 -> 友好拒绝，无文件写入', async () => {
    const res = await saveCraftDocHandler(ctx({ title: 'T' })); // 缺 craft_type/content
    expect(res.output).toContain('必填');
    expect(res.metadata).toBeUndefined();
    expect(reindexCraftDoc).not.toHaveBeenCalled();
  });

  it('reindex 失败 -> 文档仍保存 + 降级提示（never un-save），indexed=false', async () => {
    vi.mocked(reindexCraftDoc).mockRejectedValue(new Error('db locked'));
    const res = await saveCraftDocHandler(ctx({ craft_type: 'jiezou', title: '节奏注', content: '黄金 300 字' }));
    expect(res.output).toContain('已策展入全局 craft KB');
    expect(res.output).toContain('索引重建失败');
    expect(res.output).toContain('watcher'); // 恢复路径提示
    expect(res.metadata).toMatchObject({ ok: true, indexed: false });
    expect(existsSync(path.join(RESEARCH_DIR, '节奏注.md'))).toBe(true);
  });

  it('filename 参数自定义 slug（sanitize 同样生效）', async () => {
    const res = await saveCraftDocHandler(ctx({
      craft_type: 'pattern', title: '标题不影响', content: 'c',
      filename: '../my notes:v2.md',
    }));
    expect((res.metadata as { craftId: string }).craftId).toBe('my-notes-v2');
  });
});

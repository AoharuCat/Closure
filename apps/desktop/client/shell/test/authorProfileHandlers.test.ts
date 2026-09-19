/**
 * author_profile_update shell handler + author-profile:apply IPC tests
 * (Story 8.6 R4, design D5/D6 / §3.1).
 *
 * Real-fs suite（mirror craftCurationHandlers.test.ts——throwaway home 下真跑追加/读取）：
 * 缺文件合法空起步、append dated entry 幂等语义（两次追加两条）、作者手改内容保留
 * （append-only 不重写）、suggest 档 author_profile_patch envelope（before/after 展示面
 * + note 载荷、不写盘）、accept IPC（author-profile:apply 经捕获的 ipcMain.handle 真跑
 * 追加 + 非法输入 structured error）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-author-profile');

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));

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
  ipcMain: { handle },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));

import {
  authorProfileUpdateHandler,
  appendAuthorProfileNote,
  extractLastEntry,
  formatAuthorProfileEntry,
  getAuthorProfilePath,
  sanitizeProfileNoteLines,
} from '../main/ipc/toolHandlers/authorProfileHandlers';
import { registerAuthorProfileIpc } from '../main/ipc/authorProfileIpc';

const PROFILE_PATH = path.join(TEST_HOME, '.orison', 'author_profile.md');

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: '/proj', // unused（机器级全局文件）——handler 不得依赖它
  sessionId: 's1',
  abort: new AbortController().signal,
});

function clean() {
  rmBestEffort(TEST_HOME);
}

beforeAll(() => {
  clean();
});
afterAll(clean);

beforeEach(() => {
  clean();
  handle.mockClear();
});

describe('纯函数：entry 格式 + 尾部提取', () => {
  it('formatAuthorProfileEntry：本地时间 YYYY-MM-DD HH:mm 标题 + note + 尾换行', () => {
    expect(formatAuthorProfileEntry('观察：偏好短对话', new Date(2026, 7, 18, 9, 5)))
      .toBe('## 2026-08-18 09:05\n观察：偏好短对话\n');
    // 补零。
    expect(formatAuthorProfileEntry('x', new Date(2026, 10, 3, 0, 7)))
      .toBe('## 2026-11-03 00:07\nx\n');
  });

  it('extractLastEntry：多条取末条 / 单条在文件头 / 无 entry 形态内容返空串', () => {
    expect(extractLastEntry('## 2026-08-17 10:00\n第一条\n\n## 2026-08-18 11:00\n第二条\n'))
      .toBe('## 2026-08-18 11:00\n第二条');
    expect(extractLastEntry('## 2026-08-18 11:00\n唯一一条\n')).toBe('## 2026-08-18 11:00\n唯一一条');
    expect(extractLastEntry('作者手写的自由前言，无条目标题。')).toBe('');
    expect(extractLastEntry('')).toBe('');
  });
});

describe('appendAuthorProfileNote（persist core，真 fs）', () => {
  it('缺文件合法空起步——mkdir .orison + 首条创建', () => {
    expect(existsSync(PROFILE_PATH)).toBe(false);
    const result = appendAuthorProfileNote('第一次记录', new Date(2026, 7, 18, 9, 5));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filePath).toBe(PROFILE_PATH);
    expect(readFileSync(PROFILE_PATH, 'utf-8')).toBe('## 2026-08-18 09:05\n第一次记录\n');
  });

  it('append 幂等语义——两次追加两条（dated entries 追加式，不覆盖不合并）', () => {
    appendAuthorProfileNote('第一条', new Date(2026, 7, 18, 9, 5));
    appendAuthorProfileNote('第二条', new Date(2026, 7, 18, 9, 6));
    const content = readFileSync(PROFILE_PATH, 'utf-8');
    expect((content.match(/^## /gm) ?? []).length).toBe(2);
    expect(content).toContain('第一条');
    expect(content).toContain('第二条');
    expect(content.trimEnd().endsWith('第二条')).toBe(true); // 追加在尾部
  });

  it('作者手改内容保留——append-only 不重写既有内容（含无尾换行的手改文件）', () => {
    mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    const handWritten = '# 我的作者档案\n\n作者手写的前言，没有尾换行';
    writeFileSync(PROFILE_PATH, handWritten, 'utf-8'); // 故意无尾换行
    appendAuthorProfileNote('新观察', new Date(2026, 7, 18, 9, 5));
    const content = readFileSync(PROFILE_PATH, 'utf-8');
    expect(content.startsWith(handWritten)).toBe(true); // 手改内容逐字保留
    expect(content).toContain('## 2026-08-18 09:05\n新观察');
    // 无尾换行文件 → 分隔补空行（entry 间至少一个空行）。
    expect(content).toContain('作者手写的前言，没有尾换行\n\n## 2026-08-18 09:05');
  });

  it('空白 note 拒绝（ok:false，不写文件）', () => {
    const result = appendAuthorProfileNote('   ');
    expect(result.ok).toBe(false);
    expect(existsSync(PROFILE_PATH)).toBe(false);
  });

  // ── CR-012（8.6 BMad CR）：note 行首 # 转义——防伪造 entry 分段头破坏 extractLastEntry ──

  it('CR-012 sanitizeProfileNoteLines：行首 #（含缩进后 #）逐字符转义；非行首 / 无 # 不动；幂等', () => {
    expect(sanitizeProfileNoteLines('## 2026-01-01 00:00\n伪造的 entry 头')).toBe('\\#\\# 2026-01-01 00:00\n伪造的 entry 头');
    expect(sanitizeProfileNoteLines('  ### indented')).toBe('  \\#\\#\\# indented');
    // 单 # / 正文中间 # 不动（只转义行首标题形态）。
    expect(sanitizeProfileNoteLines('# 单井')).toBe('\\# 单井');
    expect(sanitizeProfileNoteLines('话题 # 不在行首')).toBe('话题 # 不在行首');
    expect(sanitizeProfileNoteLines('普通观察，无井号')).toBe('普通观察，无井号');
    // 幂等：转义后行首是 \，再跑不变形。
    const once = sanitizeProfileNoteLines('## fake');
    expect(sanitizeProfileNoteLines(once)).toBe(once);
  });

  it('CR-012 append 后档案分段不变式：note 含 `## ` 行首也不伪造 entry——extractLastEntry 仍取真实末条', () => {
    appendAuthorProfileNote('第一条真实观察', new Date(2026, 7, 18, 9, 5));
    appendAuthorProfileNote('作者提到：\n## 2020-01-01 00:00\n他手写过假条目', new Date(2026, 7, 18, 9, 6));
    const content = readFileSync(PROFILE_PATH, 'utf8');
    // 两个真实 entry 头（伪造行已被转义，不参与 ^## 计数）。
    expect((content.match(/^## /gm) ?? []).length).toBe(2);
    // extractLastEntry 取真实末条（含被转义的伪造行原文），不被 note 内伪头误截。
    const last = extractLastEntry(content);
    expect(last).toContain('2026-08-18 09:06');
    expect(last).toContain('他手写过假条目');
    expect(last).not.toMatch(/^## 2026-08-18 09:06\n## /); // 伪头不在 entry 首行裸露
    expect(content).toContain('\\#\\# 2020-01-01 00:00');
  });

  it('CR-012 suggest 档 envelope：note 载荷与 after 预览同走 sanitize（accept 重放形态一致）', async () => {
    mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, '## 2026-08-17 10:00\n既有观察\n', 'utf8');
    const res = await authorProfileUpdateHandler(ctx({ note: '观察：\n## 2026-01-01 00:00\n作者爱写伪头' }));
    expect(res.metadata?.type).toBe('author_profile_patch');
    expect(res.metadata?.note).toContain('\\#\\# 2026-01-01 00:00');
    expect(String(res.metadata?.note)).not.toMatch(/\n## 2026-01-01/);
    expect(String(res.metadata?.after)).toContain('\\#\\# 2026-01-01 00:00');
  });
});

describe('authorProfileUpdateHandler（tool handler）', () => {
  it('suggest 档（缺省）：不写盘，产 author_profile_patch envelope（note 载荷 + before/after 展示面）', async () => {
    mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, '## 2026-08-17 10:00\n既有观察\n', 'utf-8');

    const res = await authorProfileUpdateHandler(ctx({ note: '  作者讨厌被催规划  ' }));
    expect(res.metadata?.type).toBe('author_profile_patch'); // 专用 envelope，非 field_patch
    expect(res.metadata?.note).toBe('作者讨厌被催规划'); // trim 后的 accept 载荷
    expect(res.metadata?.before).toBe('## 2026-08-17 10:00\n既有观察');
    // after = before entry + 空行 + 新 entry（时间戳运行时生成——断言结构形态不锁日期）。
    const after = String(res.metadata?.after);
    expect(after.startsWith('## 2026-08-17 10:00\n既有观察\n\n## ')).toBe(true);
    expect(after.trimEnd().endsWith('作者讨厌被催规划')).toBe(true);
    // suggest 不落盘。
    expect(readFileSync(PROFILE_PATH, 'utf-8')).toBe('## 2026-08-17 10:00\n既有观察\n');
    expect(res.output).toContain('由作者决定是否采纳');
  });

  it('suggest 档缺文件：before 空串（合法空档案）', async () => {
    const res = await authorProfileUpdateHandler(ctx({ note: '首条观察' }));
    expect(res.metadata?.before).toBe('');
    expect(String(res.metadata?.after)).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n首条观察$/);
  });

  it('autoApply=true：直接追加落盘 + applied metadata（两次调用两条）', async () => {
    const res1 = await authorProfileUpdateHandler(ctx({ note: '第一条观察', autoApply: true }));
    expect(res1.metadata).toMatchObject({ ok: true, applied: true });
    expect(existsSync(PROFILE_PATH)).toBe(true);

    const res2 = await authorProfileUpdateHandler(ctx({ note: '第二条观察', autoApply: true }));
    expect(res2.metadata).toMatchObject({ ok: true, applied: true });
    const content = readFileSync(PROFILE_PATH, 'utf-8');
    expect((content.match(/^## /gm) ?? []).length).toBe(2);
    expect(content).toContain('第一条观察');
    expect(content).toContain('第二条观察');
  });

  it('note 空/whitespace/非 string → 友好 skip 不 throw（CR-008 + never-throws）', async () => {
    for (const params of [{ note: '' }, { note: '   ' }, { note: 42 }, {}, { autoApply: true }]) {
      const res = await authorProfileUpdateHandler(ctx(params));
      expect(res.metadata).toBeUndefined();
      expect(res.output).toContain('已跳过');
    }
    expect(existsSync(PROFILE_PATH)).toBe(false);
  });

  it('params null → 友好 skip 不 throw', async () => {
    const res = await authorProfileUpdateHandler({
      params: null as any,
      projectDir: '/proj',
      sessionId: 's1',
      abort: new AbortController().signal,
    });
    expect(res.output).toContain('已跳过');
  });
});

describe('author-profile:apply accept IPC（registerAuthorProfileIpc 真跑）', () => {
  it('注册 channel author-profile:apply；合法输入 → 追加落盘 ok:true', async () => {
    registerAuthorProfileIpc();
    expect(handle).toHaveBeenCalledTimes(1);
    const [channel, handler] = handle.mock.calls[0] as [string, (e: unknown, input: unknown) => Promise<unknown>];
    expect(channel).toBe('author-profile:apply');

    const result = (await handler({}, { note: 'accept 追加的观察' })) as { ok: boolean; filePath?: string };
    expect(result.ok).toBe(true);
    expect(result.filePath).toBe(PROFILE_PATH);
    const content = readFileSync(PROFILE_PATH, 'utf-8');
    expect(content).toContain('accept 追加的观察');
    expect(content).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\naccept 追加的观察\n$/);
  });

  it('既有档案被作者手改后 accept——重放 note 追加，手改内容保留（永不写 stale after 快照）', async () => {
    registerAuthorProfileIpc();
    const [, handler] = handle.mock.calls[0] as [string, (e: unknown, input: unknown) => Promise<unknown>];

    // 提议时的档案形态。
    mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, '## 2026-08-17 10:00\n提议时的旧观察\n', 'utf-8');
    // 提议与采纳之间作者手改（插入自定义内容）。
    writeFileSync(PROFILE_PATH, '## 2026-08-17 10:00\n提议时的旧观察\n\n（作者手改：本周只写短篇）\n', 'utf-8');

    const result = (await handler({}, { note: '采纳的观察' })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const content = readFileSync(PROFILE_PATH, 'utf-8');
    expect(content).toContain('（作者手改：本周只写短篇）'); // 手改保留
    expect(content.trimEnd().endsWith('采纳的观察')).toBe(true); // 追加在尾部
  });

  it('非法输入（缺 note / 空 note / 非对象 / CR-018 超长）→ structured {ok:false} 不 throw', async () => {
    registerAuthorProfileIpc();
    const [, handler] = handle.mock.calls[0] as [string, (e: unknown, input: unknown) => Promise<unknown>];
    // CR-018：note > 4000 在 IPC schema 层拒（与 agent 工具参数 / shared-contracts schema 同步）。
    for (const bad of [undefined, {}, { note: '' }, { note: 42 }, 'string-input', { note: 'x'.repeat(4001) }]) {
      const result = (await handler({}, bad)) as { ok: boolean; reason: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('invalid input');
    }
  });
});

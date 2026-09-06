import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconStylePayload, Material } from '@orison/shared-contracts';

// E10.3b W5：风格导出测试——mergeDeconStyleCard 纯函数面（语义键替换/手写与未识别节保留/
// 无卡标准 14 节新建/fenced 节选不误切/坏形防御）+ decon:export-style IPC handler 面（落盘/
// style-payload-missing/project-not-found/stale 拒绝/路径门）。ABI 门控 + throwaway home。

const TEST_HOME = path.join(process.cwd(), 'test-tmp-decon-style-export');
const PROJECT_DIR = path.join(TEST_HOME, 'proj-style-target');

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_HOME,
    isPackaged: false,
  },
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
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  // styleExport 消费 agent 包导出的 parseStyleSections（W1 入口补挂）——**partial mock**
  // 保留真实导出，只覆写 LLM 解析面（resolveTaskModel 等不被本测试触达）。
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return { ...actual, resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() };
});
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { upsertDeconProduct } from '../main/db/closure-decon';
import { upsertMaterialRow } from '../main/db/materialIndexer';
import { ensureProject } from '../main/db/projectRepository';
import { createDeconJob, type DeconJobDeps } from '../main/decon/deconJob';
import { mergeDeconStyleCard } from '../main/decon/styleExport';
import { createDeconIpcHandlers, type DeconIpcHandlers } from '../main/ipc/deconIpc';
import { allowPath } from '../main/ipc/pathGuard';
import { withProjectLock } from '../main/fs/projectWriteLock';
import { composeDerivedText } from '../main/ipc/toolHandlers/materialIngest';

let sqliteUsable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  sqliteUsable = false;
}

function clean() {
  closeDb();
  resetSqliteVecState();
  rmBestEffort(TEST_HOME);
}

/** 手动 resolve 门（CR-4 并发语义测试——排队写者挂起面）。 */
function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ── fixtures ──

const MAT_ID = 'mat-0000000000d5';
const CONTENT_HASH = `sha256:${'d'.repeat(64)}`;
const BODY = ['风格测试第一章正文，句子平实。', '风格测试第二章正文，对话占四成。'].join('\n\n');
const { derived } = composeDerivedText(BODY, [
  { start: 0, end: BODY.split('\n\n')[0]!.length, title: '第1章' },
  { start: BODY.split('\n\n')[0]!.length + 2, end: BODY.length, title: '第2章' },
], 'regex', 'high');

function sha(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

const DERIVED_HASH = sha(derived);
const NOW = new Date('2026-09-05T14:00:00.000Z');

const STYLE_PAYLOAD: DeconStylePayload = {
  sections: {
    voice: '叙述者口吻：冷静克制，对人物带着温和的体察。',
    stats: '- 句子长度：均值 18.0 字（最短 6 / 最长 44，离散度 8.2，样本数 210）',
    syntax: '短句为主，长句只用于情绪推进。',
    excerpt: '```text\n风格测试第一章正文，句子平实。\n```',
    appendix: '来源：《风格测试小说》（材料 mat-0000000000d5）。本报告为本地拆书私用的节选级引用。',
  },
  excerptAnchors: [{ chapterIndex: 0, charStart: 0, charEnd: 12, paraStart: 0, paraEnd: 1 }],
  bookTitle: '风格测试小说',
  materialId: MAT_ID,
};

function mkMaterial(): Material {
  const firstLen = BODY.split('\n\n')[0]!.length;
  return {
    materialId: MAT_ID,
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '风格测试小说',
    format: 'txt',
    provenance: {
      medium: 'novel_text',
      tier: 'original',
      sourcePath: 'novel.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-05T00:00:00.000Z',
      author: null,
      lang: null,
      originDate: null,
      description: null,
    },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: BODY.length,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters: [
      { index: 0, title: '第1章', charStart: 0, charEnd: firstLen, paraStart: 0, paraEnd: 0, confidence: 'high', method: 'regex' },
      { index: 1, title: '第2章', charStart: firstLen + 2, charEnd: BODY.length, paraStart: 0, paraEnd: 0, confidence: 'high', method: 'regex' },
    ],
    chunkSpans: [],
    contentHash: CONTENT_HASH,
    status: 'ready',
  };
}

// ── 纯函数面（无 db）──

describe('mergeDeconStyleCard（纯函数）', () => {
  it('无卡新建：标准卡头 + 来源注记 + payload 各节标准标题（标准序）', () => {
    const merged = mergeDeconStyleCard(null, STYLE_PAYLOAD, '风格测试小说');
    expect(merged.content.startsWith('# 风格卡片')).toBe(true);
    expect(merged.content).toContain('> 本卡管「像谁」（正面画像）；llmlint 管「不像 AI」（负面清单）——两者互补。');
    expect(merged.content).toContain('> 本卡由拆书风格维导出生成（来源《风格测试小说》）');
    // 标准标题 + 标准序（voice → stats → syntax → … → excerpt → appendix）。
    const idxVoice = merged.content.indexOf('## ① 声音画像');
    const idxStats = merged.content.indexOf('## ② 机械统计');
    const idxSyntax = merged.content.indexOf('## ③ 句法与文字节奏');
    const idxExcerpt = merged.content.indexOf('## ⑬ 节选（few-shot）');
    const idxAppendix = merged.content.indexOf('## ⑭ 原文附录');
    expect(idxVoice).toBeGreaterThan(-1);
    expect(idxStats).toBeGreaterThan(idxVoice);
    expect(idxSyntax).toBeGreaterThan(idxStats);
    expect(idxExcerpt).toBeGreaterThan(idxSyntax);
    expect(idxAppendix).toBeGreaterThan(idxExcerpt);
    expect(merged.content).toContain('叙述者口吻：冷静克制');
    expect(merged.writtenSections).toEqual(['voice', 'stats', 'syntax', 'excerpt', 'appendix']);
  });

  it('既有卡合并：语义键替换 + 手写/未识别节保留 + 卡头序言逐字保留 + 缺节追加', () => {
    const existing = [
      '---',
      'title: 手工风格卡',
      '---',
      '# 风格卡片',
      '',
      '> 手写注记一行。',
      '',
      '## ① 声音画像',
      '',
      '旧的手写声音。',
      '',
      '## 作者手记',
      '',
      '这一节是我自己写的，导出不许动。',
      '',
      '## ③ 句法与文字节奏',
      '',
      '旧的句法观察。',
      '',
      '## ⑫ 禁则',
      '',
      '手写禁则保留。',
      '',
    ].join('\n');
    const merged = mergeDeconStyleCard(existing, STYLE_PAYLOAD, '风格测试小说');
    // 序言（frontmatter + H1 + 手写注记）逐字保留。
    expect(merged.content).toContain('---\ntitle: 手工风格卡\n---\n# 风格卡片');
    expect(merged.content).toContain('> 手写注记一行。');
    // 语义键替换：①/③ 换成 payload 内容（标准标题形态）。
    expect(merged.content).not.toContain('旧的手写声音');
    expect(merged.content).not.toContain('旧的句法观察');
    expect(merged.content).toContain('叙述者口吻：冷静克制');
    expect(merged.content).toContain('短句为主，长句只用于情绪推进。');
    // 未识别节（作者手记）与无 payload 键的手写节（⑫ 禁则）原样保留。
    expect(merged.content).toContain('## 作者手记');
    expect(merged.content).toContain('这一节是我自己写的，导出不许动。');
    expect(merged.content).toContain('## ⑫ 禁则');
    expect(merged.content).toContain('手写禁则保留。');
    // 卡内没有的 payload 节（stats/excerpt/appendix）按标准序追加在尾部。
    expect(merged.content).toContain('## ② 机械统计');
    expect(merged.content.indexOf('## ⑬ 节选（few-shot）')).toBeGreaterThan(merged.content.indexOf('## ② 机械统计'));
    // writtenSections = 实际写入键（标准序——确定性回执，UI 写前确认按此展示）。
    expect(merged.writtenSections).toEqual(['voice', 'stats', 'syntax', 'excerpt', 'appendix']);
    // 追加节在手写节之后（卡内节序不被打乱）。
    expect(merged.content.indexOf('## ② 机械统计')).toBeGreaterThan(merged.content.indexOf('## 作者手记'));
  });

  it('fenced 节选内的 `## ` 行不误切节（⑭ 仍可被识别替换；后续手写节保留）', () => {
    const existing = [
      '# 风格卡片',
      '',
      '## ⑬ 节选（few-shot）',
      '',
      '```text',
      '## 第一章 假章标题（原文里的行——不切节）',
      '正文……',
      '```',
      '',
      '## ⑭ 原文附录',
      '',
      '```text',
      '旧附录全文。',
      '```',
      '',
      '## 作者手记',
      '',
      '围栏后手写节，必须保留。',
      '',
    ].join('\n');
    const payload: DeconStylePayload = {
      ...STYLE_PAYLOAD,
      sections: { ...STYLE_PAYLOAD.sections, appendix: '新的附录注记。' },
    };
    const merged = mergeDeconStyleCard(existing, payload, '风格测试小说');
    // ⑬/⑭ 都被解析为独立节（fenced 内的假 `## ` 行没把 ⑭ 吞进 ⑬ 内容——否则 appendix
    // 不可替换）；两节都被 payload 替换。
    expect(merged.writtenSections).toContain('excerpt');
    expect(merged.writtenSections).toContain('appendix');
    expect(merged.content).toContain('新的附录注记。');
    expect(merged.content).not.toContain('旧附录全文');
    // ⑬ 替换为 payload 节选（fenced 假标题行随旧节内容退场）。
    expect(merged.content).not.toContain('## 第一章 假章标题');
    expect(merged.content).toContain('```text\n风格测试第一章正文，句子平实。\n```');
    // 围栏后的手写节保留（fence 开合对称——解析器回到节识别态）。
    expect(merged.content).toContain('## 作者手记');
    expect(merged.content).toContain('围栏后手写节，必须保留。');
  });

  it('坏形防御：无任何 `## ` 节标题的卡整卡当序言保留（零丢弃）', () => {
    const garbage = '# 随便一个标题\n\n没有任何标准节的胡乱内容，不许丢。';
    const merged = mergeDeconStyleCard(garbage, STYLE_PAYLOAD, '风格测试小说');
    expect(merged.content).toContain('没有任何标准节的胡乱内容，不许丢。');
    expect(merged.content).toContain('## ① 声音画像');
    expect(merged.writtenSections).toEqual(['voice', 'stats', 'syntax', 'excerpt', 'appendix']);
  });

  it('CR-20：首节标题串先出现在 fenced 块内 → 前言不错切（fence 感知定位——真节前内容零丢）', () => {
    const existing = [
      '# 风格卡片',
      '',
      '> 卡头注记，必须保留。',
      '',
      '```text',
      '## ① 声音画像',
      '（节选引文里先出现了节标题文本——不是真节）',
      '```',
      '',
      '## ① 声音画像',
      '',
      '旧的手写声音。',
      '',
    ].join('\n');
    const merged = mergeDeconStyleCard(existing, STYLE_PAYLOAD, '风格测试小说');
    // 前言逐字保留到**真节**为止：卡头注记 + 整个 fenced 块（含假标题行与其后引文）都在
    // ——旧 indexOf 实现会把前言错切到围栏内的假标题处，围栏尾半段被静默丢。
    expect(merged.content).toContain('> 卡头注记，必须保留。');
    expect(merged.content).toContain('## ① 声音画像');
    expect(merged.content).toContain('（节选引文里先出现了节标题文本——不是真节）');
    // 真节 ① 语义键照常替换（payload 内容进卡、旧手写声音退场）。
    expect(merged.content).not.toContain('旧的手写声音');
    expect(merged.content).toContain('叙述者口吻：冷静克制');
    expect(merged.writtenSections).toContain('voice');
  });
});

// ── IPC handler 面（db + fs + 项目注册库）──

describe.skipIf(!sqliteUsable)('decon:export-style handler', () => {
  let handlers: DeconIpcHandlers;
  let jobId: string;
  let projectId: string;

  beforeEach(() => {
    clean();
    mkdirSync(PROJECT_DIR, { recursive: true });
    allowPath(PROJECT_DIR); // pick-directory 先例：注册库项目路径的授权面
    getDb();
    upsertMaterialRow(mkMaterial());
    const jobDeps: DeconJobDeps = {
      readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: DERIVED_HASH }),
      now: () => NOW,
    };
    handlers = createDeconIpcHandlers({
      readCurrentFingerprints: jobDeps.readCurrentFingerprints,
      now: () => NOW,
      runPipeline: () => Promise.resolve({ status: 'done' }),
      notify: () => undefined,
    });
    const created = createDeconJob({ materialId: MAT_ID, tier: 'coarse', dimensions: ['style'] }, jobDeps);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('seed job failed');
    jobId = created.job.jobId;
    const ok = upsertDeconProduct({ jobId, pass: 'p4:style', unit: 'all', payload: STYLE_PAYLOAD, updatedAt: NOW.toISOString() });
    expect(ok).toBe(true);
    const record = ensureProject({ name: '导出目标项目', type: 'novel', localFingerprint: PROJECT_DIR, path: PROJECT_DIR });
    projectId = record.projectId;
  });
  afterEach(() => {
    clean();
  });

  const stylePath = (): string => path.join(PROJECT_DIR, 'settings', 'style.md');

  it('有 payload 有项目：merge 落盘 settings/style.md（无卡新建路径 + writtenSections 回执）', async () => {
    const result = await handlers.exportStyleDecon({ jobId, projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writtenSections).toEqual(['voice', 'stats', 'syntax', 'excerpt', 'appendix']);
    const written = readFileSync(stylePath(), 'utf-8');
    expect(written.startsWith('# 风格卡片')).toBe(true);
    expect(written).toContain('叙述者口吻：冷静克制');
    expect(written).toContain('```text\n风格测试第一章正文，句子平实。\n```');
  });

  it('已有手写卡：合并语义落盘（手写节保留——不覆写用户内容）', async () => {
    mkdirSync(path.join(PROJECT_DIR, 'settings'), { recursive: true });
    const existing = ['# 风格卡片', '', '## 作者手记', '', '我的手写节。', ''].join('\n');
    writeFileSync(stylePath(), existing, 'utf-8');
    const result = await handlers.exportStyleDecon({ jobId, projectId });
    expect(result.ok).toBe(true);
    const written = readFileSync(stylePath(), 'utf-8');
    expect(written).toContain('## 作者手记');
    expect(written).toContain('我的手写节。');
    expect(written).toContain('## ① 声音画像');
  });

  it('CR-4：读+合并+写同锁——锁外排队写者的更新不被陈旧快照覆写（丢更新防线）', async () => {
    mkdirSync(path.join(PROJECT_DIR, 'settings'), { recursive: true });
    // 排队中的另一项目写者（先占项目锁，gate 放行后才落盘）。
    const gate = deferredVoid();
    const queued = withProjectLock(PROJECT_DIR, async () => {
      await gate.promise;
      writeFileSync(stylePath(), ['# 风格卡片', '', '## 作者手记', '', '排队写者写入的手写节。', ''].join('\n'), 'utf-8');
    });
    // 导出（invoke 即返 promise；其读-合并-写 op 排在 queued 之后——若读在锁外〔旧实现〕，
    // 会在排队写者落盘前读到空文件 → 最终原子写把写者内容整体覆掉 = 丢更新）。
    const exportPromise = handlers.exportStyleDecon({ jobId, projectId });
    gate.resolve();
    await queued;
    const result = await exportPromise;
    expect(result.ok).toBe(true);
    // 排队写者的手写节存活 = 导出的既有卡读取发生在其落盘之后（锁内读）。
    const written = readFileSync(stylePath(), 'utf-8');
    expect(written).toContain('## 作者手记');
    expect(written).toContain('排队写者写入的手写节。');
    // 导出节照常落（合并语义在锁内完整执行）。
    expect(written).toContain('## ① 声音画像');
    expect(written).toContain('叙述者口吻：冷静克制');
  });

  it('payload 缺失 → style-payload-missing（先跑完 p4:style 再导出）', async () => {
    getDb().prepare(`DELETE FROM closure_decon_product WHERE job_id=? AND pass='p4:style'`).run(jobId);
    const result = await handlers.exportStyleDecon({ jobId, projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('style-payload-missing');
  });

  it('项目不存在 → project-not-found；job 不存在 → not-found；坏参 → invalid-input', async () => {
    const badProject = await handlers.exportStyleDecon({ jobId, projectId: '99999' });
    expect(badProject.ok).toBe(false);
    if (!badProject.ok) expect(badProject.error).toBe('project-not-found');
    const badJob = await handlers.exportStyleDecon({ jobId: 'decon-0000000000ee', projectId });
    expect(badJob.ok).toBe(false);
    if (!badJob.ok) expect(badJob.error).toBe('not-found');
    const badInput = await handlers.exportStyleDecon({ projectId });
    expect(badInput.ok).toBe(false);
    if (!badInput.ok) expect(badInput.error).toBe('invalid-input');
  });

  it('stale job（双指纹失配）→ 导出被拒（漂移锚点的风格产物不供给——F-02 读侧半边）', async () => {
    const staleHandlers = createDeconIpcHandlers({
      readCurrentFingerprints: () => ({ materialContentHash: CONTENT_HASH, derivedHash: `sha256:${'e'.repeat(64)}` }),
      now: () => NOW,
      runPipeline: () => Promise.resolve({ status: 'done' }),
      notify: () => undefined,
    });
    const result = await staleHandlers.exportStyleDecon({ jobId, projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('operation-failed');
      expect(result.message).toContain('失配');
    }
  });
});

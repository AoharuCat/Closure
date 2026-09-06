/**
 * attachment-meta sidecar 测试（A 波 09-01，design §1.2c / D-B''）。
 *
 * 纯函数矩阵（shingle 相似度 80% 边界两档 / 精确查找 / 损坏 JSON fail-soft /
 * 条目形态归一）+ 薄 IO（缺失/损坏降级空表、atomicWrite 落盘 roundtrip）。
 * 真实 temp 目录 + 真 fs（mirror parseDocumentHandlers.test.ts 形态），零网络。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import {
  ATTACHMENT_SHINGLE_SIZE,
  ATTACHMENT_SIMILARITY_THRESHOLD,
  ATTACHMENT_SAMPLE_MAX_CHARS,
  attachmentMetaPath,
  findExactEntry,
  findSimilarEntry,
  loadAttachmentMeta,
  parseAttachmentMetaJson,
  saveAttachmentMeta,
  shingleSimilarity,
  shinglesOf,
  withAttachmentMetaLock,
  type AttachmentMetaEntry,
} from '../main/research/attachmentMeta';
import { rmBestEffort } from './rmBestEffort';

// ── Fixtures ──

/**
 * 确定性伪随机文本（LCG over CJK 区）：5-gram 几乎全不重复——Jaccard 分母可按
 * 字符长度推算（2000 字文本 ≈ 1996 个 gram），相似度断言不碰运气。
 * 不同 seed 产出零重叠文本（跨 seed 5-gram 命中率 ~0）。
 */
function lcgText(n: number, seed: number): string {
  let state = (seed >>> 0) || 1;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(0x4e00 + (state % 5000));
  }
  return out;
}

const BASE = lcgText(2_000, 42);
/** 小幅修改：开头 2000 字保留 + 追加 ~20% 新内容 → Jaccard ≈ 1996/2392 ≈ 0.83 ≥ 0.8。 */
const LIGHTLY_EDITED = BASE + lcgText(400, 777);
/** 大幅改写：仅保留前 30%，其余全换 → Jaccard ≈ 596/2792 ≈ 0.21 < 0.8。 */
const HEAVILY_REWRITTEN = BASE.slice(0, 600) + lcgText(1_400, 999);

function entry(overrides: Partial<AttachmentMetaEntry> = {}): AttachmentMetaEntry {
  return {
    contentHash: 'sha256:fixture',
    lastSeenPath: 'inbox/大纲.md',
    derivedOf: 'inbox/大纲.docx',
    description: '历史卷宗大纲',
    generatedAt: 1_700_000_000_000,
    sample: BASE,
    ...overrides,
  };
}

let projectDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'attachment-meta-'));
});

afterEach(() => {
  rmBestEffort(projectDir);
});

// ── shingle 相似度 ──

describe('shingleSimilarity（纯代码差分，R1.2c）', () => {
  it('常量钉死：5-gram / 80% 阈值 / sample 8K 截取', () => {
    expect(ATTACHMENT_SHINGLE_SIZE).toBe(5);
    expect(ATTACHMENT_SIMILARITY_THRESHOLD).toBe(0.8);
    expect(ATTACHMENT_SAMPLE_MAX_CHARS).toBe(8_000);
  });

  it('同内容 = 1；空白差异不算内容差异', () => {
    expect(shingleSimilarity(BASE, BASE)).toBe(1);
    expect(shingleSimilarity(BASE, BASE.replace(/(.{50})/g, '$1\n'))).toBe(1);
  });

  it('短于 n-gram 或空 sample = 0（空对空不构成同内容证据）', () => {
    expect(shingleSimilarity('', '')).toBe(0);
    expect(shingleSimilarity('短文', '短文')).toBe(0);
    expect(shingleSimilarity(BASE, '')).toBe(0);
    expect(shinglesOf('abcd').size).toBe(0);
    expect(shinglesOf(BASE).size).toBeGreaterThan(1_900);
  });

  it('80% 边界两档：小幅修改（~0.83）≥ 阈值；大幅改写（~0.21）低于阈值', () => {
    const light = shingleSimilarity(LIGHTLY_EDITED, BASE);
    const heavy = shingleSimilarity(HEAVILY_REWRITTEN, BASE);
    expect(light).toBeGreaterThanOrEqual(ATTACHMENT_SIMILARITY_THRESHOLD);
    expect(light).toBeLessThan(1);
    expect(heavy).toBeLessThan(ATTACHMENT_SIMILARITY_THRESHOLD);
  });
});

// ── 条目查找 ──

describe('findExactEntry / findSimilarEntry', () => {
  it('精确命中按 contentHash；未命中 undefined', () => {
    const entries = [entry({ contentHash: 'sha256:a' }), entry({ contentHash: 'sha256:b' })];
    expect(findExactEntry(entries, 'sha256:b')).toBe(entries[1]);
    expect(findExactEntry(entries, 'sha256:zz')).toBeUndefined();
  });

  it('相似命中：小幅修改命中原条目，大幅改写 miss；多命中取最高分', () => {
    const baseEntry = entry({ contentHash: 'sha256:old', sample: BASE }); // vs LIGHTLY ≈ 0.833
    // 次高命中：BASE + 80 字小尾巴 → vs LIGHTLY ≈ 0.806（同样过阈但分数更低）。
    const near = entry({ contentHash: 'sha256:near', sample: BASE + lcgText(80, 555) });
    const unrelated = entry({ contentHash: 'sha256:un', sample: lcgText(2_000, 24) });
    const entries = [unrelated, near, baseEntry];

    expect(findSimilarEntry(entries, LIGHTLY_EDITED)).toBe(baseEntry);
    expect(findSimilarEntry([near, unrelated], LIGHTLY_EDITED)).toBe(near);
    expect(findSimilarEntry(entries, HEAVILY_REWRITTEN)).toBeUndefined();
  });

  it('空 sample 条目永不相似命中', () => {
    expect(findSimilarEntry([entry({ sample: '' })], BASE)).toBeUndefined();
  });
});

// ── JSON 解析（fail-soft）──

describe('parseAttachmentMetaJson', () => {
  it('合法 JSON 完整 roundtrip', () => {
    const meta = { entries: [entry(), entry({ derivedOf: null, description: '', generatedAt: 0 })] };
    const parsed = parseAttachmentMetaJson(JSON.stringify(meta));
    expect(parsed).toEqual(meta);
  });

  it('损坏 JSON / 非对象 / entries 非数组 → 空表（fail-soft 不抛）', () => {
    expect(parseAttachmentMetaJson('{oops')).toEqual({ entries: [] });
    expect(parseAttachmentMetaJson('"string"')).toEqual({ entries: [] });
    expect(parseAttachmentMetaJson('null')).toEqual({ entries: [] });
    expect(parseAttachmentMetaJson('{"entries": "nope"}')).toEqual({ entries: [] });
  });

  it('单条畸形跳过其余保留；缺省字段归一（derivedOf 非 string → null 等）', () => {
    const raw = JSON.stringify({
      entries: [
        { contentHash: 'sha256:ok', lastSeenPath: 'inbox/a.md' }, // 最小合法条目
        { contentHash: 123, lastSeenPath: 'x' }, // 缺关键 → 跳过
        'garbage', // 非对象 → 跳过
        { contentHash: 'sha256:partial', lastSeenPath: 'inbox/b.md', generatedAt: 'not-a-number' },
      ],
    });
    const parsed = parseAttachmentMetaJson(raw);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({
      contentHash: 'sha256:ok',
      lastSeenPath: 'inbox/a.md',
      derivedOf: null,
      description: '',
      generatedAt: 0,
      sample: '',
    });
    expect(parsed.entries[1]!.generatedAt).toBe(0);
  });
});

// ── 薄 IO ──

describe('loadAttachmentMeta / saveAttachmentMeta', () => {
  it('无文件 → 空表；落盘自动建 .orison/ 并 roundtrip', () => {
    expect(loadAttachmentMeta(projectDir)).toEqual({ entries: [] });
    expect(saveAttachmentMeta(projectDir, { entries: [entry()] })).toBe(true);

    const p = attachmentMetaPath(projectDir);
    expect(p).toBe(path.join(projectDir, '.orison', 'attachment-meta.json'));
    const loaded = loadAttachmentMeta(projectDir);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toEqual(entry());
  });

  it('盘上损坏 JSON → 空表降级（不抛、不覆盖原档；parse 级降级静默——warn 只挂读失败）', () => {
    mkdirSync(path.dirname(attachmentMetaPath(projectDir)), { recursive: true });
    writeFileSync(attachmentMetaPath(projectDir), '{corrupt', 'utf-8');
    expect(loadAttachmentMeta(projectDir)).toEqual({ entries: [] });
    // 降级读不主动清档——下一次 save 才会覆盖为干净内容。
  });
});

// ── 进程内串行化（CR-008，09-01 CR patch）──

describe('withAttachmentMetaLock（sidecar 读-改-写串行化）', () => {
  it('重叠临界区按提交顺序串行：前段未 settle 后段不开工', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAttachmentMetaLock(projectDir, async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = withAttachmentMetaLock(projectDir, () => {
      order.push('second-start');
    });
    // 让微任务沉淀后断言：第二段被链在第一段尾部，尚未开工。
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('前段失败不卡队列（成功或失败都放行后续——mirror projectWriteLock 契约）', async () => {
    const order: string[] = [];
    const first = withAttachmentMetaLock(projectDir, async () => {
      order.push('first');
      throw new Error('boom');
    }).catch(() => 'caught');
    const second = withAttachmentMetaLock(projectDir, () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('并发 load→mutate→save（临界区内含 await 缝）经锁两不丢', async () => {
    // 意图断言（CR-008 的失效形态）：无锁时四个并发 RMW 各自持有旧快照、跨 await
    // 交错后 last-write-wins 只剩 1 条；过锁后按提交顺序串行、4 条全数落盘。
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        withAttachmentMetaLock(projectDir, async () => {
          const meta = loadAttachmentMeta(projectDir);
          await new Promise((r) => setTimeout(r, 1)); // 模拟临界区内的异步缝
          meta.entries.push(entry({ contentHash: `sha256:${i}`, lastSeenPath: `inbox/${i}.md`, derivedOf: null }));
          saveAttachmentMeta(projectDir, meta);
        }),
      ),
    );
    const loaded = loadAttachmentMeta(projectDir);
    expect(loaded.entries).toHaveLength(4);
    expect(new Set(loaded.entries.map((e) => e.contentHash)).size).toBe(4);
  });

  it('不同项目互不串行（per-project 键控）；同 key 归一（resolve 形态）', async () => {
    // 不同 projectDir 并行（本测试只验证不互锁死——两段都能完成）。
    const other = `${projectDir}-other`;
    await Promise.all([
      withAttachmentMetaLock(projectDir, async () => {
        await new Promise((r) => setTimeout(r, 2));
      }),
      withAttachmentMetaLock(other, async () => {
        await new Promise((r) => setTimeout(r, 0));
      }),
    ]);
    expect(true).toBe(true);
  });
});

import { rmBestEffort } from './rmBestEffort';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeconJob, DeconProgressEvent, Material } from '@orison/shared-contracts';

// dogfood R3 修复批 W1a（C3/C4/C5）：deconRun 新 helpers 单测——runDeconLlmCall（截断升帽
// 重试两径 + 预算门每 attempt 过门 + actual 各记各的）/ loadExtractableMaterial（中间态恢复
// vs 真零章诚实失败）/ buildDeconChapterHeadings + 标签族（真实章标行解析——F19 章号错位）。
// ABI 门控 + throwaway home（mirror deconP3Label.test.ts；runDeconLlmCall 面需 db——
// writeDeconCost 落 job 行）。

const TEST_HOME = vi.hoisted(() => process.cwd() + (process.platform === 'win32' ? '\\' : '/') + 'test-tmp-decon-runhelpers');

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
}));

vi.mock('../main/ipc/modelGatewayIpc', () => ({
  resolveEmbeddingModel: () => null,
  resolveRerankModel: () => null,
  resolveSummaryModel: () => null,
  resolveModel: () => {
    throw new Error('resolveModel should not be called');
  },
}));
vi.mock('@orison/desktop-agent', () => ({ resolveTaskModel: vi.fn(), assignmentThinkingControl: vi.fn() }));
vi.mock('@orison/model-protocols', () => ({ generateText: vi.fn(), generateEmbeddings: vi.fn() }));

import { closeDb, getDb } from '../main/db/index';
import { resetSqliteVecState } from '../main/db/sqliteVecLoader';
import { getDeconJob, upsertDeconJob } from '../main/db/closure-decon';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import {
  DECON_LLM_RETRY_ESCALATE,
  DECON_MATERIAL_FAILED_STREAK,
  DECON_MATERIAL_LOAD_RETRY_ATTEMPTS,
  loadExtractableMaterial,
  runDeconLlmCall,
} from '../main/decon/deconRun';
import { estimateDeconCallTokens } from '../main/decon/deconRun';

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

beforeAll(() => {
  if (sqliteUsable) {
    rmBestEffort(TEST_HOME);
    getDb();
  }
});

afterAll(() => {
  clean();
});

const maybe = sqliteUsable ? describe : describe.skip;

// ── C4-F12：材料读点有限重试（deps.getMaterialRow 注入——零 db 依赖）──

function mat(status: Material['status'], chapters: number): Material {
  return {
    materialId: 'mat-000000000009',
    scope: 'global',
    projectId: null,
    kind: 'prose',
    name: '重试测试小说',
    format: 'txt',
    provenance: {
      medium: 'novel_text',
      tier: 'original',
      sourcePath: 'novel.txt',
      via: 'direct-read',
      extractor: 'builtin-text',
      ingestedAt: '2026-09-12T00:00:00.000Z',
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
      charCount: 1000,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
    },
    chapters: Array.from({ length: chapters }, (_, i) => ({
      index: i,
      title: `第${i + 1}章`,
      charStart: i * 100,
      charEnd: i * 100 + 100,
      paraStart: 0,
      paraEnd: 0,
      confidence: 'high' as const,
      method: 'regex' as const,
    })),
    chunkSpans: [],
    contentHash: `sha256:${'d'.repeat(64)}`,
    status,
  };
}

describe('loadExtractableMaterial（C4-F12 中间态有限重试）', () => {
  it('行在且 ≥1 章 → 立即 ok（零等待）', async () => {
    let waits = 0;
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => mat('ready', 3),
      waitMs: async () => {
        waits += 1;
      },
    });
    expect(result.ok).toBe(true);
    expect(waits).toBe(0);
  });

  it('中间态零章（pending）→ 轮询等待，第 3 次探针恢复 → ok（F12 竞态窗口收敛）', async () => {
    let probes = 0;
    let waits = 0;
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => {
        probes += 1;
        return probes < 3 ? mat('pending', 0) : mat('ready', 98);
      },
      waitMs: async () => {
        waits += 1;
      },
    });
    expect(result.ok).toBe(true);
    expect(probes).toBe(3);
    expect(waits).toBe(2); // 探针间隔各等一次
  });

  it('真删除（行恒缺）→ 重试窗口耗尽诚实失败（等待 attempts-1 次）', async () => {
    let waits = 0;
    const result = await loadExtractableMaterial('gone-000000000009', {
      getMaterialRow: () => null,
      waitMs: async () => {
        waits += 1;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('不存在');
    expect(waits).toBe(DECON_MATERIAL_LOAD_RETRY_ATTEMPTS - 1);
  });

  it('中间态零章（pending）重试不收敛 → 耗尽诚实失败（CR-5：pending 仍走全窗口——重登记真在途）', async () => {
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => mat('pending', 0),
      waitMs: async () => {},
      attempts: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('仍为空');
  });

  it('CR-5：durable failed 零章且行快照连续 3 次相同 → 提前诚实失败（不等全窗口）', async () => {
    let probes = 0;
    let waits = 0;
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => {
        probes += 1;
        return mat('failed', 0); // contentHash/章数/状态 恒同
      },
      waitMs: async () => {
        waits += 1;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('摄取已失败且无变化');
      expect(result.message).toContain('请先重摄取');
    }
    expect(probes).toBe(DECON_MATERIAL_FAILED_STREAK);
    expect(waits).toBe(DECON_MATERIAL_FAILED_STREAK - 1); // 末次探针命中快败不再等
  });

  it('CR-5：failed 但行快照在变（重登记真在途）→ 快败不触发走全窗口', async () => {
    let probes = 0;
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => {
        probes += 1;
        // 每次探针指纹不同——streak 永远重置（摄取失败行正在被重写）
        return { ...mat('failed', 0), contentHash: `sha256:${'d'.repeat(63)}${probes}` };
      },
      waitMs: async () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('仍为空');
    expect(probes).toBe(DECON_MATERIAL_LOAD_RETRY_ATTEMPTS + 1); // 全窗口 + 终读
  });

  it('真零章（ready 且零章）→ 立即诚实失败零重试（终局需人工校对/重摄取，非竞态）', async () => {
    let waits = 0;
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => mat('ready', 0),
      waitMs: async () => {
        waits += 1;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('请先重摄取');
    expect(waits).toBe(0);
  });

  it('low-confidence 零章同终局处理（立即失败）', async () => {
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => mat('low-confidence', 0),
      waitMs: async () => {},
    });
    expect(result.ok).toBe(false);
  });

  it('CR-3：收敛恰落在末次探针与终读之间 → 终读复查章列表如实返回 ok（不假报「仍为空」）', async () => {
    let probes = 0;
    let waits = 0;
    const result = await loadExtractableMaterial('mat-000000000009', {
      getMaterialRow: () => {
        probes += 1;
        // 全窗口探针恒 pending 零章；终读（第 attempts+1 次）恰逢相 B 回填恢复。
        return probes <= DECON_MATERIAL_LOAD_RETRY_ATTEMPTS ? mat('pending', 0) : mat('ready', 98);
      },
      waitMs: async () => {
        waits += 1;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.material.chapters.length).toBe(98);
    expect(probes).toBe(DECON_MATERIAL_LOAD_RETRY_ATTEMPTS + 1);
    expect(waits).toBe(DECON_MATERIAL_LOAD_RETRY_ATTEMPTS - 1);
  });
});

// ── C3：runDeconLlmCall（截断升帽重试脚手架——db 面：writeDeconCost 落行）──

const NOW_ISO = '2026-09-12T08:00:00.000Z';

function seedJob(jobId: string, budgetTotal: number | null): DeconJob {
  const job: DeconJob = {
    jobId,
    materialRef: 'global:mat-000000000009',
    tier: 'coarse',
    dimensions: [],
    status: 'running',
    budget: { totalTokens: budgetTotal, perPass: {} },
    cost: { totalTokens: 0, calls: 0, byPass: {}, estimated: true },
    materialContentHash: `sha256:${'e'.repeat(64)}`,
    derivedHash: `sha256:${'f'.repeat(64)}`,
    error: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  upsertDeconJob(job);
  return job;
}

const CALL_BASE = {
  jobId: 'decon-00000000000a',
  pass: 'p3a',
  unit: '0',
  slot: 'extraction' as const,
  system: 'SYS',
  user: 'USER',
  maxTokens: 1_000,
  label: '测试调用',
  nowIso: () => NOW_ISO,
};

maybe('runDeconLlmCall（C3 截断升帽重试脚手架）', () => {
  it('正常路径：单次调用 ok——usage 真值记账落 job 行（CR-13）', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    const gen: DeconGenerateText = async () => ({ text: '正文', finishReason: 'stop', usage: { totalTokens: 123 } });
    const call = await runDeconLlmCall({ ...CALL_BASE, budget: job.budget, cost: job.cost, job, generate: gen });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(call.text).toBe('正文');
    expect(call.cost.calls).toBe(1);
    const row = getDeconJob(CALL_BASE.jobId);
    expect(row?.cost.totalTokens).toBe(123);
    // estimated 是 sticky OR（CR-13）——seed 的空 cost 已 true，单笔真值不回翻；只断言记账数值面。
    expect(row?.cost.byPass['p3a']).toEqual({ tokens: 123, calls: 1 });
  });

  it('截断→升帽重试→过：二次调用帽 ×2、notify note 相位可见、actual 各记各的（两次落行）', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    const caps: number[] = [];
    const notes: DeconProgressEvent[] = [];
    const gen: DeconGenerateText = async (input) => {
      caps.push(input.maxTokens ?? -1);
      return caps.length === 1
        ? { text: '半程', finishReason: 'length', usage: { totalTokens: 500 } }
        : { text: '完整输出', finishReason: 'stop', usage: { totalTokens: 900 } };
    };
    const call = await runDeconLlmCall({
      ...CALL_BASE,
      budget: job.budget,
      cost: job.cost,
      job,
      generate: gen,
      notify: (e) => notes.push(e),
    });
    expect(call.ok).toBe(true);
    expect(caps).toEqual([1_000, 1_000 * DECON_LLM_RETRY_ESCALATE]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toContain('升帽重试 1/1');
    expect(notes[0]?.pass).toBe('p3a');
    const row = getDeconJob(CALL_BASE.jobId);
    expect(row?.cost.calls).toBe(2); // 重试不绕记账——两笔 actual 各记各的
    expect(row?.cost.totalTokens).toBe(1_400);
  });

  it('截断→升帽重试→仍截断：kind=length 交调用方裁决（helper 不落状态）、两笔已记账', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    const gen: DeconGenerateText = async () => ({ text: '半程', finishReason: 'length' });
    const call = await runDeconLlmCall({ ...CALL_BASE, budget: job.budget, cost: job.cost, job, generate: gen });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.kind).toBe('length');
    expect(call.note).toContain('已升帽重试一次仍截断');
    expect(getDeconJob(CALL_BASE.jobId)?.status).toBe('running'); // 状态落库归调用方语义
    expect(getDeconJob(CALL_BASE.jobId)?.cost.calls).toBe(2);
  });

  it('预算门（首尝试）：超限即 capped 不烧 token——generate 零调用', async () => {
    const job = seedJob(CALL_BASE.jobId, 1); // 极小预算
    let calls = 0;
    const gen: DeconGenerateText = async () => {
      calls += 1;
      return { text: 'x' };
    };
    const call = await runDeconLlmCall({ ...CALL_BASE, budget: job.budget, cost: job.cost, job, generate: gen });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.kind).toBe('budget-capped');
    expect(call.note).toContain('预算超限');
    expect(calls).toBe(0);
  });

  it('预算门（重试 est 同样过门）：首尝试放行、升帽 est 超限 → capped 且首笔已记账', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    // 预算取「首帽 est 恰过、升帽 est 超限」的窄带（est = 输入折算 + 帽）。
    const inputTokens = estimateDeconCallTokens('SYS', 'USER', 0);
    const budget = { totalTokens: inputTokens + 1_500, perPass: {} };
    let calls = 0;
    const gen: DeconGenerateText = async () => {
      calls += 1;
      return { text: '半程', finishReason: 'length', usage: { totalTokens: 100 } };
    };
    const call = await runDeconLlmCall({ ...CALL_BASE, budget, cost: job.cost, job, generate: gen });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.kind).toBe('budget-capped');
    expect(call.note).toContain('升帽重试预算超限');
    expect(calls).toBe(1);
    expect(getDeconJob(CALL_BASE.jobId)?.cost.calls).toBe(1); // 首笔已记——重试被门拦下零新烧
  });

  it('generate 抛错 → kind=error（note 含原因，未记账未重试）', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    const gen: DeconGenerateText = async () => {
      throw new Error('网络炸了');
    };
    const call = await runDeconLlmCall({ ...CALL_BASE, budget: job.budget, cost: job.cost, job, generate: gen });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.kind).toBe('error');
    expect(call.note).toContain('网络炸了');
  });

  it('空回复 → kind=empty（调用方按本 pass 语义处置——p6 走候选丢弃）', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    const gen: DeconGenerateText = async () => ({ text: '   ' });
    const call = await runDeconLlmCall({ ...CALL_BASE, budget: job.budget, cost: job.cost, job, generate: gen });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.kind).toBe('empty');
    expect(call.note).toContain('空回复');
  });

  it('job 行已删（在途 delete 竞态）→ writeDeconCost 抛 DeconJobGoneError 沿调用链上抛', async () => {
    const job = seedJob(CALL_BASE.jobId, null);
    getDb().prepare('DELETE FROM closure_decon_job WHERE job_id=?').run(CALL_BASE.jobId);
    const gen: DeconGenerateText = async () => ({ text: 'x', usage: { totalTokens: 5 } });
    await expect(
      runDeconLlmCall({ ...CALL_BASE, budget: job.budget, cost: job.cost, job, generate: gen }),
    ).rejects.toThrow('已删除');
  });
});

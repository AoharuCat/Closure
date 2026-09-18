import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@orison/shared-contracts';

const { handle, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

// Partial mock of the agent package: the seam functions stay REAL
// (setTaskSlotResolver / setGenerateTextFn / setExecuteToolFn /
// registerBuiltinTools / listSkillPackages ...) so the resolver injection under
// test is exercised end-to-end against the module state the runtime actually
// reads. Only the heavyweight runtime factory is stubbed — its construction is
// irrelevant to the resolver seam.
vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    createWorkflowRuntime: vi.fn(() => ({ __stub: 'agentIpcTaskSlotWiring' })),
  };
});

// agentIpc only forwards tool executions through handleToolExecute — stub it so
// this file never pulls the full toolHandlers graph.
vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));

import { resolveTaskModel, readContextPolicy } from '@orison/desktop-agent';
import { registerAgentIpc } from '../main/ipc/agentIpc';
import { _setModelConfigDirForTest, readTaskModelSlots, readUserPreferencesFromDisk } from '../main/ipc/configIpc';
import { resolveModel } from '../main/ipc/modelGatewayIpc';
import { taskModelSlotSchema } from '@orison/shared-contracts';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-agent-slot-wiring');
const SIDECAR = () => path.join(TEST_MODEL_DIR, 'task-models.yaml');

// ── C3.2 / CR-001: the production wiring line must be pinned ──
//
// agentIpc's `setTaskSlotResolver((slot) => readTaskModelSlots()?.[slot])` had
// zero test coverage — deleting it left every suite green while all six slots
// silently fell back to shell auto-pick (the "wiring missing ≙ user didn't
// configure" unobservable pair, design §7). These assertions read the agent
// package's OWN module state after registerAgentIpc ran, so removing the
// wiring line turns them red.
describe('agentIpc task-slot resolver wiring (C3.2 / CR-001)', () => {
  // Production registers once for the app lifetime (module `registered` guard)
  // — mirror that here: one registration, per-test isolation via the sidecar
  // (the injected closure queries fresh per resolve).
  beforeAll(() => {
    registerAgentIpc(() => null);
  });

  beforeEach(() => {
    handle.mockReset();
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
    warn.mockReset();
    info.mockReset();
    // NOTE: the injected resolver deliberately STAYS installed — it was
    // registered once in beforeAll (mirroring the app-lifetime registration)
    // and each test re-establishes its expectations via the sidecar. Vitest
    // isolates module state per file, so nothing leaks beyond this file.
  });

  it('injects the sidecar-backed resolver: configured slot → ref, unconfigured slot → undefined', () => {
    writeFileSync(
      SIDECAR(),
      ['dialogue.keyId: key_001', 'dialogue.modelId: qwen-max'].join('\n') + '\n',
      'utf8',
    );

    expect(resolveTaskModel('dialogue')).toEqual({ keyId: 'key_001', modelId: 'qwen-max' });
    expect(resolveTaskModel('writer-draft')).toBeUndefined();
    // The injected closure is exactly the per-slot projection of the sidecar.
    expect(resolveTaskModel('dialogue')).toEqual(readTaskModelSlots()?.dialogue);
  });

  it('no sidecar on disk → the injected resolver yields undefined for every slot (auto-pick)', () => {
    // 09-13 R1b：枚举驱动全量迭代（十档含四个审核细档）——细档回落链在无 sidecar
    // 形态下同样落 undefined（回落不凭空造 assignment）。
    for (const slot of taskModelSlotSchema.options) {
      expect(resolveTaskModel(slot)).toBeUndefined();
    }
  });

  // 09-13 R1b：审核族细档回落链——shell 注入闭包是单槽直查（readTaskModelSlots()?.[slot]），
  // 档间回落由 agent 侧 resolveTaskModel 单点实现。只配 review-judge 时四个细档经真实
  // 注入 resolver 落到 review-judge assignment（enrichment 同 ride）。
  it('only review-judge on disk → the four fine review slots fall back to its assignment (09-13 R1b)', () => {
    writeFileSync(
      SIDECAR(),
      ['review-judge.keyId: key_001', 'review-judge.modelId: judge-model'].join('\n') + '\n',
      'utf8',
    );
    for (const fine of ['plan-review', 'multi-review', 'route-judge', 'revision-guard'] as const) {
      expect(resolveTaskModel(fine)).toEqual({ keyId: 'key_001', modelId: 'judge-model' });
    }
    // 非审核族槽位不受回落影响。
    expect(resolveTaskModel('extraction')).toBeUndefined();
  });

  it('a sidecar change becomes visible without re-registration (fresh-query semantics)', () => {
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: m-one\n', 'utf8');
    expect(resolveTaskModel('dialogue')).toEqual({ keyId: 'key_001', modelId: 'm-one' });

    // Different SIZE guarantees the stat gate re-reads even on mtime-granularity
    // collisions between consecutive writes (CR-004 determinism note).
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: m-two-longer\n', 'utf8');
    expect(resolveTaskModel('dialogue')).toEqual({ keyId: 'key_001', modelId: 'm-two-longer' });
  });

  // 08-25 S3：sidecar thinking 策略位——注入闭包返回的是完整 SlotAssignment
  //（含 thinking/thinkingCustom）。agent 侧 resolveTaskModel 是纯透传（S4b 才改
  // 侧类型），策略字段经 seam 完整到达 agent 面；接线测试钉「除 ref 外还携带
  // 策略」，删掉 configIpc 的策略读取即红（mirror CR-001 的接线钉法）。
  it('a sidecar with thinking policy keys → the injected resolver returns the full SlotAssignment (08-25)', () => {
    writeFileSync(
      SIDECAR(),
      [
        'dialogue.keyId: key_001',
        'dialogue.modelId: qwen-max',
        'dialogue.thinking: high',
        'writer-draft.keyId: key_001',
        'writer-draft.modelId: glm-5.3',
        'writer-draft.thinkingCustom: 8192',
        'review-judge.keyId: key_001',
        'review-judge.modelId: deepseek-v4-pro',
      ].join('\n') + '\n',
      'utf8',
    );

    expect(resolveTaskModel('dialogue')).toEqual({
      keyId: 'key_001',
      modelId: 'qwen-max',
      thinking: 'high',
    });
    expect(resolveTaskModel('writer-draft')).toEqual({
      keyId: 'key_001',
      modelId: 'glm-5.3',
      thinkingCustom: '8192',
    });
    // Ref-only entries carry NO policy keys (auto semantics preserved verbatim).
    expect(resolveTaskModel('review-judge')).toEqual({ keyId: 'key_001', modelId: 'deepseek-v4-pro' });
    expect('thinking' in (resolveTaskModel('review-judge') ?? {})).toBe(false);
  });

  it('AC4 / CR-012: a slot pointing at a DISABLED model passes through unchanged, and resolveModel throws visibly', () => {
    // The sidecar designates dialogue → a model that exists but is disabled in
    // its key. The agent seam must hand that ref to generate EXACTLY as-is
    // (transparency, no silent rerouting) — the visible failure lands where the
    // key knowledge lives: shell resolveModel's disabled-model throw.
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: gpt-4o\n', 'utf8');

    const ref = resolveTaskModel('dialogue');
    expect(ref).toEqual({ keyId: 'key_001', modelId: 'gpt-4o' });

    const configWithDisabled: ModelConfig = {
      keys: [
        {
          id: 'key_001',
          name: 'Relay',
          protocol: 'openai-compatible',
          apiKey: 'sk-test',
          baseUrl: 'https://relay.example.com/v1',
          models: [{ id: 'gpt-4o', alias: 'GPT 4o', capability: 'text', enabled: false }],
        },
      ],
    };
    expect(() => resolveModel(ref!, configWithDisabled)).toThrow(/disabled/);
  });

  // ── 09-12 子3 §4.4：resolver 闭包的 contextWindow enrichment 接线钉（mirror CR-001
  // 姿态——删掉闭包上的 enrichSlotAssignment 调用即红）。enrichment 是 runtime-only：
  // 读侧（readTaskModelSlots / load-model 盘上原样）零污染，sidecar 永不落盘此字段。──
  it('key defaults.contextWindow → 注入闭包返回 contextWindowTokens；读侧与盘面零污染', () => {
    mkdirSync(path.join(TEST_MODEL_DIR, 'keys'), { recursive: true });
    writeFileSync(
      path.join(TEST_MODEL_DIR, 'keys', 'key_001.yaml'),
      [
        'id: key_001',
        'name: Enrich relay',
        'protocol: openai-compatible',
        'baseUrl: https://relay.example.com/v1',
        'apiKey: sk-test',
        'models.0.id: m-window',
        'models.0.capability: text',
        'models.0.alias: m-window',
        'models.0.enabled: true',
        'models.0.defaults.contextWindow: 131072',
        'models.1.id: m-plain',
        'models.1.capability: text',
        'models.1.alias: m-plain',
        'models.1.enabled: true',
      ].join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      SIDECAR(),
      'dialogue.keyId: key_001\ndialogue.modelId: m-window\nwriter-draft.keyId: key_001\nwriter-draft.modelId: m-plain\n',
      'utf8',
    );

    // enriched：key 的 defaults.contextWindow 注入 assignment（AC3 接线面）。
    expect(resolveTaskModel('dialogue')).toEqual({
      keyId: 'key_001',
      modelId: 'm-window',
      contextWindowTokens: 131_072,
    });
    // 无 defaults 的模型恒等（无 contextWindowTokens 键）。
    expect(resolveTaskModel('writer-draft')).toEqual({ keyId: 'key_001', modelId: 'm-plain' });
    expect('contextWindowTokens' in (resolveTaskModel('writer-draft') ?? {})).toBe(false);
    // 读侧零污染：readTaskModelSlots 盘上原样（UI load-model 同源不受 enrichment 影响）。
    expect(readTaskModelSlots()?.dialogue).toEqual({ keyId: 'key_001', modelId: 'm-window' });
    expect(readFileSync(SIDECAR(), 'utf-8')).not.toContain('contextWindowTokens');
  });
});

// ── 08-25 S4b：context-policy 注入线钉死（mirror CR-001 姿态）──
//
// agentIpc 的 `setContextPolicyProvider(() => readUserPreferencesFromDisk()
// .contextCompaction)` 同样是「删了接线全绿」的静默面——agent 侧 readContextPolicy
// 未注入恒 undefined → leader 车道红线回落缺省 95，与「用户设了 60」不可区分。
// 断言两侧同源相等：注入线在位时 readContextPolicy() 与 preferences 现读闭包的
// 返回逐字段相等（contextCompaction 经 configIpc 读路径恒有值——缺省 95 兜底）；
// 删线后左 undefined 右有值 → 红。不写真实 home 目录的 preferences.yaml。
describe('agentIpc context-policy provider wiring (08-25 S4b)', () => {
  beforeAll(() => {
    // registerAgentIpc 的 registered 守卫是模块级的——上一 describe 已注册过，
    // setContextPolicyProvider 已随之注入；这里直接读 agent 包自身模块态断言。
  });

  it('readContextPolicy() equals the fresh preferences projection (redline always present via read-path default)', () => {
    const policy = readContextPolicy();
    const expected = readUserPreferencesFromDisk().contextCompaction;
    expect(policy).toEqual(expected);
    expect(policy?.redlinePercent).toBeGreaterThanOrEqual(50);
    expect(policy?.redlinePercent).toBeLessThanOrEqual(100);
  });
});

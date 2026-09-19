import { describe, expect, it } from 'vitest';
import type { GenerationMessage, ResolvedModel, TextGenerationRequest } from '@orison/shared-contracts';
import {
  __getAntigravityCliTextAgentResolverForTest,
  createAntigravityCliDriver,
  setAntigravityCliTextAgentResolver,
  type AntigravityCliDriver,
} from '../src/antigravityCli/driver';
import type { FakeAgyProcess, FakePoolEnv } from './antigravityCliFakes';
import { fakePoolEnv } from './antigravityCliFakes';

// ── 09-19 CLI 白名单 W3：零工具 agent 解析器缝 + 行为级降级带（driver 侧）──
//
// 判据（prd R3 / AC3）：挂 agent 的 spawn 出现工具 step → 作废 + 无 agent spec 重跑恰
// 一次 + warn；降级记账后同会话恒走无 agent spec（不循环）；resolver undefined（无 agent
// 正常态）不触发降级带。零真进程（fakePoolEnv 既有范式）。
//
// ⚠️ 归因纠正（2026-09-19 F12 真机实证）：工具 step **不是** agent 未加载的证据——挂
// agent 加载成功（agent=true / system prompt 整体替换）时内置工具仍可调用（收窄未清零）；
// warn 文案已去掉「did not load」断言，签名标记见下 DEGRADED_WARN_MARKER。
// 证据：research/f8-builtin-tool-stream-signal.md §4/§5。

/** 降级带 warn 的签名标记（与 shell agentIpc 拦截共用同一子串语义）。 */
const DEGRADED_WARN_MARKER = 'built-in tool step';

function cliModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    keyId: 'agy-key',
    modelId: 'gemini-3.8-pro-high',
    protocol: 'antigravity-cli',
    baseUrl: '',
    apiKey: '',
    capability: 'text',
    cliExecutable: 'C:\\agy\\bin\\agy.exe',
    ...overrides,
  };
}

function request(messages: GenerationMessage[], overrides: Partial<TextGenerationRequest> = {}): TextGenerationRequest {
  return {
    model: 'gemini-3.8-pro-high',
    messages,
    ...overrides,
  };
}

/** 工具 step + 成功收尾的事件流（降级带触发形态）。 */
function scriptToolStepTurn(proc: FakeAgyProcess, response: string): void {
  proc.emitEvent({ type: 'step_update', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search' } });
  proc.emitEvent({ type: 'result', status: 'SUCCESS', response });
}

describe('零工具 agent 解析器缝（W3）', () => {
  it('resolver 返回激活值 → spawn args 带 --agent <值>；undefined → 现状无 agent', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver: AntigravityCliDriver = createAntigravityCliDriver(env.deps, undefined, {
      resolveTextAgent: () => 'closure-text',
    });
    await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    const args = env.spawns[0]!.spawnArgs.args;
    expect(args).toContain('--agent');
    expect(args[args.indexOf('--agent') + 1]).toBe('closure-text');
    driver.dispose();

    const env2 = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver2 = createAntigravityCliDriver(env2.deps, undefined, { resolveTextAgent: () => undefined });
    await driver2.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(env2.spawns[0]!.spawnArgs.args).not.toContain('--agent');
    driver2.dispose();
  });

  it('每 turn 现咨询 resolver（池复用进程也重问——决策即时反映）', async () => {
    let consulted = 0;
    const env = fakePoolEnv((proc) => {
      proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, {
      resolveTextAgent: () => {
        consulted += 1;
        return 'closure-text';
      },
    });
    const msgs: GenerationMessage[] = [{ role: 'user', content: '第一问' }];
    await driver.generateText(cliModel(), request(msgs, { sessionKey: 'chain:r' }));
    await driver.generateText(cliModel(), request([...msgs, { role: 'assistant', content: 'ok' }, { role: 'user', content: '第二问' }], { sessionKey: 'chain:r' }));
    expect(consulted).toBe(2);
    expect(env.spawns).toHaveLength(1); // 同进程增量（spec 面不变）
    driver.dispose();
  });
});

describe('行为级降级带（W3/R3——AC3）', () => {
  it('agent 挂载 spawn 出现工具 step → 恰一次无 agent 重跑（冷重启换 spec）+ warn + 降级记账', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const withAgent = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (withAgent) scriptToolStepTurn(proc, 'agent 车道正文');
        else proc.scriptSuccessTurn('降级车道正文', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => 'closure-text' });
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 'chain:w1' });
    const r = await driver.generateText(cliModel(), req);
    expect(r.text).toBe('降级车道正文');
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[0]!.stdinEnded).toBe(true); // 旧 agent 进程走优雅关停（冷重启语义）
    expect(env.spawns[1]!.spawnArgs.args).not.toContain('--agent');
    // 行为级判据：重跑后的正文来自无 agent 进程（冷启动全量）。
    expect((JSON.parse(env.spawns[1]!.writtenLines[0]!) as { message: { content: string } }).message.content).toContain('x');
    expect(env.warns.some((w) => w.includes(DEGRADED_WARN_MARKER))).toBe(true);
    expect(env.warns.some((w) => w.includes('retrying this turn without --agent'))).toBe(true);
    driver.dispose();
  });

  it('降级记账后同会话恒走无 agent spec——不再咨询 resolver、不再触发降级（AC3 不循环）', async () => {
    let spawnCount = 0;
    let consulted = 0;
    const env = fakePoolEnv((proc) => {
      const first = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (first) scriptToolStepTurn(proc, 'agent 车道正文');
        else proc.scriptSuccessTurn('降级车道正文', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, {
      resolveTextAgent: () => {
        consulted += 1;
        return 'closure-text';
      },
    });
    const req = request([{ role: 'user', content: 'x' }], { sessionKey: 'chain:w1' });
    await driver.generateText(cliModel(), req);
    expect(consulted).toBe(1); // 重跑 spec 无 agent——不再问 resolver

    const warnsBefore = env.warns.length;
    const r2 = await driver.generateText(cliModel(), request(
      [{ role: 'user', content: 'x' }, { role: 'assistant', content: '降级车道正文' }, { role: 'user', content: 'y' }],
      { sessionKey: 'chain:w1' },
    ));
    expect(r2.text).toBe('降级车道正文');
    expect(consulted).toBe(1); // 降级键短路——resolver 零咨询
    expect(env.spawns).toHaveLength(2); // 复用降级进程（零新 spawn）
    expect(env.warns.slice(warnsBefore).filter((w) => w.includes(DEGRADED_WARN_MARKER))).toHaveLength(0);
    driver.dispose();
  });

  it('oneshot 车道同过此缝：恰一次降级；无会话身份——下轮重新咨询 resolver', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const odd = spawnCount % 2 === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (odd) scriptToolStepTurn(proc, 'agent 车道正文');
        else proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => 'closure-text' });
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
    expect(r.text).toBe('ok');
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[1]!.spawnArgs.args).not.toContain('--agent');

    // oneshot 每轮新会话身份：第二调用重新咨询（resolver 仍返回名字 → 再挂 agent →
    // 再降级一次——每轮成本独立，无跨轮记账）。
    const r2 = await driver.generateText(cliModel(), request([{ role: 'user', content: 'y' }]));
    expect(r2.text).toBe('ok');
    expect(env.spawns).toHaveLength(4);
    expect(env.spawns[2]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[3]!.spawnArgs.args).not.toContain('--agent');
    driver.dispose();
  });

  it('resolver undefined（无 agent 正常态）出现工具 step → 不触发降级带（单 spawn）', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptToolStepTurn(proc, 'ok');
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => undefined });
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }], { sessionKey: 's1' }));
    expect(r.text).toBe('ok');
    expect(env.spawns).toHaveLength(1);
    expect(env.warns.some((w) => w.includes(DEGRADED_WARN_MARKER))).toBe(false);
    driver.dispose();
  });

  it('无 resolver（缺省，现状路径）出现工具 step → 不触发降级带', async () => {
    const env = fakePoolEnv((proc) => {
      proc.responder = () => scriptToolStepTurn(proc, 'ok');
    });
    const driver = createAntigravityCliDriver(env.deps);
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }], { sessionKey: 's1' }));
    expect(r.text).toBe('ok');
    expect(env.spawns).toHaveLength(1);
    expect(env.warns.some((w) => w.includes(DEGRADED_WARN_MARKER))).toBe(false);
    driver.dispose();
  });

  it('空 SUCCESS 重试与降级带组合：重试仍带 agent；重试代次再现工具 step → 降级恰一次（CR-4 证据按进程代次）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const index = spawnCount;
      spawnCount += 1;
      proc.responder = () => {
        if (index === 0) {
          scriptToolStepTurn(proc, ''); // 工具 step + 空 SUCCESS → 空重试（同 spec 冷重启）
        } else if (index === 1) {
          // 冷重启进程（带 agent）：空重试出正文但本代次再现工具 step → 降级带按当前
          // 代次证据触发（CR-4：旧代次证据已随进程重生作废，不残留叠加）。
          scriptToolStepTurn(proc, '重试正文');
        } else {
          proc.scriptSuccessTurn('降级正文', { input: 1, output: 1 });
        }
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => 'closure-text' });
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }], { sessionKey: 'chain:e1' }));
    expect(r.text).toBe('降级正文');
    // spawn 序：agent(工具step+空) → agent 冷重启(重试代次工具 step) → 无 agent(降级重跑)。
    expect(env.spawns).toHaveLength(3);
    expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[1]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[2]!.spawnArgs.args).not.toContain('--agent');
    driver.dispose();
  });

  it('CR-4①：空 SUCCESS 干净重试成功 → 工具 step 证据随进程重生重置，不触发第三次降级重跑', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const first = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (first) {
          scriptToolStepTurn(proc, ''); // 工具 step + 空 SUCCESS → 空重试（同 spec 冷重启）
        } else {
          proc.scriptSuccessTurn('干净重试正文', { input: 1, output: 1 }); // 冷重启进程（带 agent，零工具 step）
        }
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => 'closure-text' });
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }], { sessionKey: 'chain:c4a' }));
    expect(r.text).toBe('干净重试正文');
    // spawn 序恰二：agent 进程（工具 step + 空）→ 同 spec 冷重启进程（干净成功）。
    // 重试进程的干净证据作废首轮旧证据 → 无第三次无 agent 降级重跑、无降级带警告。
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
    expect(env.spawns[1]!.spawnArgs.args).toContain('--agent');
    expect(env.warns.some((w) => w.includes(DEGRADED_WARN_MARKER))).toBe(false);
    driver.dispose();
  });

  it('CR-4②：降级重跑失败 → 保首试成功结果 + warn（不整 turn 拒绝）', async () => {
    let spawnCount = 0;
    const env = fakePoolEnv((proc) => {
      const first = spawnCount === 0;
      spawnCount += 1;
      proc.responder = () => {
        if (first) scriptToolStepTurn(proc, '首试正文'); // 工具 step + 成功 → 降级带触发
        else proc.scriptErrorTurn('ERROR', 'quota exceeded for today'); // 无 agent 重跑失败
      };
    });
    const driver = createAntigravityCliDriver(env.deps, undefined, { resolveTextAgent: () => 'closure-text' });
    const r = await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }], { sessionKey: 'chain:c4b' }));
    expect(r.text).toBe('首试正文');
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[1]!.spawnArgs.args).not.toContain('--agent');
    expect(env.warns.some((w) => w.includes(DEGRADED_WARN_MARKER))).toBe(true);
    expect(env.warns.some((w) => w.includes('keeping the first-pass result'))).toBe(true);
    driver.dispose();
  });
});

describe('模块级 resolver override（shell 生产注入缝）', () => {
  it('setAntigravityCliTextAgentResolver → 裸工厂驱动器（生产单例同路径）每 turn 消费；复位生效', async () => {
    const previous = __getAntigravityCliTextAgentResolverForTest();
    try {
      setAntigravityCliTextAgentResolver(() => 'closure-text');
      expect(__getAntigravityCliTextAgentResolverForTest()).toBeDefined();
      const env = fakePoolEnv((proc) => {
        proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
      });
      const driver = createAntigravityCliDriver(env.deps); // 无 driverOpts——消费模块级 override
      await driver.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
      expect(env.spawns[0]!.spawnArgs.args).toContain('--agent');
      driver.dispose();

      setAntigravityCliTextAgentResolver(undefined);
      expect(__getAntigravityCliTextAgentResolverForTest()).toBeUndefined();
      const env2 = fakePoolEnv((proc) => {
        proc.responder = () => proc.scriptSuccessTurn('ok', { input: 1, output: 1 });
      });
      const driver2 = createAntigravityCliDriver(env2.deps);
      await driver2.generateText(cliModel(), request([{ role: 'user', content: 'x' }]));
      expect(env2.spawns[0]!.spawnArgs.args).not.toContain('--agent');
      driver2.dispose();
    } finally {
      setAntigravityCliTextAgentResolver(previous);
    }
  });
});

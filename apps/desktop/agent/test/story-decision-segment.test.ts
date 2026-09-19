import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.6 R2/⑥：loadOpenDecisionsForLeader + buildSessionStateSnapshot
//（system 稳定化 09-12 + CR-D1 拆分 09-13：静态登记能力段回 system 恒定区，
// 注记 = 纯动态状态快照，以 user-role 状态注记消息追加在消息尾）
// 创作决策登记引导段（system）+ open 决策三态注入（注记）测试。
//
// 1. has open（decided/superseded/dropped 排除 + newestFirst top-3 + 截断标注）→ 快照注入提醒。
// 2. no open（全 decided / 无 story_decisions）→ 零噪音（快照不注入提醒段）。
// 3. degraded（project.yaml 不可读 / story_decisions 非数组）→ 「暂不可用」。
// 4. per-element safeParse：一条坏决策（缺 risk）不清空整个数组（mirror CR-4.1-07）。
//
// 测试方法 mirror setting-assistant-segment.test.ts：非 exported 函数经 sendMessage end-to-end 验
//（generate mock 2 参回调：1 参 messages 捕获 kind='session_state_note' 状态注记断动态快照文本；
// 2 参 system 取 capabilityOnly 隔离段断静态登记能力段文本）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CR-D1 拆分后静态能力段 = system 尾 `---` 块（buildMainRunConfig 拼）——剥 DEFAULT_CLOSURE_PROMPT /
 * path 行 / skills 与 runLoop 追加的工具描述，能力段断言打在此隔离段。
 */
function capabilityOnly(system: string): string {
  return system.split('# Available Tools')[0].split('\n\n---\n').pop() ?? '';
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1',
    summary: '女主真背叛主角团',
    reason: '妹妹被挟持',
    risk: '铺垫不足读者弃书',
    status: 'open',
    source: 'user',
    createdAt: '2026-08-01T10:00:00Z',
    ...overrides,
  };
}

describe('Story 2.6 — 创作决策登记引导段 + open 三态注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-story-decision-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeProjectYaml(doc: Record<string, unknown>): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  /** runLoop generate 捕获投影：1 参 messages（取注记）+ 2 参 system（取能力段隔离段）。 */
  type TurnMessage = { kind?: string; content: string };

  async function runTurn(expectTurn: (system: string, note: TurnMessage | undefined) => void): Promise<void> {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (messages: TurnMessage[], system: string) => {
      expectTurn(system, messages.find((m) => m.kind === 'session_state_note'));
      return { content: 'ok', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Note the open decision.',
      abortSignal: new AbortController().signal,
    });
    expect(generate).toHaveBeenCalledOnce();
  }

  // ── 登记引导段（system 恒定区常驻）──

  it('引导段常驻注入（system 恒定区）：登记时机 + 三语义 + user-source 保护 + 档位映射', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((system) => {
      const seg = capabilityOnly(system);
      expect(seg).toContain('创作决策登记能力（StoryDecision ADR）');
      expect(seg).toContain('story_decisions_update');
      expect(seg).toContain('open→decided');
      expect(seg).toContain('supersede');
      expect(seg).toContain('受保护');
      expect(seg).toContain('不双登记'); // ⑦ 边界：设定卡/承诺不重复登记
    });
  });

  // ── open 三态注入 ──

  it('has open：注入提醒（open 才进，decided/superseded 排除）', async () => {
    writeProjectYaml({
      name: 'Test',
      novel: {
        chapters: [],
        story_decisions: [
          decision({ id: 'open-1', summary: '女主背叛线待拍板' }),
          decision({ id: 'decided-1', status: 'decided' }),
          decision({ id: 'superseded-1', status: 'superseded', supersededBy: 'decided-1' }),
        ],
      },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('未决创作决策');
      expect(note?.content).toContain('[open-1]');
      expect(note?.content).toContain('女主背叛线待拍板');
      expect(note?.content).toContain('风险：铺垫不足读者弃书');
      expect(note?.content).not.toContain('[decided-1]');
      expect(note?.content).not.toContain('[superseded-1]');
    });
  });

  it('no open（全 decided）→ 零噪音（快照不注入提醒段）', async () => {
    writeProjectYaml({
      name: 'Test',
      novel: {
        chapters: [],
        story_decisions: [decision({ id: 'd1', status: 'decided' })],
      },
    });
    await runTurn((_system, note) => {
      expect(note).toBeDefined(); // 注记在轮（防 not.toContain 空过）
      expect(note?.content).not.toContain('未决创作决策');
    });
  });

  it('no story_decisions（合法空）→ 零噪音', async () => {
    writeProjectYaml({ name: 'Test', novel: { chapters: [] } });
    await runTurn((_system, note) => {
      expect(note).toBeDefined(); // 注记在轮（防 not.toContain 空过）
      expect(note?.content).not.toContain('未决创作决策');
    });
  });

  it('novel section 缺（fresh project，CR-B03）→ 合法空零噪音（非假 degraded）', async () => {
    // createEmptyProjectDocument 不产 novel 键——缺 ≠ 坏，若判 degraded 每个 fresh 项目每 turn
    // 都出假「检查暂不可用」行。（断言锚定决策段专属文案「未决创作决策……检查暂不可用」——
    // 泛「检查暂不可用」会命中 2.2 设定覆盖段 fresh project 的既有降级行，非本段 concern。）
    writeProjectYaml({ name: 'Test' });
    await runTurn((_system, note) => {
      expect(note).toBeDefined(); // 注记在轮（防 not.toContain 空过）
      expect(note?.content).not.toContain('未决创作决策');
      expect(note?.content).not.toContain('未决创作决策（novel.story_decisions open）：检查暂不可用');
    });
  });

  it('episode-scoped open 决策进 leader 提醒（CR-E03：全量视角无 episode 过滤）', async () => {
    // leader 自己可登记带 relatedEpisodeId 的 open 决策（draft schema 允许）——作者解决的是所有
    // open 非仅本章相关，episode-scoped 不进提醒 = 该决策两通道（leader + brief #8）都不提。
    writeProjectYaml({
      name: 'Test',
      novel: {
        chapters: [],
        story_decisions: [
          decision({ id: 'scoped-1', summary: '第 7 章魔法规则待定', relatedEpisodeId: 'ep7' }),
          decision({ id: 'global-1', summary: '全局悬念待拍板' }),
        ],
      },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('[scoped-1]');
      expect(note?.content).toContain('第 7 章魔法规则待定');
      expect(note?.content).toContain('[global-1]');
    });
  });

  it('degraded（story_decisions 非数组）→ 「暂不可用」', async () => {
    writeProjectYaml({ name: 'Test', novel: { chapters: [], story_decisions: 'oops' } });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('检查暂不可用');
    });
  });

  it('per-element safeParse：一条坏决策（缺 risk）不清空整个数组（CR-4.1-07）', async () => {
    writeProjectYaml({
      name: 'Test',
      novel: {
        chapters: [],
        story_decisions: [
          { id: 'bad', summary: '缺 risk 的坏条目', reason: 'r', status: 'open', createdAt: '2026-08-01T00:00:00Z' },
          decision({ id: 'good-1', summary: '好决策' }),
        ],
      },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('[good-1]');
      expect(note?.content).not.toContain('[bad]');
    });
  });

  it('newestFirst + 截断标注：4 条 open 只列前 3 + 「前 3 / 共 4」', async () => {
    writeProjectYaml({
      name: 'Test',
      novel: {
        chapters: [],
        story_decisions: [
          decision({ id: 'old', createdAt: '2026-08-01T00:00:00Z' }),
          decision({ id: 'd2', createdAt: '2026-08-02T00:00:00Z' }),
          decision({ id: 'd3', createdAt: '2026-08-03T00:00:00Z' }),
          decision({ id: 'newest', createdAt: '2026-08-04T00:00:00Z' }),
        ],
      },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('前 3 条 / 共 4 条');
      expect(note?.content).toContain('[newest]');
      expect(note?.content).toContain('[d3]');
      expect(note?.content).not.toContain('[old]');
    });
  });
});

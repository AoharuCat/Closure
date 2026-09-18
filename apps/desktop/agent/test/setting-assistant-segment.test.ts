import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.2 WP-A/WP-C：loadSettingCoverageForLeader + buildSessionStateSnapshot
//（system 稳定化 09-12 + CR-D1 拆分 09-13：静态深化段回 system 恒定区，
// 注记 = 纯动态状态快照，以 user-role 状态注记消息追加在消息尾）
// 设定深化引导段（system）+ coverage 三态段（注记）注入测试。
//
// 深化段（九条协议文案 system 恒定区常驻）+ coverage 三态（mirror 结构健康度/stale 三态模式）：
// 1. has gaps（dangling_ref warning / scene_no_refs info / 截断 top-5+总数）→ 快照注入缺口消息。
// 2. no gaps（全 refs 命中）→ 「已检查过，无已知设定覆盖缺口」。
// 3. degraded（project.yaml 不可读 / scene_graph 缺 / asset_cards 形态坏）→ 「暂不可用」。
//
// 测试方法：loadSettingCoverageForLeader / buildSessionStateSnapshot 非 exported → 经 sendMessage
// end-to-end 验（generate mock 2 参回调：1 参 messages 捕获 kind='session_state_note' 状态注记
// 断动态快照文本；2 参 system 取 capabilityOnly 隔离段断静态深化段文本。mirror stale-fields-segment
// .test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CR-D1 拆分后静态能力段 = system 尾 `---` 块（buildMainRunConfig 拼）——剥 DEFAULT_ORISON_PROMPT /
 * path 行 / skills 与 runLoop 追加的工具描述，能力段断言打在此隔离段。
 */
function capabilityOnly(system: string): string {
  return system.split('# Available Tools')[0].split('\n\n---\n').pop() ?? '';
}

/** 合法 character 卡（过 assetCardsSchema discriminatedUnion）。 */
const CHAR_CARD = {
  id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
  narrative: { storyFunction: '主角' },
  desireAndBottomline: { coreDesire: '变强' },
  personality: { coreTraits: ['坚韧'] },
};

describe('Story 2.2 — 设定深化引导段 + coverage 三态段注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-setting-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** Write a project.yaml fixture（JSON——js-yaml 是 JSON 超集）。 */
  function writeProjectYaml(doc: Record<string, unknown>): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  /** scene node fixture（assetRefs 可选）。 */
  function scene(id: string, assetRefs?: string[]): Record<string, unknown> {
    return {
      id,
      episodeId: 'ep1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      ...(assetRefs ? { assetRefs } : {}),
    };
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
      content: 'Deepen setting.',
      abortSignal: new AbortController().signal,
    });
    expect(generate).toHaveBeenCalledOnce();
  }

  // ── WP-A 深化引导段（system 恒定区常驻，九条协议文案）──

  it('深化引导段常驻注入（system 恒定区）：何时深化 + craft 域路由 + 用途锚 + 三层权威 + 落盘路由 + 档位 + gate 补救 + craft 反哺', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1'])], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      const seg = capabilityOnly(system);
      // 段头（何时深化三触发：作者要深化 / gate needs_world_anchor / coverage 段报缺口）。
      expect(seg).toContain('设定深化能力（设定助手）');
      expect(seg).toContain('needs_world_anchor');
      // craft 域路由表（CRAFT_TYPE_VOCAB 8 类 slug）+ 查空降级明示。
      expect(seg).toContain('query_craft');
      expect(seg).toContain("'jinzhishao'");
      expect(seg).toContain("'playbook'");
      expect(seg).toContain('无此域参考');
      // 用途锚（宁缺毋滥）。
      expect(seg).toContain('用途锚');
      expect(seg).toContain('不提议');
      // 三层权威内联标注。
      expect(seg).toContain('【你已定】');
      expect(seg).toContain('【craft 参考】');
      expect(seg).toContain('【LLM 建议】');
      // 落盘路由三工具 + locked 告知。
      expect(seg).toContain('asset_cards_update');
      expect(seg).toContain('genre_contract_update');
      expect(seg).toContain('setting_md_update');
      expect(seg).toContain('已锁');
      // 档位映射（autoApply / PatchReview / 只文字）。
      expect(seg).toContain('autoApply=true');
      expect(seg).toContain('PatchReview');
      // gate 补救路由（优先序 + 重跑）。
      expect(seg).toContain('题材承诺+主角卡');
      expect(seg).toContain('重跑 write_chapter');
      // craft 反哺。
      expect(seg).toContain('save_craft_doc');
      // 收尾契约。
      expect(seg).toContain('present_result');
    });
  });

  // ── WP-C coverage 三态段 ──

  it('has gaps（dangling_ref warning）：scene 引用不存在的卡 → 注入缺口消息 + 引导补卡', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1', 'card-missing'])], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('设定覆盖');
      expect(note?.content).toContain('「card-missing」不存在');
      expect(note?.content).toContain('[warning]');
      // 引导接深化段流程 + 修正引用路由。
      expect(note?.content).toContain('asset_cards_update');
    });
  });

  it('has gaps（scene_no_refs info）：场无 assetRefs → 注入 info 弱结构信号', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1')], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('[info]');
      expect(note?.content).toContain('还没有标注涉及');
      // info 不算设定债——修 scene_graph_update。
      expect(note?.content).toContain('scene_graph_update');
    });
  });

  it('截断 top-5 + 总数标注（7 条 dangling → 前 5 / 共 7）', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: {
        nodes: [scene('s1', ['missing-1', 'missing-2', 'missing-3', 'missing-4', 'missing-5', 'missing-6', 'missing-7'])],
        edges: [],
        lines: [],
      },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('此处列前 5 条 / 共 7 条');
      expect(note?.content).toContain('「missing-1」不存在');
      // 第 6/7 条不入 top-5（防 prompt 撑大）。
      expect(note?.content).not.toContain('「missing-6」');
      expect(note?.content).not.toContain('「missing-7」');
    });
  });

  it('no gaps（全 refs 命中）→「已检查过，无已知设定覆盖缺口」graceful 提示', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1'])], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('已检查过，无已知设定覆盖缺口');
      expect(note?.content).not.toContain('设定覆盖检查暂不可用');
    });
  });

  it('asset_cards 缺省（合法空项目）+ scene refs → 机械真相全 dangling（非降级）', async () => {
    // 无 asset_cards 键 = 合法空（无卡项目）——refs 无处可解析，dangling 是机械真相非误报。
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['ghost-card'])], edges: [], lines: [] },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('「ghost-card」不存在');
      expect(note?.content).not.toContain('设定覆盖检查暂不可用');
    });
  });

  it('degraded（project.yaml 不可读）→「设定覆盖检查暂不可用」声明', async () => {
    // 不写 project.yaml → readFile 失败 → loadSettingCoverageForLeader 返 null → undefined 分支。
    await runTurn((_system, note) => {
      expect(note?.content).toContain('设定覆盖检查暂不可用');
      expect(note?.content).toContain('本轮不提供设定缺口信息');
    });
  });

  it('degraded（scene_graph 缺）→「设定覆盖检查暂不可用」（mirror 结构健康度缺 scene_graph 三态）', async () => {
    writeProjectYaml({ name: 'Test', asset_cards: [CHAR_CARD] });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('设定覆盖检查暂不可用');
    });
  });

  it('degraded（asset_cards 形态坏：非数组）→「设定覆盖检查暂不可用」（不可信数据不判，防误报）', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1'])], edges: [], lines: [] },
      asset_cards: { not: 'an array' },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('设定覆盖检查暂不可用');
      // 不产 dangling 误报（「有卡却全报悬空」防线）。
      expect(note?.content).not.toContain('「char-1」不存在');
    });
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 Step 7：loadArcCoverageForLeader + buildSessionStateSnapshot
//（system 稳定化 09-12 + CR-D1 拆分 09-13：静态能力段回 system 恒定区，
// 注记 = 纯动态状态快照，以 user-role 状态注记消息追加在消息尾）
// 角色弧设计能力引导段（system）+ 弧覆盖三态段（注记）注入测试（mirror setting-assistant-segment.test.ts）。
//
// 能力段（system 恒定区常驻：主动提议 + timing 双态行 + 三角 + 转折点 + 权威标注 + 工具路由 + 克制——AC7）
// + 覆盖三态（mirror 设定覆盖三态模式）：
// 1. has gaps（零曲线+有角色卡 / 集纲 progression 悬空 / 截断 top5+总数）→ 快照注入缺口。
// 2. no gaps（有弧全落 / 零弧无卡）→ 「已检查过」graceful。
// 3. degraded（project.yaml 不可读 / episode_outlines 或 asset_cards 形态坏）→ 「暂不可用」。
//
// 测试方法：loadArcCoverageForLeader / buildSessionStateSnapshot 非 exported → 经 sendMessage
// end-to-end 验（generate mock 2 参回调：1 参 messages 捕获 kind='session_state_note' 状态注记
// 断 <session_state readonly="true"> 包裹内的动态快照文本；2 参 system 取 capabilityOnly 隔离段
// 断静态能力段文本。mirror setting-assistant-segment.test.ts）。
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
  id: 'char-1', type: 'character', name: '林昭', tier: 'core', summary: '落魄贵女',
  narrative: { storyFunction: '主角' },
  desireAndBottomline: { coreDesire: '夺回家产' },
  personality: { coreTraits: ['隐忍'] },
};

/** 合法 growth_curve 条目（readGrowthCurves 归一单源接受的最小形态）。 */
function curve(characterId: string): Record<string, unknown> {
  return { character_id: characterId, start_state: '隐忍求生', turning_points: [] };
}

/** 合法集纲条目（过 episodeOutlinesSchema；characterIds → character_progressions from→to）。 */
function episode(id: string, index: number, characterIds: string[]): Record<string, unknown> {
  return {
    id,
    index,
    title: `集-${id}`,
    character_progressions: characterIds.map((cid) => ({ characterId: cid, from: 'A', to: 'B' })),
  };
}

describe('Story 8.5 — 角色弧设计引导段 + 弧覆盖三态段注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-arc-segment-'));
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
      content: 'Design arc.',
      abortSignal: new AbortController().signal,
    });
    expect(generate).toHaveBeenCalledOnce();
  }

  // ── 能力段（system 恒定区常驻，AC7：主动提议指令 + timing 双态行 + 婉拒克制指令）──

  it('弧设计能力段常驻注入（system 恒定区）：主动提议 + timing 双态行 + 三角 + 转折点 + 终点反推 + 权威 + 工具路由 + 克制', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((system) => {
      const seg = capabilityOnly(system);
      // 段头 + 成长弧就地解释（角色由内而外的变化主线 + 多弧交织是常态）。
      expect(seg).toContain('角色弧设计能力');
      expect(seg).toContain('由内而外的变化主线');
      expect(seg).toContain('彼此交织是常态');
      // 主动提议 posture（不待问——作者可以不知道这个功能存在）。
      expect(seg).toContain('主动开口提议');
      expect(seg).toContain('主动找上他');
      // timing 双态行（CR-D1 拆分拍板 B：写前列 / 边写边列两分支并列，不随偏好裁剪）。
      expect(seg).toContain('提议时机按作者选的节奏对号');
      expect(seg).toContain('要不要设计她从什么状态走到什么状态');
      expect(seg).toContain('大纲的阶段（卷）划好后');
      expect(seg).toContain('排集纲前');
      expect(seg).toContain('写了几章、人物立起来后');
      expect(seg).toContain('成长线始终没人管');
      // 三角（wound/desire/need 词表先验就地解释）。
      expect(seg).toContain('wound_or_lack');
      expect(seg).toContain('desire');
      expect(seg).toContain('need');
      expect(seg).toContain('九类欲望');
      // 转折点 = 质变节点 + 用途锚（为高潮攒劲）+ 集锚。
      expect(seg).toContain('质变节点');
      expect(seg).toContain('攒了什么劲');
      expect(seg).toContain('linked_episode_ids');
      // 终点反推。
      expect(seg).toContain('先定终点再回推');
      expect(seg).toContain('end_state');
      // 三层权威标注。
      expect(seg).toContain('【你已定】');
      expect(seg).toContain('【craft 参考】');
      expect(seg).toContain('【LLM 建议】');
      // 工具路由 + 确认语义（用法语言：先呈作者确认 / 全权立即生效 / 微操不动手）。
      expect(seg).toContain('growth_curve_update');
      expect(seg).toContain('pacing_curve_update');
      expect(seg).toContain('先呈给作者确认');
      expect(seg).toContain('全权档：立即生效');
      // 克制条款（婉拒同阶段不再提 + 不刷屏 + 只给重要角色）。
      expect(seg).toContain('不再主动提');
      expect(seg).toContain('不要每轮重复刷屏');
      expect(seg).toContain('扁平配角与龙套不建');
    });
  });

  // ── 覆盖三态段 ──

  it('has gaps（零曲线 + 有角色卡）：主动提议建弧缺口注入', async () => {
    writeProjectYaml({ name: 'Test', asset_cards: [CHAR_CARD] });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('弧覆盖');
      expect(note?.content).toContain('成长弧一条都还没有');
      expect(note?.content).toContain('随波逐流');
      // 指向能力段流程。
      expect(note?.content).toContain('「角色弧设计能力」段流程');
      expect(note?.content).not.toContain('弧覆盖检查暂不可用');
    });
  });

  it('has gaps（集纲 progression 悬空）：集纲设计了走向但角色无弧 → 注入缺口消息', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      growth_curve: [curve('char-1')],
      episode_outlines: [episode('ep1', 0, ['char-2'])],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('弧覆盖');
      expect(note?.content).toContain('「char-2」');
      expect(note?.content).toContain('还没有成长曲线');
      expect(note?.content).not.toContain('成长弧一条都还没有');
      expect(note?.content).not.toContain('弧覆盖检查暂不可用');
    });
  });

  it('截断 top-5 + 总数标注（7 个悬空角色 → 前 5 条 / 共 7 条）', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      growth_curve: [curve('char-1')],
      episode_outlines: [episode('ep1', 0, ['char-2', 'char-3', 'char-4', 'char-5', 'char-6', 'char-7', 'char-8'])],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('此处列前 5 条 / 共 7 条');
      expect(note?.content).toContain('「char-2」');
      // 第 6/7 个不入 top-5（防 prompt 撑大）。
      expect(note?.content).not.toContain('「char-7」');
      expect(note?.content).not.toContain('「char-8」');
    });
  });

  it('no gaps（有弧且集纲引用全落）→「已检查过，共 N 条成长弧」graceful 提示', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      growth_curve: [curve('char-1')],
      episode_outlines: [episode('ep1', 0, ['char-1'])],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('已检查过，共 1 条成长弧（角色：char-1）');
      expect(note?.content).toContain('全部有着落');
      expect(note?.content).not.toContain('弧覆盖检查暂不可用');
    });
  });

  it('no gaps（零弧 + 无角色卡）→ 如实告知非缺口态，不出提议缺口（防误打扰）', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('已检查过，0 条成长弧');
      expect(note?.content).toContain('项目还没有角色卡');
      expect(note?.content).not.toContain('成长弧一条都还没有');
    });
  });

  it('degraded（project.yaml 不可读）→「弧覆盖检查暂不可用」声明', async () => {
    // 不写 project.yaml → readFile 失败 → loadArcCoverageForLeader 返 null → undefined 分支。
    await runTurn((system, note) => {
      expect(note?.content).toContain('弧覆盖检查暂不可用');
      expect(note?.content).toContain('本轮不提供弧覆盖信息');
      // 能力段仍常驻（协议段与状态段独立——CR-D1 拆分后进 system 恒定区）。
      expect(capabilityOnly(system)).toContain('角色弧设计能力');
    });
  });

  it('degraded（episode_outlines 形态坏：非数组）→「暂不可用」（不可信数据不判，防误报）', async () => {
    writeProjectYaml({
      name: 'Test',
      growth_curve: [curve('char-1')],
      episode_outlines: { not: 'an array' },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('弧覆盖检查暂不可用');
      expect(note?.content).not.toContain('已检查过，共 1 条成长弧');
    });
  });

  it('degraded（asset_cards 形态坏：非数组）→「暂不可用」（防「有卡却报零曲线」误报）', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: { not: 'an array' },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('弧覆盖检查暂不可用');
      expect(note?.content).not.toContain('成长弧一条都还没有');
    });
  });

  // ── CR-002（8.5 BMad CR）：growth_curve 坏形态 →「数据坏」态如实显示，非「零曲线」提议。──
  // 同一份坏数据读侧归一零曲线（每轮催建弧）+ 写侧 corrupt 拒编辑（让用户手修）会把作者夹死；
  // 修后注入段如实报「N 条坏形态被忽略（需手修）」，不催建弧、不吞缺口信息。

  it('growth_curve 混坏条目 + 有角色卡 → 显示「N 条坏形态数据被忽略」，不出「零曲线提议建弧」', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      growth_curve: ['garbage-entry-not-a-curve'], // 全坏条目（0 可读）
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('1 条坏形态数据被忽略');
      expect(note?.content).toContain('需手修 project.yaml');
      // 数据坏时零曲线判断不可信——不催建弧（防坏数据下每轮提议）。
      expect(note?.content).not.toContain('成长弧一条都还没有');
      expect(note?.content).not.toContain('弧覆盖检查暂不可用');
    });
  });

  it('growth_curve 部分可读（1 好 + 1 坏）→ 坏计数 + 可读数同报，正常无缺口态不误入', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      growth_curve: [curve('char-1'), 'garbage'],
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('1 条坏形态数据被忽略');
      expect(note?.content).toContain('只能读出其中 1 个角色的成长弧');
      // 好条目照常服务缺口检查（此处无悬空 progression）——但数据坏态优先，不出「已检查过……全部有着落」
      // 的全绿结论（被忽略的坏条目里可能有弧）。
      expect(note?.content).not.toContain('全部有着落');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { agentContractSchema, creativeFieldKeys, assetCardTypeSchema } from '@orison/shared-contracts';
import { getAllAgentContracts, getAgentContract } from '../src/engine/agentContracts';

describe('agentContracts 注册表', () => {
  const contracts = getAllAgentContracts();

  it('注册表包含所有预期 agent（targeted-revision 已随链流程重排退役删除）', () => {
    const ids = contracts.map((c) => c.id);
    expect(ids).toContain('intake-agent');
    expect(ids).toContain('asset-loader-agent');
    expect(ids).toContain('story-planner-agent');
    expect(ids).toContain('episode-planner-agent');
    expect(ids).toContain('draft-writer-agent');
    expect(ids).toContain('continuity-memory-agent');
    expect(ids).toContain('multi-review-agent');
    // CR-25（W-CR 批清理）：dormant 条目已删——守门防回潮。
    expect(ids).not.toContain('targeted-revision-agent');
  });

  it('每个 contract 都能通过 agentContractSchema 校验', () => {
    for (const c of contracts) {
      expect(() => agentContractSchema.parse(c)).not.toThrow();
    }
  });

  it('getAgentContract 能按 id 查找', () => {
    const c = getAgentContract('story-planner-agent');
    expect(c).toBeDefined();
    expect(c!.role).toBe('故事规划');
  });

  it('getAgentContract 对不存在的 id 返回 undefined', () => {
    expect(getAgentContract('nonexistent')).toBeUndefined();
  });

  it('每个 contract 的 owns 和 reads 不重叠', () => {
    for (const c of contracts) {
      const overlap = c.owns.filter((f) => c.reads.includes(f));
      expect(overlap, `${c.id} owns 和 reads 重叠: ${overlap}`).toEqual([]);
    }
  });

  it('所有 owns 和 reads 都是合法的 CreativeFieldKey', () => {
    const validKeys = new Set(creativeFieldKeys);
    for (const c of contracts) {
      for (const f of [...c.owns, ...c.reads]) {
        expect(validKeys.has(f), `${c.id} 引用了非法字段: ${f}`).toBe(true);
      }
    }
  });

  it('每个有 owns 的核心创作字段至少被一个 agent 拥有', () => {
    const ownedFields = new Set(contracts.flatMap((c) => c.owns));
    // 这些字段必须有 owner。promise_registry 不在列（Story 8.5 owns 收窄）：写入者 = leader 对话
    // （promise_ledger_update 工具）+ promise-emergence-node 涌现自动落盘，非 CONTRACTS[] agent。
    const requiredOwned = ['creative_brief', 'world_setting', 'outline', 'episode_outlines', 'asset_cards', 'relationship_graph'];
    for (const f of requiredOwned) {
      expect(ownedFields.has(f), `字段 ${f} 没有被任何 agent 拥有`).toBe(true);
    }
  });

  it('每个 contract 至少有一条 must 和一条 mustNot', () => {
    for (const c of contracts) {
      expect(c.must.length, `${c.id} 缺少 must`).toBeGreaterThan(0);
      expect(c.mustNot.length, `${c.id} 缺少 mustNot`).toBeGreaterThan(0);
    }
  });
});

// ── Story 2.4：asset-loader-agent 契约对齐 asset_cards 8 类卡模型（ADR-4 双重表示）──
// CR-008：本测试只锁 TS 侧 CONTRACTS[] shape（owns/reads/must/mustNot/qualityGates 防漂移）。
// runtime 不 parse yaml（prompts/asset-loader-agent.yaml），故无法真测「yaml↔TS 一致」——该一致性
// 是 ADR-4 双重表示的约定（手动同步），真 runtime 接通属 Epic 4。此处锁 CONTRACTS[] shape，
// 非校验 yaml parse；yaml 侧由人按约定与 CONTRACTS[] 对齐。
describe('asset-loader-agent 契约对齐 asset_cards 8 类卡模型（Story 2.4 ADR-4）', () => {
  const assetLoader = getAgentContract('asset-loader-agent');

  it('契约存在且 owns/reads 不变', () => {
    expect(assetLoader).toBeDefined();
    expect(assetLoader!.owns).toEqual(['world_setting', 'asset_cards', 'relationship_graph']);
    expect(assetLoader!.reads).toEqual(['creative_brief']);
  });

  it('goal 反映 8 类 typed 卡模型', () => {
    expect(assetLoader!.goal).toContain('8 类');
    expect(assetLoader!.goal).toContain('typed');
  });

  it('must 覆盖全部卡类型 + world_constitution + per-type 引导字段', () => {
    const mustText = assetLoader!.must.join(' ');
    // CR-007：从 assetCardTypeSchema.options 派生遍历（名副其实防第 9 类漏，非手抄 8 字面量）。
    for (const cardType of assetCardTypeSchema.options) {
      expect(mustText, `must 未覆盖卡类型 ${cardType}`).toContain(cardType);
    }
    expect(mustText).toContain('world_constitution');
    expect(mustText).toContain('per-type 引导字段');
  });

  it('mustNot 禁止 schema 外旧形态字段（styleGuide/characterTemplates 等已废弃）+ 禁改 brief', () => {
    const mustNotText = assetLoader!.mustNot.join(' ');
    expect(mustNotText).toContain('修改创作 brief');
    expect(mustNotText).toContain('schema 外字段');
    // 旧 prompt 产出的 4 个废弃顶层字段必须被显式禁用（防回退）
    for (const legacy of ['styleGuide', 'references', 'worldRules', 'characterTemplates']) {
      expect(mustNotText, `mustNot 未显式禁用废弃字段 ${legacy}`).toContain(legacy);
    }
  });

  it('qualityGates 含 has_world_setting + has_asset_cards + asset_cards_have_valid_type', () => {
    expect(assetLoader!.qualityGates).toContain('has_world_setting');
    expect(assetLoader!.qualityGates).toContain('has_asset_cards');
    expect(assetLoader!.qualityGates).toContain('asset_cards_have_valid_type');
  });
});

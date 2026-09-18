import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  YAML_AGENT_SLOT,
  assignmentContextWindowTokens,
  resolveTaskModel,
  resolveTaskModelForAgent,
  setTaskSlotResolver,
} from '../src/runtime/taskModelRouting';
import { taskModelSlotSchema } from '@orison/shared-contracts';

// Module-level resolver state persists across tests in this file — reset so
// each test starts from the "nothing injected" default.
afterEach(() => {
  setTaskSlotResolver(undefined);
});

describe('runtime taskModelRouting resolver', () => {
  it('returns undefined for every slot when no resolver is injected (default = auto-pick)', () => {
    for (const slot of taskModelSlotSchema.options) {
      expect(resolveTaskModel(slot)).toBeUndefined();
    }
  });

  it('routes each configured slot through the injected resolver', () => {
    setTaskSlotResolver((slot) =>
      slot === 'writer-draft' ? { keyId: 'k1', modelId: 'heavy-model' } : undefined,
    );
    expect(resolveTaskModel('writer-draft')).toEqual({ keyId: 'k1', modelId: 'heavy-model' });
  });

  it('returns undefined when the resolver has no model configured for the slot', () => {
    setTaskSlotResolver(() => undefined);
    expect(resolveTaskModel('dialogue')).toBeUndefined();
  });

  it('setTaskSlotResolver(undefined) resets to the no-routing default', () => {
    setTaskSlotResolver(() => ({ keyId: 'k1', modelId: 'm' }));
    expect(resolveTaskModel('extraction')).toEqual({ keyId: 'k1', modelId: 'm' });
    setTaskSlotResolver(undefined);
    expect(resolveTaskModel('extraction')).toBeUndefined();
  });
});

// ── 09-13 链流程重排 R1b：审核族细档回落链（fine ?? review-judge ?? undefined）──
// 回落链在 resolveTaskModel 单点实现（W0-8：现状零档间回落，mirror 装配侧
// writer-selfcheck ?? writer-draft 先例）；assignment 整体回落（模型+思考策略，
// 不杂交——design §1.2 纪律）。
const FINE_REVIEW_SLOTS = ['plan-review', 'multi-review', 'route-judge', 'revision-guard'] as const;

describe('review-lineage fine-slot fallback (09-13 R1b)', () => {
  it('细档未配而 review-judge 已配 → 四细档全部回落 review-judge assignment 整体（含思考策略，不杂交）', () => {
    setTaskSlotResolver((slot) =>
      slot === 'review-judge'
        ? { keyId: 'k1', modelId: 'judge-model', thinking: 'high' as const }
        : undefined,
    );
    for (const fine of FINE_REVIEW_SLOTS) {
      expect(resolveTaskModel(fine), `${fine} 应回落 review-judge`).toEqual({
        keyId: 'k1',
        modelId: 'judge-model',
        thinking: 'high',
      });
    }
  });

  it('细档已配 → 本档 assignment 优先，不回落', () => {
    setTaskSlotResolver((slot) =>
      slot === 'route-judge'
        ? { keyId: 'k1', modelId: 'route-model' }
        : slot === 'review-judge'
          ? { keyId: 'k1', modelId: 'judge-model' }
          : undefined,
    );
    expect(resolveTaskModel('route-judge')).toEqual({ keyId: 'k1', modelId: 'route-model' });
  });

  it('细档与 review-judge 都未配 → undefined（「全局」终点 = provider default 哨兵自动选择）', () => {
    setTaskSlotResolver((slot) => (slot === 'writer-draft' ? { keyId: 'k1', modelId: 'm' } : undefined));
    expect(resolveTaskModel('multi-review')).toBeUndefined();
    expect(resolveTaskModel('revision-guard')).toBeUndefined();
    expect(resolveTaskModel('plan-review')).toBeUndefined();
  });

  it('回落只覆盖细档：非审核族槽位未配恒 undefined（review-judge 自身无回落条目，链不循环）', () => {
    setTaskSlotResolver((slot) => (slot === 'review-judge' ? { keyId: 'k1', modelId: 'judge-model' } : undefined));
    for (const coarse of ['writer-selfcheck', 'writer-draft', 'extraction', 'dispatch', 'dialogue'] as const) {
      expect(resolveTaskModel(coarse), `${coarse} 不参与回落`).toBeUndefined();
    }
    // review-judge 直查命中自身。
    expect(resolveTaskModel('review-judge')).toEqual({ keyId: 'k1', modelId: 'judge-model' });
  });

  it('resolveTaskModelForAgent 经 YAML_AGENT_SLOT 吃到回落（adjudicator→route-judge 未配回落 review-judge）', () => {
    setTaskSlotResolver((slot) => (slot === 'review-judge' ? { keyId: 'k1', modelId: 'judge-model' } : undefined));
    expect(resolveTaskModelForAgent('adjudicator-agent')).toEqual({ keyId: 'k1', modelId: 'judge-model' });
  });
});

describe('assignmentContextWindowTokens enrichment precedence (09-12 子3 §4.4, AC3 agent 面)', () => {
  it('enriched 值优先：assignment.contextWindowTokens（shell resolver 注入产物）压过 registry', () => {
    // 未知模型（registry 无 limits）+ enriched 131072 → 用户手填窗口生效（AC3 正例）。
    expect(
      assignmentContextWindowTokens({ keyId: 'k1', modelId: 'totally-unknown', contextWindowTokens: 131_072 }),
    ).toBe(131_072);
    // 已知模型同样 enriched 优先——enrichment 语义是「覆盖」不是「仅未知模型补位」。
    expect(
      assignmentContextWindowTokens({ keyId: 'k1', modelId: 'glm-5.1', contextWindowTokens: 8_000 }),
    ).toBe(8_000);
  });

  it('无 enriched 值回 registry 单源（basename 二轮同带）', () => {
    expect(assignmentContextWindowTokens({ keyId: 'k1', modelId: 'glm-5.1' })).toBe(204_800);
  });

  it('CR-4: 非正整数 enriched 值（0/负/小数）回落 registry——`??` 链不再保 0 毒化红线数学', () => {
    // 三处链路的末端 belt（shell 读侧拒 + enrichSlotAssignment 注入侧滤是前两道）：
    // 经任何路径渗入的 0/负/小数 contextWindowTokens 不注入，registry 单源承接。
    for (const bad of [0, -1, 1.5]) {
      expect(assignmentContextWindowTokens({ keyId: 'k1', modelId: 'glm-5.1', contextWindowTokens: bad })).toBe(204_800);
    }
    // 未知模型 + 病态 enriched 值 → undefined（不猜窗口，非 0）。
    expect(assignmentContextWindowTokens({ keyId: 'k1', modelId: 'totally-unknown', contextWindowTokens: 0 })).toBeUndefined();
  });

  it('双无 → undefined（不猜窗口；调用方诚实回落缺省）', () => {
    expect(assignmentContextWindowTokens({ keyId: 'k1', modelId: 'totally-unknown' })).toBeUndefined();
    expect(assignmentContextWindowTokens(undefined)).toBeUndefined();
  });
});

describe('YAML_AGENT_SLOT dispatch table (design §5)', () => {
  it('maps the six dispatch-family agents to dispatch', () => {
    expect(YAML_AGENT_SLOT['story-planner-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['episode-planner-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['director-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['researcher-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['revision-optimizer-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['ripple-diagnosis-agent']).toBe('dispatch');
  });

  it('maps the coarse semantic judges to review-judge', () => {
    expect(YAML_AGENT_SLOT['arc-audit-agent']).toBe('review-judge');
    expect(YAML_AGENT_SLOT['world-amender-agent']).toBe('review-judge');
    // 风格卡分析者（08-28 style-card-mvp A 路）——语义质量档：九遍扫描深分析，质量敏感。
    expect(YAML_AGENT_SLOT['style-analyzer-agent']).toBe('review-judge');
  });

  it('maps the review lineage to the fine slots (09-13 R1b)', () => {
    // 裁决器迁 route-judge（design §1：灰区裁决是链尾 route 判决语义的延伸）；链节点名
    // 先行入表钉 slot 语义单源（装配行 re-slot 归 W1a/W1c——brief-reviewer 节点 W1c 建）。
    expect(YAML_AGENT_SLOT['adjudicator-agent']).toBe('route-judge');
    expect(YAML_AGENT_SLOT['multi-review-agent']).toBe('multi-review');
    expect(YAML_AGENT_SLOT['route-agent']).toBe('route-judge');
    expect(YAML_AGENT_SLOT['revision-guard-agent']).toBe('revision-guard');
    expect(YAML_AGENT_SLOT['brief-reviewer-agent']).toBe('plan-review');
  });

  it('contains exactly the fourteen registered agents — every value is a legal slot', () => {
    const entries = Object.entries(YAML_AGENT_SLOT);
    expect(entries).toHaveLength(14);
    const legalSlots = new Set<string>(taskModelSlotSchema.options);
    for (const [name, slot] of entries) {
      expect(name.endsWith('-agent')).toBe(true);
      expect(legalSlots.has(slot)).toBe(true);
    }
  });

  it('leaves unknown agent names unmapped (undefined → no routing, auto-pick)', () => {
    // A yaml agent not in the table must not inherit a slot by accident —
    // the dispatch single point routes nothing for it.
    expect(YAML_AGENT_SLOT['retrieval-agent']).toBeUndefined();
    expect(YAML_AGENT_SLOT['inspiration-agent']).toBeUndefined();
  });

  it('unknown-name lookup yields undefined even with a resolver injected', () => {
    setTaskSlotResolver(() => ({ keyId: 'k1', modelId: 'm' }));
    // The wiring at workflow.ts dispatch single point guards on the lookup
    // before calling resolveTaskModel; an unmapped name therefore never
    // consults the resolver and the call routes nothing (auto-pick).
    expect(YAML_AGENT_SLOT['some-future-agent']).toBeUndefined();
  });

  it('resolveTaskModelForAgent: mapped name routes the slot, unknown name routes nothing', () => {
    setTaskSlotResolver((slot) => (slot === 'dispatch' ? { keyId: 'k1', modelId: 'd-model' } : undefined));
    expect(resolveTaskModelForAgent('director-agent')).toEqual({ keyId: 'k1', modelId: 'd-model' });
    // Unknown agent name never consults the resolver (spy stays uncalled).
    const spy = vi.fn(() => ({ keyId: 'k1', modelId: 'm' }));
    setTaskSlotResolver(spy);
    expect(resolveTaskModelForAgent('inspiration-agent')).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('CR-009: prototype-key names (toString/__proto__/constructor) hit "not registered", never an inherited property', () => {
    // YAML_AGENT_SLOT is a plain object — a naive `TABLE[name]` lookup would
    // resolve 'toString' to the inherited function and feed it to a slot cast.
    // Object.hasOwn must gate the lookup even with a resolver injected.
    setTaskSlotResolver((slot) => (slot === 'dispatch' ? { keyId: 'k1', modelId: 'd' } : undefined));
    expect(resolveTaskModelForAgent('toString')).toBeUndefined();
    expect(resolveTaskModelForAgent('__proto__')).toBeUndefined();
    expect(resolveTaskModelForAgent('constructor')).toBeUndefined();
  });

  it('AC4 / CR-012: a slot pointing at a disabled or deleted model passes through unchanged — transparency', () => {
    // The agent layer holds no key/enabled knowledge by design (ADR-2: config
    // lives in the shell). Whatever the resolver returns must reach generate
    // EXACTLY as-is — never silently rerouted — so the failure stays visible
    // where it belongs: shell resolveModel throws (pinned shell-side).
    const danglingRef = { keyId: 'key_gone', modelId: 'model-disabled' };
    setTaskSlotResolver(() => danglingRef);
    expect(resolveTaskModel('writer-draft')).toBe(danglingRef); // same reference, untouched
  });
});

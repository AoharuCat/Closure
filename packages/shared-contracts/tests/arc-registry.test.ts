import { describe, expect, it } from 'vitest';
import {
  ARC_QUERY_BEAT_WINDOW,
  ARC_STAGNATION_CHAPTERS,
  applyArcLedgerActions,
  arcAuditFindingSchema,
  arcAuditResultSchema,
  arcBeatSchema,
  arcBeatWriteSchema,
  arcLedgerActionSchema,
  arcLedgerUpdateRequestSchema,
  arcRegistrySchema,
  detectArcStagnation,
  detectVolumeClosure,
  deriveArcSpan,
  queryArcRequestSchema,
  queryArcSummaryRequestSchema,
  type ArcBeat,
  type ArcRegistry,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.2 Step 1：arc_registry 契约（schema round-trip）+ 关口/停滞/span 三纯函数边界
// + bounded action projector 幂等 + IPC request schemas。
// 范式红线（creative-vs-mechanical）：三纯函数全机械判定（集合查询/计数/min-max），测试只断言机械事实。
// ─────────────────────────────────────────────────────────────────────────────

function mkBeat(over: Partial<ArcBeat> & Pick<ArcBeat, 'arcRef' | 'arcKind' | 'action' | 'episodeId' | 'episodeIndex'>): ArcBeat {
  return arcBeatSchema.parse({
    id: `b-${over.arcRef}-${over.episodeId}-${over.action}`,
    ...over,
    ...(over.action === 'close' ? { grounding: over.grounding ?? '伏线在法庭对峙中收束。' } : {}),
  });
}

// ── schema round-trip ──

describe('arc schemas — round-trip（design §3 原样）', () => {
  it('arcBeatSchema：完整 beat parse 通过 + 类型化字段', () => {
    const beat = arcBeatSchema.parse({
      id: 'b1',
      episodeId: 'ep-10',
      episodeIndex: 10,
      arcRef: 'phase-2',
      arcKind: 'volume',
      action: 'close',
      note: '本卷在审判日收束',
      grounding: '「判决生效。」法官落槌。',
    });
    expect(beat.arcKind).toBe('volume');
    expect(beat.grounding).toContain('落槌');
  });

  it('arcBeatSchema：非法 arcKind / action / 负 episodeIndex reject', () => {
    const base = { id: 'b1', episodeId: 'e', arcRef: 'a', action: 'advance' as const };
    expect(() => arcBeatSchema.parse({ ...base, episodeIndex: 0, arcKind: 'thread' })).toThrow();
    expect(() => arcBeatSchema.parse({ ...base, episodeIndex: 0, arcKind: 'line', action: 'reopen' })).toThrow();
    expect(() => arcBeatSchema.parse({ ...base, episodeIndex: -1, arcKind: 'line' })).toThrow();
  });

  it('arcRegistrySchema：defaults（beats [] / version 0 / updatedBy agent）', () => {
    const registry = arcRegistrySchema.parse({});
    expect(registry).toEqual({ beats: [], version: 0, updatedBy: 'agent' });
  });

  it('arcAuditFindingSchema：六维 category + 三档 route + 四档 verdict 全枚举可 parse', () => {
    const categories = [
      'volume-arc',
      'arc-drift',
      'foreshadow-payoff',
      'theme-earning',
      'character-arc',
      'emotion-arc',
    ] as const;
    const routes = ['defect', 'deviation', 'gray'] as const;
    const verdicts = ['missing', 'under-developed', 'stalled', 'drifted'] as const;
    for (const category of categories) {
      for (const route of routes) {
        const finding = arcAuditFindingSchema.parse({
          category,
          route,
          verdict: verdicts[0],
          entityId: 'phase-2',
          entityLabel: '第二卷',
          quote: '原文引用',
          location: 'ep-12',
          explanation: '该收束未挣得',
          suggestedFix: '下卷开场补一次呼应',
        });
        expect(finding.route).toBe(route);
      }
    }
    expect(() =>
      arcAuditFindingSchema.parse({
        category: 'bogus',
        route: 'defect',
        verdict: 'missing',
        entityId: 'x',
        entityLabel: 'x',
        quote: 'q',
        location: 'l',
        explanation: 'e',
        suggestedFix: 'f',
      }),
    ).toThrow();
  });

  it('arcAuditResultSchema：停滞专注审形态（无 arcSummary）+ 大审形态（含 arcSummary defaults）round-trip', () => {
    const stagnation = arcAuditResultSchema.parse({
      arcRef: 'line-sub-a',
      arcKind: 'line',
      span: { fromEpisodeIndex: 3, toEpisodeIndex: 14 },
      findings: [],
    });
    expect(stagnation.arcSummary).toBeUndefined();
    expect(stagnation.degraded).toBe(false);

    const closure = arcAuditResultSchema.parse({
      arcRef: 'phase-1',
      arcKind: 'volume',
      span: { fromEpisodeIndex: 0, toEpisodeIndex: 12 },
      arcSummary: { synopsis: '第一卷：逃离临安。' },
      findings: [],
    });
    expect(closure.arcSummary?.lineSections).toEqual([]);
    expect(closure.arcSummary?.openThreads).toEqual([]);
    expect(closure.arcSummary?.characterArcs).toEqual([]);
  });

  it('arcAuditResultSchema：degraded 标注形态 parse（永不假 pass 通道）', () => {
    const degraded = arcAuditResultSchema.parse({
      arcRef: 'phase-1',
      arcKind: 'volume',
      span: { fromEpisodeIndex: 0, toEpisodeIndex: 12 },
      degraded: true,
      degradationNote: '大审输出 parse 失败，findings 为空非真无发现',
    });
    expect(degraded.degraded).toBe(true);
    expect(degraded.degradationNote).toBeTruthy();
  });

  it('arcBeatWriteSchema：close 缺 grounding reject（写入侧强制）；advance 无 grounding 合法', () => {
    expect(() =>
      arcBeatWriteSchema.parse({
        episodeId: 'ep-10',
        episodeIndex: 10,
        arcRef: 'phase-1',
        arcKind: 'volume',
        action: 'close',
      }),
    ).toThrow();
    // 空白 grounding 同样拒（trim 检查）。
    expect(() =>
      arcBeatWriteSchema.parse({
        episodeId: 'ep-10',
        episodeIndex: 10,
        arcRef: 'phase-1',
        arcKind: 'volume',
        action: 'close',
        grounding: '   ',
      }),
    ).toThrow();
    expect(
      arcBeatWriteSchema.parse({
        episodeId: 'ep-10',
        episodeIndex: 10,
        arcRef: 'phase-1',
        arcKind: 'volume',
        action: 'advance',
      }).id,
    ).toBeUndefined(); // id 可缺（projector 自然键生成）
  });
});

// ── detectVolumeClosure（关口判定）──

describe('detectVolumeClosure — 关口判定（纯函数）', () => {
  const beats = [
    mkBeat({ arcRef: 'phase-1', arcKind: 'volume', action: 'advance', episodeId: 'ep-1', episodeIndex: 1 }),
    mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'close', episodeId: 'ep-2', episodeIndex: 2 }),
    mkBeat({ arcRef: 'phase-1', arcKind: 'volume', action: 'close', episodeId: 'ep-12', episodeIndex: 12 }),
    mkBeat({ arcRef: 'growth:erina', arcKind: 'growth', action: 'advance', episodeId: 'ep-12', episodeIndex: 12 }),
  ];

  it('本章有卷弧 close beat → 返回该 beat', () => {
    const hit = detectVolumeClosure(beats, 'ep-12');
    expect(hit).toBeDefined();
    expect(hit!.arcRef).toBe('phase-1');
    expect(hit!.action).toBe('close');
  });

  it('无 close beat 章（只有 advance / 别弧 close）→ undefined（零派发零成本路径）', () => {
    expect(detectVolumeClosure(beats, 'ep-1')).toBeUndefined();
    // ep-2 只有线弧 close——非卷弧不触发大审。
    expect(detectVolumeClosure(beats, 'ep-2')).toBeUndefined();
    expect(detectVolumeClosure(beats, 'ep-999')).toBeUndefined();
  });

  it('空 beats → undefined', () => {
    expect(detectVolumeClosure([], 'ep-1')).toBeUndefined();
  });
});

// ── deriveArcSpan（弧节拍区间）──

describe('deriveArcSpan — 弧首末 beat index 区间（纯函数）', () => {
  const beats = [
    mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'advance', episodeId: 'e2', episodeIndex: 2 }),
    mkBeat({ arcRef: 'phase-1', arcKind: 'volume', action: 'advance', episodeId: 'e0', episodeIndex: 0 }),
    mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'advance', episodeId: 'e5', episodeIndex: 5 }),
    mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'close', episodeId: 'e9', episodeIndex: 9 }),
    // 跨弧混传：line-b 的 beats 不污染 line-a 区间。
    mkBeat({ arcRef: 'line-b', arcKind: 'line', action: 'advance', episodeId: 'e30', episodeIndex: 30 }),
  ];

  it('跨弧混传安全：按 arcRef 过滤后取 min/max（乱序 beats 亦然）', () => {
    expect(deriveArcSpan(beats, 'line-a')).toEqual({ fromEpisodeIndex: 2, toEpisodeIndex: 9 });
    expect(deriveArcSpan(beats, 'line-b')).toEqual({ fromEpisodeIndex: 30, toEpisodeIndex: 30 });
    expect(deriveArcSpan(beats, 'phase-1')).toEqual({ fromEpisodeIndex: 0, toEpisodeIndex: 0 });
  });

  it('空 beats / 该弧无 beat → undefined', () => {
    expect(deriveArcSpan([], 'line-a')).toBeUndefined();
    expect(deriveArcSpan(beats, 'line-ghost')).toBeUndefined();
  });
});

// ── detectArcStagnation（停滞检测）──

describe('detectArcStagnation — 停滞检测（纯函数）', () => {
  function staleBeats(arcRef: string, arcKind: 'line' | 'growth', lastEpisodeIndex: number): ArcBeat[] {
    return [
      mkBeat({ arcRef, arcKind, action: 'advance', episodeId: 'e0', episodeIndex: 0 }),
      mkBeat({ arcRef, arcKind, action: 'advance', episodeId: `e${lastEpisodeIndex}`, episodeIndex: lastEpisodeIndex }),
    ];
  }

  it(`N 界：最后 beat 距今 ${ARC_STAGNATION_CHAPTERS} 章不算停滞；超过才算`, () => {
    const last = 10;
    // current = last + 10 → gap = 10 = n → 不停滞（须严格超过）。
    expect(detectArcStagnation(staleBeats('line-a', 'line', last), last + ARC_STAGNATION_CHAPTERS)).toEqual([]);
    // current = last + 11 → gap = 11 > n → 停滞。
    const stagnant = detectArcStagnation(staleBeats('line-a', 'line', last), last + ARC_STAGNATION_CHAPTERS + 1);
    expect(stagnant).toHaveLength(1);
    expect(stagnant[0]).toMatchObject({
      arcRef: 'line-a',
      arcKind: 'line',
      lastBeatEpisodeIndex: 10,
      chaptersSinceLastBeat: ARC_STAGNATION_CHAPTERS + 1,
      span: { fromEpisodeIndex: 0, toEpisodeIndex: 10 },
    });
  });

  it('自定义 n 生效（常量可调，design §2）', () => {
    const beats = staleBeats('line-a', 'line', 4); // current=10 → gap=6
    expect(detectArcStagnation(beats, 10, 6)).toEqual([]); // gap 6 = n → 不停滞
    expect(detectArcStagnation(beats, 10, 5)).toHaveLength(1); // gap 6 > n=5 → 停滞
  });

  it('空 beats → []（无停滞弧不派发）', () => {
    expect(detectArcStagnation([], 100)).toEqual([]);
  });

  it('只对 line + growth：volume 弧长跨度不误报（同 gap 不停滞）', () => {
    const volumeStale = [
      mkBeat({ arcRef: 'phase-1', arcKind: 'volume', action: 'advance', episodeId: 'e1', episodeIndex: 1 }),
    ];
    expect(detectArcStagnation(volumeStale, 1 + ARC_STAGNATION_CHAPTERS + 5)).toEqual([]);
    // line + growth 同 gap 均停滞。
    const mixed = [
      ...volumeStale,
      ...staleBeats('line-a', 'line', 1),
      ...staleBeats('growth:erina', 'growth', 1),
    ];
    const stagnant = detectArcStagnation(mixed, 1 + ARC_STAGNATION_CHAPTERS + 5);
    expect(stagnant.map((s) => s.arcKind).sort()).toEqual(['growth', 'line']);
  });

  it('已闭合弧（有 close beat）不审停滞——终态', () => {
    const closed = [
      mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'advance', episodeId: 'e1', episodeIndex: 1 }),
      mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'close', episodeId: 'e2', episodeIndex: 2 }),
    ];
    expect(detectArcStagnation(closed, 2 + ARC_STAGNATION_CHAPTERS + 5)).toEqual([]);
  });

  it('跨弧分组：多弧独立判定 + registry beats 首现序输出', () => {
    const beats = [
      ...staleBeats('line-first', 'line', 3),
      ...staleBeats('line-second', 'line', 7),
      ...staleBeats('line-fresh', 'line', 20), // 距今 0 章不停滞
    ];
    const stagnant = detectArcStagnation(beats, 20);
    expect(stagnant.map((s) => s.arcRef)).toEqual(['line-first', 'line-second']);
    expect(stagnant[0].lastBeatEpisodeIndex).toBe(3);
    expect(stagnant[1].lastBeatEpisodeIndex).toBe(7);
  });

  it('未来章边界防御不截断（输入契约=实际轨无未来 beat；有也不筛——文档化行为）', () => {
    // currentEpisodeIndex 早于 last beat（负 gap）不误报为停滞。
    const beats = staleBeats('line-a', 'line', 50);
    expect(detectArcStagnation(beats, 10)).toEqual([]);
  });
});

// ── applyArcLedgerActions（bounded action projector）──

describe('applyArcLedgerActions — bounded action 投影（纯函数，mirror applyPromiseActions）', () => {
  const emptyRegistry: ArcRegistry = arcRegistrySchema.parse({});

  it('add_beat：追加 + id 自然键生成（arcRef::episodeId::action）', () => {
    const next = applyArcLedgerActions(emptyRegistry, [
      {
        type: 'add_beat',
        beat: {
          episodeId: 'ep-10',
          episodeIndex: 10,
          arcRef: 'phase-1',
          arcKind: 'volume',
          action: 'advance',
          note: '审判日开庭',
        },
      },
    ]);
    expect(next.beats).toHaveLength(1);
    expect(next.beats[0].id).toBe('phase-1::ep-10::advance');
    // version/updatedBy 透传（onFieldEdited 落盘时 bump，非 projector 职责）。
    expect(next.version).toBe(0);
    expect(next.updatedBy).toBe('agent');
  });

  it('幂等：同 (arcRef, episodeId, action) 自然键覆盖 note/grounding，保留既有 id，不累积', () => {
    const seeded: ArcRegistry = arcRegistrySchema.parse({
      beats: [
        mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'advance', episodeId: 'ep-3', episodeIndex: 3, note: '旧推进' }),
      ],
    });
    const next = applyArcLedgerActions(seeded, [
      {
        type: 'add_beat',
        beat: {
          id: 'ignored-explicit-id',
          episodeId: 'ep-3',
          episodeIndex: 3,
          arcRef: 'line-a',
          arcKind: 'line',
          action: 'advance',
          note: '新推进',
        },
      },
    ]);
    expect(next.beats).toHaveLength(1);
    expect(next.beats[0].id).toBe('b-line-a-ep-3-advance'); // 既有 id 保留（显式 id 不覆盖）
    expect(next.beats[0].note).toBe('新推进');
  });

  it('同 actions 双投影幂等（链流程重排 W3——同章重跑 E 段 arc_ledger_update 无重复登记）', () => {
    // E 段（E5 arc-emergence → arc_ledger_update）重跑场景：同章同 actions 二次投影 beats 数与
    // id 集不变——自然键 (arcRef, episodeId, action) upsert 覆盖（W0-2 结论回归锚：arc 侧自然键与
    // LLM 自拟 id 无关，重跑严格幂等）。
    const actions = [
      {
        type: 'add_beat',
        beat: { episodeId: 'ep-10', episodeIndex: 10, arcRef: 'phase-1', arcKind: 'volume', action: 'advance', note: '审判日开庭' },
      },
      {
        type: 'add_beat',
        beat: { episodeId: 'ep-10', episodeIndex: 10, arcRef: 'phase-1', arcKind: 'volume', action: 'close', grounding: '「判决生效。」' },
      },
    ] as const;
    const first = applyArcLedgerActions(emptyRegistry, [...actions]);
    expect(first.beats).toHaveLength(2);
    const second = applyArcLedgerActions(first, [...actions]);
    expect(second.beats).toHaveLength(2);
    expect(second.beats.map((b) => b.id).sort()).toEqual(first.beats.map((b) => b.id).sort());
  });

  it('同弧同章 advance + close 并存（不同 action = 不同自然键槽）', () => {
    const next = applyArcLedgerActions(emptyRegistry, [
      {
        type: 'add_beat',
        beat: { episodeId: 'ep-12', episodeIndex: 12, arcRef: 'phase-1', arcKind: 'volume', action: 'advance' },
      },
      {
        type: 'add_beat',
        beat: {
          episodeId: 'ep-12',
          episodeIndex: 12,
          arcRef: 'phase-1',
          arcKind: 'volume',
          action: 'close',
          grounding: '「判决生效。」',
        },
      },
    ]);
    expect(next.beats).toHaveLength(2);
    expect(next.beats.map((b) => b.action).sort()).toEqual(['advance', 'close']);
  });

  it('close 缺 grounding 在 schema 层拦截（projector 前的 trust-boundary）', () => {
    expect(() =>
      arcLedgerActionSchema.parse({
        type: 'add_beat',
        beat: { episodeId: 'e1', episodeIndex: 1, arcRef: 'p1', arcKind: 'volume', action: 'close' },
      }),
    ).toThrow(/grounding/);
  });

  it('空 actions → 原样 registry（beats 引用不变语义）', () => {
    const seeded: ArcRegistry = arcRegistrySchema.parse({
      beats: [mkBeat({ arcRef: 'line-a', arcKind: 'line', action: 'advance', episodeId: 'e1', episodeIndex: 1 })],
    });
    const next = applyArcLedgerActions(seeded, []);
    expect(next.beats).toHaveLength(1);
    expect(next.version).toBe(seeded.version);
  });
});

// ── IPC request schemas（handler 校验 + agent builtin 工具描述共用单源）──

describe('Story 8.2 IPC request schemas', () => {
  it('queryArcRequestSchema：空参合法（全量最近窗）；episodeId/arcRef 收窄；空串 reject', () => {
    expect(queryArcRequestSchema.parse({})).toEqual({});
    expect(queryArcRequestSchema.parse({ episodeId: 'ep-10', arcRef: 'phase-1' })).toEqual({
      episodeId: 'ep-10',
      arcRef: 'phase-1',
    });
    expect(() => queryArcRequestSchema.parse({ episodeId: '' })).toThrow();
  });

  it('arcLedgerUpdateRequestSchema：actions + autoApply 可选；非法 action 形状 reject', () => {
    expect(
      arcLedgerUpdateRequestSchema.parse({
        actions: [
          {
            type: 'add_beat',
            beat: { episodeId: 'e1', episodeIndex: 1, arcRef: 'p1', arcKind: 'line', action: 'advance' },
          },
        ],
        autoApply: true,
      }).autoApply,
    ).toBe(true);
    expect(() => arcLedgerUpdateRequestSchema.parse({ actions: [{ type: 'bogus' }] })).toThrow();
  });

  it('queryArcSummaryRequestSchema：空参合法；arcRef 空串 reject', () => {
    expect(queryArcSummaryRequestSchema.parse({})).toEqual({});
    expect(queryArcSummaryRequestSchema.parse({ arcRef: 'phase-1' }).arcRef).toBe('phase-1');
    expect(() => queryArcSummaryRequestSchema.parse({ arcRef: '' })).toThrow();
  });

  it(`ARC_QUERY_BEAT_WINDOW = ${ARC_QUERY_BEAT_WINDOW}（读侧最近窗防倾倒常量在位）`, () => {
    expect(ARC_QUERY_BEAT_WINDOW).toBe(200);
  });
});

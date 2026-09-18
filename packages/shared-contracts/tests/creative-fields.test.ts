import { describe, expect, it } from 'vitest';
import {
  creativeBriefSchema,
  creativePreferencesSchema,
  outlineDepthAxisSchema,
  arcTimingAxisSchema,
  worldDepthAxisSchema,
  characterDepthAxisSchema,
  worldSettingSchema,
  outlineV2Schema,
  episodeOutlineSchema,
  episodeOutlinesSchema,
  growthCurveSchema,
  growthCurveFieldSchema,
  growthCurveActionSchema,
  applyGrowthCurveActions,
  pacingCurveSchema,
  pacingPointSchema,
  pacingCurveActionSchema,
  applyPacingCurveActions,
  episodeActionSchema,
  applyEpisodeActions,
  emotionCurveSchema,
  emotionPointSchema,
  emotionCharacterSchema,
  emotionCurveActionSchema,
  applyEmotionCurveActions,
  vadTripleSchema,
  assetCardSchema,
  assetCardsSchema,
  assetCardTypeSchema,
  assetCardActionSchema,
  applyAssetCardActions,
  narrativeSchema,
  relationshipGraphSchema,
  promiseRegistrySchema,
  promiseEntrySchema,
  promiseBeatSchema,
  promiseActionSchema,
  applyPromiseActions,
  derivePromiseStage,
  deriveBeatState,
  resolvePromiseFulfillment,
  PROMISE_CATEGORY_VOCAB,
  sceneGraphSchema,
  sceneNodeSchema,
  sceneEdgeSchema,
  sceneLineSchema,
  sceneGraphActionSchema,
  majorTurningPointSchema,
  majorTurningPointTypeSchema,
  lineVisibilitySchema,
  findDanglingLineTags,
  LINE_VALIDATION_PROFILE,
  fieldMetadataSchema,
  creativeFieldKeys,
  creativeFieldKeySchema,
  presentationSpanSchema,
  projectFieldPatchSchema,
  POWER_SYSTEM_TYPE_VOCAB,
  LOCATION_TYPE_VOCAB,
  PROP_TYPE_VOCAB,
  ORGANIZATION_TYPE_VOCAB,
  RULE_TYPE_VOCAB,
  VISUAL_MOTIF_TYPE_VOCAB,
  LORE_TYPE_VOCAB,
  GOLDEN_FINGER_TYPE_VOCAB,
  GOLDEN_FINGER_ESSENCE_VOCAB
} from '../src';

describe('creative-fields schemas', () => {
  it('creativeFieldKeys 覆盖 14 个核心字段（含 scene_graph + info_release_map + promise_registry + arc_registry + creative_preferences）', () => {
    expect(creativeFieldKeys).toHaveLength(14);
    expect(creativeFieldKeys).toContain('world_setting');
    expect(creativeFieldKeys).toContain('asset_cards');
    expect(creativeFieldKeys).toContain('relationship_graph');
    expect(creativeFieldKeys).toContain('episode_outlines');
    expect(creativeFieldKeys).toContain('promise_registry');
    expect(creativeFieldKeys).toContain('info_release_map');
    expect(creativeFieldKeys).toContain('scene_graph');
    // Story 8.2：弧节拍 creative field（写手声明，mirror promise_registry 归属）。
    expect(creativeFieldKeys).toContain('arc_registry');
    // Story 8.6：创作深度偏好（分项目工作方式，尾部追加保既有序不动）。
    expect(creativeFieldKeys).toContain('creative_preferences');
    expect(creativeFieldKeys[creativeFieldKeys.length - 1]).toBe('creative_preferences');
  });

  it('creativeFieldKeySchema 校验合法值', () => {
    expect(creativeFieldKeySchema.parse('outline')).toBe('outline');
    expect(() => creativeFieldKeySchema.parse('invalid')).toThrow();
  });

  // ── Story 8.6 D3/D4：创作深度偏好（四轴 enum + note，全 optional——absent = 未问 = 标准档）──

  it('creativePreferencesSchema 缺省（空对象）= 未问 = 标准档（全轴 undefined，parse 通过）', () => {
    const prefs = creativePreferencesSchema.parse({});
    expect(prefs.outline_depth).toBeUndefined();
    expect(prefs.arc_timing).toBeUndefined();
    expect(prefs.world_depth).toBeUndefined();
    expect(prefs.character_depth).toBeUndefined();
    expect(prefs.note).toBeUndefined();
  });

  it('creativePreferencesSchema 部分（任一子集合法——四轴逐域独立，世界深 + 大纲轻并存）', () => {
    const prefs = creativePreferencesSchema.parse({
      outline_depth: 'skeleton',
      world_depth: 'upfront',
      note: '先写第一卷再说'
    });
    expect(prefs.outline_depth).toBe('skeleton');
    expect(prefs.world_depth).toBe('upfront');
    expect(prefs.arc_timing).toBeUndefined();
    expect(prefs.note).toBe('先写第一卷再说');
  });

  it('creativePreferencesSchema 非法轴值拒收（enum 封闭——机械档位值域，非语义分类）', () => {
    expect(creativePreferencesSchema.safeParse({ outline_depth: 'deep' }).success).toBe(false);
    expect(creativePreferencesSchema.safeParse({ arc_timing: 'later' }).success).toBe(false);
    expect(creativePreferencesSchema.safeParse({ world_depth: 'thin' }).success).toBe(false);
    expect(creativePreferencesSchema.safeParse({ character_depth: 'half' }).success).toBe(false);
  });

  it('CR-018（8.6 BMad CR）：note 长度上限 4000（LLM 失控超长直进 project.yaml 拦在 schema 层）', () => {
    expect(creativePreferencesSchema.safeParse({ note: 'x'.repeat(4000) }).success).toBe(true);
    expect(creativePreferencesSchema.safeParse({ note: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('四轴 enum 值域覆盖 design D4 全集', () => {
    expect(outlineDepthAxisSchema.options).toEqual(['skeleton', 'volume', 'chapter']);
    expect(arcTimingAxisSchema.options).toEqual(['upfront', 'as_you_go']);
    expect(worldDepthAxisSchema.options).toEqual(['shell', 'upfront']);
    expect(characterDepthAxisSchema.options).toEqual(['framework', 'full']);
  });

  it('fieldMetadataSchema 校验完整元信息', () => {
    const meta = fieldMetadataSchema.parse({
      version: 3,
      source: 'agent',
      locked: true,
      dependsOn: [{ field: 'outline', version: 2 }],
      stale: false,
      lastSyncedAt: '2026-04-25T00:00:00Z'
    });
    expect(meta.version).toBe(3);
    expect(meta.dependsOn[0].field).toBe('outline');
  });

  it('fieldMetadataSchema 使用默认值', () => {
    const meta = fieldMetadataSchema.parse({ version: 0, source: 'user' });
    expect(meta.locked).toBe(false);
    expect(meta.stale).toBe(false);
    expect(meta.dependsOn).toEqual([]);
  });

  it('creativeBriefSchema 校验创作 brief', () => {
    const brief = creativeBriefSchema.parse({
      genre: '悬疑',
      theme: '救赎',
      tone: '暗黑',
      rawRequirement: '写一个关于侦探的故事'
    });
    expect(brief.rawRequirement).toBe('写一个关于侦探的故事');
    expect(brief.taboos).toEqual([]);
  });

  it('worldSettingSchema 校验世设', () => {
    const ws = worldSettingSchema.parse({
      premise: '近未来赛博朋克城市',
      era: '2077',
      rules: ['AI 不能伤害人类'],
      taboos: ['不涉及真实政治']
    });
    expect(ws.premise).toBe('近未来赛博朋克城市');
    expect(ws.rules).toHaveLength(1);
  });

  it('outlineV2Schema 校验扩展大纲', () => {
    const outline = outlineV2Schema.parse({
      title: '暗城',
      logline: '一个侦探在暗城追查真相',
      central_conflict: '正义与秩序的冲突',
      acts: [{ id: 'act_1', title: '序幕', goal: '引入世界', conflict: '初次遭遇' }],
      major_turning_points: [
        { type: 'core-anchor', label: '发现真相' },
        { type: 'secondary-anchor', label: '背叛', description: '盟友倒戈' }
      ],
      ending_direction: '开放式结局'
    });
    expect(outline.central_conflict).toBe('正义与秩序的冲突');
    expect(outline.major_turning_points).toHaveLength(2);
  });

  it('episodeOutlineSchema 校验集纲', () => {
    const ep = episodeOutlineSchema.parse({
      id: 'ep_1',
      index: 0,
      title: '第一集：暗夜降临',
      purpose: '建立世界观',
      core_event: '主角到达暗城',
      character_progressions: [{ characterId: 'char_1', from: '迷茫', to: '决心' }],
      emotional_beats: ['紧张', '好奇'],
      hook: '神秘信件'
    });
    expect(ep.status).toBe('planned');
    expect(ep.character_progressions).toHaveLength(1);
  });

  it('episodeOutlinesSchema 校验集纲数组', () => {
    const eps = episodeOutlinesSchema.parse([
      { id: 'ep_1', index: 0, title: '第一集' },
      { id: 'ep_2', index: 1, title: '第二集' }
    ]);
    expect(eps).toHaveLength(2);
  });

  it('growthCurveSchema 校验成长曲线', () => {
    const curve = growthCurveSchema.parse({
      character_id: 'char_1',
      start_state: '天真少年',
      wound_or_lack: '失去父亲',
      desire: '复仇',
      need: '放下仇恨',
      turning_points: [{ turning_point: '遇到导师', linked_episode_ids: ['ep_2'] }],
      end_state: '成熟的守护者'
    });
    expect(curve.character_id).toBe('char_1');
    expect(curve.turning_points).toHaveLength(1);
  });

  it('pacingCurveSchema 校验节奏曲线', () => {
    const curve = pacingCurveSchema.parse({
      unit: 'episode',
      points: [
        { refId: 'ep_1', intensity: 3 },
        { refId: 'ep_2', intensity: 7, actionLevel: 8 }
      ],
      target_shape: 'rising',
      risks: ['中段节奏拖沓']
    });
    expect(curve.points).toHaveLength(2);
    expect(curve.target_shape).toBe('rising');
  });

  it('emotionCurveSchema 校验情感曲线（语义为主 + VAD 可选投影）', () => {
    const curve = emotionCurveSchema.parse({
      unit: 'scene',
      points: [
        {
          refId: 'scene_1',
          sceneMood: '压抑',
          sceneVad: { v: -0.6, a: 0.3, d: -0.4 },
          characters: [
            { characterId: 'char_a', emotion: '恐惧', emotionEnd: '忧虑', vad: { v: -0.7, a: 0.8, d: -0.3 } },
            { characterId: 'char_b', emotion: '愤怒' },
          ],
        },
      ],
      emotional_promises: ['正义终将到来'],
      catharsis_points: ['最终对决'],
    });
    expect(curve.points).toHaveLength(1);
    expect(curve.points[0].characters).toHaveLength(2);
    expect(curve.points[0].characters[0].emotionEnd).toBe('忧虑');
    expect(curve.points[0].sceneVad?.d).toBe(-0.4);
    expect(curve.points[0].characters[1].vad).toBeUndefined(); // 可选，未填
    expect(curve.catharsis_points).toHaveLength(1);
  });

  it('emotionPointSchema 旧字段被 zod strip（不兼容，parse 通过非 fail）', () => {
    // 砍掉的旧 point 字段（primaryEmotion/valence/arousal）被 zod object 默认 .strip() 默默删，
    // parse 通过（非 strict fail）——故不需要 loadProject 迁移（design §5）。旧字段语义态被丢，
    // 但 emotion_curve 是 fork 初始遗物无 Closure 真实数据。
    const point = emotionPointSchema.parse({
      refId: 'scene_1',
      primaryEmotion: '好奇', // 旧字段，strip
      valence: 0.3, // 旧字段，strip
    });
    expect(point.refId).toBe('scene_1');
    expect(point.characters).toEqual([]); // default([])
    expect((point as unknown as { primaryEmotion?: string }).primaryEmotion).toBeUndefined(); // strip 掉
  });

  it('vadTripleSchema 范围 -1..1（Mehrabian PAD，越界拒）', () => {
    expect(vadTripleSchema.safeParse({ v: 0.5, a: -0.3, d: 0 }).success).toBe(true);
    expect(vadTripleSchema.safeParse({ v: 1, a: -1, d: 0 }).success).toBe(true); // 边界合法
    expect(vadTripleSchema.safeParse({ v: 1.5, a: 0, d: 0 }).success).toBe(false); // valence 越界
    expect(vadTripleSchema.safeParse({ v: 0, a: -1.2, d: 0 }).success).toBe(false); // arousal 越界
    expect(vadTripleSchema.safeParse({ v: 0, a: 0, d: 2 }).success).toBe(false); // dominance 越界
  });

  it('emotionCharacterSchema vad/vadEnd nullish（CR-002：接受 null，防 LLM 产 null 致整 project parse 失败）', () => {
    // F1 fix（BMad CR Edge F1）：vad/vadEnd/sceneVad 用 .nullish() 非 .optional()（mirror CR-002 nested object 既约）。
    // LLM 产 vad:null 不再 fail（.nullish 接受 undefined+null），防 emotion_curve（projectDocumentSchema 顶层）
    // 一处 vad:null 致整 project parse 失败 → loadProject catch → corrupt 重建空项目。
    const r = emotionCharacterSchema.parse({ characterId: 'c1', emotion: '恐惧', vad: null });
    expect(r.vad).toBeNull();
    const r2 = emotionCharacterSchema.parse({ characterId: 'c1', emotion: '恐惧' });
    expect(r2.vad).toBeUndefined();
    // vad 对象缺 a/d（required）→ reject
    expect(emotionCharacterSchema.safeParse({ characterId: 'c1', emotion: '恐惧', vad: { v: 0.5 } }).success).toBe(false);
  });

  it('emotionPointSchema refId required（missing-refId 拒）+ sceneMood 空串拒（CR-4 负例守门）', () => {
    expect(emotionPointSchema.safeParse({ primaryEmotion: 'x' }).success).toBe(false); // 无 refId
    expect(emotionPointSchema.safeParse({ refId: 's1', sceneMood: '' }).success).toBe(false); // sceneMood 空串
  });

  // D-5.1-4（5.1 CR deferred，owner=5.2 补）：测试盲区——characters 显式传 [] / unit=act+characters 组合 /
  // 旧 secondaryEmotion+arousal+transition strip。5.2 接入 Director 时顺带覆盖（implement Step 10）。
  it('D-5.1-4：characters 显式传 []（非 default 路径）→ 合法（场景氛围-only point）', () => {
    const r = emotionPointSchema.safeParse({ refId: 's1', sceneMood: '压抑', characters: [] });
    expect(r.success).toBe(true);
    expect(r.data?.characters).toEqual([]);
  });

  it('D-5.1-4：emotion_curve unit=act + characters[] 组合（语义由 Director prompt 约束，schema 不耦）', () => {
    // D-5.1-1：5.2 Director 接入定 unit=scene for characters；schema 层 unit 与 characters 不强耦合（宽松），
    // unit=act+characters 在 schema 通过（语义归 prompt 约束非 schema 门禁，避假信心门）。
    const r = emotionCurveSchema.safeParse({
      unit: 'act',
      points: [{ refId: 'a1', characters: [{ characterId: 'c1', emotion: '恐惧' }] }],
    });
    expect(r.success).toBe(true);
  });

  it('D-5.1-4：旧 secondaryEmotion+arousal+transition 组合 strip（不兼容 parse 通过非 fail）', () => {
    const r = emotionPointSchema.safeParse({
      refId: 's1',
      secondaryEmotion: '忧虑', // 旧字段，strip
      arousal: 0.6, // 旧字段，strip
      transition: '恐惧→决心', // 旧字段，strip
      characters: [{ characterId: 'c1', emotion: '恐惧' }],
    });
    expect(r.success).toBe(true);
    expect((r.data as unknown as { secondaryEmotion?: string }).secondaryEmotion).toBeUndefined();
    expect((r.data as unknown as { arousal?: number }).arousal).toBeUndefined();
    expect((r.data as unknown as { transition?: string }).transition).toBeUndefined();
  });

  it('assetCardSchema 校验资产卡', () => {
    const card = assetCardSchema.parse({
      id: 'char_main',
      type: 'character',
      name: '李探长',
      summary: '暗城资深侦探',
      tags: ['主角', '侦探'],
      relationships: [{ targetId: 'char_villain', relationType: 'rivalry' }],
      firstAppearance: 'ep_1',
      status: 'active'
    });
    expect(card.type).toBe('character');
    expect(card.relationships).toHaveLength(1);
  });

  it('assetCardsSchema 校验资产卡数组', () => {
    const cards = assetCardsSchema.parse([
      { id: 'char_1', type: 'character', name: '角色A' },
      { id: 'loc_1', type: 'location', name: '暗城广场' }
    ]);
    expect(cards).toHaveLength(2);
  });

  it('relationshipGraphSchema 校验人物关系网', () => {
    const graph = relationshipGraphSchema.parse({
      nodes: [
        { id: 'n1', assetCardId: 'char_1', label: '李探长', type: 'character' },
        { id: 'n2', assetCardId: 'char_2', label: '王局长', type: 'character' }
      ],
      edges: [
        {
          id: 'e1', from: 'n1', to: 'n2',
          relationType: 'alliance', label: '上下级',
          strength: 7, polarity: 'positive', visibility: 'public'
        }
      ],
      version: 1,
      updatedBy: 'agent'
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges[0].relationType).toBe('alliance');
  });

  it('relationshipGraphSchema 使用默认值', () => {
    const graph = relationshipGraphSchema.parse({});
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.version).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 5.2: EmotionCurve bounded action projector（mirror applyInfoReleaseActions）。
// 范式判据：by-refId 机械投影（覆盖/追加/删）= 纯代码（ADR-3 ✓）；不判情绪语义（归 Director LLM + Reader-Audit）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 5.2 applyEmotionCurveActions（EmotionCurve bounded action 投影，mirror applyInfoReleaseActions）', () => {
  const point = (refId: string, emotion = '恐惧') =>
    emotionPointSchema.parse({ refId, sceneMood: '压抑', characters: [{ characterId: 'c1', emotion }] });
  const emptyCurve = emotionCurveSchema.parse({ unit: 'scene' }); // unit required（无 default），显式给

  it('add_point：新 refId 追加', () => {
    const out = applyEmotionCurveActions(emptyCurve, [{ op: 'add_point', point: point('scene_1') }]);
    expect(out.points).toHaveLength(1);
    expect(out.points[0].refId).toBe('scene_1');
  });

  it('add_point：refId 已存在 → 覆盖（幂等）', () => {
    const out = applyEmotionCurveActions(
      { ...emptyCurve, points: [point('scene_1', '焦虑')] },
      [{ op: 'add_point', point: point('scene_1', '决心') }],
    );
    expect(out.points).toHaveLength(1);
    expect(out.points[0].characters[0].emotion).toBe('决心'); // 覆盖
  });

  it('update_point：refId 已存在 → 覆盖；不存在 → 追加（容错）', () => {
    const out = applyEmotionCurveActions(
      { ...emptyCurve, points: [point('scene_1')] },
      [
        { op: 'update_point', point: point('scene_1', '愤怒') },
        { op: 'update_point', point: point('scene_2', '喜悦') },
      ],
    );
    expect(out.points).toHaveLength(2);
    expect(out.points[0].characters[0].emotion).toBe('愤怒'); // 覆盖
    expect(out.points[1].refId).toBe('scene_2'); // 追加
  });

  it('remove_point：存在 → 删；不存在 → 幂等跳过', () => {
    const out = applyEmotionCurveActions(
      { ...emptyCurve, points: [point('scene_1'), point('scene_2')] },
      [
        { op: 'remove_point', refId: 'scene_1' },
        { op: 'remove_point', refId: '不存在' },
      ],
    );
    expect(out.points).toHaveLength(1);
    expect(out.points[0].refId).toBe('scene_2');
  });

  it('unit/emotional_promises/catharsis_points 透传不动', () => {
    const curve = emotionCurveSchema.parse({
      unit: 'scene',
      emotional_promises: ['正义'],
      catharsis_points: ['对决'],
    });
    const out = applyEmotionCurveActions(curve, [{ op: 'add_point', point: point('scene_1') }]);
    expect(out.unit).toBe('scene');
    expect(out.emotional_promises).toEqual(['正义']);
    expect(out.catharsis_points).toEqual(['对决']);
  });

  it('emotionCurveActionSchema 守门：非法 op / 缺 refId / 缺 point 拒', () => {
    expect(emotionCurveActionSchema.parse({ op: 'remove_point', refId: 'x' }).op).toBe('remove_point');
    expect(() => emotionCurveActionSchema.parse({ op: 'remove_point' })).toThrow(); // 缺 refId
    expect(() => emotionCurveActionSchema.parse({ op: 'add_point', point: { characters: [] } })).toThrow(); // point 缺 refId
    expect(() => emotionCurveActionSchema.parse({ op: 'foo', refId: 'x' })).toThrow(); // 非法 op
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.6 WP9: AssetCard bounded action projector（applyAssetCardActions）
// mirror applySceneGraphActions / applyPromiseActions——纯代码机械 by-id 投影。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 3.6 WP9 applyAssetCardActions（AssetCard bounded action 投影）', () => {
  const character = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    assetCardSchema.parse({ id, type: 'character', name, ...extra });

  it('add_card：追加完整 typed 卡（schema 填 defaults：tags/relationships/status）', () => {
    const out = applyAssetCardActions([], [
      { op: 'add_card', card: character('c1', '阿米娅', { summary: '罗德岛领袖' }) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('c1');
    expect(out[0].name).toBe('阿米娅');
    expect(out[0].tags).toEqual([]); // schema default
  });

  it('add_card 重复 id → 跳过不覆盖（防御 backstop——handler 侧先友好报错）', () => {
    const out = applyAssetCardActions([character('c1', '旧名')], [
      { op: 'add_card', card: character('c1', '新名') },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('旧名'); // 既有卡不动，永不静默替换
  });

  it('update_card：浅合并 patch——未提供字段 + customFields(details) 保留', () => {
    const base = [character('c1', '阿米娅', {
      summary: '旧摘要',
      details: { 战斗风格: '法术' },
      tier: 'core',
    })];
    const out = applyAssetCardActions(base, [
      { op: 'update_card', cardId: 'c1', patch: { summary: '新摘要' } },
    ]);
    expect(out[0].summary).toBe('新摘要');
    expect(out[0].name).toBe('阿米娅'); // 未提供字段保留
    expect((out[0] as { details?: unknown }).details).toEqual({ 战斗风格: '法术' }); // customFields 保留
    expect((out[0] as { tier?: unknown }).tier).toBe('core');
    // 原 cards 不被原地改（纯函数）
    expect(base[0].summary).toBe('旧摘要');
  });

  it('update_card：patch 内 id/type 身份键剥除忽略（mirror promise update_beat E8）', () => {
    const out = applyAssetCardActions([character('c1', '阿米娅')], [
      { op: 'update_card', cardId: 'c1', patch: { id: 'evil', type: 'location', summary: '改摘要' } },
    ]);
    expect(out[0].id).toBe('c1'); // 身份不变
    expect(out[0].type).toBe('character'); // type 不变
    expect(out[0].summary).toBe('改摘要');
  });

  it('update_card：cardId 不存在 → 幂等跳过（mirror promise update_beat）', () => {
    const out = applyAssetCardActions([character('c1', '阿米娅')], [
      { op: 'update_card', cardId: '不存在', patch: { summary: 'x' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBeUndefined();
  });

  it('remove_card：存在 → 删；不存在 → 幂等跳过（mirror promise remove_beat）', () => {
    const out1 = applyAssetCardActions([character('c1', 'A'), character('c2', 'B')], [
      { op: 'remove_card', cardId: 'c1' },
    ]);
    expect(out1).toHaveLength(1);
    expect(out1[0].id).toBe('c2');

    const out2 = applyAssetCardActions(out1, [{ op: 'remove_card', cardId: 'c1' }]);
    expect(out2).toHaveLength(1); // 再删不存在 id 无效果
  });

  it('多 action 顺序投影 + 既有卡保留（策展主场景：研究后补卡）', () => {
    const current = [character('c1', '阿米娅')];
    const out = applyAssetCardActions(current, [
      { op: 'add_card', card: assetCardSchema.parse({ id: 'loc-1', type: 'location', name: '罗德岛' }) },
      { op: 'update_card', cardId: 'c1', patch: { summary: '研究补充' } },
      { op: 'remove_card', cardId: 'loc-1' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('c1');
    expect(out[0].summary).toBe('研究补充');
  });

  it('assetCardActionSchema 守门：非法 op / add 缺 name 拒 / remove 缺 cardId 拒', () => {
    expect(assetCardActionSchema.parse({ op: 'remove_card', cardId: 'x' }).op).toBe('remove_card');
    expect(() => assetCardActionSchema.parse({ op: 'add_card', card: { id: 'c1', type: 'character' } })).toThrow(); // 缺 name
    expect(() => assetCardActionSchema.parse({ op: 'add_card', card: { id: 'c1', type: 'bogus', name: 'X' } })).toThrow(); // 非法 type
    expect(() => assetCardActionSchema.parse({ op: 'remove_card' })).toThrow(); // 缺 cardId
    expect(() => assetCardActionSchema.parse({ op: 'foo' })).toThrow(); // 非法 op
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.5: Promise ledger schema + 派生纯函数 + bounded action projector
// 范式判据：派生态计算 / projector / 迁移 transform = 纯代码（无 LLM）；涌现登记 + 命名归 LLM（Phase D）。
// 派生态（derivedStage / beat.state）不进 schema 存储——消费时纯函数算（NeuroBook 结构不漂移）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 6.5 Promise ledger schema + 派生 + projector', () => {
  it('promiseRegistrySchema 默认空 registry（promises/beats/version/updatedBy）', () => {
    const registry = promiseRegistrySchema.parse({});
    expect(registry.promises).toEqual([]);
    expect(registry.beats).toEqual([]);
    expect(registry.version).toBe(0);
    expect(registry.updatedBy).toBe('agent');
  });

  it('promiseEntrySchema 接受完整 Promise + 默认 status=open / autoFulfill=true / source_type=emergent', () => {
    const promise = promiseEntrySchema.parse({
      id: 'p1',
      title: '国王真面目',
      summary: '读者以为国王是明君，实际是暴君',
      category: 'setup_payoff',
    });
    expect(promise.status).toBe('open');
    expect(promise.importance).toBe(0.5);
    expect(promise.autoFulfill).toBe(true);
    expect(promise.source_type).toBe('emergent');
    expect(promise.tags).toEqual([]);
  });

  it('promiseEntrySchema category 接受词表外自造值（先验非门禁，D4）', () => {
    const promise = promiseEntrySchema.parse({
      id: 'p1',
      title: 'X',
      summary: 'Y',
      category: '自定义分类', // 词表无此项，仍合法
    });
    expect(promise.category).toBe('自定义分类');
  });

  it('promiseEntrySchema 拒绝缺 id / title / summary', () => {
    expect(() => promiseEntrySchema.parse({ title: 'X', summary: 'Y' })).toThrow();
    expect(() => promiseEntrySchema.parse({ id: 'p1', summary: 'Y' })).toThrow();
    expect(() => promiseEntrySchema.parse({ id: 'p1', title: 'X' })).toThrow();
  });

  it('PROMISE_CATEGORY_VOCAB 含 setup_payoff/prophecy/motif/mirror 4 类', () => {
    const values = PROMISE_CATEGORY_VOCAB.map((e) => e.value);
    expect(values).toEqual(['setup_payoff', 'prophecy', 'motif', 'mirror']);
    for (const entry of PROMISE_CATEGORY_VOCAB) {
      expect(typeof entry.gloss).toBe('string');
      expect(entry.gloss.length).toBeGreaterThan(0);
    }
  });

  it('promiseBeatSchema 接受 beat（挂 Scene sceneRef）+ 拒绝缺必填', () => {
    const beat = promiseBeatSchema.parse({
      id: 'b1',
      promiseId: 'p1',
      sceneRef: 'scene_5',
      kind: 'plant',
    });
    expect(beat.kind).toBe('plant');
    expect(() => promiseBeatSchema.parse({ id: 'b1', sceneRef: 's1', kind: 'plant' })).toThrow(); // 缺 promiseId
    expect(() => promiseBeatSchema.parse({ id: 'b1', promiseId: 'p1', kind: 'plant' })).toThrow(); // 缺 sceneRef
  });

  // ── 派生纯函数（消费时算，不存）──

  it('derivePromiseStage 各态：unplanted / planted / echoed / paid_off', () => {
    const promise = promiseEntrySchema.parse({ id: 'p1', title: 'X', summary: 'Y' });
    expect(derivePromiseStage(promise, [])).toBe('unplanted');
    expect(
      derivePromiseStage(
        promise,
        [{ id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' }],
      ),
    ).toBe('planted');
    expect(
      derivePromiseStage(
        promise,
        [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
          { id: 'b2', promiseId: 'p1', sceneRef: 's2', kind: 'advance' },
        ],
      ),
    ).toBe('echoed');
    expect(
      derivePromiseStage(
        promise,
        [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
          { id: 'b2', promiseId: 'p1', sceneRef: 's2', kind: 'setback' },
        ],
      ),
    ).toBe('echoed');
    expect(
      derivePromiseStage(
        promise,
        [
          { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
          { id: 'b2', promiseId: 'p1', sceneRef: 's2', kind: 'payoff' },
        ],
      ),
    ).toBe('paid_off');
  });

  it('derivePromiseStage 按 promiseId 过滤（不混入他 Promise beats）', () => {
    const promise = promiseEntrySchema.parse({ id: 'p1', title: 'X', summary: 'Y' });
    const beats = [
      { id: 'b1', promiseId: 'p2', sceneRef: 's1', kind: 'payoff' }, // 他 Promise
      { id: 'b2', promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
    ] as const;
    expect(derivePromiseStage(promise, beats)).toBe('planted'); // 不受 p2 payoff 影响
  });

  it('deriveBeatState 从 Scene.status 派生 planned/factual/archived', () => {
    expect(deriveBeatState(undefined)).toBe('planned');
    expect(deriveBeatState('draft')).toBe('planned');
    expect(deriveBeatState('active')).toBe('planned');
    expect(deriveBeatState('written')).toBe('factual');
    expect(deriveBeatState('revised')).toBe('factual');
    expect(deriveBeatState('archived')).toBe('archived');
  });

  it('resolvePromiseFulfillment：autoFulfill + payoff → fulfilled；删 payoff → 回退 open', () => {
    const promise = promiseEntrySchema.parse({ id: 'p1', title: 'X', summary: 'Y' });
    // 无 payoff + status=open → open
    expect(resolvePromiseFulfillment(promise, [])).toBe('open');
    // 有 payoff → fulfilled
    expect(
      resolvePromiseFulfillment(promise, [
        { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'payoff' },
      ]),
    ).toBe('fulfilled');
    // 曾 fulfilled + payoff 删 → 回退 open（system.md:208）
    const fulfilled = { ...promise, status: 'fulfilled' as const };
    expect(resolvePromiseFulfillment(fulfilled, [])).toBe('open');
  });

  it('resolvePromiseFulfillment：abandoned 永不自动改 / autoFulfill=false 不自动改', () => {
    const abandoned = promiseEntrySchema.parse({
      id: 'p1', title: 'X', summary: 'Y', status: 'abandoned',
    });
    // abandoned 即使有 payoff 也不改
    expect(
      resolvePromiseFulfillment(abandoned, [
        { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'payoff' },
      ]),
    ).toBe('abandoned');

    const manual = promiseEntrySchema.parse({
      id: 'p2', title: 'X', summary: 'Y', autoFulfill: false,
    });
    // autoFulfill=false → 不自动改（手管）
    expect(
      resolvePromiseFulfillment(manual, [
        { id: 'b1', promiseId: 'p2', sceneRef: 's1', kind: 'payoff' },
      ]),
    ).toBe('open');
  });

  // ── bounded action projector（applyPromiseActions）──

  it('applyPromiseActions：add_promise 追加 + 同 id 覆盖（幂等）', () => {
    const empty = promiseRegistrySchema.parse({});
    const r1 = applyPromiseActions(empty, [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
    ]);
    expect(r1.promises).toHaveLength(1);
    // 同 id 再 add → 覆盖（title 变）
    const r2 = applyPromiseActions(r1, [
      { type: 'add_promise', promise: { id: 'p1', title: 'B', summary: 'Y' } },
    ]);
    expect(r2.promises).toHaveLength(1);
    expect(r2.promises[0].title).toBe('B');
    expect(r2.promises[0].summary).toBe('Y');
  });

  it('applyPromiseActions：add_promise + firstBeat 一起写入', () => {
    const empty = promiseRegistrySchema.parse({});
    const r = applyPromiseActions(empty, [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
    ]);
    expect(r.promises).toHaveLength(1);
    expect(r.beats).toHaveLength(1);
    expect(r.beats[0].promiseId).toBe('p1');
    expect(r.beats[0].kind).toBe('plant');
    // beat id 自然键生成（promiseId::sceneRef）
    expect(r.beats[0].id).toBe('p1::s1');
  });

  it('applyPromiseActions：add_beat 幂等——同 (promiseId, sceneRef) 一 beat 覆盖 kind', () => {
    const withPromise = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
    ]);
    // 首次 plant
    const r1 = applyPromiseActions(withPromise, [
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' } },
    ]);
    expect(r1.beats).toHaveLength(1);
    expect(r1.beats[0].kind).toBe('plant');
    // 同 (p1, s1) 再 add advance → 覆盖 kind（不新增 beat），id 保留
    const r2 = applyPromiseActions(r1, [
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'advance' } },
    ]);
    expect(r2.beats).toHaveLength(1);
    expect(r2.beats[0].kind).toBe('advance');
    expect(r2.beats[0].id).toBe('p1::s1'); // id 保留
  });

  it('applyPromiseActions：add_beat 不同 scene → 各自一 beat（不互相覆盖）', () => {
    const withPromise = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
    ]);
    const r = applyPromiseActions(withPromise, [
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' } },
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's2', kind: 'payoff' } },
    ]);
    expect(r.beats).toHaveLength(2);
  });

  it('applyPromiseActions：同 actions 双投影幂等（链流程重排 W3——同章重跑 E 段 promise_ledger_update 无重复登记）', () => {
    // E 段（E4 promise-emergence → promise_ledger_update）重跑场景（redo 到链尾 / re-extract-chapter）：
    // 同章同 actions 二次投影后 registry 逐字段相等——add_promise 同 id partial-merge 覆盖 +
    // add_beat 自然键（promiseId::sceneRef / id）upsert + resolvePromiseFulfillment 稳定派生，
    // 三者共同保证不累积重复登记（W0-2 结论回归锚）。
    const actions = [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: '密信', summary: '读者债' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's2', kind: 'payoff' } },
    ] as const;
    const first = applyPromiseActions(promiseRegistrySchema.parse({}), [...actions]);
    const second = applyPromiseActions(first, [...actions]);
    expect(second.promises).toHaveLength(1);
    expect(second.beats).toHaveLength(2);
    expect(second.beats.map((b) => b.id).sort()).toEqual(first.beats.map((b) => b.id).sort());
    // 双投影后 status 派生稳定（payoff 在 → fulfilled 不翻转不重复）。
    expect(second.promises[0].status).toBe(first.promises[0].status);
  });

  it('applyPromiseActions：update_beat 浅合并 patch（保留 id）', () => {
    const base = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
    ]);
    const beatId = base.beats[0].id;
    const r = applyPromiseActions(base, [
      { type: 'update_beat', beatId, patch: { note: '只写到发烫，不发光' } },
    ]);
    expect(r.beats[0].note).toBe('只写到发烫，不发光');
    expect(r.beats[0].kind).toBe('plant'); // 未改字段保留
    expect(r.beats[0].id).toBe(beatId); // id 保留
  });

  it('applyPromiseActions：update_beat beatId 不存在 → 幂等跳过', () => {
    const base = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
    ]);
    const r = applyPromiseActions(base, [
      { type: 'update_beat', beatId: 'nonexistent', patch: { note: 'x' } },
    ]);
    expect(r.beats).toEqual([]); // 无 beat，幂等
  });

  it('applyPromiseActions：remove_promise 级联删其 beats', () => {
    const base = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
      { type: 'add_promise', promise: { id: 'p2', title: 'B', summary: 'Y' } },
    ]);
    expect(base.beats).toHaveLength(1);
    const r = applyPromiseActions(base, [{ type: 'remove_promise', promiseId: 'p1' }]);
    expect(r.promises).toHaveLength(1);
    expect(r.promises[0].id).toBe('p2');
    expect(r.beats).toEqual([]); // p1 的 beat 级联删
  });

  it('applyPromiseActions：remove_beat 幂等（不存在跳过）', () => {
    const base = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
    ]);
    const r1 = applyPromiseActions(base, [{ type: 'remove_beat', beatId: 'p1::s1' }]);
    expect(r1.beats).toEqual([]);
    // 再删不存在的 beat → 幂等
    const r2 = applyPromiseActions(r1, [{ type: 'remove_beat', beatId: 'p1::s1' }]);
    expect(r2.beats).toEqual([]);
  });

  it('promiseActionSchema 接受所有 5 ops（discriminated union 完整）', () => {
    const ops = [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' } },
      { type: 'update_beat', beatId: 'b1', patch: { note: 'x' } },
      { type: 'remove_promise', promiseId: 'p1' },
      { type: 'remove_beat', beatId: 'b1' },
    ] as const;
    for (const a of ops) {
      expect(() => promiseActionSchema.parse(a)).not.toThrow();
    }
  });

  it('promiseActionSchema add_promise 拒绝缺 id（promise.id 必填，LLM 语义决策）', () => {
    expect(() =>
      promiseActionSchema.parse({
        type: 'add_promise',
        promise: { title: 'A', summary: 'X' }, // 缺 id
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.5 BMad CR group 1 fixes（shared-contracts：projector + schema）
// B1/E2/A6（add_promise partial merge）+ B2/E4/A3（resolvePromiseFulfillment wire）+
// E10（migrated_foreshadow 不 auto-rollback）+ E7（firstBeat promiseId optional）+ E8（update_beat identity strip）。
// 范式红线：projector / 派生 sync = 纯代码机械映射，无 LLM 语义。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 6.5 BMad CR group 1 fixes（projector + schema）', () => {
  // ════════════════════════════════════════════════════════════════════════════
  // B1/E2/A6：add_promise 对现已有 ID 用 partial merge——真实字段不被 defaults 覆盖
  // ════════════════════════════════════════════════════════════════════════════

  it('B1/E2/A6：add_promise 对现已有 ID 用 partial merge——真实字段不被 defaults 覆盖', () => {
    // autoFulfill=false 隔离 B2 sync——status 保留纯由 partial merge（B1）保证，非 B2 sync。
    const base = promiseRegistrySchema.parse({
      promises: [{
        id: 'p1', title: '原标题', summary: '原摘要',
        status: 'fulfilled',
        importance: 0.9,
        tags: ['关键', '主线'],
        source_type: 'manual',
        autoFulfill: false,
        related_asset_ids: ['asset_x'],
        related_promise_ids: ['p2'],
        sourceRefs: ['ref1'],
      }],
      beats: [],
    });
    // 部分 payload（只 id/title/summary）——不应覆盖真实字段
    const r = applyPromiseActions(base, [
      { type: 'add_promise', promise: { id: 'p1', title: '新标题', summary: '新摘要' } },
    ]);
    expect(r.promises).toHaveLength(1);
    expect(r.promises[0].title).toBe('新标题');           // 显式提供 → 覆盖
    expect(r.promises[0].summary).toBe('新摘要');         // 显式提供 → 覆盖
    expect(r.promises[0].status).toBe('fulfilled');       // 未提供 → 保留（不回退 default 'open'）
    expect(r.promises[0].importance).toBe(0.9);           // 未提供 → 保留（不回退 default 0.5）
    expect(r.promises[0].tags).toEqual(['关键', '主线']);  // 未提供 → 保留（不回退 default []）
    expect(r.promises[0].source_type).toBe('manual');     // 未提供 → 保留（不回退 default 'emergent'）
    expect(r.promises[0].autoFulfill).toBe(false);        // 未提供 → 保留（不回退 default true）
    expect(r.promises[0].related_asset_ids).toEqual(['asset_x']);  // 保留（不回退 default []）
    expect(r.promises[0].related_promise_ids).toEqual(['p2']);     // 保留
    expect(r.promises[0].sourceRefs).toEqual(['ref1']);            // 保留
  });

  it('B1：新 Promise（idx<0）仍填 defaults（partial merge 仅对现已有 ID）', () => {
    const empty = promiseRegistrySchema.parse({});
    const r = applyPromiseActions(empty, [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
    ]);
    expect(r.promises[0].status).toBe('open');          // default 填充（新 Promise）
    expect(r.promises[0].importance).toBe(0.5);         // default 填充
    expect(r.promises[0].tags).toEqual([]);             // default 填充
    expect(r.promises[0].source_type).toBe('emergent'); // default 填充
    expect(r.promises[0].autoFulfill).toBe(true);       // default 填充
  });

  it('B1：add_promise 同 id 覆盖时显式提供 undefined 值的字段不回退（仅提供 title/summary）', () => {
    // 既有 Promise + 部分 payload（只改 title，不改 summary）——summary 应保留旧值
    const base = promiseRegistrySchema.parse({
      promises: [{
        id: 'p1', title: '旧标题', summary: '旧摘要', autoFulfill: false,
      }],
    });
    const r = applyPromiseActions(base, [
      { type: 'add_promise', promise: { id: 'p1', title: '新标题', summary: '旧摘要' } },
    ]);
    expect(r.promises[0].title).toBe('新标题');
    expect(r.promises[0].summary).toBe('旧摘要'); // 保留
  });

  // ════════════════════════════════════════════════════════════════════════════
  // B2/E4/A3：wire resolvePromiseFulfillment——应用 actions 后 sync 存储态与 beats
  // ════════════════════════════════════════════════════════════════════════════

  it('B2/E4/A3：add_beat kind=payoff → promise status 自动 flip fulfilled（wire autoFulfill）', () => {
    const withPromise = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
    ]);
    expect(withPromise.promises[0].status).toBe('open');
    const r = applyPromiseActions(withPromise, [
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'payoff' } },
    ]);
    expect(r.promises[0].status).toBe('fulfilled'); // autoFulfill wire → flip
  });

  it('B2：remove_beat 删 payoff → status 回退 open（auto-rollback，system.md:208）', () => {
    const fulfilled = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X' } },
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'payoff' } },
    ]);
    expect(fulfilled.promises[0].status).toBe('fulfilled');
    const r = applyPromiseActions(fulfilled, [
      { type: 'remove_beat', beatId: 'p1::s1' },
    ]);
    expect(r.promises[0].status).toBe('open'); // payoff 删 → 回退
  });

  it('B2：autoFulfill=false → add payoff 不自动 flip（手管）', () => {
    const manual = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X', autoFulfill: false } },
    ]);
    const r = applyPromiseActions(manual, [
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'payoff' } },
    ]);
    expect(r.promises[0].status).toBe('open'); // autoFulfill=false → 不自动改
  });

  it('B2：abandoned Promise 即使 add payoff 也永不自动改', () => {
    const abandoned = applyPromiseActions(promiseRegistrySchema.parse({}), [
      { type: 'add_promise', promise: { id: 'p1', title: 'A', summary: 'X', status: 'abandoned' } },
    ]);
    const r = applyPromiseActions(abandoned, [
      { type: 'add_beat', beat: { promiseId: 'p1', sceneRef: 's1', kind: 'payoff' } },
    ]);
    expect(r.promises[0].status).toBe('abandoned'); // abandoned 永不自动改
  });

  it('B2：add_promise + firstBeat payoff → 一步到位 fulfilled', () => {
    const r = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'payoff' },
      },
    ]);
    expect(r.promises[0].status).toBe('fulfilled'); // firstBeat payoff → sync flip
  });

  // ════════════════════════════════════════════════════════════════════════════
  // E10：迁移期 Promise（migrated_foreshadow）fulfilled 无 payoff → 不 auto-rollback
  // ════════════════════════════════════════════════════════════════════════════

  it('E10：resolvePromiseFulfillment migrated_foreshadow fulfilled 无 payoff → 保留 fulfilled', () => {
    const migrated = promiseEntrySchema.parse({
      id: 'p1', title: 'X', summary: 'Y',
      status: 'fulfilled',
      source_type: 'migrated_foreshadow',
    });
    expect(resolvePromiseFulfillment(migrated, [])).toBe('fulfilled'); // 不回退 open
  });

  it('E10：applyPromiseActions sync 不回退 migrated fulfilled（迁移 status 保留）', () => {
    const withMigrated = promiseRegistrySchema.parse({
      promises: [{
        id: 'p1', title: 'X', summary: 'Y',
        status: 'fulfilled',
        source_type: 'migrated_foreshadow',
      }],
      beats: [],
    });
    // 跑一个无关 action 触发 sync——不应回退 p1 的 fulfilled
    const r = applyPromiseActions(withMigrated, [
      { type: 'add_promise', promise: { id: 'p2', title: 'B', summary: 'Z' } },
    ]);
    const p1 = r.promises.find((p) => p.id === 'p1')!;
    expect(p1.status).toBe('fulfilled'); // 不回退 open
  });

  it('E10：非迁移 Promise fulfilled 无 payoff → 仍回退 open（rollback 仅对迁移豁免）', () => {
    const emergent = promiseEntrySchema.parse({
      id: 'p1', title: 'X', summary: 'Y',
      status: 'fulfilled',
      source_type: 'emergent',
    });
    expect(resolvePromiseFulfillment(emergent, [])).toBe('open');
  });

  it('E10：migrated_foreshadow 有 payoff beat → 仍判 fulfilled（payoff 优先于迁移豁免）', () => {
    const migrated = promiseEntrySchema.parse({
      id: 'p1', title: 'X', summary: 'Y',
      status: 'open',
      source_type: 'migrated_foreshadow',
    });
    expect(
      resolvePromiseFulfillment(migrated, [
        { id: 'b1', promiseId: 'p1', sceneRef: 's1', kind: 'payoff' },
      ]),
    ).toBe('fulfilled'); // 有 payoff → fulfilled（迁移豁免仅在无 payoff 的 rollback 路径）
  });

  // ════════════════════════════════════════════════════════════════════════════
  // E7：add_promise firstBeat 缺 promiseId → 仍 valid
  // ════════════════════════════════════════════════════════════════════════════

  it('E7：promiseActionSchema 接受 add_promise firstBeat 缺 promiseId', () => {
    expect(() => promiseActionSchema.parse({
      type: 'add_promise',
      promise: { id: 'p1', title: 'A', summary: 'X' },
      firstBeat: { sceneRef: 's1', kind: 'plant' }, // 缺 promiseId
    })).not.toThrow();
  });

  it('E7：applyPromiseActions add_promise firstBeat 缺 promiseId → normalizeBeat 填 promise.id', () => {
    const r = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { sceneRef: 's1', kind: 'plant' }, // 缺 promiseId
      },
    ]);
    expect(r.beats).toHaveLength(1);
    expect(r.beats[0].promiseId).toBe('p1'); // normalizeBeat 用 promise.id 覆盖
    expect(r.beats[0].sceneRef).toBe('s1');
    expect(r.beats[0].id).toBe('p1::s1');
  });

  it('E7：add_beat 仍要求 promiseId（firstBeat 放宽不影响 add_beat）', () => {
    expect(() => promiseActionSchema.parse({
      type: 'add_beat',
      beat: { sceneRef: 's1', kind: 'plant' }, // 缺 promiseId
    })).toThrow();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // E8：update_beat patch 剥除 identity 字段（id/promiseId/sceneRef）
  // ════════════════════════════════════════════════════════════════════════════

  it('E8：update_beat patch 经 schema parse 剥除 identity 字段（id/promiseId/sceneRef）', () => {
    const parsed = promiseActionSchema.parse({
      type: 'update_beat',
      beatId: 'b1',
      patch: { note: 'x', promiseId: 'p_OTHER', sceneRef: 's_OTHER', id: 'b_OTHER' },
    });
    if (parsed.type === 'update_beat') {
      expect(parsed.patch).not.toHaveProperty('promiseId');
      expect(parsed.patch).not.toHaveProperty('sceneRef');
      expect(parsed.patch).not.toHaveProperty('id');
      expect(parsed.patch.note).toBe('x'); // 非 identity 字段保留
    }
  });

  it('E8：raw update_beat patch 含 identity → 经 parse strip + projector identity 不变', () => {
    const base = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
    ]);
    const beatId = base.beats[0].id;
    // raw action 含 identity 字段（模拟 LLM 直出未经 TS 类型检查）。
    // handler 信任边界：promiseActionSchema.parse strip identity（E8 schema omit）。
    const parsed = promiseActionSchema.parse({
      type: 'update_beat',
      beatId,
      patch: { note: '新note', promiseId: 'p_OTHER', sceneRef: 's_OTHER' },
    });
    // projector 收到 clean patch → identity 不变
    const r = applyPromiseActions(base, [parsed]);
    expect(r.beats[0].note).toBe('新note');
    expect(r.beats[0].promiseId).toBe('p1');  // identity 不变
    expect(r.beats[0].sceneRef).toBe('s1');   // identity 不变
    expect(r.beats[0].id).toBe(beatId);
  });

  it('E8：update_beat patch 改 kind 合法（kind 非 identity，可推进 plant→advance）', () => {
    const base = applyPromiseActions(promiseRegistrySchema.parse({}), [
      {
        type: 'add_promise',
        promise: { id: 'p1', title: 'A', summary: 'X' },
        firstBeat: { promiseId: 'p1', sceneRef: 's1', kind: 'plant' },
      },
    ]);
    const r = applyPromiseActions(base, [
      { type: 'update_beat', beatId: base.beats[0].id, patch: { kind: 'advance' } },
    ]);
    expect(r.beats[0].kind).toBe('advance'); // kind 可改
  });
});

describe('scene_graph schema (Story 1.1)', () => {
  it('sceneGraphSchema 校验完整 scene-graph（nodes/edges/lines + 双坐标 + 锚点）', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        {
          id: 'scene_1',
          lineTags: ['line_main'],
          episodeId: 'ep_1',
          storyTime: 1,
          storyTimeLabel: '第一天清晨',
          presentationOrder: { chapter: 1, pos: 0 },
          role: 'normal',
          actRef: 'act_1'
        },
        {
          id: 'scene_2',
          lineTags: ['line_main', 'line_sub'],
          storyTime: 2,
          presentationOrder: { chapter: 1, pos: 1 },
          role: 'core-anchor'
        }
      ],
      edges: [
        { id: 'edge_1', from: 'scene_1', to: 'scene_2', type: 'CAUSAL' }
      ],
      lines: [
        {
          id: 'line_main',
          name: '主线',
          topology_role: 'converging',
          convergence_target: 'scene_2',
          story_time_span: { start: 1, end: 2 }
        },
        {
          id: 'line_sub',
          name: '支线',
          topology_role: 'parallel-worldview',
          worldEventRef: 'event_alien_invasion'
        }
      ],
      version: 1,
      updatedBy: 'user'
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[1].role).toBe('core-anchor');
    expect(graph.edges[0].type).toBe('CAUSAL');
    expect(graph.lines[0].topology_role).toBe('converging');
    expect(graph.lines[1].worldEventRef).toBe('event_alien_invasion');
  });

  it('sceneGraphSchema 空 graph 使用默认值', () => {
    const graph = sceneGraphSchema.parse({});
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.lines).toEqual([]);
    expect(graph.version).toBe(0);
    expect(graph.updatedBy).toBe('agent');
  });

  it('sceneNodeSchema 拒绝缺 id / 非法 role / 负 storyTime', () => {
    expect(() => sceneNodeSchema.parse({
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    })).toThrow();
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      role: 'invalid-role'
    })).toThrow();
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: -1,
      presentationOrder: { chapter: 0, pos: 0 }
    })).toThrow();
  });

  it('sceneEdgeSchema 拒绝非法 type / 空 from|to', () => {
    expect(() => sceneEdgeSchema.parse({
      id: 'e1', from: 's1', to: 's2', type: 'INVALID'
    })).toThrow();
    expect(() => sceneEdgeSchema.parse({
      id: 'e1', from: '', to: 's2', type: 'CAUSAL'
    })).toThrow();
  });

  it('sceneLineSchema 拒绝非法 topology_role', () => {
    expect(() => sceneLineSchema.parse({
      id: 'l1', name: '主线', topology_role: 'invalid'
    })).toThrow();
  });

  it('sceneNode role 默认 normal + lineTags 默认空数组', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    });
    expect(node.role).toBe('normal');
    expect(node.lineTags).toEqual([]);
  });

  it('sceneLine topology_role/displacement/visibility 默认值', () => {
    const line = sceneLineSchema.parse({
      id: 'l1',
      name: '主线'
    });
    expect(line.topology_role).toBe('converging');
    expect(line.displacement).toBe('none');
    expect(line.visibility).toEqual({ status: 'open' });
  });

  it('projectFieldPatchSchema 支持 field:scene_graph patch（D5 自动支持）', () => {
    const patch = projectFieldPatchSchema.parse({
      runId: 'run_1',
      createdAt: '2026-07-25T00:00:00Z',
      patches: [
        {
          field: 'scene_graph',
          action: 'set',
          data: { nodes: [], edges: [], lines: [] },
          fieldVersion: 1,
          generatedBy: 'story-planner-agent'
        }
      ]
    });
    expect(patch.patches[0].field).toBe('scene_graph');
  });
});

describe('Story 1.2 schema additions', () => {
  describe('major_turning_points typed anchors', () => {
    it('接受 typed 锚点（core-anchor / secondary-anchor / fork-point）', () => {
      const outline = outlineV2Schema.parse({
        major_turning_points: [
          { type: 'core-anchor', label: '决战少林' },
          { type: 'secondary-anchor', label: '客栈交锋', description: '主角首次遭遇反派' },
          { type: 'fork-point', label: '生死抉择' }
        ]
      });
      expect(outline.major_turning_points).toHaveLength(3);
      expect(outline.major_turning_points[0].type).toBe('core-anchor');
      expect(outline.major_turning_points[1].description).toBe('主角首次遭遇反派');
    });

    it('major_turning_points 默认空数组', () => {
      const outline = outlineV2Schema.parse({});
      expect(outline.major_turning_points).toEqual([]);
    });

    it('拒绝缺 type 的锚点', () => {
      expect(() => majorTurningPointSchema.parse({ label: '决战' })).toThrow();
    });

    it('拒绝缺 label 的锚点', () => {
      expect(() => majorTurningPointSchema.parse({ type: 'core-anchor' })).toThrow();
    });

    it('拒绝 normal type（转折点恒为锚点）', () => {
      expect(() => majorTurningPointSchema.parse({ type: 'normal', label: 'x' })).toThrow();
      expect(() => majorTurningPointTypeSchema.parse('normal')).toThrow();
    });

    it('拒绝旧 string 形态（升级非零迁移）', () => {
      expect(() => outlineV2Schema.parse({
        major_turning_points: ['发现真相']
      })).toThrow();
    });
  });

  describe('lineVisibility discriminated union (CR-004)', () => {
    it('status:open 接受', () => {
      const v = lineVisibilitySchema.parse({ status: 'open' });
      expect(v.status).toBe('open');
    });

    it('status:hidden-until 带 target 接受', () => {
      const v = lineVisibilitySchema.parse({ status: 'hidden-until', target: 'scene_anchor_3' });
      expect(v.status).toBe('hidden-until');
      expect((v as { target: string }).target).toBe('scene_anchor_3');
    });

    it('status:hidden-until 缺 target 拒绝', () => {
      expect(() => lineVisibilitySchema.parse({ status: 'hidden-until' })).toThrow();
    });

    it('缺省时默认 {status:"open"}', () => {
      const line = sceneLineSchema.parse({ id: 'l1', name: '暗线' });
      expect(line.visibility).toEqual({ status: 'open' });
    });

    it('拒绝旧 placeholder 字面量 hidden-until-X', () => {
      expect(() => lineVisibilitySchema.parse('hidden-until-X')).toThrow();
    });

    it('sceneLine 接受 hidden-until 暗线', () => {
      const line = sceneLineSchema.parse({
        id: 'l_dark',
        name: '神秘人线',
        visibility: { status: 'hidden-until', target: 'episode_7_reveal' }
      });
      expect(line.visibility.status).toBe('hidden-until');
    });
  });

  describe('Line Thread 模型（phase_ref / is_main_thread，§3.8）', () => {
    it('接受 phase_ref + is_main_thread', () => {
      const line = sceneLineSchema.parse({
        id: 'l_main',
        name: '主线',
        phase_ref: 'phase-1',
        is_main_thread: true
      });
      expect(line.phase_ref).toBe('phase-1');
      expect(line.is_main_thread).toBe(true);
    });

    it('phase_ref / is_main_thread 默认 undefined（optional）', () => {
      const line = sceneLineSchema.parse({ id: 'l1', name: '支线' });
      expect(line.phase_ref).toBeUndefined();
      expect(line.is_main_thread).toBeUndefined();
    });

    it('sceneGraphSchema 含 Thread 字段的 line 完整 parse', () => {
      const graph = sceneGraphSchema.parse({
        lines: [
          { id: 'l_main', name: '主线', is_main_thread: true, phase_ref: 'phase-1' },
          { id: 'l_sub', name: '支线', phase_ref: 'phase-2' }
        ]
      });
      expect(graph.lines[0].is_main_thread).toBe(true);
      expect(graph.lines[1].phase_ref).toBe('phase-2');
    });
  });

  describe('findDanglingLineTags（lineTags 引用完整性，D5）', () => {
    it('空 graph 返回空数组', () => {
      expect(findDanglingLineTags(sceneGraphSchema.parse({}))).toEqual([]);
    });

    it('所有 lineTags 都解析到 line 时返回空数组', () => {
      const graph = sceneGraphSchema.parse({
        nodes: [
          { id: 's1', lineTags: ['l1', 'l2'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
          { id: 's2', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 } }
        ],
        lines: [
          { id: 'l1', name: '主线' },
          { id: 'l2', name: '支线' }
        ]
      });
      expect(findDanglingLineTags(graph)).toEqual([]);
    });

    it('有 dangling tag 时报告 node + danglingTags', () => {
      const graph = sceneGraphSchema.parse({
        nodes: [
          { id: 's1', lineTags: ['l1', 'ghost'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
          { id: 's2', lineTags: ['ghost', 'phantom'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 } }
        ],
        lines: [{ id: 'l1', name: '主线' }]
      });
      const result = findDanglingLineTags(graph);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ node: 's1', danglingTags: ['ghost'] });
      expect(result[1]).toEqual({ node: 's2', danglingTags: ['ghost', 'phantom'] });
    });

    it('node 无 lineTags 不在结果中', () => {
      const graph = sceneGraphSchema.parse({
        nodes: [
          { id: 's1', lineTags: [], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }
        ],
        lines: []
      });
      expect(findDanglingLineTags(graph)).toEqual([]);
    });
  });

  describe('LINE_VALIDATION_PROFILE（topology_role → 校验 profile 路由声明，D4）', () => {
    const TOPOLOGY_ROLES = ['converging', 'parallel-worldview', 'offline', 'if-branch', 'side'] as const;

    it('5 型 topology_role 全覆盖（exhaustive）', () => {
      for (const role of TOPOLOGY_ROLES) {
        expect(LINE_VALIDATION_PROFILE).toHaveProperty(role);
      }
      expect(Object.keys(LINE_VALIDATION_PROFILE).sort()).toEqual(
        [...TOPOLOGY_ROLES].sort()
      );
    });

    it('converging 要求 mainline reachability，不豁免', () => {
      expect(LINE_VALIDATION_PROFILE['converging']).toEqual({
        mainlineReachability: true,
        meshMapping: false,
        exempt: false
      });
    });

    it('parallel-worldview 要求 mesh mapping，不豁免', () => {
      expect(LINE_VALIDATION_PROFILE['parallel-worldview']).toEqual({
        mainlineReachability: false,
        meshMapping: true,
        exempt: false
      });
    });

    it('offline / if-branch / side 全豁免主线可达性', () => {
      for (const role of ['offline', 'if-branch', 'side'] as const) {
        expect(LINE_VALIDATION_PROFILE[role].exempt).toBe(true);
        expect(LINE_VALIDATION_PROFILE[role].mainlineReachability).toBe(false);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.7: IF 线两型 — schema additions（origin_ref + fork_branch op）
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 1.7 schema additions（IF branch）', () => {
  it('sceneNodeSchema 接受 origin_ref（branch 拷贝指向 canon 源）', () => {
    const node = sceneNodeSchema.parse({
      id: 'scene_1__branch_a',
      storyTime: 5,
      presentationOrder: { chapter: 0, pos: 0 },
      origin_ref: 'scene_1'
    });
    expect(node.origin_ref).toBe('scene_1');
  });

  it('sceneNodeSchema origin_ref 缺省 undefined（canon 节点，零 migration）', () => {
    const node = sceneNodeSchema.parse({
      id: 'scene_1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    });
    expect(node.origin_ref).toBeUndefined();
  });

  it('sceneNodeSchema 拒绝空 origin_ref（min(1)）', () => {
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      origin_ref: ''
    })).toThrow();
  });

  it('sceneGraphActionSchema 接受 fork_branch op（含 branch_line_name）', () => {
    const a = sceneGraphActionSchema.parse({
      op: 'fork_branch',
      fork_from_scene_id: 'fork_pt',
      branch_line_id: 'branch_a',
      branch_line_name: 'IF：主角接受邀请'
    });
    expect(a.op).toBe('fork_branch');
  });

  it('sceneGraphActionSchema fork_branch branch_line_name 可选', () => {
    const a = sceneGraphActionSchema.parse({
      op: 'fork_branch',
      fork_from_scene_id: 'fork_pt',
      branch_line_id: 'branch_a'
    });
    expect(a.op).toBe('fork_branch');
  });

  it('sceneGraphActionSchema fork_branch 拒绝缺 fork_from_scene_id / branch_line_id', () => {
    expect(() => sceneGraphActionSchema.parse({
      op: 'fork_branch',
      branch_line_id: 'branch_a'
    })).toThrow();
    expect(() => sceneGraphActionSchema.parse({
      op: 'fork_branch',
      fork_from_scene_id: 'fork_pt'
    })).toThrow();
  });

  it('sceneGraphActionSchema fork_branch 拒绝空 fork_from_scene_id（min(1)）', () => {
    expect(() => sceneGraphActionSchema.parse({
      op: 'fork_branch',
      fork_from_scene_id: '',
      branch_line_id: 'branch_a'
    })).toThrow();
  });

  it('旧 graph（无 origin_ref、无 fork_branch）仍 schema-valid（回归：零 migration）', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's2', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 } }
      ],
      edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    expect(graph.nodes.every((n) => n.origin_ref === undefined)).toBe(true);
  });

  it('sceneGraphActionSchema 仍接受既有 8 ops（fork_branch 不破坏 discriminated union）', () => {
    const ops = [
      { op: 'add_scene', scene: { id: 's1' } },
      { op: 'update_scene', scene: { id: 's1', storyTime: 2 } },
      { op: 'remove_scene', id: 's1' },
      { op: 'add_edge', edge: { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' } },
      { op: 'remove_edge', id: 'e1' },
      { op: 'add_line', line: { id: 'l1', name: '主线' } },
      { op: 'update_line', line: { id: 'l1', convergence_target: 's2' } },
      { op: 'remove_line', id: 'l1' }
    ] as const;
    for (const a of ops) {
      expect(() => sceneGraphActionSchema.parse(a)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.8: 场↔章 M:N — presentationSpans schema（§3.8）
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 1.8 schema additions（presentationSpans 场↔章 M:N）', () => {
  it('sceneNodeSchema 接受 presentationSpans 跨章场（2 spans 引用 episode）', () => {
    const node = sceneNodeSchema.parse({
      id: 'scene_court',
      lineTags: ['l_main'],
      storyTime: 5,
      presentationOrder: { chapter: 3, pos: 0 },
      presentationSpans: [
        { episodeId: 'ep_3', pos: 0 },
        { episodeId: 'ep_4', pos: 0 }
      ]
    });
    expect(node.presentationSpans).toHaveLength(2);
    expect(node.presentationSpans![0].episodeId).toBe('ep_3');
    expect(node.presentationSpans![1].pos).toBe(0);
  });

  it('sceneNodeSchema 缺 presentationSpans 仍 valid（向后兼容：单章场 = 1.1 行为）', () => {
    const node = sceneNodeSchema.parse({
      id: 'scene_simple',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    });
    expect(node.presentationSpans).toBeUndefined();
  });

  it('presentationSpanSchema 拒绝空 episodeId / 负 pos / 非整数 pos', () => {
    expect(() => presentationSpanSchema.parse({ episodeId: '', pos: 0 })).toThrow();
    expect(() => presentationSpanSchema.parse({ episodeId: 'ep_1', pos: -1 })).toThrow();
    expect(() => presentationSpanSchema.parse({ episodeId: 'ep_1', pos: 1.5 })).toThrow();
  });

  it('sceneNodeSchema 拒绝 presentationSpans: []（空数组——契约二态外第三态，CR-001/007/008）', () => {
    // [] 不属任何 episode（无意义）；单章场应用 undefined（缺省），跨章场 ≥1 span。
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      presentationSpans: []
    })).toThrow();
  });

  it('sceneNodeSchema 拒绝 span 缺 episodeId / 缺 pos', () => {
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      presentationSpans: [{ pos: 0 }]  // 缺 episodeId
    })).toThrow();
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      presentationSpans: [{ episodeId: 'ep_1' }]  // 缺 pos
    })).toThrow();
  });

  it('sceneGraphSchema 含跨章场节点完整 parse', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        {
          id: 'scene_court',
          lineTags: ['l_main'],
          storyTime: 5,
          presentationOrder: { chapter: 3, pos: 0 },
          presentationSpans: [
            { episodeId: 'ep_3', pos: 0 },
            { episodeId: 'ep_4', pos: 2 }
          ],
          role: 'normal'
        }
      ],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging' }]
    });
    expect(graph.nodes[0].presentationSpans).toHaveLength(2);
  });

  it('旧 graph（无 presentationSpans）仍 schema-valid（回归：零 migration）', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's2', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 } }
      ],
      edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    expect(graph.nodes.every((n) => n.presentationSpans === undefined)).toBe(true);
  });

  it('presentationOrder / episodeId 保留不变（presentationSpans 是新增 optional，不替换）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      episodeId: 'ep_1',
      storyTime: 3,
      presentationOrder: { chapter: 1, pos: 2 },
      presentationSpans: [{ episodeId: 'ep_1', pos: 2 }, { episodeId: 'ep_2', pos: 0 }]
    });
    expect(node.episodeId).toBe('ep_1');
    expect(node.presentationOrder).toEqual({ chapter: 1, pos: 2 });
    expect(node.presentationSpans).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.9: 叙事枚举 — outcomeType / pacingRole（SceneNode）+ mice_type（Line）
// 语义型枚举（D1 自由值 + 词表先验非门禁，非 closed z.enum）。零 migration（optional additive）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 1.9 schema additions（叙事枚举 outcomeType/pacingRole/mice_type）', () => {
  it('sceneNodeSchema 接受 outcomeType + pacingRole（自由值，词表外也合法）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      lineTags: ['l_main'],
      storyTime: 1,
      presentationOrder: { chapter: 0, pos: 0 },
      outcomeType: '惨胜',
      pacingRole: '高潮'
    });
    expect(node.outcomeType).toBe('惨胜');
    expect(node.pacingRole).toBe('高潮');
  });

  it('sceneNodeSchema 接受词表外的自造值（先验非门禁，D1 核心）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      outcomeType: '双输',           // 词表无此项，但仍合法（先验非门禁）
      pacingRole: '缓冲转折'         // 词表无此项
    });
    expect(node.outcomeType).toBe('双输');
    expect(node.pacingRole).toBe('缓冲转折');
  });

  it('sceneNodeSchema outcomeType / pacingRole 缺省 undefined（optional，零 migration）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    });
    expect(node.outcomeType).toBeUndefined();
    expect(node.pacingRole).toBeUndefined();
  });

  it('sceneNodeSchema 接受空字符串 outcomeType / pacingRole（自由 string，非 min(1)）', () => {
    // 注意：outcomeType/pacingRole 是 z.string().optional()（非 min(1)）——语义归 LLM，纯代码不设门槛。
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      outcomeType: '',
      pacingRole: ''
    });
    expect(node.outcomeType).toBe('');
    expect(node.pacingRole).toBe('');
  });

  it('sceneLineSchema 接受 mice_type（自由值，D2 挂线）', () => {
    const line = sceneLineSchema.parse({
      id: 'l_main',
      name: '主线',
      mice_type: '观念'
    });
    expect(line.mice_type).toBe('观念');
  });

  it('sceneLineSchema 接受词表外的自造 mice_type（先验非门禁）', () => {
    const line = sceneLineSchema.parse({
      id: 'l_x',
      name: '复合线',
      mice_type: '观念×角色双螺旋'  // 词表外精确值
    });
    expect(line.mice_type).toBe('观念×角色双螺旋');
  });

  it('sceneLineSchema mice_type 缺省 undefined（optional，零 migration）', () => {
    const line = sceneLineSchema.parse({ id: 'l1', name: '支线' });
    expect(line.mice_type).toBeUndefined();
  });

  it('mice_type 与 topology_role 正交共存（一机械一语义，同一线两维度）', () => {
    const line = sceneLineSchema.parse({
      id: 'l1',
      name: '悬疑主线',
      topology_role: 'converging',   // 机械型（封闭 enum，驱动校验路由）
      mice_type: '观念'               // 语义型（开放 + 词表）
    });
    expect(line.topology_role).toBe('converging');
    expect(line.mice_type).toBe('观念');
  });

  it('sceneGraphSchema 含三新字段完整 parse', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        {
          id: 's1',
          lineTags: ['l_main'],
          storyTime: 1,
          presentationOrder: { chapter: 0, pos: 0 },
          role: 'normal',
          outcomeType: '反转',
          pacingRole: '推进'
        }
      ],
      lines: [{ id: 'l_main', name: '主线', topology_role: 'converging', mice_type: '事件' }]
    });
    expect(graph.nodes[0].outcomeType).toBe('反转');
    expect(graph.nodes[0].pacingRole).toBe('推进');
    expect(graph.lines[0].mice_type).toBe('事件');
  });

  it('旧 graph（无三新字段）仍 schema-valid（回归：零 migration）', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
        { id: 's2', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 1 } }
      ],
      edges: [{ id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' }],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    expect(graph.nodes.every((n) => n.outcomeType === undefined && n.pacingRole === undefined)).toBe(true);
    expect(graph.lines.every((l) => l.mice_type === undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4: scene.assetRefs（D6 涟漪 reverse-ref 锚点）
// - additive optional 零 migration（旧 graph 无此字段仍 valid）
// - 填充归 LLM（ADR-3：这场涉及哪些设定卡是语义判断）
// - bounded action add_scene/update_scene 自动支持（sceneNodeSchema.partial()）
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 3.4 schema additions（assetRefs 场↔设定 reverse-ref）', () => {
  it('sceneNodeSchema 接受 assetRefs（asset_card id 列表）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      lineTags: ['l_main'],
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      assetRefs: ['char_hero', 'loc_tavern', 'prop_sword']
    });
    expect(node.assetRefs).toEqual(['char_hero', 'loc_tavern', 'prop_sword']);
  });

  it('sceneNodeSchema assetRefs 缺省 undefined（optional，零 migration）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    });
    expect(node.assetRefs).toBeUndefined();
  });

  it('sceneNodeSchema 拒绝 assetRefs 含空字符串（min(1) per item）', () => {
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      assetRefs: ['valid_id', '']
    })).toThrow();
  });

  it('sceneNodeSchema 接受 assetRefs 空数组（零元素合法，消费者 ?? [] 归一）', () => {
    // assetRefs 是 z.array().optional() 非 .min(1)——空数组（= 不涉及设定卡）是合法值，
    // 区别于 presentationSpans 的二态契约（那里空 [] 无意义被拒）。
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      assetRefs: []
    });
    expect(node.assetRefs).toEqual([]);
  });

  it('旧 graph（无 assetRefs）仍 schema-valid（回归：零 migration）', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }
      ],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    expect(graph.nodes[0].assetRefs).toBeUndefined();
  });

  it('add_scene bounded action 接受 assetRefs（sceneNodeSchema.partial() 透传）', () => {
    const action = sceneGraphActionSchema.parse({
      op: 'add_scene',
      scene: {
        id: 's_new',
        assetRefs: ['char_hero']
      }
    });
    expect(action.op).toBe('add_scene');
    if (action.op === 'add_scene') {
      expect(action.scene.assetRefs).toEqual(['char_hero']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 批次0（阅读缺失1）：SceneNode.title/summary——场景人类标题与内容摘要。
// - additive optional 零 migration（同 outcomeType/pacingRole/assetRefs 先例）
// - .min(1) 同 id 约定（空串无意义拒收；缺省 undefined = 未命名回退 id / 未写摘要）
// - 填充归 LLM/作者（title = 时间线格人类名；summary = AI 补全落点）；手编直写（作者主权）
// ─────────────────────────────────────────────────────────────────────────────
describe('dogfood R2 批次0 schema additions（SceneNode title/summary）', () => {
  it('sceneNodeSchema 接受 title + summary', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      lineTags: ['l_main'],
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      title: '客栈初遇',
      summary: '主角与宿敌在客栈初次交手，埋下信物伏笔。'
    });
    expect(node.title).toBe('客栈初遇');
    expect(node.summary).toBe('主角与宿敌在客栈初次交手，埋下信物伏笔。');
  });

  it('sceneNodeSchema title/summary 缺省 undefined（optional，零 migration）', () => {
    const node = sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 }
    });
    expect(node.title).toBeUndefined();
    expect(node.summary).toBeUndefined();
  });

  it('sceneNodeSchema 拒绝空字符串 title / summary（min(1)，同 id 约定）', () => {
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      title: ''
    })).toThrow();
    expect(() => sceneNodeSchema.parse({
      id: 's1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      summary: ''
    })).toThrow();
  });

  it('旧 graph（无 title/summary）仍 schema-valid（回归：零 migration）', () => {
    const graph = sceneGraphSchema.parse({
      nodes: [
        { id: 's1', lineTags: ['l1'], storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }
      ],
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }]
    });
    expect(graph.nodes[0].title).toBeUndefined();
    expect(graph.nodes[0].summary).toBeUndefined();
  });

  it('add_scene bounded action 接受 title/summary（sceneNodeSchema.partial() 透传）', () => {
    const action = sceneGraphActionSchema.parse({
      op: 'add_scene',
      scene: {
        id: 's_new',
        title: '雨夜追踪'
      }
    });
    expect(action.op).toBe('add_scene');
    if (action.op === 'add_scene') {
      expect(action.scene.title).toBe('雨夜追踪');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.4: 设定字段扩 + typed details
// - 顶层 creative_brief/world_setting 字段（零 migration additive optional）
// - asset_cards 8 类卡 discriminatedUnion（base 公共 + per-type typed + customFields=details）
// - 第 8 类 golden_finger
// - 开放分类（自由值 + 词表先验非封闭 enum）
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 2.4 schema additions（设定字段 + 8 类卡 typed details）', () => {
  // ── 顶层字段 ──
  describe('creativeBriefSchema 顶层设定字段', () => {
    it('接受 genre_tags / shuangdian_preferences（默认空数组）+ commitments / emotion_arc_template / power_system_type', () => {
      const brief = creativeBriefSchema.parse({
        rawRequirement: '写一个修真故事',
        genre_tags: ['玄幻', '爽文', '系统流'],
        commitments: [
          { type: 'HE', content: '主角终成大道' },
          { type: '爽点底线', content: '每章至少一次反转' }
        ],
        emotion_arc_template: '先抑后扬',
        shuangdian_preferences: ['打脸', '装逼'],
        power_system_type: '修炼'
      });
      expect(brief.genre_tags).toEqual(['玄幻', '爽文', '系统流']);
      expect(brief.commitments).toHaveLength(2);
      expect(brief.commitments![0].type).toBe('HE');
      expect(brief.emotion_arc_template).toBe('先抑后扬');
      expect(brief.shuangdian_preferences).toEqual(['打脸', '装逼']);
      expect(brief.power_system_type).toBe('修炼');
    });

    it('缺新字段时仍 valid + 默认值（零 migration backward-compat）', () => {
      const brief = creativeBriefSchema.parse({ rawRequirement: '极简' });
      expect(brief.genre_tags).toEqual([]);
      expect(brief.shuangdian_preferences).toEqual([]);
      // CR-006：commitments 改 .default([])，缺省 [] 非 undefined（与 genre_tags/shuangdian_preferences 一致）
      expect(brief.commitments).toEqual([]);
      expect(brief.emotion_arc_template).toBeUndefined();
      expect(brief.power_system_type).toBeUndefined();
      // 既有字段保留
      expect(brief.taboos).toEqual([]);
    });

    it('CR-006：genre_tags/shuangdian_preferences/commitments 拒空串元素（.min(1)）', () => {
      expect(() => creativeBriefSchema.parse({
        rawRequirement: 'x', genre_tags: ['玄幻', '']
      })).toThrow();
      expect(() => creativeBriefSchema.parse({
        rawRequirement: 'x', shuangdian_preferences: ['']
      })).toThrow();
      expect(() => creativeBriefSchema.parse({
        rawRequirement: 'x', commitments: [{ type: '', content: 'x' }]
      })).toThrow();
      expect(() => creativeBriefSchema.parse({
        rawRequirement: 'x', commitments: [{ type: 'HE', content: '' }]
      })).toThrow();
    });

    it('接受词表外的 power_system_type（先验非门禁）', () => {
      const brief = creativeBriefSchema.parse({
        rawRequirement: 'x',
        power_system_type: '克苏鲁神话体系'  // 词表无此项，仍合法
      });
      expect(brief.power_system_type).toBe('克苏鲁神话体系');
    });

    it('保留既有 loose genre/theme/tone/audience/length（back-compat）', () => {
      const brief = creativeBriefSchema.parse({
        genre: '悬疑', theme: '救赎', tone: '暗黑', audience: '成人', length: '长篇',
        rawRequirement: 'x'
      });
      expect(brief.genre).toBe('悬疑');
      expect(brief.length).toBe('长篇');
    });
  });

  describe('worldSettingSchema world_constitution', () => {
    it('接受 world_constitution（世界 impossible list）', () => {
      const ws = worldSettingSchema.parse({
        premise: '高魔世界',
        world_constitution: ['绝无时间旅行', '死者不能复生']
      });
      expect(ws.world_constitution).toEqual(['绝无时间旅行', '死者不能复生']);
    });

    it('缺 world_constitution 仍 valid（optional，零 migration）', () => {
      const ws = worldSettingSchema.parse({ premise: 'x' });
      expect(ws.world_constitution).toBeUndefined();
    });

    it('旧实体 string[] 字段保留 back-compat（locations/rules/power_structures/taboos/visual_language 不删）', () => {
      const ws = worldSettingSchema.parse({
        locations: [{ id: 'l1', name: '暗城' }],
        rules: ['AI 不能伤害人类'],
        power_structures: ['联邦'],
        taboos: ['不涉真实政治'],
        visual_language: ['冷色调']
      });
      expect(ws.locations).toHaveLength(1);
      expect(ws.rules).toHaveLength(1);
      expect(ws.power_structures).toHaveLength(1);
      expect(ws.taboos).toHaveLength(1);
      expect(ws.visual_language).toHaveLength(1);
    });
  });

  // ── 8 类卡 discriminatedUnion ──
  describe('assetCardTypeSchema 含第 8 类 golden_finger', () => {
    it('assetCardTypeSchema 接受 golden_finger', () => {
      expect(assetCardTypeSchema.parse('golden_finger')).toBe('golden_finger');
    });

    it('assetCardTypeSchema 拒绝非法 type', () => {
      expect(() => assetCardTypeSchema.parse('unknown_type')).toThrow();
    });

    it('8 类 type 全覆盖（exhaustive）', () => {
      const types = ['character', 'location', 'prop', 'organization', 'rule', 'visual_motif', 'lore', 'golden_finger'];
      for (const t of types) {
        expect(() => assetCardTypeSchema.parse(t)).not.toThrow();
      }
    });
  });

  describe('assetCardSchema 8 类卡 typed 引导字段 + customFields', () => {
    it('character 卡：接受 per-type 字段 + details 自由扩展', () => {
      const card = assetCardSchema.parse({
        id: 'char_main',
        type: 'character',
        name: '林动',
        personality: { coreTraits: ['坚韧', '机敏', '重情'], surface: '市井少年', innerTruth: '不甘平庸' },
        desireAndBottomline: { coreDesire: '变强保护家人', coreFear: '无力感', oocAnchors: ['绝不背叛朋友'] },
        abilities: { core: ['吞噬祖符'], cost: '每次吞噬消耗精神力' },
        voice: { speechStyle: '直率带痞气', behaviorStyle: '果断' },
        narrative: { storyFunction: '主角', coreConflict: '平凡vs非凡' },
        writingCheatSheet: { vocabulary: { verbs: ['吞噬', '凝聚'] } },
        details: { customField1: '自由补充', customField2: 42 }  // customFields 自由扩展
      });
      expect(card.type).toBe('character');
      if (card.type === 'character') {
        expect(card.personality?.coreTraits).toEqual(['坚韧', '机敏', '重情']);
        expect(card.desireAndBottomline?.oocAnchors).toEqual(['绝不背叛朋友']);
      }
      expect(card.details).toEqual({ customField1: '自由补充', customField2: 42 });
    });

    it('location 卡：接受 per-type 字段', () => {
      const card = assetCardSchema.parse({
        id: 'loc_1', type: 'location', name: '雷冲秘境',
        basics: { type: '秘境', scale: '方圆百里', region: '大荒山东麓' },
        environment: { terrain: '雷暴荒原', palette: '紫电', moodKeywords: ['压抑', '危险', '狂暴'] },
        ecology: { economy: '雷晶开采', society: '散修聚集', culture: '弱肉强食' },
        history: { origin: '远古雷兽陨落之地', currentSituation: '每甲子开启一次' },
        landmarks: ['雷池', '祖兽骨山']
      });
      expect(card.type).toBe('location');
      if (card.type === 'location') {
        expect(card.environment?.moodKeywords).toHaveLength(3);
        expect(card.landmarks).toHaveLength(2);
      }
    });

    it('prop 卡：接受 per-type 字段', () => {
      const card = assetCardSchema.parse({
        id: 'prop_1', type: 'prop', name: '天罡剑',
        basics: { type: '武器', rarity: '仙器', system: '剑修体系' },
        appearance: { dimensions: '三尺青锋', visual: '寒光凛凛' },
        mechanics: { coreFunction: '斩妖除魔', limitations: '需主人精血温养' },
        value: { economic: '无价', scarcity: '举世唯一' },
        socioCulture: { symbolism: '正道象征', perception: '邪魔闻之色变' }
      });
      expect(card.type).toBe('prop');
      if (card.type === 'prop') {
        expect(card.mechanics?.limitations).toBe('需主人精血温养');
      }
    });

    it('organization 卡：接受 per-type 字段（公众 vs 隐藏 信息差）', () => {
      const card = assetCardSchema.parse({
        id: 'org_1', type: 'organization', name: '天道院',
        basics: { type: '学术', scale: '大陆第一', headquarters: 'loc_1' },
        ideology: { coreBelief: '维护天道秩序', publicImage: '济世救人', hiddenFace: '暗中操控皇权', bottomLine: ['绝不公开介入俗世皇权更迭'] },
        structure: { powerStructure: '长老会', factions: ['激进派', '保守派'] },
        resources: { manpower: '万弟子', military: '护院暗卫', intelligence: '遍布天下的眼线' },
        culture: { symbols: ['天罡印'], internalCulture: '师徒制', taboos: ['欺师灭祖'] },
        memberProfile: '白衣飘飘的修真学者'
      });
      expect(card.type).toBe('organization');
      if (card.type === 'organization') {
        expect(card.ideology?.hiddenFace).toBe('暗中操控皇权');
      }
    });

    it('rule 卡：接受 per-type 字段（边界漏洞爽点矿 + 认知分布信息差）', () => {
      const card = assetCardSchema.parse({
        id: 'rule_1', type: 'rule', name: '雷劫定律',
        basics: { type: '自然法则', level: '底层公理', scope: '所有修炼者突破时' },
        definition: { description: '突破境界必引天劫', nature: '绝对性' },
        mechanism: { trigger: '境界突破', executor: '天道意志' },
        boundaries: { loopholes: ['散仙无劫', '域外不受约束'], paradoxes: ['逆天改命者反遭天谴加强'] },
        costs: { violationConsequence: '形神俱灭', abuseConsequence: '天劫加强' },
        ecologicalImpact: '塑造了修炼者对天道的敬畏',
        cognition: { levels: '凡人不知→修士知其然→大能知边界', misconceptions: ['以为硬抗即可'] }
      });
      expect(card.type).toBe('rule');
      if (card.type === 'rule') {
        expect(card.boundaries?.loopholes).toContain('散仙无劫');
        expect(card.ecologicalImpact).toBe('塑造了修炼者对天道的敬畏');
      }
    });

    it('visual_motif 卡：接受 per-type 字段（主题映射三层）', () => {
      const card = assetCardSchema.parse({
        id: 'vm_1', type: 'visual_motif', name: '紫电',
        basics: { type: '视觉', level: '全书核心', frequency: '每章' },
        definition: { coreImagery: '紫色闪电', abstractMeaning: '天命/力量觉醒' },
        sensoryDetails: { visual: '刺目紫光', sound: '轰鸣' },
        variants: { list: ['觉醒紫（弱）', '狂暴紫（强）'], evolutionLogic: '随境界加深' },
        narrativeFunction: ['预示', '强化', '转折'],
        themeMapping: { surface: '雷电威力', middle: '主角成长', deep: '命运不可违抗' }
      });
      expect(card.type).toBe('visual_motif');
      if (card.type === 'visual_motif') {
        expect(card.themeMapping?.deep).toBe('命运不可违抗');
        expect(card.narrativeFunction).toContain('预示');
      }
    });

    it('lore 卡：接受 per-type 字段（真相层级信息差）', () => {
      const card = assetCardSchema.parse({
        id: 'lore_1', type: 'lore', name: '远古神战',
        basics: { type: '创世神话', credibility: '半信半疑', period: '太古' },
        storyBody: { fullVersion: '诸神争夺天道…', coreElements: ['天道意志', '神血'] },
        versionSystem: { versions: ['光明版', '黑暗版'], relations: '黑暗版最接近真相' },
        truth: { levels: '表层大众：神战→中层知情者：争夺天道→深层作者设定：天道意志在筛选' },
        impact: '相信神血者可获得力量',
        unsolvedMysteries: ['神血最终去向']
      });
      expect(card.type).toBe('lore');
      if (card.type === 'lore') {
        expect(card.truth?.levels).toContain('深层作者设定');
      }
    });

    it('golden_finger 卡（第 8 类）：接受完整 per-type 字段（限制代价 ⭐⭐）', () => {
      const card = assetCardSchema.parse({
        id: 'gf_1', type: 'golden_finger', name: '吞噬祖符',
        basics: { type: '器物型', unique: true, awakeningTime: '少年时', essence: '资源', packaging: '神秘石符' },
        abilitySystem: {
          coreAbility: '吞噬万物能量', derivedAbilities: ['吞噬妖兽得功法', '凝聚本源'],
          ultimateAbility: '吞噬天地', boundaries: '不能吞噬有主意志的生灵'
        },
        growthSystem: { mode: '吞噬积累', resources: '妖兽晶核', stages: '初始→凝符→完全体', pacing: '前期快后期慢' },
        limitations: {
          hardLimits: '不能突破天道上限', usageCost: '吞噬反噬精神力（累积）',
          conditionLimits: '需接触或近距离', cognitiveLimits: '初期不知能吞噬抽象之物',
          emotionalMoralLimits: '吞噬人族会心魔入体'
        },
        worldRelation: { legality: '灰色地带', powerSystemPosition: '独立体系', uniqueness: '举世唯一' },
        holderRelation: { attitudeEvolution: '恐惧→依赖→认同', dependency: '高度依赖', identity: '吞噬者' },
        balance: {
          coreLogic: '吞噬越强反噬越大', unsolvableDilemma: '不能复活已吞噬的存在',
          shuangdianAndNuedian: '爽点：以弱胜强；虐点：反噬'
        }
      });
      expect(card.type).toBe('golden_finger');
      if (card.type === 'golden_finger') {
        expect(card.limitations?.usageCost).toContain('反噬');
        expect(card.balance?.unsolvableDilemma).toBe('不能复活已吞噬的存在');
      }
    });
  });

  describe('assetCardSchema backward-compat（零 migration）', () => {
    it('最小 card（仅 id+type+name）仍 validate（per-type 字段全 optional）', () => {
      const card = assetCardSchema.parse({ id: 'c1', type: 'character', name: '匿名角色' });
      expect(card.id).toBe('c1');
      expect(card.name).toBe('匿名角色');
    });

    it('既有 fixture（base 字段齐全，无新字段）仍 validate', () => {
      const card = assetCardSchema.parse({
        id: 'char_main',
        type: 'character',
        name: '李探长',
        summary: '暗城资深侦探',
        tags: ['主角', '侦探'],
        relationships: [{ targetId: 'char_villain', relationType: 'rivalry' }],
        firstAppearance: 'ep_1',
        status: 'active'
      });
      expect(card.status).toBe('active');
      expect(card.relationships).toHaveLength(1);
    });

    it('assetCardsSchema 数组含混合类型卡仍 validate', () => {
      const cards = assetCardsSchema.parse([
        { id: 'c1', type: 'character', name: 'A' },
        { id: 'g1', type: 'golden_finger', name: '系统', basics: { essence: '信息' } },
        { id: 'l1', type: 'location', name: '暗城' }
      ]);
      expect(cards).toHaveLength(3);
      expect(cards[1].type).toBe('golden_finger');
    });

    it('拒绝缺 type（discriminatedUnion 必须有 discriminator）', () => {
      expect(() => assetCardSchema.parse({ id: 'c1', name: '无类型' })).toThrow();
    });

    it('拒绝未知 type（discriminatedUnion 不匹配任何 variant）', () => {
      expect(() => assetCardSchema.parse({ id: 'c1', type: 'unknown', name: 'X' })).toThrow();
    });

    it('拒绝缺 id / 空 name', () => {
      expect(() => assetCardSchema.parse({ type: 'character', name: 'X' })).toThrow();
      expect(() => assetCardSchema.parse({ id: 'c1', type: 'character', name: '' })).toThrow();
    });
  });

  // ── 分类词表（先验非门禁）──
  describe('分类词表（开放 string + 策展先验，mirror narrative-enums / craft-type-vocab）', () => {
    it('9 组词表均非空 + 每项含 value/gloss', () => {
      const vocabs = [
        POWER_SYSTEM_TYPE_VOCAB, LOCATION_TYPE_VOCAB, PROP_TYPE_VOCAB,
        ORGANIZATION_TYPE_VOCAB, RULE_TYPE_VOCAB, VISUAL_MOTIF_TYPE_VOCAB,
        LORE_TYPE_VOCAB, GOLDEN_FINGER_TYPE_VOCAB, GOLDEN_FINGER_ESSENCE_VOCAB
      ];
      for (const v of vocabs) {
        expect(v.length).toBeGreaterThan(0);
        for (const entry of v) {
          expect(typeof entry.value).toBe('string');
          expect(entry.value.length).toBeGreaterThan(0);
          expect(typeof entry.gloss).toBe('string');
        }
      }
    });

    it('GOLDEN_FINGER_ESSENCE_VOCAB 含信息/时间/规则/资源 4 不对称类型', () => {
      const values = GOLDEN_FINGER_ESSENCE_VOCAB.map((e) => e.value);
      expect(values).toEqual(['信息', '时间', '规则', '资源']);
    });

    it('POWER_SYSTEM_TYPE_VOCAB 含修炼/系统/网游/超能/无', () => {
      const values = POWER_SYSTEM_TYPE_VOCAB.map((e) => e.value);
      expect(values).toEqual(['修炼', '系统', '网游', '超能', '无']);
    });
  });

  // ── BMad CR patch 覆盖（2026-07-29）──
  describe('BMad CR patches', () => {
    // CR-001a：narrativeSchema 退场 themeMapping（与 visual_motif 顶层三层 themeMapping 同名冲突）
    it('CR-001a：narrativeSchema 仅 storyFunction + coreConflict（themeMapping 退场）', () => {
      const n = narrativeSchema.parse({ storyFunction: '主角', coreConflict: '平凡vs非凡' });
      expect(n.storyFunction).toBe('主角');
      expect(n.coreConflict).toBe('平凡vs非凡');
      // themeMapping 不再是 narrativeSchema 字段（Zod 默认 strip 未知键）
      const stripped = narrativeSchema.parse({ themeMapping: 'x' } as any);
      expect((stripped as any).themeMapping).toBeUndefined();
    });

    it('CR-001a：visual_motif 顶层 themeMapping（三层 object）仍保留为该类专字段', () => {
      const card = assetCardSchema.parse({
        id: 'vm_1', type: 'visual_motif', name: '紫电',
        themeMapping: { surface: '雷电', middle: '成长', deep: '命运' }
      });
      if (card.type === 'visual_motif') {
        expect(card.themeMapping?.deep).toBe('命运');
      }
    });

    // CR-002：nested object 组 .nullish() 接受 null（防 LLM 产 null 致整卡 parse 失败）
    it('CR-002：per-type nested object 组接受 null（.nullish()）', () => {
      const card = assetCardSchema.parse({
        id: 'char_1', type: 'character', name: '李探长',
        personality: null,           // null 合法（nullish）
        desireAndBottomline: null,
        narrative: null,             // 公共 sub-schema 同样接受 null
        writingCheatSheet: null
      });
      expect(card.type).toBe('character');
      if (card.type === 'character') {
        expect(card.personality).toBeNull();
        expect(card.narrative).toBeNull();
      }
    });

    it('CR-002：location 地标（数组）仍 .optional 不受 nullish 影响', () => {
      // 数组字段保持 .optional（非 nullish）——null 会被拒（数组非 nullish）
      expect(() => assetCardSchema.parse({
        id: 'l1', type: 'location', name: '暗城', landmarks: null
      } as any)).toThrow();
    });

    // CR-005：rule/visual_motif basics 删 name（与 base 顶层必填 name 重复）
    it('CR-005：rule basics 无 name 字段（顶层 name 为准，basics.name 被 strip）', () => {
      const card = assetCardSchema.parse({
        id: 'rule_1', type: 'rule', name: '雷劫定律',
        basics: { name: '应被忽略', type: '自然法则', level: '底层公理' } as any
      });
      if (card.type === 'rule') {
        expect((card.basics as any)?.name).toBeUndefined();
        expect(card.name).toBe('雷劫定律');   // 顶层 name 为准
      }
    });

    it('CR-005：visual_motif basics 无 name 字段', () => {
      const card = assetCardSchema.parse({
        id: 'vm_1', type: 'visual_motif', name: '紫电',
        basics: { name: '应被忽略', type: '视觉' } as any
      });
      if (card.type === 'visual_motif') {
        expect((card.basics as any)?.name).toBeUndefined();
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.3：asset_cards tier 标注（additive optional，零 migration）
// 范式判据：tier 标注是 LLM 写设定时标的语义判断；编译器读 tier 做结构提取（纯代码）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 2.3 schema additions（asset_cards tier 标注）', () => {
  it('接受 tier=core / tier=micro', () => {
    const core = assetCardSchema.parse({ id: 'c1', type: 'character', name: 'A', tier: 'core' });
    const micro = assetCardSchema.parse({ id: 'c2', type: 'location', name: 'B', tier: 'micro' });
    expect(core.tier).toBe('core');
    expect(micro.tier).toBe('micro');
  });

  it('tier 缺省 undefined（零 migration backward-compat：既有卡仍 validate）', () => {
    const card = assetCardSchema.parse({ id: 'c1', type: 'character', name: 'A' });
    expect(card.tier).toBeUndefined();
  });

  it('拒绝非法 tier 值（非 core/micro）', () => {
    expect(() => assetCardSchema.parse({ id: 'c1', type: 'character', name: 'A', tier: 'main' })).toThrow();
  });

  it('tier 跨 8 类卡均可用（base 公共字段，所有 variant 继承）', () => {
    for (const t of assetCardTypeSchema.options) {
      const card = assetCardSchema.parse({ id: 'x', type: t, name: 'N', tier: 'core' });
      expect(card.tier, `${t} tier 未生效`).toBe('core');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5（design D3）：outlineV2 假字段重命名——growth_curve→arc_design_notes /
// pacing_curve_text→pacing_design_notes（与顶层结构化 creative field 同名不同物，改名消歧）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 8.5 outlineV2 假字段重命名（arc_design_notes / pacing_design_notes）', () => {
  it('新键 parse：自由文本草稿位（z.string().optional）', () => {
    const outline = outlineV2Schema.parse({
      arc_design_notes: '主角弧草稿：自卑→自我接纳',
      pacing_design_notes: '前松后紧，卷末高潮',
    });
    expect(outline.arc_design_notes).toBe('主角弧草稿：自卑→自我接纳');
    expect(outline.pacing_design_notes).toBe('前松后紧，卷末高潮');
  });

  it('旧键 growth_curve / pacing_curve_text 被 zod strip 容忍（Step 2 loadProject 就地迁移前不 fail）', () => {
    const outline = outlineV2Schema.parse({
      growth_curve: '旧草稿文本',
      pacing_curve_text: '旧节奏文本',
    } as Record<string, unknown>);
    // 旧键非 strict zod strip：不进输出、不报错（迁移在 Step 2，mirror foreshadow-migration）
    expect((outline as Record<string, unknown>).growth_curve).toBeUndefined();
    expect((outline as Record<string, unknown>).pacing_curve_text).toBeUndefined();
    expect(outline.arc_design_notes).toBeUndefined(); // 旧键不冒充新键
  });

  it('缺省合法（零 migration：既有无草稿 outline 仍 validate）', () => {
    expect(outlineV2Schema.parse({ central_conflict: 'x' }).arc_design_notes).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 R2：episodeOutlineSchema.phase_ref + episodeActionSchema / applyEpisodeActions
// （mirror assetCardActionSchema / applyAssetCardActions——by-id upsert，index 冲突不机械改写）。
// 范式判据：集纲切分与 phase 挂钩是语义归 LLM；identity/内容投影归纯代码（ADR-3 ✓）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 8.5 episodeOutlineSchema.phase_ref（集纲→卷锚，mirror Line.phase_ref）', () => {
  it('phase_ref 可选挂 phases[].id（零 migration）', () => {
    const ep = episodeOutlineSchema.parse({ id: 'e1', index: 0, title: '第一卷开局', phase_ref: 'phase-1' });
    expect(ep.phase_ref).toBe('phase-1');
  });

  it('缺省 undefined + 空串拒收（.min(1)，mirror 既有 *_ref 约定）', () => {
    expect(episodeOutlineSchema.parse({ id: 'e1', index: 0, title: 't' }).phase_ref).toBeUndefined();
    expect(() => episodeOutlineSchema.parse({ id: 'e1', index: 0, title: 't', phase_ref: '' })).toThrow();
  });

  it('既有 episode（无 phase_ref）仍 validate（backward-compat）', () => {
    expect(
      episodeOutlinesSchema.parse([{ id: 'e1', index: 0, title: 't', status: 'locked' }])[0].status,
    ).toBe('locked');
  });
});

describe('Story 8.5 applyEpisodeActions（episode_outlines bounded action 投影，mirror applyAssetCardActions）', () => {
  const ep = (id: string, extra: Record<string, unknown> = {}) =>
    episodeOutlineSchema.parse({ id, index: 0, title: id, ...extra });

  it('add_episode：追加 + schema 填 defaults（character_progressions/status/dependsOn）', () => {
    const out = applyEpisodeActions([], [{ op: 'add_episode', episode: ep('e1', { title: '觉醒' }) }]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('e1');
    expect(out[0].title).toBe('觉醒');
    expect(out[0].character_progressions).toEqual([]); // schema default
    expect(out[0].status).toBe('planned'); // schema default
  });

  it('add_episode 重复 id → 跳过不覆盖（防御 backstop，mirror add_card）', () => {
    const out = applyEpisodeActions([ep('e1', { title: '旧题' })], [
      { op: 'add_episode', episode: ep('e1', { title: '新题' }) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('旧题'); // 既有集纲不动，永不静默替换
  });

  it('update_episode：浅合并 patch——未提供字段保留 + phase_ref 可经 patch 挂钩', () => {
    const current = [ep('e1', { summary: '旧摘要', status: 'locked' })];
    const out = applyEpisodeActions(current, [
      { op: 'update_episode', episodeId: 'e1', patch: { phase_ref: 'phase-2' } },
    ]);
    expect(out[0].phase_ref).toBe('phase-2');
    expect(out[0].summary).toBe('旧摘要'); // 未提供字段保留
    expect(out[0].status).toBe('locked');
    // 原 array 不被原地改（纯函数）
    expect(current[0].phase_ref).toBeUndefined();
  });

  it('update_episode patch 空 {} → 无 default 填充（partial 不应用 defaults，mirror sceneNodeSchema.partial 先例）', () => {
    const current = [ep('e1', { summary: '旧摘要' })];
    const parsed = episodeActionSchema.parse({ op: 'update_episode', episodeId: 'e1', patch: {} });
    if (parsed.op !== 'update_episode') throw new Error('expected update_episode');
    expect(parsed.patch).toEqual({}); // patch 本身无 defaults 填充
    const out = applyEpisodeActions(current, [parsed]);
    expect(out[0]).toEqual(current[0]); // 合并无变化（status 未被 default 'planned' 覆盖）
  });

  it('update_episode：patch 内 id 被 omit strip（identity 不可改，mirror promise update_beat E8）', () => {
    const action = episodeActionSchema.parse({
      op: 'update_episode',
      episodeId: 'e1',
      patch: { id: 'evil', title: '改题' },
    });
    const out = applyEpisodeActions([ep('e1')], [action]);
    expect(out[0].id).toBe('e1'); // 身份不变
    expect(out[0].title).toBe('改题'); // 其余字段合并
  });

  // ── CR-Blind-F1（8.5 CR）：patch.phase_ref 三态——null 显式清除 / undefined 不改 / 空串拒。──
  it('update_episode patch phase_ref=null → 显式清除既有卷锚（null 不落盘，折叠为删键）', () => {
    const out = applyEpisodeActions([ep('e1', { phase_ref: 'phase-1' })], [
      { op: 'update_episode', episodeId: 'e1', patch: { phase_ref: null } },
    ]);
    expect(out[0].phase_ref).toBeUndefined(); // 清除
    expect('phase_ref' in out[0]).toBe(false); // 删键（非 null 落盘）
    expect(out[0].title).toBe('e1'); // 其余字段不受牵连
  });

  it('update_episode patch 不含 phase_ref → 保留旧锚（undefined = 不改，partial merge 语义）', () => {
    const out = applyEpisodeActions([ep('e1', { phase_ref: 'phase-1' })], [
      { op: 'update_episode', episodeId: 'e1', patch: { hook: '新钩子' } },
    ]);
    expect(out[0].phase_ref).toBe('phase-1'); // 未提供 → 不改
    expect(out[0].hook).toBe('新钩子');
  });

  it('update_episode patch phase_ref 空串仍拒（.min(1)——锚要么有值要么明确 null 清除）', () => {
    expect(() =>
      episodeActionSchema.parse({ op: 'update_episode', episodeId: 'e1', patch: { phase_ref: '' } }),
    ).toThrow();
  });

  it('add_episode 的 episode.phase_ref 不收 null（add 是整集写入，null 清除语义只在 update patch）', () => {
    expect(() =>
      episodeActionSchema.parse({
        op: 'add_episode',
        episode: { id: 'e1', index: 0, title: 't', phase_ref: null },
      }),
    ).toThrow();
  });

  it('update_episode：episodeId 不存在 → 幂等跳过（mirror update_card）', () => {
    const out = applyEpisodeActions([ep('e1')], [
      { op: 'update_episode', episodeId: '不存在', patch: { title: 'x' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('e1'); // untouched
  });

  it('remove_episode：存在 → 删；不存在 → 幂等跳过；删后不 reindex', () => {
    const out1 = applyEpisodeActions(
      [episodeOutlineSchema.parse({ id: 'e0', index: 0, title: 'e0' }), episodeOutlineSchema.parse({ id: 'e1', index: 1, title: 'e1' })],
      [{ op: 'remove_episode', episodeId: 'e0' }],
    );
    expect(out1).toHaveLength(1);
    expect(out1[0].index).toBe(1); // 不 renumber（index 是 LLM 排序决策）
    const out2 = applyEpisodeActions(out1, [{ op: 'remove_episode', episodeId: 'e0' }]);
    expect(out2).toHaveLength(1); // 再删不存在 id 无效果
  });

  it('index 冲突不机械改写：add 带 index 撞既有 → 双方保留原值（projector 不 renumber/去重）', () => {
    const out = applyEpisodeActions(
      [episodeOutlineSchema.parse({ id: 'e1', index: 1, title: 'e1' })],
      [{ op: 'add_episode', episode: episodeOutlineSchema.parse({ id: 'e2', index: 1, title: 'e2' }) }],
    );
    expect(out.map((e) => e.index)).toEqual([1, 1]); // 均保留，projector 忠实不机械改写
  });

  it('多 action 顺序投影（leader 直改 phase_ref + episode-planner 补集纲两驱动同通道）', () => {
    const out = applyEpisodeActions([], [
      { op: 'add_episode', episode: ep('e1') },
      { op: 'add_episode', episode: ep('e2') },
      { op: 'update_episode', episodeId: 'e1', patch: { phase_ref: 'phase-1', hook: '卷末钩子' } },
      { op: 'remove_episode', episodeId: 'e2' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('e1');
    expect(out[0].phase_ref).toBe('phase-1');
    expect(out[0].hook).toBe('卷末钩子');
  });

  it('episodeActionSchema 守门：非法 op / add 缺 title / add 缺 index 拒', () => {
    expect(episodeActionSchema.parse({ op: 'remove_episode', episodeId: 'x' }).op).toBe('remove_episode');
    expect(() => episodeActionSchema.parse({ op: 'add_episode', episode: { id: 'e1', index: 0 } })).toThrow(); // 缺 title
    expect(() => episodeActionSchema.parse({ op: 'add_episode', episode: { id: 'e1', title: 't' } })).toThrow(); // 缺 index
    expect(() => episodeActionSchema.parse({ op: 'bogus', episodeId: 'x' })).toThrow(); // 非法 op
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 D2：growthCurveFieldSchema（顶层形态归一——union 单条/array/Record → array）。
// 宽容读（旧 yaml 单条/Record 不丢）+ canonical 写（恒 array）。存储契约层（条目严格）；
// 防御性宽容读（坏条目跳过）归 readGrowthCurves（arc-coverage.ts），两层不混。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 8.5 growthCurveFieldSchema（顶层形态归一：union → array canonical）', () => {
  it('array 形态直通（canonical 多角色，保序 + defaults 已由元素 schema 填）', () => {
    const out = growthCurveFieldSchema.parse([
      { character_id: 'c1', start_state: '自卑' },
      { character_id: 'c2', start_state: '傲慢', desire: '压倒一切' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].character_id).toBe('c1');
    expect(out[0].turning_points).toEqual([]); // defaults
    expect(out[1].desire).toBe('压倒一切');
  });

  it('旧 yaml 单条形态 → 包成数组（不丢数据）', () => {
    const out = growthCurveFieldSchema.parse({
      character_id: 'c1',
      start_state: '自卑',
      wound_or_lack: '被遗弃',
    });
    expect(out).toHaveLength(1);
    expect(out[0].character_id).toBe('c1');
    expect(out[0].wound_or_lack).toBe('被遗弃');
  });

  it('Record 形态：值缺 character_id → key 补', () => {
    const out = growthCurveFieldSchema.parse({
      'char-lin': { start_state: '封闭', desire: '被理解' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].character_id).toBe('char-lin'); // key 补齐
    expect(out[0].desire).toBe('被理解');
  });

  it('Record 形态：值自带 character_id 优先（key 只补缺）', () => {
    const out = growthCurveFieldSchema.parse({
      'record-key': { character_id: 'real-id', start_state: '起点' },
    });
    expect(out[0].character_id).toBe('real-id'); // 值内优先
  });

  it('存储契约严格：非三形态的坏数据拒收（区别于 readGrowthCurves 宽容读）', () => {
    expect(() => growthCurveFieldSchema.parse('a string')).toThrow();
    expect(() => growthCurveFieldSchema.parse(42)).toThrow();
    expect(() => growthCurveFieldSchema.parse([{ start_state: '缺 character_id' }])).toThrow();
    expect(() => growthCurveFieldSchema.parse({ k: { desire: '缺 start_state' } })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 R1：growthCurveActionSchema / applyGrowthCurveActions
// （mirror applyAssetCardActions + promiseEntryWriteSchema B1——partial merge 防 defaults 覆盖）。
// 范式判据：弧内容生产归 leader LLM 对话；by-character_id 投影归纯代码（ADR-3 ✓）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 8.5 applyGrowthCurveActions（growth_curve bounded action 投影）', () => {
  const full = growthCurveSchema.parse({
    character_id: 'c1',
    start_state: '自卑',
    desire: '被认可',
    turning_points: [{ turning_point: '觉醒', linked_episode_ids: ['ep3'] }],
    regressions: ['ep2 倒退'],
    end_state: '自我接纳',
    linked_episode_ids: ['ep1', 'ep2'],
  });

  it('add_curve：新角色 → 追加 + parse 填 defaults（turning_points/regressions/linked_episode_ids）', () => {
    const out = applyGrowthCurveActions([], [
      { op: 'add_curve', curve: { character_id: 'c1', start_state: '自卑', desire: '被认可' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].desire).toBe('被认可');
    expect(out[0].turning_points).toEqual([]); // defaults
    expect(out[0].regressions).toEqual([]);
    expect(out[0].linked_episode_ids).toEqual([]);
  });

  it('add_curve 已存在 → partial merge：显式字段覆盖、未提供 defaulted 字段不被 default 覆盖（B1 谱）', () => {
    const out = applyGrowthCurveActions([full], [
      { op: 'add_curve', curve: { character_id: 'c1', start_state: '封闭', need: '自我接纳' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].start_state).toBe('封闭'); // 显式提供 → 覆盖
    expect(out[0].need).toBe('自我接纳');
    expect(out[0].turning_points).toEqual([{ turning_point: '觉醒', linked_episode_ids: ['ep3'] }]); // 不被 [] 覆盖（B1）
    expect(out[0].regressions).toEqual(['ep2 倒退']); // 不被 [] 覆盖
    expect(out[0].linked_episode_ids).toEqual(['ep1', 'ep2']);
    expect(out[0].end_state).toBe('自我接纳');
    // 原 array 不被原地改（纯函数）
    expect(full.start_state).toBe('自卑');
  });

  it('add_curve 已存在且显式提供 defaulted 字段 → 覆盖（显式意图非 default 覆盖）', () => {
    const out = applyGrowthCurveActions([full], [
      { op: 'add_curve', curve: { character_id: 'c1', start_state: '自卑', regressions: [] } },
    ]);
    expect(out[0].regressions).toEqual([]); // LLM 显式清空 regressions = 显式意图
  });

  it('update_curve：patch 浅合并——未提供字段保留', () => {
    const out = applyGrowthCurveActions([full], [
      { op: 'update_curve', character_id: 'c1', patch: { desire: '复仇', end_state: '放下' } },
    ]);
    expect(out[0].desire).toBe('复仇');
    expect(out[0].end_state).toBe('放下');
    expect(out[0].start_state).toBe('自卑'); // 未提供保留
    expect(out[0].turning_points).toHaveLength(1); // 未提供保留
  });

  it('update_curve：patch 内 character_id 被 omit strip（identity 键不可改，mirror E8）', () => {
    const parsed = growthCurveActionSchema.parse({
      op: 'update_curve',
      character_id: 'c1',
      patch: { character_id: 'evil', desire: 'x' },
    });
    if (parsed.op !== 'update_curve') throw new Error('expected update_curve');
    expect((parsed.patch as Record<string, unknown>).character_id).toBeUndefined(); // schema strip
    const out = applyGrowthCurveActions([full], [parsed]);
    expect(out[0].character_id).toBe('c1'); // 身份不变
    expect(out[0].desire).toBe('x');
  });

  it('update_curve：character_id 不存在 → 幂等跳过（mirror update_card）', () => {
    const out = applyGrowthCurveActions([full], [
      { op: 'update_curve', character_id: '不存在', patch: { desire: 'x' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].desire).toBe('被认可'); // untouched
  });

  it('remove_curve：存在 → 删；不存在 → 幂等跳过', () => {
    const other = growthCurveSchema.parse({ character_id: 'c2', start_state: '起点' });
    const out1 = applyGrowthCurveActions([full, other], [{ op: 'remove_curve', character_id: 'c1' }]);
    expect(out1).toHaveLength(1);
    expect(out1[0].character_id).toBe('c2');
    const out2 = applyGrowthCurveActions(out1, [{ op: 'remove_curve', character_id: 'c1' }]);
    expect(out2).toHaveLength(1); // 再删不存在 id 无效果
  });

  it('多 action 顺序投影（对话建弧→补转折点→删弧主场景）', () => {
    const out = applyGrowthCurveActions([], [
      { op: 'add_curve', curve: { character_id: 'c1', start_state: '自卑' } },
      {
        op: 'update_curve',
        character_id: 'c1',
        patch: { turning_points: [{ turning_point: '觉醒', linked_episode_ids: ['ep3'] }] },
      },
      { op: 'add_curve', curve: { character_id: 'c2', start_state: '起点' } },
      { op: 'remove_curve', character_id: 'c2' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].character_id).toBe('c1');
    expect(out[0].turning_points).toEqual([{ turning_point: '觉醒', linked_episode_ids: ['ep3'] }]);
  });

  it('growthCurveActionSchema 守门：非法 op / add 缺 character_id / add 缺 start_state 拒', () => {
    expect(growthCurveActionSchema.parse({ op: 'remove_curve', character_id: 'c1' }).op).toBe('remove_curve');
    expect(() =>
      growthCurveActionSchema.parse({ op: 'add_curve', curve: { start_state: '起点' } }),
    ).toThrow(); // 缺 character_id
    expect(() =>
      growthCurveActionSchema.parse({ op: 'add_curve', curve: { character_id: 'c1' } }),
    ).toThrow(); // 缺 start_state
    expect(() => growthCurveActionSchema.parse({ op: 'bogus', character_id: 'c1' })).toThrow(); // 非法 op
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 R1：pacingCurveActionSchema / applyPacingCurveActions
// （mirror emotionCurveActionSchema / applyEmotionCurveActions 逐字段同构——同为 refId+points 曲线）。
// ─────────────────────────────────────────────────────────────────────────────
describe('Story 8.5 applyPacingCurveActions（pacing_curve bounded action 投影，mirror applyEmotionCurveActions）', () => {
  const point = (refId: string, intensity = 5) => pacingPointSchema.parse({ refId, intensity });
  const emptyCurve = pacingCurveSchema.parse({ unit: 'episode' });

  it('add_point：新 refId 追加；已存在 → 覆盖（幂等）', () => {
    const out = applyPacingCurveActions(emptyCurve, [{ op: 'add_point', point: point('ep1') }]);
    expect(out.points).toHaveLength(1);
    expect(out.points[0].refId).toBe('ep1');
    const out2 = applyPacingCurveActions(
      { ...emptyCurve, points: [point('ep1', 3)] },
      [{ op: 'add_point', point: point('ep1', 9) }],
    );
    expect(out2.points).toHaveLength(1);
    expect(out2.points[0].intensity).toBe(9); // 覆盖
  });

  it('update_point：refId 已存在 → 覆盖；不存在 → 追加（容错）', () => {
    const out = applyPacingCurveActions(
      { ...emptyCurve, points: [point('ep1')] },
      [
        { op: 'update_point', point: point('ep1', 8) },
        { op: 'update_point', point: point('ep2', 2) },
      ],
    );
    expect(out.points).toHaveLength(2);
    expect(out.points[0].intensity).toBe(8); // 覆盖
    expect(out.points[1].refId).toBe('ep2'); // 追加
  });

  it('remove_point：存在 → 删；不存在 → 幂等跳过', () => {
    const out = applyPacingCurveActions(
      { ...emptyCurve, points: [point('ep1'), point('ep2')] },
      [{ op: 'remove_point', refId: 'ep1' }, { op: 'remove_point', refId: '不存在' }],
    );
    expect(out.points).toHaveLength(1);
    expect(out.points[0].refId).toBe('ep2');
  });

  it('unit/target_shape/risks 透传不动（projector 只管 points）', () => {
    const curve = pacingCurveSchema.parse({ unit: 'scene', target_shape: '锯齿爬升', risks: ['连续高潮致麻木'] });
    const out = applyPacingCurveActions(curve, [{ op: 'add_point', point: point('s1') }]);
    expect(out.unit).toBe('scene');
    expect(out.target_shape).toBe('锯齿爬升');
    expect(out.risks).toEqual(['连续高潮致麻木']);
  });

  it('pacingCurveActionSchema 守门：非法 op / intensity 越界 / 缺 refId 拒', () => {
    expect(pacingCurveActionSchema.parse({ op: 'remove_point', refId: 'x' }).op).toBe('remove_point');
    expect(() => pacingCurveActionSchema.parse({ op: 'remove_point' })).toThrow(); // 缺 refId
    expect(() =>
      pacingCurveActionSchema.parse({ op: 'add_point', point: { refId: 'x', intensity: 11 } }),
    ).toThrow(); // intensity 越界
    expect(() => pacingCurveActionSchema.parse({ op: 'foo', refId: 'x' })).toThrow(); // 非法 op
  });
});

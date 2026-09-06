import { describe, expect, it } from 'vitest';
import {
  DECON_CRAFT_DIMENSION_IDS,
  DECON_DIMENSIONS,
  DECON_EMOTIONAL_BEATS,
  DECON_HOOK_TYPES,
  DECON_INFO_GAP_TYPES,
  DECON_PLOT_PHASES,
  DECON_TRANSITION_TYPES,
  type DeconDimensionId,
} from '@orison/shared-contracts';
import {
  DECON_CHARACTER_TIERS,
  DECON_CONTRAST_AXES,
  DECON_DESIRE_TYPES,
  DECON_EMOTIONAL_BEAT_VOCAB,
  DECON_FORESHADOW_LINES,
  DECON_FORESHADOW_SHAPES,
  DECON_FUNCTIONAL_CHARACTERS,
  DECON_FUNNEL_AXES,
  DECON_HOOK_VOCAB,
  DECON_IMMERSION_DIMENSIONS,
  DECON_INFO_DISPLAY_METHODS,
  DECON_INFO_GAP_VOCAB,
  DECON_LINE_ORGANIZATION_METHODS,
  DECON_MAP_CHANGE_PRECURSORS,
  DECON_MEME_AXES,
  DECON_OBSTACLE_TYPES,
  DECON_OVERALL_STRUCTURES,
  DECON_PERSONA_APPROACHES,
  DECON_PLOT_LINE_FAMILIES,
  DECON_PLOT_PHASE_VOCAB,
  DECON_P4_ARC_OUTPUT_CONTRACT,
  DECON_P4_CHAPTER_OUTPUT_CONTRACT,
  DECON_P4_GRANULARITY,
  DECON_P4_STANCE_PROMPT,
  DECON_SIX_STEPS,
  DECON_TIME_AXES,
  DECON_TRANSITION_VOCAB,
  DECON_VIEWPOINT_TYPES,
  DECON_WORLD_COMPONENTS,
  buildDeconP4BookQuestionnaire,
  buildDeconP4SystemPrompt,
  type DeconP4BookDimensionId,
  type DeconP4Granularity,
} from '../main/decon/p4Questionnaires';

// E10.3b W3a：P4 手艺问题单纯函数面——粒度登记对拍 / 13 维全覆盖 / 立场段四条 /
// 每维正典词汇注入抽查 / 词形单源（契约枚举 zip）/ 输出契约形状 / 书级问题单（P5 注入面）/
// 网文语境 grep 守卫（零古典例零反向禁令零学院名号——feedback-webnovel-framing-no-classical）。

const ALL_VOCAB: ReadonlyArray<ReadonlyArray<{ value: string; gloss: string }>> = [
  DECON_HOOK_VOCAB,
  DECON_TRANSITION_VOCAB,
  DECON_EMOTIONAL_BEAT_VOCAB,
  DECON_PLOT_PHASE_VOCAB,
  DECON_INFO_GAP_VOCAB,
  DECON_SIX_STEPS,
  DECON_VIEWPOINT_TYPES,
  DECON_INFO_DISPLAY_METHODS,
  DECON_IMMERSION_DIMENSIONS,
  DECON_DESIRE_TYPES,
  DECON_OBSTACLE_TYPES,
  DECON_PLOT_LINE_FAMILIES,
  DECON_LINE_ORGANIZATION_METHODS,
  DECON_OVERALL_STRUCTURES,
  DECON_FUNCTIONAL_CHARACTERS,
  DECON_CHARACTER_TIERS,
  DECON_PERSONA_APPROACHES,
  DECON_WORLD_COMPONENTS,
  DECON_MAP_CHANGE_PRECURSORS,
  DECON_TIME_AXES,
  DECON_MEME_AXES,
  DECON_CONTRAST_AXES,
  DECON_FUNNEL_AXES,
  DECON_FORESHADOW_SHAPES,
  DECON_FORESHADOW_LINES,
];

const BOOK_DIMS: readonly DeconP4BookDimensionId[] = ['huoke', 'jiegou', 'shijieguan'];

function build(dim: string, granularity: DeconP4Granularity): string {
  return buildDeconP4SystemPrompt({ dimensionId: dim as DeconDimensionId, granularity });
}

/** 全量语料（全部可产出的 prompt 文本 + 词表条目）——grep 守卫基面。 */
function buildCorpus(): string {
  const parts: string[] = [
    DECON_P4_STANCE_PROMPT,
    DECON_P4_CHAPTER_OUTPUT_CONTRACT,
    DECON_P4_ARC_OUTPUT_CONTRACT,
    ...DECON_CRAFT_DIMENSION_IDS.flatMap((id) =>
      DECON_P4_GRANULARITY[id].map((g) => buildDeconP4SystemPrompt({ dimensionId: id, granularity: g })),
    ),
    ...BOOK_DIMS.map((d) => buildDeconP4BookQuestionnaire(d)),
    ...ALL_VOCAB.flatMap((table) => table.map((e) => `${e.value}：${e.gloss}`)),
  ];
  return parts.join('\n');
}

describe('DECON_P4_GRANULARITY（粒度登记 × design §3.1 对拍）', () => {
  it('逐维粒度面与设计表一致', () => {
    expect({ ...DECON_P4_GRANULARITY }).toEqual({
      huoke: ['chapter'],
      qidaigan: ['chapter', 'arc'],
      jiegou: ['arc'],
      renshe: ['arc'],
      shijieguan: ['arc'],
      qingxu: ['chapter', 'arc'],
      wenbi: ['chapter'],
      zaogeng: ['chapter', 'arc'],
      xinxicha: ['chapter', 'arc'],
      shijian: ['chapter', 'arc'],
      fubi: ['arc'],
      duizhao: ['arc'],
    });
  });

  it('12 手艺维全登记（style 除外——归 p4Style）', () => {
    expect(Object.keys(DECON_P4_GRANULARITY).sort()).toEqual([...DECON_CRAFT_DIMENSION_IDS].sort());
  });
});

describe('13 维全覆盖构建（DECON_DIMENSIONS 遍历）', () => {
  it('style 抛错（风格维走 p4Style.ts）', () => {
    expect(() => buildDeconP4SystemPrompt({ dimensionId: 'style', granularity: 'chapter' })).toThrow(
      /p4Style/,
    );
  });

  it('style 之外每维每粒度可构建，立场段前置 + 输出契约在尾', () => {
    for (const d of DECON_DIMENSIONS) {
      if (d.id === 'style') continue;
      for (const g of DECON_P4_GRANULARITY[d.id as keyof typeof DECON_P4_GRANULARITY]) {
        const prompt = build(d.id, g);
        expect(prompt.startsWith(DECON_P4_STANCE_PROMPT)).toBe(true);
        expect(prompt).toContain(`【分析任务：${d.label}`);
        expect(prompt).toContain('paraRange');
        expect(prompt).toContain('宁缺毋滥');
      }
    }
  });

  it('粒度面错配抛错（不变量显式失败）', () => {
    expect(() => build('jiegou', 'chapter')).toThrow(/没有 chapter 粒度面/);
    expect(() => build('fubi', 'chapter')).toThrow(/没有 chapter 粒度面/);
    expect(() => build('huoke', 'arc')).toThrow(/没有 arc 粒度面/);
  });
});

describe('共用立场段（design §3.2 四条）', () => {
  it('四条关键短语在场：学优点 / 失败对照需外部材料 / 呼应证据 / 词表词形', () => {
    for (const phrase of ['做对了什么', '外部材料', '呼应证据', '不要自造新词']) {
      expect(DECON_P4_STANCE_PROMPT).toContain(phrase);
    }
  });

  it('书内人物对照组只作呼应证据（不当失败样本）', () => {
    expect(DECON_P4_STANCE_PROMPT).toContain('不当失败样本');
  });
});

describe('词形单源（契约枚举 zip——不复制词形）', () => {
  it('五个契约枚举词表的 value 序列与契约常量一致', () => {
    expect(DECON_HOOK_VOCAB.map((e) => e.value)).toEqual([...DECON_HOOK_TYPES]);
    expect(DECON_TRANSITION_VOCAB.map((e) => e.value)).toEqual([...DECON_TRANSITION_TYPES]);
    expect(DECON_EMOTIONAL_BEAT_VOCAB.map((e) => e.value)).toEqual([...DECON_EMOTIONAL_BEATS]);
    expect(DECON_PLOT_PHASE_VOCAB.map((e) => e.value)).toEqual([...DECON_PLOT_PHASES]);
    expect(DECON_INFO_GAP_VOCAB.map((e) => e.value)).toEqual([...DECON_INFO_GAP_TYPES]);
  });

  it('全部词表 gloss 非空（zip 按位对齐防漂移）', () => {
    for (const table of ALL_VOCAB) {
      for (const entry of table) {
        expect(entry.gloss.trim().length, `${entry.value} 的 gloss 不应为空`).toBeGreaterThan(0);
      }
    }
  });
});

describe('每维正典词汇注入（抽查）', () => {
  it('huoke 章级（开篇子集）：获客四件', () => {
    const p = build('huoke', 'chapter');
    expect(p).toContain('开篇章');
    for (const w of ['耐心值', '开篇任务清单', '承诺', '黄金三章']) expect(p).toContain(w);
  });

  it('qidaigan 章级：六步法全环节词形', () => {
    const p = build('qidaigan', 'chapter');
    for (const e of DECON_SIX_STEPS) expect(p).toContain(e.value);
    expect(p).toContain('明铺');
    expect(p).toContain('暗铺');
  });

  it('qidaigan 弧级：钩子 11 型 + 转折 9 型全词形（契约单源注入）', () => {
    const p = build('qidaigan', 'arc');
    for (const t of DECON_HOOK_TYPES) expect(p).toContain(t);
    for (const t of DECON_TRANSITION_TYPES) expect(p).toContain(t);
  });

  it('qingxu 章级：情绪 7 拍 + 四相位 + 欲望 9 型 + 阻碍 8 类', () => {
    const p = build('qingxu', 'chapter');
    for (const t of DECON_EMOTIONAL_BEATS) expect(p).toContain(t);
    for (const t of DECON_PLOT_PHASES) expect(p).toContain(t);
    for (const e of DECON_DESIRE_TYPES) expect(p).toContain(e.value);
    for (const e of DECON_OBSTACLE_TYPES) expect(p).toContain(e.value);
  });

  it('wenbi 章级抽查：信息展现 5 法 + 代入 5 维', () => {
    const p = build('wenbi', 'chapter');
    for (const e of DECON_INFO_DISPLAY_METHODS) expect(p).toContain(e.value);
    for (const e of DECON_IMMERSION_DIMENSIONS) expect(p).toContain(e.value);
    expect(p).toContain('六觉刻画');
  });

  it('zaogeng 章级：造梗三件', () => {
    const p = build('zaogeng', 'chapter');
    for (const e of DECON_MEME_AXES) expect(p).toContain(e.value);
  });

  it('xinxicha 章级：信息差 6 型（契约）+ 视角 6 型 + 解读不重打纪律', () => {
    const p = build('xinxicha', 'chapter');
    for (const t of DECON_INFO_GAP_TYPES) expect(p).toContain(t);
    for (const e of DECON_VIEWPOINT_TYPES) expect(p).toContain(e.value);
    expect(p).toContain('不要自己重新标注');
  });

  it('shijian 章级：时间三轴操作化词形（无学院名号）', () => {
    const p = build('shijian', 'chapter');
    for (const e of DECON_TIME_AXES) expect(p).toContain(e.value);
  });

  it('jiegou 弧级：换地图 + 三前兆 + 剧情线 5 族子型', () => {
    const p = build('jiegou', 'arc');
    expect(p).toContain('换地图');
    for (const e of DECON_MAP_CHANGE_PRECURSORS) expect(p).toContain(e.value);
    expect(p).toContain('递进连续'); // 持续线子型
    expect(p).toContain('信息前提'); // 前提线子型
    expect(p).toContain('拼图延迟'); // 延时线子型
    expect(p).toContain('核心节奏公式');
    expect(p).toContain('切分解读'); // 消费 P3b 弧切分
    for (const e of DECON_LINE_ORGANIZATION_METHODS) expect(p).toContain(e.value);
  });

  it('renshe 弧级：功能人物 8 类 + 人物分级 + 人设 3 思路', () => {
    const p = build('renshe', 'arc');
    expect(p).toContain('功能人物');
    for (const e of DECON_FUNCTIONAL_CHARACTERS) expect(p).toContain(e.value);
    for (const e of DECON_CHARACTER_TIERS) expect(p).toContain(e.value);
    for (const e of DECON_PERSONA_APPROACHES) expect(p).toContain(e.value);
    expect(p).toContain('笔法指纹');
  });

  it('shijieguan 弧级：世界 8 件套 + 换壳测试 + 留白', () => {
    const p = build('shijieguan', 'arc');
    for (const e of DECON_WORLD_COMPONENTS) expect(p).toContain(e.value);
    expect(p).toContain('换壳测试');
    expect(p).toContain('留白');
  });

  it('qingxu 弧级：相位循环 + 欲望-阻碍配对', () => {
    const p = build('qingxu', 'arc');
    expect(p).toContain('稳定看点引擎');
    expect(p).toContain('蓄放结构');
    expect(p).toContain('欲望-阻碍主力配对');
    for (const e of DECON_DESIRE_TYPES) expect(p).toContain(e.value);
    for (const e of DECON_OBSTACLE_TYPES) expect(p).toContain(e.value);
  });

  it('zaogeng 弧级：造梗三件（弧级面）', () => {
    const p = build('zaogeng', 'arc');
    for (const e of DECON_MEME_AXES) expect(p).toContain(e.value);
  });

  it('xinxicha 弧级（读者知识曲线）', () => {
    const p = build('xinxicha', 'arc');
    expect(p).toContain('读者知识曲线');
    for (const t of DECON_INFO_GAP_TYPES) expect(p).toContain(t);
    for (const e of DECON_VIEWPOINT_TYPES) expect(p).toContain(e.value);
  });

  it('shijian 弧级（频率面）：重讲取景', () => {
    const p = build('shijian', 'arc');
    expect(p).toContain('重讲');
    for (const e of DECON_TIME_AXES) expect(p).toContain(e.value);
  });

  it('fubi 弧级：回收点 + 明收/暗收 + 隔距 + 伏笔线', () => {
    const p = build('fubi', 'arc');
    expect(p).toContain('回收点');
    expect(p).toContain('明收');
    expect(p).toContain('暗收');
    expect(p).toContain('隔距');
    for (const e of DECON_FORESHADOW_SHAPES) expect(p).toContain(e.value);
    for (const e of DECON_FORESHADOW_LINES) expect(p).toContain(e.value);
  });

  it('duizhao 弧级：对照组 + 变奏对 + 避复', () => {
    const p = build('duizhao', 'arc');
    for (const e of DECON_CONTRAST_AXES) expect(p).toContain(e.value);
    expect(p).toContain('同类场景聚类');
  });
});

describe('输出契约（findings JSON 形状钉死——W1 契约 deconFindingsSchema 对齐）', () => {
  it('章/弧契约均含六字段与无锚即丢声明', () => {
    for (const contract of [DECON_P4_CHAPTER_OUTPUT_CONTRACT, DECON_P4_ARC_OUTPUT_CONTRACT]) {
      for (const key of ['insight', 'elaboration', 'evidence', 'paraRange', 'quote', 'craftHint', 'synthesis']) {
        expect(contract).toContain(key);
      }
      expect(contract).toContain('给不出正文位置的结论会被直接丢弃，宁缺毋滥');
      expect(contract).toContain('craftHint 只给值得沉淀成手艺卡复用的发现');
    }
  });

  it('弧级契约独有：概要与统计不是原文、不能当证据（弧级锚定纪律）', () => {
    expect(DECON_P4_ARC_OUTPUT_CONTRACT).toContain('不是原文');
    expect(DECON_P4_CHAPTER_OUTPUT_CONTRACT).not.toContain('不是原文');
  });

  it('章级含「不重新打标」解读纪律；弧级消费概要与统计', () => {
    expect(build('qingxu', 'chapter')).toContain('不重新打标');
    const arc = build('jiegou', 'arc');
    expect(arc).toContain('弧内各章概要');
    expect(arc).toContain('弧计量统计');
  });
});

describe('书级问题单（维 1/3/5——P5 book_reading 注入面）', () => {
  it('三维可构建且注入对应词表', () => {
    const huoke = buildDeconP4BookQuestionnaire('huoke');
    expect(huoke).toContain('漏斗');
    expect(huoke).toContain('受众画像');
    expect(huoke).toContain('黄金三章');

    const jiegou = buildDeconP4BookQuestionnaire('jiegou');
    for (const e of DECON_OVERALL_STRUCTURES) expect(jiegou).toContain(e.value);
    expect(jiegou).toContain('核心节奏公式');
    expect(jiegou).toContain('换地图');
    for (const e of DECON_PLOT_LINE_FAMILIES) expect(jiegou).toContain(e.value);

    const shijieguan = buildDeconP4BookQuestionnaire('shijieguan');
    expect(shijieguan).toContain('换壳测试');
    expect(shijieguan).toContain('留白');
    for (const e of DECON_WORLD_COMPONENTS) expect(shijieguan).toContain(e.value);
  });

  it('书级问题单不带 findings 输出契约（P5 输出是读法 markdown——格式说明归 W4 装配）', () => {
    for (const d of BOOK_DIMS) {
      expect(buildDeconP4BookQuestionnaire(d)).not.toContain('craftHint');
    }
  });

  it('非 维1/3/5 的书级面抛错', () => {
    expect(() => buildDeconP4BookQuestionnaire('qingxu' as DeconP4BookDimensionId)).toThrow(
      /没有书级问题单/,
    );
  });
});

describe('网文语境 grep 守卫（feedback-webnovel-framing-no-classical）', () => {
  it('零古典书名/作者/学院名号/学院概念（操作化描述替代）', () => {
    expect(buildCorpus()).not.toMatch(
      /亚里士多德|红楼梦|水浒|三国|西游记|金瓶梅|儒林外史|麦基|热奈特|查特曼|申丹|普罗普|格雷马斯|托多罗夫|托尔斯泰|陀思妥|卡夫卡|博尔赫斯|普鲁斯特|乔伊斯|叙事学|叙述学|文学理论|经典文学|严肃文学|传统文学|纯文学|评点|起承转合|蒙太奇|戏剧反讽|价值极性/,
    );
  });

  it('零反向禁令（不写「不是 XX 文学」类自我声明/不写摒弃学院类措辞）', () => {
    expect(buildCorpus()).not.toMatch(
      /不是[^。\n]{0,12}文学|(摒弃|拒绝|排斥)[^。\n]{0,10}(学院|学术|古典|传统)|(不采用|不使用|不用)[^。\n]{0,10}(理论|学院|古典)/,
    );
  });
});

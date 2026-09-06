import { createHash } from 'node:crypto';
import type { DeconProgressEvent, Material } from '@orison/shared-contracts';
import type { MaterialParagraphBlock } from '../main/ipc/toolHandlers/materialIngest';
import { composeDerivedText, splitParagraphBlocks } from '../main/ipc/toolHandlers/materialIngest';
import type { DeconGenerateText } from '../main/decon/deconLlmCore';
import { listCraftTerms } from '../main/db/closureCraftTermRepository';
import {
  createDeconIpcHandlers,
  runDeconPassSequence,
  type DeconIpcHandlers,
  type DeconPassSequenceResult,
} from '../main/ipc/deconIpc';

// E10.3b W7：decon 全链集成测试共用 fixture/链 mock/handler 工厂——deconGoldenEval.test.ts
// 与 deconIntegration.test.ts 消费（deconPipelineIpc.test.ts 的 A 段 inline harness 不动——
// 零 churn；本文件是其扩展形态：+ p4 craftHint findings / p4:style / p6 落卡三路 mock）。
//
// ⚠️ **依赖测试文件的 vi.mock 先行**：消费方必须在 import 本文件前 vi.mock('electron') /
// modelGatewayIpc / @orison/desktop-agent / @orison/model-protocols（mirror deconPipelineIpc.
// test.ts 头部四连 mock）——vitest 模块注册表按测试文件隔离，本文件的传递导入同受其罩。

// ── 合成材料 fixture（3 章——别名对〔灵儿/赵灵兒〕+ 幻觉实体名〔幻影真人〕+ flashback
//    + kernel 事件 + 规则段；金标实体/场景 case 的数据基）──

export interface DeconChainFixture {
  matId: string;
  matRef: string;
  contentHash: string;
  derived: string;
  derivedHash: string;
  chapters: Material['chapters'];
  blocks: MaterialParagraphBlock[];
  material: () => Material;
}

const CH0 = [
  '李逍遥在青云观的后院醒来，李逍遥发现自己躺在一张竹床上。',
  '李逍遥在山下集市遇见了赵灵儿，赵灵儿正在溪边唱歌。',
  '李逍遥与赵灵儿约好明日一同去后山，李逍遥心里隐约不安。',
].join('\n\n');
const CH1 = [
  '赵灵儿约李逍遥去后山看瀑布，灵儿走在前面哼着歌。',
  '瀑布下的水潭边有一块古碑，李逍遥伸手触碰古碑，古碑忽然发出了微弱的光。',
  '夜里李逍遥回想起十年前的那个雨夜，师父冒雨背着他走过的山路。',
].join('\n\n');
const CH2 = [
  '赵灵兒被脚步声惊醒，赵灵兒披衣起身推开了房门。',
  '青云观的老道人找到了李逍遥他们，说山中有妖物出没。',
  '观中规矩：入夜后不可下山，弟子必须按时回房。',
].join('\n\n');

/**
 * 建 3 章 fixture（matId 十六进制 12 位——teachingId/craftTeachingAnchor 派生输入；
 * contentHash 每 fixture 唯一常量，稳定可复算）。
 */
export function createDeconChainFixture(matId: string, contentHashTail: string): DeconChainFixture {
  const bodies = [CH0, CH1, CH2];
  const normalized = bodies.join('\n\n');
  let off = 0;
  const boundaries = bodies.map((body, i) => {
    const start = off;
    off += body.length + (i < bodies.length - 1 ? 2 : 0);
    return { start, end: off, title: `第${i + 1}章` };
  });
  const { derived, spans } = composeDerivedText(normalized, boundaries, 'regex', 'high');
  const chapters: Material['chapters'] = spans.map((s, i) => ({
    index: i,
    title: `第${i + 1}章`,
    charStart: s.charStart,
    charEnd: s.charEnd,
    paraStart: 0,
    paraEnd: 0,
    confidence: 'high',
    method: 'regex',
  }));
  const contentHash = `sha256:${contentHashTail.padStart(64, '0').slice(0, 64)}`;
  const derivedHash = `sha256:${createHash('sha256').update(derived, 'utf8').digest('hex')}`;
  return {
    matId,
    matRef: `global:${matId}`,
    contentHash,
    derived,
    derivedHash,
    chapters,
    blocks: splitParagraphBlocks(derived),
    material: () => ({
      materialId: matId,
      scope: 'global',
      projectId: null,
      kind: 'prose',
      name: '全链集成测试小说',
      format: 'txt',
      provenance: {
        medium: 'novel_text',
        tier: 'original',
        sourcePath: 'novel.txt',
        via: 'direct-read',
        extractor: 'builtin-text',
        ingestedAt: '2026-09-05T00:00:00.000Z',
        author: '集成测试作者',
        lang: null,
        originDate: null,
        description: null,
      },
      quality: {
        ok: true,
        scanned: false,
        nonUtf8: false,
        parseNotes: [],
        charCount: derived.length,
        chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: [] },
      },
      chapters,
      chunkSpans: [],
      contentHash,
      status: 'ready',
    }),
  };
}

// ── P1b facts 响应（真实锚定——paraRange/quote 取自块文本；raw 形态 = LLM 输出契约）──

function factsJsonForChapter(fx: DeconChainFixture, chapterIndex: number, seg: { blockStart: number }): string {
  const b = seg.blockStart;
  const q = (k: number): string => fx.derived.slice(fx.blocks[b + k]!.start, fx.blocks[b + k]!.end);
  const entityRows =
    chapterIndex === 0
      ? [
          { name: '李逍遥', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
          { name: '赵灵儿', type: 'person', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
          { name: '青云观', type: 'place', paraRange: { start: b, end: b + 1 }, quote: q(0) },
          { name: '幻影真人', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
        ]
      : chapterIndex === 1
        ? [
            { name: '李逍遥', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
            { name: '灵儿', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
            { name: '古碑', type: 'item', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
          ]
        : [
            { name: '李逍遥', type: 'person', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
            { name: '赵灵兒', type: 'person', paraRange: { start: b, end: b + 1 }, quote: q(0) },
            { name: '老道人', type: 'person', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) },
          ];
  const events =
    chapterIndex === 0
      ? [{ what: '集市初遇', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }]
      : chapterIndex === 1
        ? [
            { what: '触碰古碑引异象', paraRange: { start: b + 1, end: b + 2 }, quote: q(1), kernel: true },
            { what: '回忆起十年前的雨夜', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) },
          ]
        : [{ what: '老道人示警妖物', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }];
  const edges =
    chapterIndex === 0
      ? [{ from: '李逍遥', to: '赵灵儿', kind: '相识', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }]
      : chapterIndex === 1
        ? [{ from: '灵儿', to: '李逍遥', kind: '同门', paraRange: { start: b, end: b + 1 }, quote: q(0) }]
        : [{ from: '赵灵兒', to: '李逍遥', kind: '同行', paraRange: { start: b, end: b + 1 }, quote: q(0) }];
  const foreshadow =
    chapterIndex === 1 ? [{ hint: '古碑来历不明', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }] : [];
  const infoGap =
    chapterIndex === 0
      ? [{ type: '爽感预期', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) }]
      : chapterIndex === 1
        ? [{ type: '悬疑未知', paraRange: { start: b + 1, end: b + 2 }, quote: q(1) }]
        : [{ type: '信息前置', paraRange: { start: b + 2, end: b + 3 }, quote: q(2) }];
  return JSON.stringify({
    synopsis: `【第${chapterIndex}章】李逍遥与赵灵儿的故事推进。`,
    entities: entityRows,
    events,
    relationshipEdges: edges,
    foreshadowPlanted: foreshadow,
    infoGap,
  });
}

// ── 全链复合 LLM mock（按 system 标记分派；counts 按类型计数供断言）──

export interface ChainMockCounts {
  classify: number;
  facts: number;
  adjudicate: number;
  portrait: number;
  recall: number;
  timeline: number;
  review: number;
  labels: number;
  p4: number;
  p5book: number;
  p5chapter: number;
  p5scene: number;
  /** E10.3b W7：p4:style 风格维（LLM 11 节面）。 */
  style: number;
  /** E10.3b W7：p6 落卡归类+浓缩。 */
  p6: number;
}

export function zeroChainCounts(): ChainMockCounts {
  return {
    classify: 0,
    facts: 0,
    adjudicate: 0,
    portrait: 0,
    recall: 0,
    timeline: 0,
    review: 0,
    labels: 0,
    p4: 0,
    p5book: 0,
    p5chapter: 0,
    p5scene: 0,
    style: 0,
    p6: 0,
  };
}

/** p6 落卡浓缩产物（固定——searchCraft 关键词「期待感」命中面）。 */
export const CHAIN_CONDENSED_TEXT = '开篇早埋人物情感钩，短间隔回收，让期待感快速立起来';

/**
 * 全链 mock（system 分派顺序：A 四面 → p3a → **p5 三 kind（先于 p4——P5 system 前置共用
 * 立场段）→ p4:style → p4 手艺 → p6**）。p4 findings 带 craftHint（章级首条——p6 候选源
 * + craft 闸门触发面）；章级 insight 含「期待感/钩」、弧级含「蓄放」（金标场景关键词基）。
 */
export function mkChainGenerate(fx: DeconChainFixture, counts: ChainMockCounts): DeconGenerateText {
  const DICT_TYPES: Record<string, string> = {
    李逍遥: 'person',
    赵灵儿: 'person',
    赵灵兒: 'person',
    灵儿: 'person',
    老道人: 'person',
    青云观: 'place',
    古碑: 'item',
  };
  return async (input) => {
    const system = input.system ?? '';
    const user = input.user;
    if (system.includes('实体词典分类器')) {
      counts.classify += 1;
      const candidates = [...user.matchAll(/^\d+ \| (.+?) \| \d+$/gm)].map((m) => m[1]!);
      const picked = candidates.filter((name) => DICT_TYPES[name] !== undefined);
      return { text: JSON.stringify(picked.map((name) => ({ name, type: DICT_TYPES[name], confidence: 0.9 }))) };
    }
    if (system.includes('事实层提取器')) {
      counts.facts += 1;
      const first = /【P(\d+)】/.exec(user);
      const blockStart = first === null ? 0 : Number(first[1]);
      const chapterIndex = Math.floor(blockStart / 3);
      return { text: factsJsonForChapter(fx, chapterIndex, { blockStart }) };
    }
    if (system.includes('实体消歧')) {
      counts.adjudicate += 1;
      const pairIds = [...user.matchAll(/^(\d+) \| /gm)].map((m) => m[1]!);
      return { text: JSON.stringify(pairIds.map((pairId) => ({ pairId, sameEntity: true }))) };
    }
    if (system.includes('角色档案整理器')) {
      counts.portrait += 1;
      const names = [...user.matchAll(/^【角色】([^（\n]+)/gm)].map((m) => m[1]!.trim());
      return {
        text: JSON.stringify({
          characters: names.map((name) => ({
            name,
            identity: `${name}的身份概括`,
            traits: [{ name: '侠义心', mutability: 'immutable' }],
            arc: `${name}的成长弧`,
            neverDo: '欺辱弱者',
          })),
        }),
      };
    }
    if (system.includes('设定档案整理器')) {
      counts.recall += 1;
      const paras = [...user.matchAll(/^【P(\d+)】(.*)$/gm)].map((m) => ({ p: Number(m[1]), text: m[2]!.replace(/……$/, '') }));
      if (paras.length < 2) return { text: '{"entries":[]}' };
      return {
        text: JSON.stringify({
          entries: [
            {
              name: '召回条目A',
              summary: '直接引用条目',
              paraRanges: [{ start: paras[0]!.p, end: paras[0]!.p + 1 }],
              quote: paras[0]!.text.slice(0, 10),
            },
            { name: '召回条目B', summary: '归纳条目', paraRanges: [{ start: paras[1]!.p, end: paras[1]!.p + 1 }] },
          ],
        }),
      };
    }
    if (system.includes('时间线标注器')) {
      counts.timeline += 1;
      const events = [...user.matchAll(/^(e\d+) \| 第\d+章 \| (.+)$/gm)].map((m) => ({ id: m[1]!, what: m[2]!.split('，')[0]! }));
      return {
        text: JSON.stringify({
          events: events.map((e, i) =>
            e.what.includes('回忆')
              ? { id: e.id, storyTimeLabel: '十年前的雨夜', timeOrder: 0, device: 'flashback' }
              : { id: e.id, storyTimeLabel: `第${i + 1}日`, timeOrder: i + 1 },
          ),
        }),
      };
    }
    if (system.includes('矛盾复核裁判')) {
      counts.review += 1;
      const ids = [...user.matchAll(/^(e\d+) \| /gm)].map((m) => m[1]!);
      return { text: JSON.stringify(ids.map((id) => ({ id, intentional: true }))) };
    }
    if (system.includes('计量打标器')) {
      counts.labels += 1;
      return {
        text: JSON.stringify({
          hooks: [],
          transitions: [],
          emotionalBeats: [],
          plotPhase: null,
          highlightSpans: [],
          expositionSpans: [],
          arcBoundary: null,
        }),
      };
    }
    if (system.includes('书级读法报告')) {
      counts.p5book += 1;
      return { text: '# 《全链集成测试小说》拆书读法\n\n## 整体结构判定\n\n递进阶梯式。' };
    }
    if (system.includes('写章评')) {
      counts.p5chapter += 1;
      return { text: '## 章导读\n\n本章落在行动解决环节。\n\n## 章收束\n\n钩子布设干脆。' };
    }
    if (system.includes('做细批')) {
      counts.p5scene += 1;
      return { text: '## 场景定位\n\n水潭边，古碑初现。' };
    }
    if (system.includes('风格分析师')) {
      counts.style += 1;
      return {
        text: JSON.stringify({
          sections: {
            voice: '叙述者贴近主角的有限视角，语气平实里带一点暖。',
            syntax: '多用短句推进，紧张处连续动词起句。',
            prohibitions: '避免大段静态描写，情绪不直陈。',
          },
        }),
      };
    }
    if (system.includes('手艺层分析师')) {
      counts.p4 += 1;
      const chapter = /【P(\d+)】(.+)/.exec(user);
      if (chapter !== null) {
        return {
          text: JSON.stringify({
            findings: [
              {
                insight: '开篇用人物情感钩立期待感',
                elaboration: '钩子出现早且第二章即回收，间隔短密度高。',
                evidence: [{ paraRange: { start: Number(chapter[1]), end: Number(chapter[1]) + 1 }, quote: chapter[2]!.slice(0, 8) }],
                craftHint: { category: 'qidaigan', termHint: '期待感节奏', tags: ['开篇', '期待感'] },
              },
              {
                insight: '次要发现不落卡',
                elaboration: '该条无落卡提示，供章评聚合。',
                evidence: [{ paraRange: { start: Number(chapter[1]), end: Number(chapter[1]) + 1 }, quote: chapter[2]!.slice(0, 8) }],
                craftHint: null,
              },
            ],
            synthesis: '本章期待感建立快。',
          }),
        };
      }
      const arc = /「(.+?)」@P(\d+)–P(\d+)/.exec(user);
      if (arc !== null) {
        return {
          text: JSON.stringify({
            findings: [
              {
                insight: '弧级蓄放结构清晰',
                elaboration: '压与放的章距拿捏得当，爽点兑现密度稳定。',
                evidence: [{ paraRange: { start: Number(arc[2]), end: Number(arc[3]) + 1 }, quote: arc[1] }],
                craftHint: null,
              },
            ],
            synthesis: '本弧期待管理稳定。',
          }),
        };
      }
      return { text: JSON.stringify({ findings: [], synthesis: '' }) };
    }
    if (system.includes('落卡整理器')) {
      counts.p6 += 1;
      const term = listCraftTerms({ status: 'active' }).find((t) => t.name === '节奏调剂子型');
      return {
        text: JSON.stringify({
          category: term?.category ?? 'qidaigan',
          termId: term?.termId ?? 'term-00000000',
          condensed: CHAIN_CONDENSED_TEXT,
          points: ['第一章内埋钩'],
          scenarios: ['开篇'],
          counterexamples: [],
          tags: ['开篇'],
          confidence: 0.8,
        }),
      };
    }
    return { text: '{}' };
  };
}

// ── handler 工厂（IPC 工厂 + 后台管线 promise 捕获）──

export interface DeconChainHandlers {
  handlers: DeconIpcHandlers;
  pipelineDone: () => Promise<DeconPassSequenceResult>;
  /** 进度事件（captureEvents=false 时恒空——生产 sendDeconProgress 无订阅者路径）。 */
  events: DeconProgressEvent[];
}

/**
 * 建 handler 集（runPipeline 注入链 mock 版）。`captureEvents=false` = **progress 丢弃模拟**
 * （不注入 notify——生产 sendDeconProgress 走 BrowserWindow 广播，无窗口时静默丢弃；
 * 测试经 invoke get 兜底读态——AC6）。
 */
export function buildChainHandlers(
  fx: DeconChainFixture,
  counts: ChainMockCounts,
  opts: { now?: () => Date; captureEvents?: boolean } = {},
): DeconChainHandlers {
  const events: DeconProgressEvent[] = [];
  let done: Promise<DeconPassSequenceResult> = Promise.resolve({ status: 'done' });
  const notify = opts.captureEvents === false ? undefined : (event: DeconProgressEvent) => events.push(event);
  const handlers = createDeconIpcHandlers({
    runPipeline: (jobId) => {
      const p = runDeconPassSequence(
        jobId,
        {
          generateText: mkChainGenerate(fx, counts),
          readDerivedText: () => fx.derived,
          ...(notify !== undefined ? { notify } : {}),
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        },
        notify,
      );
      done = p;
      return p;
    },
    readCurrentFingerprints: () => ({ materialContentHash: fx.contentHash, derivedHash: fx.derivedHash }),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(notify !== undefined ? { notify } : {}),
  });
  return { handlers, pipelineDone: () => done, events };
}

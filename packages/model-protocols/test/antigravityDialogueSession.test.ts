import { describe, expect, it } from 'vitest';
import type { GenerationMessage } from '@orison/shared-contracts';
import { buildTurnSegments, splitSystemMessages } from '../src/antigravityCli/compose';
import { diffMirror, hashSegments } from '../src/antigravityCli/mirror';

// ── AC3/AC4 mirror 侧集成断言（09-12 system 稳定化 CR-P9）──
//
// dialogue 车道布局落地后的 wire 组合形态验证（纯函数组合：compose 段组装 × mirror 内容
// 锚定，不跑真进程——driver 全链 fake 形态见 antigravityDriver.test）。布局事实：
//   - system = 恒定区（同会话无设定变更两轮字节相同）；
//   - 设定 = pinned 注入位（[Pinned Context] 稳定对，变更轮 wire 变一次 → diverge 一次后恢复）；
//   - 消息流 append-only（十三路信号变化以 user-role 状态注记尾追加，不再触碰 system）。
//
// wire 管线按 driver.generateText 真实序模拟：messages（system 首条 + pinned 对 + 历史）
// → splitSystemMessages → buildTurnSegments → hashSegments → diffMirror。

/** dialogue 一轮的 wire 段组装（mirror driver.generateText 管线）。 */
function dialogueTurnSegments(
  system: string,
  messages: GenerationMessage[],
  pinned?: string,
): string[] {
  const wireMessages: GenerationMessage[] = [
    { role: 'system', content: system },
    // pinned 注入位（agent 侧 messagesToPayload 既有形态：[Pinned Context] user +
    // Acknowledged. assistant 稳定对）；设定未编译（无 project.yaml）时无此对。
    ...(pinned !== undefined
      ? [
          { role: 'user' as const, content: `[Pinned Context]\n${pinned}` },
          { role: 'assistant' as const, content: 'Acknowledged.' },
        ]
      : []),
    ...messages,
  ];
  const { system: joined, rest } = splitSystemMessages(wireMessages);
  return buildTurnSegments(joined, rest);
}

/** 状态注记消息（system 稳定化后的高频信号载体——user-role 尾追加；content 形态 mirror
 * workflow.appendSessionStateNote 产物。kind 不跨 wire——以普通 user 消息透传）。 */
function stateNote(snapshot: string): GenerationMessage {
  return {
    role: 'user',
    content: [
      '[session state note — system-injected status, not user input]',
      '<session_state readonly="true">',
      snapshot,
      '</session_state>',
    ].join('\n'),
  };
}

/** 恒定区 system（leader yaml + 通用准则 + Project path + 引导行 + skills——全低频/静态段）。 */
const STABLE_SYSTEM = [
  '你是 Closure 工作台的 leader agent，负责与作者协作并派发写作链。',
  '---',
  '# Orison 通用写作准则……',
  'Project path: C:\\projects\\demo',
  'project.yaml 可经 read_file 读取；核心设定可经 query_story 检索。',
  '# Skills\n- chapter-chain: 写章链派发',
].join('\n');

/** 设定编译前缀（compileSettingPrefix 产物形态：lean 核心字段 + 可查指针）。 */
const SETTINGS_V1 =
  '### 主角·林晚\n核心欲望：查清母亲失踪真相（起点静态身份）\n可查详情：当前状态/关系（query_story: character/lin-wan）';
const SETTINGS_V2 =
  '### 主角·林晚\n核心欲望：查清母亲失踪真相（起点静态身份）\n### 世界·雾城\n暴雨常驻的沿海工业城\n可查详情：地理/势力（query_story: world/wu-city）';

describe('antigravityCli dialogue 会话组合形态（system 稳定化 × mirror，CR-P9）', () => {
  it('AC3 两轮 append：同 system/pinned、消息流追加（assistant/新输入/新注记）→ append + prefixLength', () => {
    const turn1Messages: GenerationMessage[] = [
      { role: 'user', content: '帮我规划第一章' },
      stateNote('当前管线阶段：大纲已锁定（snapshot A）'),
    ];
    const turn1 = dialogueTurnSegments(STABLE_SYSTEM, turn1Messages, SETTINGS_V1);
    // 首轮无镜像 → 冷启动（全量）。
    expect(diffMirror(undefined, hashSegments(turn1))).toEqual({ kind: 'cold-start' });

    // 第二轮：落盘发生过（snapshot 变化 → hash 门放行新注记）+ assistant 回复 + 新输入
    // ——消息流纯追加，system/pinned 不动。
    const turn2Messages: GenerationMessage[] = [
      ...turn1Messages,
      { role: 'assistant', content: '第一章的大纲方案：雨夜码头开场。' },
      { role: 'user', content: '开写第一章' },
      stateNote('当前管线阶段：第一章在写（snapshot B——mentionSignals 已更新）'),
    ];
    const turn2 = dialogueTurnSegments(STABLE_SYSTEM, turn2Messages, SETTINGS_V1);

    const mirror = hashSegments(turn1); // commit-on-write-success 语义（已发段 hash 序列）
    const decision = diffMirror(mirror, hashSegments(turn2));
    expect(decision).toEqual({ kind: 'append', prefixLength: turn1.length });

    // 增量 turn 只发尾段：新输入/新注记在场，指令块与 pinned 对不重发（缓存读形态学证据）。
    expect(decision.kind).toBe('append');
    if (decision.kind === 'append') {
      const tail = turn2.slice(decision.prefixLength);
      expect(tail.some((s) => s.includes('开写第一章'))).toBe(true);
      expect(tail.some((s) => s.includes('snapshot B'))).toBe(true);
      expect(tail.join('\n')).not.toContain('【系统指令】');
      expect(tail.join('\n')).not.toContain('[Pinned Context]');
    }
  });

  it('AC4 设定变更轮：pinned 字节变 → diverge 一次；镜像重置后同前缀追加 → append 恢复', () => {
    const turn1Messages: GenerationMessage[] = [
      { role: 'user', content: '第一章从哪切入？' },
      stateNote('snapshot A'),
    ];
    const turn1 = dialogueTurnSegments(STABLE_SYSTEM, turn1Messages, SETTINGS_V1);

    // 设定变更轮：syncDialogueSettingPrefix 重算 → pinned 注入位字节变（system 恒定区不动）。
    const turn2Messages: GenerationMessage[] = [
      ...turn1Messages,
      { role: 'assistant', content: '从雨夜码头切入。' },
      { role: 'user', content: '好，加入雾城设定后重排' },
      stateNote('snapshot B'),
    ];
    const turn2 = dialogueTurnSegments(STABLE_SYSTEM, turn2Messages, SETTINGS_V2);

    const mirror1 = hashSegments(turn1);
    expect(diffMirror(mirror1, hashSegments(turn2))).toEqual({ kind: 'diverge', reason: 'prefix-mismatch' });

    // diverge → 优雅关停 + restart 全量后，镜像重置为轮 2 段；第三轮同轮 2 system/pinned
    // + 消息纯追加 → append 恢复（变更成本 = 一次冷启，之后回到缓存读）。
    const mirror2 = hashSegments(turn2);
    const turn3Messages: GenerationMessage[] = [
      ...turn2Messages,
      { role: 'assistant', content: '已纳入雾城设定的重排方案：……' },
      { role: 'user', content: '就这个方案，开写' },
    ];
    const turn3 = dialogueTurnSegments(STABLE_SYSTEM, turn3Messages, SETTINGS_V2);
    expect(diffMirror(mirror2, hashSegments(turn3))).toEqual({ kind: 'append', prefixLength: turn2.length });
  });

  it('AC1 mirror 侧：system 不变 + 消息追加（状态注记只动消息段）→ append 命中——旧形态同变化全断', () => {
    // 落盘轮：十三路信号变化（staleFields/mentionSignals……）以追加注记呈现，system 字节不动。
    const turn1 = dialogueTurnSegments(STABLE_SYSTEM, [
      { role: 'user', content: '第二章继续' },
      stateNote('snapshot A：无 stale 字段'),
    ], SETTINGS_V1);
    const turn2 = dialogueTurnSegments(STABLE_SYSTEM, [
      { role: 'user', content: '第二章继续' },
      stateNote('snapshot A：无 stale 字段'),
      { role: 'assistant', content: '第二章正文已落地。' },
      { role: 'user', content: '检查涟漪' },
      stateNote('snapshot B：3 个 stale 字段待确认'),
    ], SETTINGS_V1);

    // 前缀稳定的 wire 级表达：指令块与 pinned 对逐字节相同，仅消息尾增长。
    expect(turn2[0]).toBe(turn1[0]);
    expect(turn2[1]).toBe(turn1[1]);
    expect(turn2[2]).toBe(turn1[2]);
    expect(diffMirror(hashSegments(turn1), hashSegments(turn2)).kind).toBe('append');

    // 反事实（旧形态）：同样的状态变化若仍由 system 尾部 interaction 段承载
    // （buildInteractionModeSegment 时代），段 0 变 → 前缀全断——拆分设计的红利对照。
    const legacySystem = (interaction: string): string => `${STABLE_SYSTEM}\n---\nInteraction Mode\n${interaction}`;
    const legacy1 = dialogueTurnSegments(legacySystem('stale: 无'), [], SETTINGS_V1);
    const legacy2 = dialogueTurnSegments(legacySystem('stale: 3 个待确认'), [], SETTINGS_V1);
    expect(diffMirror(hashSegments(legacy1), hashSegments(legacy2))).toEqual({ kind: 'diverge', reason: 'prefix-mismatch' });
  });
});

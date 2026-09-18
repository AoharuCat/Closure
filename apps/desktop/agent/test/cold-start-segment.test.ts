import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../src/types';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.6 Step 4：创作管线能力段〔九要点静态段〕+ 流程雷达三态段 + 偏好分档行 +
// 8.5 弧段 arc_timing 分档 + 作者档案行三态 + DEFAULT_ORISON_PROMPT 订正（D12）。
//
// 测试方法：loader / 快照构建函数非 exported → 经 sendMessage end-to-end 验。system 稳定化
// （09-12）+ CR-D1 拆分（09-13）后：静态能力段（管线九要点 / 风格卡 / 弧段 timing 双态行 /
// autonomy 契约）回 system 恒定区尾（buildMainRunConfig 拼 `---` 块——capabilityOnly 隔离断言）；
// 注记（kind='session_state_note'，user-role，`<session_state readonly="true">` 包裹）= 纯动态
// 状态快照（雷达 / 偏好分档行 / 弧段档位真值行 / 档案行）。generate mock 2 参回调：
// (system, note) 双面断言。DEFAULT_ORISON_PROMPT 静态文本仍断 system。档案路径经
// _setAuthorProfilePathForTest 钉到临时目录（真 ~/.orison 永不被测试触碰 + 断言确定性）。
//
// ⚠ runLoop 会把工具描述追加进 generate 收到的 system（appendToolDescriptions '# Available Tools'
// 段）。DEFAULT_ORISON_PROMPT 的否定断言（not.toContain）仍在 prompt+segments 隔离段
//（split '# Available Tools'）上做，防工具描述误报；注记消息不含工具描述，否定断言直接上
// note.content。
// ─────────────────────────────────────────────────────────────────────────────

type WorkflowModule = typeof import('../src/runtime/workflow');

/** 合法 character 卡（过 assetCardsSchema discriminatedUnion，mirror arc-coverage-segment.test.ts）。 */
const CHAR_CARD = {
  id: 'char-1', type: 'character', name: '林昭', tier: 'core', summary: '落魄贵女',
  narrative: { storyFunction: '主角' },
  desireAndBottomline: { coreDesire: '夺回家产' },
  personality: { coreTraits: ['隐忍'] },
};

/** 合法 location 卡（世界条目——location 专有字段全 optional，base 形态同 CHAR_CARD）。 */
const WORLD_CARD = {
  id: 'loc-1', type: 'location', name: '残云城', tier: 'micro', summary: '边陲小城',
  narrative: { storyFunction: '舞台' },
};

/** 合法 growth_curve 条目（readGrowthCurves 归一单源接受的最小形态）。 */
function curve(characterId: string): Record<string, unknown> {
  return { character_id: characterId, start_state: '隐忍求生', turning_points: [] };
}

/** 合法集纲条目（过 episodeOutlinesSchema）。 */
function episode(id: string, index: number, characterIds: string[]): Record<string, unknown> {
  return {
    id,
    index,
    title: `集-${id}`,
    character_progressions: characterIds.map((cid) => ({ characterId: cid, from: 'A', to: 'B' })),
  };
}

describe('Story 8.6 — 创作管线能力段 + 流程雷达三态 + 弧段 arc_timing 分档 + 作者档案注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-cold-start-'));
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

  /** prompt+segments 隔离段（剥掉 runLoop 追加的工具描述，防 not.toContain 误报）。 */
  function promptOnly(system: string): string {
    return system.split('# Available Tools')[0];
  }

  /**
   * 静态能力段隔离（CR-D1 拆分）：capability 段 = system 尾 `---` 块（buildMainRunConfig 拼），
   * 剥 DEFAULT_ORISON_PROMPT / path 行 / skills 与 runLoop 追加的工具描述——能力段断言打在此段。
   */
  function capabilityOnly(system: string): string {
    return promptOnly(system).split('\n\n---\n').pop() ?? '';
  }

  /**
   * 跑一轮对话，generate mock 断言。1 参 system = 恒定区（DEFAULT_ORISON_PROMPT / path 行 /
   * 引导行 / skills / 静态能力段〔CR-D1 拆分回system〕/ 工具描述），2 参 note = session_state_note
   * 注记（纯动态状态快照：雷达 / 偏好行 / 档案行；turn 开始 hash 门追加——首轮必发一条）。
   * 档案路径默认钉到临时项目目录（缺文件 = 合法空档案）；configure 可改写 override（degraded /
   * 有档案用）；permissionMode 可指定会话档位（CR-023 readonly 条件化用）。
   */
  async function runTurn(
    expectTurn: (system: string, note: SessionMessage | undefined) => void,
    configure?: (mod: WorkflowModule) => void,
    permissionMode?: 'readonly' | 'suggest' | 'auto',
  ): Promise<void> {
    const mod = await import('../src/runtime/workflow');
    mod._setAuthorProfilePathForTest(path.join(projectPath, 'author_profile.md'));
    configure?.(mod);
    const generate = vi.fn(async (messages: SessionMessage[], system: string) => {
      expectTurn(system, messages.find((m) => m.kind === 'session_state_note'));
      return { content: 'ok', finishReason: 'stop' };
    });
    const runtime = mod.createWorkflowRuntime({ generate });
    const session = runtime.createSession({
      agentName: 'writer',
      projectPath,
      ...(permissionMode ? { mode: permissionMode } : {}),
    });
    await runtime.sendMessage({
      sessionId: session.id,
      content: '写点什么',
      abortSignal: new AbortController().signal,
    });
    expect(generate).toHaveBeenCalledOnce();
  }

  // ── 管线能力段（静态，无条件注入，design §3.3 九要点）──

  it('管线能力段常驻注入（system 恒定区）：身份/旅程地图/判型五方向/第一问/五档路由/派发协议/主动时机/克制/档案', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((system) => {
      const seg = capabilityOnly(system);
      // ① 身份与姿态（照 8.5 posture 句式）。
      expect(seg).toContain('带着作者把书写完的编辑');
      expect(seg).toContain('主动找上他');
      // ② 旅程地图（特殊名词就地解释：集纲/卷）。
      expect(seg).toContain('集纲＝每一集的规划');
      expect(seg).toContain('一个阶段就是一卷');
      expect(seg).toContain('各站不必按序走全');
      // ③ 判型五方向（原理思路整理第一步）。
      expect(seg).toContain('情节片段');
      expect(seg).toContain('宏观世界设定');
      expect(seg).toContain('金手指/卖点');
      expect(seg).toContain('情感/情绪体验');
      expect(seg).toContain('还有爽点衔接');
      // ④ 第一问协议 + 两工具。
      expect(seg).toContain('一句话、一个人物、一个画面都行');
      expect(seg).toContain('不要急着让作者做选择题');
      expect(seg).toContain('creative_brief_update');
      expect(seg).toContain('creative_preferences_update');
      // CR-014：新手推荐档名对齐 prd R3（轻装上阵/骨架先行/深谋远虑——旧「轻车上路」已正名）。
      expect(seg).toContain('轻装上阵');
      expect(seg).not.toContain('轻车上路');
      // ⑤ 五档「怎么补」路由（六步法前两步话术 + 挂场锚）。
      expect(seg).toContain('这一章的情节事件与欲望目标是什么');
      expect(seg).toContain('欲望目标＝主角要去干什么');
      expect(seg).toContain('把场挂到这一集');
      expect(seg).toContain('提议开写');
      // ⑥ 派发协议（GAP-1/2/3/4：intent 带结论 / 范围随偏好 / 挂场锚归 leader / readonly 不派发）。
      expect(seg).toContain('dispatch_story_planner');
      expect(seg).toContain('dispatch_episode_planner');
      expect(seg).toContain('写进要求');
      expect(seg).toContain('只产第一卷');
      expect(seg).toContain('集纲落定后把场挂到各集');
      expect(seg).toContain('规划员不管这步');
      expect(seg).toContain('微操档时不派规划员');
      // ⑦ 主动时机表（含 arc_timing 两分支措辞）。
      expect(seg).toContain('灵感记下后');
      expect(seg).toContain('提议搭大纲');
      expect(seg).toContain('提议开写第一章');
      // ⑧ 克制条款（单会话生效）。
      expect(seg).toContain('不要每轮重复刷屏');
      expect(seg).toContain('新开对话');
      // ⑨ 档案协议。
      expect(seg).toContain('author_profile_update');
      expect(seg).toContain('不得用档案推断本项目的创作偏好');
      expect(seg).toContain('记倾向不记禁令');
      // 段预算（design §3.3 ~60 行 / dispatch ≤70 行）：管线能力段实测行数守门
      //（CR-D1 拆分后终点 = 同在 system 恒定区的「设定深化能力」节头）。
      const segStart = seg.indexOf('创作管线（');
      const segEnd = seg.indexOf('设定深化能力（设定助手）');
      const pipelineSegment = seg.slice(segStart, segEnd);
      expect(pipelineSegment.trim().length).toBeGreaterThan(0);
      expect(pipelineSegment.split('\n').length).toBeLessThanOrEqual(70);
    });
  });

  // ── 风格卡问（风格卡片 MVP B 路 R2：挂在第一问偏好问后的同轮自然时机）──

  it('风格卡问常驻能力段（system 恒定区）：三步协议 + 可跳过措辞 + 零参数直派 + 换文风同链', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((system) => {
      const seg = capabilityOnly(system);
      // 问意愿（挂第一问偏好问后）+ 可跳过硬措辞（prd R2：可跳过，跳过链照跑）。
      expect(seg).toContain('有没有想模仿的文风');
      expect(seg).toContain('完全可跳过，跳过不影响任何功能');
      // 三步协议：① request_style_input 收集（≥300 字 + 备注）② 零参数直派（工具自取最近提交，
      // leader 不转述原文——D4 直传铁律 prompt 侧表达）③ 人审卡落盘。
      expect(seg).toContain('request_style_input');
      expect(seg).toContain('dispatch_style_analyzer');
      expect(seg).toContain('零参数');
      expect(seg).toContain('你不要转述原文');
      expect(seg).toContain('settings/style.md');
      // 存量项目换文风 = 对话说一声再走同链（整卡替换）。
      expect(seg).toContain('换文风');
      expect(seg).toContain('整卡替换');
    });
  });

  it('风格卡问 readonly 档不注入（system 恒定区条件行，CR-023：三步协议第②步 dispatch_style_analyzer 被 toolPolicy 滤掉——宣传被滤工具的协议引导 leader 撞墙）', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn(
      (system) => {
        const seg = capabilityOnly(system);
        // 风格卡三步协议整段不出（协议文案锚点逐个否定——capability 隔离段防工具描述误报）。
        expect(seg).not.toContain('有没有想模仿的文风');
        expect(seg).not.toContain('完全可跳过，跳过不影响任何功能');
        expect(seg).not.toContain('dispatch_style_analyzer');
        expect(seg).not.toContain('settings/style.md');
        // 能力段其余要点照常（条件化只摘风格卡行，不伤管线段）。
        expect(seg).toContain('带着作者把书写完的编辑');
        expect(seg).toContain('第一问（项目还什么都没有时）');
        // readonly 档位行在场（对照——确认本测试确实跑在 readonly 会话上）。
        expect(seg).toContain('Autonomy = 微操 (readonly)');
      },
      undefined,
      'readonly',
    );
  });

  // ── 流程雷达三态（design §3.2）──

  it('雷达 no 态（coldStart 全空）：接第一问协议，不出清单', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('创作旅程现状');
      expect(snapshot).toContain('这是一个刚起步的项目');
      expect(snapshot).toContain('先接住作者想写什么');
      expect(snapshot).toContain('见「创作管线」段的「第一问」');
      expect(snapshot).toContain('不要急着让作者做选择');
      expect(snapshot).not.toContain('还没有的站');
    });
  });

  it('雷达 has 态（各站计数 + writeReadyLikely 接缝含「写时仍会做逐章检查」）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女在灵气复苏的世界夺回家产', genre: '仙侠' },
      asset_cards: [CHAR_CARD, WORLD_CARD],
      outline_v2: { phases: [{ id: 'p1' }, { id: 'p2' }] },
      scene_graph: { nodes: [{ id: 's1' }, { id: 's2' }] },
      growth_curve: [curve('char-1')],
      episode_outlines: [episode('ep1', 0, ['char-1'])],
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('灵感已记');
      expect(snapshot).toContain('角色 1');
      expect(snapshot).toContain('世界条目 1');
      expect(snapshot).toContain('大纲 2 卷');
      expect(snapshot).toContain('场结构 2');
      expect(snapshot).toContain('成长弧 1');
      expect(snapshot).toContain('集纲 1 集');
      // D9：writeReadyLikely 措辞不架空 gate（写时仍逐章检查）。
      expect(snapshot).toContain('看起来可以开写——写时仍会做逐章检查');
      // 全站齐 → 不列缺口（防清单疲劳）。
      expect(snapshot).not.toContain('还没有的站');
    });
  });

  it('雷达 has 态（部分站）：只列缺口站，成长弧缺不列（归弧覆盖段单管）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产', genre: '仙侠' },
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('灵感已记');
      expect(snapshot).toContain('还没有的站：角色卡、世界、大纲与场结构、集纲');
      // 成长弧缺口归 8.5「弧覆盖」段单管（防两段双报矛盾）。
      expect(snapshot).not.toContain('还没有的站：角色卡、世界、大纲与场结构、集纲、成长弧');
      expect(snapshot).not.toContain('看起来可以开写');
    });
  });

  it('雷达 missing CR-007：(卷=0, 场>0) 大纲独立报（旧分支大纲静默漏报——三态对称补齐）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产' },
      scene_graph: { nodes: [{ id: 's1' }, { id: 's2' }] },
    });
    await runTurn((_system, note) => {
      // 场结构已有不报；大纲独立报（不再只在场也缺时以「大纲与场结构」合报）。
      // ⚠ 雷达行 = have + missing 同行，静态管线段也含「场结构」——断言锚定 missing 段内。
      const missingPart = ((note?.content ?? '').split('\n').find((l) => l.includes('还没有的站')) ?? '').split('还没有的站：')[1] ?? '';
      expect(missingPart).toContain('角色卡、世界、大纲、集纲');
      expect(missingPart).not.toContain('场结构');
      expect(missingPart).not.toContain('大纲与场结构');
    });
  });

  it('雷达 missing CR-007 对称分支：(卷>0, 场=0) 场结构独立报（既有行为回归锚）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产' },
      outline_v2: { phases: [{ id: 'p1' }] },
    });
    await runTurn((_system, note) => {
      const missingPart = ((note?.content ?? '').split('\n').find((l) => l.includes('还没有的站')) ?? '').split('还没有的站：')[1] ?? '';
      expect(missingPart).toContain('角色卡、世界、场结构、集纲');
      expect(missingPart).not.toContain('大纲');
      expect(missingPart).not.toContain('大纲与场结构');
    });
  });

  it('雷达 CR-009：yaml 显式 creative_brief: null（空键）归一合法空——不整雷达 degraded', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: null,
      creative_preferences: null,
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      // null 键 = 手编/工具降级常见形态，同缺省 = 合法空——雷达照常工作（冷启动态）。
      expect(snapshot).not.toContain('创作旅程现状：暂不可读');
      expect(snapshot).toContain('这是一个刚起步的项目');
      // creative_preferences: null 同归一 = 未问（非偏好「数据异常」行）。
      expect(snapshot).not.toContain('作者工作方式：数据异常');
    });
  });

  it('雷达 degraded（project.yaml 不可读）：单行暂不可用 + 静态能力段照常（CR-D1 拆分：system 恒定区不受状态降级影响）', async () => {
    await runTurn((system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('创作旅程现状：暂不可读');
      expect(snapshot).toContain('本轮不提供阶段信息');
      // 管线能力段仍常驻（静态段与状态段独立——CR-D1 拆分后进 system 恒定区）。
      expect(capabilityOnly(system)).toContain('带着作者把书写完的编辑');
      // 弧段 timing 静态双态行照常（CR-D1 拍板 B：档位分支静态化，偏好真值归注记「作者工作方式」行）。
      expect(capabilityOnly(system)).toContain('大纲的阶段（卷）划好后');
      expect(capabilityOnly(system)).toContain('排集纲前');
    });
  });

  it('雷达 degraded（creative_preferences 形态坏）：CR-008 粒度修正——雷达其他事实保留 + 偏好单行如实告知（不整雷达弃守）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_preferences: { outline_depth: 'not-a-valid-axis' },
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      // 偏好坏不再拖垮整雷达（旧 return null → 暂不可读是静默弃守）——各站事实照常注入。
      expect(snapshot).not.toContain('创作旅程现状：暂不可读');
      expect(snapshot).toContain('创作旅程现状');
      // 单行如实告知：数据异常按标准档（mirror 弧覆盖「坏数据优先如实告知」第四态）。
      expect(snapshot).toContain('作者工作方式：数据异常，本轮按标准档处理（修复 project.yaml 的 creative_preferences 后恢复）');
      // 坏偏好不可信不判档——轴标签行不出。
      expect(snapshot).not.toContain('作者工作方式（作者自己选的）');
      // preferencesSet=false（不可信不判）+ 坏数据态优先——CR-013 补问信号行也不出（数据坏 ≠ 没问过）。
      expect(snapshot).not.toContain('还没问过');
    });
  });

  it('雷达 degraded（compileSettingPrefix 值级坏 yaml 抛错，CR-004）：warn + null 单行，不再每 turn 崩 leader', async () => {
    // genre:123（非 string）——compileSettingPrefix 的 push() 对其调 .trim() 抛 TypeError。
    writeProjectYaml({
      name: 'Test',
      creative_brief: { genre: 123 },
    });
    await runTurn((system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('创作旅程现状：暂不可读');
      expect(snapshot).toContain('本轮不提供阶段信息');
      // 管线能力段仍常驻（静态段不受状态段降级影响——CR-D1 拆分后进 system 恒定区）。
      expect(capabilityOnly(system)).toContain('带着作者把书写完的编辑');
    });
  });

  // ── 偏好分档行（preferencesSet + 轴值人话映射，纯代码对照表）──

  it('偏好行：四轴组合 + 人话映射（skeleton/as_you_go/shell/framework）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产' },
      creative_preferences: {
        outline_depth: 'skeleton',
        arc_timing: 'as_you_go',
        world_depth: 'shell',
        character_depth: 'framework',
      },
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('作者工作方式（作者自己选的）');
      expect(snapshot).toContain('大纲骨架 · 弧边写边列 · 世界空壳后填 · 人物骨架');
      expect(snapshot).toContain('引导按此节奏');
      // CR-014：design §3.2 指定负面约束——勿催未选档位的细度（缺了它，选骨架档的作者仍被催细纲）。
      expect(snapshot).toContain('勿催作者未选档位的细度');
      expect(snapshot).toContain('除非作者本人改选别的档位');
    });
  });

  it('偏好行：另一组轴值映射（volume/upfront〔弧〕/upfront〔世界〕/full）', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产' },
      creative_preferences: {
        outline_depth: 'volume',
        arc_timing: 'upfront',
        world_depth: 'upfront',
        character_depth: 'full',
      },
    });
    await runTurn((_system, note) => {
      expect(note?.content).toContain('大纲分卷 · 弧写前列 · 世界先铺 · 人物全填');
    });
  });

  it('偏好行：note-only（作者说随便你定）也算已问，轴标签行不出', async () => {
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产' },
      creative_preferences: { note: '随便你定' },
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('作者工作方式：已问过，作者没有选具体档位');
      expect(snapshot).toContain('不必再问一遍');
      expect(snapshot).not.toContain('作者工作方式（作者自己选的）');
    });
  });

  it('偏好行 CR-013：未问 + 非冷启动 → 补问信号行（找个自然时机问一次，不必马上追问）', async () => {
    // 非冷启动（灵感已记）+ 无 creative_preferences——作者跳过第一问直接用面板起步的形态。
    writeProjectYaml({
      name: 'Test',
      creative_brief: { rawRequirement: '复仇少女夺回家产' },
    });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('作者工作方式：还没问过');
      expect(snapshot).toContain('找个自然时机');
      expect(snapshot).toContain('不必马上追问');
      // 轴标签行仍不出（未问 ≠ 已问无档位）。
      expect(snapshot).not.toContain('作者工作方式（作者自己选的）');
    });
  });

  it('偏好行 CR-013：冷启动不注补问信号（第一问协议本就含顺势问偏好——重复信号是噪音）', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((_system, note) => {
      expect(note?.content).not.toContain('还没问过');
    });
  });

  // ── 8.5 弧段 timing（CR-D1 拆分拍板 B）：双分支静态化进 system 恒定区——写前列 / 边写边列
  // 两分支并列（不再随偏好裁剪），档位真值归注记「作者工作方式」行（动态段承载）。──

  it('弧段 timing 静态双态并列（未问/缺省 fixture）：写前列 + 边写边列两分支同在 system', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      const seg = capabilityOnly(system);
      // 双态并列行头（含未问回退提示：还没问过则按写前列引导并顺带补问）。
      expect(seg).toContain('提议时机按作者选的节奏对号');
      expect(seg).toContain('还没问过则按写前列引导并顺带补问');
      // 写前列分支三时机。
      expect(seg).toContain('重要角色的卡落定后');
      expect(seg).toContain('大纲的阶段（卷）划好后');
      expect(seg).toContain('排集纲前');
      // 边写边列分支 + 「始终没人管」点破兜底（双态并列——静态行不再随偏好裁剪）。
      expect(seg).toContain('写了几章、人物立起来后');
      expect(seg).toContain('成长线始终没人管');
    });
  });

  it('弧段 timing 静态不随偏好变（upfront fixture）：system 双态行照在；档位真值由注记「弧写前列」行承载', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      creative_preferences: { arc_timing: 'upfront' },
    });
    await runTurn((system, note) => {
      const seg = capabilityOnly(system);
      expect(seg).toContain('提议时机按作者选的节奏对号');
      expect(seg).toContain('重要角色的卡落定后');
      // 档位真值归动态注记（作者工作方式行）。
      expect(note?.content).toContain('作者工作方式（作者自己选的）');
      expect(note?.content).toContain('弧写前列');
    });
  });

  it('弧段 timing 静态不随偏好变（as_you_go fixture）：写前列三分支照在不再裁剪；档位真值由注记「弧边写边列」行承载', async () => {
    writeProjectYaml({
      name: 'Test',
      asset_cards: [CHAR_CARD],
      creative_preferences: { arc_timing: 'as_you_go' },
    });
    await runTurn((system, note) => {
      const seg = capabilityOnly(system);
      // 双态并列：作者选了边写边列，写前列三分支也照在（静态行不随偏好裁剪——CR-D1 拍板 B）。
      expect(seg).toContain('写了几章、人物立起来后');
      expect(seg).toContain('正合作者定的节奏');
      expect(seg).toContain('重要角色的卡落定后');
      expect(seg).toContain('成长线始终没人管');
      // 档位真值归动态注记。
      expect(note?.content).toContain('作者工作方式（作者自己选的）');
      expect(note?.content).toContain('弧边写边列');
    });
  });

  // ── DEFAULT_ORISON_PROMPT 订正（D12：Project Structure 换 Closure 实际；relay 句扩指管线段）──
  // 本组断言面在 system 恒定区（DEFAULT_ORISON_PROMPT 静态文本）——不随状态注记迁移。

  it('DEFAULT_ORISON_PROMPT：story-memory.yaml 零残留 + Closure 实际结构三行 + relay 句扩指管线段', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((system) => {
      const prompt = promptOnly(system);
      expect(prompt).toContain('## Project Structure');
      expect(prompt).toContain('project.yaml');
      expect(prompt).toContain('设定卡 / 大纲 / 集纲 / 场结构 / 曲线');
      expect(prompt).toContain('.orison/');
      // OrisonSpace 遗产死事实零残留（D12 幻觉源清除）。
      expect(prompt).not.toContain('story-memory.yaml');
      expect(prompt).not.toContain('outlines/');
      // gate relay 句扩指管线段「怎么补」路由。
      expect(prompt).toContain('还缺什么怎么补');
    });
  });

  // ── 作者档案注入三态（D7）──

  it('档案有内容：注入摘录行 + 档案内容在场', async () => {
    writeProjectYaml({ name: 'Test' });
    writeFileSync(
      path.join(projectPath, 'author_profile.md'),
      '## 2026-08-18 09:00\n新手作者，偏爱短段落回复，别一次给三个方案。\n',
      'utf8',
    );
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('作者档案摘录');
      expect(snapshot).toContain('偏爱短段落回复');
      expect(snapshot).toContain('不得据此推断本项目的创作偏好');
    });
  });

  it('档案缺文件：合法空档案，不注行', async () => {
    writeProjectYaml({ name: 'Test' });
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).not.toContain('作者档案摘录');
      expect(snapshot).not.toContain('作者档案：暂不可读');
    });
  });

  it('档案超长：机械截断保尾部（最新观察）+ 标注，头部已略', async () => {
    writeProjectYaml({ name: 'Test' });
    const longProfile = `HEAD_MARKER\n${'观察记录。'.repeat(2000)}\nTAIL_MARKER`;
    expect(longProfile.length).toBeGreaterThan(8000);
    writeFileSync(path.join(projectPath, 'author_profile.md'), longProfile, 'utf8');
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('档案较长');
      expect(snapshot).toContain('仅保留最近的观察记录');
      // 追加式档案最新在尾——尾部保留，头部掐掉。
      expect(snapshot).toContain('TAIL_MARKER');
      expect(snapshot).not.toContain('HEAD_MARKER');
    });
  });

  it('档案超长 CR-011：截断点落在代理对中间时退一位（不产孤儿低代理乱码）', async () => {
    writeProjectYaml({ name: 'Test' });
    // 长度 8004（> 8000）：start = 4 恰是第一对代理的**低位**（索引 3=高 4=低）——旧代码按
    // code unit 切会把孤儿低代理留在段首（乱码）；CR-011 退一位从完整代理对起切。
    const profile = `xxx${'𝐀'.repeat(4000)}Z`;
    expect(profile.length).toBe(8004);
    writeFileSync(path.join(projectPath, 'author_profile.md'), profile, 'utf8');
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      expect(snapshot).toContain('档案较长');
      const noteIdx = snapshot.indexOf('仅保留最近的观察记录');
      expect(noteIdx).toBeGreaterThan(0);
      // 标注行后首字符 = 截断段首——须是高代理（完整对的开头），非孤儿低代理（0xDC00-0xDFFF）。
      const contentStart = snapshot.indexOf('\n', noteIdx) + 1;
      const firstCode = snapshot.charCodeAt(contentStart);
      expect(firstCode >= 0xd800 && firstCode <= 0xdbff).toBe(true);
      // 尾部完整保留。
      expect(snapshot).toContain('Z');
    });
  });

  it('档案读失败（存在但读不了，如目录）：单行 degraded', async () => {
    writeProjectYaml({ name: 'Test' });
    const dirAsFile = path.join(projectPath, 'profile-as-dir');
    mkdirSync(dirAsFile);
    await runTurn(
      (_system, note) => {
        const snapshot = note?.content ?? '';
        expect(snapshot).toContain('作者档案：暂不可读');
        expect(snapshot).toContain('本轮不注入档案');
        expect(snapshot).not.toContain('作者档案摘录');
      },
      (mod) => {
        mod._setAuthorProfilePathForTest(dirAsFile);
      },
    );
  });

  it('档案不反哺偏好（红线：注入档案含偏好字样，radar 偏好行仍不出）', async () => {
    writeProjectYaml({ name: 'Test' });
    writeFileSync(
      path.join(projectPath, 'author_profile.md'),
      '## 2026-08-18 09:00\n上个项目里作者工作方式偏大纲骨架，本项目未必。\n',
      'utf8',
    );
    await runTurn((_system, note) => {
      const snapshot = note?.content ?? '';
      // 档案内容注入在场……
      expect(snapshot).toContain('作者档案摘录');
      expect(snapshot).toContain('上个项目里');
      // ……但偏好行不因档案出现（preferencesSet 只由 creative_preferences 决定）。
      expect(snapshot).not.toContain('作者工作方式（作者自己选的）');
      expect(snapshot).not.toContain('作者工作方式：已问过');
    });
  });
});

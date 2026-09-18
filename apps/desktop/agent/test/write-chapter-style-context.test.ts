import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshot, RunSnapshotSummary } from '../src/contracts/run';
import { buildDraftWriterVars } from '../src/nodes/chapter-nodes';
import { parseAgentPromptYaml } from '../src/prompt/agentPrompt';
import { renderTemplate } from '../src/prompt/template';

// ─────────────────────────────────────────────────────────────────────────────
// 风格卡片 MVP（task 08-28-style-card-mvp B 路 R5）：write_chapter 消费侧装配测试。
//
// mirror write-chapter-tool.test.ts harness（mock skillExecutor.runChapterChain → 断言
// initialArtifacts）。四态中的三态在 style-card.test.ts 纯函数层已钉；本文件钉**注入面**：
// 1. 无卡零回归：initialArtifacts 键集与旧版逐字节一致（inline snapshot——无 style_* key，AC3）
//    + AC3 值级断言（CR-018）：buildDraftWriterVars / 两 yaml 实文件渲染的 styleContext 为空串、
//    无残留空白行（非仅键集）。
// 2. 有卡：style_context（全量 ①-⑫〔含⑫禁则 CR-003〕+节选）注入；style_context_brief **不注入**
//    （CR-006：精简版真实消费路径是 dispatch-planners 派发时现读现编，链内零消费者）。
// 3. 无①-⑫节但有⑬ fenced 的卡：style_context 走节选路径仍注入（纯增益不挑卡形态）。
// ─────────────────────────────────────────────────────────────────────────────

const SHORT_EXCERPT = '他推门进来，风先到。桌上的茶凉了半盏，他没有喝，只是站着看了一会儿，然后转身走了。';

/** 完整卡 fixture（①-⑭；节选短于 cap）。 */
function fullCardBody(): string {
  return [
    '# 风格卡片',
    '',
    '> 分工注记行。',
    '',
    '## ① 声音画像',
    '冷静旁观，带一点悲悯。',
    '',
    '## ② 机械统计（代码预计算）',
    '',
    '句长中位数：18 字',
    '',
    '## ③ 句法与文字节奏',
    '长短交替呼吸。',
    '',
    '## ④ 叙事节奏',
    '场景硬切。',
    '',
    '## ⑤ 对话',
    '动作代标签。',
    '',
    '## ⑥ 描写的取舍',
    '一个精确细节。',
    '',
    '## ⑦ 意象与比喻思维',
    '喻体取自农事。',
    '',
    '## ⑧ 情绪手法',
    '情绪外化为身体反应。',
    '',
    '## ⑨ 信息处理',
    '读者先知。',
    '',
    '## ⑩ 人物呈现法',
    '行动立人。',
    '',
    '## ⑪ 期待管理',
    '章尾悬崖切。',
    '',
    '## ⑫ 禁则',
    '不用感叹号。',
    '',
    '## ⑬ 节选（few-shot）',
    '',
    '```text',
    SHORT_EXCERPT,
    '```',
    '',
    '## ⑭ 原文附录',
    '',
    '```text',
    '完整原文……',
    '```',
    '',
  ].join('\n');
}

const SUMMARY_OK: RunSnapshotSummary = {
  status: 'completed',
  routeDecision: { decision: 'accept_as_truth', reason: '正文升级' },
  reviewVerdict: 'pass',
  draftTitle: '第二章 B 城',
  draftWordCount: 2800,
  errors: [],
  chapter_accept: {
    chapterId: 'ch_001',
    candidate: { title: '第二章 B 城', content: '正文…', wordCount: 2800 },
    runId: 'run_mock',
  },
};

describe('write_chapter：风格卡消费侧装配（B 路 R5）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-style-'));
    runChapterChain = vi.fn();
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: {
        runChapterChain,
        runSubagent: vi.fn(),
        executeSkillByName: vi.fn(),
      },
    };
    // 裸 registry（不 registerBuiltinTools）——world_state/cognition/presence/arc_snapshot 等
    // registry-driven optional 注入自然缺席，与 write-chapter-tool.test.ts 同形态。
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeProjectYaml(): void {
    const doc = {
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市', '奇幻'] },
      world_setting: { premise: '灵气复苏的现代都市' },
      asset_cards: [
        {
          id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
          narrative: { storyFunction: '主角' },
          desireAndBottomline: { coreDesire: '变强守护家族' },
          personality: { coreTraits: ['坚韧'] },
        },
      ],
      scene_graph: {
        nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }],
        edges: [],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging' }],
      },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  function writeStyleCard(body: string): void {
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(path.join(projectPath, 'settings', 'style.md'), `---\nid: style\ntype: style\n---\n${body}`, 'utf8');
  }

  it('无卡零回归：initialArtifacts 键集与旧版逐字节一致（无 style_* key，AC3 快照）+ 值级断言（CR-018）', async () => {
    writeProjectYaml();
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'G' } }, ctx);

    expect(runChapterChain).toHaveBeenCalledTimes(1);
    const artifacts = runChapterChain.mock.calls[0]![1] as Record<string, unknown>;
    // B 路前旧版键集逐字节钉死（assemble 9 键 + episode_outlines + asset_cards post-assemble）——
    // 无卡时本任务不得新增/删除任何 key（风格卡纯增益，AC3）。
    expect(Object.keys(artifacts).sort()).toMatchInlineSnapshot(`
      [
        "asset_cards",
        "chapter_brief_input",
        "emotion_curve",
        "episode_outlines",
        "genreContract",
        "info_release_map",
        "promise_registry",
        "scene_graph",
        "settings_context",
        "settings_context_report",
        "story_decisions",
      ]
    `);
    expect(artifacts['style_context']).toBeUndefined();
    expect(artifacts['style_context_brief']).toBeUndefined();

    // ── AC3 值级升级（CR-018）：非仅键集——无卡时写手/精修 vars 的 styleContext 是空串，
    // 且两 yaml 实文件渲染后无「仅空白」残留行（slot 行塌净空行）。──
    const emptyRun = { artifacts: {} } as unknown as RunSnapshot;
    expect(buildDraftWriterVars(emptyRun).styleContext).toBe('');
    // targeted-revision 同款 slot 校验已随 W4 F-1 清理退役（yaml 已删）；draft-writer 真实 yaml
    //（生产 parseAgentPromptYaml + renderTemplate，js-yaml 剥块缩进）+ 空 styleContext 渲染——
    // 断言渲染产物无 /^[ \t]+$/ 行。
    {
      const raw = readFileSync(path.join(__dirname, '..', 'prompts', 'draft-writer-agent.yaml'), 'utf8');
      const { userTemplate } = parseAgentPromptYaml(raw);
      const rendered = renderTemplate(userTemplate, {
        // 模板 slot 全给占位值，可选块（styleContext/revisionFeedback/revisionIntent）空串。
        chapterTask: 'T', storyPlan: 'S', projectContext: 'P',
        styleContext: '', revisionFeedback: '', revisionIntent: '',
      });
      expect(rendered).not.toMatch(/^[ \t]+$/m);
    }
  });

  it('有卡：style_context（全量 ①-⑫〔含⑫禁则 CR-003〕+节选）注入；style_context_brief 不注入（CR-006 零消费者）', async () => {
    writeProjectYaml();
    writeStyleCard(fullCardBody());
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'G' } }, ctx);

    const artifacts = runChapterChain.mock.calls[0]![1] as Record<string, unknown>;
    // 全量版：①-⑫ + 节选 fenced；frontmatter 已剥（不进注入）。
    const styleContext = artifacts['style_context'];
    expect(typeof styleContext).toBe('string');
    expect(styleContext as string).toContain('## ① 声音画像');
    expect(styleContext as string).toContain('## ⑪ 期待管理');
    expect(styleContext as string).toContain('## ⑬ 节选（few-shot 原文范本）');
    expect(styleContext as string).toContain(SHORT_EXCERPT);
    expect(styleContext as string).not.toContain('id: style');
    // CR-003：⑫ 禁则进全量版（写手同受负面清单约束）。
    expect(styleContext as string).toContain('## ⑫ 禁则');
    expect(styleContext as string).toContain('不用感叹号');
    // CR-006：style_context_brief 不再作链内 artifact——精简版的真实消费路径是 dispatch-planners
    // 派发时现读 settings/style.md 现编（executePlannerDispatch），链内注入即零消费者误用。
    expect(artifacts['style_context_brief']).toBeUndefined();
    // 既有 artifact 不受影响（settings_context 仍为 assemble 产的字符串）。
    expect(typeof artifacts['settings_context']).toBe('string');
  });

  it('无①-⑫节但有⑬ fenced 的卡：style_context 走节选路径仍注入（纯增益不挑卡形态）', async () => {
    writeProjectYaml();
    // 只有文字层节的卡（无 ①-⑫——mainParts 仅 ③；⑬ fenced 在 → 全量走正常节选路径）。
    writeStyleCard([
      '# 风格卡片', '', '## ③ 句法与文字节奏', '长短交替。', '',
      '## ⑬ 节选（few-shot）', '', '```text', SHORT_EXCERPT, '```', '',
    ].join('\n'));
    runChapterChain.mockResolvedValue(SUMMARY_OK);
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'G' } }, ctx);

    const artifacts = runChapterChain.mock.calls[0]![1] as Record<string, unknown>;
    expect(artifacts['style_context']).toBeDefined();
    expect(artifacts['style_context_brief']).toBeUndefined();
  });
});

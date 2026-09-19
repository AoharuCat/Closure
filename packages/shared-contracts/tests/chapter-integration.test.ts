import { describe, expect, it } from 'vitest';
import {
  acceptChapterCandidateCore,
  autoCreatedChapterFileContent,
  buildAcceptStoryDecisions,
  buildChapterAccept,
  countChaptersAtSortOrder,
  describeAcceptSkip,
  planAutoCreateChapter,
  preserveChapterFrontmatter,
  resolveChapterIdForEpisode,
  resolveEpisodeIdForChapter,
  sanitizeChapterStemSegment,
  stripChapterFrontmatter,
  type ChapterAcceptArtifact,
  type ChapterAcceptResult,
  type ChapterIntegrationProject,
  type ChapterAcceptSnapshot,
} from '../src/contracts/chapter-integration';
import type { StoryDecision } from '../src/contracts/story-decision';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.1 Step 4：chapter-integration 共享纯函数测（acceptChapterCandidateCore +
// resolveChapterIdForEpisode + buildChapterAccept）。纯函数无 fs / Date / db → plain vitest。
// ─────────────────────────────────────────────────────────────────────────────

const NOW_ISO = '2026-08-01T00:00:00.000Z';

function makeProject(overrides: Partial<ChapterIntegrationProject> = {}): ChapterIntegrationProject {
  return {
    novel: {
      chapters: [
        {
          id: 'ch_001',
          title: '旧标题',
          sort_order: 0,
          sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
          status: 'generating',
          last_run_id: 'run_pre',
        },
        {
          id: 'ch_002',
          title: '第2章',
          sort_order: 1,
          sections: [{ id: 'ch_002_s1', sort_order: 0, content_file: 'chapters/ch_002.md' }],
        },
      ],
      story_decisions: [],
    },
    meta: { version: 5, updated_at: '2026-07-31T00:00:00.000Z' },
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// acceptChapterCandidateCore
// ════════════════════════════════════════════════════════════════════════════

describe('acceptChapterCandidateCore — 项目 mutation 纯逻辑（不写盘）', () => {
  it('更新章节元数据 + 返 mdPath/mdContent/chapterMeta（mirror acceptChapterCandidate 行为）', () => {
    const project = makeProject();
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'run_accept1',
      candidate: { title: '第1章 新标题', content: '夜幕降临。', summary: '新摘要。', wordCount: 42 },
      nowISO: NOW_ISO,
    });

    expect(result).not.toBeNull();
    expect(result!.mdPath).toBe('chapters/ch_001.md');
    expect(result!.mdContent).toBe('夜幕降临。');
    expect(result!.chapterMeta).toMatchObject({
      title: '第1章 新标题',
      summary: '新摘要。',
      summary_source: 'ai',
      word_count: 42,
      status: 'draft',
      last_run_id: 'run_accept1',
      generated_at: NOW_ISO,
    });
    // 章节 meta 在 updatedProject 中已 mutate
    const ch = result!.updatedProject.novel!.chapters!.find((c) => c.id === 'ch_001')!;
    expect(ch.title).toBe('第1章 新标题');
    expect(ch.status).toBe('draft');
    expect(ch.sections![0].word_count).toBe(42);
  });

  it('不动 meta.version / meta.updated_at（调用方 batch 级 bump，避 double-count）', () => {
    const project = makeProject();
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    })!;
    expect(result.updatedProject.meta.version).toBe(5); // 未递增（调用方 bump）
    expect(result.updatedProject.meta.updated_at).toBe('2026-07-31T00:00:00.000Z'); // 未改
  });

  it('不改入参引用（structuredClone）', () => {
    const project = makeProject();
    const original = JSON.parse(JSON.stringify(project));
    acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: '新内容' },
      nowISO: NOW_ISO,
    });
    expect(JSON.parse(JSON.stringify(project))).toEqual(original); // 入参未变
  });

  it('story_decisions 追加到 novel.story_decisions（create array if absent）', () => {
    const project = makeProject({ novel: { chapters: makeProject().novel!.chapters! } });
    delete (project.novel as { story_decisions?: StoryDecision[] }).story_decisions;
    const decision: StoryDecision = {
      id: 'd1',
      summary: '偏离',
      reason: '正文升级',
      alternatives: [],
      risk: '须校正',
      status: 'decided',
      source: 'accept_as_truth',
      createdAt: NOW_ISO,
    };
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
      storyDecisions: [decision],
    })!;
    expect(result.updatedProject.novel!.story_decisions).toEqual([decision]);
  });

  it('章节不存在 → 返 null（调用方决定 throw 或 skip）', () => {
    const project = makeProject();
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_nonexistent',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    });
    expect(result).toBeNull();
  });

  it('novel.chapters 缺 → 返 null', () => {
    const result = acceptChapterCandidateCore({
      project: { meta: { version: 0, updated_at: NOW_ISO } },
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    });
    expect(result).toBeNull();
  });

  it('章节无 sections → 返 null', () => {
    const project = makeProject();
    (project.novel!.chapters![0] as { sections?: unknown }).sections = undefined;
    const result = acceptChapterCandidateCore({
      project,
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: 'x' },
      nowISO: NOW_ISO,
    });
    expect(result).toBeNull();
  });

  it('最小 candidate（仅 content）→ 正常 mutation', () => {
    const result = acceptChapterCandidateCore({
      project: makeProject(),
      chapterId: 'ch_001',
      runId: 'r1',
      candidate: { content: '最小内容。' },
      nowISO: NOW_ISO,
    })!;
    expect(result.mdContent).toBe('最小内容。');
    expect(result.chapterMeta.status).toBe('draft');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveChapterIdForEpisode
// ════════════════════════════════════════════════════════════════════════════

describe('resolveChapterIdForEpisode — episodeId → chapterId 映射', () => {
  const episodes = [
    { id: 'ep_1', index: 0 },
    { id: 'ep_2', index: 1 },
    { id: 'ep_3', index: 2 },
  ];
  const chapters = [
    { id: 'ch_001', sort_order: 0 },
    { id: 'ch_002', sort_order: 1 },
  ];

  it('episodeId → episode.index → chapters[sort_order===index]（命中）', () => {
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_1')).toBe('ch_001');
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_2')).toBe('ch_002');
  });

  it('directChapterId 优先（绕过映射推断）', () => {
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_1', 'ch_002')).toBe('ch_002');
    // 即使 episodeId 不存在，directChapterId 仍优先返回
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_nonexistent', 'ch_custom')).toBe('ch_custom');
  });

  it('episode 不存在 → undefined', () => {
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_nonexistent')).toBeUndefined();
  });

  it('episode.index 无对应 sort_order 章（章未注册） → undefined', () => {
    // ep_3.index=2，但 chapters 只到 sort_order=1
    expect(resolveChapterIdForEpisode(episodes, chapters, 'ep_3')).toBeUndefined();
  });

  it('CR-4.1-06：多章 sort_order 重复（映射歧义）→ undefined（accept 阻断，非取首个静默写错章）', () => {
    // chapterSchema.sort_order 无唯一约束；两章共 sort_order=0 时旧 `find` 取首个会静默写错位置。
    const chaptersWithDupSort = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_001b', sort_order: 0 },
    ];
    expect(resolveChapterIdForEpisode(episodes, chaptersWithDupSort, 'ep_1')).toBeUndefined();
  });

  it('episodeOutlines 缺 → undefined（无 directChapterId 时）', () => {
    expect(resolveChapterIdForEpisode(undefined, chapters, 'ep_1')).toBeUndefined();
  });

  it('novelChapters 缺 → undefined（无 directChapterId 时）', () => {
    expect(resolveChapterIdForEpisode(episodes, undefined, 'ep_1')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// countChaptersAtSortOrder（dogfood R2 #107 / R1.1：入口层 0 命中 vs 多命中区分）
// ════════════════════════════════════════════════════════════════════════════

describe('countChaptersAtSortOrder — sort_order 命中计数（#107 自动建章判定）', () => {
  const episodes = [
    { id: 'ep_1', index: 0 },
    { id: 'ep_2', index: 1 },
    { id: 'ep_3', index: 2 },
  ];

  it('0 命中（章未注册）→ 0（#107 自动建章的合法入口态）', () => {
    const chapters = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_002', sort_order: 1 },
    ];
    expect(countChaptersAtSortOrder(chapters, 2)).toBe(0);
  });

  it('1 命中 → 1（resolveChapterIdForEpisode 唯一命中路径）', () => {
    const chapters = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_002', sort_order: 1 },
    ];
    expect(countChaptersAtSortOrder(chapters, 0)).toBe(1);
    expect(countChaptersAtSortOrder(chapters, 1)).toBe(1);
  });

  it('多命中（sort_order 重复歧义）→ >1（自动建章救不了，维持现行报错）', () => {
    const chapters = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_001b', sort_order: 0 },
    ];
    expect(countChaptersAtSortOrder(chapters, 0)).toBe(2);
  });

  it('novelChapters 缺 / sort_order 缺失章不计 → 计数安全', () => {
    expect(countChaptersAtSortOrder(undefined, 0)).toBe(0);
    expect(countChaptersAtSortOrder([{ id: 'no_sort' }], 0)).toBe(0);
  });

  it('配对不变式：count===1 ⟺ resolve 返回 defined（同一比较式，防两逻辑漂移）', () => {
    const cases: Array<Array<{ id: string; sort_order?: number }>> = [
      [], // 全空：count 0，resolve undefined
      [{ id: 'ch_001', sort_order: 0 }], // 唯一：count 1，resolve ch_001
      [
        { id: 'ch_001', sort_order: 0 },
        { id: 'ch_001b', sort_order: 0 },
      ], // 歧义：count 2，resolve undefined
      [{ id: 'ch_002', sort_order: 1 }], // 命中他位：count 0（对 index 0），resolve undefined
    ];
    for (const chapters of cases) {
      const count = countChaptersAtSortOrder(chapters, 0);
      const resolved = resolveChapterIdForEpisode(episodes, chapters, 'ep_1');
      if (count === 1) {
        expect(resolved).toBeDefined();
      } else {
        expect(resolved).toBeUndefined();
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// resolveEpisodeIdForChapter（正向链取反，Story 8.7 BMad CR-001 章落盘降档取反链）
// ════════════════════════════════════════════════════════════════════════════

describe('resolveEpisodeIdForChapter — chapterId → episodeId 映射（反向）', () => {
  const episodes = [
    { id: 'ep_1', index: 0 },
    { id: 'ep_2', index: 1 },
    { id: 'ep_3', index: 2 },
  ];
  const chapters = [
    { id: 'ch_001', sort_order: 0 },
    { id: 'ch_002', sort_order: 1 },
  ];

  it('chapterId → sort_order → episode[index]（命中，与正向互逆）', () => {
    expect(resolveEpisodeIdForChapter(episodes, chapters, 'ch_001')).toBe('ep_1');
    expect(resolveEpisodeIdForChapter(episodes, chapters, 'ch_002')).toBe('ep_2');
  });

  it('chapter 不存在 / sort_order 缺 / 无对应 episode → undefined', () => {
    expect(resolveEpisodeIdForChapter(episodes, chapters, 'ch_nonexistent')).toBeUndefined();
    expect(
      resolveEpisodeIdForChapter(episodes, [{ id: 'ch_nosort' }], 'ch_nosort'),
    ).toBeUndefined();
    // ch_002.sort_order=1 → ep_2 命中；构造有章无 episode 的形态：index 超出 episodes 集。
    expect(
      resolveEpisodeIdForChapter(episodes, [{ id: 'ch_009', sort_order: 9 }], 'ch_009'),
    ).toBeUndefined();
  });

  it('多 episode 同 index（反向歧义）→ undefined（mirror 正向 CR-4.1-06 防御）', () => {
    const dupEpisodes = [
      { id: 'ep_1a', index: 0 },
      { id: 'ep_1b', index: 0 },
    ];
    expect(resolveEpisodeIdForChapter(dupEpisodes, chapters, 'ch_001')).toBeUndefined();
  });

  it('双章共 sort_order → 正向本就 undefined，反向回代校验同判 undefined（正反一致）', () => {
    const dupChapters = [
      { id: 'ch_001', sort_order: 0 },
      { id: 'ch_001b', sort_order: 0 },
    ];
    // 正向 anchor：ep_1 → 两章共 sort_order → undefined。
    expect(resolveChapterIdForEpisode(episodes, dupChapters, 'ep_1')).toBeUndefined();
    // 反向不得单侧放行（镜像错位防线——回代校验拦下）。
    expect(resolveEpisodeIdForChapter(episodes, dupChapters, 'ch_001')).toBeUndefined();
    expect(resolveEpisodeIdForChapter(episodes, dupChapters, 'ch_001b')).toBeUndefined();
  });

  it('episodeOutlines / novelChapters 缺 → undefined', () => {
    expect(resolveEpisodeIdForChapter(undefined, chapters, 'ch_001')).toBeUndefined();
    expect(resolveEpisodeIdForChapter(episodes, undefined, 'ch_001')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildChapterAccept
// ════════════════════════════════════════════════════════════════════════════

describe('buildChapterAccept — 链段 accept 分支产 chapter_accept artifact', () => {
  function makeSnapshot(
    artifacts: ChapterAcceptSnapshot['artifacts'],
    runId = 'run_xyz',
  ): ChapterAcceptSnapshot {
    return { runId, artifacts };
  }

  /**
   * Narrow ChapterAcceptResult → ChapterAcceptArtifact（success case helper）。
   * CR-4.1-08：buildChapterAccept 返 `ChapterAcceptArtifact | ChapterAcceptSkip` 区分式（非旧 `| undefined`），
   * 成功断言前先验「有 chapterId」narrow，让 TS 推导到 ChapterAcceptArtifact。
   */
  function expectArtifact(r: ChapterAcceptResult): ChapterAcceptArtifact {
    expect(r).toBeDefined();
    expect(r && 'chapterId' in r).toBe(true);
    if (!r || !('chapterId' in r)) throw new Error('expected ChapterAcceptArtifact, got ChapterAcceptSkip');
    return r;
  }

  const episodes = [{ id: 'ep_1', index: 0 }];
  const chapters = [{ id: 'ch_001', sort_order: 0 }];

  it('draft + accept + 无 deviation → chapter_accept（无 storyDecisions）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { title: '第1章', text: '正文内容。', wordCount: 100 },
      'route_decision': { decision: 'accept_as_truth', reason: '正文升级', deviation: false },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.chapterId).toBe('ch_001');
    expect(artifact.candidate).toEqual({ title: '第1章', content: '正文内容。', wordCount: 100 });
    expect(artifact.storyDecisions).toBeUndefined(); // 无偏离 → 不登记
    expect(artifact.runId).toBe('run_xyz');
  });

  it('deviation=true → 建 decided StoryDecision（source=accept_as_truth, relatedEpisodeId, createdAt=nowISO）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '角色突然硬气', deviation: true },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.storyDecisions).toHaveLength(1);
    const decision = artifact.storyDecisions![0];
    expect(decision.status).toBe('decided');
    expect(decision.source).toBe('accept_as_truth');
    expect(decision.relatedEpisodeId).toBe('ep_1');
    expect(decision.createdAt).toBe(NOW_ISO);
    expect(decision.reason).toBe('角色突然硬气');
    expect(decision.id).toBe('accept-run_xyz');
  });

  it('deviation=true + route=escalate_user -> source=escalate_accepted（2.6 CR-Edge-4：保留 escalation 上下文）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'escalate_user', reason: '灰区：正文比计划激进，上发裁决', deviation: true },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.storyDecisions).toHaveLength(1);
    const decision = artifact.storyDecisions![0];
    expect(decision.status).toBe('decided');
    expect(decision.source).toBe('escalate_accepted');
    expect(decision.summary).toContain('灰区裁决');
    expect(decision.reason).toBe('灰区：正文比计划激进，上发裁决');
  });

  it('deviation 缺省（route 未输出） → 不登记 StoryDecision', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '通过' },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    }));
    expect(artifact.storyDecisions).toBeUndefined();
  });

  it('CR-4.1-08：chapterId 映射失败（章未注册） → {skipReason:"no-chapter"}（区分失败模式，非旧 undefined）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '通过' },
    });
    const result = buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_nonexistent',
      episodeOutlines: episodes,
      novelChapters: chapters,
    });
    expect(result).toEqual({ skipReason: 'no-chapter' });
  });

  it('directChapterId 优先（绕过映射）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '通过' },
    });
    const artifact = expectArtifact(buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      novelChapters: chapters,
      directChapterId: 'ch_custom',
    }));
    expect(artifact.chapterId).toBe('ch_custom');
  });

  it('CR-4.1-08：draft.initial 缺 / 无 text → {skipReason:"no-draft"}（区分失败模式，非旧 undefined）', () => {
    const snapshot = makeSnapshot({ 'route_decision': { decision: 'accept_as_truth' } });
    const result = buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    });
    expect(result).toEqual({ skipReason: 'no-draft' });
  });

  it('CR-4.1-09：nowISO 缺（空串） → {skipReason:"no-nowiso"}（不产 invalid createdAt 违 z.string().min(1)）', () => {
    const snapshot = makeSnapshot({
      'draft.initial': { text: '正文。' },
      'route_decision': { decision: 'accept_as_truth', reason: '正文升级', deviation: true },
    });
    const result = buildChapterAccept(snapshot, {
      nowISO: '',
      episodeId: 'ep_1',
      episodeOutlines: episodes,
      novelChapters: chapters,
    });
    // nowISO 缺前置 skip（即使 deviation=true 也不登记 StoryDecision——createdAt 会违 schema）
    expect(result).toEqual({ skipReason: 'no-nowiso' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildAcceptStoryDecisions（#107 R1.1c：从 buildChapterAccept 内联提取的单源构造器——
// 正常路径（buildChapterAccept）与 no-chapter 自动建章补产路径共用，防双形态漂移）
// ════════════════════════════════════════════════════════════════════════════

describe('buildAcceptStoryDecisions — accept 登记 StoryDecision 单源构造（#107 R1.1c）', () => {
  it('deviation=true + accept_as_truth → decided StoryDecision（source=accept_as_truth, id=accept-<runId>）', () => {
    const decisions = buildAcceptStoryDecisions({
      routeDecision: { decision: 'accept_as_truth', reason: '角色突然硬气', deviation: true },
      episodeId: 'ep_1',
      runId: 'run_x',
      nowISO: NOW_ISO,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions![0]).toMatchObject({
      id: 'accept-run_x',
      status: 'decided',
      source: 'accept_as_truth',
      relatedEpisodeId: 'ep_1',
      createdAt: NOW_ISO,
      reason: '角色突然硬气',
    });
  });

  it('deviation=true + escalate_user → source=escalate_accepted（CR-Edge-4 escalation 上下文保留）', () => {
    const decisions = buildAcceptStoryDecisions({
      routeDecision: { decision: 'escalate_user', reason: '灰区', deviation: true },
      episodeId: 'ep_1',
      runId: 'run_y',
      nowISO: NOW_ISO,
    });
    expect(decisions![0].source).toBe('escalate_accepted');
    expect(decisions![0].summary).toContain('灰区裁决');
  });

  it('deviation 缺省 / false / routeDecision 缺 → undefined（无偏离不登记，不静默产空记录）', () => {
    expect(buildAcceptStoryDecisions({ routeDecision: undefined, episodeId: 'e', runId: 'r', nowISO: NOW_ISO })).toBeUndefined();
    expect(buildAcceptStoryDecisions({ routeDecision: { decision: 'accept_as_truth' }, episodeId: 'e', runId: 'r', nowISO: NOW_ISO })).toBeUndefined();
    expect(buildAcceptStoryDecisions({ routeDecision: { decision: 'accept_as_truth', deviation: false }, episodeId: 'e', runId: 'r', nowISO: NOW_ISO })).toBeUndefined();
  });

  it('reason 缺省/空 → fallback 文案（mirror 提取前 buildChapterAccept 内联兜底）', () => {
    const decisions = buildAcceptStoryDecisions({
      routeDecision: { decision: 'accept_as_truth', deviation: true },
      episodeId: 'e',
      runId: 'r',
      nowISO: NOW_ISO,
    });
    expect(decisions![0].reason).toBe('route 判定正文偏离计划，按正文为真相接受');
  });

  it('单源等价锚：buildChapterAccept 内联路径与单源构造器产出逐字一致（防提取时漂移）', () => {
    const snapshot: ChapterAcceptSnapshot = {
      runId: 'run_equiv',
      artifacts: {
        'draft.initial': { text: '正文。' },
        'route_decision': { decision: 'escalate_user', reason: '灰区上发', deviation: true },
      },
    };
    const artifact = buildChapterAccept(snapshot, {
      nowISO: NOW_ISO,
      episodeId: 'ep_1',
      episodeOutlines: [{ id: 'ep_1', index: 0 }],
      novelChapters: [{ id: 'ch_001', sort_order: 0 }],
    }) as ChapterAcceptArtifact;
    const standalone = buildAcceptStoryDecisions({
      routeDecision: { decision: 'escalate_user', reason: '灰区上发', deviation: true },
      episodeId: 'ep_1',
      runId: snapshot.runId,
      nowISO: NOW_ISO,
    });
    expect(artifact.storyDecisions).toEqual(standalone);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// planAutoCreateChapter + autoCreatedChapterFileContent + sanitizeChapterStemSegment
// （dogfood R2 #107 / R1.1：no-chapter 链侧自动建章判定 + 文件形态，两车道单源）
// ════════════════════════════════════════════════════════════════════════════

describe('sanitizeChapterStemSegment — 章标题文件名安全段', () => {
  it('Windows 非法字符 / 控制字符剔除，中文保留（ASCII 白名单折叠会毁掉整题）', () => {
    expect(sanitizeChapterStemSegment('挖出来的是什么')).toBe('挖出来的是什么');
    expect(sanitizeChapterStemSegment('a<b>c:"d/e\\f|g?h*i')).toBe('abcdefghi');
    expect(sanitizeChapterStemSegment('标题\x00\x1f去控制字符')).toBe('标题去控制字符');
  });

  it('控制字符（含换行）剔除在前，空格折叠在后 + 首尾去 + 尾点去（Windows 限制）', () => {
    // \n 属控制字符段——第一 replace 已剔除（文件名段内换行直接删除而非留空格），空格才折叠。
    expect(sanitizeChapterStemSegment('  多  空白\n换行  ')).toBe('多 空白换行');
    expect(sanitizeChapterStemSegment('标题结尾点... ')).toBe('标题结尾点');
  });

  it('超长截 40 字符（防 MAX_PATH）', () => {
    expect(sanitizeChapterStemSegment('标'.repeat(50))).toHaveLength(40);
  });

  it('保留名加 -doc 后缀（W2 R1/FS#6 单源；后缀插首点前，40 帽仍收尾）', () => {
    // 标题恰为 Windows 保留设备名 → stem 段加 '-doc'（naming.ts insertReservedSuffix 同语义）。
    expect(sanitizeChapterStemSegment('NUL')).toBe('NUL-doc');
    expect(sanitizeChapterStemSegment('com1')).toBe('com1-doc');
    // 带内部点的保留主名段：后缀插在首点前（CON.x → CON-doc.x），产物整体不再是保留名。
    expect(sanitizeChapterStemSegment('CON.x')).toBe('CON-doc.x');
    // 非保留名带点不受影响；既有清洗语义不回退（中文/删除式清洗原样）。
    expect(sanitizeChapterStemSegment('第1.5章 伏笔')).toBe('第1.5章 伏笔');
    expect(sanitizeChapterStemSegment('a<b>c:"d/e\\f|g?h*i')).toBe('abcdefghi');
  });

  it('全非法/空 → 空串（调用方退化为纯「第N章」）', () => {
    expect(sanitizeChapterStemSegment('???')).toBe('');
    expect(sanitizeChapterStemSegment('')).toBe('');
  });
});

describe('planAutoCreateChapter — #107 no-chapter 自动建章判定', () => {
  const episodes = [
    { id: 'ep_1', index: 0 },
    { id: 'ep_2', index: 1 },
  ];

  it('首章空项目（无 novelChapters）→ plan：stem=第01章-标题，锚 episode.index', () => {
    const plan = planAutoCreateChapter({
      episodeOutlines: episodes,
      episodeId: 'ep_1',
      title: '挖出来的是什么',
    });
    expect(plan).toBeDefined();
    expect(plan!.stem).toBe('第01章-挖出来的是什么');
    expect(plan!.episodeIndex).toBe(0);
    expect(plan!.title).toBe('挖出来的是什么');
  });

  it('0 命中空位 + 守卫过（连续密集多章）→ plan：第2章落位 1', () => {
    const plan = planAutoCreateChapter({
      episodeOutlines: episodes,
      novelChapters: [{ id: 'ch_001', sort_order: 0 }],
      episodeId: 'ep_2',
      title: '夜色',
    });
    expect(plan).toBeDefined();
    expect(plan!.stem).toBe('第02章-夜色');
    expect(plan!.episodeIndex).toBe(1);
  });

  it('标题空/缺 → stem 与 title 退化纯「第N章」', () => {
    const plan = planAutoCreateChapter({ episodeOutlines: episodes, episodeId: 'ep_1' });
    expect(plan!.stem).toBe('第01章');
    expect(plan!.title).toBe('第01章');
  });

  it('确定性/幂等：同输入两次 plan 完全一致（chapter_write 同 stem 幂等键）', () => {
    const input = { episodeOutlines: episodes, episodeId: 'ep_1', title: '同一章' };
    expect(planAutoCreateChapter(input)).toEqual(planAutoCreateChapter(input));
  });

  it('显式 directChapterId → undefined（用户意图，不自动建）', () => {
    expect(planAutoCreateChapter({
      episodeOutlines: episodes,
      episodeId: 'ep_1',
      directChapterId: 'ch_custom',
    })).toBeUndefined();
  });

  it('episode 不存在 / episodeOutlines 缺 → undefined', () => {
    expect(planAutoCreateChapter({ episodeOutlines: episodes, episodeId: 'ep_x' })).toBeUndefined();
    expect(planAutoCreateChapter({ episodeId: 'ep_1' })).toBeUndefined();
  });

  it('多命中（sort_order 重复歧义）→ undefined（自动建章救不了映射歧义，维持报错）', () => {
    expect(planAutoCreateChapter({
      episodeOutlines: episodes,
      novelChapters: [
        { id: 'ch_a', sort_order: 0 },
        { id: 'ch_b', sort_order: 0 },
      ],
      episodeId: 'ep_1',
    })).toBeUndefined();
  });

  it('1 命中（章已注册）→ undefined（走正常路径，无空位可补）', () => {
    expect(planAutoCreateChapter({
      episodeOutlines: episodes,
      novelChapters: [{ id: 'ch_001', sort_order: 0 }],
      episodeId: 'ep_1',
    })).toBeUndefined();
  });

  it('R1.1d 落位守卫不过（yaml 有洞：位置 0 空、既有章 sort_order=2，插 order:1 落位 0≠1）→ undefined', () => {
    // diskSim 近似下：existing=[order 2]，new order:1 → 排序 [1,2] → 落位 0 ≠ target 1 → 守卫拒。
    expect(planAutoCreateChapter({
      episodeOutlines: episodes,
      novelChapters: [{ id: 'ch_jump', sort_order: 2 }],
      episodeId: 'ep_2',
    })).toBeUndefined();
  });

  it('守卫边界：既有章缺 sort_order（模拟「无序垫底」）+ 首章位 → plan（首章零近似误差）', () => {
    const plan = planAutoCreateChapter({
      episodeOutlines: episodes,
      novelChapters: [{ id: 'ch_nosort' }],
      episodeId: 'ep_1',
    });
    // diskSim：existing explicitOrder=null（垫底 MAX），new order:0 → 排序 [0, MAX] → 落位 0 === target ✓。
    expect(plan).toBeDefined();
    expect(plan!.stem).toBe('第01章');
  });
});

describe('autoCreatedChapterFileContent — 建章文件形态（磁盘派生消费契约对偶）', () => {
  const plan = { stem: '第01章-挖出来的是什么', episodeIndex: 0, title: '挖出来的是什么' };

  it('direct 车道（body 提供）：frontmatter order + # 标题 + 空行 + 正文', () => {
    expect(autoCreatedChapterFileContent(plan, '正文第一段。')).toBe(
      '---\norder: 0\n---\n\n# 挖出来的是什么\n\n正文第一段。',
    );
  });

  it('review 车道（骨架，body 缺省）：frontmatter + 标题、无正文', () => {
    expect(autoCreatedChapterFileContent(plan)).toBe('---\norder: 0\n---\n\n# 挖出来的是什么\n');
  });

  it('ORDER_RE 消费契约：frontmatter 形态可被磁盘派生解析为显式序（对偶自证）', () => {
    const content = autoCreatedChapterFileContent({ stem: 's', episodeIndex: 12, title: 't' });
    // mirror chapterDiskDerivation ORDER_RE（^order:\s*([0-9]+)\s*$，m）。
    expect(content.match(/^order:\s*([0-9]+)\s*$/m)?.[1]).toBe('12');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// describeAcceptSkip no-chapter 文案（#107 / R1.4：修后该文案只在自动建未发生时出现）
// ════════════════════════════════════════════════════════════════════════════

describe('describeAcceptSkip no-chapter 文案（#107 R1.4）', () => {
  it('no-chapter 文案指明自动建未发生的原因 + 手建路径', () => {
    const text = describeAcceptSkip('no-chapter');
    expect(text).toContain('自动建章');
    expect(text).toContain('落位守卫');
    expect(text).toContain('工作台');
  });

  it('no-draft / no-nowiso 文案不变（零回归）', () => {
    expect(describeAcceptSkip('no-draft')).toContain('draft');
    expect(describeAcceptSkip('no-nowiso')).toContain('时间戳');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// preserveChapterFrontmatter —— 章文件覆写保序规则（#107 check 批补缝）
//
// 缝：#107 后 frontmatter order 是每章的登记载体，但既有三条 body-only 覆写路径
// （acceptChapterCandidate / applyFieldPatches chapter_candidate / chapter_write splice）
// 会把已注册章的 order 物理抹掉 → hasExplicitOrder 混合态 → 派生重排错位。规则 =
// 旧文件有 frontmatter 且新内容无 → 旧块逐字节回拼；其余原样。
// ════════════════════════════════════════════════════════════════════════════

describe('preserveChapterFrontmatter — 覆写保序（#107 check 批）', () => {
  const FM = '---\norder: 3\n---\n\n';

  it('旧有 frontmatter + 新内容无 → 旧块回拼在前（order 不丢；块含单个尾换行，mirror ui splitFrontmatter）', () => {
    expect(preserveChapterFrontmatter(`${FM}# 旧标题\n\n旧正文`, '# 新标题\n\n新正文'))
      .toBe('---\norder: 3\n---\n# 新标题\n\n新正文');
  });

  it('新内容自带 frontmatter（#107 全形态候选）→ 原样，不双拼', () => {
    const fullForm = '---\norder: 4\n---\n\n# 新章\n\n正文';
    expect(preserveChapterFrontmatter(`${FM}旧内容`, fullForm)).toBe(fullForm);
  });

  it('旧文件无 frontmatter（历史 body-only 章）→ 新内容原样（零行为变化）', () => {
    expect(preserveChapterFrontmatter('# 旧标题\n\n旧正文', '# 新标题\n\n新正文'))
      .toBe('# 新标题\n\n新正文');
  });

  it('新建文件（existing null / undefined）→ 原样', () => {
    expect(preserveChapterFrontmatter(null, '# 新章\n')).toBe('# 新章\n');
    expect(preserveChapterFrontmatter(undefined, '# 新章\n')).toBe('# 新章\n');
  });

  it('旧块保序：CRLF + 注释 + BOM 原样回拼（块含单个尾 \r\n，mirror ui splitFrontmatter）', () => {
    // BOM + CRLF + 注释行的 frontmatter——回拼原样保留（watcher 误触发防护）。
    const exotic = '\uFEFF---\r\n# 注释\r\norder: 0\r\n---\r\n\r\n';
    const out = preserveChapterFrontmatter(`${exotic}旧正文`, '新正文');
    expect(out.startsWith('\uFEFF---\r\n# 注释\r\norder: 0\r\n---\r\n')).toBe(true);
    expect(out.endsWith('新正文')).toBe(true);
  });

  it('EOF 收尾无换行的旧块 → 回拼时补一个行分隔（closing --- 保持行首稳定）', () => {
    // 无正文章文件（骨架+全被删）：'---\norder: 1\n---'（EOF 无换行）+ 非空 body。
    expect(preserveChapterFrontmatter('---\norder: 1\n---', '新正文'))
      .toBe('---\norder: 1\n---\n新正文');
  });

  it('旧块 EOF 无换行 + 新内容空串 → 原样（无需补分隔）', () => {
    expect(preserveChapterFrontmatter('---\norder: 1\n---', '')).toBe('---\norder: 1\n---');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stripChapterFrontmatter —— 章文件正文剥离（链流程重排 W4 / R6 链外重提取）
//
// re-extract-chapter 从盘上 chapters/<id>.md 读正文喂 E 段：链上 draft.initial.text 是纯正文，
// frontmatter（order 登记载体）不是正文。与 preserveChapterFrontmatter 共用同一块形状
// （CHAPTER_FILE_FRONTMATTER_RE，BOM/CRLF/EOF 容忍）——此处锚定剥离侧形状，防两函数漂移。
// ════════════════════════════════════════════════════════════════════════════

describe('stripChapterFrontmatter — 正文剥离（W4 链外重提取）', () => {
  it('frontmatter + 正文 → 剥块返正文（块尾单个换行随块走，其余按落盘原样含前导空行）', () => {
    // mirror preserve 测试 1 的输入形状：块匹配含 closing --- 后单个 \n，正文从第二空行起原样保留。
    expect(stripChapterFrontmatter('---\norder: 3\n---\n\n# 标题\n\n正文')).toBe('\n# 标题\n\n正文');
  });

  it('无 frontmatter（历史 body-only 章）→ 原样返回（零行为变化）', () => {
    const body = '# 标题\n\n正文';
    expect(stripChapterFrontmatter(body)).toBe(body);
  });

  it('BOM + CRLF + 注释行 frontmatter → 剥离后正文无 BOM 无块残留', () => {
    const BOM = String.fromCharCode(0xfeff);
    const out = stripChapterFrontmatter(`${BOM}---\r\n#注释\r\norder: 0\r\n---\r\n\r\n正文`);
    expect(out).toBe('\r\n正文');
    expect(out.includes(BOM)).toBe(false);
    expect(out.includes('order')).toBe(false);
  });

  it('EOF 收尾无换行（骨架章全删正文）→ 剥离后空串（caller 判「正文为空」graceful）', () => {
    expect(stripChapterFrontmatter('---\norder: 1\n---')).toBe('');
  });

  it('CR-12③：BOM + body-only（无 frontmatter 块）→ BOM 兜底剥（不泄入正文）', () => {
    const BOM = String.fromCharCode(0xfeff);
    // 修前：leadingFrontmatterBlock 对无块形态返 null → BOM 原样泄入「正文」（prompt/字数/提取全带）。
    expect(stripChapterFrontmatter(`${BOM}# 标题\n\n正文`)).toBe('# 标题\n\n正文');
    // 无 BOM body-only 原样返回不变（零回归）。
    expect(stripChapterFrontmatter('# 标题\n\n正文')).toBe('# 标题\n\n正文');
  });
});

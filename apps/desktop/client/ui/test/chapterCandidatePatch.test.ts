/**
 * Story 4.1 Step 5（design §3.4 / §3.3）：chapter_candidate patch 持久化路由。
 *
 * applySelectedPatches 必须把 chapter_candidate patches 路由到 applyAgentFieldPatch IPC
 * （→ applyFieldPatches → acceptChapterCandidateCore 写 chapters/*.md + chapter 元数据 +
 * story_decisions），而非 syncField（field:sync 会 creativeFieldKeySchema.parse('chapter_candidate')
 * 抛错，且会污染 creativeFields 状态）。
 *
 * 落地公理（conclusions §2.5）：正文须产品读者可达。chapter_candidate 的 accept 是 prose 落地
 * 的唯一 UI 持久化路径（write_chapter accept_as_truth → field_patch → PatchReviewPanel accept → 此处）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { createCreativeFieldsSlice, type CreativeFieldsSlice } from '../src/shared/store/creativeFieldsSlice';
import { createProjectSlice, type ProjectSlice } from '../src/shared/store/projectSlice';
import type { ProjectFieldPatch } from '@orison/shared-contracts';

declare global {
  interface Window {
    orisonDesktop: any;
  }
}

type TestState = CreativeFieldsSlice &
  ProjectSlice & {
    saveProject: () => Promise<void>;
    resolvedLocale: string;
  };

const SESS = 'sess-cf';

const useTestStore = create<TestState>()((...a) => ({
  ...createProjectSlice(...a),
  ...createCreativeFieldsSlice(...a),
  agentSessionId: SESS,
  resolvedLocale: 'en-US',
}));

// dogfood T1 Stage 3（r8 键控）：selections 在 per-session entry 内——测试直改 entry。
function selectPatches(selections: Record<string, boolean>) {
  const s = useTestStore.getState();
  const entry = s.pendingPatchBySession[SESS];
  if (!entry) throw new Error('no pending patch entry');
  useTestStore.setState({ pendingPatchBySession: { ...s.pendingPatchBySession, [SESS]: { ...entry, selections } } });
}


function makeChapterCandidatePatch(storyDecisions?: unknown[]): ProjectFieldPatch {
  return {
    runId: 'run-cc-1',
    createdAt: '2026-08-01T00:00:00Z',
    patches: [
      {
        field: 'chapter_candidate' as any,
        action: 'set',
        data: {
          chapterId: 'ch_001',
          runId: 'run_mock',
          candidate: { title: '开篇', content: '正文…', wordCount: 2800 },
          ...(storyDecisions ? { storyDecisions } : {}),
        },
        fieldVersion: 1,
        generatedBy: 'write_chapter',
      },
    ],
  };
}

beforeEach(() => {
  useTestStore.setState({
    pendingPatchBySession: {},
            creativeFields: {},
    fieldMetadata: {},
    currentProject: { path: '/proj', name: 'P' } as any,
    agentSessionId: SESS,
    resolvedLocale: 'en-US',
  });
  (globalThis as any).window = globalThis as any;
  (window as any).orisonDesktop = {
    syncField: vi.fn().mockResolvedValue(undefined),
    applyAgentFieldPatch: vi.fn().mockResolvedValue(undefined),
  };
});

describe('applySelectedPatches — chapter_candidate 路由（Story 4.1 Step 5）', () => {
  it('chapter_candidate patch → applyAgentFieldPatch 调用（含 chapterId + candidate），syncField 不被调', () => {
    useTestStore.getState().setPendingPatch(SESS, makeChapterCandidatePatch());
    selectPatches({ chapter_candidate: true });

    useTestStore.getState().applySelectedPatches();

    // applyAgentFieldPatch 收到完整的 ProjectFieldPatch（含 chapter_candidate entry）。
    expect(window.orisonDesktop.applyAgentFieldPatch).toHaveBeenCalledTimes(1);
    const [persistPath, fieldPatch] = window.orisonDesktop.applyAgentFieldPatch.mock.calls[0];
    expect(persistPath).toBe('/proj');
    expect(fieldPatch.runId).toBe('run-cc-1');
    expect(fieldPatch.patches).toHaveLength(1);
    expect((fieldPatch.patches[0].field as string)).toBe('chapter_candidate');
    expect((fieldPatch.patches[0].data as { chapterId: string }).chapterId).toBe('ch_001');
    // syncField 绝不被调（chapter_candidate 非 creative field，parse 会抛）。
    expect(window.orisonDesktop.syncField).not.toHaveBeenCalled();
  });

  it('chapter_candidate patch 不污染 creativeFields 状态（不写 creativeFields.chapter_candidate）', () => {
    useTestStore.getState().setPendingPatch(SESS, makeChapterCandidatePatch());
    selectPatches({ chapter_candidate: true });

    useTestStore.getState().applySelectedPatches();

    // creativeFields 不含 chapter_candidate（它是 pseudo-field，不该进 creative-field store）。
    expect((useTestStore.getState().creativeFields as any).chapter_candidate).toBeUndefined();
    // pendingPatch 清空（apply 后）。
    expect((useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null)).toBeNull();
  });

  it('chapter_candidate patch 带 storyDecisions → data 透传给 applyAgentFieldPatch（accept 登记 decided decision）', () => {
    const storyDecisions = [
      {
        id: 'accept-run_mock',
        summary: '正文偏离计划',
        reason: '正文升级',
        alternatives: [],
        risk: '后续校正',
        status: 'decided',
        source: 'accept_as_truth',
        relatedEpisodeId: 'ep1',
        createdAt: '2026-08-01T00:00:00Z',
      },
    ];
    useTestStore.getState().setPendingPatch(SESS, makeChapterCandidatePatch(storyDecisions));
    selectPatches({ chapter_candidate: true });

    useTestStore.getState().applySelectedPatches();

    const fieldPatch = window.orisonDesktop.applyAgentFieldPatch.mock.calls[0][1];
    expect((fieldPatch.patches[0].data as { storyDecisions: unknown[] }).storyDecisions).toEqual(storyDecisions);
  });

  it('chapter_candidate 与 scene_graph 混合 patch → scene_graph 走 syncField，chapter_candidate 走 applyAgentFieldPatch（分流）', () => {
    const mixedPatch: ProjectFieldPatch = {
      runId: 'run-mix',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'scene_graph' as any,
          action: 'set',
          data: { nodes: [], edges: [], lines: [] },
          fieldVersion: 1,
          generatedBy: 'story-planner-agent',
        },
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    useTestStore.getState().setPendingPatch(SESS, mixedPatch);
    selectPatches({ scene_graph: true, chapter_candidate: true });

    useTestStore.getState().applySelectedPatches();

    // scene_graph 走 syncField（creative field）。
    expect(window.orisonDesktop.syncField).toHaveBeenCalledTimes(1);
    expect(window.orisonDesktop.syncField.mock.calls[0][1]).toBe('scene_graph');
    // chapter_candidate 走 applyAgentFieldPatch（单独路由）。
    expect(window.orisonDesktop.applyAgentFieldPatch).toHaveBeenCalledTimes(1);
    const fieldPatch = window.orisonDesktop.applyAgentFieldPatch.mock.calls[0][1];
    expect(fieldPatch.patches).toHaveLength(1);
    expect((fieldPatch.patches[0].field as string)).toBe('chapter_candidate');
    // creativeFields 落 scene_graph（不落 chapter_candidate）。
    expect(useTestStore.getState().creativeFields.scene_graph).toBeDefined();
    expect((useTestStore.getState().creativeFields as any).chapter_candidate).toBeUndefined();
  });

  it('chapter_candidate 未选中（patchSelections 缺）→ applyAgentFieldPatch 不调', () => {
    useTestStore.getState().setPendingPatch(SESS, makeChapterCandidatePatch());
    selectPatches({}); // 未选 chapter_candidate

    useTestStore.getState().applySelectedPatches();

    expect(window.orisonDesktop.applyAgentFieldPatch).not.toHaveBeenCalled();
  });
});

/**
 * CR-4.1-05：same-run merge 的 chapter_candidate dedup。leader 同 run 连调两次 write_chapter（两章）
 * 产两条 field='chapter_candidate' patch——原 byField.set(e.field, e) 让后者覆盖前者，第一章正文静默丢。
 * 现按 `(field, chapterId)` 复合键各自保留。同 chapterId 重发仍后者覆盖（latest LLM intent 胜）。
 */
describe('setPendingPatch — chapter_candidate 同 run 多章 dedup（CR-4.1-05）', () => {
  it('同 run 两条不同 chapterId 的 chapter_candidate → 都保留（不互覆盖）', () => {
    const ch1Patch: ProjectFieldPatch = {
      runId: 'run-multi',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run-multi', candidate: { content: '第一章正文。' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    const ch2Patch: ProjectFieldPatch = {
      runId: 'run-multi',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_002', runId: 'run-multi', candidate: { content: '第二章正文。' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };

    useTestStore.getState().setPendingPatch(SESS, ch1Patch);
    useTestStore.getState().setPendingPatch(SESS, ch2Patch);

    const pending = (useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null);
    expect(pending).not.toBeNull();
    // 两章都存活（原 bug：ch_001 被覆盖，只剩 ch_002）。
    expect(pending!.patches).toHaveLength(2);
    const chapterIds = pending!.patches.map((p) => (p.data as { chapterId: string }).chapterId).sort();
    expect(chapterIds).toEqual(['ch_001', 'ch_002']);
  });

  it('同 run 同 chapterId 重发 → 新 entry 覆盖旧（latest LLM intent 胜）', () => {
    const v1: ProjectFieldPatch = {
      runId: 'run-redo',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run-redo', candidate: { content: '旧稿。' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    const v2: ProjectFieldPatch = {
      runId: 'run-redo',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run-redo', candidate: { content: '新稿。' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };

    useTestStore.getState().setPendingPatch(SESS, v1);
    useTestStore.getState().setPendingPatch(SESS, v2);

    const pending = (useTestStore.getState().pendingPatchBySession[SESS]?.patch ?? null);
    expect(pending).not.toBeNull();
    // 同 chapterId → 仍只一条（latest 胜）。
    expect(pending!.patches).toHaveLength(1);
    expect((pending!.patches[0].data as { candidate: { content: string } }).candidate.content).toBe('新稿。');
  });

  it('同 run 两条不同 chapterId accept → applyAgentFieldPatch 收到两条（CR-4.1-05 + 落地公理）', () => {
    const ch1Patch: ProjectFieldPatch = {
      runId: 'run-apply-multi',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run-apply-multi', candidate: { content: '第一章。' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    const ch2Patch: ProjectFieldPatch = {
      runId: 'run-apply-multi',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_002', runId: 'run-apply-multi', candidate: { content: '第二章。' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };

    useTestStore.getState().setPendingPatch(SESS, ch1Patch);
    useTestStore.getState().setPendingPatch(SESS, ch2Patch);
    // patchSelections 按 field 键（chapter_candidate），两行共享一个勾选 = 同批 accept。
    selectPatches({ chapter_candidate: true });

    useTestStore.getState().applySelectedPatches();

    // 两条 chapter_candidate 都进 applyAgentFieldPatch（→ applyFieldPatches batch loop 各自持久化）。
    expect(window.orisonDesktop.applyAgentFieldPatch).toHaveBeenCalledTimes(1);
    const fieldPatch = window.orisonDesktop.applyAgentFieldPatch.mock.calls[0][1];
    expect(fieldPatch.patches).toHaveLength(2);
    const chapterIds = fieldPatch.patches
      .map((p: { data: { chapterId: string } }) => p.data.chapterId)
      .sort();
    expect(chapterIds).toEqual(['ch_001', 'ch_002']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 09-13 子3 W4（design §5.2 / 拍板 D-g 切分）：applySelectedPatches 尾参 sessionId + excludeFields
// 的 slice 行为——对话栏过滤挂载传 ['chapter_candidate']：隐藏的链产物**不随 Apply 静默落盘**
//（applyAgentFieldPatch 不调）且**不静默清丢**（重 stage 进原键继续挂起，供写作页产物区审阅
// 落盘）；排除集空 = 全批语义照旧清键。组件层测试只断言参数透传，此处钉 slice 真行为。
// ═══════════════════════════════════════════════════════════════════════════
describe('applySelectedPatches — W4 excludeFields（D-g 对话栏过滤挂载）', () => {
  /** scene_graph + chapter_candidate 混合批（对话指挥产物 + 链产物同批——leader 车道 director 子 patch 同批真实形态）。 */
  function mixedBatch(): ProjectFieldPatch {
    return {
      runId: 'run-dg',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'scene_graph' as any,
          action: 'set',
          data: { nodes: [], edges: [], lines: [] },
          fieldVersion: 1,
          generatedBy: 'story-planner-agent',
        },
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run-dg', candidate: { content: '终稿正文' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
  }

  it('excludeFields=[chapter_candidate]：scene_graph 照常落盘，chapter_candidate 不落盘（applyAgentFieldPatch 不调）且重 stage 继续挂起', () => {
    useTestStore.getState().setPendingPatch(SESS, mixedBatch());
    selectPatches({ scene_graph: true, chapter_candidate: true });

    const applied = useTestStore.getState().applySelectedPatches(undefined, ['chapter_candidate']);

    // scene_graph 照常（creative field 车道）。
    expect(window.orisonDesktop.syncField).toHaveBeenCalledTimes(1);
    expect(useTestStore.getState().creativeFields.scene_graph).toBeDefined();
    // 隐藏的链产物不随本批落盘——把关面（写作页）没审过，不得静默写 chapters/。
    expect(window.orisonDesktop.applyAgentFieldPatch).not.toHaveBeenCalled();
    // applied 返回不含被排除 patch。
    expect(applied?.patches.map((p) => p.field as string)).toEqual(['scene_graph']);
    // 重 stage：键保留、只含被排除的 chapter_candidate、selections 重置默认选中（写作页 apply 即落盘）。
    const restaged = useTestStore.getState().pendingPatchBySession[SESS];
    expect(restaged?.patch.patches.map((p) => p.field as string)).toEqual(['chapter_candidate']);
    expect(restaged?.selections).toEqual({ chapter_candidate: true });
    expect(restaged?.issues).toEqual([]);
  });

  it('excludeFields 后 selectedPatches 空（只勾了被排除 field）→ 返 null 且重 stage（不静默清丢）', () => {
    useTestStore.getState().setPendingPatch(SESS, mixedBatch());
    selectPatches({ chapter_candidate: true }); // scene_graph 未勾

    const applied = useTestStore.getState().applySelectedPatches(undefined, ['chapter_candidate']);

    expect(applied).toBeNull();
    expect(window.orisonDesktop.syncField).not.toHaveBeenCalled();
    expect(window.orisonDesktop.applyAgentFieldPatch).not.toHaveBeenCalled();
    const restaged = useTestStore.getState().pendingPatchBySession[SESS];
    expect(restaged?.patch.patches.map((p) => p.field as string)).toEqual(['chapter_candidate']);
    expect(restaged?.selections).toEqual({ chapter_candidate: true });
  });

  it('排除集空（undefined）→ 全批语义照旧清键（既有挂载形态零回归）', () => {
    useTestStore.getState().setPendingPatch(SESS, mixedBatch());
    selectPatches({ scene_graph: true });

    useTestStore.getState().applySelectedPatches(undefined, undefined);

    expect(useTestStore.getState().pendingPatchBySession[SESS]).toBeUndefined();
  });

  it('尾参 sessionId → 按目标会话键 apply（写作页产物区按链会话挂载；视图会话键不动）', () => {
    const chainSid = 'sess-chain';
    useTestStore.getState().setPendingPatch(chainSid, makeChapterCandidatePatch());
    const s = useTestStore.getState();
    const entry = s.pendingPatchBySession[chainSid];
    if (!entry) throw new Error('no pending patch entry');
    useTestStore.setState({ pendingPatchBySession: { ...s.pendingPatchBySession, [chainSid]: { ...entry, selections: { chapter_candidate: true } } } });

    useTestStore.getState().applySelectedPatches(chainSid);

    // 目标会话键的 chapter_candidate 落盘 + 清键；视图会话（SESS）无键不受影响。
    expect(window.orisonDesktop.applyAgentFieldPatch).toHaveBeenCalledTimes(1);
    expect(useTestStore.getState().pendingPatchBySession[chainSid]).toBeUndefined();
  });
});

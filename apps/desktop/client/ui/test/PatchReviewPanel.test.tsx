/**
 * Story 1.5 Phase A (design §4 / §1.2): PatchReviewPanel UI behaviour.
 *
 * The panel is the resurrected UI consumer for the creativeFieldsSlice patch
 * channel (store API stayed intact in 1.3; only the UI was deleted in 94b40d7).
 * These tests cover the wiring: null guard, patch listing, action forwarding.
 * The slice's own behaviour (validate, art_overrides, CR-013 merge) is covered
 * by creativeFieldsSceneGraph.test.ts — not duplicated here. Actions are mocked
 * (vi.fn) so these tests assert forwarding, not slice semantics.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchReviewPanel } from '../src/features/agent-panel/PatchReviewPanel';
import { useAppStore } from '../src/shared/store/appStore';
import type { ProjectFieldPatch } from '@orison/shared-contracts';

const sceneGraphPatch: ProjectFieldPatch = {
  runId: 'run-1',
  createdAt: '2026-07-27T00:00:00Z',
  patches: [
    {
      field: 'scene_graph',
      action: 'set',
      data: { nodes: [], edges: [], lines: [] },
      fieldVersion: 1,
      generatedBy: 'story-planner-agent',
    },
  ],
};

const multiFieldPatch: ProjectFieldPatch = {
  runId: 'run-2',
  createdAt: '2026-07-27T00:00:00Z',
  patches: [
    {
      field: 'outline',
      action: 'merge',
      data: { central_conflict: '新冲突' },
      fieldVersion: 2,
      generatedBy: 'story-planner-agent',
    },
    {
      field: 'scene_graph',
      action: 'set',
      data: { nodes: [], edges: [], lines: [] },
      fieldVersion: 1,
      generatedBy: 'story-planner-agent',
    },
  ],
};

describe('PatchReviewPanel', () => {
  let togglePatchSelection: ReturnType<typeof vi.fn>;
  let applySelectedPatches: ReturnType<typeof vi.fn>;
  let setPendingPatch: ReturnType<typeof vi.fn>;
  let toggleFieldLock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    togglePatchSelection = vi.fn();
    applySelectedPatches = vi.fn();
    setPendingPatch = vi.fn();
    toggleFieldLock = vi.fn();

    useAppStore.setState({
      resolvedLocale: 'en-US',
      agentSessionId: 'sess-pr',
      pendingPatchBySession: {},
      fieldMetadata: {},
      togglePatchSelection,
      applySelectedPatches,
      setPendingPatch,
      toggleFieldLock,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when pendingPatch is null', () => {
    render(<PatchReviewPanel />);
    expect(screen.queryByText('Patch Review')).toBeNull();
  });

  it('lists pending patches when pendingPatch is non-null', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // Title + run id.
    expect(screen.getByText('Patch Review')).toBeTruthy();
    expect(screen.getByText(/Run: run-1/)).toBeTruthy();
    // Field label resolves via creative.tabs.scene_graph (CR-003 key added).
    expect(screen.getByText('Scene Graph')).toBeTruthy();
    // Action label resolves via creative.patch.set.
    expect(screen.getByText('Set')).toBeTruthy();
    // generatedBy is surfaced verbatim.
    expect(screen.getByText('story-planner-agent')).toBeTruthy();
  });

  it('lists every patch entry in a multi-field patch', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: multiFieldPatch, selections: { outline: true, scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // Both field labels render (outline tab + scene_graph tab).
    expect(screen.getByText('Outline')).toBeTruthy();
    expect(screen.getByText('Scene Graph')).toBeTruthy();
    // Both action labels render (merge + set).
    expect(screen.getByText('Merge')).toBeTruthy();
    expect(screen.getAllByText('Set')).toHaveLength(1);
  });

  it('reflects the checkbox state from patchSelections and forwards toggles', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    await userEvent.click(checkbox);
    // W4（D-g 切分）：toggle 尾参传目标会话（缺省视图会话）。
    expect(togglePatchSelection).toHaveBeenCalledWith('scene_graph', 'sess-pr');
  });

  it('forwards Apply to applySelectedPatches', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    expect(applySelectedPatches).toHaveBeenCalledTimes(1);
  });

  it('forwards Reject to setPendingPatch(null)', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
    } as any);

    render(<PatchReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject All' }));

    expect(setPendingPatch).toHaveBeenCalledWith('sess-pr', null);
  });

  it('does not show issue badges when pendingPatchIssues is empty', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
          } as any);

    const { container } = render(<PatchReviewPanel />);
    expect(container.querySelector('.patch-review-badge')).toBeNull();
  });

  it('surfaces scene_graph error/warning counts from the Story 1.3 data channel', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true }, issues: [
        { code: 'causal-cycle', severity: 'error', message: 'm', targets: [] },
        { code: 'unreachable-line', severity: 'warning', message: 'm', targets: [] },
      ] } },
    } as any);

    const { container } = render(<PatchReviewPanel />);
    expect(container.querySelector('.patch-review-badge--error')?.textContent).toBe('1');
    expect(container.querySelector('.patch-review-badge--warning')?.textContent).toBe('1');
  });

  it('does not show issue badges on non-scene_graph patches', () => {
    const outlinePatch: ProjectFieldPatch = {
      runId: 'run-3',
      createdAt: '2026-07-27T00:00:00Z',
      patches: [
        {
          field: 'outline',
          action: 'set',
          data: { central_conflict: 'x' },
          fieldVersion: 1,
          generatedBy: 'story-planner-agent',
        },
      ],
    };
    // Issues are scene_graph-scoped at the slice level, but guard anyway: an
    // outline row must not show badges even if issues were somehow present.
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: outlinePatch, selections: { outline: true }, issues: [
        { code: 'causal-cycle', severity: 'error', message: 'm', targets: [] },
      ] } },
    } as any);

    const { container } = render(<PatchReviewPanel />);
    expect(container.querySelector('.patch-review-badge')).toBeNull();
  });

  // Story 4.1 Step 5：write_chapter accept_as_truth → field_patch chapter_candidate
  // → PatchReviewPanel 显示章节正文候选行（label / action / generatedBy），accept 走
  // applySelectedPatches → applyAgentFieldPatch IPC（持久化 chapters/*.md）。
  it('renders a chapter_candidate patch row from write_chapter（Story 4.1 Step 5）', () => {
    const chapterCandidatePatch: ProjectFieldPatch = {
      runId: 'run-cc',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文…' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: chapterCandidatePatch, selections: { chapter_candidate: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // creative.tabs.chapter_candidate label resolves（"Chapter Draft" en-US）。
    expect(screen.getByText('Chapter Draft')).toBeTruthy();
    // generatedBy 透传（write_chapter）。
    expect(screen.getByText('write_chapter')).toBeTruthy();
  });

  // ── Story 3.1 WP5: per-row field-lock toggle wiring. ──

  it('renders a lock button per creative-field row and forwards to toggleFieldLock', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
      fieldMetadata: {},
    } as any);

    render(<PatchReviewPanel />);

    // Unlocked scene_graph row exposes a "Lock field" button (en-US).
    const lockBtn = screen.getByRole('button', { name: 'Lock field' });
    await userEvent.click(lockBtn);

    expect(toggleFieldLock).toHaveBeenCalledWith('scene_graph');
  });

  it('reflects the locked state from fieldMetadata on the lock button', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: sceneGraphPatch, selections: { scene_graph: true } } },
      fieldMetadata: { scene_graph: { version: 1, source: 'user', locked: true, dependsOn: [], stale: false } },
    } as any);

    render(<PatchReviewPanel />);

    // A locked row exposes an "Unlock field" button, marked pressed.
    const lockBtn = screen.getByRole('button', { name: 'Unlock field' });
    expect(lockBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not render a lock button on chapter_candidate rows (not a creative field)', () => {
    const chapterCandidatePatch: ProjectFieldPatch = {
      runId: 'run-cc',
      createdAt: '2026-08-01T00:00:00Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set',
          data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文…' } },
          fieldVersion: 1,
          generatedBy: 'write_chapter',
        },
      ],
    };
    useAppStore.setState({
      pendingPatchBySession: { 'sess-pr': { patch: chapterCandidatePatch, selections: { chapter_candidate: true } } },
    } as any);

    render(<PatchReviewPanel />);

    // No lock/unlock button on a chapter_candidate row.
    expect(screen.queryByRole('button', { name: 'Lock field' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unlock field' })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 09-13 子3 W4（design §5.2 / 拍板 D-g 切分）：props sessionId（写作页产物区按链会话挂载）
// + excludeChapterCandidate（对话栏过滤——链产物不渲染全尺寸卡，apply 不静默落盘隐藏 patch）。
// ═══════════════════════════════════════════════════════════════════════════
describe('PatchReviewPanel — W4 D-g 切分（sessionId / excludeChapterCandidate）', () => {
  const chapterCandidateOnly: ProjectFieldPatch = {
    runId: 'run-cc',
    createdAt: '2026-08-01T00:00:00Z',
    patches: [
      {
        field: 'chapter_candidate' as any,
        action: 'set',
        data: { chapterId: 'ch_001', runId: 'run_mock', candidate: { content: '正文…' } },
        fieldVersion: 1,
        generatedBy: 'write_chapter',
      },
    ],
  };

  const mixedPatch: ProjectFieldPatch = {
    runId: 'run-mixed',
    createdAt: '2026-08-01T00:00:00Z',
    patches: [
      ...chapterCandidateOnly.patches,
      {
        field: 'outline',
        action: 'set',
        data: { phases: [{ id: 'p1', title: 'Volume One' }] },
        fieldVersion: 2,
        generatedBy: 'story-planner-agent',
      },
    ],
  };

  let applySelectedPatches: ReturnType<typeof vi.fn>;
  let setPendingPatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    applySelectedPatches = vi.fn();
    setPendingPatch = vi.fn();
    useAppStore.setState({
      resolvedLocale: 'en-US',
      agentSessionId: 'sess-view',
      pendingPatchBySession: {},
      fieldMetadata: {},
      applySelectedPatches,
      setPendingPatch,
      togglePatchSelection: vi.fn(),
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('excludeChapterCandidate + 纯 chapter_candidate 批 → 整卡不渲染（对话栏只挂轻量提示）', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-view': { patch: chapterCandidateOnly, selections: { chapter_candidate: true } } },
    } as any);

    const { container } = render(<PatchReviewPanel excludeChapterCandidate />);

    expect(container.querySelector('.patch-review')).toBeNull();
  });

  it('excludeChapterCandidate + 混合批 → 非链行照常渲染、chapter_candidate 行隐藏', () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-view': { patch: mixedPatch, selections: { chapter_candidate: true, outline: true } } },
    } as any);

    render(<PatchReviewPanel excludeChapterCandidate />);

    expect(screen.getByText('Outline')).toBeTruthy();
    expect(screen.queryByText('Chapter Draft')).toBeNull();
  });

  it('excludeChapterCandidate 的 Apply → applySelectedPatches 传排除集（隐藏 patch 不静默落盘）', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-view': { patch: mixedPatch, selections: { chapter_candidate: true, outline: true } } },
    } as any);

    render(<PatchReviewPanel excludeChapterCandidate />);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    expect(applySelectedPatches).toHaveBeenCalledWith('sess-view', ['chapter_candidate']);
  });

  it('缺省挂载（不过滤）→ apply 无排除集（既有形态零回归）', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-view': { patch: chapterCandidateOnly, selections: { chapter_candidate: true } } },
    } as any);

    render(<PatchReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));

    expect(applySelectedPatches).toHaveBeenCalledWith('sess-view', undefined);
  });

  it('props sessionId → 读目标会话的挂起 patch + apply/reject 按该会话（写作页产物区形态）', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-chain': { patch: chapterCandidateOnly, selections: { chapter_candidate: true } } },
    } as any);

    render(<PatchReviewPanel sessionId="sess-chain" />);

    // 视图会话（sess-view）无键——本卡读 sess-chain 的键。
    expect(screen.getByText('Chapter Draft')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apply Selected' }));
    expect(applySelectedPatches).toHaveBeenCalledWith('sess-chain', undefined);

    await userEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(setPendingPatch).toHaveBeenCalledWith('sess-chain', null);
  });

  // CR-1：Reject All 在过滤挂载下整键清场会静默丢弃被隐藏的 chapter_candidate envelope
  //（apply 路径有重 stage 保护，reject 路径此前漏）——mirror apply 的 re-stage 语义。
  it('CR-1：excludeChapterCandidate + 混合批 Reject All → 整键清场 + 重 stage 被隐藏的 chapter_candidate（原批 runId 保持、默认选中）', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-view': { patch: mixedPatch, selections: { chapter_candidate: true, outline: true } } },
    } as any);

    render(<PatchReviewPanel excludeChapterCandidate />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject All' }));

    expect(setPendingPatch).toHaveBeenCalledTimes(2);
    expect(setPendingPatch).toHaveBeenCalledWith('sess-view', null);
    const restage = (setPendingPatch.mock.calls[1] as [string, ProjectFieldPatch])[1];
    expect(restage.runId).toBe('run-mixed'); // 原批 runId/createdAt 保持
    expect(restage.createdAt).toBe('2026-08-01T00:00:00Z');
    expect(restage.patches).toHaveLength(1); // 只剩被隐藏的链产物行
    expect(restage.patches[0].field).toBe('chapter_candidate');
  });

  it('CR-1：纯链挂载（不过滤）Reject All → 整键清场不变（无重 stage 调用）', async () => {
    useAppStore.setState({
      pendingPatchBySession: { 'sess-view': { patch: mixedPatch, selections: { outline: true } } },
    } as any);

    render(<PatchReviewPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject All' }));

    expect(setPendingPatch).toHaveBeenCalledTimes(1);
    expect(setPendingPatch).toHaveBeenCalledWith('sess-view', null);
  });
});

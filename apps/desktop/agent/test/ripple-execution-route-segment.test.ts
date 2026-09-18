import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 Phase 4.1：涟漪执行路由引导 segment 注入测试。
//
// Phase 4.1 在 interaction 状态快照末尾（stale 段之后）追加「执行路由引导」段——
// 仅当有 stale 时注入。引导 leader 按 impactType + autonomy 轴路由到既有工具
// （scene_graph_update / field_update / write_chapter / dismiss_stale_fields），非新建执行器。
//
// 测四态：
// 1. has stale → 含执行路由引导 + impactType 路由分类 + dismiss_stale_fields + autonomy 映射。
// 2. no stale / degraded → 不含执行路由引导段（仅 stale 段，无执行段）。
// 3. autonomy 映射三档（auto / suggest / readonly）→ 含对应权限 hint。
// 4. present_result 收尾契约在执行段末（mirror 涟漪流程收尾）。
//
// 测试方法：buildSessionStateSnapshot 非 exported → 经 sendMessage end-to-end 验。
// system 稳定化（09-12）后 interaction 段已迁出 system prompt，改以 kind='session_state_note'
// 的 user 消息追加在消息尾——generate mock 收 messages 断言注记 content 含期望文本，
// mirror stale-fields-segment.test.ts 模式。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

/** generate mock 第 1 参 messages 里的 session_state_note 注记（interaction 段迁居处）。 */
function findSessionStateNote(messages: unknown): { content: string } | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.find((m) => (m as { kind?: string } | null)?.kind === 'session_state_note') as
    | { content: string }
    | undefined;
}

describe('Story 3.4 Phase 4.1 — 涟漪执行路由引导 segment injection', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-ripple-route-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** Write a project.yaml with the given field_metadata stale map + optional permissionMode hint. */
  function writeProjectYaml(staleFields: string[]) {
    const fm: Record<string, { stale: boolean }> = {};
    for (const f of staleFields) {
      fm[f] = { stale: true };
    }
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({ name: 'Test', field_metadata: fm }),
      'utf-8',
    );
  }

  /** Build runtime with given permissionMode + capture session state note via generate mock. */
  async function captureSessionStateNote(permissionMode?: 'readonly' | 'suggest' | 'auto') {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    let capturedNote: { content: string } | undefined;
    const generate = vi.fn(async (messages: unknown, _system: string) => {
      capturedNote = findSessionStateNote(messages);
      return { content: 'ok', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({
      agentName: 'writer',
      projectPath,
      ...(permissionMode ? { mode: permissionMode } : {}),
    });
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });
    return capturedNote;
  }

  it('has stale：含执行路由引导段 + impactType 分类路由 + dismiss_stale_fields + present_result 收尾', async () => {
    writeProjectYaml(['scene_graph']);

    const note = await captureSessionStateNote();

    // 执行路由引导段标题。
    expect(note?.content).toContain('涟漪执行路由');
    // impactType 分类路由（conflict/contradiction / stale-derivative / opportunity / no-impact/no-events）。
    expect(note?.content).toContain('conflict');
    expect(note?.content).toContain('contradiction');
    expect(note?.content).toContain('stale-derivative');
    expect(note?.content).toContain('opportunity');
    expect(note?.content).toContain('no-impact');
    // 涉及正文 → Epic 7 定点修路径（write_chapter + revisionIntent）。
    expect(note?.content).toContain('write_chapter');
    expect(note?.content).toContain('revisionIntent');
    // dismiss 通路（clearStale dismiss）。
    expect(note?.content).toContain('dismiss_stale_fields');
    // 既有 field_update 工具指引（非新建执行器）。
    expect(note?.content).toContain('scene_graph_update');
    expect(note?.content).toContain('outline_update');
    // 冲突灰区两选项（V1 文字两选项 + adjudicator 专属派发根 TODO）。
    expect(note?.content).toContain('两选项');
    expect(note?.content).toContain('TODO');
    // present_result 收尾契约。
    expect(note?.content).toContain('present_result');
    expect(note?.content).toContain('awaiting_intent_confirmation');
  });

  it('no stale（全最新）：不含执行路由引导段（仅 stale 段「均为最新」）', async () => {
    writeProjectYaml([]);

    const note = await captureSessionStateNote();

    // stale 段在（「均为最新」）。
    expect(note?.content).toContain('均为最新');
    // 执行路由引导段不在（无 stale 无需路由）。
    expect(note?.content).not.toContain('涟漪执行路由');
  });

  it('degraded（project.yaml 不可读）：不含执行路由引导段', async () => {
    // 不写 project.yaml → readFile 失败 → loadStaleFieldsForLeader 返 null。
    const note = await captureSessionStateNote();

    // stale 段降级提示在。
    expect(note?.content).toContain('stale 状态暂不可用');
    // 执行路由引导段不在。
    expect(note?.content).not.toContain('涟漪执行路由');
  });

  it('autonomy=auto → 执行路由段含「全权模式」+ 直接执行 hint', async () => {
    writeProjectYaml(['scene_graph']);
    const note = await captureSessionStateNote('auto');
    expect(note?.content).toContain('全权模式');
    expect(note?.content).toContain('直接调 bounded-action 工具');
  });

  it('autonomy=suggest → 执行路由段含「半自动模式」+ PatchReview hint', async () => {
    writeProjectYaml(['scene_graph']);
    const note = await captureSessionStateNote('suggest');
    expect(note?.content).toContain('半自动模式');
    expect(note?.content).toContain('PatchReview');
  });

  it('autonomy=readonly → 执行路由段含「微操模式」+ 只提建议 hint', async () => {
    writeProjectYaml(['scene_graph']);
    const note = await captureSessionStateNote('readonly');
    expect(note?.content).toContain('微操模式');
    expect(note?.content).toContain('只提建议');
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../src/types';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 Phase 3.1-3.2：loadStaleFieldsForLeader + 状态注记（session_state_note）
// stale 待诊断段注入测试。
//
// 测三态（mirror 结构健康度三态模式）：
// 1. has stale（field_metadata 含 stale=true）→ 注记含 stale 字段名 + diagnose_impacts 引导。
// 2. no stale（field_metadata 全 stale=false）→ 注记含「均为最新」。
// 3. degraded（project.yaml 不可读）→ 注记含「暂不可用」。
//
// 测试方法：loadStaleFieldsForLeader / 快照渲染非 exported → 经 sendMessage end-to-end 验。
// system 稳定化（09-12）后 interaction 段文本迁至 turn 开始追加的 session_state_note 注记
// 消息（user-role，`<session_state readonly="true">` 包裹）——generate mock 从 1 参 messages
// 取注记断言（mirror runtime.workflow.test.ts 的 sendMessage 模式）。
// ─────────────────────────────────────────────────────────────────────────────

/** 从 generate mock 收到的消息流取状态注记（turn 开始 hash 门追加——首轮必发一条）。 */
function stateNote(messages: SessionMessage[]): SessionMessage | undefined {
  return messages.find((message) => message.kind === 'session_state_note');
}

describe('Story 3.4 Phase 3 — loadStaleFieldsForLeader + 状态注记注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-stale-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** Write a project.yaml with the given field_metadata stale map. */
  function writeProjectYaml(staleFields: string[]) {
    const fm: Record<string, { stale: boolean }> = {};
    for (const f of staleFields) {
      fm[f] = { stale: true };
    }
    const doc = {
      name: 'Test',
      field_metadata: fm,
    };
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf-8');
  }

  it('has stale：状态注记含 stale 字段名 + diagnose_impacts 引导 + present_result 指引', async () => {
    writeProjectYaml(['scene_graph', 'asset_cards']);

    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (messages: SessionMessage[], _system: string) => {
      const note = stateNote(messages);
      // stale 字段名进注记（按 creativeFieldKeys enum 序：asset_cards < scene_graph）。
      expect(note?.content).toContain('asset_cards');
      expect(note?.content).toContain('scene_graph');
      // diagnose_impacts tool 引导。
      expect(note?.content).toContain('diagnose_impacts');
      // present_result 收尾指引。
      expect(note?.content).toContain('present_result');
      // stale 计数（2 个字段）。
      expect(note?.content).toContain('2 个创作字段');
      return { content: 'ok', finishReason: 'stop' };
    });

    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledOnce();
  });

  it('no stale：状态注记含「均为最新」graceful 提示（mirror 结构健康度无 issue 态）', async () => {
    // field_metadata 存在但全 stale=false。
    writeProjectYaml([]);

    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (messages: SessionMessage[], _system: string) => {
      const note = stateNote(messages);
      expect(note?.content).toContain('均为最新');
      expect(note?.content).toContain('无待诊断改动');
      return { content: 'ok', finishReason: 'stop' };
    });

    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledOnce();
  });

  it('degraded（project.yaml 不可读）：状态注记含「暂不可用」graceful 降级提示', async () => {
    // 不写 project.yaml → readFile 失败 → loadStaleFieldsForLeader 返 null → 快照走 undefined 分支。
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (messages: SessionMessage[], _system: string) => {
      const note = stateNote(messages);
      expect(note?.content).toContain('stale 状态暂不可用');
      expect(note?.content).toContain('project.yaml 不可读');
      return { content: 'ok', finishReason: 'stop' };
    });

    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledOnce();
  });

  it('field_metadata 缺省（project.yaml 可读但无 field_metadata）：视为无 stale（均为最新）', async () => {
    // project.yaml 可读但无 field_metadata 键 → loadStaleFieldsForLeader 返 { staleFields: [], total: 0 }
    // → 快照走 length===0 分支（全最新），非 undefined 降级。
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({ name: 'Test' }),
      'utf-8',
    );

    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (messages: SessionMessage[], _system: string) => {
      const note = stateNote(messages);
      expect(note?.content).toContain('均为最新');
      // 不含「暂不可用」（非降级态）。
      expect(note?.content).not.toContain('stale 状态暂不可用');
      return { content: 'ok', finishReason: 'stop' };
    });

    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledOnce();
  });

  it('stale 非布尔值（undefined/null/0）不命中（仅 stale===true 计入）', async () => {
    // 只 world_setting stale=true；scene_graph stale=undefined（缺 stale 键）；emotion_curve stale=false。
    const fm: Record<string, Record<string, unknown>> = {
      world_setting: { stale: true },
      scene_graph: {}, // stale undefined
      emotion_curve: { stale: false },
    };
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({ name: 'Test', field_metadata: fm }),
      'utf-8',
    );

    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (messages: SessionMessage[], _system: string) => {
      const note = stateNote(messages);
      expect(note?.content).toContain('world_setting');
      expect(note?.content).toContain('1 个创作字段');
      // scene_graph / emotion_curve 不进 stale 列表（非 true）。
      expect(note?.content).not.toContain('2 个创作字段');
      return { content: 'ok', finishReason: 'stop' };
    });

    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledOnce();
  });
});

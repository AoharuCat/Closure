/**
 * Story 4.1 Step 5（design §3.4）：leader system prompt 含 write_chapter 工具使用引导。
 *
 * leader 凭此引导识别「写第 N 章」/ 工作台选章意图 → 调 write_chapter tool（4.0
 * capability-only → 4.1 exercised）。验证方式：mock generate() 捕获 system prompt，
 * 断言含 write_chapter 引导文字（grep-able）。
 *
 * `DEFAULT_CLOSURE_PROMPT`（workflow.ts 内部 const，非 export）经 buildRuntimeSystemPrompt
 * 组装进 leader system prompt（runLoop 调 generate 时传 sys 参）。本测试走 runtime.sendMessage
 * 真实路径捕获——不读源文件（抗重构）。
 */
import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

describe('leader system prompt — write_chapter 引导（Story 4.1 Step 5）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-leader-prompt-'));
  });

  afterEach(async () => {
    // 测试内 runtime.createSession 开的句柄先关再删目录（mirror chain-node-streaming.test.ts
    // 清理形态）——零 close 直接 resetModules 会孤儿化句柄（S1 制图 §2.2-B）。
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('leader system prompt 含 write_chapter 引导段（何时调 + episodeId/chapterId/chapterBrief 参数说明）', async () => {
    const capturedSystem: string[] = [];
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (_messages, system) => {
        if (typeof system === 'string') capturedSystem.push(system);
        return { content: 'done', finishReason: 'stop' };
      }),
    });

    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({ sessionId: session.id, content: '请写第 1 章' });

    expect(capturedSystem.length).toBeGreaterThan(0);
    const leaderSystem = capturedSystem.join('\n');
    // 引导段标题 + 工具名（grep-able）。
    expect(leaderSystem).toContain('write_chapter');
    expect(leaderSystem).toContain('Chapter Generation');
    // 参数引导（episodeId 必填 + chapterId 直传 + chapterBrief LLM 段）。
    expect(leaderSystem).toContain('episodeId');
    expect(leaderSystem).toContain('chapterId');
    expect(leaderSystem).toContain('chapterBrief');
    // 中文触发短语（用户工作台「写第 N 章」）。
    expect(leaderSystem).toContain('写第 N 章');
  });
});

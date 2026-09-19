/**
 * Story 3.6 WP8.2：leader system prompt 含 Research 段（直查 vs 派发判据 + 五段
 * brief 模板 + manual 视觉转告协议 + canon 冲突问作者 + 策展提醒）。
 *
 * 验证方式 mirror leader-write-chapter-prompt.test.ts：mock generate() 捕获 system
 * prompt，断言含 Research 段引导文字（grep-able）——不读源文件（抗重构）。
 * `DEFAULT_CLOSURE_PROMPT`（workflow.ts 内部 const，非 export）经 buildRuntimeSystemPrompt
 * 组装进 leader system prompt。
 */
import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

describe('leader system prompt — Research 段（Story 3.6 WP8.2）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-leader-research-'));
  });

  afterEach(async () => {
    // 测试内 runtime.createSession 开的句柄先关再删目录（mirror chain-node-streaming.test.ts
    // 清理形态）——零 close 直接 resetModules 会孤儿化句柄（S1 制图 §2.2-B）。
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('leader system prompt 含 Research 段（派发判据 + 五段 brief + manual 协议红线 + 策展提醒）', async () => {
    const capturedSystem: string[] = [];
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (_messages, system) => {
        if (typeof system === 'string') capturedSystem.push(system);
        return { content: 'done', finishReason: 'stop' };
      }),
    });

    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({ sessionId: session.id, content: '帮我查一下阿米娅的能力设定' });

    expect(capturedSystem.length).toBeGreaterThan(0);
    const leaderSystem = capturedSystem.join('\n');
    // 段标题 + 两路径工具名（grep-able）。
    expect(leaderSystem).toContain('## Research');
    expect(leaderSystem).toContain('dispatch_researcher');
    expect(leaderSystem).toContain('wiki_search');
    expect(leaderSystem).toContain('web_fetch');
    expect(leaderSystem).toContain('render_page');
    expect(leaderSystem).toContain('parse_document');
    expect(leaderSystem).toContain('analyze_image');
    // 五段 brief 模板（派发契约）。
    expect(leaderSystem).toContain('研究问题');
    expect(leaderSystem).toContain('创作背景');
    expect(leaderSystem).toContain('已知与假设');
    expect(leaderSystem).toContain('期望产出');
    // 深研究示例（多源综合判据）。
    expect(leaderSystem).toContain('阿米娅');
    // manual 视觉转告协议 + 红线（绝不编造图片内容）。
    expect(leaderSystem).toContain('视觉模型未配置');
    expect(leaderSystem).toContain('NEVER fabricate');
    // canon 冲突问作者（创作决定归人）。
    expect(leaderSystem).toContain('Canon conflicts');
    // 策展提醒（两个工具都提，WP9 落地）。
    expect(leaderSystem).toContain('save_craft_doc');
    expect(leaderSystem).toContain('asset_cards_update');
  });
});

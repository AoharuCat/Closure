import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../src/types';

/**
 * system 稳定化（09-12）dialogue 车道验收测试（prd AC1/AC4 + 注记形态 + 容错 + 手钉共存）。
 *
 * 目标形态：system = 恒定区（同会话无设定变更两轮 wire system 字节相同）；设定编译前缀 =
 * pinned auto 项（变更轮 diverge 一次）；interaction 状态 = user-role 状态注记追加尾部
 *（append 分支永不破缓存，hash 门幂等）。
 *
 * 形态 mirror runtime.workflow.test.ts：真实临时项目目录 + vi.mock skill discovery +
 * resetModules 动态 import（session/registry 状态隔离）+ generate mock 捕获。
 */

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

interface Captured {
  messages: SessionMessage[];
  system: string;
  pinnedContent?: string;
  /** C 批 W_c2：generate 实收 opts.cacheControl（dialogue 装配点断言面）。 */
  cacheControl?: boolean;
}

function makeProjectYaml(genre: string, withDecision = false): string {
  const lines = ['creative_brief:', `  genre: ${genre}`];
  if (withDecision) {
    lines.push(
      'novel:',
      '  story_decisions:',
      '    - id: d1',
      '      summary: 主角走黑化线',
      '      reason: 拍板测试',
      '      risk: 读者流失风险',
      "      createdAt: '2026-09-13T00:00:00Z'",
    );
  }
  return lines.join('\n');
}

describe('runtime dialogue prefix stabilization (09-12 system 稳定化)', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-dialogue-prefix-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** 两轮 sendMessage，捕获每轮 generate 实收（messages / system / cacheConfig.pinnedContent）。 */
  async function runTwoTurns(yamlRound2: string): Promise<{ captured: Captured[]; sessionId: string }> {
    writeFileSync(path.join(projectPath, 'project.yaml'), makeProjectYaml('都市'), 'utf-8');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const captured: Captured[] = [];
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (messages: SessionMessage[], system: string, _tools: unknown, _abort: unknown, opts?: { cacheControl?: boolean }, cacheConfig?: { pinnedContent?: string }) => {
        captured.push({ messages, system, pinnedContent: cacheConfig?.pinnedContent, cacheControl: opts?.cacheControl });
        return { content: 'ok', finishReason: 'stop' };
      }),
    });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: '第一轮',
      abortSignal: new AbortController().signal,
    });
    // 第二轮前按需改盘（设定变更 / 状态变更 fixture 由 caller 决定）。
    writeFileSync(path.join(projectPath, 'project.yaml'), yamlRound2, 'utf-8');
    await runtime.sendMessage({
      sessionId: session.id,
      content: '第二轮',
      abortSignal: new AbortController().signal,
    });
    return { captured, sessionId: session.id };
  }

  it('AC1 前缀稳定：同会话无设定变更两轮，wire system 字节相同（恒定区）', async () => {
    // 第二轮盘内容与第一轮相同（同 yaml）→ pinned 不变 + 快照不变 → system 恒定。
    const { captured } = await runTwoTurns(makeProjectYaml('都市'));
    expect(captured).toHaveLength(2);
    expect(captured[1].system).toBe(captured[0].system);
    // 恒定区三件在场：path 行 + 引导行 + 恒定骨架；全文内嵌不在场。
    expect(captured[0].system).toContain(`Project path: ${projectPath}`);
    expect(captured[0].system).toContain('readable with the read_file tool');
    expect(captured[0].system).not.toContain('<project_config');
  });

  it('AC1 配套：pinned 编译前缀两轮相同且设定在场（creative_brief → 设定核心前缀）', async () => {
    const { captured } = await runTwoTurns(makeProjectYaml('都市'));
    expect(captured[0].pinnedContent).toContain('设定核心前缀');
    expect(captured[0].pinnedContent).toContain('题材：都市');
    expect(captured[1].pinnedContent).toBe(captured[0].pinnedContent);
  });

  it('C 批 W_c2：dialogue 装配点置 cacheControl:true（generate 实收 opts——Anthropic 断点开关）', async () => {
    // 三面同步的 agent 缝面验收：flag 经 GenerateOptions → body 构造点 → wire schema 到
    // 协议层 buildAnthropicBody；dialogue 两轮恒 true（装配点静态置位，非状态门控）。
    const { captured } = await runTwoTurns(makeProjectYaml('都市'));
    expect(captured).toHaveLength(2);
    expect(captured[0].cacheControl).toBe(true);
    expect(captured[1].cacheControl).toBe(true);
  });

  it('AC4 落盘轮语义：状态变化轮只追加注记（append-only），system 恒定不被破坏', async () => {
    // 第二轮盘：设定不变（genre 同）+ 新增 open 决策 → 快照变（openDecisions loader 读到）。
    const { captured } = await runTwoTurns(makeProjectYaml('都市', true));

    const notes1 = captured[0].messages.filter((m) => m.kind === 'session_state_note');
    const notes2 = captured[1].messages.filter((m) => m.kind === 'session_state_note');
    // 首轮必发全量注记；状态变化第二轮追加一条（快照 diff）。
    expect(notes1).toHaveLength(1);
    expect(notes2).toHaveLength(2);
    // 追加语义 = append-only：第一轮的消息（user 输入 / assistant / 注记）在第二轮原样在位。
    expect(captured[1].messages.slice(0, captured[0].messages.length)).toEqual(captured[0].messages);
    // system 恒定区不被状态变化破坏（状态不进 system——这正是迁出的意义）。
    expect(captured[1].system).toBe(captured[0].system);
    // 新注记内容含 open 决策信号（Story 2.6 段渲染产物）。
    expect(notes2[1].content).toContain('黑化线');
  });

  it('AC4 设定变更轮：pinned 编译前缀重算 diverge 一次，恢复后稳定', async () => {
    // 第二轮盘：genre 变（设定变更）→ syncDialogueSettingPrefix 重算 → pinned wire 字节变。
    const { captured } = await runTwoTurns(makeProjectYaml('仙侠'));
    expect(captured[0].pinnedContent).toContain('题材：都市');
    expect(captured[1].pinnedContent).not.toBe(captured[0].pinnedContent);
    expect(captured[1].pinnedContent).toContain('题材：仙侠');
    // system 恒定区不受设定变更影响（设定在 pinned 车道，不在 system）。
    expect(captured[1].system).toBe(captured[0].system);
  });

  it('AC4 幂等门：同快照再轮不追加注记（hash 门）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), makeProjectYaml('都市'), 'utf-8');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const captured: Captured[] = [];
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (messages: SessionMessage[], system: string) => {
        if (captured.length === 0 || captured[captured.length - 1].messages !== messages) {
          captured.push({ messages, system });
        }
        return { content: 'ok', finishReason: 'stop' };
      }),
    });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    for (let i = 0; i < 3; i++) {
      await runtime.sendMessage({
        sessionId: session.id,
        content: `第${i + 1}轮`,
        abortSignal: new AbortController().signal,
      });
    }
    // 三轮同快照 → 恒一条注记（首轮全量），第二轮起 hash 门拦住零追加。
    const allNotes = captured[captured.length - 1].messages.filter((m) => m.kind === 'session_state_note');
    expect(allNotes).toHaveLength(1);
  });

  it('CR-P1 自愈门：truncate 删尾后同快照重发（hash 残留不吞重发——流中在位判据）', async () => {
    // CR-P1（09-13 CR 批）配套：hash 同 **且** 流中最后一条注记 content === 本次产物 才跳过。
    // truncate 删尾 / 崩溃缝（jsonl 与 meta 持久化不同步）/ 压缩边界吃掉注记后，hash 残留若仍
    // 跳过 → leader 零状态广播；在位判据强制自愈重发。
    writeFileSync(path.join(projectPath, 'project.yaml'), makeProjectYaml('都市'), 'utf-8');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const captured: Captured[] = [];
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (messages: SessionMessage[], system: string) => {
        captured.push({ messages, system });
        return { content: 'ok', finishReason: 'stop' };
      }),
    });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({
      sessionId: session.id,
      content: '第一轮',
      abortSignal: new AbortController().signal,
    });
    const note1 = captured[0].messages.find((m) => m.kind === 'session_state_note');
    expect(note1).toBeDefined();
    // 模拟 truncate 删尾：把注记从 live session 消息流摘除——contextState.hash 残留不清理
    //（正是自愈门要覆盖的逐出形态）。
    const live = runtime.getSession(session.id)!;
    const noteIdx = live.messages.findIndex((m) => m.kind === 'session_state_note');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    live.messages.splice(noteIdx, 1);
    // 同盘同快照第二轮：hash 同但流中注记不在位 → 自愈重发恰一条、内容与原注记逐字节同。
    await runtime.sendMessage({
      sessionId: session.id,
      content: '第二轮',
      abortSignal: new AbortController().signal,
    });
    const notes2 = captured[1].messages.filter((m) => m.kind === 'session_state_note');
    expect(notes2).toHaveLength(1);
    expect(notes2[0].content).toBe(note1!.content);
  });

  it('注记形态：kind + 头行 + <session_state readonly> 包裹在场', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), makeProjectYaml('都市'), 'utf-8');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const captured: Captured[] = [];
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (messages: SessionMessage[], system: string) => {
        captured.push({ messages, system });
        return { content: 'ok', finishReason: 'stop' };
      }),
    });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });
    const note = captured[0].messages.find((m) => m.kind === 'session_state_note');
    expect(note).toBeDefined();
    expect(note?.role).toBe('user');
    expect(note?.content.startsWith('[session state note — system-injected status, not user input]')).toBe(true);
    expect(note?.content).toContain('<session_state readonly="true">');
    expect(note?.content).toContain('</session_state>');
    // 注记追加位在 user 输入之后（turn 尾垫底）。
    expect(captured[0].messages[captured[0].messages.length - 1]).toBe(note);
  });

  it('syncDialogueSettingPrefix 容错：坏 yaml 归空不驻留、不抛（sendMessage 照常跑）', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), '{{{ not yaml :::', 'utf-8');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const captured: Captured[] = [];
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (messages: SessionMessage[], system: string, _t: unknown, _a: unknown, cacheConfig?: { pinnedContent?: string }) => {
        captured.push({ messages, system, pinnedContent: cacheConfig?.pinnedContent });
        return { content: 'ok', finishReason: 'stop' };
      }),
    });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });
    // 不抛（above await 已证）+ auto 项不驻留（pinnedContent 无设定核心前缀）。
    expect(captured[0].pinnedContent ?? '').not.toContain('设定核心前缀');
    // system 恒定区照常（path 行在场）。
    expect(captured[0].system).toContain(`Project path: ${projectPath}`);
  });

  it('用户手钉项共存：auto upsert 不触碰 source=user 项', async () => {
    writeFileSync(path.join(projectPath, 'project.yaml'), makeProjectYaml('都市'), 'utf-8');
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const captured: Captured[] = [];
    const runtime = createWorkflowRuntime({
      generate: vi.fn(async (messages: SessionMessage[], system: string) => {
        captured.push({ messages, system });
        return { content: 'ok', finishReason: 'stop' };
      }),
    });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    // 预置用户手钉项（固定 id 'user-pin-1'——auto 项 upsert 只动 'setting-prefix:core'）。
    const live = runtime.getSession(session.id);
    expect(live).toBeDefined();
    live!.pinnedContext = [
      {
        id: 'user-pin-1',
        type: 'custom',
        label: '用户手钉',
        content: '手钉内容不可被 auto 同步触碰',
        priority: 90,
        createdAt: Date.now(),
        source: 'user',
      },
    ];
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });
    const after = runtime.getSession(session.id)?.pinnedContext ?? [];
    const userPin = after.find((item) => item.id === 'user-pin-1');
    expect(userPin).toMatchObject({ label: '用户手钉', content: '手钉内容不可被 auto 同步触碰' });
    const autoItem = after.find((item) => item.id === 'setting-prefix:core');
    expect(autoItem?.source).toBe('auto');
    expect(autoItem?.content).toContain('题材：都市');
    // 注记照常追加（手钉共存不影响注记通道）。
    expect(captured[0].messages.some((m) => m.kind === 'session_state_note')).toBe(true);
  });
});

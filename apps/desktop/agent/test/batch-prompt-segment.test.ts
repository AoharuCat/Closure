import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, deleteSession } from '../src/agent/session';
// 静态 closeDb：与上方静态 createSession 绑定同代模块实例——resetModules 后动态 import 解析到
// 新代，旧代 dbCache 里的静态句柄只有静态引用够得着（S1 制图 §2.2-A 静态实例孤儿向量）。
import { closeDb } from '../src/agent/persistence';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 5：批量协议段注入（design §2.2 四档协议表）。经 sendMessage end-to-end 验。
// system 稳定化（09-12）后批量协议段已迁出 system prompt，改以 kind='session_state_note' 的
// user 消息追加在消息尾——generate mock 收 messages 断言注记 content（mirror stale-fields-segment
// .test.ts 模式）：
// 1. 活跃批量 + 各档位 → 四档协议差异文本。
// 2. 无活跃批量 → 零注入（回归安全）。
// 3. escalate 穿透纪律 + 锚点收尾（各档共有）。
// ─────────────────────────────────────────────────────────────────────────────

async function writeRunningBatch(projectPath: string, gear: string, sessionId?: string) {
  // 直接写 batches.json（绕过 start_batch——本测聚焦 prompt 段注入，非工具行为）。
  const { saveBatchRuns } = await import('../src/tool/batch-state');
  saveBatchRuns(projectPath, [
    {
      batchId: 'b-prompt',
      createdAt: Date.now(),
      lineTag: 'main',
      orderedSceneIds: ['s1', 's2', 's3'],
      doneSceneIds: ['s1'],
      gear: gear as never,
      status: 'running',
      chapterMap: { s1: 'ch-0', s2: 'ch-1', s3: 'ch-1' },
      ...(sessionId ? { sessionId } : {}),
    },
  ]);
}

async function runTurn(projectPath: string, participationGear?: string) {
  const { createWorkflowRuntime } = await import('../src/runtime/workflow');
  const generate = vi.fn(async () => ({ content: 'ok', finishReason: 'stop' }));
  const runtime = createWorkflowRuntime({ generate });
  const session = runtime.createSession({
    agentName: 'writer',
    projectPath,
    ...(participationGear ? { participationGear: participationGear as never } : {}),
  });
  await runtime.sendMessage({
    sessionId: session.id,
    content: 'Continue batch.',
    abortSignal: new AbortController().signal,
  });
  expect(generate).toHaveBeenCalledOnce();
  // 每测新建会话 → 首轮必发全量注记（hash 门首轮 undefined）——mock 第 1 参 messages 取
  // kind='session_state_note' 消息的 content 作断言面（批量协议段迁居处）。
  const messages = generate.mock.calls[0][0] as readonly unknown[];
  const note = messages.find((m) => (m as { kind?: string } | null)?.kind === 'session_state_note') as
    | { content: string }
    | undefined;
  return { system: generate.mock.calls[0][1] as string, note: note?.content ?? '', sessionId: session.id };
}

describe('Story 3.5 — batch prompt segment（session_state_note 注记）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-segment-'));
  });

  afterEach(async () => {
    const { closeDb: closeDbDynamic } = await import('../src/agent/persistence');
    closeDbDynamic(projectPath);
    closeDb(projectPath); // 静态代实例的句柄也关（见文件头注释）——两代全关后才 rm/reset。
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('smart 档：通报走向单不阻塞 + 判轻重 + 信号卡指引 + 进度（1/3 + 下一场）', async () => {
    await writeRunningBatch(projectPath, 'smart');
    const { note } = await runTurn(projectPath, 'smart');
    expect(note).toContain('批量写作协议');
    expect(note).toContain('参与档位=smart');
    expect(note).toContain('通报走向单');
    expect(note).toContain('判轻重');
    expect(note).toContain('信号卡');
    expect(note).toContain('1/3 场已完成');
    expect(note).toContain('下一场=s2');
  });

  it('steer 档：每场写前都问 + 逐场预告', async () => {
    await writeRunningBatch(projectPath, 'steer');
    const { note } = await runTurn(projectPath, 'steer');
    expect(note).toContain('每场写前都问');
    expect(note).toContain('逐场预告');
    expect(note).not.toContain('参与档位=smart');
  });

  it('balanced 档：走向单等确认 + 圈类别命中才问（默认三项全）', async () => {
    await writeRunningBatch(projectPath, 'balanced');
    const { note } = await runTurn(projectPath, 'balanced');
    expect(note).toContain('走向单必须等作者确认');
    expect(note).toContain('主角生死安危');
    expect(note).toContain('信息差关键抉择');
    expect(note).toContain('方向转弯');
  });

  it('hands_off 档：零问 + trustAdjudication（默认 false=停下问）+ 验收清单', async () => {
    await writeRunningBatch(projectPath, 'hands_off');
    const { note } = await runTurn(projectPath, 'hands_off');
    expect(note).toContain('全程不问');
    expect(note).toContain('trustAdjudication=false');
    expect(note).toContain('diff 验收清单');
  });

  it('各档共有：escalate 穿透纪律（BLOCK 不豁免）+ 锚点收尾（end_batch + present_result + L0 + diagnose_impacts）', async () => {
    await writeRunningBatch(projectPath, 'smart');
    const { note } = await runTurn(projectPath, 'smart');
    expect(note).toContain('硬性打断穿透');
    expect(note).toContain('不豁免 BLOCK');
    expect(note).toContain('end_batch');
    expect(note).toContain('present_result');
    expect(note).toContain('L0 全景');
    expect(note).toContain('diagnose_impacts');
  });

  it('Story 8.4：出发核查挂起纪律（跳过该章继续他章 + 呈作者决断；与 escalate 停整批两纪律并存）', async () => {
    await writeRunningBatch(projectPath, 'smart');
    const { note } = await runTurn(projectPath, 'smart');
    expect(note).toContain('出发核查挂起');
    expect(note).toContain('继续批量推进其他章');
    expect(note).toContain('呈给作者决断');
    // 两纪律并存（escalate 停整批 vs 挂起跳该章）——防挂起被误当 escalate 全停。
    expect(note).toContain('硬性打断穿透');
  });

  it('Story 8.4：挂起场不进「下一场」推进（intro 行跳过挂起场 + 挂起计数呈报）', async () => {
    const { saveBatchRuns } = await import('../src/tool/batch-state');
    saveBatchRuns(projectPath, [
      {
        batchId: 'b-suspended',
        createdAt: Date.now(),
        lineTag: 'main',
        orderedSceneIds: ['s1', 's2', 's3'],
        doneSceneIds: ['s1'],
        suspendedSceneIds: ['s2'], // s2 挂起 → 下一场应为 s3（非 s2）。
        gear: 'smart' as never,
        status: 'running',
        chapterMap: { s1: 'ch-0', s2: 'ch-1', s3: 'ch-1' },
      },
    ]);
    const { note } = await runTurn(projectPath, 'smart');
    expect(note).toContain('下一场=s3');
    expect(note).not.toContain('下一场=s2');
    expect(note).toContain('另有 1 场挂起');
  });

  it('无活跃批量 → 零注入（回归安全）', async () => {
    const { note } = await runTurn(projectPath, 'smart');
    expect(note).not.toContain('批量写作协议');
    expect(note).not.toContain('参与档位');
  });

  it('live 档位优先于批量启动档位（随时调档下一轮生效，design §2.1）', async () => {
    await writeRunningBatch(projectPath, 'smart'); // 启动快照 smart。
    const { note } = await runTurn(projectPath, 'steer'); // 会话 live = steer。
    expect(note).toContain('参与档位=steer');
    expect(note).not.toContain('参与档位=smart');
  });

  it('批量 sessionId 不匹配本会话且属主会话健在 → 不注入（他 会话 的批量）；属主已删（孤儿）→ 注入可接管', async () => {
    const foreign = createSession({ agentName: 'writer', projectPath });
    await writeRunningBatch(projectPath, 'smart', foreign.id);
    const { note } = await runTurn(projectPath, 'smart');
    expect(note).not.toContain('批量写作协议');
    // CR-007 对偶：孤儿批量（属主会话已删）对本会话可见 → 协议注入（可 batch_status 对账接管）。
    deleteSession(foreign.id);
    const { note: afterOrphan } = await runTurn(projectPath, 'smart');
    expect(afterOrphan).toContain('批量写作协议');
  });
});

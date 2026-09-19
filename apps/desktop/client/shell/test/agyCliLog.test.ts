import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCliError, createAntigravityCliDriver } from '@orison/model-protocols';

import {
  agyCliLogDirFor,
  agyCliLogLinkPathFor,
  classifyAgyCliLog,
  inspectAgyCliLog,
  isEmptyTurnFailure,
  observeAgyCliAgentState,
} from '../main/ipc/agyCliLog';
import { cliTestModel, cliTestRequest, fakeDriverEnv } from './agyDriverHarness';
import { rmBestEffort } from './rmBestEffort';

// ── R9：agy CLI 日志观测（定位 + agent 三态 + 落一行）──
//
// 样张逐字取自装机实证（research/agy-log-observability-channel.md §5.1）。三条降级路径
// （日志不存在 / 读不了 / 格式漂移）必须**不抛错**且返回 'unknown'——日志只作观测，绝不
// 影响功能路径。

// 样张：agent 加载成功（agentB 探针）。
const LOG_AGENT_LOADED = [
  'I0919 19:13:05.112423       1 printmode.go:174] Print mode: starting (promptLength=0, model="", conversationID="")',
  'I0919 19:13:05.112423       1 conversation_manager.go:451] Starting new conversation (agent=true)',
  'I0919 19:13:05.112423       1 server.go:1142] Creating new cascade trajectory (agentScript=true)',
].join('\n');

// 样张：未请求 / 静默未加载（桥仿真无 agent）。
const LOG_NOT_LOADED = [
  'I0919 19:11:53.996876       1 printmode.go:174] Print mode: starting (promptLength=0, model="", conversationID="")',
  'I0919 19:11:59.692366       1 conversation_manager.go:451] Starting new conversation (agent=false)',
  'I0919 19:11:59.692366       1 server.go:1142] Creating new cascade trajectory (agentScript=false)',
].join('\n');

// 样张：显式 fallback（agentA 探针——文件缺失）。
const LOG_AGENT_FALLBACK = [
  'W0919 19:12:23.381074       1 session.go:82] Agent "closure-text" not found, falling back to default',
  'I0919 19:12:29.592656       1 conversation_manager.go:451] Starting new conversation (agent=false)',
  'I0919 19:12:29.592656       1 server.go:1142] Creating new cascade trajectory (agentScript=false)',
].join('\n');

// 样张：噪音（GeminiDir 解析 fallback——加载成功的运行里同样出现，永不作判据）。
const LOG_NOISE_ONLY = [
  'I0919 19:12:01.000000       1 launchsteps.go:84] Failed to resolve GeminiDir ".gemini" ... falling back to default',
  'I0919 19:12:01.000000       1 cli_setting_manager.go:92] CLI settings initialized: permissions=<nil>, toolPermission=request-review',
].join('\n');

describe('classifyAgyCliLog（三态归类，纯函数）', () => {
  it('agent=true + agentScript=true → agent-loaded', () => {
    expect(classifyAgyCliLog(LOG_AGENT_LOADED).state).toBe('agent-loaded');
  });

  it('agent=false + agentScript=false → agent-not-loaded', () => {
    expect(classifyAgyCliLog(LOG_NOT_LOADED).state).toBe('agent-not-loaded');
  });

  it('fallback 记录行 → agent-fallback（优先于同文件里的 false 对）', () => {
    expect(classifyAgyCliLog(LOG_AGENT_FALLBACK).state).toBe('agent-fallback');
  });

  it('launchsteps 噪音 fallback 行不误报（加载成功的运行里同样出现）', () => {
    expect(classifyAgyCliLog(LOG_NOISE_ONLY).state).toBe('unknown');
  });

  it('格式漂移 / 空文本 / 只到一半 → unknown（不猜）', () => {
    expect(classifyAgyCliLog('').state).toBe('unknown');
    expect(classifyAgyCliLog('some unrelated log line\nanother').state).toBe('unknown');
    // 只命中一条判据行（进程刚起步 / 日志截断）→ 不判加载成功。
    expect(classifyAgyCliLog('conversation_manager.go:451] Starting new conversation (agent=true)').state)
      .toBe('unknown');
  });

  it('宽行号：行号漂移不破锚（09-12 :32 → 09-19 :188 形态）', () => {
    const drifted = [
      'I0919 19:10:18.218967     408 tool_confirmation_manager.go:32] Print mode: soft-denying tool confirmation "ListDir" at step 4',
      'I0919 19:10:18.218967     408 conversation_manager.go:999] Starting new conversation (agent=true)',
      'I0919 19:10:18.218967     408 server.go:7] Creating new cascade trajectory (agentScript=true)',
    ].join('\n');
    expect(classifyAgyCliLog(drifted).state).toBe('agent-loaded');
  });
});

describe('inspectAgyCliLog（定位 + 读取，绝不抛）', () => {
  let homeRoot: string;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-cli-log-'));
  });

  afterEach(() => {
    rmBestEffort(homeRoot);
  });

  function writeLogDir(sessionId: string): string {
    const logDir = agyCliLogDirFor(homeRoot, sessionId);
    mkdirSync(logDir, { recursive: true });
    return logDir;
  }

  it('路径派生复用假宿段规则（<homeRoot>/<净化 sessionId>/.gemini/antigravity-cli/{log,cli.log}）', () => {
    expect(agyCliLogDirFor(homeRoot, 'sess:1')).toBe(
      path.join(homeRoot, 'sess_1', '.gemini', 'antigravity-cli', 'log'),
    );
    expect(agyCliLogLinkPathFor(homeRoot, 'sess:1')).toBe(
      path.join(homeRoot, 'sess_1', '.gemini', 'antigravity-cli', 'cli.log'),
    );
  });

  it('正例：log/ 下 cli-<ts>.log 命中 agent-loaded（无 cli.log 指针时）', () => {
    const logDir = writeLogDir('sess-1');
    writeFileSync(path.join(logDir, 'cli-20260919_191305.log'), LOG_AGENT_LOADED, 'utf8');
    const inspection = inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' });
    expect(inspection.state).toBe('agent-loaded');
    expect(inspection.logFile).toBe(path.join(logDir, 'cli-20260919_191305.log'));
    expect(inspection.logDir).toBe(logDir);
  });

  it('cli.log 指针优先于 log/ 下最新份（agy 每进程启动改写指向本会话那份）', () => {
    const logDir = writeLogDir('sess-1');
    writeFileSync(path.join(logDir, 'cli-20260919_191141.log'), LOG_NOT_LOADED, 'utf8');
    writeFileSync(agyCliLogLinkPathFor(homeRoot, 'sess-1'), LOG_AGENT_LOADED, 'utf8');
    const inspection = inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' });
    expect(inspection.state).toBe('agent-loaded');
    expect(inspection.logFile).toBe(agyCliLogLinkPathFor(homeRoot, 'sess-1'));
  });

  it('cli.log 符号链接（真机形态）照读；断链 → 指针失效不抛（退化扫描）', () => {
    const logDir = writeLogDir('sess-1');
    const real = path.join(logDir, 'cli-20260919_191305.log');
    writeFileSync(real, LOG_AGENT_LOADED, 'utf8');
    const link = agyCliLogLinkPathFor(homeRoot, 'sess-1');
    try {
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(real, link, 'file');
    } catch {
      return; // 环境建不出符号链接（Windows 无开发者模式）→ 跳过，非本用例失败
    }
    expect(inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' }).state).toBe('agent-loaded');

    // 断链（目标被删）→ existsSync 假：观测面不得抛，按无候选静默降级。
    rmSync(real);
    const dangling = inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' });
    expect(dangling.state).toBe('unknown');
    expect(dangling.logFile).toBeUndefined();
  });

  it('无指针时取文件名最新一份（名 = 进程启动时刻，字典序即时间序）', () => {
    const logDir = writeLogDir('sess-1');
    writeFileSync(path.join(logDir, 'cli-20260919_191141.log'), LOG_AGENT_LOADED, 'utf8');
    writeFileSync(path.join(logDir, 'cli-20260919_200000.log'), LOG_NOISE_ONLY, 'utf8');
    // 非会话日志命名的文件不参与候选（历史杂项）。
    writeFileSync(path.join(logDir, 'other.log'), LOG_AGENT_LOADED, 'utf8');
    const inspection = inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' });
    expect(inspection.logFile).toBe(path.join(logDir, 'cli-20260919_200000.log'));
    expect(inspection.state).toBe('unknown');
  });

  it('降级①：日志文件不存在 → unknown + 目录路径仍可算（不抛）', () => {
    const inspection = inspectAgyCliLog({ homeRoot, sessionId: 'sess-none' });
    expect(inspection.state).toBe('unknown');
    expect(inspection.logFile).toBeUndefined();
    expect(inspection.logDir).toBe(agyCliLogDirFor(homeRoot, 'sess-none'));
  });

  it('降级②：路径读不了（cli.log 是目录 / 祖先路径是文件）→ unknown（不抛）', () => {
    mkdirSync(agyCliLogLinkPathFor(homeRoot, 'sess-1'), { recursive: true });
    const asDir = inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' });
    expect(asDir.state).toBe('unknown');
    expect(asDir.detail).toBeDefined();

    // 祖先路径是文件（假宿根本身是个文件）→ readdir 抛 ENOTDIR，同样静默。
    const fileHome = path.join(homeRoot, 'as-file');
    writeFileSync(fileHome, 'not a dir', 'utf8');
    expect(inspectAgyCliLog({ homeRoot: fileHome, sessionId: 'sess-1' }).state).toBe('unknown');
  });

  it('降级③：格式漂移（文案不匹配任何三态）→ unknown（不抛）', () => {
    const logDir = writeLogDir('sess-1');
    writeFileSync(path.join(logDir, 'cli-20260919_191141.log'), LOG_NOISE_ONLY, 'utf8');
    expect(inspectAgyCliLog({ homeRoot, sessionId: 'sess-1' }).state).toBe('unknown');
  });

  it('降级④：sessionId 非法（净化后为点段）→ unknown（路径派生拒绝不抛穿）', () => {
    const inspection = inspectAgyCliLog({ homeRoot, sessionId: '..' });
    expect(inspection.state).toBe('unknown');
    expect(inspection.logDir).toBeUndefined();
  });
});

describe('observeAgyCliAgentState（读一次 + 落一行）', () => {
  let homeRoot: string;
  const info = vi.fn();
  const warn = vi.fn();

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-cli-log-observe-'));
    info.mockReset();
    warn.mockReset();
  });

  afterEach(() => {
    rmBestEffort(homeRoot);
  });

  it('session-open → info 一行，载 agent 三态与日志路径', () => {
    const logDir = agyCliLogDirFor(homeRoot, 'sess-1');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'cli-20260919_191305.log'), LOG_AGENT_LOADED, 'utf8');
    const inspection = observeAgyCliAgentState({
      homeRoot,
      sessionId: 'sess-1',
      reason: 'session-open',
      sink: { info, warn },
    });
    expect(inspection.state).toBe('agent-loaded');
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    const [payload, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      component: 'agy-bridge',
      sessionId: 'sess-1',
      reason: 'session-open',
      agentState: 'agent-loaded',
      logDir,
    });
    expect(payload.logFile).toBe(path.join(logDir, 'cli-20260919_191305.log'));
    expect(message).toContain('agent state = agent-loaded');
  });

  it('first-turn-completed（取景③）→ info 一行——健康会话也读得到 agent 三态', () => {
    const logDir = agyCliLogDirFor(homeRoot, 'sess-1');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'cli-20260919_191305.log'), LOG_AGENT_LOADED, 'utf8');
    const inspection = observeAgyCliAgentState({
      homeRoot,
      sessionId: 'sess-1',
      reason: 'first-turn-completed',
      sink: { info, warn },
    });
    expect(inspection.state).toBe('agent-loaded');
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    const [payload, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({ reason: 'first-turn-completed', agentState: 'agent-loaded' });
    expect(message).toContain('agent state = agent-loaded');
  });

  it('empty-turn-failure → warn 一行；日志读不到也照落（unknown 态）', () => {
    observeAgyCliAgentState({
      homeRoot,
      sessionId: 'sess-missing',
      reason: 'empty-turn-failure',
      sink: { info, warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    const [payload] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      sessionId: 'sess-missing',
      reason: 'empty-turn-failure',
      agentState: 'unknown',
    });
    expect(payload.detail).toBeDefined();
  });

  it('sink 抛错不逃逸（观测面绝不反向影响功能路径）', () => {
    const throwing = {
      info: () => {
        throw new Error('transport down');
      },
      warn: () => {
        throw new Error('transport down');
      },
    };
    expect(() =>
      observeAgyCliAgentState({ homeRoot, sessionId: 'sess-1', reason: 'session-open', sink: throwing }),
    ).not.toThrow();
  });

  it('缺省 sink = 真应用日志（pino）——不抛，行含 agent 三态与日志路径', () => {
    const logDir = agyCliLogDirFor(homeRoot, 'sess-1');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'cli-20260919_191305.log'), LOG_AGENT_LOADED, 'utf8');
    expect(() =>
      observeAgyCliAgentState({ homeRoot, sessionId: 'sess-1', reason: 'first-turn-completed' }),
    ).not.toThrow();
    expect(() =>
      observeAgyCliAgentState({ homeRoot, sessionId: 'sess-1', reason: 'empty-turn-failure' }),
    ).not.toThrow();
  });
});

describe('isEmptyTurnFailure（空回合失败族判据，观测面专用）', () => {
  // 本族判据按**消息身份**（协议层文案片段）分族——shell → 协议层单向依赖，常量不可共享，
  // 故每个针都配一条**跨包交叉校验**：拿协议层真实生产者（classifyCliError / 真 driver）的
  // 产物过判据，而不是拿手抄样张自证。协议层改文案而 shell 未同步 = 此处红。

  it('内置工具无头自动拒（真 classifyCliError 产物 412）→ true（文案交叉校验）', () => {
    const err = classifyCliError(
      '',
      'jetski: no output produced because the "read_file" permission that headless mode cannot prompt for was denied',
    );
    expect((err as { status?: number }).status).toBe(412);
    expect(isEmptyTurnFailure(err)).toBe(true);
  });

  it('MCP 预授权 412 不归入本族（同状态码、另文案——归因按消息身份不按裸状态码）', () => {
    const err = classifyCliError(
      '',
      'jetski: permission check failed for mcp "novel-writing/read_file" — headless mode cannot prompt for permission',
    );
    // 两条 412 各说各话：MCP 行的 remedy 是「去设置页补授权」，不是「内置工具被拒」。
    expect((err as { status?: number }).status).toBe(412);
    expect(isEmptyTurnFailure(err)).toBe(false);
  });

  it('空 SUCCESS 终态（真 driver 产出 EMPTY 错误）→ true（文案交叉校验）', async () => {
    // 治前形态是「拿手抄的 EMPTY 原文喂 classifyCliError」——协议层改文案用例照绿
    //（零守门）。这里跑真 driver（fake spawn，零真进程），断言的 err 是 finishCliTurn →
    // classifyCliError 真实产物：events.ts 文案漂移 = 本例红。
    const env = fakeDriverEnv((proc) => {
      proc.responder = () => proc.emitEvent({ type: 'result', status: 'SUCCESS', response: '' });
    });
    const driver = createAntigravityCliDriver(env.deps);
    try {
      const err = await driver.generateText(cliTestModel(), cliTestRequest()).then(
        () => { throw new Error('expected the EMPTY turn to reject'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(502);
      expect(isEmptyTurnFailure(err)).toBe(true);
      // 空 SUCCESS 的整 turn 一次重试（driver 内建）后仍空 → 两代进程各一次 spawn。
      expect(env.spawns.length).toBe(2);
    } finally {
      driver.dispose();
    }
  });

  it('非空回合族（abort / timeout / quota / 一般错误 / 非 Error）→ false', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isEmptyTurnFailure(abort)).toBe(false);
    expect(isEmptyTurnFailure(new Error('agy bridge turn exceeded 1800000ms (bridge print-timeout + grace outer belt)'))).toBe(false);
    expect(isEmptyTurnFailure(classifyCliError('quota exceeded for this model', ''))).toBe(false);
    expect(isEmptyTurnFailure(new Error('quota exceeded'))).toBe(false);
    expect(isEmptyTurnFailure(undefined)).toBe(false);
    expect(isEmptyTurnFailure('boom')).toBe(false);
  });
});

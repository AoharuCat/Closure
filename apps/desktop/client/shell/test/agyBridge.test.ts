import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __getAgyBridgeCoreForTest,
  uninstallAgyBridgeCoreForTest,
  BRIDGE_MCP_SERVER_NAME,
  AGY_GLOBAL_AGENTS_ROOT_SEGMENTS,
  CLOSURE_BRIDGE_AGENT,
  CLOSURE_BRIDGE_AGENT_LAYOUT,
  renderAgentMarkdown,
} from '@orison/model-protocols';

const { handleToolExecuteMock } = vi.hoisted(() => ({
  handleToolExecuteMock: vi.fn(),
}));

// 三道闸执行路径走统一工具通道——本文件钉的是闸门次序与回程形态，通道自身行为在
// toolHandlers 各自测试内（mock 面收敛为 handleToolExecute 一点）。
vi.mock('../main/ipc/toolExecution', () => ({
  handleToolExecute: handleToolExecuteMock,
}));

import {
  AgyBridgeHomeError,
  assertFakeHomePath,
  abortBridgeSession,
  BRIDGE_HOME_MAX_AGE_MS,
  bridgePipeName,
  createAgyBridgeRegistry,
  defaultAgyBridgeHomeRoot,
  executeBridgeToolCall,
  installShellAgyBridgeCore,
  isVerifiedAgyVersionBand,
  prepareBridgeHome,
  probeAgyCliVersion,
  setProductionAgyBridgeRuntime,
  sweepStaleBridgeHomes,
  VERIFIED_AGY_MAJOR_MINOR,
  type BridgeSessionRecord,
} from '../main/ipc/agyBridge';
import { registry, type SkillExecutorRef, type ToolContext } from '@orison/desktop-agent';
import type { BridgeToolFaceEntry } from '@orison/model-protocols';

// ── 子4 W2：桥基座（假宿四件套 + 清扫守卫矩阵 + 三道闸 + 管道协议 + wiring）──
// 红线：真实 ~/.gemini 零触碰——全部 fs 面在 temp 根（realHome 为 fixture 根，非真 home）。

const TMP_ROOTS: string[] = [];

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  TMP_ROOTS.push(dir);
  return dir;
}

afterEach(() => {
  uninstallAgyBridgeCoreForTest();
  handleToolExecuteMock.mockReset();
  for (const dir of TMP_ROOTS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const FACE: BridgeToolFaceEntry[] = [
  { name: 'present_result', description: '呈现结果并声明本轮结束。', inputSchema: { type: 'object' } },
  { name: 'write_chapter', description: '为指定章节触发完整写作流程。', inputSchema: { type: 'object' } },
  { name: 'outline_update', description: '修订大纲。', inputSchema: { type: 'object' } },
];

// ── 09-19 白名单 W2：桥声明式 agent 文件断言素材（内容/路径均取协议层单源——布局常量
// 可能被装机探针定谳翻转为扁平形态，测试从常量拼预期路径，不钉字面量）。 ──

const BRIDGE_AGENT_MD = renderAgentMarkdown(CLOSURE_BRIDGE_AGENT);

/** 假宿内桥 agent 文件预期路径（与 prepareBridgeHome 同一套常量拼接）。 */
function bridgeAgentFilePath(homeDir: string): string {
  return path.join(
    homeDir,
    ...AGY_GLOBAL_AGENTS_ROOT_SEGMENTS,
    ...CLOSURE_BRIDGE_AGENT_LAYOUT.dirSegments,
    'agent.md',
  );
}

// ── 假宿四件套 + marker + 真实 ~/.gemini 零触碰 ──

/** 递归快照（相对路径 + size + mtimeMs + isDir）——零触碰对拍用。 */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const relNext = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(full);
      out.set(relNext, st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(full, relNext);
    }
  };
  walk(root, '');
  return out;
}

function buildRealHomeFixture(home: string): void {
  mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    JSON.stringify({ theme: 'dark', permissions: { allow: ['read_file(*)'], deny: ['run_command(rm *)'] } }),
    'utf8',
  );
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), '{"mcpServers":{"user-own":{}}}', 'utf8');
  mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'brain', 'conv-1.json'), '{"k":1}', 'utf8');
}

describe('agyBridge：prepareBridgeHome（四件套 + 桥 agent 文件 + marker + 真实目录零触碰）', () => {
  it('四件套 + 桥 agent 文件内容断言 + 真实 home 快照零变化（红线对拍）', async () => {
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    const homeRoot = tempDir('agy-bridge-root-');
    const homeDir = path.join(homeRoot, 'session-1');
    const before = snapshot(realHome);

    await prepareBridgeHome({
      homeDir,
      homeRoot,
      realHome,
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: '\\\\.\\pipe\\test-pipe',
      token: 'tok-1',
      tools: FACE,
      agentMarkdown: BRIDGE_AGENT_MD,
      mcpServerPath: '/assets/mcpServer.mjs',
      execPath: '/electron/exe',
      pid: 4242,
      sessionId: 'session-1',
    });

    // ① .gemini 整拷（含凭据子树与用户 settings）。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', 'conv-1.json'))).toBe(true);
    // ② mcp_config 全新写（用户 global mcpServers 被隔离——不合并）。
    const mcpConfig = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(mcpConfig.mcpServers)).toEqual([BRIDGE_MCP_SERVER_NAME]);
    const entry = mcpConfig.mcpServers[BRIDGE_MCP_SERVER_NAME]!;
    expect(entry.command).toBe('/electron/exe');
    expect(entry.args).toEqual(['/assets/mcpServer.mjs']);
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      ORISON_BRIDGE_PIPE: '\\\\.\\pipe\\test-pipe',
      ORISON_BRIDGE_TOKEN: 'tok-1',
      ORISON_BRIDGE_TOOLS_JSON: path.join(homeDir, 'bridge', 'tools.json'),
    });
    // ③ settings verbatim 副本 + 预授权追加（用户 deny 随副本保全）。
    const settingsCopy = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as {
      theme: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settingsCopy.theme).toBe('dark');
    expect(settingsCopy.permissions.allow).toEqual(['read_file(*)', `mcp(${BRIDGE_MCP_SERVER_NAME}/*)`]);
    expect(settingsCopy.permissions.deny).toEqual(['run_command(rm *)']);
    // ④ tools.json。
    expect(JSON.parse(readFileSync(path.join(homeDir, 'bridge', 'tools.json'), 'utf8'))).toEqual(FACE);
    // ⑤ 桥声明式 agent 文件（09-19 白名单 W2）：内容 = 生成器输出逐字节一致（零内置
    //    工具 + system prompt 通道的落盘面；--agent 激活值对应 agents.ts 布局常量）。
    expect(readFileSync(bridgeAgentFilePath(homeDir), 'utf8')).toBe(BRIDGE_AGENT_MD);
    // ⑥ marker。
    const marker = JSON.parse(readFileSync(path.join(homeDir, 'marker.json'), 'utf8')) as { pid: number; sessionId: string };
    expect(marker).toMatchObject({ pid: 4242, sessionId: 'session-1' });

    // 🔴 红线：真实 home 快照逐项不变（零写入）。
    expect(snapshot(realHome)).toEqual(before);
  });

  it('U8：整拷排除 agy CLI 日志（log/ 目录 + cli.log 指针）——假宿无日志、其余结构在位、真实 home 零触碰', async () => {
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    // 日志形态（U8 取证）：antigravity-cli/log/ 历史日志（无轮转，65 份 1.56MB 线性增长）
    // + antigravity-cli/cli.log 指针（生产是 symlink → log/cli-<ts>.log，dereference 会把
    // 指针拷成实体文件）。这里以普通文件布景——filter 只按路径判，不涉节点类型；
    // symlink 场景的 dereference 语义已在注释面覆盖。
    const logDir = path.join(realHome, '.gemini', 'antigravity-cli', 'log');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'cli-20260919_184948.log'), 'history log line', 'utf8');
    writeFileSync(path.join(realHome, '.gemini', 'antigravity-cli', 'cli.log'), 'latest log line', 'utf8');
    const homeRoot = tempDir('agy-bridge-root-');
    const homeDir = path.join(homeRoot, 'u8');

    await prepareBridgeHome({
      homeDir,
      homeRoot,
      realHome,
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'u8',
    });

    // 日志零带入（目录整个缺席 + 指针文件不拷）。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'log'))).toBe(false);
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'cli.log'))).toBe(false);
    // 其余结构原样：settings 副本 / 凭据子树 / config 新写。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', 'conv-1.json'))).toBe(true);
    expect(existsSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'))).toBe(true);
    // 真实 home 日志零触碰。
    expect(existsSync(path.join(logDir, 'cli-20260919_184948.log'))).toBe(true);
    expect(readFileSync(path.join(realHome, '.gemini', 'antigravity-cli', 'cli.log'), 'utf8')).toBe('latest log line');
  });

  it('U8 CR-2/3/4：轮转变体 + win32 大小写变体 + 界外 symlink 指入 log/ 均不带入；symlink 指向其余结构照拷', async () => {
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    const cliRoot = path.join(realHome, '.gemini', 'antigravity-cli');
    // 真日志目录（排除面正主）：CR-4 的界外 symlink 指向它（指入排除面才该拒）。
    const logDirReal = path.join(cliRoot, 'log');
    mkdirSync(logDirReal, { recursive: true });
    writeFileSync(path.join(logDirReal, 'session.log'), 'real log line', 'utf8');
    // CR-3：直宿轮转变体（cli.log.1 / cli-<ts>.log）——旧精确比对（src !== logLinkSrc）会漏。
    writeFileSync(path.join(cliRoot, 'cli.log.1'), 'rotated log line', 'utf8');
    writeFileSync(path.join(cliRoot, 'cli-20260919_184948.log'), 'rotated ts log line', 'utf8');
    // CR-2：日志目录以大小写变体落盘——win32/darwin（默认 APFS）盘面不区分大小写，
    // `Log` 与真 `log` 同目录、落排除面；仅 linux（大小写敏感盘面）`Log` 是独立合法目录。
    const logDirVariant = path.join(cliRoot, 'Log');
    mkdirSync(logDirVariant, { recursive: true });
    writeFileSync(path.join(logDirVariant, 'cli-variant-case.log'), 'case variant log line', 'utf8');
    // CR-4：界外 symlink 指入真 log/（对 dereference 拷贝是内容拷入——前缀测试对 symlink
    // 失效）；对照组 symlink 指向其余结构（brain）——照常 dereference 拷入。
    const linkToLog = path.join(realHome, '.gemini', 'config', 'loglink');
    const linkToBrain = path.join(realHome, '.gemini', 'config', 'brainlink');
    try {
      symlinkSync(logDirReal, linkToLog, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkSync(path.join(cliRoot, 'brain'), linkToBrain, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 无特权环境无法布景（mirror 既有 junction 先例）
    }
    const homeRoot = tempDir('agy-bridge-root-');
    const homeDir = path.join(homeRoot, 'u8-variants');

    await prepareBridgeHome({
      homeDir,
      homeRoot,
      realHome,
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'u8-variants',
    });

    // 真日志目录零带入（全平台——排除面正主）。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'log'))).toBe(false);
    // CR-3：轮转变体零带入。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'cli.log.1'))).toBe(false);
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'cli-20260919_184948.log'))).toBe(false);
    // CR-2：大小写变体目录——win32/darwin 盘面不区分大小写（与真 log 同目录被排除）；
    // 仅 linux 大小写敏感盘面上 `Log` 是独立合法目录，语义如实拷入。
    expect(existsSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'Log'))).toBe(process.platform === 'linux');
    // CR-4：指入真 log/ 的界外 symlink 不拷（lstat 分流 + realpath 目标判拒）；指向 brain
    // 的 symlink 照常 dereference 拷入（非日志目标不误伤）。
    expect(existsSync(path.join(homeDir, '.gemini', 'config', 'loglink'))).toBe(false);
    expect(existsSync(path.join(homeDir, '.gemini', 'config', 'brainlink', 'conv-1.json'))).toBe(true);
    // 真实 home 零触碰。
    expect(readFileSync(path.join(logDirReal, 'session.log'), 'utf8')).toBe('real log line');
    expect(readFileSync(path.join(logDirVariant, 'cli-variant-case.log'), 'utf8')).toBe('case variant log line');
    expect(readFileSync(path.join(cliRoot, 'cli.log.1'), 'utf8')).toBe('rotated log line');
  });

  it('用户 settings 损坏 → 类型化阻断（不产出副本）；settings 缺失 → 副本基 {}', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const corruptHome = tempDir('agy-bridge-corrupt-');
    buildRealHomeFixture(corruptHome);
    writeFileSync(path.join(corruptHome, '.gemini', 'antigravity-cli', 'settings.json'), '{broken', 'utf8');
    const corruptHomeDir = path.join(homeRoot, 'c1');
    await expect(prepareBridgeHome({
      homeDir: corruptHomeDir,
      homeRoot,
      realHome: corruptHome,
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'c1',
    })).rejects.toThrow(AgyBridgeHomeError);
    // CR-3：corrupt 预检先于一切拷贝——零字节已写假宿（半成品凭据副本不留盘）。
    expect(existsSync(corruptHomeDir)).toBe(false);

    const noSettingsHome = tempDir('agy-bridge-nosettings-');
    mkdirSync(path.join(noSettingsHome, '.gemini'), { recursive: true });
    const homeDir = path.join(homeRoot, 'c2');
    await prepareBridgeHome({
      homeDir, homeRoot, realHome: noSettingsHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'c2',
    });
    const settingsCopy = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as { permissions: { allow: string[] } };
    expect(settingsCopy.permissions.allow).toEqual([`mcp(${BRIDGE_MCP_SERVER_NAME}/*)`]);
  });

  it('CR-3：拷贝/写入中途失败 → catch 内清理已拷内容（半成品假宿不留盘）', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    // 注入失败：homeDir/.gemini 预置为普通文件 → 目录拷贝到文件路径必炸。
    const homeDir = path.join(homeRoot, 'c3');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(path.join(homeDir, '.gemini'), 'not-a-dir', 'utf8');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'c3',
    })).rejects.toThrow();
    // 失败路径清理——整个半成品假宿（含预置残骸）删除，凭据副本零滞留。
    expect(existsSync(homeDir)).toBe(false);
  });

  it('CR-10：marker 归属其他 sessionId → typed 阻断（sanitize 撞段），他人假宿不误删', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    const homeDir = path.join(homeRoot, 'taken');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(path.join(homeDir, 'marker.json'), JSON.stringify({ pid: 1234, sessionId: 'someone-else' }), 'utf8');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'mine',
    })).rejects.toThrow(AgyBridgeHomeError);
    expect(existsSync(path.join(homeDir, 'marker.json'))).toBe(true); // 他人假宿原样保留
    // 同 sessionId marker（清理失败的残留）→ force 覆盖照常准备。
    await prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'someone-else',
    });
    expect(existsSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'))).toBe(true);
  });

  it('CR-2：假宿拷贝树内同名 agent（bridge/text 任一名）→ 遮蔽闸 typed 阻断 + 半成品假宿不留盘', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    // 用户真实全局 agents 里的同名文件（bridge 名）——随整拷进入假宿。
    const shadowDir = path.join(realHome, '.gemini', 'config', 'agents', 'user-copy');
    mkdirSync(shadowDir, { recursive: true });
    const shadowFile = path.join(shadowDir, 'agent.md');
    writeFileSync(shadowFile, '---\nname: closure-bridge\n---\n用户自建同名 agent\n', 'utf8');
    const homeDir = path.join(homeRoot, 'shadowed');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'shadowed',
    })).rejects.toThrow(AgyBridgeHomeError);
    // typed 报错点名遮蔽路径（用户可定位处理）；失败路径清理——凭据副本零滞留。
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'shadowed',
    })).rejects.toThrow(/user-copy/);
    expect(existsSync(homeDir)).toBe(false);

    // text 名同样在闸内（双名检测）：改名为 closure-text → 照阻断。
    writeFileSync(shadowFile, '---\nname: closure-text\n---\n用户自建同名 agent\n', 'utf8');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'shadowed',
    })).rejects.toThrow(AgyBridgeHomeError);

    // 异名外来 agent（无害）→ 照常准备成功。
    writeFileSync(shadowFile, '---\nname: my-own-agent\n---\n正文\n', 'utf8');
    await prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'shadowed',
    });
    expect(readFileSync(bridgeAgentFilePath(homeDir), 'utf8')).toBe(BRIDGE_AGENT_MD);
  });

  it('CR-2 symlink 目录：假宿 agents 根内符号链接指入同名 agent → 照阻断（statSync 跟进）', async () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    buildRealHomeFixture(realHome);
    // 真目录在 agents 根外，agents 根内以符号链接指入——dirent.isDirectory()=false 形态。
    const outside = path.join(realHome, '.gemini', 'config', 'outside-agents');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'agent.md'), '---\nname: closure-bridge\n---\n正文\n', 'utf8');
    const link = path.join(realHome, '.gemini', 'config', 'agents', 'linked');
    mkdirSync(path.dirname(link), { recursive: true });
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 无特权环境无法布景（mirror 既有 junction 先例）——机制面为纯 statSync 跟进
    }
    const homeDir = path.join(homeRoot, 'shadowed-link');
    await expect(prepareBridgeHome({
      homeDir, homeRoot, realHome,
      serverName: BRIDGE_MCP_SERVER_NAME, pipeName: 'p', token: 't', tools: [], agentMarkdown: BRIDGE_AGENT_MD, mcpServerPath: 'm', execPath: 'e', pid: 1, sessionId: 'shadowed-link',
    })).rejects.toThrow(AgyBridgeHomeError);
  });

  it('路径守卫第一道：假宿必须严格位于 homeRoot 之内 → 越出即阻断', () => {
    const homeRoot = tempDir('agy-bridge-root-');
    const realHome = tempDir('agy-bridge-realhome-');
    expect(() => assertFakeHomePath(tempDir('agy-elsewhere-'), homeRoot, realHome)).toThrow(AgyBridgeHomeError);
    expect(() => assertFakeHomePath(homeRoot, homeRoot, realHome)).toThrow(AgyBridgeHomeError);
    expect(defaultAgyBridgeHomeRoot('/home/u')).toBe(path.join('/home/u', '.orison', 'agy-bridge', 'home'));
  });

  it('路径守卫放行面：假宿位于真实用户目录的数据子树内是合法落点（生产嵌套拓扑）', () => {
    const realHome = tempDir('agy-real-');
    const homeRoot = path.join(realHome, '.orison', 'agy-bridge', 'home');
    const home = path.join(homeRoot, '647fefd2-session');
    expect(() => assertFakeHomePath(home, homeRoot, realHome)).not.toThrow();
    // homeRoot 与 realHome 分离、互不嵌套：照常放行。
    const separateRoot = tempDir('agy-bridge-root-');
    expect(() => assertFakeHomePath(path.join(separateRoot, 'x'), separateRoot, realHome)).not.toThrow();
    // homeRoot 恰与 realHome 重合：home 仍属「位于真实目录内」的合法族。
    expect(() => assertFakeHomePath(path.join(homeRoot, 'x'), homeRoot, homeRoot)).not.toThrow();
  });

  it('路径守卫禁令面：假宿不得等于/包含真实目录，不得触及真实 .gemini 凭据树', () => {
    const base = tempDir('agy-guard-');
    // 禁令①：home === real（入参须先过第一道 homeRoot 检查，故 real 取在 homeRoot 之内）。
    const root1 = path.join(base, 'root1');
    expect(() => assertFakeHomePath(path.join(root1, 's1'), root1, path.join(root1, 's1'))).toThrow(
      /真实用户目录/,
    );
    // 禁令②：home 包含 real（真实目录整个落进假宿树——灾难形态）。
    const root2 = path.join(base, 'root2');
    expect(() => assertFakeHomePath(path.join(root2, 's1'), root2, path.join(root2, 's1', 'realuser'))).toThrow(
      /真实用户目录/,
    );
    // 禁令③：home === realGemini（假宿指到真实凭据目录上）。
    const root3 = path.join(base, 'root3');
    const real3 = path.join(root3, 'realuser');
    expect(() => assertFakeHomePath(path.join(real3, '.gemini'), root3, real3)).toThrow(/agy 凭据目录/);
    // 禁令④：home 位于 realGemini 之内（假宿落进真实凭据树）。
    const real4 = path.join(base, 'real4');
    const root4 = path.join(real4, '.gemini', 'bridge-home');
    expect(() => assertFakeHomePath(path.join(root4, 's1'), root4, real4)).toThrow(/凭据目录之内/);
  });
});

describe('agyBridge：启动清扫守卫（marker pid 判活矩阵）', () => {
  it('死 pid 删 / 活且非本进程跳 / 无 marker 删 / 本进程 pid 删 / 杂散文件删', async () => {
    const root = tempDir('agy-bridge-sweep-');
    const mk = (name: string, marker?: unknown): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      if (marker !== undefined) writeFileSync(path.join(dir, 'marker.json'), JSON.stringify(marker), 'utf8');
      return dir;
    };
    const dead = mk('dead', { pid: 11111, sessionId: 'a' });
    const foreign = mk('foreign', { pid: 22222, sessionId: 'b' });
    const noMarker = mk('nomarker');
    const own = mk('own', { pid: 999, sessionId: 'c' });
    const corrupt = mk('corrupt', 'not-json');
    const strayFile = path.join(root, 'stray.txt');
    writeFileSync(strayFile, 'x', 'utf8');

    const result = await sweepStaleBridgeHomes({
      homeRoot: root,
      ownPid: 999,
      isPidAlive: (pid) => pid === 22222, // 仅 22222 视为存活（另一实例）
    });
    expect(result.removed.sort()).toEqual([corrupt, dead, noMarker, own, strayFile].sort());
    expect(result.skipped).toEqual([{ dir: foreign, reason: 'live-foreign-pid' }]);
    expect(existsSync(foreign)).toBe(true);
  });

  it('CR-4 age 兜底：live-foreign-pid 但 marker/目录 mtime 超 7 天 → 照删（pid 回收形态）', async () => {
    const root = tempDir('agy-bridge-sweep-age-');
    const mkOld = (name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ pid: 22222, sessionId: name }), 'utf8');
      return dir;
    };
    const staleForeign = mkOld('stale-foreign'); // 判活永真（死 pid 被无关进程回收）
    const freshForeign = mkOld('fresh-foreign');
    const eightDaysAgo = new Date(Date.now() - BRIDGE_HOME_MAX_AGE_MS - 24 * 60 * 60 * 1000);
    utimesSync(path.join(staleForeign, 'marker.json'), eightDaysAgo, eightDaysAgo);
    utimesSync(staleForeign, eightDaysAgo, eightDaysAgo);

    const result = await sweepStaleBridgeHomes({
      homeRoot: root,
      ownPid: 999,
      isPidAlive: () => true, // 全部「存活」——纯靠 age 兜底分辨
    });
    expect(result.removed).toEqual([staleForeign]);
    expect(result.skipped).toEqual([{ dir: freshForeign, reason: 'live-foreign-pid' }]);
    expect(existsSync(staleForeign)).toBe(false);
    expect(existsSync(freshForeign)).toBe(true);
  });

  it('CR-4 运行期防护：ownPid 命中但会话注册表仍活跃 → 跳过（防删自家活动桥假宿）', async () => {
    const root = tempDir('agy-bridge-sweep-own-');
    const mk = (name: string, marker?: unknown): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      if (marker !== undefined) writeFileSync(path.join(dir, 'marker.json'), JSON.stringify(marker), 'utf8');
      return dir;
    };
    const activeOwn = mk('active-own', { pid: 999, sessionId: 'live-session' });
    const staleOwn = mk('stale-own', { pid: 999, sessionId: 'gone-session' });

    // 启动语义（无活跃集）：ownPid 残留照删。
    const startup = await sweepStaleBridgeHomes({ homeRoot: root, ownPid: 999, isPidAlive: () => true });
    expect(startup.removed.sort()).toEqual([activeOwn, staleOwn].sort());

    // 运行期误接线语义：活跃集内的会话假宿被守卫保住。
    const root2 = tempDir('agy-bridge-sweep-own2-');
    const mk2 = (name: string): string => {
      const dir = path.join(root2, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ pid: 999, sessionId: name }), 'utf8');
      return dir;
    };
    const active = mk2('live-session');
    const stale = mk2('gone-session');
    const guarded = await sweepStaleBridgeHomes({
      homeRoot: root2,
      ownPid: 999,
      isPidAlive: () => true,
      activeSessionIds: new Set(['live-session']),
    });
    expect(guarded.removed).toEqual([stale]);
    expect(guarded.skipped).toEqual([{ dir: active, reason: 'live-foreign-pid' }]);
    expect(existsSync(active)).toBe(true);
  });
});

describe('agyBridge：版本带 + 探测（零真进程）', () => {
  it('1.2.x 在带内；其他版本带外；探测 runner 注入', async () => {
    expect(VERIFIED_AGY_MAJOR_MINOR).toBe('1.2');
    expect(isVerifiedAgyVersionBand('1.2.2')).toBe(true);
    expect(isVerifiedAgyVersionBand('v1.2.9')).toBe(true);
    expect(isVerifiedAgyVersionBand('1.3.0')).toBe(false);
    expect(isVerifiedAgyVersionBand('agy version 1.2.2')).toBe(false); // 前缀文本不匹配（探测层先提取）
    expect(await probeAgyCliVersion('agy', async () => 'agy version 1.2.2\n')).toBe('1.2.2');
    expect(await probeAgyCliVersion('agy', async () => '1.3.0')).toBe('1.3.0');
    expect(await probeAgyCliVersion('missing', async () => { throw new Error('spawn ENOENT'); })).toBeUndefined();
  });
});

// ── 三道闸（§5.2 等价重建——同一 toolPolicy 模块）──

function makeRecord(overrides: Partial<BridgeSessionRecord> = {}): BridgeSessionRecord {
  return {
    sessionId: 'session-1',
    projectDir: os.tmpdir(),
    permissionMode: 'suggest',
    face: FACE,
    faceNames: new Set(FACE.map((t) => t.name)),
    pipeName: 'pipe',
    token: 'tok',
    abortController: new AbortController(),
    callRecords: [],
    presentResult: { called: false, awaiting: undefined },
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe('agyBridge：三道闸（面外拒 / 档位强制 / 自审闸）', () => {
  it('闸1 面外：不在会话注册面 → 错误结果 + 不执行', async () => {
    const record = makeRecord();
    const result = await executeBridgeToolCall(record, 'write_file', {});
    expect(result).toMatchObject({ ok: false, gate: 'face' });
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('闸1b 权限档：readonly 档 write 类工具 → assertToolAllowed 拒绝文案回错误结果', async () => {
    // memory_update 须在会话面内（闸1 面外先于闸1b 权限档）——面内但 readonly 档拒。
    const face = [...FACE, { name: 'memory_update', description: '更新记忆。', inputSchema: { type: 'object' } }];
    const record = makeRecord({ permissionMode: 'readonly', face, faceNames: new Set(face.map((t) => t.name)) });
    const result = await executeBridgeToolCall(record, 'memory_update', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not allowed in readonly mode');
    expect(result).toMatchObject({ gate: 'policy' });
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('闸2 档位强制：suggest 档 diff 工具带 autoApply:true → 改写 autoApply:false 后执行', async () => {
    const record = makeRecord({ permissionMode: 'suggest' });
    handleToolExecuteMock.mockResolvedValue({ title: '大纲', output: '已修订' });
    const result = await executeBridgeToolCall(record, 'outline_update', { patch: [], autoApply: true, selfReviewConfirmed: true });
    expect(result.ok).toBe(true);
    expect(handleToolExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'outline_update',
      params: expect.objectContaining({ autoApply: false }),
      projectDir: record.projectDir,
      sessionId: record.sessionId,
      abort: record.abortController.signal,
    }));
  });

  it('闸3 自审闸：auto 档首发 autoApply:true 未自审 → 不执行，闸门文案作工具结果返回', async () => {
    const record = makeRecord({ permissionMode: 'auto' });
    const result = await executeBridgeToolCall(record, 'outline_update', { patch: [], autoApply: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('自审');
      expect(result.output).toContain('selfReviewConfirmed: true');
      expect(result.gate).toBe('self-review');
      expect(result.metadata).toMatchObject({ bridgeGate: 'self-review' });
    }
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('自审重发（selfReviewConfirmed:true）→ 放行执行；执行异常 → ok:false 错误结果', async () => {
    const record = makeRecord({ permissionMode: 'auto' });
    handleToolExecuteMock.mockResolvedValueOnce({ title: '大纲', output: '已修订' });
    const okResult = await executeBridgeToolCall(record, 'outline_update', { patch: [], autoApply: true, selfReviewConfirmed: true });
    expect(okResult).toMatchObject({ ok: true, output: '已修订' });
    expect(handleToolExecuteMock).toHaveBeenCalledTimes(1);

    handleToolExecuteMock.mockRejectedValueOnce(new Error('章节不存在'));
    const errResult = await executeBridgeToolCall(record, 'write_chapter', { chapter: 1 });
    expect(errResult).toMatchObject({ ok: false, error: '章节不存在' });
    expect('gate' in errResult ? errResult.gate : undefined).toBeUndefined();
    // 调用记录随管道帧一起落（此处直调不经注册表——记录面在管道路径测试）。
  });
});

// ── 注册表 + 管道协议 ──

interface FrameWaiter {
  predicate: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
}

/** 测试侧管道客户端（mcpServer 的角色——hello 握手 + 行帧收发）。 */
class PipeClient {
  readonly socket: net.Socket;
  private buffer = '';
  private readonly waiters: FrameWaiter[] = [];
  readonly frames: Array<Record<string, unknown>> = [];

  constructor(pipeName: string) {
    this.socket = net.connect(pipeName);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.frames.push(frame);
        const idx = this.waiters.findIndex((w) => w.predicate(frame));
        if (idx >= 0) {
          const [waiter] = this.waiters.splice(idx, 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pipe frame wait timeout')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connectWithRetry(pipeName: string, timeoutMs = 5000): Promise<PipeClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const client = new PipeClient(pipeName);
      await new Promise<void>((resolve, reject) => {
        client.socket.once('connect', () => resolve());
        client.socket.once('error', (err) => reject(err));
      });
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe('agyBridge：注册表 + 管道协议（hello 握手 / 调用往返 / token 拒绝 / present_result 记录）', () => {
  it('全链往返：鉴权 → 工具调用 → 结果帧 + 调用记录；错 token 拒断；present_result 通知记录', async () => {
    handleToolExecuteMock.mockResolvedValue({ title: '写章', output: '第一章已完成' });
    const registry = createAgyBridgeRegistry();
    const { pipeName, token } = registry.openSession({
      sessionId: 'session-1',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    // CR-2 安全形态：管道名不含 token 任何片段——Windows 管道命名空间本机可枚举，
    // 枚举者只能拿到不可认证的端点（认证只经 hello 帧 token 比对）。
    expect(pipeName).not.toContain(token);
    expect(pipeName).toContain('orison-agy-bridge-');
    // 管道名派生自独立随机 id（bridgePipeName 入参 = 不透明 pipeId，非 token）。
    expect(pipeName).not.toBe(bridgePipeName(token));

    // 错 token：welcome ok:false + 断连。
    const bad = await connectWithRetry(pipeName);
    bad.send({ op: 'hello', token: 'wrong' });
    await bad.waitFor((f) => f.op === 'welcome');
    expect(bad.frames[0]).toMatchObject({ op: 'welcome', ok: false });
    bad.close();

    // 对 token：握手 + 调用往返。
    const client = await connectWithRetry(pipeName);
    client.send({ op: 'hello', token });
    await client.waitFor((f) => f.op === 'welcome' && f.ok === true);
    client.send({ op: 'call', id: 7, toolId: 'write_chapter', arguments: { chapter: 1 } });
    const resultFrame = await client.waitFor((f) => f.op === 'result' && f.id === 7);
    expect(resultFrame).toMatchObject({ op: 'result', id: 7, ok: true, output: '第一章已完成' });
    expect(handleToolExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'write_chapter',
      params: { chapter: 1 },
      projectDir: os.tmpdir(),
      sessionId: 'session-1',
    }));
    const record = registry.getSession('session-1')!;
    expect(record.callRecords).toHaveLength(1);
    expect(record.callRecords[0]).toMatchObject({ toolId: 'write_chapter', ok: true, output: '第一章已完成' });

    // 握手前业务帧 = 未鉴权断连。
    const naked = await connectWithRetry(pipeName);
    naked.send({ op: 'call', id: 1, toolId: 'write_chapter', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    naked.close();

    // present_result 通知 → 记录（无回执帧）。
    client.send({ op: 'present_result', awaiting: true, summary: '方案已出' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(record.presentResult).toMatchObject({ called: true, awaiting: true, summary: '方案已出' });

    // 执行异常路径。
    handleToolExecuteMock.mockRejectedValueOnce(new Error('工具炸了'));
    client.send({ op: 'call', id: 8, toolId: 'write_chapter', arguments: {} });
    const errFrame = await client.waitFor((f) => f.op === 'result' && f.id === 8);
    expect(errFrame).toMatchObject({ op: 'result', id: 8, ok: false, error: '工具炸了' });

    // 幂等开管道：同会话复用 pipe/token。
    expect(registry.openSession({
      sessionId: 'session-1', projectDir: os.tmpdir(), permissionMode: 'auto', face: FACE,
    })).toEqual({ pipeName, token });
    client.close();

    // revoke：会话出表 + 管道关闭（新连接失败 = token 吊销后的拒绝面；旧连接被强断）。
    expect(registry.revokeSession('session-1')).toBe(true);
    expect(registry.getSession('session-1')).toBeUndefined();
    await expect(connectWithRetry(pipeName, 800)).rejects.toThrow();
    registry.disposeAll();
  });
});

// ── CR-6/7/8：会话重建 / idle 回收 / 执行路径 reject 兜底 ──

describe('agyBridge：openSession 配置变更（CR-6）', () => {
  it('同 sessionId 变更权限档/面/项目目录 → revoke 旧会话重建（新管道新 token，旧管道关闭）', async () => {
    const registry = createAgyBridgeRegistry();
    const base = { sessionId: 'session-1', projectDir: 'C:/proj-a', permissionMode: 'suggest' as const, face: FACE };
    const first = registry.openSession(base);
    // 完全相同输入 → 幂等复用。
    expect(registry.openSession(base)).toEqual(first);

    // 权限档收紧（suggest → readonly）→ 重建：新 token/管道，注册表反映新档。
    const tightened = registry.openSession({ ...base, permissionMode: 'readonly' });
    expect(tightened.token).not.toBe(first.token);
    expect(tightened.pipeName).not.toBe(first.pipeName);
    expect(registry.getSession('session-1')?.permissionMode).toBe('readonly');
    expect(registry.getByToken(first.token)).toBeUndefined(); // 旧 token 吊销
    await expect(connectWithRetry(first.pipeName, 800)).rejects.toThrow(); // 旧管道已关

    // 面变更 / 项目目录变更同样触发重建。
    const biggerFace = [...FACE, { name: 'wiki_search', description: '检索维基。', inputSchema: { type: 'object' } }];
    const refaced = registry.openSession({ ...base, permissionMode: 'readonly', face: biggerFace });
    expect(refaced.token).not.toBe(tightened.token);
    const moved = registry.openSession({ ...base, permissionMode: 'readonly', face: biggerFace, projectDir: 'C:/proj-b' });
    expect(moved.token).not.toBe(refaced.token);
    registry.disposeAll();
  });
});

describe('agyBridge：桥会话 idle 回收（CR-7）', () => {
  it('超过 TTL 无帧活动 → 关管道 + 出表；帧活动刷新存活；无会话清扫器停摆', async () => {
    const timers: Array<{ fn: () => void; cleared: boolean; clear(): void }> = [];
    let nowValue = 1_000_000;
    const registry = createAgyBridgeRegistry({
      idleTtlMs: 1_000,
      sweepIntervalMs: 100,
      now: () => nowValue,
      setTimer: (fn, _ms) => {
        const timer = { fn, cleared: false, clear() { this.cleared = true; } };
        timers.push(timer);
        return timer;
      },
    });
    const opened = registry.openSession({
      sessionId: 'session-idle',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    expect(timers).toHaveLength(1); // openSession 武装清扫器

    // T+900 present_result 帧（活动）→ T+1000 清扫（自 T+900 起 100ms ≤ TTL）→ 存活。
    nowValue += 900;
    registry.recordPresentResult('session-idle', true, '活动中');
    nowValue += 100;
    timers[0]!.fn();
    expect(registry.getSession('session-idle')).toBeDefined();

    // 清扫后重武装（会话仍在）；T+2000（自 T+900 帧 activity 起 1100ms > TTL）→ 回收。
    expect(timers).toHaveLength(2);
    nowValue += 1_000;
    timers[1]!.fn();
    expect(registry.getSession('session-idle')).toBeUndefined();
    expect(registry.getByToken(opened.token)).toBeUndefined();
    await expect(connectWithRetry(opened.pipeName, 800)).rejects.toThrow(); // 管道已关

    // 无会话 → 清扫器停摆（不再重武装）。
    expect(timers).toHaveLength(2);
    registry.disposeAll();
  });

  it('hello/call 帧也刷新活动（管道交互即活跃）', async () => {
    handleToolExecuteMock.mockResolvedValue({ title: '写章', output: 'ok' });
    const timers: Array<{ fn: () => void; cleared: boolean; clear(): void }> = [];
    let nowValue = 1_000_000;
    const registry = createAgyBridgeRegistry({
      idleTtlMs: 1_000,
      sweepIntervalMs: 100,
      now: () => nowValue,
      setTimer: (fn, _ms) => {
        const timer = { fn, cleared: false, clear() { this.cleared = true; } };
        timers.push(timer);
        return timer;
      },
    });
    const { pipeName, token } = registry.openSession({
      sessionId: 'session-frames',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    const client = await connectWithRetry(pipeName);
    nowValue += 900;
    client.send({ op: 'hello', token });
    await client.waitFor((f) => f.op === 'welcome' && f.ok === true);
    nowValue += 900; // 自 hello 起 900ms < TTL
    client.send({ op: 'call', id: 1, toolId: 'write_chapter', arguments: {} });
    await client.waitFor((f) => f.op === 'result' && f.id === 1);
    nowValue += 900; // 自 call 起 900ms < TTL
    timers[0]!.fn();
    expect(registry.getSession('session-frames')).toBeDefined(); // 帧活动链保活
    client.close();
    registry.disposeAll();
  });
});

describe('agyBridge：执行路径 reject 兜底（CR-8）', () => {
  it('executeCall reject → 错误 result 帧（agy 不挂）+ 不成未处理拒绝', async () => {
    const registry = createAgyBridgeRegistry({
      executeCall: async () => { throw new Error('dispatch boom'); },
    });
    const { pipeName, token } = registry.openSession({
      sessionId: 'session-cr',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    const client = await connectWithRetry(pipeName);
    client.send({ op: 'hello', token });
    await client.waitFor((f) => f.op === 'welcome' && f.ok === true);
    client.send({ op: 'call', id: 9, toolId: 'write_chapter', arguments: {} });
    const frame = await client.waitFor((f) => f.op === 'result' && f.id === 9);
    expect(frame).toMatchObject({ op: 'result', id: 9, ok: false, error: 'dispatch boom' });
    client.close();
    registry.disposeAll();
  });
});

// ── 装配 wiring（漏装配红线）──

describe('agyBridge：installShellAgyBridgeCore wiring（model-protocols 内核装配钉死）', () => {
  it('install 后 model-protocols 探针非空 + writeHomePayload 走通真实四件套路径', async () => {
    expect(__getAgyBridgeCoreForTest()).toBeUndefined(); // 前置：未装配
    const realHome = tempDir('agy-bridge-wiring-real-');
    buildRealHomeFixture(realHome);
    const homeRoot = tempDir('agy-bridge-wiring-root-');
    const registry = installShellAgyBridgeCore({
      homeRoot,
      realHome,
      mcpServerPath: '/assets/mcpServer.mjs',
      execPath: '/electron/exe',
    });

    const core = __getAgyBridgeCoreForTest();
    expect(core).toBeDefined();
    expect(core!.homeRoot).toBe(homeRoot);
    // 09-19 白名单 W2：装配处填 renderAgentMarkdown(CLOSURE_BRIDGE_AGENT)（内容单源 =
    // 协议层 agents.ts，shell 零内容编写）。
    expect(core!.bridgeAgentMarkdown).toBe(renderAgentMarkdown(CLOSURE_BRIDGE_AGENT));
    // 内核 writeHomePayload → shell prepareBridgeHome 真实现（漏装配 = 生产全量降级而无红的对偶：装配了但没接到实现也在此红）。
    const homeDir = path.join(homeRoot, 'session-w');
    await core!.writeHomePayload({
      homeDir,
      sessionId: 'session-w',
      serverName: BRIDGE_MCP_SERVER_NAME,
      pipeName: 'p-w',
      token: 't-w',
      tools: FACE,
      agentMarkdown: core!.bridgeAgentMarkdown,
    });
    const mcpConfig = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcpConfig.mcpServers)).toEqual([BRIDGE_MCP_SERVER_NAME]);
    expect(JSON.parse(readFileSync(path.join(homeDir, 'marker.json'), 'utf8'))).toMatchObject({ sessionId: 'session-w' });
    // 桥 agent 文件落盘且内容 = 生成器输出（spawn --agent 激活值的假宿落盘面——W2 主链）。
    expect(readFileSync(bridgeAgentFilePath(homeDir), 'utf8')).toBe(renderAgentMarkdown(CLOSURE_BRIDGE_AGENT));
    // openBridgeSession → 注册表。
    const opened = await core!.openBridgeSession({ sessionId: 'session-o', projectDir: os.tmpdir(), permissionMode: 'auto', face: FACE });
    expect(registry.getSession('session-o')?.token).toBe(opened.token);
    registry.disposeAll();
  });
});

// 静态资产在位守卫（构建期拷贝的源文件——丢资产 = prod spawn 哑火）。
describe('agyBridge：mcpServer.mjs 资产在位', () => {
  it('resources/agy-bridge/mcpServer.mjs 存在且含协议关键锚点', () => {
    const assetPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'agy-bridge', 'mcpServer.mjs');
    expect(existsSync(assetPath)).toBe(true);
    const source = readFileSync(assetPath, 'utf8');
    expect(source).toContain('server/discover');
    expect(source).toContain('-32601');
    expect(source).toContain('protocolVersion');
    expect(source).toContain('present_result');
    expect(source).toContain('ORISON_BRIDGE_TOOLS_JSON');
    expect(source).toContain('novel-writing');
  });
});

// ── 09-20 F17 W1/W3：本地工具分派（design §1.2/§1.3）+ abort 联动（design §4-1）──

/**
 * 在 agent 库 registry 注册 stub 本地件（defineTool 直建形态）。桥分派只透传 params——
 * zod schema 不解析，stub 面只需形态满足 ToolDefinition（zod 非 shell 直接依赖，cast 补）。
 * afterEach 经 registry.__clearForTest() 清（agent 模块级单例不跨 describe 泄漏）。
 */
function registerStubLocalTool(
  id: string,
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<{ title: string; output: string; metadata?: Record<string, unknown> }>,
): void {
  registry.register({
    id,
    description: `stub ${id}`,
    parameters: {} as never,
    execute: execute as unknown as Parameters<typeof registry.register>[0]['execute'],
  });
}

describe('agyBridge：本地工具分派（三闸后 registry 本地件 → 进程内 ToolContext 执行）', () => {
  afterEach(() => {
    registry.__clearForTest();
  });

  it('本地命中：ctx 八字段同源基准（loop.ts:497-507）+ 结果/metadata 透传 + 不经 shell 通道', async () => {
    const seen: Array<{ params: Record<string, unknown>; ctx: ToolContext }> = [];
    registerStubLocalTool('stub_local_probe', async (params, ctx) => {
      seen.push({ params: params as Record<string, unknown>, ctx });
      return { title: '探测', output: '本地件完成', metadata: { k: 1 } };
    });
    const runtimeStub = { runChapterChain: vi.fn() } as unknown as SkillExecutorRef;
    const chainSender = vi.fn();
    const childSender = vi.fn();
    const face = [...FACE, { name: 'stub_local_probe', description: 'stub', inputSchema: { type: 'object' } }];
    const record = makeRecord({
      permissionMode: 'auto',
      face,
      faceNames: new Set(face.map((t) => t.name)),
      agentRuntime: () => runtimeStub,
      emitChainEvent: chainSender,
      emitChildEvent: childSender,
      lastActivityAt: 0,
    });
    const result = await executeBridgeToolCall(record, 'stub_local_probe', { a: 1 });
    expect(result).toMatchObject({ ok: true, output: '本地件完成', metadata: { k: 1 } });
    expect(handleToolExecuteMock).not.toHaveBeenCalled(); // 不经 shell 统一通道
    // ctx 八字段（design §1.3）：sessionId = leader 会话键位；projectPath = 假宿外的项目根；
    // abort = 记录信号（UI 停止联动面）；skillExecutor = deps.agentRuntime()；spawnDepth = 0
    //（桥 = leader 层）；emitChainEvent/emitChildEvent = 记录上的发送器；emitConfirmation 缺席。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.params).toEqual({ a: 1 });
    const ctx = seen[0]!.ctx;
    expect(ctx.sessionId).toBe(record.sessionId);
    expect(ctx.projectPath).toBe(record.projectDir);
    expect(ctx.abort).toBe(record.abortController.signal);
    expect(ctx.skillExecutor).toBe(runtimeStub);
    expect(ctx.spawnDepth).toBe(0);
    expect(ctx.emitChainEvent).toBe(chainSender);
    expect(ctx.emitChildEvent).toBe(childSender);
    expect(ctx.emitConfirmation).toBeUndefined();
    // idle 续活（design §4-2）：本地工具执行起止各 touch（此处至少起步 touch 可观测）。
    expect(record.lastActivityAt).toBeGreaterThan(0);
  });

  it('activeSkill 预埋（design §1.4）：metadata.activeSkill → 会话级收窄面 → 闸1b 拒后续面外调用；垃圾形态零写入', async () => {
    let metadata: Record<string, unknown> | undefined;
    registerStubLocalTool('stub_skill_loader', async () => ({
      title: 'skill',
      output: 'loaded',
      ...(metadata !== undefined ? { metadata } : {}),
    }));
    const face = [
      ...FACE,
      { name: 'stub_skill_loader', description: 'stub', inputSchema: { type: 'object' } },
      { name: 'query_story', description: '查询', inputSchema: { type: 'object' } },
    ];
    const record = makeRecord({ permissionMode: 'auto', face, faceNames: new Set(face.map((t) => t.name)) });
    // 垃圾形态（非对象 / allowedTools 非数组）→ 零写入。
    metadata = { activeSkill: 'garbage' };
    await executeBridgeToolCall(record, 'stub_skill_loader', {});
    expect(record.activeSkillAllowedTools).toBeUndefined();
    metadata = { activeSkill: { name: 's', allowedTools: 'not-array', permission: 'auto' } };
    await executeBridgeToolCall(record, 'stub_skill_loader', {});
    expect(record.activeSkillAllowedTools).toBeUndefined();
    // 正常形态 → 写入 + 闸1b 收窄（同源 loop.ts:529-534 的 activeSkillAllowedTools 参数）。
    metadata = { activeSkill: { name: 's', allowedTools: ['query_story'], permission: 'auto' } };
    await executeBridgeToolCall(record, 'stub_skill_loader', {});
    expect(record.activeSkillAllowedTools).toEqual(['query_story']);
    // 面外于 allowedTools 的调用（write_chapter 在会话面内、classify=read 档位闸本放行）→
    // activeSkill 收窄拒。
    const rejected = await executeBridgeToolCall(record, 'write_chapter', {});
    expect(rejected).toMatchObject({ ok: false, gate: 'policy' });
    if (!rejected.ok) expect(rejected.error).toContain('not allowed by active skill');
  });

  it('未命中（registry 无此本地件）→ 落回 handleToolExecute 现状（代理工具直达 shell handler）', async () => {
    // 注册面非空（别件在场）——证分派按 id 判，非「注册面空 → 全走 shell」假绿。
    registerStubLocalTool('stub_local_probe', async () => ({ title: 't', output: 'x' }));
    handleToolExecuteMock.mockResolvedValueOnce({ title: '写章', output: 'shell 完成' });
    const record = makeRecord({ permissionMode: 'auto' });
    const result = await executeBridgeToolCall(record, 'write_chapter', { chapter: 1 });
    expect(result).toMatchObject({ ok: true, output: 'shell 完成' });
    expect(handleToolExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'write_chapter',
      params: { chapter: 1 },
      projectDir: record.projectDir,
      sessionId: record.sessionId,
      abort: record.abortController.signal,
    }));
  });

  it('闸拒不变：本地件同受闸1b（readonly 档 write 类 → policy 拒，本地执行器与 shell 通道都不触达）', async () => {
    const execute = vi.fn(async () => ({ title: 't', output: 'x' }));
    registerStubLocalTool('memory_update', execute);
    const face = [...FACE, { name: 'memory_update', description: 'stub', inputSchema: { type: 'object' } }];
    const record = makeRecord({ permissionMode: 'readonly', face, faceNames: new Set(face.map((t) => t.name)) });
    const result = await executeBridgeToolCall(record, 'memory_update', {});
    expect(result).toMatchObject({ ok: false, gate: 'policy' });
    expect(execute).not.toHaveBeenCalled();
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('abort signal 贯通：本地件收到 record.abortController 信号，执行中 abort 可观测（CR-2 后预中止记录不再派发，贯通改在执行中验）', async () => {
    let seenAbort: AbortSignal | undefined;
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    registerStubLocalTool('stub_local_probe', async (_params, ctx) => {
      seenAbort = ctx.abort;
      releaseTool?.();
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      return { title: 't', output: 'x' };
    });
    const face = [...FACE, { name: 'stub_local_probe', description: 'stub', inputSchema: { type: 'object' } }];
    const record = makeRecord({ permissionMode: 'auto', face, faceNames: new Set(face.map((t) => t.name)) });
    const pending = executeBridgeToolCall(record, 'stub_local_probe', {});
    await toolGate; // 工具已拿到 ctx（seenAbort 已置）后再 abort——验贯通不依赖预中止
    record.abortController.abort(new Error('stop'));
    await pending;
    expect(seenAbort).toBe(record.abortController.signal);
    expect(seenAbort?.aborted).toBe(true);
  });

  it('CR-2 pre-dispatch abort 门：会话中止后的 call 帧不再执行（本地件与 shell 通道都不触达，mirror loop.ts:511-525）', async () => {
    const execute = vi.fn(async () => ({ title: 't', output: 'x' }));
    registerStubLocalTool('stub_local_probe', execute);
    const record = makeRecord({ permissionMode: 'auto' });
    const reason = new Error('stop');
    reason.name = 'AbortError';
    record.abortController.abort(reason);
    const result = await executeBridgeToolCall(record, 'write_chapter', {});
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('会话已被用户中止');
    expect(execute).not.toHaveBeenCalled();
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });

  it('本地件执行失败 → ok:false 错误结果（G4 顺带：catch 留痕不炸管道回程）', async () => {
    registerStubLocalTool('stub_local_probe', async () => {
      throw new Error('本地件炸了');
    });
    const face = [...FACE, { name: 'stub_local_probe', description: 'stub', inputSchema: { type: 'object' } }];
    const record = makeRecord({ permissionMode: 'auto', face, faceNames: new Set(face.map((t) => t.name)) });
    const result = await executeBridgeToolCall(record, 'stub_local_probe', {});
    expect(result).toMatchObject({ ok: false, error: '本地件炸了' });
    expect(handleToolExecuteMock).not.toHaveBeenCalled();
  });
});

describe('agyBridge：abort 联动（UI 停止钮掐桥会话在途本地执行）', () => {
  afterEach(() => {
    setProductionAgyBridgeRuntime(undefined);
  });

  it('abortBridgeSession：在册会话 → abort 记录信号（abort-only 不 revoke）；无会话 → false', () => {
    const registryInstance = createAgyBridgeRegistry();
    setProductionAgyBridgeRuntime(registryInstance);
    registryInstance.openSession({
      sessionId: 'session-ab',
      projectDir: os.tmpdir(),
      permissionMode: 'auto',
      face: FACE,
    });
    expect(abortBridgeSession('session-ab')).toBe(true);
    // abort-only：会话仍在册（销毁归 turn 生产的 abort catch revoke 语义——turn 级所有权）。
    const record = registryInstance.getSession('session-ab');
    expect(record).toBeDefined();
    expect(record!.abortController.signal.aborted).toBe(true);
    // CR-1（09-21 三层 CR）：reason 须 AbortError 形——isAbortLikeError 只认 name，
    // 裸 Error 会被 turn 生产 catch 当普通失败误分类（abort→revoke 链断裂）。
    const reason = record!.abortController.signal.reason as Error;
    expect(reason).toBeInstanceOf(Error);
    expect(reason.name).toBe('AbortError');
    expect(reason.message).toBe('agy bridge session aborted by user');
    expect(abortBridgeSession('no-such-session')).toBe(false);
    registryInstance.disposeAll();
  });

  it('CR-1 中止后会话复用：同输入幂等复用 → 重建 abort 控制器（不毒化会话余下生命周期）+ warn 留痕', () => {
    const warn = vi.fn();
    const registryInstance = createAgyBridgeRegistry({ warn });
    const input = { sessionId: 'session-cr1', projectDir: os.tmpdir(), permissionMode: 'auto' as const, face: FACE };
    const first = registryInstance.openSession(input);
    const record = registryInstance.getSession('session-cr1')!;
    expect(record.abortController.signal.aborted).toBe(false);
    const stop = new Error('stop');
    stop.name = 'AbortError';
    record.abortController.abort(stop); // 模拟用户停止且无在途 turn（无 revoke 路径）
    const second = registryInstance.openSession(input);
    expect(second.token).toBe(first.token); // 幂等复用（管道/token 不变）
    expect(record.abortController.signal.aborted).toBe(false); // 控制器已重建
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('重建 abort 控制器'));
    registryInstance.disposeAll();
  });

  it('未装配生产注册表 → false（幂等，不 throw）', () => {
    expect(abortBridgeSession('any-session')).toBe(false);
  });
});

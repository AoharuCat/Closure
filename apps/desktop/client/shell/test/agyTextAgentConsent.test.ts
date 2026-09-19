import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgyTextAgentFileState } from '@orison/shared-contracts';
import {
  CLOSURE_TEXT_AGENT,
  CLOSURE_TEXT_AGENT_LAYOUT,
  closureAgentContentHash,
  renderAgentMarkdown,
} from '@orison/model-protocols';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

// CR-5：consent 损坏 warn 单次旗断言面（logger 整体 mock——本文件其余路径零日志消费）。
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info: vi.fn() }) }));

import {
  __resetTextAgentConsentCorruptWarnForTest,
  buildTextAgentStatusView,
  createAgyTextAgentConsentStore,
  detectAgentNameShadowing,
  detectTextAgentNameShadowing,
  defaultTextAgentConsentFilePath,
  parseAgentFrontmatterName,
  reconcileTextAgentAtStartup,
  removeTextAgentFileIfOurs,
  resolveTextAgentFileState,
  textAgentConsentEnabled,
  textAgentFilePath,
  writeTextAgentFile,
  type AgyTextAgentConsentStore,
} from '../main/ipc/agyTextAgentConsent';
import { rmBestEffort } from './rmBestEffort';

// ── 09-19 CLI 白名单 W3：文本 Agent 同意存储 + 真实全局文件生命周期原语测试 ──
//
// 全部落 temp 根（红线：零真实 ~/.gemini / ~/.orison 写）。覆盖：store 翻转语义
//（无记录 = 默认开启）、损坏保守化（CR-5：坏文件 → 'corrupt' 视同 declined + warn 一次）、
// 文件四态转换、写/删红线（foreign 拒写拒删 + CR-6 'wx' 独占创建）、启动对账全分支、
// frontmatter name 遮蔽三例（无遮蔽 / 有遮蔽 / 解析容错——装机探针定谳③）+ CR-2 泛化
//（text/bridge 双名 + symlink 目录 + 大小帽）。

let realHome: string;
let consentDir: string;

beforeEach(() => {
  realHome = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-home-'));
  consentDir = mkdtempSync(path.join(os.tmpdir(), 'agy-text-agent-consent-'));
  warn.mockClear();
  __resetTextAgentConsentCorruptWarnForTest();
});

afterEach(() => {
  rmBestEffort(realHome);
  rmBestEffort(consentDir);
});

function makeStore(): AgyTextAgentConsentStore {
  return createAgyTextAgentConsentStore({ filePath: path.join(consentDir, 'consent.json') });
}

function agentFile(): string {
  return textAgentFilePath(realHome);
}

/**
 * stale 化：把尾标记 hash 换成旧版本值——W1 陈旧语义 = 标记 hash（**版本身份**，记录
 * 写入时的内容版本）≠ 当前生成器输出 hash；对现版本文件就地篡改正文不在陈旧检测面内
 *（版本身份比对，无需剥离重算——agents.ts 定谳语义）。
 */
function staleify(): void {
  const lines = readFileSync(agentFile(), 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('<!-- closure-agent-content-v1:'));
  expect(idx).toBeGreaterThanOrEqual(0);
  lines[idx] = '<!-- closure-agent-content-v1:000000000000 -->';
  writeFileSync(agentFile(), lines.join('\n'), 'utf8');
}

describe('同意存储（仅记显式 declined；无记录 = 默认开启）', () => {
  it('无记录 → read undefined（默认开启）；markDeclined → 持久 declined（跨实例可读）', () => {
    const store = makeStore();
    expect(store.read()).toBeUndefined();

    store.markDeclined();
    expect(store.read()).toBe('declined');
    expect(createAgyTextAgentConsentStore({ filePath: store.filePath() }).read()).toBe('declined');

    store.clearDeclined();
    expect(store.read()).toBeUndefined();
  });

  it('坏状态文件保守化（CR-5）：坏 JSON / 非对象 / 未知 consent 值 → corrupt（视同 declined）+ warn 一次', () => {
    const file = path.join(consentDir, 'consent.json');
    // 合法清空形态（clearDeclined 的 `{version:1}`）不在损坏面——undefined = 默认开启。
    for (const [content, expected] of [
      ['{not json', 'corrupt'],
      ['', 'corrupt'],
      ['null', 'corrupt'],
      ['"str"', 'corrupt'],
      ['[]', 'corrupt'],
      [JSON.stringify({ consent: 'hacked' }), 'corrupt'],
      [JSON.stringify({ consent: 42 }), 'corrupt'],
      [JSON.stringify({ version: 1 }), undefined],
    ] as const) {
      mkdirSync(consentDir, { recursive: true });
      writeFileSync(file, content, 'utf8');
      expect(makeStore().read()).toBe(expected);
    }
    // corrupt → 开关判定单源视同 declined（宁少写不误写全局）。
    writeFileSync(file, '{not json', 'utf8');
    expect(textAgentConsentEnabled(makeStore().read())).toBe(false);
    // warn 进程级一次（CR-5：多次 corrupt 读不刷屏）。
    makeStore().read();
    makeStore().read();
    expect(warn).toHaveBeenCalledTimes(1);
    const firstArg = warn.mock.calls[0]?.[0] as { file?: string } | undefined;
    expect(String(firstArg?.file)).toContain('consent.json');
  });

  it('路径单源：defaultTextAgentConsentFilePath = ~/.orison/agy-text-agent/consent.json', () => {
    expect(defaultTextAgentConsentFilePath('/h')).toBe(path.join('/h', '.orison', 'agy-text-agent', 'consent.json'));
  });
});

describe('文件四态（current/stale/foreign/missing）', () => {
  const markdown = renderAgentMarkdown(CLOSURE_TEXT_AGENT);

  it('missing → 写入后 current（hash 一致）→ stale 化后 stale → 外来文本 foreign', () => {
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('missing');

    expect(writeTextAgentFile({ realHome, markdown })).toEqual({ ok: true });
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('current');

    staleify();
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('stale');

    writeFileSync(agentFile(), '# 用户自己的 agent\n随便写的内容\n', 'utf8');
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('foreign');
  });

  it('写红线：foreign 压住 → foreign-conflict 拒写（文件内容不变）；current/stale 可覆写更新', () => {
    expect(writeTextAgentFile({ realHome, markdown })).toEqual({ ok: true });

    writeFileSync(agentFile(), '外来内容\n', 'utf8');
    const before = readFileSync(agentFile(), 'utf8');
    const refused = writeTextAgentFile({ realHome, markdown });
    expect(refused).toEqual({ ok: false, error: 'foreign-conflict' });
    expect(readFileSync(agentFile(), 'utf8')).toBe(before);

    // 恢复我方文件（先移走外来占位——writeTextAgentFile 对外来路径按设计拒写）后：
    // stale 态可被最新内容覆写（启动对账更新语义）。
    rmSync(agentFile(), { force: true });
    writeTextAgentFile({ realHome, markdown });
    staleify();
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('stale');
    expect(writeTextAgentFile({ realHome, markdown })).toEqual({ ok: true });
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('current');
  });

  it('删红线：current 删除返回 true；missing/foreign 返回 false 且外来文件绝不动', () => {
    expect(removeTextAgentFileIfOurs(realHome)).toBe(false); // missing

    writeTextAgentFile({ realHome, markdown });
    expect(removeTextAgentFileIfOurs(realHome)).toBe(true);
    expect(existsSync(agentFile())).toBe(false);

    mkdirSync(path.dirname(agentFile()), { recursive: true });
    writeFileSync(agentFile(), '用户自己的文件\n', 'utf8');
    expect(removeTextAgentFileIfOurs(realHome)).toBe(false); // foreign 绝不动
    expect(existsSync(agentFile())).toBe(true);
    expect(readFileSync(agentFile(), 'utf8')).toBe('用户自己的文件\n');
    rmSync(agentFile(), { force: true });
  });

  it('CR-7 大小帽：>1MB 文件（即便带 Closure 标记）不读即判 foreign（防巨型文件同步读卡主进程）', () => {
    mkdirSync(path.dirname(agentFile()), { recursive: true });
    // 带合法尾标记的巨物——形态上「像我方」，但 >1MB 绝不可能是本 task 产物。
    writeFileSync(agentFile(), `${markdown}${'# pad\n'.repeat(200 * 1024)}`, 'utf8');
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('foreign');
  });
});

describe('启动对账（reconcileTextAgentAtStartup 全分支）', () => {
  const markdown = renderAgentMarkdown(CLOSURE_TEXT_AGENT);

  function reconcile(enabled: boolean, log: string[] = []): AgyTextAgentFileState {
    return reconcileTextAgentAtStartup({ realHome, markdown, enabled, log: (m) => log.push(m) });
  }

  it('enabled + missing → 写最新（态转 current）+ 「已注入」日志行', () => {
    const log: string[] = [];
    expect(reconcile(true, log)).toBe('current');
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('current');
    expect(log.join('\n')).toContain('已注入');
  });

  it('enabled + stale → 重写最新（态转 current）+ 「已更新」日志行', () => {
    writeTextAgentFile({ realHome, markdown });
    staleify();
    const log: string[] = [];
    expect(reconcile(true, log)).toBe('current');
    expect(resolveTextAgentFileState({ realHome, expectedMarkdown: markdown })).toBe('current');
    expect(log.join('\n')).toContain('已更新至当前版本');
  });

  it('enabled + current → 不改写 + 「版本一致」日志行', () => {
    writeTextAgentFile({ realHome, markdown });
    const before = readFileSync(agentFile(), 'utf8');
    const log: string[] = [];
    expect(reconcile(true, log)).toBe('current');
    expect(readFileSync(agentFile(), 'utf8')).toBe(before);
    expect(log.join('\n')).toContain('版本一致');
  });

  it('enabled + foreign → 不动（绝不覆盖）+ 「跳过注入」呈报行；遮蔽警示不阻断我方文件维护', () => {
    mkdirSync(path.dirname(agentFile()), { recursive: true });
    writeFileSync(agentFile(), '外来压住的文件\n', 'utf8');
    const log: string[] = [];
    expect(reconcile(true, log)).toBe('foreign');
    expect(readFileSync(agentFile(), 'utf8')).toBe('外来压住的文件\n');
    expect(log.join('\n')).toContain('跳过注入');
  });

  it('disabled（declined / 无 CLI key）→ 不写不刷屏（missing 保持 missing）', () => {
    const log: string[] = [];
    expect(reconcile(false, log)).toBe('missing');
    expect(existsSync(agentFile())).toBe(false);
    expect(log).toHaveLength(0);
  });
});

describe('frontmatter name 遮蔽检测（装机探针定谳③）', () => {
  const markdown = renderAgentMarkdown(CLOSURE_TEXT_AGENT);
  const agentsRoot = () => path.join(realHome, '.gemini', 'config', 'agents');

  function placeForeign(dir: string, content: string): string {
    const file = path.join(agentsRoot(), dir, 'agent.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    return file;
  }

  it('无遮蔽：agents 根不存在 / 只有我方目录 / 同名文件在我方目录自身 → []', () => {
    expect(detectTextAgentNameShadowing(realHome)).toEqual([]);

    writeTextAgentFile({ realHome, markdown }); // 我方 closure-text/agent.md
    expect(detectTextAgentNameShadowing(realHome)).toEqual([]);

    // 我方目录内的「重名」即我方文件本身——路径排除，不算遮蔽。
    expect(parseAgentFrontmatterName(readFileSync(agentFile(), 'utf8'))).toBe(CLOSURE_TEXT_AGENT_LAYOUT.agentName);
  });

  it('有遮蔽：外来目录同 frontmatter name → 记外来路径（我方目录排除；多目录全收）', () => {
    const foreignA = placeForeign('other-dir', '---\nname: closure-text\ndescription: x\n---\n正文\n');
    const foreignB = placeForeign('another', '---\nname: "closure-text"\ndescription: y\n---\n正文\n'); // 围引号同值
    placeForeign('benign', '---\nname: something-else\ndescription: z\n---\n正文\n');
    expect(detectTextAgentNameShadowing(realHome)).toEqual([foreignA, foreignB].sort());
  });

  it('解析容错：坏 frontmatter（无围栏/无 name/坏形态）跳过不炸；嵌套目录一层扫描不深入', () => {
    placeForeign('bad1', '没有 frontmatter 的普通 markdown');
    placeForeign('bad2', '---\ndescription: 有围栏无 name\n---\n正文\n');
    placeForeign('bad3', '---\nname 值奇怪\n---\n正文\n');
    expect(detectTextAgentNameShadowing(realHome)).toEqual([]);

    // 嵌套（nested/deep/agent.md）不入扫描面（1.2.2 不发现——无遮蔽可能）。
    const deep = path.join(agentsRoot(), 'nested', 'deep');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'agent.md'), '---\nname: closure-text\n---\n正文\n', 'utf8');
    expect(detectTextAgentNameShadowing(realHome)).toEqual([]);
  });

  it('解析器直测：剥围引号 + CRLF 容错；无 name → undefined', () => {
    expect(parseAgentFrontmatterName('---\nname: closure-text\n---\n')).toBe('closure-text');
    expect(parseAgentFrontmatterName('---\r\nname: "closure-text"\r\n---\r\n')).toBe('closure-text');
    expect(parseAgentFrontmatterName("---\nname: 'quoted'\n---\n")).toBe('quoted');
    expect(parseAgentFrontmatterName('---\ndescription: no name\n---\n')).toBeUndefined();
    expect(parseAgentFrontmatterName('plain text')).toBeUndefined();
    expect(parseAgentFrontmatterName('---\n未闭合')).toBeUndefined();
  });

  // ── CR-2 泛化面：text/bridge 双名 + symlink 目录 + 大小帽 ──

  it('CR-2 泛化：detectAgentNameShadowing 双名命中（text 或 bridge 名都收）；我方两布局路径恒排除', () => {
    const bridgeHit = placeForeign('shadow-bridge', '---\nname: closure-bridge\n---\n正文\n');
    const textHit = placeForeign('shadow-text', '---\nname: closure-text\n---\n正文\n');
    placeForeign('benign', '---\nname: other\n---\n正文\n');
    const hits = detectAgentNameShadowing(realHome, [
      CLOSURE_TEXT_AGENT_LAYOUT.agentName,
      'closure-bridge',
    ]);
    expect(hits).toEqual([bridgeHit, textHit].sort());

    // 我方两布局规范路径（text/bridge）self 不算撞名：把同名文件放进我方目录段。
    const ourBridge = path.join(agentsRoot(), 'closure-bridge', 'agent.md');
    mkdirSync(path.dirname(ourBridge), { recursive: true });
    writeFileSync(ourBridge, '---\nname: closure-bridge\n---\n正文\n', 'utf8');
    expect(
      detectAgentNameShadowing(realHome, [CLOSURE_TEXT_AGENT_LAYOUT.agentName, 'closure-bridge']),
    ).toEqual([bridgeHit, textHit].sort());
  });

  it('CR-2 symlink 目录跟进：agents 根下的符号链接目录装同名 agent → 命中（断链/文件链接跳过）', () => {
    // 真目录放别处，agents 根内以符号链接指入——dirent.isDirectory()=false 的形态。
    const realDir = path.join(realHome, 'elsewhere', 'shadowy-link');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(path.join(realDir, 'agent.md'), '---\nname: closure-text\n---\n正文\n', 'utf8');
    const link = path.join(agentsRoot(), 'linked-shadow');
    mkdirSync(agentsRoot(), { recursive: true });
    try {
      symlinkSync(realDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Windows 无开发者模式/特权环境创建 symlink 会 EPERM——机制面无法布景即跳过
      //（mirror materialIpc.test.ts junction 先例；判定逻辑为纯 statSync 跟进）。
      return;
    }
    const hits = detectTextAgentNameShadowing(realHome);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(path.join(link, 'agent.md'));

    // 断链目录：跳过不炸。
    rmSync(realDir, { recursive: true, force: true });
    expect(detectTextAgentNameShadowing(realHome)).toEqual([]);
  });

  it('CR-7 大小帽：>1MB 同名 agent.md 跳过不读（不判遮蔽、不卡主进程）', () => {
    placeForeign('huge', `---\nname: closure-text\n---\n${'# pad\n'.repeat(200 * 1024)}`);
    expect(detectTextAgentNameShadowing(realHome)).toEqual([]);
  });
});

describe('状态读面（buildTextAgentStatusView）', () => {
  it('enabled = 无 declined；cliKeyPresent 透传；四态 + 遮蔽 + 路径齐备', () => {
    writeTextAgentFile({ realHome, markdown: renderAgentMarkdown(CLOSURE_TEXT_AGENT) });
    placeForeignShadow();
    const view = buildTextAgentStatusView({
      declined: false,
      cliKeyPresent: true,
      realHome,
      consentFilePath: path.join(consentDir, 'consent.json'),
    });
    expect(view.enabled).toBe(true);
    expect(view.cliKeyPresent).toBe(true);
    expect(view.fileState).toBe('current');
    expect(view.shadowedBy).toEqual([shadowPath()]);
    expect(view.agentFilePath).toBe(agentFile());

    const declinedView = buildTextAgentStatusView({
      declined: true,
      cliKeyPresent: false,
      realHome,
      consentFilePath: path.join(consentDir, 'consent.json'),
    });
    expect(declinedView.enabled).toBe(false);
    expect(declinedView.cliKeyPresent).toBe(false);
  });

  const shadowDir = () => path.join(realHome, '.gemini', 'config', 'agents', 'shadowy');
  const shadowPath = () => path.join(shadowDir(), 'agent.md');
  function placeForeignShadow(): void {
    mkdirSync(shadowDir(), { recursive: true });
    writeFileSync(shadowPath(), '---\nname: closure-text\n---\n正文\n', 'utf8');
  }
});

describe('fixture 自检（W1 语义单源锚）', () => {
  it('激活值与布局目录同源（探针定谳：激活 = frontmatter name 精确匹配）', () => {
    expect(CLOSURE_TEXT_AGENT_LAYOUT.agentName).toBe('closure-text');
    expect(CLOSURE_TEXT_AGENT.name).toBe(CLOSURE_TEXT_AGENT_LAYOUT.agentName);
    expect(closureAgentContentHash(renderAgentMarkdown(CLOSURE_TEXT_AGENT))).toMatch(/^[0-9a-f]{12}$/);
  });
});

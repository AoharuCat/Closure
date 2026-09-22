/**
 * 09-12 子4 W6（design §4.3/§8）：agy MCP 工具桥运行期可见性——dispatcher 面测试。
 *
 * 覆盖：
 * - `parseAgyBridgeConsentError`：前缀三态解析（missing-consent / conflict+rules /
 *   declined）+ 非前缀错误不误吞。
 * - agentEvents `error` case 的桥同意拦截：前缀错误 → agyBridgeStore.ask 开（declined
 *   不开——AC6 不再征询）+ agentError 落人话键（前缀串不直出）；非前缀错误行为零变化。
 * - agentEvents `bridge-notice` case：三信号 per-session 写入（cap）/ 最小测试 store
 *   缺省字段不写不炸；R5 增 builtin-tool-started（携工具名，其余信号不带键）；R6 增
 *   builtin-tool-denied（F13——携名/无名两形态）。
 * - AgentPanel 渲染面：soft-denied 通知条可见（运行阶段可见性纪律：不静默）；R5 内置
 *   工具步通知条与人话文案（与桥工具相位「正在调用 X」措辞可区分）；R6 内置工具被拒
 *   通知条（与 soft-denied 的 MCP 预授权语义分开）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AgentStreamEvent } from '../src/shared/api/agent';

// CR-09-20-dogfood-1：Part 4 起向真 appStore 派发 done / 调 cancelAgent——两者都会触
// fetchAgentSession 对账（api 模块级捕获 window.orisonDesktop，本文件装桥晚于模块加载）
// → mock api/agent 单点（mirror agentEventsDispatch.test.ts 形态）。
const apiMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ id: 'session-1', messages: [] })),
  fetchAgentSession: vi.fn(async () => ({ id: 'session-1', status: 'idle', messages: [] })),
  setAgentSessionMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionBehaviorMode: vi.fn(async () => ({ ok: true })),
  setAgentSessionParticipationGear: vi.fn(async () => ({ ok: true })),
  deleteAgentSession: vi.fn(async () => true),
  listAgentSessions: vi.fn(async () => []),
  streamAgentMessage: vi.fn(async () => ({ status: 'completed' })),
  resumeChapterChain: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../src/shared/api/agent', () => apiMocks);

import {
  handleAgentStreamEvent,
  __clearAgentEventTracks,
  BRIDGE_NOTICE_CAP,
  type AgentDispatchState,
  type AgentStreamWireEvent,
} from '../src/shared/store/agentEvents';
import {
  __resetAgyBridgeStoreForTest,
  parseAgyBridgeConsentError,
  useAgyBridgeStore,
} from '../src/shared/store/agyBridgeStore';
import { AgentPanel } from '../src/features/agent-panel/AgentPanel';
import { translate } from '../src/shared/i18n/useI18n';
import { useAppStore } from '../src/shared/store/appStore';

// ── Part 1：dispatcher case（最小 store，mirror agentContextUsageBar 先例）──

type BridgeTestState = AgentDispatchState & Record<string, unknown>;

const useBridgeStore = create<BridgeTestState>()((set) => ({
  agentSessionId: 's1',
  agentMessages: [],
  activeSessionRunning: false,
  agentError: null,
  currentProject: { path: 'I:/p' },
  agentRunStates: {},
  chainRunBySession: {},
  chainRunAnchorByProject: {},
  bridgeNoticesBySession: {},
  runOutcomeBySession: {},
  setAgentRunState: vi.fn(),
  setPendingToolConfirm: vi.fn(),
  pushPendingDiff: vi.fn(),
  setPausedReview: vi.fn(),
  setPendingPatch: vi.fn(),
  fieldMetadata: {},
  set,
}));

function dispatchError(message: string, sessionId = 's1'): void {
  handleAgentStreamEvent(useBridgeStore, {
    type: 'error',
    data: { message },
    sessionId,
    projectPath: 'I:/p',
  } as AgentStreamWireEvent);
}

function dispatchNotice(
  notice: 'sendback' | 'sendback-missed' | 'soft-denied' | 'builtin-tool-started' | 'builtin-tool-denied',
  sessionId = 's1',
  toolName?: string,
): void {
  handleAgentStreamEvent(useBridgeStore, {
    type: 'bridge-notice',
    data: { notice, ...(toolName !== undefined ? { toolName } : {}) },
    sessionId,
    projectPath: 'I:/p',
  } as AgentStreamWireEvent);
}

beforeEach(() => {
  __clearAgentEventTracks();
  __resetAgyBridgeStoreForTest();
  (window as unknown as { orisonDesktop: unknown }).orisonDesktop = { abortAgentRun: vi.fn() };
  useBridgeStore.setState({ agentSessionId: 's1', agentError: null, bridgeNoticesBySession: {}, runOutcomeBySession: {} });
});

afterEach(() => cleanup());

describe('parseAgyBridgeConsentError（前缀解析）', () => {
  it('missing-consent 形态', () => {
    expect(parseAgyBridgeConsentError('agy_bridge_consent|state=missing-consent')).toEqual({
      state: 'missing-consent',
      conflicts: [],
    });
  });

  it('conflict 形态带 rules 原文', () => {
    expect(
      parseAgyBridgeConsentError('agy_bridge_consent|state=conflict|rules=mcp(novel-writing/*);mcp(*)'),
    ).toEqual({
      state: 'conflict',
      conflicts: ['mcp(novel-writing/*)', 'mcp(*)'],
    });
  });

  it('rules 编码 round-trip（CR-7）：用户规则含分隔符也不损坏 + 坏转义不炸', () => {
    // 生产侧（AgyBridgeConsentRequiredError）逐条 encodeURIComponent 后 join(';')。
    const nasty = ['mcp(novel-writing/write_chapter); rm -rf', 'mcp(a)|state=hacked'];
    const encoded = nasty.map((r) => encodeURIComponent(r)).join(';');
    expect(
      parseAgyBridgeConsentError(`agy_bridge_consent|state=conflict|rules=${encoded}`),
    ).toEqual({ state: 'conflict', conflicts: nasty });
    // 坏转义序列（畸形前缀串）按原文回退——分发面不炸。
    expect(
      parseAgyBridgeConsentError('agy_bridge_consent|state=conflict|rules=mcp(%ZZ)'),
    ).toEqual({ state: 'conflict', conflicts: ['mcp(%ZZ)'] });
  });

  it('declined 形态（turn 硬门 CR-27 三态全发）', () => {
    expect(parseAgyBridgeConsentError('agy_bridge_consent|state=declined')).toEqual({
      state: 'declined',
      conflicts: [],
    });
  });

  it('非前缀错误不误吞', () => {
    expect(parseAgyBridgeConsentError('some other failure')).toBeNull();
    expect(parseAgyBridgeConsentError('agy_bridge_consent|state=unknown-state')).toBeNull();
  });
});

describe('agentEvents error case 桥同意拦截', () => {
  it('missing-consent 前缀 → 同意对话框 ask 开 + agentError 人话键（前缀串不直出）', () => {
    dispatchError('agy_bridge_consent|state=missing-consent');
    expect(useAgyBridgeStore.getState().ask).toEqual({ state: 'missing-consent', conflicts: [] });
    expect(useBridgeStore.getState().agentError).toBe('agent.bridgeConsentNeeded');
  });

  it('conflict 前缀 → ask 带冲突规则原文', () => {
    dispatchError('agy_bridge_consent|state=conflict|rules=mcp(novel-writing/*)');
    expect(useAgyBridgeStore.getState().ask).toEqual({
      state: 'conflict',
      conflicts: ['mcp(novel-writing/*)'],
    });
    expect(useBridgeStore.getState().agentError).toBe('agent.bridgeConsentConflict');
  });

  it('declined 前缀 → 不开对话框（AC6：已拒绝不再征询）+ declined 人话键', () => {
    dispatchError('agy_bridge_consent|state=declined');
    expect(useAgyBridgeStore.getState().ask).toBeNull();
    expect(useBridgeStore.getState().agentError).toBe('agent.bridgeConsentDeclined');
  });

  it('非前缀错误 → agentError 原文照旧（零回归）', () => {
    dispatchError('generateText not initialized');
    expect(useAgyBridgeStore.getState().ask).toBeNull();
    expect(useBridgeStore.getState().agentError).toBe('generateText not initialized');
  });
});

describe('agentEvents bridge-notice case（三信号运行期可见性）', () => {
  it('三信号各写一条 per-session 通知（顺序保留）', () => {
    dispatchNotice('soft-denied');
    dispatchNotice('sendback');
    dispatchNotice('sendback-missed');
    const notices = useBridgeStore.getState().bridgeNoticesBySession!['s1'];
    expect(notices).toHaveLength(3);
    expect(notices!.map((n) => n.notice)).toEqual(['soft-denied', 'sendback', 'sendback-missed']);
  });

  it('R5：builtin-tool-started 携工具名落槽（其余信号不带 toolName 键）', () => {
    dispatchNotice('builtin-tool-started', 's1', 'list_dir');
    dispatchNotice('sendback');
    const notices = useBridgeStore.getState().bridgeNoticesBySession!['s1']!;
    expect(notices.map((n) => n.notice)).toEqual(['builtin-tool-started', 'sendback']);
    expect(notices[0]!.toolName).toBe('list_dir');
    // 缺席即不带键（undefined 不混进渲染面——`in` 判定与 `?? ` 语义都干净）。
    expect('toolName' in notices[1]!).toBe(false);
  });

  it('R6：builtin-tool-denied 落槽（携名 / 无名两形态；与其他信号共存保序）', () => {
    dispatchNotice('builtin-tool-denied', 's1', 'list_dir');
    dispatchNotice('builtin-tool-denied');
    const notices = useBridgeStore.getState().bridgeNoticesBySession!['s1']!;
    expect(notices.map((n) => n.notice)).toEqual(['builtin-tool-denied', 'builtin-tool-denied']);
    expect(notices[0]!.toolName).toBe('list_dir');
    expect('toolName' in notices[1]!).toBe(false);
  });

  it('cap 截断（BRIDGE_NOTICE_CAP）', () => {
    for (let i = 0; i < BRIDGE_NOTICE_CAP + 3; i++) dispatchNotice('soft-denied');
    expect(useBridgeStore.getState().bridgeNoticesBySession!['s1']).toHaveLength(BRIDGE_NOTICE_CAP);
  });

  it('最小测试 store 缺省字段 → 不写不炸', () => {
    const bare = create<Record<string, unknown>>((set) => ({
      agentSessionId: 's1',
      agentMessages: [],
      activeSessionRunning: false,
      agentError: null,
      currentProject: { path: 'I:/p' },
      agentRunStates: {},
      setAgentRunState: vi.fn(),
      setPendingToolConfirm: vi.fn(),
      pushPendingDiff: vi.fn(),
      setPausedReview: vi.fn(),
      setPendingPatch: vi.fn(),
      fieldMetadata: {},
      set,
    }));
    expect(() =>
      handleAgentStreamEvent(bare as unknown as Parameters<typeof handleAgentStreamEvent>[0], {
        type: 'bridge-notice',
        data: { notice: 'sendback' },
        sessionId: 's1',
      } as AgentStreamWireEvent),
    ).not.toThrow();
  });
});

// ── Part 1b：run 终态正向观测（CR-09-20-dogfood-1，小残留 b 二次修）──
// 旧判定读视图级 error——切走切回（switch 清 error 而通知残留）与 abort 回合（done 不写
// error）都误标「本轮已成功收场」。改 per-session outcome：error 事件→'error' / abort
// 请求→'aborted'（cancelAgent，slice 面）/ done→'ok'（不覆写已置标记）/ send→null。

describe('run 终态 outcome 追踪（CR-09-20-dogfood-1）', () => {
  const dispatchDone = (sessionId = 's1'): void => {
    handleAgentStreamEvent(useBridgeStore, {
      type: 'done',
      data: { status: 'completed' },
      sessionId,
      projectPath: 'I:/p',
    } as AgentStreamWireEvent);
  };

  it('done → ok；error → error（后台会话照写键控槽）', () => {
    dispatchDone('s1');
    // s2 非当前视图会话（后台）——outcome 照写（键控槽，切回可见）。
    handleAgentStreamEvent(useBridgeStore, {
      type: 'error',
      data: { message: 'boom' },
      sessionId: 's2',
      projectPath: 'I:/p',
    } as AgentStreamWireEvent);
    expect(useBridgeStore.getState().runOutcomeBySession!['s1']).toBe('ok');
    expect(useBridgeStore.getState().runOutcomeBySession!['s2']).toBe('error');
  });

  it('done 不覆写已置 aborted（abort 回合的 done 不携 error——覆写即误标成功）', () => {
    useBridgeStore.setState({ runOutcomeBySession: { s1: 'aborted' } });
    dispatchDone('s1');
    expect(useBridgeStore.getState().runOutcomeBySession!['s1']).toBe('aborted');
  });

  it('done 不覆写已置 error（防御——error 已终态，done 不得翻成功）', () => {
    useBridgeStore.setState({ runOutcomeBySession: { s1: 'error' } });
    dispatchDone('s1');
    expect(useBridgeStore.getState().runOutcomeBySession!['s1']).toBe('error');
  });

  it('最小测试 store 缺省字段 → done 不炸（mirror bridge-notice 守卫形态）', () => {
    const bare = create<BridgeTestState>()((set) => ({
      agentSessionId: 's1',
      agentMessages: [],
      activeSessionRunning: false,
      agentError: null,
      currentProject: { path: 'I:/p' },
      agentRunStates: {},
      chainRunBySession: {},
      setAgentRunState: vi.fn(),
      setPendingToolConfirm: vi.fn(),
      pushPendingDiff: vi.fn(),
      setPausedReview: vi.fn(),
      setPendingPatch: vi.fn(),
      fieldMetadata: {},
      set,
    }));
    expect(() =>
      handleAgentStreamEvent(bare as unknown as Parameters<typeof handleAgentStreamEvent>[0], {
        type: 'done',
        data: { status: 'completed' },
        sessionId: 's1',
        projectPath: 'I:/p',
      } as AgentStreamWireEvent),
    ).not.toThrow();
  });
});

// ── Part 2：AgentPanel 通知条渲染（真 appStore，mirror agentContextUsageBar seed 模式）──

function seedPanelStore(
  notices: Record<string, { id: string; notice: string; toolName?: string; at: number }[]>,
): void {
  useAppStore.setState({
    currentProject: { projectId: 'p1', name: 'Cold City', path: 'I:/echo/project' },
  } as any);
  useAppStore.getState().resetAgentForProjectSwitch();
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    agentSessionId: 'session-1',
    activeSessionRunning: false,
    agentRunStates: {},
    agentError: null,
    agentMessages: [],
    agentSkills: [],
    agentSkillError: null,
    loadAgentSkills: vi.fn().mockResolvedValue(undefined),
    skillPackages: [],
    skillPackagesLoading: false,
    loadSkillPackages: vi.fn().mockResolvedValue(undefined),
    toggleSkillPackage: vi.fn(),
    toggleSkill: vi.fn(),
    agentParticipationGear: 'smart',
    pendingAttachments: [],
    attachmentUploadStates: {},
    uploadInboxFiles: vi.fn().mockResolvedValue(undefined),
    uploadChatImages: vi.fn().mockResolvedValue(undefined),
    bridgeNoticesBySession: notices,
  } as any);
}

describe('AgentPanel 桥通知条渲染（W6 可见性）', () => {
  it('soft-denied → 通知条可见且指向授权机制（AC7）', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'soft-denied', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice--warn');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('授权策略拦下');
    expect(strip!.textContent).toContain('MCP 工具桥');
  });

  it('sendback（中性）→ 可见；无通知 → 不渲染', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'sendback', at: 1 }],
    });
    const { unmount } = render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('打回重跑');
    unmount();

    seedPanelStore({});
    render(<AgentPanel />);
    expect(document.querySelector('.agent-bridge-notice')).toBeNull();
  });

  it('未登记 kind（IPC 载荷未校验）→ 兜底条目渲染，不崩不静默', () => {
    // 治前形态：BRIDGE_NOTICE_PRESENTATION[kind] 取 undefined 后 meta.tone TypeError——
    // 整个 agent 面板渲染崩溃（白屏）。wire 事件不经 schema 校验，kind 可是任意字符串。
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'a-kind-from-the-future', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice');
    expect(strip).not.toBeNull(); // 不静默：条目照渲
    expect(strip!.textContent).toContain('未能识别');
    // 不泄露原始 kind（实现词不进用户可见面）
    expect(strip!.textContent).not.toContain('a-kind-from-the-future');
    expect(strip!.className).toContain('agent-bridge-notice--neutral');
  });

  it('未知-kind 兜底 zh/en 双语文案在位（translate 通道，回落键名 = 缺键）', () => {
    expect(translate('zh-CN', 'agent.bridgeNoticeUnknown')).toContain('未能识别');
    expect(translate('en-US', 'agent.bridgeNoticeUnknown')).toContain('unrecognized');
  });
});

// ── Part 3：R5 内置工具步呈报（模型离开了桥工具族）──

describe('R5：内置工具步通知（与桥工具相位可区分）', () => {
  it('通知条可见：人话文案 + 被调工具名后缀；措辞不被认作桥工具相位', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-started', toolName: 'list_dir', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice--warn');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('写作工具族');
    expect(strip!.textContent).toContain('list_dir');
    // 桥工具相位（tool 通道）是「正在调用 X」——本通知不得用同款措辞（防语义混淆）。
    expect(strip!.textContent).not.toContain('正在调用');
    // 无实现词泄露（工具 id 属用户可辨数据，允许；机制名不允许）。
    expect(strip!.textContent).not.toContain('builtin-tool-started');
  });

  it('工具名缺席 → 主句照渲且无悬空后缀（键缺席不渲染 scope span）', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-started', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('写作工具族');
    expect(strip!.querySelector('.agent-bridge-notice-scope')).toBeNull();
  });

  it('zh/en 双语文案在位（translate 通道，回落键名 = 缺键）', () => {
    expect(translate('zh-CN', 'agent.bridgeNoticeBuiltinTool')).toContain('写作工具族');
    expect(translate('en-US', 'agent.bridgeNoticeBuiltinTool')).toContain('writing toolset');
  });
});

// ── Part 3b：R6 内置工具被拒呈报（F13：模型离开桥工具族且调用被拦下）──

describe('R6：内置工具被拒通知（与 MCP 软拒语义分开）', () => {
  it('通知条可见：人话文案 + 被调工具名后缀；不被认作 MCP 预授权指引', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-denied', toolName: 'list_dir', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice--warn');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('写作工具族');
    expect(strip!.textContent).toContain('被系统拒绝');
    expect(strip!.textContent).toContain('list_dir');
    // 与 soft-denied（MCP 预授权）文案分开——不得指向设置页 MCP 工具桥授权入口。
    expect(strip!.textContent).not.toContain('MCP 工具桥');
    // 无实现词泄露（工具名属用户可辨数据，允许；机制名不允许）。
    expect(strip!.textContent).not.toContain('builtin-tool-denied');
  });

  it('工具名缺席（stderr 兜底信号形态）→ 主句照渲且无悬空后缀', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-denied', at: 1 }],
    });
    render(<AgentPanel />);
    const strip = document.querySelector('.agent-bridge-notice');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('被系统拒绝');
    expect(strip!.querySelector('.agent-bridge-notice-scope')).toBeNull();
  });

  it('zh/en 双语文案在位（translate 通道，回落键名 = 缺键）', () => {
    expect(translate('zh-CN', 'agent.bridgeNoticeBuiltinToolDenied')).toContain('被系统拒绝');
    expect(translate('en-US', 'agent.bridgeNoticeBuiltinToolDenied')).toContain('writing toolset');
  });
});

// ── Part 4：小残留 b（dogfood R4）——警示条结局收敛（成功标注 + 失败/运行中维持）──
// 真机观测：一个成功回合（纠正续跑救回）仍挂 4 条「模型离开了写作工具族」警示条——
// 事件时点为真，但呈现不随结局收敛。修法 = 成功收场后整组降淡 + 尾部结局标注行（不删
// 历史）；失败结局/运行中维持警示强度。
// CR-09-20-dogfood-1（二次修）：结局判定改 per-session run 终态正向观测（done→ok /
// abort→aborted / error→error / send→null）——四态测试：成功收敛 / 失败维持 / abort 不
// 误标（done 不翻已置 aborted）/ 切走切回不误标（switch 清 error 而 outcome 留存）。

describe('桥警示条结局收敛（dogfood R4 小残留 b）', () => {
  /** 真 appStore 派发终态事件（dispatch 谓词 mirror Part 1；active 视图 = session-1）。 */
  const dispatchTerminal = (type: 'done' | 'error'): void => {
    handleAgentStreamEvent(useAppStore, {
      type,
      ...(type === 'done' ? { data: { status: 'completed' } } : { data: { message: 'boom' } }),
      sessionId: 'session-1',
      projectPath: 'I:/echo/project',
    } as AgentStreamWireEvent);
  };

  it('回合成功收场（done → outcome ok）→ 收敛类 + 结局标注行（历史条目保留不删）', () => {
    seedPanelStore({
      'session-1': [
        { id: 'n1', notice: 'builtin-tool-started', toolName: 'view_file', at: 1 },
        { id: 'n2', notice: 'soft-denied', at: 2 },
      ],
    });
    dispatchTerminal('done');
    render(<AgentPanel />);
    const container = document.querySelector('.agent-bridge-notices');
    expect(container).not.toBeNull();
    expect(container!.className).toContain('agent-bridge-notices--settled-ok');
    const outcome = container!.querySelector('.agent-bridge-notice-outcome');
    expect(outcome).not.toBeNull();
    expect(outcome!.textContent).toContain('本轮已成功收场');
    // 历史警示条保留（事件时点为真——只降淡不删除）。
    expect(container!.querySelectorAll('.agent-bridge-notice').length).toBe(2);
    expect(container!.querySelector('.agent-bridge-notice--warn')).not.toBeNull();
  });

  it('失败结局（error 事件 → outcome error）→ 无收敛类无标注行，警示条维持原强度', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-started', toolName: 'view_file', at: 1 }],
    });
    dispatchTerminal('error');
    expect(useAppStore.getState().runOutcomeBySession['session-1']).toBe('error');
    render(<AgentPanel />);
    const container = document.querySelector('.agent-bridge-notices');
    expect(container).not.toBeNull();
    expect(container!.className).not.toContain('agent-bridge-notices--settled-ok');
    expect(container!.querySelector('.agent-bridge-notice-outcome')).toBeNull();
    expect(container!.querySelector('.agent-bridge-notice--warn')).not.toBeNull();
  });

  it('abort 回合不误标（cancelAgent 置 aborted；随后 done 不翻成功）', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-started', toolName: 'view_file', at: 1 }],
    });
    // UI 停止请求（真 slice 动作——置 'aborted'）。
    useAppStore.getState().cancelAgent();
    expect(useAppStore.getState().runOutcomeBySession['session-1']).toBe('aborted');
    // abort 后端侧仍以 done 收场（不携 error）——不得覆写已置标记。
    dispatchTerminal('done');
    expect(useAppStore.getState().runOutcomeBySession['session-1']).toBe('aborted');
    render(<AgentPanel />);
    const container = document.querySelector('.agent-bridge-notices');
    expect(container).not.toBeNull();
    expect(container!.className).not.toContain('agent-bridge-notices--settled-ok');
    expect(container!.querySelector('.agent-bridge-notice-outcome')).toBeNull();
  });

  it('切走切回不误标（switch 清 error 而 outcome 留存——失败结局不漂白）', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-started', toolName: 'view_file', at: 1 }],
    });
    dispatchTerminal('error');
    expect(useAppStore.getState().agentError).toContain('boom');
    // switchAgentSession 入口即清视图级 agentError（`set({ agentError: null })`）且不触
    // outcome 图——此处直改同字段模拟该面（switch 全量调用需整 session 形态，机制等价）。
    useAppStore.setState({ agentError: null } as any);
    expect(useAppStore.getState().runOutcomeBySession['session-1']).toBe('error');
    render(<AgentPanel />);
    const container = document.querySelector('.agent-bridge-notices');
    expect(container).not.toBeNull();
    expect(container!.className).not.toContain('agent-bridge-notices--settled-ok');
    expect(container!.querySelector('.agent-bridge-notice-outcome')).toBeNull();
  });

  it('运行中（activeSessionRunning）→ 不标注（事件仍在发生，谈结局为时过早）', () => {
    seedPanelStore({
      'session-1': [{ id: 'n1', notice: 'builtin-tool-started', toolName: 'view_file', at: 1 }],
    });
    useAppStore.setState({ activeSessionRunning: true } as any);
    render(<AgentPanel />);
    const container = document.querySelector('.agent-bridge-notices');
    expect(container).not.toBeNull();
    expect(container!.className).not.toContain('agent-bridge-notices--settled-ok');
    expect(container!.querySelector('.agent-bridge-notice-outcome')).toBeNull();
  });

  it('zh/en 结局标注文案在位（translate 通道，回落键名 = 缺键）', () => {
    expect(translate('zh-CN', 'agent.bridgeNoticeTurnSettledOk')).toContain('成功收场');
    expect(translate('en-US', 'agent.bridgeNoticeTurnSettledOk')).toContain('completed successfully');
  });
});

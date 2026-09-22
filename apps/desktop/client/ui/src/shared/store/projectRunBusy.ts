import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 CR（D4 闸 UI 面单源）：路径归一比较 + busy 提示 + 链 IPC 机器串解析。
//
// CR-T1-026：路径比较双标准——shell 侧注册表 key 走 normalizeProjectKey（path.resolve +
// win32 小写归一），渲染层六处裸 ===（事件 projectPath vs currentProject.path 等）在分隔符
// 风格 / 尾斜杠 / 盘符大小写漂移时全部失配（漂移源 = 链 IPC 不归一透传）。本模块提供渲染层
// 单源 normalize + sameProjectPath，六处全换。与 shell normalizeProjectKey 同规则的可移植
// 子集：`\`→`/`、消尾斜杠、含盘符（win32 绝对路径）整体小写——path.resolve 的相对段消解
//（`.`/`..`）渲染层无 node:path，两处路径均来自主进程已 resolve 的形态，非目标。
//
// CR-T1-027/030：链 IPC 的 D4 拒绝经 summary.errors 机器串（`project_run_active|heldBy=…`）
// 与 agent 层链守卫（批2 `chain_run_active|heldBy=…`）回 UI——原样 join(';') 透出机器串；
// 本模块解析 + 统一 busy toast（链租约 id 不可跳转——stub 会话不在列表，换文案无跳转钮）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 渲染层路径归一（mirror shell normalizeProjectKey 的词法子集——见文件头）。
 * UNC 路径（无盘符）不归大小写：本项目库的项目恒在 ~/Documents/OrisonSpace 下，非目标。
 */
export function normalizeProjectPathForCompare(projectPath: string): string {
  let s = projectPath.replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (/^[a-z]:/i.test(s)) s = s.toLowerCase();
  return s;
}

/**
 * 项目路径判等（归一后比较）。空值语义维持恒等：两者皆空（undefined/null）→ true
 * （「同无归属」），单边空 → false——与既有裸 === 的真值表兼容，仅升级字符串比较。
 */
export function sameProjectPath(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b) return a === b;
  return normalizeProjectPathForCompare(a) === normalizeProjectPathForCompare(b);
}

/** 链 IPC 租约 id 前缀（mirror shell agentIpc.CHAIN_RUN_LEASE_ID——UI 包不依赖 shell）。 */
export const CHAIN_LEASE_ID_PREFIX = 'chain-run:closure';

/**
 * W4（09-21-subagent-bg-decouple U6 存量债）：会话列表可列判定（客户端防御镜像——权威过滤
 * 在 shell `agent:list-sessions` handler 的 isListableSession）。消费点：
 * ① 项目自动接续 `agentSessions.find(...)` 跳过 child/stub（W3 移交项②）；
 * ② 历史列表如有直列场景的兜底。词表（child 角色 + 链 stub agentName）须与 shell 同步——
 * 新增 stub agentName 两处同步（closureChainIpc.ts :885/:1668 创建点）。
 * 本函数住 projectRunBusy（非 api/agent）的原因：api 模块被大量测试文件 vi.mock 整体替换，
 * 部分工厂缺导出 = 访问即抛（vitest mock getter 语义）；store 级纯函数与路径判等同源不受 mock。
 */
const STUB_CHAIN_AGENT_NAMES = new Set(['chapter-chain-dogfood', 'chapter-reextract']);

export function isPrimaryListableSession(
  s: { sessionRole?: 'primary' | 'child' | 'fork' | null; agentName?: string },
): boolean {
  if (s.sessionRole === 'child') return false;
  return !(s.agentName !== undefined && STUB_CHAIN_AGENT_NAMES.has(s.agentName));
}

/** 占用者是否链租约（stub 会话 id，不可跳转——CR-T1-030）。 */
export function isChainLeaseId(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return sessionId === CHAIN_LEASE_ID_PREFIX || sessionId.startsWith(`${CHAIN_LEASE_ID_PREFIX}:`);
}

/** 链 IPC busy 拒绝形态（机器串解析结果）。 */
export type ChainBusyRejection =
  /** shell D4 闸（projectActiveRuns）——另一 run 占用本项目（占用者可为链租约 id）。 */
  | { kind: 'project_run_active'; heldBySessionId: string; projectPath: string }
  /** agent 层链守卫（批2 activeChainByProject）——本项目已有写章链在跑（无跳转）。 */
  | { kind: 'chain_run_active'; heldBySessionId: string };

/**
 * 从链 IPC summary.errors 解析 busy 拒绝（CR-T1-027）。
 * - `project_run_active|heldBy=<id>|project=<path>`（closureChainIpc 两入口闸）
 * - `chain_run_active|heldBy=<id>`（agent 层 runChapterChain 链守卫，批2）
 */
export function parseChainBusyError(errors: string[] | undefined): ChainBusyRejection | undefined {
  for (const raw of errors ?? []) {
    if (typeof raw !== 'string') continue;
    if (raw.startsWith('project_run_active|')) {
      const heldBy = /^project_run_active\|heldBy=([^|]*)\|project=(.*)$/.exec(raw);
      if (heldBy) return { kind: 'project_run_active', heldBySessionId: heldBy[1], projectPath: heldBy[2] };
    } else if (raw.startsWith('chain_run_active|')) {
      const heldBy = /^chain_run_active\|heldBy=(.*)$/.exec(raw);
      if (heldBy) return { kind: 'chain_run_active', heldBySessionId: heldBy[1] };
    }
  }
  return undefined;
}

/**
 * D4 busy 统一 toast（chat 预检 / chat shell 拒绝 / 链 resume 拒绝三入口同款体验）。
 *
 * - 占用者是链租约 id（`chain-run:closure*`）→ 「写章链正在本项目运行」文案，**无跳转钮**
 *   （stub 会话不在会话列表，跳转必失败——CR-T1-030）。
 * - 普通会话 id → 「该项目另一会话正在运行」+ 一键跳转（onJump = switchAgentSession）。
 */
export function showRunBusyToast(opts: {
  heldBySessionId?: string;
  projectPath?: string;
  locale: string;
  onJump?: (sessionId: string) => void;
}): void {
  const { heldBySessionId, projectPath, locale, onJump } = opts;
  void projectPath; // 拒绝载荷的项目路径（提示文案不展开路径——会话跳转即定位）
  if (isChainLeaseId(heldBySessionId)) {
    showChainRunBusyToast(locale);
    return;
  }
  useToastStore.getState().showToast(
    translate(locale, 'agent.projectRunBusy'),
    'warning',
    6000,
    heldBySessionId && onJump
      ? {
          label: translate(locale, 'agent.projectRunJump'),
          onClick: () => { onJump(heldBySessionId); },
        }
      : undefined,
  );
}

/**
 * 「本项目已有写章链在运行」提示（两类占用者共用文案：agent 层链守卫 chain_run_active 的
 * 占用者是真实 leader 会话 id（可跳转但链在跑跳过去也只能等——无动作价值，不提供跳转）；
 * shell 链租约 id 不可跳转。故统一无跳转钮。）
 */
export function showChainRunBusyToast(locale: string): void {
  useToastStore.getState().showToast(translate(locale, 'agent.chainRunBusy'), 'warning', 6000);
}

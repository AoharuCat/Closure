// ── 权限软拒族（单源判据：桥 / 纯文本两车道共用）──
//
// agy headless（print）模式弹不出权限窗：需要授权的工具调用被**软拒**——run 继续、exit 0，
// 拒绝以三种形态出现（W0 §2 样本三形态逐字；F13 真机实证三形态均携带**主体名**）：
//   ① 流事件 `tool_info.error.message`：`permission check failed for <subject> "<target>"…`
//   ② stderr 通知：`… the "<subject>" permission that headless mode cannot prompt for …`
//   ③ `result.denied_actions[].action`：主体名本身（`mcp` / `read_file` / `ListDir`…）
//
// **主体名是分派维度**（F13 + F9 两向收口的单点）：
//   - 主体 = 'mcp' → MCP 工具预授权（桥工具族）被拒——桥侧既有 soft-denied 诊断路径；
//   - 主体 ≠ 'mcp' → **agy 内置工具**被权限检查拦下（主体是权限能力名，如 read_file /
//     ListDir——不是工具名；denied_actions 的 display_name 才是工具名）——F8 §1.1
//     三针全打空的根因即此处（旧针把 `mcp "` 写死）。
//
// **归一 + 优先级（CR-3）**：主体位先归一去装饰（`mcp(novel-writing/*)` → `mcp`——
// 不归一会把 MCP 主体误判成内置工具族）；同一 haystack 两形态俱命中时 **MCP 主体优先**
// （显式规则，不是文本位置「首次命中胜出」——同类输入下归因不得静默翻转）。两条规则都
// 只在本模块实现，两车道消费者共用（各自排序 = 漂移）。
//
// 两车道消费者共用本模块（单源纪律——两侧各自加针必然漂移）：
//   - 桥（bridgeTurn）：按主体分派 soft-denied（mcp 支，行为不变）/ builtin-tool-denied
//     （内置工具支，新分类）两类呈报；
//   - driver（isBuiltinToolAutoDeny → classifyCliError）：文本含 'mcp' 主体软拒时**绝不**
//     判成内置工具族（F9 反向——旧针 `cannot prompt for` 把 MCP 软拒通知一并卷进内置工具
//     族，用户面拿到归因错误的指引）。
//
// 证据：task 09-19-agy-toolface-fix-batch research/f8-builtin-tool-stream-signal.md
// §1.1（三针全打空）/§2.4（四形态对照表）。

/** 权限软拒主体名（'mcp' = MCP 预授权；其它 = 内置工具被拒的权限能力名）。 */
export type PermissionSoftDenySubject = string;

/**
 * 主信号针（W0 §2 样本② 逐字锚 + F13 泛化）：原针 `permission check failed for mcp "`
 * 把主体写死成 mcp——内置工具软拒（`… for read_file "…"`）在其上全打空。泛化 = 前缀保留、
 * 主体就地取名（主体即分派维度）。
 */
export const PERMISSION_SOFT_DENY_MESSAGE_PREFIX = 'permission check failed for ';

/** MCP 主体名（分派判据单源——消费者侧勿写 'mcp' 字面量）。 */
export const MCP_PERMISSION_SUBJECT = 'mcp';

/** 兜底①针（W0 §2 样本① 逐字锚 + F13 泛化）：主体位捕获（原针把 `mcp` 写死）。 */
const SOFT_DENY_STDERR_PATTERN = /the "([^"]+)" permission that headless mode cannot prompt for/;

/**
 * 主体名定界符：引号 / 空白 / 括号 / 冒号 / 斜杠（`… for <subject> "<target>"` 与
 * `… for mcp(x/y)` / `… for mcp(novel-writing/*)` 装饰形态同吃）。
 */
const SUBJECT_DELIMITER = /["\s(:\/]/;

/**
 * 主体名归一（CR-3 去装饰）：取主体位的**主名段**——stderr 引号捕获可能带装饰
 * （`mcp(novel-writing/*)` / `mcp:…` / `mcp/…`），不归一的话 `isMcpPermissionSubject`
 * 的字面等值判据会把它误认成内置工具主体（归因静默翻转）。归一不会把内置能力名变成
 * mcp（内置名不含这些装饰符；即便含，截断后仍非 'mcp'——分类不变）。
 */
function normalizeSubject(raw: string | undefined): PermissionSoftDenySubject | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const end = trimmed.search(SUBJECT_DELIMITER);
  const core = (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
  return core.length > 0 ? core : undefined;
}

/**
 * 主信号解析：`tool_info.error.message` → 主体名（归一后）。文本不含前缀 / 主体为空 →
 * undefined（undefined = 不属本族；消费者不得把「没解析出」当「内置工具」——那是过度匹配）。
 */
export function parsePermissionSoftDenyMessageSubject(
  text: string | undefined,
): PermissionSoftDenySubject | undefined {
  if (text === undefined) return undefined;
  const at = text.indexOf(PERMISSION_SOFT_DENY_MESSAGE_PREFIX);
  if (at === -1) return undefined;
  return normalizeSubject(text.slice(at + PERMISSION_SOFT_DENY_MESSAGE_PREFIX.length));
}

/** 兜底①解析：stderr 通知 chunk → 主体名（归一后；尾句不匹配 / 主体空 → undefined）。 */
export function parsePermissionSoftDenyStderrSubject(text: string): PermissionSoftDenySubject | undefined {
  return normalizeSubject(SOFT_DENY_STDERR_PATTERN.exec(text)?.[1]);
}

/**
 * 两形态任一命中即返回主体名（driver 侧 haystack = 终态 message + stderr 拼接）。
 *
 * **MCP 主体优先于内置工具主体**（CR-3 显式优先级；两车道共用本判据，不各自排序；
 * 队长裁决 2026-09-19 确认保持）：haystack 同时含两类主体时（混合 stderr / 两形态各一类）
 * 不得「文本位置首次命中胜出」——那会让归因在同类输入下静默翻转。定序理由：MCP 软拒是
 * **会话授权事实**（不烧链，出路 = 设置页补预授权，比内置族「改走桥工具族」更可行动且与
 * 桥侧 soft-denied 诊断同向）；且本批 F9 反向修复的目标正是「别再把它误报成内置工具被拒」
 * ——混合形态下必须保持该方向。
 */
export function findPermissionSoftDenySubject(text: string): PermissionSoftDenySubject | undefined {
  const messageSubject = parsePermissionSoftDenyMessageSubject(text);
  const stderrSubject = parsePermissionSoftDenyStderrSubject(text);
  if (messageSubject !== undefined && isMcpPermissionSubject(messageSubject)) return messageSubject;
  if (stderrSubject !== undefined && isMcpPermissionSubject(stderrSubject)) return stderrSubject;
  return messageSubject ?? stderrSubject;
}

/** 文本是否命中 **MCP 主体**软拒（两形态任一；driver 侧第二条合成 412 行的判据）。 */
export function hasMcpPermissionSoftDeny(text: string): boolean {
  const subject = findPermissionSoftDenySubject(text);
  return subject !== undefined && isMcpPermissionSubject(subject);
}

/** 主体是否 MCP（MCP 预授权 vs 内置工具的唯一分派判据）。 */
export function isMcpPermissionSubject(subject: PermissionSoftDenySubject): boolean {
  return subject === MCP_PERMISSION_SUBJECT;
}

import type { ToolDefinition } from '../types';

export type SessionPermissionMode = 'readonly' | 'suggest' | 'auto';
export type ToolClass = 'read' | 'write' | 'diff' | 'dangerous';

const MODE_RANK: Record<SessionPermissionMode, number> = {
  readonly: 0,
  suggest: 1,
  auto: 2,
};

const ACTIVE_SKILL_SYSTEM_TOOLS = new Set([
  'skill',
  'skill_resource_list',
  'skill_resource_read',
]);

const WRITE_TOOLS = new Set([
  'write_file',
  'chapter_write',
  'memory_update',
  'generate_image',
  'edit_image',
  'git_commit',
  // Story 3.6 WP9：策展入全局 craft KB（~/.orison/craft-kb/）——显式写入用户库的动作，
  // readonly/suggest 不可用（mirror write_file）。本 story 唯一一次动 WRITE_TOOLS。
  'save_craft_doc',
  // Story 8.7 BMad CR-002（2026-08-19）：mention 账两链内写工具显式归写类。它们无 field_patch
  // envelope（不产人审卡）且 record 是 per-episode 全量替换语义——缺省 classifyTool='read' 时
  // readonly 档 LLM 可直调，一次误调即覆写真实账 + json_set 直写章梗概。归 'write'（readonly/suggest
  // 拦，auto 放行）而非 'diff'：无 patch 人审面，suggest 放行没有审卡兜底。链内 mention-ledger-node
  // 走 registry.execute 直调不经 filterToolsForPolicy，照旧可达（调用来源判据，mirror 8.1
  // materialize_chapter_summary 注释——该工具至今未收录是遗留差异，本条只管 8.7 新面）。
  // 链流程重排 W1d：targeted-revision 降档包装退役后 degrade 的链内直调方不在——工具本体保留
  // 注册，未来消费方 = W4 re-extract-chapter / 保守化通道（同样 registry 直调形态）。
  // PermissionService（skill-VM 路径）无匹配规则 → external/ask fallback（用户可见门，非静默直通）。
  'record_episode_mentions',
  'degrade_episode_mentions',
]);

const DIFF_TOOLS = new Set([
  'rewrite_passage',
  'outline_update',
  'overview_update',
  'genre_contract_update',
  // Story 2.6：创作决策 ADR 登记（register/supersede/drop）--缺省产 field_patch envelope 走
  // PatchReview 人审（mirror genre_contract_update diff 语义）；autoApply=true（auto 档）直落
  // novel.story_decisions（复用 applyFieldPatches story_decisions 分支单写路径）。readonly 拦。
  'story_decisions_update',
  // Story 3.6 WP9：设定卡策展——产 field_patch 人审（mirror scene_graph_update 的 diff 语义：
  // suggest 可用走 PatchReview，readonly 拦）。
  'asset_cards_update',
  // Story 2.2 WP-B：长文设定文档 bounded 段落编辑——缺省产 setting_md_patch envelope 走
  // 专用词级 diff 卡人审；autoApply=true（auto 档）直落。mirror asset_cards_update 的 diff 语义。
  'setting_md_update',
  // Story 2.2 WP-E：story-sync 反哺 applier——write_chapter route 终态收尾调用（链内写工具，
  // mirror write_world_events），autoApply=true（auto 档 + accept 语义背书）直落 / 缺省产
  // field_patch envelope 组走 PatchReview。readonly 拦（mirror setting_md_update 的 diff 语义）。
  'story_sync_apply',
  // Story 8.2：弧节拍账本 bounded 编辑（add_beat）——缺省产 field_patch envelope（field arc_registry）
  // 走 PatchReview 人审（mirror story_decisions_update diff 语义）；autoApply=true（arc-emergence 节点 /
  // auto 档）直落 arc_registry creative field。readonly 拦。B01 三处同步第 2 处（shell handler +
  // UI agentDiffSlice.WRITE_TOOLS 同 commit）。
  'arc_ledger_update',
  // Story 8.5 R1/R2：角色弧生产线 + 集纲写工具三件——缺省产 field_patch envelope（field
  // growth_curve/pacing_curve/episode_outlines）走 PatchReview 人审（mirror asset_cards_update diff
  // 语义）；autoApply=true（auto 档）直落。readonly 拦。B01 三处同步第 2 处（shell toolExecution
  // register + UI agentDiffSlice.WRITE_TOOLS 同 commit）。
  'growth_curve_update',
  'pacing_curve_update',
  'episode_outlines_update',
  // emotion_curve_update：Story 5.2 工具 B01 追补（8.5 Step 5 latent finding）——5.2 落了 shell handler
  // 但三处同步全缺（builtin 注册缺失致 Director auto 档 allowedTools 被静默滤掉）。diff 语义同上：
  // 缺省产 field_patch envelope（field emotion_curve）走 PatchReview；autoApply=true 直落。readonly 拦。
  'emotion_curve_update',
  // Story 8.6：冷启动引导三写工具——creative_brief_update / creative_preferences_update 缺省产
  // field_patch envelope（field creative_brief / creative_preferences）走 PatchReview 人审（mirror
  // growth_curve_update diff 语义）；author_profile_update 缺省产**专用** author_profile_patch
  // envelope（机器级档案文件，UI 专用分流，mirror setting_md_update）——三件 autoApply=true（auto 档）
  // 直落。readonly 拦。B01 三处同步第 2 处（shell toolExecution register Step 2 已登；UI
  // agentDiffSlice.WRITE_TOOLS 归 Step 6——author_profile 走专用分流不进 WRITE_TOOLS）。
  'creative_brief_update',
  'creative_preferences_update',
  // 09-12 子4 W6 遗留②（Tier 2 桥面，design §7）：信息释放地图与承诺台账两写工具——
  // 产 field_patch envelope（field info_release_map / promise_registry）走 PatchReview 人审
  // （mirror growth_curve_update diff 语义）；autoApply=true（auto 档）直落。此前缺省 'read'
  // 让 readonly 档可直调 + autoApply 自审闸门/档位强制双不覆盖（闸只拦 diff 家族）。B01
  // 三处同步第 2 处（shell handler 既有；UI agentDiffSlice.WRITE_TOOLS 已同批补齐）。
  'info_release_map_update',
  'promise_ledger_update',
  'author_profile_update',
  // 风格卡片 MVP（task 08-28-style-card-mvp A 路）：文风分析派发工具——本体派发无工具分析子
  // agent（纯判断），返回的卡草案以专用 setting_md_patch envelope（settingId='style'）走既有
  // SettingMdPatchCard 人审（UI 按元数据 type 专用分流，mirror setting_md_update 的 diff 语义：
  // suggest 档人审卡、readonly 拦）。无 autoApply 参数——永走人审（dispatch 铁律「不 autoApply
  // 直写」），autoApply 自审闸门/档位强制对本工具天然不触发。
  'dispatch_style_analyzer',
]);

export function classifyTool(toolName: string): ToolClass {
  if (toolName === 'git_commit') return 'dangerous';
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (DIFF_TOOLS.has(toolName)) return 'diff';
  return 'read';
}

// ── CR-001（8.5 BMad CR，2026-08-18 用户拍板）：autoApply 自审闸门 ──
//
// LLM 首次发 diff 工具带 autoApply:true → 拦截不执行（无 IPC），合成闸门消息要求自审
// （重读当前数据逐条核对），带 selfReviewConfirmed:true 重发才落盘。autoApply 语义本身不变
// （重发即真落盘）；缺省/false（PatchReview 人审路径）与 readonly 拦截照旧不受影响。
//
// 🔑 seam = runLoop（loop.ts）工具执行段：LLM 发起的一切工具调用（leader / 子 agent /
// Director / skill 内 LLM 节点）都经 runLoop 派发，此处拦截即覆盖全 registry 工具；而链上
// 节点与入口层程序化写入（arc-emergence-node 调 arc_ledger_update、write_chapter 收尾调
// story_sync_apply）走 registry.get().execute 直调不经 runLoop，天然不进闸（调用来源判据）。
// 不放 shell handler——handler 无会话上下文，且程序化直调也走 handler 会误伤链上节点。

/** 闸门消息（LLM 可读，说人话：做什么、怎么做、做完怎么重发）。 */
export const AUTO_APPLY_SELF_REVIEW_MESSAGE =
  '你请求了让修改立即生效（autoApply=true）。执行前请先自审：重新读取该字段的当前数据，逐条核对你准备做的每项修改是否正确、是否会误删或遗漏既有内容。确认无误后，把这次调用原样重发一遍，并加上 selfReviewConfirmed: true，即可生效。';

/**
 * autoApply 自审闸门判定（纯函数，CR-001）。true = 拦截本次调用（runLoop 合成闸门消息，
 * 不执行不 IPC）。三个条件同时满足才拦：
 * 1. diff 类工具（DIFF_TOOLS 家族——产生 field_patch / autoApply 直落的写工具）；
 * 2. params.autoApply === true（人审 envelope 路径不拦）；
 * 3. params.selfReviewConfirmed !== true（重发自证已自审，放行）。
 */
export function shouldGateAutoApply(toolName: string, params: unknown): boolean {
  if (classifyTool(toolName) !== 'diff') return false;
  const p = (params && typeof params === 'object' ? params : {}) as {
    autoApply?: unknown;
    selfReviewConfirmed?: unknown;
  };
  return p.autoApply === true && p.selfReviewConfirmed !== true;
}

// ── CR-002（8.6 BMad CR，2026-08-18）：autoApply 档位强制 ──
//
// 闸门（CR-001）三条件只看参数不看档位——suggest/readonly 档 LLM 首发即带 autoApply:true +
// selfReviewConfirmed:true 同发可绕过人审直写（家族性缺口自 2.2，8.6 三工具放大）。档位强制：
// 有效档位（session 与 active skill 取严，mirror assertToolAllowed）非 auto 时，diff 工具
// params 的 autoApply 一律视为 false（strip 后再派发）——suggest 档恒走 patch 人审（2.2/8.5/
// 8.6 全家族受保护，by design 的决断性修复）；readonly 档 diff 工具本就被 assertToolAllowed 拦，
// 此处是 belt。auto 档不受影响（闸门 + autoApply 语义照旧）。
//
// seam = runLoop 派发段（loop.ts，与 CR-001 闸门同一拦截点）：链上节点程序化 registry.execute
// 直调不经 runLoop 天然免强制（调用来源判据，同闸门）。

/**
 * autoApply 档位强制（纯函数，CR-002）。有效档位非 auto 时把 diff 工具 params 的 autoApply
 * 改写为 false 返回；auto 档 / 非 diff 工具 / autoApply 非 true / params 非对象 → 原样返回。
 * 不 mutate 入参（浅拷贝改写）。
 */
export function enforceAutoApplyTier(
  toolName: string,
  params: unknown,
  sessionMode: SessionPermissionMode | undefined,
  activeSkillPermission?: SessionPermissionMode,
): unknown {
  const mode = stricterMode(sessionMode ?? 'suggest', activeSkillPermission);
  if (mode === 'auto') return params;
  if (classifyTool(toolName) !== 'diff') return params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const p = params as { autoApply?: unknown };
  if (p.autoApply !== true) return params;
  return { ...(params as Record<string, unknown>), autoApply: false };
}

export function filterToolsForPolicy(input: {
  tools: ToolDefinition[];
  sessionMode?: SessionPermissionMode;
  activeSkillAllowedTools?: string[];
  activeSkillPermission?: SessionPermissionMode;
}): ToolDefinition[] {
  return input.tools.filter((tool) => {
    try {
      assertToolAllowed({
        toolName: tool.id,
        sessionMode: input.sessionMode,
        activeSkillAllowedTools: input.activeSkillAllowedTools,
        activeSkillPermission: input.activeSkillPermission,
      });
      return true;
    } catch {
      return false;
    }
  });
}

export function assertToolAllowed(input: {
  toolName: string;
  sessionMode?: SessionPermissionMode;
  activeSkillAllowedTools?: string[];
  activeSkillPermission?: SessionPermissionMode;
}): void {
  const mode = stricterMode(input.sessionMode ?? 'suggest', input.activeSkillPermission);
  const allowedTools = input.activeSkillAllowedTools;
  if (
    allowedTools &&
    !allowedTools.includes(input.toolName) &&
    !ACTIVE_SKILL_SYSTEM_TOOLS.has(input.toolName)
  ) {
    throw new Error(`tool "${input.toolName}" is not allowed by active skill`);
  }

  const klass = classifyTool(input.toolName);
  if (mode === 'readonly' && (klass === 'write' || klass === 'diff' || klass === 'dangerous')) {
    throw new Error(`tool "${input.toolName}" is not allowed in readonly mode`);
  }

  if (mode === 'suggest' && klass === 'write') {
    throw new Error(`tool "${input.toolName}" requires auto mode`);
  }

  if (mode === 'suggest' && klass === 'dangerous') {
    throw new Error(`tool "${input.toolName}" requires auto mode`);
  }
}

function stricterMode(sessionMode: SessionPermissionMode, skillPermission?: SessionPermissionMode): SessionPermissionMode {
  if (!skillPermission) return sessionMode;
  return MODE_RANK[skillPermission] < MODE_RANK[sessionMode] ? skillPermission : sessionMode;
}

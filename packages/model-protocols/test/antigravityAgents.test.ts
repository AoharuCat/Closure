import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGY_BUILTIN_TOOL_REGISTRY,
  AGY_UNRESOLVABLE_TOOLS,
  AGY_GLOBAL_AGENTS_ROOT_SEGMENTS,
  BRIDGE_MCP_SERVER_NAME,
  CLOSURE_TEXT_AGENT,
  CLOSURE_BRIDGE_AGENT,
  CLOSURE_TEXT_AGENT_LAYOUT,
  CLOSURE_BRIDGE_AGENT_LAYOUT,
  KNOWN_CONTENT_MARKER_VERSIONS,
  SHARED_PERSONA_BLOCK,
  SHARED_WEBNOVEL_DISCIPLINE_BLOCK,
  renderAgentMarkdown,
  isClosureAgentFile,
  closureAgentContentHash,
} from '../src/antigravityCli/agents';

/** 渲染输出 → frontmatter 行（`---` 围栏之间；围栏形态不对直接红）。 */
function frontmatterLines(md: string): string[] {
  const lines = md.split('\n');
  expect(lines[0]).toBe('---');
  const close = lines.indexOf('---', 1);
  expect(close).toBeGreaterThan(0);
  return lines.slice(1, close);
}

describe('antigravityCli agents — 注册表名单（AC4，研究报告 §3.1 逐字锁死）', () => {
  it('AGY_BUILTIN_TOOL_REGISTRY 与研究报告 §3.1 的 44 名单逐一相等（含顺序）', () => {
    expect([...AGY_BUILTIN_TOOL_REGISTRY]).toEqual([
      'browser_move_mouse',
      'browser_press_key',
      'browser_refresh_page',
      'browser_resize_window',
      'browser_scroll',
      'browser_scroll_dom',
      'browser_select_option',
      'browser_subagent',
      'capture_browser_console_logs',
      'capture_browser_screenshot',
      'click_browser_pixel',
      'command_status',
      'define_subagent',
      'delete_knowledge',
      'execute_browser_javascript',
      'find_by_name',
      'finish',
      'generate_image',
      'grep_search',
      'invoke_subagent',
      'list_browser_pages',
      'list_dir',
      'list_permissions',
      'list_resources',
      'manage_inbox',
      'manage_subagents',
      'manage_task',
      'multi_replace_file_content',
      'notebook_edit',
      'notebook_execution',
      'open_browser_url',
      'read_browser_page',
      'read_resource',
      'read_url_content',
      'replace_file_content',
      'run_command',
      'schedule',
      'search_web',
      'sed_file',
      'send_command_input',
      'send_message',
      'view_file',
      'wait',
      'write_to_file',
    ]);
  });

  it('AGY_UNRESOLVABLE_TOOLS 与研究报告 §3.1 末的 13 禁项逐一相等（含顺序）', () => {
    expect([...AGY_UNRESOLVABLE_TOOLS]).toEqual([
      'ask_custom_permission',
      'ask_permission',
      'ask_question',
      'browser_click_element',
      'browser_drag_pixel_to_pixel',
      'browser_get_dom',
      'browser_get_network_request',
      'browser_input',
      'browser_list_network_requests',
      'browser_mouse_down',
      'browser_mouse_up',
      'call_mcp_tool',
      'wait_5_seconds',
    ]);
  });

  it('两名单互斥，合计 = 57（init.tools 广告位计数，研究报告 §2）', () => {
    expect(AGY_BUILTIN_TOOL_REGISTRY).toHaveLength(44);
    expect(AGY_UNRESOLVABLE_TOOLS).toHaveLength(13);
    const union = new Set([...AGY_BUILTIN_TOOL_REGISTRY, ...AGY_UNRESOLVABLE_TOOLS]);
    expect(union.size).toBe(57);
  });
});

describe('antigravityCli agents — 布局常量节（探针定谳后只改常量，测试不钉值）', () => {
  it('两 agent 布局互异；目录段均为安全单段（落盘路径拼装前提）', () => {
    expect(CLOSURE_TEXT_AGENT_LAYOUT.agentName).not.toBe(CLOSURE_BRIDGE_AGENT_LAYOUT.agentName);
    for (const layout of [CLOSURE_TEXT_AGENT_LAYOUT, CLOSURE_BRIDGE_AGENT_LAYOUT]) {
      expect(layout.agentName.length).toBeGreaterThan(0);
      expect(layout.dirSegments.length).toBeGreaterThan(0);
      for (const seg of layout.dirSegments) {
        expect(seg).toMatch(/^[^\\/]+$/);
        expect(seg).not.toBe('.');
        expect(seg).not.toBe('..');
      }
    }
  });

  it('agy 全局 agent 发现根（研究报告 §4 定谳：仅 ~/.gemini/config/agents/ 加载）', () => {
    expect(AGY_GLOBAL_AGENTS_ROOT_SEGMENTS).toEqual(['.gemini', 'config', 'agents']);
  });

  it('定义 name 取自布局常量（单一出口——探针定谳/扁平回退改一处即全链生效）', () => {
    expect(CLOSURE_TEXT_AGENT.name).toBe(CLOSURE_TEXT_AGENT_LAYOUT.agentName);
    expect(CLOSURE_BRIDGE_AGENT.name).toBe(CLOSURE_BRIDGE_AGENT_LAYOUT.agentName);
  });
});

describe('antigravityCli agents — frontmatter 纪律（AC12，R9：只写已验证字段）', () => {
  it('text agent：keys 恰为 name/description/inheritMcp，inheritMcp: false；name 取布局常量', () => {
    const fm = frontmatterLines(renderAgentMarkdown(CLOSURE_TEXT_AGENT));
    expect(fm.map((line) => line.slice(0, line.indexOf(':')))).toEqual([
      'name',
      'description',
      'inheritMcp',
    ]);
    expect(fm[0]).toBe(`name: ${CLOSURE_TEXT_AGENT_LAYOUT.agentName}`);
    expect(fm[2]).toBe('inheritMcp: false');
  });

  it('bridge agent：keys 恰为 name/description——无 inheritMcp（桥命脉）、无 tools（R9）', () => {
    const fm = frontmatterLines(renderAgentMarkdown(CLOSURE_BRIDGE_AGENT));
    expect(fm.map((line) => line.slice(0, line.indexOf(':')))).toEqual(['name', 'description']);
    expect(fm[0]).toBe(`name: ${CLOSURE_BRIDGE_AGENT_LAYOUT.agentName}`);
  });

  it('双 agent frontmatter 均无未验证字段 model/hidden/tools（R9 禁令）', () => {
    for (const def of [CLOSURE_TEXT_AGENT, CLOSURE_BRIDGE_AGENT]) {
      const fm = frontmatterLines(renderAgentMarkdown(def)).join('\n');
      expect(fm).not.toMatch(/^model:/m);
      expect(fm).not.toMatch(/^hidden:/m);
      expect(fm).not.toMatch(/^tools:/m);
    }
  });

  it('CR-11：text agent description 不写工具面断言（写入用户全局 agent.md 的用户可见文案）', () => {
    // 该串经 renderAgentMarkdown 落 `~/.gemini/config/agents/closure-text/agent.md` 并在
    // `agy agents` 可见。旧文案「零工具，纯文本直出」断言的工具面事实已被 F8 真机证伪
    // （不写 `tools` 收窄但**未清零**内置工具面），「收窄工具面」这类未定谳推断同样不写
    // ——「宁可不写，不写错」：只描述有实证支撑的机制（正文作为系统提示）。
    expect(CLOSURE_TEXT_AGENT.description).not.toContain('零工具');
    expect(CLOSURE_TEXT_AGENT.description).not.toContain('工具面');
    expect(CLOSURE_TEXT_AGENT.description).toContain('系统提示');
  });

  it('F16：桥 agent description 划通道分工界（写入用户全局 agent.md 的用户可见文案）', () => {
    // 该串经 renderAgentMarkdown 落 `~/.gemini/config/agents/closure-bridge/agent.md` 并在
    // `agy agents` 可见。旧文案「写作域走桥工具族，面向用户的正文纯文本直出」把线画反
    // （真机模型把「写第一章」解成「正文写在对话里」，write_chapter 零调用——dogfood
    // round4 findings F16）⇒ 断言分工表述在场、旧「正文直出」授权不在场。
    expect(CLOSURE_BRIDGE_AGENT.description).toContain('由桥工具产出写进作品');
    expect(CLOSURE_BRIDGE_AGENT.description).toContain('呈现性回复');
    expect(CLOSURE_BRIDGE_AGENT.description).not.toContain('正文纯文本直出');
  });
});

describe('antigravityCli agents — 正文共享块（字面同源）', () => {
  it('双 agent 正文均含人设块 + 网文语境纪律块（同一常量实例）', () => {
    for (const def of [CLOSURE_TEXT_AGENT, CLOSURE_BRIDGE_AGENT]) {
      expect(def.body).toContain(SHARED_PERSONA_BLOCK);
      expect(def.body).toContain(SHARED_WEBNOVEL_DISCIPLINE_BLOCK);
    }
  });

  it('text 正文块序 = 人设 → 网文纪律 → 零工具直出车道块', () => {
    const body = CLOSURE_TEXT_AGENT.body;
    expect(body.indexOf(SHARED_PERSONA_BLOCK)).toBeLessThan(
      body.indexOf(SHARED_WEBNOVEL_DISCIPLINE_BLOCK),
    );
    expect(body.indexOf(SHARED_WEBNOVEL_DISCIPLINE_BLOCK)).toBeLessThan(
      body.indexOf('你没有配置任何工具'),
    );
    expect(body).toContain('忠实执行用户消息中的写作任务');
  });

  it('桥正文含 novel-writing 工具纪律 + 通道分工 + present_result 协议常驻段（W5 上移 + F16 补正的正守卫）', () => {
    const body = CLOSURE_BRIDGE_AGENT.body;
    // 工具纪律段（自 BRIDGE_OUTPUT_DIRECTIVE 常驻段上移——R5 分工：常驻纪律归 system）。
    expect(body).toContain(`一律使用 ${BRIDGE_MCP_SERVER_NAME} 桥提供的工具族`);
    // F16 通道分工句（dogfood-round4 findings F16：旧「面向用户的最终正文直接以纯文本写出」
    // 与工具纪律互相拆台，真机 write_chapter 零调用）。两句双写在案（CR-1 用户拍板 2026-09-19）：
    // 此句与 BRIDGE_OUTPUT_DIRECTIVE 逐字同在——桥车道无行为级降级带，directive 侧保留本句
    // + 条件式降级兜底句是降级路径唯一防线，非 R5 违例；协议常驻段（present_result）仍只在 system。
    expect(body).toContain('章节正文、改稿结果这类作品内容一律由对应桥工具产出并写进作品');
    expect(body).toContain('对话回复只用于讨论、说明、方案、评审意见、回答用户提问这类呈现性回复');
    // F16 根因句禁回（旧授权：正文直出）——回潮即红。
    expect(body).not.toContain('面向用户的最终正文直接以纯文本写出');
    // 推进表述（F16 同层）：提交待审 ≠ 已生效（真机 leader 把「已挂成待补丁」说成「已推至大纲面」）。
    expect(body).toContain('已提交、待作者确认');
    // present_result 协议常驻段（与 BRIDGE_SENDBACK_MESSAGE / loop.ts 打回文案同义基线
    // ——协议措辞家族第三站点，改文案三处同步）。
    expect(body).toContain('present_result');
    expect(body).toContain('awaiting_intent_confirmation');
    // 块序：人设 → 网文纪律 → 桥车道块。
    expect(body.indexOf(SHARED_PERSONA_BLOCK)).toBeLessThan(
      body.indexOf(SHARED_WEBNOVEL_DISCIPLINE_BLOCK),
    );
    expect(body.indexOf(SHARED_WEBNOVEL_DISCIPLINE_BLOCK)).toBeLessThan(
      body.indexOf(`一律使用 ${BRIDGE_MCP_SERVER_NAME} 桥提供的工具族`),
    );
    // frontmatter 禁项不受 v2 影响：正文点名 server 与工具是纪律文本，frontmatter 仍
    // 无 inheritMcp / 无 tools（keys 断言在 frontmatter 纪律组钉死）。
  });
});

describe('antigravityCli agents — 渲染 + 尾标记（自有认定 + 版本检测单源）', () => {
  it('渲染稳定：两次输出逐字节一致；尾标记 = 12 位 hex 且 hash 覆盖 frontmatter+正文', () => {
    const a = renderAgentMarkdown(CLOSURE_TEXT_AGENT);
    expect(a).toBe(renderAgentMarkdown(CLOSURE_TEXT_AGENT));
    const m = /<!-- closure-agent-content-v1:([0-9a-f]{12}) -->\n$/.exec(a);
    expect(m).not.toBeNull();
    // hash 覆盖面 = 去尾标记行后的全部内容（core 文档）
    const core = a.slice(0, a.lastIndexOf('<!--'));
    expect(m![1]).toBe(createHash('sha256').update(core, 'utf8').digest('hex').slice(0, 12));
  });

  it('内容变更 → hash 变（陈旧检测的生成侧前提）', () => {
    const base = closureAgentContentHash(renderAgentMarkdown(CLOSURE_TEXT_AGENT));
    const bodyChanged = closureAgentContentHash(
      renderAgentMarkdown({ ...CLOSURE_TEXT_AGENT, body: `${CLOSURE_TEXT_AGENT.body}\n追加一段。` }),
    );
    const fmChanged = closureAgentContentHash(
      renderAgentMarkdown({ ...CLOSURE_TEXT_AGENT, description: '换一个描述。' }),
    );
    expect(bodyChanged).not.toBe(base);
    expect(fmChanged).not.toBe(base);
  });

  it('自有认定：渲染输出认定自有；外来文本/形态不符标记 → false + undefined', () => {
    const md = renderAgentMarkdown(CLOSURE_TEXT_AGENT);
    expect(isClosureAgentFile(md)).toBe(true);
    expect(closureAgentContentHash(md)).toMatch(/^[0-9a-f]{12}$/);

    const foreign = '# my own agent\n自定义内容，无标记。\n';
    expect(isClosureAgentFile(foreign)).toBe(false);
    expect(closureAgentContentHash(foreign)).toBeUndefined();

    // 形态不对的尾注释（hash 非.hex12）不认定
    expect(
      isClosureAgentFile('---\nname: x\n---\nbody\n<!-- closure-agent-content-v1:zz -->\n'),
    ).toBe(false);
  });

  it('认定容差：容文件尾空行；标记后另有内容 = 保守不认定', () => {
    const md = renderAgentMarkdown(CLOSURE_BRIDGE_AGENT);
    expect(isClosureAgentFile(`${md}\n\n`)).toBe(true);
    expect(isClosureAgentFile(`${md}appended\n`)).toBe(false);
  });

  it('CR-7 fail-fast：frontmatter 标量含换行（\\n / \\r\\n）→ 渲染期 throw（不产坏 YAML 产物）', () => {
    expect(() =>
      renderAgentMarkdown({ ...CLOSURE_TEXT_AGENT, description: '第一行\n第二行' }),
    ).toThrow(/single-line/);
    expect(() =>
      renderAgentMarkdown({ ...CLOSURE_TEXT_AGENT, name: 'a\r\nb' }),
    ).toThrow(/single-line/);
    // 正文换行合法（body 非 frontmatter 标量）——渲染照常成功。
    expect(() =>
      renderAgentMarkdown({ ...CLOSURE_TEXT_AGENT, body: `${CLOSURE_TEXT_AGENT.body}\n多一段。` }),
    ).not.toThrow();
  });
});

describe('antigravityCli agents — 尾标记版本前向兼容（CR-13）', () => {
  it('KNOWN_CONTENT_MARKER_VERSIONS 现 = [v1]（版本谱系登记；升级 bump 时追加旧版本）', () => {
    expect([...KNOWN_CONTENT_MARKER_VERSIONS]).toEqual(['v1']);
  });

  it('泛化认定：模拟未来 v2 标记文件（形态完好）→ 判自有 + hash 可提取（shell 四态据此落 stale 重写自愈，不落 foreign 冲突）', () => {
    const v2File = '---\nname: x\n---\n正文\n<!-- closure-agent-content-v2:0123456789ab -->\n';
    expect(isClosureAgentFile(v2File)).toBe(true);
    expect(closureAgentContentHash(v2File)).toBe('0123456789ab');
    // v2 hash ≠ 当前渲染 hash → 陈旧（重写自愈路径），非外来（冲突不覆盖 = 自愈断链）。
    expect(closureAgentContentHash(v2File)).not.toBe(
      closureAgentContentHash(renderAgentMarkdown(CLOSURE_TEXT_AGENT)),
    );
  });

  it('未知格式仍 foreign：坏 hash 形态 / 缺版本号形态不认定（保守纪律不受泛化影响）', () => {
    expect(
      isClosureAgentFile('---\nname: x\n---\nbody\n<!-- closure-agent-content-v1:zz -->\n'),
    ).toBe(false);
    expect(
      isClosureAgentFile('---\nname: x\n---\nbody\n<!-- closure-agent-content-v:0123456789ab -->\n'),
    ).toBe(false);
  });
});

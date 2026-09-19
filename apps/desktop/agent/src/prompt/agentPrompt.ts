import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { logger } from '../logger';

// ── Story 4.0 写章战术链段：LLM 节点的 yaml 契约加载（design §4.2 / implement.md 2.1）──
//
// verify-point 2.0 resolved（controller 2026-07-31 读 agentDefinitions.ts）：OrisonSpace 的
// `loadAgentDefinition` 读 `.md`（`.orison/agents/<role>.md` / `.claude/agents/` / extraRoots），
// **不读 `prompts/*.yaml`**。runSubagent/runChildAgent 取的是 `.md` systemPrompt（无则 fallback
// `DEFAULT_CLOSURE_PROMPT`），与 `prompts/*.yaml` 的 `system:` 段是两套。故 LLM 节点不能复用
// runSubagent 取 system——须自行 load yaml（ADR-4 单契约源：system + user 都从 yaml）。
//
// 本模块 = 「读 prompts/<role>.yaml + 解析出 {system, userTemplate}」的纯函数 + FS 读。
// mirror craftMd（`shell/main/db/craftMd.ts`）的防御技术：BOM-strip + js-yaml。prompts/*.yaml 是
// 纯 yaml 文档（顶层 `system: |` + `user: |`，无 `---` frontmatter fence）——与 craftMd 的 frontmatter+body
// 结构不同，故这里整篇 yaml.load（不抽 fence）。「无 frontmatter」= prompts 的常态。
//
// prompts 目录路径 resolve：agent 包 ESM（`"type": "module"`），mirror persistence.ts:21 的
// `import.meta.url` 模式。`agentPrompt.ts` 位于 `src/prompt/`，prompts 位于 `src/../prompts/`
// （即 `apps/desktop/agent/prompts/`）。dev（tsx）+ vitest 下 `import.meta.url` 指向源文件 → 解析正确。
// ⚠️ 生产打包（electron-vite 把 agent 打包进 shell `dist/main/index.cjs`）下 `import.meta.url` 指向
// bundle，此相对路径会失配——Step 5/6 接通 runChapterChain 时由 wiring 层处理（注入 prompts 基址或
// 配 electron-vite 拷贝 prompts 为静态资源）。Step 2 只建工厂 + 单测，dev/test 路径解析够用。
//
// expected_downstream_consumers:
// - Story 4.0 Step 2：createLlmNode.run() = loadAgentPrompt(role) → renderTemplate(userTemplate, vars)
//   → generate([user], system, [], abort, {modelRef})。
// - Story 4.0 Step 3：draft-writer / multi-review / route（+ 当时的 targeted-revision，09-13 W1d 退役）
//   节点实例化；链流程重排后另经 brief-reviewer-node / revision-optimizer-node 工厂消费（loadAgentPrompt
//   'brief-reviewer-agent' / 'revision-optimizer-agent'）。

const BOM_CHAR_CODE = 0xfeff;

export interface AgentPrompt {
  /** yaml `system:` 段——LLM 的 system prompt（ADR-4 单契约源，非 Orison 默认 systemPrompt）。 */
  system: string;
  /** yaml `user:` 段原文（含 `{{var}}` 占位）——交 renderTemplate 渲染后再喂 generate。 */
  userTemplate: string;
}

/**
 * 解析 prompts yaml 文本为 {system, userTemplate}。纯函数（无 fs）——可 plain vitest 单测。
 *
 * 防御（mirror craftMd「degrade, don't drop」）：
 * - BOM（U+FEFF）剥离——Windows 编辑器（Notepad）常带，不剥则 js-yaml 把 BOM 当首 key 的一部分。
 * - malformed yaml → warn + 返回 `{system:'', userTemplate:''}`（不抛——让 generate 收到空 system 产
 *   弱输出 → parseOutput 失败 → createLlmNode 重试/兜底 error artifact，链段不崩）。
 * - system/user 缺失或非 string → 该字段空串（prompts 约定两段都有；缺则降级）。
 */
export function parseAgentPromptYaml(content: string): AgentPrompt {
  const bomStripped = content.charCodeAt(0) === BOM_CHAR_CODE ? content.slice(1) : content;
  let parsed: unknown = null;
  try {
    parsed = yaml.load(bomStripped);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'parseAgentPromptYaml: malformed yaml → degrade to empty');
    return { system: '', userTemplate: '' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { system: '', userTemplate: '' };
  }
  const obj = parsed as Record<string, unknown>;
  const system = typeof obj.system === 'string' ? obj.system : '';
  const userTemplate = typeof obj.user === 'string' ? obj.user : '';
  return { system, userTemplate };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

// dogfood #48（2026-08-21 实录）：electron-vite 把 agent 打进 shell `dist/main/index.cjs`
// （shell electron.vite.config bundledWorkspaceDeps 刻意内联），`import.meta.url` 指向
// bundle → 默认 heuristic 解析到 `shell/prompts`（不存在）→ loadAgentPrompt 全部
// degrade to empty → researcher 子 agent 只拿到裸角色头、五段 brief 全丢（用户三次派发
// 实录 + dev 日志 ENOENT 三连）。修 = wiring 层注入真实基址（本文件头注释预警的
// 「Step 5/6 由 wiring 层处理」在此补上）：shell 启动时探测 dev 仓库布局 / 打包
// resources 后 setPromptsBaseDir。未注入时保留 heuristic（vitest 与 agent 包 dist
// 直跑两条路径本就正确）。
let promptsBaseDir: string | null = null;

/**
 * Wiring seam：注入 prompts 根目录（绝对路径，内含 `<role>.yaml`）。切换基址时清空
 * promptCache（旧基址内容作废）。shell main 启动时调用（见 shell/main/index.ts wiring）。
 */
export function setPromptsBaseDir(dir: string): void {
  promptsBaseDir = dir;
  promptCache.clear();
}

function resolvePromptsDir(): string {
  return promptsBaseDir ?? DEFAULT_PROMPTS_DIR;
}

/**
 * 模块级 prompt cache（CR-9a）：prompts/*.yaml 是静态资源（进程内不变），每节点 run 读 FS 浪费。
 * loadAgentPrompt 首次读 + parse + cache，后续命中。dogfood 跑一章链段调 4-6 次 generate → 节省 4-6 次 FS 读。
 * yaml 永不变（除非热重载，4.0 无）→ 无失效策略（进程生命周期内可信）。
 */
const promptCache = new Map<string, AgentPrompt>();

/**
 * 读 `prompts/<role>.yaml` 并解析为 {system, userTemplate}（CR-9a：首次读后 cache）。
 *
 * 文件缺失/读失败 → warn + 返回空（不抛——同 malformed 策略：链段降级而非崩）。注意：空结果**不 cache**
 * （文件可能后续被创建/修复，如下次读命中真实文件）。
 */
export async function loadAgentPrompt(role: string): Promise<AgentPrompt> {
  const cached = promptCache.get(role);
  if (cached) return cached;

  const filePath = path.join(resolvePromptsDir(), `${role}.yaml`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = parseAgentPromptYaml(raw);
    promptCache.set(role, parsed);
    return parsed;
  } catch (err) {
    logger.warn({ role, err: err instanceof Error ? err.message : String(err) }, 'loadAgentPrompt: failed to read prompt file → degrade to empty');
    return { system: '', userTemplate: '' };
  }
}

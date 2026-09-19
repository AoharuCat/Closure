import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import type { AgyTextAgentFileState, AgyTextAgentStatusView } from '@orison/shared-contracts';
import {
  AGY_GLOBAL_AGENTS_ROOT_SEGMENTS,
  CLOSURE_BRIDGE_AGENT_LAYOUT,
  CLOSURE_TEXT_AGENT,
  CLOSURE_TEXT_AGENT_LAYOUT,
  closureAgentContentHash,
  isClosureAgentFile,
  renderAgentMarkdown,
} from '@orison/model-protocols';
import { getLogger } from '../logger';

// ── Closure 文本 Agent α 生命周期（09-19 CLI 白名单 W3，design §1.2）──
//
// 纯文本车道零工具 agent 的同意存储 + 真实全局文件生命周期原语。与 agyBridgeConsent
// 同形态 mirror（bridge 只读不改——桥同意独立红线），语义独立：本模块写**用户真实全局**
// `~/.gemini/config/agents/<布局>/agent.md` 一个文件（α 拍板的固有成本），桥零全局写入。
//
// 🔑 默认开启（opt-out，用户拍板 2026-09-19）：store 仅记显式 declined——无记录 = 默认
// 开启；版本同步 = 启动对账（reconcileTextAgentAtStartup，每次应用启动 missing/stale →
// 写最新）；自有认定 + 版本检测单源 = 内容尾标记（W1 renderAgentMarkdown，协议层）。
//
// fs 纪律（implement.md 红线）：只写/只删本布局一个 agent.md；写前 foreign 检测（无
// Closure 尾标记 = 外来文件，绝不覆盖）；删前验自有标记（外来绝不误删）；目录拼接一律
// 经 AGY_GLOBAL_AGENTS_ROOT_SEGMENTS + CLOSURE_TEXT_AGENT_LAYOUT.dirSegments（禁字面量
// 散落）。全部原语路径注入（默认真实 home，测试传 temp 根）——纯逻辑可测，零真实
// ~/.gemini 触碰。
//
// CR 硬化批（09-19 三层 CR）：CR-2 遮蔽检测泛化（text/bridge 双名 + symlink 目录跟进 +
// 大小帽；桥车道假宿检测复用本模块 detectAgentNameShadowing）；CR-5 坏 consent 文件
// 类型化 corrupt 视同 declined（+ warn 一次）；CR-6 写入 'wx' 独占创建（TOCTOU）；CR-7
// 渲染/hash 进程级 memo + agent.md 大小帽（>1MB 不读即判 foreign）。

// ── 同意存储（自包含状态文件；mirror createAgyBridgeConsentStore 形态）──

export interface AgyTextAgentConsentFile {
  version: 1;
  /** 仅记显式关闭——'allowed' 不存在（无记录 = 默认开启，prd R4）。 */
  consent?: 'declined';
  updatedAt?: string;
}

/**
 * read 三态：'declined' = 显式关闭；undefined = 无记录（默认开启，含合法清空形态
 * `{version:1}`）；'corrupt' = 坏状态文件（CR-5——解析失败/非对象/未知 consent 值）。
 * corrupt 由消费方经 textAgentConsentEnabled **视同 declined**（宁少写不误写全局）。
 */
export type AgyTextAgentConsentRead = 'declined' | 'corrupt' | undefined;

/** 开关判定单源：undefined（无记录）= 开启；declined 与 corrupt（视同 declined）= 关闭。 */
export function textAgentConsentEnabled(read: AgyTextAgentConsentRead): boolean {
  return read === undefined;
}

export interface AgyTextAgentConsentStore {
  read(): AgyTextAgentConsentRead;
  markDeclined(): void;
  clearDeclined(): void;
  filePath(): string;
}

// CR-5：损坏 warn 进程级一次（模块级旗——长会话多次 status 轮询/resolver 门不刷屏）。
let corruptWarned = false;

/** 测试缝：复位损坏 warn 单次旗（module-level state 不得跨测试泄漏）。 */
export function __resetTextAgentConsentCorruptWarnForTest(): void {
  corruptWarned = false;
}

function warnConsentCorruptOnce(file: string): void {
  if (corruptWarned) return;
  corruptWarned = true;
  // 中文主文案（用户可读日志面）：损坏 → 关闭态（绝不误写真实全局），设置页重开自愈。
  getLogger().warn(
    { component: 'agy-text-agent', file },
    '同意状态文件损坏，按关闭处理（宁少写不误写全局，不写真实全局文件）——可在设置页重新开启自愈',
  );
}

export function defaultTextAgentConsentFilePath(home: string = os.homedir()): string {
  return path.join(home, '.orison', 'agy-text-agent', 'consent.json');
}

export function createAgyTextAgentConsentStore(
  opts: { filePath?: string; now?: () => Date } = {},
): AgyTextAgentConsentStore {
  const file = opts.filePath ?? defaultTextAgentConsentFilePath();
  const now = opts.now ?? (() => new Date());
  const write = (next: AgyTextAgentConsentFile): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  };
  return {
    read() {
      if (!existsSync(file)) return undefined;
      let value: AgyTextAgentConsentRead;
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const isRecord = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        if (!isRecord) {
          value = 'corrupt'; // 非 JSON 对象——形态不可信
        } else {
          const consent = (parsed as { consent?: unknown }).consent;
          // 合法形态仅两种：consent 缺席（clearDeclined 写入的 `{version:1}` = 默认开启）
          // 与 consent === 'declined'。其余值（'hacked'/错型）= 损坏，不赌。
          value = consent === undefined ? undefined : consent === 'declined' ? 'declined' : 'corrupt';
        }
      } catch {
        value = 'corrupt'; // 坏 JSON——CR-5：不再静默当「默认开启」，宁少写不误写全局
      }
      if (value === 'corrupt') warnConsentCorruptOnce(file);
      return value;
    },
    markDeclined() {
      write({ version: 1, consent: 'declined', updatedAt: now().toISOString() });
    },
    clearDeclined() {
      write({ version: 1 });
    },
    filePath: () => file,
  };
}

let productionTextAgentConsentStore: AgyTextAgentConsentStore | undefined;

/** 生产同意存储（懒建；mirror agyBridge getProductionAgyBridgeConsentStore 先例）。 */
export function getProductionAgyTextAgentConsentStore(): AgyTextAgentConsentStore {
  if (productionTextAgentConsentStore === undefined) {
    productionTextAgentConsentStore = createAgyTextAgentConsentStore();
  }
  return productionTextAgentConsentStore;
}

// ── 真实全局文件生命周期原语（路径注入；布局拼接经布局常量，禁硬编码）──

/** 我方 agent.md 绝对路径：`<realHome>/.gemini/config/agents/<布局段>/agent.md`。 */
export function textAgentFilePath(realHome: string): string {
  return path.join(realHome, ...AGY_GLOBAL_AGENTS_ROOT_SEGMENTS, ...CLOSURE_TEXT_AGENT_LAYOUT.dirSegments, 'agent.md');
}

// CR-7（shell 热路径）：agent.md 大小帽——本 task 生成的文件约 1KB，>1MB 的「agent.md」
// 不可能是 Closure 产物；同步 readFileSync 直读巨物会卡主进程 → 不读即分类（file state
// 判 foreign 保守 / 遮蔽扫描跳过）。
const MAX_AGENT_MD_BYTES = 1024 * 1024;

let cachedTextAgentMarkdown: string | undefined;

/**
 * 生产文本 agent.md 全文（CR-7 进程级 memo）：内容 = 协议层常量单源（进程内不变）——
 * sha256 + 渲染只算一次，resolver 每 spawn / 状态读 / 对账 / enable 不再重复重算。
 */
export function textAgentMarkdownCached(): string {
  if (cachedTextAgentMarkdown === undefined) {
    cachedTextAgentMarkdown = renderAgentMarkdown(CLOSURE_TEXT_AGENT);
  }
  return cachedTextAgentMarkdown;
}

/**
 * 文件四态（design §1.2）：current（Closure 尾标记 + hash 与当前生成器输出一致）/
 * stale（有标记但 hash 失配——上一版本，启动对账即修）/ foreign（存在但无标记——外来
 * 文件，绝不覆盖/误删）/ missing。读失败视作 missing（resolver/对账降级方向——宁走
 * γ 兜底不赌不可读文件）。
 */
export function resolveTextAgentFileState(input: {
  realHome: string;
  expectedMarkdown: string;
}): AgyTextAgentFileState {
  const file = textAgentFilePath(input.realHome);
  if (!existsSync(file)) return 'missing';
  // CR-7 大小帽：>1MB 绝不可能是本 task 产物——不读即判 foreign（保守：不覆盖/不误删），
  // 巨型文件零同步读面。
  try {
    if (statSync(file).size > MAX_AGENT_MD_BYTES) return 'foreign';
  } catch {
    return 'missing'; // stat 不可达 ≈ 读不可达——mirror 读失败降级方向（宁走 γ 兜底）
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 'missing';
  }
  if (!isClosureAgentFile(text)) return 'foreign';
  // 陈旧判定 = 标记 hash ≠ 当前 renderAgentMarkdown 输出的 hash（W1 内容版本身份比对）。
  return closureAgentContentHash(text) === closureAgentContentHash(input.expectedMarkdown)
    ? 'current'
    : 'stale';
}

export type TextAgentWriteResult =
  | { ok: true }
  | { ok: false; error: 'foreign-conflict' | 'operation-failed'; message?: string };

/**
 * 写入/更新我方 agent.md（CR-6 TOCTOU 硬化）：主体走 `flag:'wx'` 独占创建——预检与写入
 * 之间路径上若出现文件（哪怕 foreign 抢注），'wx' 即失败回到**重读重分类**，绝不经原子
 * 写的 rename 通道静默顶替。EEXIST 重分类：外来 → foreign-conflict 拒写如实；我方
 *（current/stale）→ 允许覆写走原子写通道（版本更新语义，design §4）。目录不存在即建
 *（recursive mkdir）。
 */
export function writeTextAgentFile(input: { realHome: string; markdown: string }): TextAgentWriteResult {
  const file = textAgentFilePath(input.realHome);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, input.markdown, { encoding: 'utf8', flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // EEXIST → 读盘上此刻真相重分类：无 Closure 尾标记 = 外来，拒写（绝不覆盖）。
      if (!isClosureAgentFile(readFileSync(file, 'utf8'))) {
        return { ok: false, error: 'foreign-conflict' };
      }
    }
    // 我方文件（current/stale）→ 覆写更新（原子写）。
    atomicWriteFileSync(file, input.markdown, 'utf8');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: 'operation-failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 删除自有 agent 文件（卡片关闭动作）：读文件验 Closure 尾标记后才删——外来文件/缺失
 * 绝不动（返回 false）。IO 错误上抛调用方（IPC catch → operation-failed 如实呈报）。
 * 只删 agent.md 一个文件，不递归清目录（最小写入面红线——空目录无害）。
 *
 * CR-6 读-删窗口固化：readFileSync（验标记）与 rmSync 之间存在亚秒级窗口，窗口内文件
 * 被外部替换成外来内容的形态在「删除」动作下威胁有限——unlink 前已验标记，被误删的
 * 至多是「标记验证时仍为我方」的文件；且本删除只发生在用户显式关闭（文件本就该消失）。
 * 威胁模型评估后接受残余窗口，不引入锁文件/重读二验（复杂度 > 收益）。
 */
export function removeTextAgentFileIfOurs(realHome: string): boolean {
  const file = textAgentFilePath(realHome);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (!isClosureAgentFile(text)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * 启动对账（prd R4，每次应用启动）：enabled 且 missing/stale → 写/重写最新 + 日志行
 *（注入/更新各一行——运行阶段可见性）；current → 版本一致一行；foreign → 不动 +
 * 呈报一行；disabled（declined 或无 agy CLI key）→ 不写不刷屏。返回对账后的文件态
 *（写失败保持原态——调用方 best-effort，γ 兜底恒在）。name 遮蔽（detectTextAgentNameShadowing）
 * **不阻断**本对账——我方文件照常维护，警示由状态面呈现。
 */
export function reconcileTextAgentAtStartup(input: {
  realHome: string;
  markdown: string;
  enabled: boolean;
  log: (message: string) => void;
}): AgyTextAgentFileState {
  const file = textAgentFilePath(input.realHome);
  const state = resolveTextAgentFileState({ realHome: input.realHome, expectedMarkdown: input.markdown });
  if (!input.enabled) return state;
  switch (state) {
    case 'current':
      input.log(`文本 Agent 版本一致：${file}`);
      return state;
    case 'foreign':
      // 外来文件压住我方路径 → 不动（绝不覆盖），状态供卡片呈报（宁误报不漏报语义，
      // mirror 桥 conflict）。
      input.log(`检测到外来同名 agent 文件，已跳过注入：${file}`);
      return state;
    case 'missing': {
      const written = writeTextAgentFile({ realHome: input.realHome, markdown: input.markdown });
      if (written.ok) {
        input.log(`文本 Agent 已注入：${file}`);
        return 'current';
      }
      input.log(
        `文本 Agent 注入失败（${written.error}${written.message !== undefined ? `：${written.message}` : ''}）——纯文本车道暂走无 agent 兜底，下次启动重试`,
      );
      return state;
    }
    case 'stale': {
      const written = writeTextAgentFile({ realHome: input.realHome, markdown: input.markdown });
      if (written.ok) {
        input.log(`文本 Agent 已更新至当前版本：${file}`);
        return 'current';
      }
      input.log(
        `文本 Agent 更新失败（${written.error}${written.message !== undefined ? `：${written.message}` : ''}）——纯文本车道暂走无 agent 兜底，下次启动重试`,
      );
      return state;
    }
  }
}

// ── frontmatter name 遮蔽扫描（装机探针定谳③）──

/**
 * frontmatter `name` 容错小解析器：首个 `---` 围栏内 `^name:\s*(.+)$` 行（剥围引号）。
 * 无围栏/无 name/坏形态 → undefined（调用方跳过，不炸）。
 */
export function parseAgentFrontmatterName(text: string): string | undefined {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return undefined;
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m === null) continue;
    let value = m[1];
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/**
 * 同 frontmatter `name` 遮蔽检测（agy 对同名零警告静默竞速——路径级 foreign 检测罩不
 * 住此形态）：对 `<home>/.gemini/config/agents/`（AGY_GLOBAL_AGENTS_ROOT_SEGMENTS 拼接）
 * **一层**扫描（嵌套 1.2.2 不发现，无更深扫描面），解析各文件 frontmatter `name`（容错
 * ——坏 frontmatter 跳过），凡 name 命中 `names` 任一值且路径非我方 → 记为遮蔽。宁误报
 * 不漏报（mirror 桥 conflict 语义）——呈报不代删，且不阻断我方文件维护。
 *
 * CR-2 泛化（text/bridge 双名共用 + 消费方按需传名）：
 * - 目录判定含 **symlink 跟进**（readdir dirent 对符号链接 isDirectory()=false——
 *   statSync 跟进定谳；断链跳过）——防「软链目录装同名 agent」漏检；
 * - 我方两个布局规范路径（text/bridge）恒排除——检测先于本方写入时（桥假宿）、或同名额
 *   上挂的是本方文件时，self 不算撞名；
 * - >1MB 文件跳过（CR-7 大小帽——遮蔽扫描同面，防巨型文件同步读卡主进程）。
 */
export function detectAgentNameShadowing(home: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const agentsRoot = path.join(home, ...AGY_GLOBAL_AGENTS_ROOT_SEGMENTS);
  if (!existsSync(agentsRoot)) return [];
  const ownFiles = new Set([
    textAgentFilePath(home),
    path.join(home, ...AGY_GLOBAL_AGENTS_ROOT_SEGMENTS, ...CLOSURE_BRIDGE_AGENT_LAYOUT.dirSegments, 'agent.md'),
  ]);
  let entries: Dirent[];
  try {
    entries = readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const shadowing: string[] = [];
  for (const entry of entries) {
    const dir = path.join(agentsRoot, entry.name);
    if (!isDirectoryLike(entry, dir)) continue;
    const file = path.join(dir, 'agent.md');
    if (ownFiles.has(file) || !existsSync(file)) continue;
    try {
      if (statSync(file).size > MAX_AGENT_MD_BYTES) continue; // 大小帽——不读巨物
      const name = parseAgentFrontmatterName(readFileSync(file, 'utf8'));
      if (name !== undefined && names.includes(name)) {
        shadowing.push(file);
      }
    } catch {
      continue; // 读/stat 失败跳过——不可判 ≠ 判遮蔽（不扩误报面）
    }
  }
  return shadowing;
}

/** readdir dirent 的目录判定（CR-2）：真目录直认；符号链接 statSync 跟进定谳；断链否。 */
function isDirectoryLike(entry: Dirent, fullPath: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

/** 纯文本车道遮蔽检测（状态面入口；text 名单单参薄封装——CR-2 泛化前原语义）。 */
export function detectTextAgentNameShadowing(realHome: string): string[] {
  return detectAgentNameShadowing(realHome, [CLOSURE_TEXT_AGENT_LAYOUT.agentName]);
}

// ── 状态读面（IPC 形状单源 = shared-contracts AgyTextAgentStatusView）──

/** 组装状态视图（每次现读——文件被手删/外来覆盖/降级翻转即时反映，不信缓存）。 */
export function buildTextAgentStatusView(input: {
  declined: boolean;
  cliKeyPresent: boolean;
  realHome: string;
  consentFilePath: string;
}): AgyTextAgentStatusView {
  return {
    enabled: !input.declined,
    cliKeyPresent: input.cliKeyPresent,
    fileState: resolveTextAgentFileState({
      realHome: input.realHome,
      expectedMarkdown: textAgentMarkdownCached(),
    }),
    shadowedBy: detectTextAgentNameShadowing(input.realHome),
    agentFilePath: textAgentFilePath(input.realHome),
    consentFilePath: input.consentFilePath,
  };
}

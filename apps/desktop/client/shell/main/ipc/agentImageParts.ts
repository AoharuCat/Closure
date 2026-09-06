/**
 * Agent 对话图片附件的 generate 缝统一处理（task 09-01 B3 / dogfood #45，design §2.3）。
 *
 * agent 侧 messagesToPayload 把带图 user 消息组为**指针 parts**（`{type:'image',
 * image:{path, b64hash, projectPath?}}`，path=项目相对路径——agent 是纯编排层零 FS
 * （ADR-2），线上指针非 b64；projectPath = CR-001b 决议 b 的可选精确项目根）。本模块是
 * 指针的 shell 侧半边：handleGenerateText / handleGenerateTextStream 在 resolveModel
 * 之后第一件事调 {@link resolveImageParts}，对每枚指针 part：
 *
 *   1. **读盘**（CR-001b）：指针带 `projectPath` → **精确项目根**解析（buildProjectPath +
 *      assertWithinProject，不扫注册库；**精确指针失效即失效**——项目不存在/文件缺失直接
 *      降级，不回退扫描）；缺席 → 机器项目注册库候选根扫描（generate 载荷不携带项目
 *      身份），优先 b64hash（落盘字节 sha256）命中（跨项目同名消歧 + 陈旧指针检测），
 *      无命中回退唯一/首个存在匹配（warn 可查）。
 *   2. **`prepareVisionImage` 归一**（5MB 闸 / 长边 1568 / magic-byte mime 校正，
 *      never-throws——visionAnalysis 既有内核，不复制逻辑）。🔑 复查 M1：归一在直传与
 *      转述**两路共用**——渲染层 10MB 进件闸与 Anthropic 每图 5MB 硬限之间有 5-10MB
 *      窗口，跳过归一的大图直传必 400。
 *   3. `resolvedModel.vision === true`（B1 registry 派生标记）→ part 改写为 b64 形态
 *      `{type:'image', image:{b64Json, mimeType}}`（协议层 OpenAI/Anthropic 双格式已通）。
 *   4. 否则 **visionModel sidecar 串行转述**（API 并发纪律）：miss 时 mirror
 *      runVisionAnalysis 三层派发形态——未配 visionModel → 降级文本（**绝不盲试主文本
 *      模型**——中转站静默剥图 = 幻觉红线）；成功 → part 替换为 `[图片转述] …` 文本。
 *   5. **归一缓存（CR-019，R2.5/D-E）**：key = sha256(归一后字节) → `{b64, mimeType,
 *      transcription?}`（直传/转述两路同条目共享，模型切换互复用）；另有指针身份
 *      （relPath|b64hash）→ 归一哈希的二级映射——历史每轮全量重放**零读盘/零哈希/零归一**。
 *      进程内存级，盘缓存 Deferred。旧「纯 string 转述文本」值形态随 CR-019 整体替换——
 *      缓存无持久化，不存在跨版本旧值，零迁移。
 *   6. **CR-007**：调用方 AbortSignal 贯穿转述 generateText（停止钮对转述生效），转述
 *      调用独立包 600s 硬上限（{@link IMAGE_RELAY_CEILING_MS}——挂死端点有界失败）。
 *   7. **CR-003a**：转述车道每图开始/完成各广播一次 `image-relay-progress`
 *      `{current, total}`（agentIpc 注入全窗 webContents.send；直传路/缓存全命中不发）。
 *
 * NEVER throws：任何单图失败降级为占位文本 part，消息继续流（B 波 fail-friendly 契约）。
 * 无图快径：messages 引用原样返回，调用方零重打包（既有载荷逐字节不变）。
 *
 * 依赖注入（防环，depcruise no-circular）：本模块被 modelGatewayIpc 静态引入，而
 * visionAnalysis（prepareImage）、modelGatewayIpc（resolveModelRef）、configIpc
 * （readModelConfig——configIpc→db indexers→modelGatewayIpc 亦成环）都在环上，故三者
 * 全部经 {@link installAgentImagePartsCore} 由 agentIpc 注册期装配（mirror setGenerateTextFn
 * 注入形态）。其余依赖（model-protocols / projectIpcHelpers）为叶子，静态引入。读盘/归一
 * 在主进程同步做：单图 ≤10MB 量级 + 1568 长边归一毫秒级，可接受（未观察到卡顿风险，
 * 未做 setImmediate 分片）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelConfig, ModelRef, ResolvedModel, TextGenerationResponse } from '@orison/shared-contracts';
import { generateText } from '@orison/model-protocols';
import { buildProjectPath, mimeTypeFromExt } from './projectIpcHelpers';
import { getLogger } from '../logger';

/**
 * prepareVisionImage（visionAnalysis）返回形态的本地结构镜像——防环不 import 原模块；
 * 结构一致性由 visionAnalysis.test.ts 与本文件测试 + CR 复核钉住。
 */
export type PreparedImageInput =
  | { ok: true; buffer: Buffer; mimeType: string; note?: string }
  | { ok: false; reason: string };

/** 转述 prompt（R2.4 固定文案：逐字转录 / 画面 / 构图风格，只依据所见不得编造）。 */
export const IMAGE_RELAY_PROMPT =
  '详细描述这张图片的全部信息：图中文字逐字转录、画面内容、构图与风格特征。只依据图中所见，不得编造。';

/** 转述文本 part 前缀（与 B2 指针块 `[图片引用 · name]` 对应的图义文本锚）。 */
const RELAY_TEXT_PREFIX = '[图片转述] ';

const NOT_CONFIGURED_REASON = '未配置识图模型，可在设置「研究与视觉」配置';

/**
 * CR-007：转述 generateText 调用的硬总时长上限（ms）——mirror modelGatewayIpc 的
 * BACKGROUND_NONSTREAM_CEILING_MS（CR-34，600s）。转述是独立的非流式 generateText 调用
 * （无 onDelta、协议层无时长界），挂死端点上会无限拖延整条 generate。两侧若动，同步。
 */
export const IMAGE_RELAY_CEILING_MS = 600_000;

/**
 * CR-003a 转述进度事件载荷（channel `image-relay-progress`，全窗广播——单窗口 app 无需
 * session 定向）。current = 正在转述的图在本载荷指针图串行处理序中的 1-based 位次；
 * total = 本载荷指针图总数。每图转述开始/完成各发一次（载荷相同，UI 取最新渲染
 * 「正在识图 i/N」即可）；直传路 / 缓存全命中不发。
 */
export interface ImageRelayProgress {
  current: number;
  total: number;
}

/** 降级占位 part：never-throws——任何单图失败都以非空文本替换，消息继续流。 */
function degradeTextPart(reason: string): { type: 'text'; text: string } {
  return { type: 'text', text: `[图片未识别：${reason}。请提示用户。]` };
}

function textRelayPart(description: string): { type: 'text'; text: string } {
  return { type: 'text', text: `${RELAY_TEXT_PREFIX}${description}` };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 线上形态 narrowing（本地类型，不跨端共享——B2/B3 边界拍板：两侧形态一致性由各自
//    测试逐字锁定 + CR 复核；buildImagesParts（agent ipc-provider）是另一半）。 ──

/**
 * 指针形态 part：type 'image' + image{path 项目相对, b64hash 落盘字节 sha256 指纹,
 * projectPath? 精确项目根（CR-001b 决议 b——agent 侧 additive，session.projectPath 现成）}。
 */
interface PointerImagePart {
  type: 'image';
  image: { path: string; b64hash: string; projectPath?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 指针判定：type 'image'、无非空 b64Json（b64 内联形态非本模块管辖，原样过）、有非空
 * path。projectPath 仅精确根解析用——非 string 形态视为缺席（回落既有扫描路，语义不变）。
 */
function isPointerImagePart(part: unknown): part is PointerImagePart {
  if (!isRecord(part) || part.type !== 'image' || !isRecord(part.image)) return false;
  if (typeof part.image.b64Json === 'string' && part.image.b64Json.length > 0) return false;
  return typeof part.image.path === 'string' && part.image.path.length > 0;
}

/**
 * 畸形 image part：type 'image' 但既无非空 path 也无非空 b64Json——替换为降级文本，防
 * provider 400。CR-006：**长度判**（非 typeof-only）——`path: ''` / `b64Json: ''` 曾同时
 * 逃过指针判定（要求 length>0）与畸形判定（旧实现只查 typeof string），原样穿透协议层。
 */
function isMalformedImagePart(part: unknown): boolean {
  if (!isRecord(part) || part.type !== 'image') return false;
  if (!isRecord(part.image)) return true;
  const hasB64 = typeof part.image.b64Json === 'string' && part.image.b64Json.length > 0;
  const hasPath = typeof part.image.path === 'string' && part.image.path.length > 0;
  return !hasB64 && !hasPath;
}

// ── 归一/转述缓存（R2.5 / design D-E + CR-019 直传路归一缓存） ──

/** 归一产物缓存条目：直传路消费 b64/mimeType，转述路再回填 transcription（两路同条目）。 */
interface PreparedImageCacheEntry {
  b64: string;
  mimeType: string;
  transcription?: string;
}

/**
 * key = sha256(**归一后**字节) hex。进程生命周期内存级——有界性：以会话累计图片数为上界
 * （每图一条、b64 ≤5MB 量级 + 数百字节转述文本），无淘汰策略；跨重启首轮每图重走全路径
 * （盘缓存涉淘汰，Deferred 不进本期）。
 */
const preparedImageCache = new Map<string, PreparedImageCacheEntry>();

/**
 * CR-019 零 IO 快路：指针身份（`${relPath}|${b64hash}`）→ 归一哈希。历史每轮重放先查
 * 这里，命中即免读盘/哈希/归一（直传/转述两路同享）。仅内容身份非空的指针进此表（空
 * b64hash 无从建身份，每轮走全路径——既有行为）。
 */
const pointerPreparedKey = new Map<string, string>();

// ── 防环注入内核 ──

/**
 * 生产实现全部位于依赖环上（visionAnalysis.prepareVisionImage /
 * modelGatewayIpc.resolveModel / configIpc.readModelConfigFromDisk——configIpc 经 db
 * indexers 回指 modelGatewayIpc），由 agentIpc 注册期装配。未装配时图片一律降级 +
 * error 日志（wiring 由 agentIpcStreamDispatch.test 钉死，不会静默）。
 */
export interface AgentImagePartsCore {
  /** 字节归一（5MB/1568/magic-byte mime，never-throws）。生产 = visionAnalysis.prepareVisionImage。 */
  prepareImage(imageB64: string, declaredMimeType: string): PreparedImageInput;
  /** ModelRef → ResolvedModel（visionModel 转述用）。生产 = modelGatewayIpc.resolveModel。 */
  resolveModelRef(ref: ModelRef, config: ModelConfig): ResolvedModel;
  /** 读模型配置（visionModel 判定）。生产 = configIpc.readModelConfigFromDisk。 */
  readModelConfig(): ModelConfig;
  /**
   * CR-003a 转述进度广播（可选——缺席 = 静默不中断生成）。生产 = agentIpc 全窗
   * webContents.send('image-relay-progress')（mirror notifyUI 广播形态）。
   */
  notifyRelayProgress?: (progress: ImageRelayProgress) => void;
}

let core: AgentImagePartsCore | null = null;

/** 生产装配点（agentIpc.registerAgentIpc 内调用，mirror setGenerateTextFn 注入形态）。 */
export function installAgentImagePartsCore(next: AgentImagePartsCore): void {
  core = next;
}

/** 测试缝：探针已装配内核（钉 agentIpc 的 install wiring）。 */
export function __getAgentImagePartsCoreForTest(): AgentImagePartsCore | null {
  return core;
}

/** 测试缝：清归一/转述缓存（用例间独立断言缓存命中/未命中与调用计数）。 */
export function __clearImageRelayCacheForTest(): void {
  preparedImageCache.clear();
  pointerPreparedKey.clear();
}

// ── 字节解析（项目根定位 + 指纹校验） ──

type BytesResult = { ok: true; buffer: Buffer } | { ok: false; reason: string };

async function resolveImageBytes(relPath: string, b64hash: string, projectDirs: string[]): Promise<BytesResult> {
  const wantHash = b64hash.trim().toLowerCase();
  // 只留首个存在匹配的字节（多候选不再逐个持有——同路径 10MB 图 × N 项目的病态面）。
  let fallback: Buffer | null = null;
  let fallbackCount = 0;
  for (const projectDir of projectDirs) {
    let absPath: string;
    try {
      // normalizeRelativePath（拒 '..'/空段）+ assertWithinProject（realpath 防符号链接逃逸）。
      absPath = buildProjectPath(projectDir, relPath);
    } catch {
      return { ok: false, reason: `图片路径不合法或越出项目（${relPath}）` };
    }
    if (!existsSync(absPath)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absPath);
    } catch {
      continue; // 单候选不可读——继续扫其余项目根
    }
    if (wantHash) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash === wantHash) {
        return { ok: true, buffer: bytes }; // 指纹命中即权威：跨项目同名消歧 + 防陈旧指针
      }
    }
    if (fallback === null) fallback = bytes;
    fallbackCount += 1;
  }
  if (fallback !== null) {
    // 指纹未命中（落盘后被外部改动 / 哈希编码形态漂移）→ 回退存在匹配；多候选取注册库
    // 顺序首个（最近打开优先，确定性）。warn 可查但不断流。
    if (fallbackCount > 1 || wantHash) {
      getLogger().warn(
        { relPath, candidates: fallbackCount },
        'agentImageParts: image pointer hash miss — falling back to existence match',
      );
    }
    return { ok: true, buffer: fallback };
  }
  return { ok: false, reason: `未找到图片文件（${relPath}）` };
}

/**
 * CR-001b（决议 b）：指针带 projectPath 时的**精确项目根**解析——不扫注册库（载荷自带
 * 项目身份后零候选歧义）；**精确指针失效即失效**（项目不存在/文件缺失/路径越界 → 降级
 * 文本，不回退扫描——回退会让指向已删项目的指针静默解析到注册库里同名误配）。指纹
 * miss（盘上字节被外部改动）mirror 扫描路存在匹配语义：warn + 用现存字节（精确根落点
 * 唯一，无跨项目消歧需求）。never-throws。
 */
function resolveImageBytesPrecise(projectPath: string, relPath: string, b64hash: string): BytesResult {
  const wantHash = b64hash.trim().toLowerCase();
  if (!existsSync(projectPath)) {
    return { ok: false, reason: `项目目录不存在（${projectPath}）` };
  }
  let absPath: string;
  try {
    absPath = buildProjectPath(projectPath, relPath);
  } catch {
    return { ok: false, reason: `图片路径不合法或越出项目（${relPath}）` };
  }
  if (!existsSync(absPath)) {
    return { ok: false, reason: `未找到图片文件（${relPath}）` };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch (err) {
    return { ok: false, reason: `图片读取失败（${errMsg(err)}）` };
  }
  if (wantHash) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== wantHash) {
      getLogger().warn(
        { relPath, projectPath },
        'agentImageParts: precise-root image hash miss — using current bytes',
      );
    }
  }
  return { ok: true, buffer: bytes };
}

/** 生产项目根清单：机器注册库非删除项目（最近打开优先）。动态 import 防把 native db 拖进模块图。 */
async function defaultListProjectDirs(): Promise<string[]> {
  try {
    const { listProjects } = await import('../db/projectRepository');
    return listProjects()
      .filter((p): p is typeof p & { path: string } => typeof p.path === 'string' && p.path.length > 0)
      .map((p) => p.path);
  } catch {
    return [];
  }
}

// ── visionModel 转述（mirror runVisionAnalysis 三层派发，降级文本替换 manual 导出） ──

type RelayOutcome =
  | { ok: true; description: string }
  | { ok: false; kind: 'not-configured' }
  | { ok: false; kind: 'failed'; message: string };

/**
 * CR-34 工具（modelGatewayIpc.signalWithCeiling）的本地镜像——防环不 import（本模块被
 * modelGatewayIpc 静态引入，反向 import 成环）；结构一致性由本文件测试钉住：手工
 * controller + setTimeout（fake timers 可驱动上限）、timer unref 不挂事件循环、调用方
 * 取消原样穿透（adopt outer.reason）、上限到点以 TimeoutError DOMException 中止。
 */
function relaySignalWithCeiling(outer: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const fire = () => {
    controller.abort(new DOMException('image relay generation exceeded its total ceiling', 'TimeoutError'));
  };
  const timer = setTimeout(fire, ms);
  (timer as { unref?: () => void }).unref?.();
  if (outer === undefined) return controller.signal;
  if (outer.aborted) {
    clearTimeout(timer);
    controller.abort(outer.reason);
    return controller.signal;
  }
  outer.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      controller.abort(outer.reason);
    },
    { once: true },
  );
  return controller.signal;
}

async function relayImageDescription(
  b64Json: string,
  mimeType: string,
  coreFns: Pick<AgentImagePartsCore, 'resolveModelRef' | 'readModelConfig'>,
  signal: AbortSignal | undefined,
): Promise<RelayOutcome> {
  // CR-007：已取消的 run 不再发起识图调用（主调用随后同样以取消收场）。
  if (signal?.aborted) {
    return { ok: false, kind: 'failed', message: '生成已取消' };
  }
  let config: ModelConfig;
  try {
    config = coreFns.readModelConfig();
  } catch (err) {
    return { ok: false, kind: 'failed', message: `读取模型配置失败（${errMsg(err)}）` };
  }
  // R9b 红线 mirror（runVisionAnalysis :198-199）：未配 visionModel 绝不盲试主文本模型
  //（中转站静默剥 image part = 幻觉，不是降级）→ 调用方替换为降级说明文本。
  if (!config.visionModel) {
    return { ok: false, kind: 'not-configured' };
  }
  let resolved: ResolvedModel;
  try {
    resolved = coreFns.resolveModelRef(config.visionModel, config);
  } catch (err) {
    return { ok: false, kind: 'failed', message: `识图模型配置无法解析（${errMsg(err)}）` };
  }
  try {
    const response: TextGenerationResponse = await generateText(
      resolved,
      {
        model: resolved.modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'text' as const, text: IMAGE_RELAY_PROMPT },
            { type: 'image' as const, image: { b64Json, mimeType } },
          ],
        }],
      },
      // CR-007：signal 贯穿（停止钮生效）+ 600s 硬上限（挂死端点有界失败）。
      { signal: relaySignalWithCeiling(signal, IMAGE_RELAY_CEILING_MS) },
    );
    const description = (response.text ?? '').trim();
    if (!description) {
      return { ok: false, kind: 'failed', message: '识图模型返回了空回复' };
    }
    return { ok: true, description };
  } catch (err) {
    return { ok: false, kind: 'failed', message: errMsg(err) };
  }
}

// ── 主入口 ──

/**
 * 把 messages 里的指针 image part 解析为 b64 part（vision=true 直传）或转述文本 part
 * （否则）。无待处理 part 时**原引用返回**（调用方零重打包）。改写只浅拷贝受影响消息，
 * 其余消息对象与数组引用原样保留。
 *
 * deps：listProjectDirs（扫描路项目根清单，生产 = 机器注册库）/ signal（CR-007 取消
 * 贯穿，转述 generateText 内部再包 600s ceiling）/ onRelayProgress（CR-003a 进度发射，
 * 优先于 core.notifyRelayProgress——测试缝/逐调用覆写）。
 */
export async function resolveImageParts(
  messages: unknown[],
  resolvedModel: ResolvedModel,
  deps: {
    listProjectDirs?: () => Promise<string[]> | string[];
    /** CR-007：贯穿转述 generateText 的取消信号（内部再包 600s ceiling）。 */
    signal?: AbortSignal;
    /** CR-003a：转述进度发射（逐调用覆写；缺省回落 core.notifyRelayProgress）。 */
    onRelayProgress?: (progress: ImageRelayProgress) => void;
  } = {},
): Promise<unknown[]> {
  // Pass 1 — 扫描含待处理 image part 的消息（string content / 无图载荷零触碰）。
  const targets: Array<{ msgIndex: number; partIndices: number[] }> = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const message = messages[mi];
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    const content = message.content as unknown[];
    const partIndices: number[] = [];
    for (let pi = 0; pi < content.length; pi += 1) {
      if (isPointerImagePart(content[pi]) || isMalformedImagePart(content[pi])) partIndices.push(pi);
    }
    if (partIndices.length > 0) targets.push({ msgIndex: mi, partIndices });
  }
  if (targets.length === 0) return messages;

  if (!core) {
    getLogger().error('agentImageParts: core not installed (agentIpc wiring missing) — degrading image parts');
    return rewriteTargets(messages, targets, () => degradeTextPart('图片暂无法处理，请稍后重试'));
  }
  // 捕获为 const：闭包（treatPart/relay）内不再受模块级 let 的可变性影响（TS 收窄）。
  const installedCore: AgentImagePartsCore = core;

  let projectDirs: string[] | null = null;
  const getProjectDirs = async (): Promise<string[]> => {
    if (projectDirs === null) {
      const lister = deps.listProjectDirs ?? defaultListProjectDirs;
      projectDirs = (await lister()).filter((d): d is string => typeof d === 'string' && d.length > 0);
    }
    return projectDirs;
  };

  // 同一 (path, b64hash) 一条载荷内重复出现（历史重放同图多消息）——结果复用，免重复读盘/转述。
  const partMemo = new Map<string, unknown>();

  // CR-003a 进度计数：total = 本载荷指针图总数（畸形 part 不计——不进转述车道）；
  // ordinal 按串行处理序递增（memo 命中静默消费位次——同图重复不重发进度）。广播
  // best-effort：发射异常不阻断生成（进度是可见性增强，不是生成依赖）。
  const totalPointerParts = targets.reduce((sum, { msgIndex, partIndices }) => {
    const content = (messages[msgIndex] as { content: unknown[] }).content;
    return sum + partIndices.filter((pi) => isPointerImagePart(content[pi])).length;
  }, 0);
  let pointerOrdinal = 0;
  const emitRelayProgress = (progress: ImageRelayProgress): void => {
    const emit = deps.onRelayProgress ?? installedCore.notifyRelayProgress;
    if (!emit) return;
    try {
      emit(progress);
    } catch {
      // 静默（见上）。
    }
  };

  const treatPart = async (part: unknown): Promise<unknown> => {
    if (!isPointerImagePart(part)) {
      return degradeTextPart('图片消息格式异常');
    }
    const { path: relPath, b64hash } = part.image;
    // CR-001b：精确项目根（非 string / 空串视为缺席——回落既有扫描路，语义不变）。
    const preciseRoot =
      typeof part.image.projectPath === 'string' && part.image.projectPath.length > 0
        ? part.image.projectPath
        : undefined;
    pointerOrdinal += 1;
    const ordinal = pointerOrdinal;
    const memoKey = `${relPath}|${b64hash}`;
    if (partMemo.has(memoKey)) return partMemo.get(memoKey);

    // CR-019 零 IO 快路：指针身份 → 归一哈希 → 缓存条目（历史重放免读盘/哈希/归一）。
    const hasContentIdentity = typeof b64hash === 'string' && b64hash.trim().length > 0;
    let entry: PreparedImageCacheEntry | undefined;
    if (hasContentIdentity) {
      const preparedKey = pointerPreparedKey.get(memoKey);
      if (preparedKey !== undefined) entry = preparedImageCache.get(preparedKey);
    }

    if (entry === undefined) {
      let prepared: PreparedImageInput | undefined;
      try {
        const bytes: BytesResult =
          preciseRoot !== undefined
            ? resolveImageBytesPrecise(preciseRoot, relPath, b64hash)
            : await resolveImageBytes(relPath, b64hash, await getProjectDirs());
        if (!bytes.ok) {
          const degraded = degradeTextPart(`图片读取失败，${bytes.reason}`);
          partMemo.set(memoKey, degraded);
          return degraded;
        }
        const declaredMime = mimeTypeFromExt(path.extname(relPath)) ?? '';
        prepared = installedCore.prepareImage(bytes.buffer.toString('base64'), declaredMime);
        if (!prepared.ok) {
          const degraded = degradeTextPart(`图片处理失败，${prepared.reason}`);
          partMemo.set(memoKey, degraded);
          return degraded;
        }
      } catch (err) {
        // resolveImageBytes/prepareImage 均 never-throws 契约——此层兜底未知异常，仍不断流。
        const degraded = degradeTextPart(`图片处理失败，${errMsg(err)}`);
        partMemo.set(memoKey, degraded);
        return degraded;
      }
      const preparedKey = createHash('sha256').update(prepared.buffer).digest('hex');
      // 同内容跨路径/跨项目共享条目（内容寻址）；已存在则复用（保住既有 transcription）。
      entry =
        preparedImageCache.get(preparedKey) ?? {
          b64: prepared.buffer.toString('base64'),
          mimeType: prepared.mimeType,
        };
      preparedImageCache.set(preparedKey, entry);
      if (hasContentIdentity) pointerPreparedKey.set(memoKey, preparedKey);
    }

    let result: unknown;
    if (resolvedModel.vision === true) {
      // B1 registry vision=true → 归一后 b64 直传（协议层 OpenAI/Anthropic 双格式已通）。
      result = { type: 'image', image: { b64Json: entry.b64, mimeType: entry.mimeType } };
    } else if (entry.transcription !== undefined) {
      // CR-019 转述缓存命中：同图跨轮/跨消息/模型切换后互复用，零重复计费。
      result = textRelayPart(entry.transcription);
    } else {
      // 转述车道：CR-003a 进度（开始/完成各一发）+ CR-007 signal 贯穿。
      emitRelayProgress({ current: ordinal, total: totalPointerParts });
      const relay = await relayImageDescription(entry.b64, entry.mimeType, installedCore, deps.signal);
      emitRelayProgress({ current: ordinal, total: totalPointerParts });
      if (relay.ok) {
        entry.transcription = relay.description;
        result = textRelayPart(relay.description);
      } else if (relay.kind === 'not-configured') {
        result = degradeTextPart(NOT_CONFIGURED_REASON); // 不入缓存：配置识图模型后即愈
      } else {
        result = degradeTextPart(`识图转述失败，${relay.message}`); // 不入缓存：下一轮自动重试
      }
    }

    partMemo.set(memoKey, result);
    return result;
  };

  return rewriteTargets(messages, targets, treatPart);
}

/** Pass 2 — 只重建受影响消息（浅拷贝消息对象 + content 数组），逐 part **串行** await
 *  （转述是 LLM 调用——API 并发纪律，feedback-api-concurrency-no-parallel）。 */
async function rewriteTargets(
  messages: unknown[],
  targets: Array<{ msgIndex: number; partIndices: number[] }>,
  replacePart: (part: unknown) => unknown | Promise<unknown>,
): Promise<unknown[]> {
  const nextMessages = messages.slice();
  for (const { msgIndex, partIndices } of targets) {
    const original = messages[msgIndex] as unknown as { content: unknown[] };
    const nextContent = original.content.slice();
    for (const pi of partIndices) {
      nextContent[pi] = await replacePart(original.content[pi]);
    }
    nextMessages[msgIndex] = { ...original, content: nextContent };
  }
  return nextMessages;
}

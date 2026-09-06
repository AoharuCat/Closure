import type {
  ImportFilesResult,
  ModelConfig,
  ModelRef,
  ResolveInboxAttachmentInput,
  ResolveInboxAttachmentResult,
  StoreAttachmentDescriptionInput,
  StoreAttachmentDescriptionResult,
} from '@orison/shared-contracts';
import { normalizePath } from '../utils/paths';
import type { DirEntry } from './assets';

/**
 * A 波 09-01（task 09-01-agent-chat-attachments A3）：inbox 附件上传的 UI api 层——
 * 包 importFiles 白名单调用 + resolve/store 两 IPC + description 生成直调
 * `model:generate-text`（R1.2b 异步回填，章摘要 synopsis 同型）。
 *
 * 预解析 IPC（project:parse-inbox-doc）不经本层：resolve-inbox-attachment 的
 * reparseStale 路径已覆盖「docx/pdf 无派生件时先行解析」（deriveInboxMaterial
 * 派生件缺失/过期即走解析内核 + 写盘），上传流只调 resolve 一只——先 parse 再
 * resolve 会把大 PDF（端点 OCR 可达 120s）双倍解析。
 */

/** 惰性取桥（勿模块级捕获——测试在 beforeEach 里装 `(window as any).orisonDesktop`，晚于模块加载）。 */
const api = () => window.orisonDesktop;

/** 上传白名单（R1.5，shell 侧强制同表——importFiles allowedExtensions 归一后比对）。 */
export const INBOX_UPLOAD_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.pdf'] as const;

/** 隐藏 file input 的 accept 面（AC：选择器 accept 属性）。 */
export const INBOX_UPLOAD_ACCEPT = INBOX_UPLOAD_EXTENSIONS.join(',');

/**
 * 拷入 `<project>/inbox/`（白名单 shell 侧强制；部分成功语义——非白名单拒收回报
 * 文件名，合法文件照常拷入，AC2）。返回的 imported 已剥 shell 的前导 `/`
 * （resolve-inbox-attachment 的 filePath 须为无前导斜杠的项目相对路径，否则
 * path.resolve 会逃出项目目录被 assertWithinProject 拒收）。
 */
export async function importFilesToInbox(
  projectPath: string,
  sourcePaths: string[],
): Promise<{ imported: string[]; rejected: string[] }> {
  const result = await api()!.importFiles(projectPath, 'inbox', sourcePaths, [
    ...INBOX_UPLOAD_EXTENSIONS,
  ]);
  if (Array.isArray(result)) return { imported: result.map(stripLeadingSlash), rejected: [] };
  const typed = result as ImportFilesResult;
  return {
    imported: (typed.imported ?? []).map(stripLeadingSlash),
    rejected: typed.rejected ?? [],
  };
}

function stripLeadingSlash(rel: string): string {
  return rel.replace(/^\/+/, '');
}

/** 挂附件协议（R1.2c）：mtime 重解析 → 内容哈希 → exact/similar/fresh + 描述复用。 */
export function resolveInboxAttachment(input: ResolveInboxAttachmentInput): Promise<ResolveInboxAttachmentResult> {
  return api()!.resolveInboxAttachment(input);
}

/** fresh 描述生成完毕回写 sidecar（哈希/sample 由 shell 现算）。 */
export function storeAttachmentDescription(
  input: StoreAttachmentDescriptionInput,
): Promise<StoreAttachmentDescriptionResult> {
  return api()!.storeAttachmentDescription(input);
}

/** 读派生材料全文（description 生成输入源，~8K 字截取在调用侧）。 */
export async function readInboxMaterialText(projectPath: string, derivedPath: string): Promise<string | null> {
  const abs = normalizePath(`${projectPath}/${stripLeadingSlash(derivedPath)}`);
  try {
    return await api()!.readFile(abs);
  } catch {
    return null;
  }
}

/** 换取上传 File 的绝对路径（Electron 37 无 File.path；bridge 收口——store 不直碰 window）。 */
export function pathForUploadFile(file: File): string {
  return window.orisonDesktop?.pathForFile?.(file) ?? '';
}

const INBOX_FILE_RE = /\.(txt|md|markdown|docx|pdf)$/i;

/**
 * 扁平化 inbox/ 目录树为可挂材料清单（attach 菜单「inbox 材料」段数据源，R1.8）。
 * - 白名单扩展名过滤（dot 目录已被 readDirectoryRecursive 排除）。
 * - 派生 .md 去重：同目录同 stem 的 .docx/.pdf 原件在场时跳过 .md（挂原件经 resolve
 *   协议指向派生件，双列冗余）。**CR-015：去重键 = rel 全路径 stem**——name 级去重会把
 *   `inbox/sub/大纲.md` 连带藏给根级 `大纲.docx`（子目录同名材料误隐藏）。
 */
export function flattenInboxMaterials(entries: DirEntry[]): { name: string; rel: string }[] {
  const files: { name: string; rel: string }[] = [];
  const walk = (items: DirEntry[]) => {
    for (const e of items) {
      if (e.isDir) {
        if (Array.isArray(e.children)) walk(e.children);
        continue;
      }
      if (!INBOX_FILE_RE.test(e.name)) continue;
      const sub = (e.path ?? `/${e.name}`).replace(/^\//, '');
      files.push({ name: e.name, rel: `inbox/${sub}` });
    }
  };
  walk(entries);
  const rels = new Set(files.map((f) => f.rel.toLowerCase()));
  return files.filter((f) => {
    if (!f.name.toLowerCase().endsWith('.md')) return true;
    const stem = f.rel.slice(0, -3).toLowerCase(); // 剥 '.md' → rel 全路径 stem
    return !(rels.has(`${stem}.docx`) || rels.has(`${stem}.pdf`));
  });
}

/** 列 inbox/ 材料（懒加载——attach 菜单打开时；目录不存在/读失败回落空清单）。 */
export async function listInboxFiles(projectPath: string): Promise<{ name: string; rel: string }[]> {
  try {
    const entries = (await api()?.readDirectory(normalizePath(`${projectPath}/inbox`))) ?? [];
    return flattenInboxMaterials(entries);
  } catch {
    return [];
  }
}

/* ── description 生成（R1.2b 异步回填，renderer 直调 model:generate-text）── */

/** 生成输入前缀截取（design §1.3：派生材料前 ~8K 字）。 */
export const ATTACHMENT_DESCRIPTION_INPUT_MAX_CHARS = 8000;

/** 生成超时（失败/超时静默降级 preview-only，never-throws）。 */
export const ATTACHMENT_DESCRIPTION_TIMEOUT_MS = 10_000;

/**
 * CR-010①：非 UTF-8 编码文件的 preview 机器提示文案（GBK 等被编码检测抑制 preview 时
 * 填入附件 preview——指针块「预览:」行保门控成立，引导可达）。与指针块引导行同语言域
 * （给模型的中文提示），不走 i18n。
 */
export const NON_UTF8_ATTACHMENT_ADVISORY =
  '是非 UTF-8 编码文件（如 GBK）——请先转码为 UTF-8 再上传，或让 Agent 用 parse_document 尝试。';

/**
 * CR-010③：U+FFFD 替换符比率跳过阈（renderer 侧检测，与生成输入同窗）——≥3% 判乱码，
 * 跳过 description 生成（preview-only 降级），防 LLM 对乱码编造定性。
 */
export const ATTACHMENT_DESCRIPTION_UFFFD_RATIO = 0.03;

/** 文本 U+FFFD 替换符占比（0~1；空文本 0）。 */
export function ufffdReplacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count / text.length;
}

/**
 * description 生成前的乱码守卫（CR-010③）：对**生成输入同窗**（前 ~8K 字）算 U+FFFD
 * 比率，≥3% 跳过生成——纯代码判定（不理解意义），「这段内容是什么」仍归 LLM。
 */
export function shouldSkipAttachmentDescription(content: string): boolean {
  return ufffdReplacementRatio(content.slice(0, ATTACHMENT_DESCRIPTION_INPUT_MAX_CHARS))
    >= ATTACHMENT_DESCRIPTION_UFFFD_RATIO;
}

/* ── CR-016：description 生成底层 invoke 并发门 ── */

/**
 * 底层 generateText invoke 在途上限（模块级计数）。Promise.race 超时**不取消**底层
 * invoke——provider 挂起时串行链每 ~10s 放行下一个生成而挂起的调用仍占线，无门则线性
 * 堆积。≥2 在途时新调用顺延等待（挂起的两个是诊断面，第三个起排队不动）。
 */
export const ATTACHMENT_DESCRIPTION_MAX_INFLIGHT = 2;

let descriptionInflight = 0;
const descriptionWaiters: Array<() => void> = [];

async function acquireDescriptionSlot(): Promise<void> {
  if (descriptionInflight < ATTACHMENT_DESCRIPTION_MAX_INFLIGHT) {
    descriptionInflight += 1;
    return;
  }
  await new Promise<void>((resolve) => { descriptionWaiters.push(resolve); });
  descriptionInflight += 1;
}

function releaseDescriptionSlot(): void {
  descriptionInflight -= 1;
  descriptionWaiters.shift()?.();
}

/** 测试缝：读当前在途计数（in-flight 门用例断言）。 */
export function __attachmentDescriptionInflightForTest(): number {
  return descriptionInflight;
}

const ATTACHMENT_DESCRIPTION_PROMPT =
  '依据以下文件内容，用一句话说明这是什么材料、涵盖什么（不超过 50 字）。只依据内容，不得编造。\n\n';

/**
 * dialogue 任务档（C3.2 单控制面）→ 生成的模型 ref；未配置 → default 哨兵
 * （shell resolveModel 自动选第一个启用模型，与 leader 对话车道缺省同源）。
 */
export function dialogueModelRefFromConfig(modelConfig: ModelConfig | undefined): ModelRef {
  const assignment = modelConfig?.taskModels?.dialogue;
  if (assignment && assignment.keyId && assignment.modelId) {
    return { keyId: assignment.keyId, modelId: assignment.modelId };
  }
  return { keyId: 'default', modelId: 'default' };
}

/**
 * 一句话定性生成（AC6e）。never-throws：失败/超时（~10s）返回 null，调用方静默
 * 降级 preview-only——不阻塞 Send、不打错误横幅。CR-016：底层 invoke 经模块级
 * in-flight 门（≤2），超限顺延；槽位在底层 invoke **settle**（非 race 超时）时归还。
 */
export async function generateAttachmentDescription(input: {
  modelRef: ModelRef;
  content: string;
}): Promise<string | null> {
  const text = input.content.slice(0, ATTACHMENT_DESCRIPTION_INPUT_MAX_CHARS).trim();
  if (!text) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await acquireDescriptionSlot();
    let invokePromise: Promise<{ text?: string }>;
    try {
      invokePromise = window.orisonDesktop.generateText({
        ref: input.modelRef,
        request: {
          model: input.modelRef.modelId,
          messages: [{ role: 'user', content: `${ATTACHMENT_DESCRIPTION_PROMPT}${text}` }],
        },
      });
    } catch {
      // 桥同步抛（mock/环境异常）：槽位立即归还，never-throws 降级。
      releaseDescriptionSlot();
      return null;
    }
    // 底层 settle（成功/最终失败）才归还槽位；此链仅防 unhandled rejection（race 侧
    // 另有消费）。超时放弃等待 ≠ 取消——挂起中的 invoke 仍占槽，正是本门要防的堆积。
    void invokePromise.finally(releaseDescriptionSlot).catch(() => {});
    const result = await Promise.race([
      invokePromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ATTACHMENT_DESCRIPTION_TIMEOUT_MS);
      }),
    ]);
    if (result === null) return null;
    const description = (result.text ?? '').trim();
    return description.length > 0 ? description : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ── CR-018：importFiles 拒收三档分类 ── */

/**
 * 拒收条目带原因形态的尾缀（🔴 与 shell projectFileIpc.ts 逐字同步——SH-a 定型的
 * 跨层字符串契约，shell 侧文案改动必须同步此处）：裸名 = 扩展名拒收；
 * `name (超过 50MB 上限)` = 大小闸；`name (超过单批 100 个上限)` = 批量闸。
 */
const REJECT_SUFFIX_TOO_LARGE = '(超过 50MB 上限)';
const REJECT_SUFFIX_BATCH = '(超过单批 100 个上限)';

/** importFiles rejected 三档分类结果（names 已剥原因尾缀，供 tier 文案 + chip 对位）。 */
export type ImportRejectionTiers = {
  /** 扩展名不在白名单（裸名形态）。 */
  format: string[];
  /** 超过单文件 50MB 上限。 */
  tooLarge: string[];
  /** 超过单批 100 个上限。 */
  batchLimit: string[];
};

/**
 * 拒收条目按形态分流三档（CR-018）：带原因尾缀按尾缀归档并剥出裸名；裸名（无尾缀）
 * 回落扩展名档——UI 文案不再把「超 50MB」误说成「不支持的格式」（AC2）。
 */
export function classifyImportRejections(rejected: string[]): ImportRejectionTiers {
  const tiers: ImportRejectionTiers = { format: [], tooLarge: [], batchLimit: [] };
  for (const entry of rejected) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (entry.endsWith(REJECT_SUFFIX_TOO_LARGE)) {
      tiers.tooLarge.push(entry.slice(0, -REJECT_SUFFIX_TOO_LARGE.length).trim());
    } else if (entry.endsWith(REJECT_SUFFIX_BATCH)) {
      tiers.batchLimit.push(entry.slice(0, -REJECT_SUFFIX_BATCH.length).trim());
    } else {
      tiers.format.push(entry);
    }
  }
  return tiers;
}

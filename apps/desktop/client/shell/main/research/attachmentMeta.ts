/**
 * 附件元数据 sidecar（A 波 09-01，task 09-01-agent-chat-attachments design §1.2c / D-B''）。
 *
 * `<project>/.orison/attachment-meta.json` —— inbox 附件的「内容哈希身份」缓存：
 *
 *   - 身份跟内容走（sha256），不跟文件名走——用户在文件管理器改名、重复上传
 *     同份文件均哈希精确命中，零重复 LLM 调用（R1.2c）。
 *   - 哈希 miss 时对既有条目的 sample（首部 ~8K 字）做**纯代码** shingle 相似度
 *     （≥80% 阈值）——小幅修改复用旧描述，大幅改写才重新生成。差分计算不调
 *     LLM（范式判据：不理解意义）。
 *   - 缓存语义：可再生、fail-soft——损坏 JSON / 读写失败一律降级空表或
 *     best-effort warn，绝不抛出阻断附件挂载流程。
 *
 * 纯函数（parse/serialize/shingle/find*）与薄 IO（load/save）分离，全部可在
 * 普通 vitest 下直测（mirror docParsing.ts 的 table-testable 形态）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { getLogger } from '../logger';

// ── Sidecar 形态 ──

export const ATTACHMENT_META_FILENAME = 'attachment-meta.json';

/** sample 截取长度（条目差分用的内容首部，~8K 字）。 */
export const ATTACHMENT_SAMPLE_MAX_CHARS = 8_000;

export interface AttachmentMetaEntry {
  /** 内容身份（`sha256:<hex>`，派生 .md 或 txt/md 原件的文本内容哈希）。 */
  contentHash: string;
  /** 最近一次命中的项目相对路径（posix 斜杠；纯 bookkeeping，非身份）。 */
  lastSeenPath: string;
  /** docx/pdf 原件的项目相对路径；txt/md 无派生件为 null。 */
  derivedOf: string | null;
  /** LLM 一句话定性（≤50 字）；fresh 未生成时为空串。 */
  description: string;
  /** description 生成时间（epoch ms）。相似命中复用描述时**不刷新**（R1.2c）。 */
  generatedAt: number;
  /** 内容首部 sample（差分相似度的比对面）。 */
  sample: string;
}

export interface AttachmentMetaFile {
  entries: AttachmentMetaEntry[];
}

export function attachmentMetaPath(projectDir: string): string {
  return path.join(projectDir, '.orison', ATTACHMENT_META_FILENAME);
}

// ── 解析（fail-soft 纯函数）──

/**
 * 解析 sidecar JSON 文本。损坏 / 非对象 / entries 非数组 / 条目缺关键字段
 * 一律降级：整档损坏返回空表，单条畸形跳过（其余保留）——缓存语义可再生，
 * 永不因坏档抛出。
 */
export function parseAttachmentMetaJson(raw: string): AttachmentMetaFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return { entries: [] };
    }
    const entries: AttachmentMetaEntry[] = [];
    for (const item of (parsed as { entries: unknown[] }).entries) {
      if (item === null || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (typeof e.contentHash !== 'string' || typeof e.lastSeenPath !== 'string') continue;
      entries.push({
        contentHash: e.contentHash,
        lastSeenPath: e.lastSeenPath,
        derivedOf: typeof e.derivedOf === 'string' ? e.derivedOf : null,
        description: typeof e.description === 'string' ? e.description : '',
        generatedAt: typeof e.generatedAt === 'number' && Number.isFinite(e.generatedAt) ? e.generatedAt : 0,
        sample: typeof e.sample === 'string' ? e.sample : '',
      });
    }
    return { entries };
  } catch {
    return { entries: [] };
  }
}

// ── 薄 IO ──

/** 读 sidecar：缺失/损坏/读失败 → 空表（fail-soft，warn 只记不抛）。 */
export function loadAttachmentMeta(projectDir: string): AttachmentMetaFile {
  try {
    const p = attachmentMetaPath(projectDir);
    if (!existsSync(p)) return { entries: [] };
    return parseAttachmentMetaJson(readFileSync(p, 'utf-8'));
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectDir },
      'attachment-meta: read failed — degrading to empty cache',
    );
    return { entries: [] };
  }
}

/**
 * 落 sidecar（atomicWriteFileSync，自动建 `.orison/`）。返回 false = 写失败
 * （warn 已记，不抛——缓存可再生，绝不让描述回写炸掉挂载流程）。
 */
export function saveAttachmentMeta(projectDir: string, meta: AttachmentMetaFile): boolean {
  try {
    const p = attachmentMetaPath(projectDir);
    const dir = path.dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(p, JSON.stringify(meta, null, 2), 'utf-8');
    return true;
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), projectDir },
      'attachment-meta: write failed — cache not persisted (regenerable)',
    );
    return false;
  }
}

// ── 进程内串行化（CR-008，09-01 CR patch）──

/**
 * sidecar 读-改-写串行化（per-project promise 链互斥，mirror `fs/projectWriteLock`）。
 *
 * `project:resolve-inbox-attachment` / `project:store-attachment-description` 两入口
 * 的 load → mutate → save 若交错（临界区内任一环节出现 await 后），后写者以旧快照
 * 覆盖，先前条目更新丢失（last-write-wins 丢条目）。当前 RMW 段全同步、事件循环
 * 天然串行——本锁是**结构保证**：未来任何异步化（async fs / 校验网络调用）插进临界
 * 区也不破。导出供 parseDocumentHandlers 接线与直测（按提交顺序串行 / 失败不卡队列）。
 */
const attachmentMetaChains = new Map<string, Promise<unknown>>();

export function withAttachmentMetaLock<T>(projectDir: string, op: () => Promise<T> | T): Promise<T> {
  const key = path.resolve(projectDir);
  const prev = attachmentMetaChains.get(key) ?? Promise.resolve();
  // 前段成功或失败都放行后续（一个失败的写不卡死该项目队列）。
  const result = prev.then(() => op(), () => op());
  // 队尾跟踪 settle（永不 reject）且自剪枝，Map 不随项目数无限增长。
  const tail: Promise<unknown> = result.then(
    () => { if (attachmentMetaChains.get(key) === tail) attachmentMetaChains.delete(key); },
    () => { if (attachmentMetaChains.get(key) === tail) attachmentMetaChains.delete(key); },
  );
  attachmentMetaChains.set(key, tail);
  return result;
}

// ── 查找 ──

export function findExactEntry(entries: AttachmentMetaEntry[], contentHash: string): AttachmentMetaEntry | undefined {
  return entries.find((e) => e.contentHash === contentHash);
}

/**
 * sample shingle 相似度 ≥ {@link ATTACHMENT_SIMILARITY_THRESHOLD} 的最高分条目
 * （多命中取最像的）；全部低于阈值返回 undefined。
 */
export function findSimilarEntry(entries: AttachmentMetaEntry[], sample: string): AttachmentMetaEntry | undefined {
  let best: AttachmentMetaEntry | undefined;
  let bestScore = 0;
  for (const entry of entries) {
    const score = shingleSimilarity(sample, entry.sample);
    if (score >= ATTACHMENT_SIMILARITY_THRESHOLD && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

// ── shingle 相似度（纯代码差分，R1.2c）──

/** 字符 5-gram 粒度（中文友好——词级分词对 CJK 不稳，字符 n-gram 无需分词）。 */
export const ATTACHMENT_SHINGLE_SIZE = 5;

/** 命中阈值：sample 重叠度 ≥ 80% 视为「小幅修改」，复用旧描述。 */
export const ATTACHMENT_SIMILARITY_THRESHOLD = 0.8;

/** 归一：剥全部空白（换行/缩进差异不算内容差异）。 */
function normalizeForShingle(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 字符 n-gram 集合。短于 n-gram 长度的文本产出空集（过短内容不含可判相似度的
 * 统计信号，宁可 miss 重新生成一次，不做碰巧式部分匹配）。
 */
export function shinglesOf(text: string): Set<string> {
  const normalized = normalizeForShingle(text);
  const out = new Set<string>();
  if (normalized.length < ATTACHMENT_SHINGLE_SIZE) return out;
  for (let i = 0; i + ATTACHMENT_SHINGLE_SIZE <= normalized.length; i += 1) {
    out.add(normalized.slice(i, i + ATTACHMENT_SHINGLE_SIZE));
  }
  return out;
}

/**
 * Jaccard 重叠度（0~1）。任一侧无有效 shingle（空/过短 sample）= 0——空对空
 * 不构成任何「同内容」证据。
 */
export function shingleSimilarity(a: string, b: string): number {
  const sa = shinglesOf(a);
  const sb = shinglesOf(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const gram of sa) {
    if (sb.has(gram)) shared += 1;
  }
  const union = sa.size + sb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Story 10.1 Wave B：摄取编排（design §4.2）——任何原料进系统先变「材料」。
 *
 * `ingestMaterial(scope, sourceRelPath)` 管线：
 *
 *   白名单/上限校验（50MB/件 + 批量 250 独立常量，三档拒收语义）
 *     → parseDocumentToMarkdown（共享内核，epub 含 Wave B 新增路径）
 *     → 〔E10.2a〕format ∈ {srt,ass,vtt} 字幕分支：readFile →（utf8 替换率超阈时 GB18030
 *         二次解码择优〔CR-10〕）→ parseSubtitle → joinSubtitleCues → LLM 书面化整理
 *         （幂等门后、decideChapters 前；一切失败降级纯拼合——design §2.3/2.4；截断判定
 *         finishReason 权威〔CR-2〕+ 超预算单段句末标点二次切分〔CR-1〕+ 输出净化〔CR-9〕）
 *     → 归一化（BOM strip + CRLF→LF）
 *     → 质量诊断（复用 docParsing 信号 + 分章结论装配）
 *     → 两段式分章（design §4.2 / D2）
 *         ├─ splitChapters 正则 high/medium → 直用（method='regex'）
 *         ├─ low 且 ≥2 万字 → LLM 兜底一次（候选行约束式，候选预算 300 超限挂起〔F-07〕）
 *         └─ low 且 <2 万字 → 正则命中 ≥1 保 regex 章界（confidence='low' 诚实标注，CR-002）；
 *            零命中才伪章直进（method='none'，讲义/访谈类省调用〔F-09/F-25〕）
 *     → 派生 .md 落盘（materials/.derived/<relPath 镜像>.md〔F-08〕，atomicWrite + 章标记协议）
 *     → 返回 Material 域对象 + 登记/索引钩子 onRegistered（F-24——Wave C 装配真身）
 *
 * 🔑 Wave A 裁决（必须遵守）：splitChapters 输出**不含 para 区间**——para 编号基面是派生
 * .md 文本（标记插入后布局不同〔F-08〕），para 区间由本模块对最终派生文本计算（章 span 映射
 * 到派生文本段落序，段落 = 空行分块、转场标记/mat-chapter 标记行不占号——与 chunkChapter
 * 段落基面一致，锚点跨层对齐；见 splitParagraphBlocks）。char span 基面同派生文本。
 *
 * 幂等（本波只做纯函数面——材料身份归档落 Wave C closure_material 表）：
 *   - 重摄取时读既有派生 .md 章标记（parseChapterMarkers，读取即归一 CR-017——外部编辑器
 *     CRLF 重存不误判内容变更）：manual 标记 = 人工裁决最高优先，原件未变时**保留不重分章**
 *     （F-03）；自动类标记在原件未变时同样原样保留（保真+免重跑，特别是 llm-fallback 不重复
 *     烧调用）。
 *   - 〔CR-3 A 案〕字幕「从未整理成功」（derived = 纯拼合）且 LLM 可用时，REUSE 路径自动
 *     重烧整理（走 fresh 同路径，成功后恢复正常幂等）；LLM 不可用保持纯拼合体 + 降级 note
 *     按实际状态重建（不抹除）。派生被清空而登记未变 → empty 拒收（CR-11，不装配空材料）。
 *   - 「原件未变」判定 = 剥标记重建文本与本次解析归一化文本在空行纪律宽容下逐字一致
 *     （canonicalBlank——手改标记时的空行差异不误判为内容变更）。
 *   - 重建 ≠ 本次解析时先核**原件身份**（CR-001）：登记 content hash（deps.getRegisteredContentHash
 *     缝）与本次解析一致 → 差异来自派生人工编辑 → 不覆写派生、保留人工内容
 *     （outcome='reingest-skipped-manual' + note 确认提示）。
 *   - 〔C2 防清 belt〕CR-001 路径上 markers=0（章标记丢失/被剥——应用内编辑器保存往返〔R10〕/
 *     外部编辑器）时重建产出零章——登记行既有章界非空则**保留既有章界与分章结论**（同
 *     preserveCuratedProvenance 防清哲学），不落 0 章中间行（F1 假态/F12 cleared 窗口根因）；
 *     相 B 重索引 autoResplit 事务覆写真实值。经 deps.getRegisteredMaterial 缝取既有行。
 *   - 内容变更（shingle ≥0.8 相似 = 小幅 / 其余 = 大幅，attachmentMeta.ts:203 纯函数先例，
 *     首部 8K 采样对拍）→ 自动路径重跑 + 诚实 note；**人工标记随之丢失 = 已知限制**
 *     （prd Out of Scope：内容变更重摄取回自动分章，history 快照兜底）。
 *
 * never-throws 契约：结构化失败一律 `{ok:false, reason}` 返回；路径逃逸走
 * assertWithinProject 抛（模式 B，invariant 违反——mirror parseDocumentHandlers）。
 *
 * 依赖边界：本模块**不 import** db/* 与 configIpc/modelGatewayIpc（登记层与 LLM 生产内核
 * 均经 DI/setter 注入——Wave C 装配；防止 watcher/IPC 链上的依赖环）。
 *
 * expected_downstream_consumers:
 * - Wave C materialWatcher（materials/ 目录双轨 watcher → ingestMaterial 增量进件）
 *   与 materialIndexer（onRegistered 钩子真身：closure_material 登记 + 双车道 chunk 索引）。
 * - Wave D materialIpc（materials:import 批量拖入 / materials:reingest 重摄取入口——批量
 *   上限 250 独立常量在此导出）。
 * - 10.3 小说拆解：read_file 读派生 .md + parseChapterMarkers（下游消费缝，design §7）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  GenerationFinishReason,
  Material,
  MaterialChapterConfidence,
  MaterialChapterMethod,
  MaterialFormat,
} from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { sanitizeDiskName } from '@orison/shared-contracts/fs/naming';
import {
  extractHeadingCandidates,
  joinSubtitleCues,
  parseChapterMarkers,
  parseSubtitle,
  serializeChapterMarkers,
  splitChapters,
  type HeadingCandidate,
  type ParsedChapterMarker,
  type SubtitleFormat,
  type SubtitleParagraph,
} from '@orison/shared-contracts';
import {
  ATTACHMENT_SAMPLE_MAX_CHARS,
  ATTACHMENT_SIMILARITY_THRESHOLD,
  shingleSimilarity,
} from '../../research/attachmentMeta';
import { NON_UTF8_SUSPECT_RATIO, decodeTextDocument, utf8ReplacementCharRatio } from '../../research/docParsing';
import { getLogger } from '../../logger';
import { assertWithinProject } from '../pathGuard';
import { parseDocumentToMarkdown } from './parseDocumentHandlers';

// ── 常量（独立不 import——projectFileIpc.ts:56-58 先例；批量 250 ≠ import-files 100〔F-06〕）──

/** 单件上限（50 MiB，mirror MAX_IMPORT_FILE_BYTES 量级但独立声明——材料车道自己的门）。 */
export const MATERIAL_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** 批量导入上限（AC7：materials:import 独立 250，不沿用 import-files 的 100/批〔F-06〕）。 */
export const MATERIAL_IMPORT_MAX_BATCH = 250;

/** 扩展名白名单（shell 侧强制，不信 renderer 过滤——mirror inbox 先例；E10.2a += 字幕三扩展）。 */
export const MATERIAL_ALLOWED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.pdf', '.epub', '.srt', '.ass', '.vtt'] as const;

/** 批量导入三档拒收分类（AC7：格式 / 超 50MB / 超批量——前两档与 per-file reason 同值，batch-overflow 由批量入口拼装）。 */
export const MATERIAL_REJECTION_KINDS = ['unsupported-format', 'too-large', 'batch-overflow'] as const;
export type MaterialRejectionKind = (typeof MATERIAL_REJECTION_KINDS)[number];

/** LLM 兜底触发阈：低置信且 ≥2 万字（小说体量）才烧一次调用（design §4.2〔F-07/F-09〕）。 */
export const MATERIAL_LLM_FALLBACK_MIN_CHARS = 20_000;

/** LLM 兜底候选行预算：超过直接挂起（不静默截断——截断即隐性丢候选 = 假信心〔F-07〕）。 */
export const MATERIAL_LLM_CANDIDATE_BUDGET = 300;

// ── LLM 缝（installXxxCore setter 防环先例，agentImageParts.ts:188 同型）──

/** 兜底单次文本生成（纯文本面；图片/流式不涉）。never-throws 由调用方兜（失败 → 挂起/降级）。 */
export type MaterialGenerateText = (input: {
  system?: string;
  user: string;
  /**
   * 输出 token 预算提示（E10.2a 整理档 POLISH_MAX_TOKENS=8000——〔F-02〕独立于分章兜底 4096：
   * 整理是生成式保义改写，6000 字段输出需 3-4k tokens + 余量）。缺省 = 装配侧自有预算
   * （materialLLMCore 的 MATERIAL_FALLBACK_MAX_TOKENS）。
   */
  maxTokens?: number;
}) => Promise<{
  text: string;
  /**
   * provider 停因（model-protocols `TextGenerationResponse.finishReason`——`GenerationFinishReason`，
   * materialLLMCore 透传；CR-2 additive）。`'length'` = 输出被 token 上限截断（整理档降级判定
   * 的**权威信号**）；缺省 = 端点未回报停因，调用方回退启发式（70% 比值法）。
   */
  finishReason?: GenerationFinishReason;
}>;

export interface MaterialLLMCore {
  /**
   * 便宜档单次生成。**生产装配（Wave C 接线）**：extraction 任务档（C3.2 六档中与「机械分析」
   * 语义对齐的档位——「提取·汇编」；分章候选行判别 = 结构提取任务）→ `resolveTaskModel('extraction')`
   * ?? default 哨兵 → `resolveModel(ref, readModelConfigFromDisk())` → model-protocols
   * `generateText`（lintIpc.ts:459 classify 同型；lane 超时窗由 modelGateway 承担）。
   * configIpc/modelGatewayIpc 在既有依赖环上（configIpc→db indexers→modelGatewayIpc），
   * 本模块位于 watcher/IPC 链上不可静态引入——经注册期 setter 装配。
   */
  generateText: MaterialGenerateText;
}

let llmCore: MaterialLLMCore | null = null;

/** 生产装配点（Wave C/D 接线调用；未装配时低置信材料一律挂起，wiring 测试应钉死）。 */
export function installMaterialLLMCore(next: MaterialLLMCore): void {
  llmCore = next;
}

/** 测试缝：探针已装配内核。 */
export function __getMaterialLLMCoreForTest(): MaterialLLMCore | null {
  return llmCore;
}

/** 测试缝：清装配内核（用例间隔离——未装配态 = LLM 不可用挂起路径）。 */
export function __clearMaterialLLMCoreForTest(): void {
  llmCore = null;
}

// ── 车道 scope 与入参 ──

export interface MaterialIngestScope {
  scope: 'project' | 'global';
  /**
   * materials 车道根（绝对路径）：project 车道 = `<project>/materials`；global 车道 =
   * `~/.orison/materials`。由调用方（Wave C watcher / Wave D IPC）解析传入——本模块不查
   * 注册库（db 边界归 Wave C）。
   */
  materialsRoot: string;
  /** registry 5 位 projectId（project 车道必填语义，由调用方取）；global 车道 null。 */
  projectId: string | null;
}

export interface MaterialIngestDeps {
  /** 解析内核注入（默认 parseDocumentToMarkdown；测试注 stub 零解析可测）。 */
  parse?: typeof parseDocumentToMarkdown;
  /** LLM 兜底生成注入（优先于 installMaterialLLMCore 装配内核；测试四路注入点）。 */
  generateText?: MaterialGenerateText;
  /** 时钟注入（ingestedAt 可测）。 */
  now?: () => Date;
  /**
   * 登记库 content hash 读取缝（CR-001——重摄取区分「原件变更」vs「派生被人工编辑」）：
   * 返回该材料当前登记行的 contentHash（无登记行/读取失败返回 null）。生产装配（Wave C
   * materialIndexer.runRegisterMaterial 透传闭包查登记行）；未装配时退回既有「视为内容
   * 变更」自动路径（watcher 首登/自愈场景无登记行可查，行为不变）。
   */
  getRegisteredContentHash?: (materialId: string) => Promise<string | null> | string | null;
  /**
   * 登记库既有材料行读取缝（C2 防清 belt）：markers=0 重摄取（CR-001 人工保留路径）重建零章时，
   * 既有行章界非空则保留既有 chapters + chapterDetection（不落 0 章中间行——F1 假态/F12
   * cleared 窗口根因；相 B 重索引 autoResplit 事务覆写真实值）。生产装配（Wave C
   * materialIndexer.runRegisterMaterial）透传 getMaterialRow；未装配/零章行/缺行 → belt 不触发
   * （首登/failed/挂起行维持诚实零章现状），行为与无本缝时一致。
   */
  getRegisteredMaterial?: (materialId: string) => Promise<Material | null> | Material | null;
  /**
   * 登记+索引钩子〔F-24〕——Wave C 装配真身（closure_material upsert + materialIndexer）；
   * 默认 no-op。失败 catch + warn 不阻断（登记层 DERIVED 可由 watcher/启动扫描重建；
   * 派生 .md 已落盘 = 真相源完好）。
   */
  onRegistered?: (material: Material) => Promise<void> | void;
}

export type IngestMaterialOutcome =
  | 'fresh'
  | 'reused'
  | 'reingested'
  /** CR-001：显式重摄取时原件未变（登记 hash 一致）而派生域被人工编辑——保留人工内容未覆写。 */
  | 'reingest-skipped-manual';

export type IngestMaterialResult =
  | {
      ok: true;
      material: Material;
      /** 派生 .md 相对 materials 根的 posix 路径（.derived/ 镜像布局〔F-08〕）。 */
      derivedRelPath: string;
      outcome: IngestMaterialOutcome;
    }
  | {
      ok: false;
      reason:
        | 'invalid-path'
        | 'unsupported-format'
        | 'missing'
        | 'empty'
        | 'too-large'
        | 'read-failed'
        | 'parse-failed'
        | 'scanned';
      error: string;
      /** 三档拒收分类（unsupported-format / too-large；其余为摄取失败非拒收）。 */
      rejection?: Extract<MaterialRejectionKind, 'unsupported-format' | 'too-large'>;
    };

// ── 身份/路径 helpers（纯函数，Wave C 与测试复用）──

/**
 * 材料路径身份 `mat-<sha12(scope+'\0'+sourcePath)>`（F-19——路径身份非内容身份：同路径换
 * 内容 = 同 ID 重摄取幂等）。schema regex 钉格式，此处单源派生。
 */
export function materialIdFor(scope: 'project' | 'global', sourcePath: string): string {
  return `mat-${createHash('sha256').update(`${scope}\0${sourcePath}`, 'utf-8').digest('hex').slice(0, 12)}`;
}

/**
 * sourcePath 归一（schema 约定：project 车道相对 `<project>/`〔即带 `materials/` 前缀〕，
 * global 车道相对 `~/.orison/materials/`）。
 */
export function materialSourcePath(scope: 'project' | 'global', relInMaterials: string): string {
  return scope === 'project' ? `materials/${relInMaterials}` : relInMaterials;
}

/**
 * 材料相对路径守卫：剥前导斜杠/反斜杠归一 → 拒逃逸（../、绝对）、拒 dot 段（`.derived/`/
 * `.git`/`.DS_Store` 等隐藏面——**.derived 是本管线自派生面，不得作为进件源**）。返回
 * posix 归一相对路径；非法返回 null。
 */
export function normalizeMaterialRelPath(input: string): string | null {
  // Windows 相对形态（前导反斜杠）容忍剥除（mirror normalizeInboxFilePath 先例）；正斜杠
  // 根/盘符 = 绝对路径拒收。
  const rel = input.replace(/^[\\]+/, '').replace(/\\/g, '/');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  if (!rel) return null;
  const normalized = path.posix.normalize(rel);
  if (normalized === '.' || normalized === '' || normalized.startsWith('../')) return null;
  if (normalized.split('/').some((seg) => seg.startsWith('.'))) return null;
  return normalized;
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, MaterialFormat>> = {
  '.txt': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.srt': 'srt',
  '.ass': 'ass',
  '.vtt': 'vtt',
};

/** 派生 .md 相对路径（F-08 relPath 镜像：materials/sub/foo.txt → .derived/sub/foo.md）。 */
export function derivedRelPathFor(relInMaterials: string): string {
  const dir = path.posix.dirname(relInMaterials);
  const rawStem = path.posix.basename(relInMaterials, path.posix.extname(relInMaterials));
  // stem 过命名单源（W2 R1 / FS#14）：POSIX 源文件名可含 Windows 非法字符/保留名（源已在
  // 盘上合法），镜像派生名不加防护会在 Windows 落盘失败——非法/控制字符 → '-'、保留名
  // '-doc' 后缀、80 帽。清成空串（纯点/空格 stem）退 'untitled'。帽内既有 Windows 合法
  // stem 输出逐字节不变；超 80 帽的存量 stem 截断后派生路径变位——派生 .md 是可重建缓存，
  // 读写两侧一律经本函数重算（无持久化派生路径），变位一致、缺失侧按 re-derive 自愈。
  const stem = sanitizeDiskName(rawStem) || 'untitled';
  // ⚠ 已知边界：同目录同 stem 异扩展（foo.txt + foo.md）镜像到同一派生路径——批量导入面
  // （Wave D）按需拒收同名冲突；本模块维持 design 钉死的镜像形态。
  return dir === '.' ? `.derived/${stem}.md` : `.derived/${dir}/${stem}.md`;
}

// ── 文本归一 / 段落基面（mirror chapter-chunking 段落约定）──

/** BOM strip + CRLF/CR→LF（mirror decodeText/chapterChunk 读取侧归一惯例）。 */
export function normalizeMaterialText(content: string): string {
  const bomStripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return bomStripped.replace(/\r\n?/g, '\n');
}

/** 转场标记（mirror chapter-chunking THEMATIC_BREAK_RE）。 */
const THEMATIC_BREAK_RE = /^([-_*])(?:[ \t]*\1){2,}$/;

/**
 * mat-chapter 标记整行形态（mirror chapter-splitting MARKER_LINE_RE——一致性由两侧测试 +
 * 往返用例钉住；shared-contracts 侧未导出该 RE，此处本地镜像并注释锚定）。
 */
const MARKER_LINE_RE = /^<!--\s*mat-chapter\s+(.*?)\s*-->$/;

function isWsCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c || code === 0x0d;
}

/** 派生文本段落块（半开区间，两端收到首个/末个非空白字符——mirror splitBlocks）。 */
export interface MaterialParagraphBlock {
  start: number;
  end: number;
}

/**
 * 按空行切块的段落序（**chunkChapter 段落基面的全文本投影**）：段落 = 连续非空行块；
 * 整段单行且为转场标记或 mat-chapter 标记行的块**不占号**（前者 mirror chunkChapter「转场
 * 标记不占号」，后者保证章 span 与章内 chunk 的段落号跨层对齐——chunkChapter 消费的章切片
 * 不含标记行，其局部 para 0 ↔ 全文计数中该章首个内容块）。
 */
export function splitParagraphBlocks(text: string): MaterialParagraphBlock[] {
  const blocks: MaterialParagraphBlock[] = [];
  const len = text.length;
  let runStart = -1;
  let runEnd = -1;
  let runLines = 0;

  const flush = () => {
    if (runStart >= 0) {
      const body = text.slice(runStart, runEnd);
      const noNumber = runLines === 1 && (THEMATIC_BREAK_RE.test(body) || MARKER_LINE_RE.test(body));
      if (!noNumber) blocks.push({ start: runStart, end: runEnd });
      runStart = -1;
      runEnd = -1;
      runLines = 0;
    }
  };

  let lineStart = 0;
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? len : nl;
    let s = lineStart;
    while (s < lineEnd && isWsCode(text.charCodeAt(s))) s++;
    if (s >= lineEnd) {
      flush(); // 空白行 = 段落分界
    } else {
      let e = lineEnd;
      while (e > s && isWsCode(text.charCodeAt(e - 1))) e--;
      if (runStart < 0) runStart = s;
      runEnd = e;
      runLines += 1;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  flush();
  return blocks;
}

/**
 * 剥离派生 .md 中的章标记行（composeDerivedText 的逆）：删标记行 + 紧随的一行组合空行
 * （组合形态 = 标记 + 空行 + 章正文，该空行是组合自带的——原章尾空行在标记**之前**，保留）。
 * 用户手写标记无空行纪律时只删标记行；多余/缺失空行由 canonicalBlank 宽容比较吸收。
 */
export function stripChapterMarkerLines(derived: string): string {
  const lines = derived.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_LINE_RE.test(lines[i].trim())) {
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '') i += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join('\n');
}

/** 空行纪律宽容比较基（手改标记引入的多余/缺失空行不算内容变更）。 */
function canonicalBlank(text: string): string {
  return text.replace(/\n{2,}/g, '\n\n').trim();
}

// ── 字幕分支：书面化整理（E10.2a design §2.3——srt/ass/vtt 摄取的 LLM 整理档）──

/** 整理分段字符预算：按 SubtitleParagraph 边界装箱（段界对齐停顿段界——锚定不跨段错位）。 */
export const SEGMENT_CHAR_BUDGET = 6000;

/** 整理分段数封顶（≈4-5h 视频量级）：超限**整体降级**纯拼合 + note（不静默截断——截断即隐性丢内容）。 */
export const MAX_POLISH_SEGMENTS = 12;

/** 整理档独立输出预算（经 generate seam 的 maxTokens 参数下传；〔F-02〕不 mirror 分章兜底 4096——那是小 JSON 输出的预算，整理是生成式保义改写，6000 字段输出需 3-4k tokens + 余量）。 */
export const POLISH_MAX_TOKENS = 8000;

/** 截断防御阈：某段响应字数低于该段输入字数此比例 → 判截断 → 整体降级（不落半截整理稿——保义红线）。 */
const POLISH_TRUNCATION_RATIO = 0.7;

/** 字幕格式判定（MATERIAL_FORMATS 的 srt/ass/vtt 子集——文本获取分支与 medium 默认共用）。 */
export function isSubtitleFormat(format: MaterialFormat): format is SubtitleFormat {
  return format === 'srt' || format === 'ass' || format === 'vtt';
}

/** 字幕降级 note 单源（fresh 降级与 CR-3 REUSE 路径 note 重建共用同一文案形状）。 */
function subtitleDegradeNote(reason: string): string {
  return `字幕未经书面化整理（${reason}）——已落纯拼合文本，检索照常。`;
}

// ── CR-1：超预算单段二次切分（B 站自动字幕形态的整理可达性）──
//
// 自动字幕停顿 ≪1.5s（gapMs 分段阈），30-60min 视频 join 塌成 20k-40k 字**单段**——8000
// tokens 输出上限 + 截断判定数学上不可达 → 主用例全体静默降级。修法：对超预算段按句末标点
// 在预算边界**就近**切（不硬截语义中间）；无句末标点的极端流保持整段不硬切（由截断判定降级
// + note 诚实回报——mirror「候选超预算挂起」纪律〔F-07〕）。

/** 句末标点集合（切分锚点）：CJK 句读全族 + ASCII 对应形态（'.' 需后随空白/结尾——防「3.5 万」数字误切）。 */
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '；', '…', '!', '?', ';']);

function isSentenceEndAt(text: string, index: number): boolean {
  const ch = text[index];
  if (SENTENCE_END_CHARS.has(ch)) return true;
  if (ch === '.') {
    const next = text[index + 1];
    return next === undefined || next === '\n' || next === ' ' || next === '\t';
  }
  return false;
}

/**
 * 超预算段按句末标点就近切分：在 `(start, start+budget]` 窗口内取**最右**句末标点为切点
 * （块长 ≤ budget）；窗口内无句末标点 → 不硬截，余下保持整段（极端流降级路径处理）。
 * 纯函数、无损（pieces.join('') === segment）。
 */
function splitSegmentAtSentenceEnd(segment: string, budget: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (segment.length - start > budget) {
    let cut = -1;
    for (let i = start + budget; i > start; i--) {
      if (isSentenceEndAt(segment, i - 1)) {
        cut = i;
        break;
      }
    }
    if (cut === -1) break;
    pieces.push(segment.slice(start, cut));
    start = cut;
  }
  pieces.push(segment.slice(start));
  return pieces;
}

/**
 * 整理稿输出净化（CR-9）：LLM 输出直落派生 .md 前过 normalizeMaterialText（BOM/CRLF/CR）+
 * 剥行首 markdown ATX 标题前缀（`# 标题` 行会被 69 格式分章误判章界——chapter-splitting
 * stripAtx 同式 `^#{1,6}[ \t]+`，行首空白容忍是 scanLines trim 的超集）+ 3+ 连空行折一段
 * 空行 + 行尾空白。纯函数，never-throws。
 */
function sanitizePolishOutput(text: string): string {
  return normalizeMaterialText(text)
    .split('\n')
    .map((line) => line.replace(/^[\t ]*#{1,6}[\t ]+/, '').replace(/[\t ]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 字幕书面化整理 system prompt（R3）：口语转书面（加标点/去口癖/合并碎句/画面指代改写）；
 * 红线 = 保义（不引入原文没有的主张、不删减信息、不改技术术语）；双语混排保留语言形态
 * 不翻译不剥离（仅书面化）；输出纯文本段落空行分段（整理稿段落 = LLM 输出段落——替换
 * normalized 基面前重算段落结构，锚定基面 = 整理稿派生 .md）。
 */
export const SUBTITLE_POLISH_SYSTEM_PROMPT = [
  '你是字幕书面化整理器。输入是视频字幕的拼合文本：按停顿分段的口语转录，标点缺失、碎句多。',
  '请把它整理成可读的书面文字：',
  '1. 补全标点，按语义断句，合理分段；',
  '2. 删除重复的语气词与口癖（「嗯」「啊」「就是说」「对吧」这类无信息量的重复），合并被切碎的短句；',
  '3. 画面指代（如「看这里」「如图」「大家看这个」）改写为不依赖画面的表述，无法改写处标注〔画面演示〕；',
  '4. 双语混排（中英/中日等交错）时保留原有语言形态：不翻译、不删除其中任何一种语言，仅做书面化整理。',
  '红线（必须遵守）：不引入原文没有的主张或信息；不删减原文的信息；不改动技术术语、产品名、人名等专有名词。',
  '输出：纯文本正文，段落之间用一个空行分隔，段落数量与输入大致相当；不要输出任何解释、标题、列表标记或前后缀。',
].join('\n');

/**
 * 按 SubtitleParagraph 边界装箱分段：段 = 整段落组（不跨段拆分）；装箱后超预算的单段按
 * 句末标点在预算边界就近二次切分（CR-1——密集无停顿字幕的整理可达性，见上方块注释）；
 * 无句末标点的极端流保持整段自成一箱（停顿段界与句读双缺时不硬截语义——降级判定处理）。
 */
export function boxPolishSegments(paragraphs: readonly SubtitleParagraph[], budget: number = SEGMENT_CHAR_BUDGET): string[] {
  const segments: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.text === '') continue;
    if (current === '') {
      current = paragraph.text;
      continue;
    }
    const merged = `${current}\n\n${paragraph.text}`;
    if (merged.length > budget) {
      segments.push(current);
      current = paragraph.text;
    } else {
      current = merged;
    }
  }
  if (current !== '') segments.push(current);
  // CR-1：超预算单段二次切分（装箱只会让单段超预算——多段合并恒 ≤ budget）。
  return segments.flatMap((segment) => (segment.length > budget ? splitSegmentAtSentenceEnd(segment, budget) : [segment]));
}

export interface SubtitlePolishOutcome {
  /** 整理稿（全段成功）或纯拼合文本（降级——材料仍 ready、检索照常）。 */
  text: string;
  notes: string[];
}

/**
 * 字幕书面化整理（never-throws——一切失败形态降级纯拼合 + parseNote 诚实标注，材料不失败）：
 * 分段装箱 → 串行逐段 generate（API 并发纪律）→ 全段成功才落整理稿；未装配 / 调用失败 /
 * 空回复 / 截断（finishReason='length' 权威信号；缺省回退 70% 比值法——CR-2）/ 段数超限 →
 * **整体降级**（不落半截整理稿——保义红线，mirror「候选超预算挂起」的诚实纪律〔F-07〕）。
 * 调用点在 decideChapters 之前（分章看到的是书面化文本）。输出经 sanitizePolishOutput 净化
 * （CR-9——BOM/CRLF/ATX 标题前缀/3+ 连空行不直落派生 .md）。
 */
async function polishSubtitleText(
  paragraphs: readonly SubtitleParagraph[],
  deps: MaterialIngestDeps,
): Promise<SubtitlePolishOutcome> {
  const joined = paragraphs.map((p) => p.text).join('\n\n');
  const degrade = (reason: string): SubtitlePolishOutcome => ({
    text: joined,
    notes: [subtitleDegradeNote(reason)],
  });
  const generate = deps.generateText ?? llmCore?.generateText;
  if (!generate) return degrade('LLM 整理内核未装配');
  const segments = boxPolishSegments(paragraphs);
  if (segments.length > MAX_POLISH_SEGMENTS) {
    return degrade(`分段数 ${segments.length} 超过上限 ${MAX_POLISH_SEGMENTS}，为避免静默截断已整体降级`);
  }
  const polished: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    let responseText = '';
    let finishReason: GenerationFinishReason | undefined;
    try {
      const response = await generate({ system: SUBTITLE_POLISH_SYSTEM_PROMPT, user: segment, maxTokens: POLISH_MAX_TOKENS });
      responseText = sanitizePolishOutput(response?.text ?? '');
      finishReason = response?.finishReason;
    } catch (err) {
      return degrade(`第 ${i + 1}/${segments.length} 段整理调用失败：${errMsg(err)}`);
    }
    if (responseText === '') {
      return degrade(`第 ${i + 1}/${segments.length} 段整理返回空回复`);
    }
    // CR-2 截断判定：finishReason 是权威信号——'length' → 截断降级（真截断恰留 >70% 时比值法
    // 假阴性，半截稿落盘违保义红线）；存在且非 'length' → 通过（合法浓缩去语气词可缩 30%+，
    // 比值法假阳性会误杀已花的 LLM 工作）；缺省（端点未回报）→ 回退既有 70% 比值法。
    if (finishReason !== undefined) {
      if (finishReason === 'length') {
        return degrade(`第 ${i + 1}/${segments.length} 段整理因输出长度上限截断（finishReason='length'）`);
      }
    } else if (responseText.length < segment.length * POLISH_TRUNCATION_RATIO) {
      return degrade(
        `第 ${i + 1}/${segments.length} 段响应疑似截断（返回 ${responseText.length} 字，不足输入 ${segment.length} 字的七成）`,
      );
    }
    polished.push(responseText);
  }
  return { text: polished.join('\n\n'), notes: [`字幕已书面化整理（${segments.length} 段）。`] };
}

// ── 两段式分章（design §4.2 / D2）──

/** 原文基面章边界（归一化文本上的半开区间）。 */
interface ChapterBoundary {
  start: number;
  end: number;
  title: string | null;
}

interface ChapteringVerdict {
  boundaries: ChapterBoundary[];
  method: MaterialChapterMethod;
  confidence: MaterialChapterConfidence;
  matchedFormats: string[];
  llmCapped?: boolean;
  notes: string[];
}

/** LLM 兜底 system 文案（约束式：只能从候选行号中选，不可幻位置）。 */
export const MATERIAL_LLM_FALLBACK_SYSTEM_PROMPT =
  '你是长文档结构分析器。给定候选行清单（行号 | 候选文本 | 上文 | 下文），从中识别真正标志章节起始的行。你只能从候选行号中选择——绝不允许输出候选集之外的行号。只输出 JSON：{"selected":[行号,...]}；没有可靠章界就输出 {"selected":[]}。不要输出任何其他文字。';

/** 候选行 ±1 行局部上下文截断（行文可控、prompt 体量有界）。 */
const PROMPT_CONTEXT_MAX_CHARS = 40;

/** 候选行约束式 prompt（纯函数，导出供直测）。 */
export function buildChapterFallbackPrompt(candidates: readonly HeadingCandidate[], lines: readonly string[]): string {
  const rows = candidates.map((c) => {
    const prev = (lines[c.lineIndex - 1] ?? '').trim().slice(0, PROMPT_CONTEXT_MAX_CHARS);
    const next = (lines[c.lineIndex + 1] ?? '').trim().slice(0, PROMPT_CONTEXT_MAX_CHARS);
    return `${c.lineIndex} | ${c.text} | 上文:${prev || '(无)'} | 下文:${next || '(无)'}`;
  });
  return [
    '<候选行>',
    ...rows,
    '</候选行>',
    `共 ${candidates.length} 行候选。选出真正标志章节起始的行号，以纯 JSON 输出 {"selected":[行号,...]}；宁缺毋滥，没有可靠章界就输出 {"selected":[]}。`,
  ].join('\n');
}

/**
 * 解析 LLM 兜底响应（约束校验）：任一返回行号非整数/不在候选集内 → **整体拒收**返回 null
 * （约束式契约违反 = 输出不可信，不做部分采纳——不硬给、不编位置）。合法返回去重升序；
 * 空数组 = LLM 明确判定无章界（合法诚实负判，调用方挂起处理）。
 */
export function parseChapterFallbackResponse(raw: string, candidateLineIndexes: ReadonlySet<number>): number[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { selected?: unknown }).selected)) {
    return null;
  }
  const out: number[] = [];
  for (const value of (parsed as { selected: unknown[] }).selected) {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    if (!candidateLineIndexes.has(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
}

/** 行首偏移表（物理行 0 起——与 extractHeadingCandidates.lineIndex 同约定）。 */
function lineStartOffsets(text: string): number[] {
  const starts: number[] = [0];
  let i = text.indexOf('\n');
  while (i !== -1) {
    starts.push(i + 1);
    i = text.indexOf('\n', i + 1);
  }
  return starts;
}

/** 把边界序列补成无缝覆盖 [0, textLength]（空白缺口并入前章尾/前导空白并入首章头）。 */
function tileBoundaries(boundaries: ChapterBoundary[], textLength: number): ChapterBoundary[] {
  if (boundaries.length === 0) return [];
  const tiled = boundaries.map((b) => ({ ...b }));
  tiled[0].start = 0;
  for (let i = 1; i < tiled.length; i++) {
    if (tiled[i].start > tiled[i - 1].end) tiled[i - 1].end = tiled[i].start;
    if (tiled[i].start < tiled[i - 1].end) tiled[i].start = tiled[i - 1].end;
  }
  tiled[tiled.length - 1].end = textLength;
  return tiled;
}

/** LLM 兜底一次（never-throws——一切失败形态返回挂起原因，由调用方落 low-confidence）。 */
async function runLlmChapterFallback(
  normalized: string,
  deps: MaterialIngestDeps,
): Promise<{ boundaries: ChapterBoundary[]; notes: string[]; llmCapped?: boolean }> {
  const candidates = extractHeadingCandidates(normalized);
  if (candidates.length > MATERIAL_LLM_CANDIDATE_BUDGET) {
    return {
      boundaries: [],
      llmCapped: true,
      notes: [
        `分章候选行 ${candidates.length} 条超过预算 ${MATERIAL_LLM_CANDIDATE_BUDGET}，为避免静默截断已挂起分章（章界待人工校对，检索照常）。`,
      ],
    };
  }
  if (candidates.length === 0) {
    return { boundaries: [], notes: ['低置信且无候选章标行，分章挂起（章界待人工校对，检索照常）。'] };
  }
  const generate = deps.generateText ?? llmCore?.generateText;
  if (!generate) {
    return { boundaries: [], notes: ['LLM 兜底内核未装配，分章挂起（章界待人工校对，检索照常）。'] };
  }
  let responseText = '';
  try {
    const response = await generate({
      system: MATERIAL_LLM_FALLBACK_SYSTEM_PROMPT,
      user: buildChapterFallbackPrompt(candidates, normalized.split('\n')),
    });
    responseText = (response?.text ?? '').trim();
  } catch (err) {
    return {
      boundaries: [],
      notes: [
        `LLM 兜底调用失败（${err instanceof Error ? err.message : String(err)}），分章挂起（章界待人工校对，检索照常）。`,
      ],
    };
  }
  if (!responseText) {
    return { boundaries: [], notes: ['LLM 兜底返回空回复，分章挂起（章界待人工校对，检索照常）。'] };
  }
  const candidateIndexes = new Set(candidates.map((c) => c.lineIndex));
  const selected = parseChapterFallbackResponse(responseText, candidateIndexes);
  if (selected === null) {
    return {
      boundaries: [],
      notes: ['LLM 返回的行号不在候选集内（约束校验失败），整体拒收回退挂起（不硬给章界）。'],
    };
  }
  if (selected.length === 0) {
    return { boundaries: [], notes: ['LLM 判定候选行均非可靠章界，分章挂起（章界待人工校对，检索照常）。'] };
  }
  // 切点 = 选中行行首；段界半开区间（纯空白段跳过——mirror splitChapters 章段规则）。
  const starts = lineStartOffsets(normalized);
  const titleByLineIndex = new Map(candidates.map((c) => [c.lineIndex, c.text] as const));
  const cuts = [...new Set([0, ...selected.map((li) => starts[li]), normalized.length])]
    .filter((o) => o !== undefined)
    .sort((a, b) => a - b);
  const boundaries: ChapterBoundary[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (normalized.slice(start, end).trim() === '') continue;
    const title =
      selected.map((li) => (starts[li] === start ? titleByLineIndex.get(li) : undefined)).find((t) => t !== undefined) ??
      null;
    boundaries.push({ start, end, title: title ?? null });
  }
  return { boundaries, notes: [] };
}

/** 两段式分章分流（design §4.2）。返回 verdict（boundaries 在归一化原文基面）。 */
async function decideChapters(normalized: string, deps: MaterialIngestDeps): Promise<ChapteringVerdict> {
  const split = splitChapters(normalized);
  if (split.confidence !== 'low') {
    return {
      boundaries: split.chapters.map((c) => ({ start: c.charStart, end: c.charEnd, title: c.title })),
      method: 'regex',
      confidence: split.confidence,
      matchedFormats: split.matchedFormats,
      notes: [],
    };
  }
  if (normalized.length < MATERIAL_LLM_FALLBACK_MIN_CHARS) {
    // CR-002：正则命中 ≥1（matchedFormats 非空）的短篇**真实章界不被伪章吞掉**——<2 万字
    // 且命中 <3 只是「情报不足高置信」，章界本身是真的：沿用 regex 章界 + confidence='low'
    // 诚实标注（不拔高）。零命中才伪章直进（讲义/访谈类章标无意义，不烧调用〔F-09/F-25〕）。
    if (split.matchedFormats.length > 0) {
      return {
        boundaries: split.chapters.map((c) => ({ start: c.charStart, end: c.charEnd, title: c.title })),
        method: 'regex',
        confidence: 'low',
        matchedFormats: split.matchedFormats,
        notes: ['正则章界命中未达高置信门槛（<3 命中或大段游离），已保留正则章界并按低置信标注（如章界有误请校对派生 .md）。'],
      };
    }
    return {
      boundaries: [{ start: 0, end: normalized.length, title: null }],
      method: 'none',
      confidence: 'low',
      matchedFormats: split.matchedFormats,
      notes: [],
    };
  }
  const fallback = await runLlmChapterFallback(normalized, deps);
  return {
    boundaries: fallback.boundaries,
    method: 'llm-fallback',
    confidence: 'low',
    matchedFormats: split.matchedFormats,
    ...(fallback.llmCapped ? { llmCapped: true } : {}),
    notes: fallback.notes,
  };
}

// ── 派生文本组合与 span 装配 ──

export interface ComposedChapterSpan {
  charStart: number;
  charEnd: number;
  paraStart: number;
  paraEnd: number;
}

/**
 * 组合派生 .md 文本（标记 + 空行 + 章正文）并计算最终 char span（基面 = 派生文本）：
 * 章正文起于其标记之后；章 charEnd = 下一章标记行行首（标记行不属于任何章 span）。
 * 输入 boundaries 须已 tile（无缝覆盖全文）。
 */
export function composeDerivedText(
  normalized: string,
  boundaries: ReadonlyArray<ChapterBoundary>,
  method: MaterialChapterMethod,
  confidence: MaterialChapterConfidence,
): { derived: string; spans: Array<{ charStart: number; charEnd: number }> } {
  const parts: string[] = [];
  const spans: Array<{ charStart: number; charEnd: number }> = [];
  let offset = 0;
  boundaries.forEach((boundary, i) => {
    const markerLine = serializeChapterMarkers([{ index: i, title: boundary.title, method, confidence }]);
    const prefix = `${markerLine}\n\n`;
    const textStart = offset + prefix.length;
    parts.push(prefix, normalized.slice(boundary.start, boundary.end));
    spans.push({ charStart: textStart, charEnd: textStart + (boundary.end - boundary.start) });
    offset = textStart + (boundary.end - boundary.start);
  });
  return { derived: parts.join(''), spans };
}

/**
 * 章段落区间装配（para 基面 = 派生文本段落序，splitParagraphBlocks）：章区间取**与
 * [charStart, charEnd) 相交**的段落块范围（边界落在段中时相邻章共享该段——诚实重叠，
 * 与 chunkChapter 章切片局部段号对齐）。
 */
export function mapParagraphRanges(
  derived: string,
  spans: ReadonlyArray<{ charStart: number; charEnd: number }>,
): ComposedChapterSpan[] {
  const blocks = splitParagraphBlocks(derived);
  return spans.map(({ charStart, charEnd }) => {
    let paraStart = -1;
    let paraEnd = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].end > charStart && blocks[i].start < charEnd) {
        if (paraStart === -1) paraStart = i;
        paraEnd = i + 1;
      }
    }
    if (paraStart === -1) {
      // 纯空白章（防御——tile 后不应出现）：空段区间落在其后首段位。
      const next = blocks.findIndex((b) => b.start >= charStart);
      paraStart = paraEnd = next === -1 ? blocks.length : next;
    }
    return { charStart, charEnd, paraStart, paraEnd };
  });
}

// ── 既有派生 .md 重建（manual 保留 / 自动存档 reuse）──

export interface RebuiltChapter {
  charStart: number;
  charEnd: number;
  paraStart: number;
  paraEnd: number;
  title: string | null;
  method: MaterialChapterMethod;
  confidence: MaterialChapterConfidence;
}

export interface MarkerRebuild {
  derived: string;
  chapters: RebuiltChapter[];
  docMethod: MaterialChapterMethod;
  docConfidence: MaterialChapterConfidence;
}

/**
 * 从既有派生 .md 的标记行重建章界（**行位置是权威边界**——index 属性仅元数据）：章起点 =
 * 标记行之后首个非空且非标记行；章终点 = 下一标记行行首（末章到文末）。空章（相邻标记无
 * 正文）跳过；首标记前的正文合成前置章（method='manual'——用户删首标记 = 人工策展态）。
 * matchedFormats 不随标记存档，重建时置 []（信息性字段，原件变更重跑自动路径时恢复）。
 */
export function rebuildChaptersFromMarkers(derived: string, markers: readonly ParsedChapterMarker[]): MarkerRebuild {
  const lines = derived.split('\n');
  const lineStarts = lineStartOffsets(derived);
  const isSkippable = (lineIndex: number) =>
    lineIndex >= lines.length || lines[lineIndex].trim() === '' || MARKER_LINE_RE.test(lines[lineIndex].trim());

  // 内容起点（首个非空非标记行）。
  let contentStartLine = 0;
  while (contentStartLine < lines.length && isSkippable(contentStartLine)) contentStartLine++;

  const raw: Array<{ charStart: number; charEnd: number; title: string | null; method: MaterialChapterMethod; confidence: MaterialChapterConfidence }> = [];

  // 首标记前正文 → 前置章（人工策展态）。
  if (markers.length > 0 && contentStartLine < lines.length) {
    const firstMarkerStart = lineStarts[markers[0].lineIndex] ?? derived.length;
    const leadingStart = lineStarts[contentStartLine];
    if (leadingStart < firstMarkerStart && derived.slice(leadingStart, firstMarkerStart).trim() !== '') {
      raw.push({ charStart: leadingStart, charEnd: firstMarkerStart, title: null, method: 'manual', confidence: 'manual' });
    }
  }

  markers.forEach((marker, i) => {
    let startLine = marker.lineIndex + 1;
    while (startLine < lines.length && isSkippable(startLine)) startLine++;
    const endOffset = i + 1 < markers.length ? lineStarts[markers[i + 1].lineIndex] : derived.length;
    if (startLine >= lines.length || (lineStarts[startLine] ?? derived.length) >= endOffset) return; // 空章跳过
    raw.push({
      charStart: lineStarts[startLine],
      charEnd: endOffset,
      title: marker.title,
      method: marker.method,
      confidence: marker.confidence ?? (marker.method === 'manual' ? 'manual' : 'low'),
    });
  });

  const paras = mapParagraphRanges(derived, raw.map(({ charStart, charEnd }) => ({ charStart, charEnd })));
  const chapters: RebuiltChapter[] = raw.map((c, i) => ({ ...c, paraStart: paras[i].paraStart, paraEnd: paras[i].paraEnd }));
  const anyManual = chapters.some((c) => c.method === 'manual');
  return {
    derived,
    chapters,
    docMethod: anyManual ? 'manual' : markers[0]?.method ?? 'manual',
    docConfidence: anyManual ? 'manual' : markers[0]?.confidence ?? 'low',
  };
}

// ── 主入口 ──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── CR-10：GBK/GB18030 字幕回退解码（UTF-8-only 解码的 mojibake 修复）──
//
// GBK 字幕经 UTF-8-only 解码：时间码/ASCII 存活 + 中文全替换符 → 垃圾正文 ready 落库仅
// parseNote。修法：utf8 替换率超阈（复用 docParsing NON_UTF8_SUSPECT_RATIO 判据）时用
// TextDecoder('gb18030') 二次解码**择优**（回退解码替换率仍 ≤ 阈才采用）+ note 记录；
// 择优失败保持既有 UTF-8 路径 + mojibake 警告（nonUtf8 降级语义不变）。

/** GB18030 二次解码 best-effort：small-icu 构建无该 label 时 TextDecoder 抛错 → null（回退 UTF-8 路径）。 */
function decodeGb18030BestEffort(buffer: Buffer): string | null {
  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return null;
  }
}

/** 已解码文本的替换字符（U+FFFD）占比——gb18030 解码结果的择优判据（utf8ReplacementCharRatio 的解码后形态）。 */
function textReplacementCharRatio(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count / text.length;
}

function sha256Content(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/** 解析内核失败 reason → 摄取失败 reason（unsupported → unsupported-format；too-large-pdf → too-large）。 */
function mapParseFailureReason(reason: 'missing' | 'empty' | 'unsupported' | 'too-large-pdf' | 'read-failed' | 'parse-failed'):
  | 'missing'
  | 'empty'
  | 'unsupported-format'
  | 'too-large'
  | 'read-failed'
  | 'parse-failed' {
  if (reason === 'unsupported') return 'unsupported-format';
  if (reason === 'too-large-pdf') return 'too-large';
  return reason;
}

/**
 * 摄取一份材料（watcher/重摄取/批量导入的公共编排，never-throws）。
 *
 * 路径逃逸抛错（模式 B invariant）；其余一切失败（拒收/缺文件/坏档/扫描件/LLM 挂起）结构化
 * 返回。成功路径恒返回可 `materialSchema.parse` 的 Material 域对象（shared-contracts
 * material.test.ts 集成钉形状）。
 */
export async function ingestMaterial(
  scopeInput: MaterialIngestScope,
  sourceRelPath: string,
  deps: MaterialIngestDeps = {},
): Promise<IngestMaterialResult> {
  const parse = deps.parse ?? parseDocumentToMarkdown;
  const now = deps.now ?? (() => new Date());
  const onRegistered = deps.onRegistered ?? (async () => {});

  // 1) 相对路径守卫 + 白名单（三档拒收之一：unsupported-format）。
  const rel = normalizeMaterialRelPath(sourceRelPath);
  if (rel === null) {
    return {
      ok: false,
      reason: 'invalid-path',
      error: `非法材料路径：${sourceRelPath}（需为 materials 内相对路径，排除 .derived/ 与隐藏段）。`,
    };
  }
  const ext = path.posix.extname(rel).toLowerCase();
  const format = FORMAT_BY_EXTENSION[ext];
  if (format === undefined) {
    return {
      ok: false,
      reason: 'unsupported-format',
      rejection: 'unsupported-format',
      error: `不支持的原料格式：${ext || '(无扩展名)'}（支持 TXT / MD / DOCX / PDF / EPUB / SRT / ASS / VTT）`,
    };
  }

  const sourceAbs = path.resolve(scopeInput.materialsRoot, rel);
  try {
    assertWithinProject(scopeInput.materialsRoot, sourceAbs);
  } catch {
    return { ok: false, reason: 'invalid-path', error: `材料路径越出车道根：${sourceRelPath}` };
  }

  // 2) stat 门（missing / too-large 三档拒收之二）。
  let fileSize: number;
  try {
    fileSize = (await stat(sourceAbs)).size;
  } catch {
    return { ok: false, reason: 'missing', error: `材料文件不存在或无法访问：${rel}` };
  }
  if (fileSize > MATERIAL_MAX_FILE_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      rejection: 'too-large',
      error: `材料文件过大（${Math.round(fileSize / 1024 / 1024)}MB，超过 ${Math.round(MATERIAL_MAX_FILE_BYTES / 1024 / 1024)}MB 上限）。`,
    };
  }

  // 3) 文本获取：字幕分支（E10.2a design §2.4——readFile → parseSubtitle → joinSubtitleCues，
  //    不经共享解析内核；整理稿在幂等门（5）后、decideChapters（6）前替换基面，见 5b）或
  //    共享解析内核（materialsRoot 即解析根——守卫过的 rel 必在其内）。
  const subtitleFormat: SubtitleFormat | null = isSubtitleFormat(format) ? format : null;
  let parsedContent = '';
  let via: string;
  let scanned = false;
  let nonUtf8 = false;
  /** 字幕确定性拼合基面（幂等判定 + contentHash 身份——整理稿非确定不入身份）；非字幕 ''。 */
  let subtitleJoined = '';
  /** 字幕整理输入（非字幕恒 null；幂等门自愈路径置 null = 取消整理）。 */
  let subtitleParagraphs: readonly SubtitleParagraph[] | null = null;
  let parseNotes: string[];

  if (subtitleFormat !== null) {
    let buffer: Buffer;
    try {
      buffer = await readFile(sourceAbs);
    } catch (err) {
      return { ok: false, reason: 'read-failed', error: `读取文件失败：${errMsg(err)}` };
    }
    if (buffer.length === 0) {
      return { ok: false, reason: 'empty', error: `材料无可提取文本：${rel}` };
    }
    via = 'builtin-subtitle';
    const subtitleNotes: string[] = [];
    let subtitleText: string;
    if (utf8ReplacementCharRatio(buffer) > NON_UTF8_SUSPECT_RATIO) {
      // CR-10：疑似非 UTF-8 → GB18030 二次解码择优（回退解码替换率仍低才采用）。
      const gbDecoded = decodeGb18030BestEffort(buffer);
      if (gbDecoded !== null && textReplacementCharRatio(gbDecoded) <= NON_UTF8_SUSPECT_RATIO) {
        subtitleText = gbDecoded;
        nonUtf8 = false;
        subtitleNotes.push('字幕文件疑似 GBK/GB18030 编码：已按 GB18030 解码（如仍有乱码请转存为 UTF-8 后重新摄取）。');
      } else {
        nonUtf8 = true;
        subtitleNotes.push('疑似非 UTF-8 编码（GBK/GB18030 等）——已按 UTF-8 解码，正文可能出现乱码；建议先转存为 UTF-8 后重新解析。');
        subtitleText = decodeTextDocument(buffer);
      }
    } else {
      nonUtf8 = false;
      subtitleText = decodeTextDocument(buffer);
    }
    const { cues, notes } = parseSubtitle(subtitleText, subtitleFormat);
    subtitleNotes.push(...notes);
    const paragraphs = joinSubtitleCues(cues);
    const joined = paragraphs.map((p) => p.text).join('\n\n');
    if (joined.trim() === '') {
      // 完全无文本（空 cue / 纯时间码 / 非字幕内容）→ durable 拒收（parse-failed 既有路径，AC7）。
      return {
        ok: false,
        reason: 'parse-failed',
        error: `字幕无可提取文本：${rel}（${notes.join('；') || '未解析出字幕内容'}）——可能不是字幕文件或结构已损坏。`,
      };
    }
    subtitleParagraphs = paragraphs;
    subtitleJoined = joined;
    parseNotes = subtitleNotes;
  } else {
    const parsed = await parse(scopeInput.materialsRoot, rel);
    if (!parsed.ok) {
      if (parsed.reason === 'scanned') {
        return {
          ok: false,
          reason: 'scanned',
          error: `${parsed.error}材料摄取需要可检索文本——请配置文档解析端点（设置「研究与视觉」）后重试。`,
        };
      }
      return { ok: false, reason: mapParseFailureReason(parsed.reason), error: parsed.error };
    }
    parsedContent = parsed.content;
    via = parsed.via;
    scanned = parsed.scanned === true;
    nonUtf8 = parsed.nonUtf8 === true;
    parseNotes = [...parsed.notes];
  }

  // 4) 归一化 + 空文本守卫（mirror docx CR-014——近空文本不冒充成功；字幕基面 = 确定性拼合
  //    文本，空档已在分支内守卫，此处 belt 对五格式路径不变）。
  let normalized = normalizeMaterialText(subtitleFormat !== null ? subtitleJoined : parsedContent);
  if (normalized.trim() === '') {
    return { ok: false, reason: 'empty', error: `材料无可提取文本：${rel}` };
  }

  const derivedRel = derivedRelPathFor(rel);
  const derivedAbs = path.resolve(scopeInput.materialsRoot, derivedRel);
  try {
    assertWithinProject(scopeInput.materialsRoot, derivedAbs);
  } catch {
    return { ok: false, reason: 'invalid-path', error: `派生路径越出车道根：${derivedRel}` };
  }

  // 5) 既有派生 .md 幂等判定（F-03：manual 保留 / 自动存档未变保留）。
  // CR-017：读取即归一（BOM strip + CRLF/CR→LF）——外部编辑器 CRLF 重存不算「内容已变更」；
  // 标记解析/章界重建/写跳过比较全用同一 LF 基面（派生文件本身不重写，磁盘形态保留）。
  let existingDerived: string | null = null;
  try {
    existingDerived = normalizeMaterialText(await readFile(derivedAbs, 'utf-8'));
  } catch {
    existingDerived = null; // 缺失/不可读 → 新鲜路径
  }

  if (existingDerived !== null) {
    const markers = parseChapterMarkers(existingDerived);
    const reconstructed = stripChapterMarkerLines(existingDerived);
    if (subtitleFormat !== null) {
      // E10.2a 字幕幂等（design §2.3「原件 hash 门控」）：整理稿是 LLM 产物**非确定**——
      // 「原件未变」判定基面 = 确定性拼合文本（登记 contentHash 对字幕材料 = 拼合 hash）：
      // 一致 → 未变（时间码-only 编辑拼合不变同判未变——语义身份正确）；登记缝不可用时退回
      // 拼合直比（上次降级路径可命中；整理过的只有重跑一条路——生产登记缝恒在，materialIndexer）。
      const joinedHash = sha256Content(subtitleJoined);
      const registeredHash = await readRegisteredContentHash(
        deps,
        materialIdFor(scopeInput.scope, materialSourcePath(scopeInput.scope, rel)),
      );
      const unchanged =
        registeredHash === joinedHash ||
        (registeredHash === null && canonicalBlank(reconstructed) === canonicalBlank(normalized));
      if (unchanged) {
        // CR-11：自愈路径 empty 守卫（mirror docx CR-014）——派生 .md 被清空而登记 hash 仍
        // 匹配时，不得装配 ready 空材料（下方无标记自愈会把空 reconstructed 当基面直进）。
        if (reconstructed.trim() === '') {
          return {
            ok: false,
            reason: 'empty',
            error: `派生 .md 已被清空而登记内容未变：${rel}——请恢复派生文件或删除后重新摄取。`,
          };
        }
        // CR-3（A 案，2026-09-05 拍板）：「从未整理成功」（derived = 纯拼合）且 generateText
        // 可用 → 自动重烧整理（走 fresh 同路径——subtitleParagraphs 留给 5b 消费，成功后恢复
        // 正常幂等）；LLM 不可用 → 保持 REUSE 纯拼合体，降级 note 按实际状态重建（不抹除）。
        // 已整理材料（或派生含人工编辑）REUSE 不重烧——幂等不破。
        const wasDegraded = canonicalBlank(reconstructed) === canonicalBlank(normalized);
        const generate = deps.generateText ?? llmCore?.generateText;
        const reheat = wasDegraded && generate !== undefined;
        if (markers.length > 0 && !reheat) {
          // REUSE：原件未变——沿用存档章界与已整理稿（含人工校对），不重整理不重写。
          const reuseNotes = [
            ...parseNotes,
            '原件未变更：沿用派生 .md 已存档的章界（人工标记优先保留）。',
            ...(wasDegraded
              ? [subtitleDegradeNote('LLM 整理内核未装配')]
              : ['字幕沿用已书面化整理稿（原件未变，不重烧整理）。']),
          ];
          return await assembleReusedFromMarkers({
            scopeInput,
            rel,
            derivedRel,
            format,
            via,
            scanned,
            nonUtf8,
            parseNotes: reuseNotes,
            charCount: reconstructed.length,
            contentHash: joinedHash,
            existingDerived,
            now,
            onRegistered,
            outcome: 'reused',
          });
        }
        if (markers.length === 0) {
          // 无标记（上次分章挂起的裸整理稿）：以既有派生文本为基面重试分章（自愈）；降级态
          // 且 LLM 可用时保留段落走 5b 重烧（一次摄取即愈，CR-3 A 案同源）。
          normalized = reconstructed;
          if (!reheat) subtitleParagraphs = null;
        }
        parseNotes.push(
          reheat
            ? '原件未变：上次为纯拼合降级态，已自动重新书面化整理。'
            : '原件未变更：沿用已整理文本重试分章（上次分章挂起）。',
        );
      } else {
        parseNotes.push(
          registeredHash === null
            ? '登记校验不可用，字幕已按本次解析重新整理。'
            : '原件内容已变更，字幕已重新解析并整理。',
        );
        noteManualMarkerLoss(markers, parseNotes);
      }
    } else {
      const unchanged = canonicalBlank(reconstructed) === canonicalBlank(normalized);
      if (unchanged && markers.length > 0) {
        // REUSE：原件未变——标记存档即裁决（manual 最高优先；自动类保真免重跑）。
        return await assembleReusedFromMarkers({
          scopeInput,
          rel,
          derivedRel,
          format,
          via,
          scanned,
          nonUtf8,
          parseNotes: [...parseNotes, '原件未变更：沿用派生 .md 已存档的章界（人工标记优先保留）。'],
          charCount: normalized.length,
          contentHash: sha256Content(normalized),
          existingDerived,
          now,
          onRegistered,
          outcome: 'reused',
        });
      }
      if (!unchanged) {
        // CR-001：先核原件身份（登记 content hash）——与本次解析一致 → 差异全部来自派生域的
        // 人工编辑：**不覆写派生、保留人工内容**（outcome='reingest-skipped-manual'，note 说明
        // 确认姿势）；hash 不同（或登记缝不可用）→ 原件真变了，走既有自动路径。
        const currentHash = sha256Content(normalized);
        const materialId = materialIdFor(scopeInput.scope, materialSourcePath(scopeInput.scope, rel));
        const registeredHash = await readRegisteredContentHash(deps, materialId);
        if (registeredHash === currentHash) {
          // C2 防清 belt 取数：markers=0（章标记丢失/被剥）重建必零章——取既有行以便保留
          // 章界（markers>0 时重建非空，无需取）；缝未装配/零章行 → null（诚实零章现状）。
          const registeredMaterial = markers.length === 0 ? await readRegisteredMaterialForBelt(deps, materialId) : null;
          return await assembleReusedFromMarkers({
            scopeInput,
            rel,
            derivedRel,
            format,
            via,
            scanned,
            nonUtf8,
            parseNotes: [
              ...parseNotes,
              '派生 .md 含人工编辑（原件未变更）：已保留人工内容未覆写——如需按原件重摄取，请先确认并移除/改名派生 .md 后重试。',
            ],
            charCount: normalized.length,
            contentHash: currentHash,
            existingDerived,
            registeredMaterial,
            now,
            onRegistered,
            outcome: 'reingest-skipped-manual',
          });
        }
        const similarity = shingleSimilarity(
          reconstructed.slice(0, ATTACHMENT_SAMPLE_MAX_CHARS),
          normalized.slice(0, ATTACHMENT_SAMPLE_MAX_CHARS),
        );
        parseNotes.push(
          similarity >= ATTACHMENT_SIMILARITY_THRESHOLD
            ? `原件内容小幅变更（相似度 ${similarity.toFixed(2)}），已重新自动分章。`
            : '原件内容已大幅变更，已重新自动分章。',
        );
        noteManualMarkerLoss(markers, parseNotes);
      }
    }
  }

  // 5b) 字幕书面化整理（E10.2a design §2.3）——幂等门之后（reused 不重烧）、decideChapters
  //     之前（分章看到的是书面化文本）；never-throws（一切失败形态降级纯拼合，检索不断线）。
  //     整理稿段落 = LLM 输出段落（重算段落结构后整体替换 normalized 基面）。
  if (subtitleParagraphs !== null) {
    const polished = await polishSubtitleText(subtitleParagraphs, deps);
    parseNotes.push(...polished.notes);
    normalized = polished.text;
  }

  // 6) 两段式分章 + 派生组合 + span 装配。
  const verdict = await decideChapters(normalized, deps);
  parseNotes.push(...verdict.notes);

  let derivedText: string;
  let chapterSpans: Array<ComposedChapterSpan & { title: string | null }>;
  if (verdict.boundaries.length === 0) {
    // 挂起（LLM 兜底失败/超限/负判）：不硬给章界——裸文本落盘（零章材料由 Wave C 索引器
    // 全文单伪章照索引，F-09「检索照常」）；无标记 = 重摄取时自动路径可重试（自愈）。
    derivedText = normalized;
    chapterSpans = [];
  } else {
    const tiled = tileBoundaries(verdict.boundaries, normalized.length);
    const composed = composeDerivedText(normalized, tiled, verdict.method, verdict.confidence);
    derivedText = composed.derived;
    const paras = mapParagraphRanges(derivedText, composed.spans);
    chapterSpans = tiled.map((b, i) => ({ ...paras[i], title: b.title }));
  }

  // 7) 落盘（内容逐字一致则跳过——避免 watcher 自写噪声〔F-12〕）。
  if (existingDerived !== derivedText) {
    try {
      mkdirSync(path.dirname(derivedAbs), { recursive: true });
      atomicWriteFileSync(derivedAbs, derivedText, 'utf-8');
    } catch (err) {
      getLogger().warn({ err: errMsg(err), derivedRel }, 'materialIngest: derived .md write failed');
      return { ok: false, reason: 'parse-failed', error: `派生 .md 写入失败：${derivedRel}（请检查磁盘权限后重试摄取）` };
    }
  }

  // 8) Material 装配 + 登记钩子。
  const material = assembleMaterial({
    scopeInput,
    rel,
    format,
    via,
    scanned,
    nonUtf8,
    parseNotes,
    charCount: normalized.length,
    // 字幕材料身份 = 确定性拼合 hash（整理稿非确定不入身份——幂等门基面，design §2.3）。
    contentHash: subtitleFormat !== null ? sha256Content(subtitleJoined) : sha256Content(normalized),
    chapters: chapterSpans.map((c, i) => ({
      index: i,
      title: c.title,
      charStart: c.charStart,
      charEnd: c.charEnd,
      paraStart: c.paraStart,
      paraEnd: c.paraEnd,
      confidence: verdict.confidence,
      method: verdict.method,
    })),
    chapterDetection: {
      method: verdict.method,
      confidence: verdict.confidence,
      matchedFormats: verdict.matchedFormats,
      ...(verdict.llmCapped ? { llmCapped: true } : {}),
    },
    now,
  });
  await notifyRegistered(onRegistered, material);
  return {
    ok: true,
    material,
    derivedRelPath: derivedRel,
    outcome: existingDerived === null ? 'fresh' : 'reingested',
  };
}

/** onRegistered 钩子统一包壳：失败 warn 不阻断（登记层 DERIVED，watcher/backfill 自愈）。 */
async function notifyRegistered(
  onRegistered: (material: Material) => Promise<void> | void,
  material: Material,
): Promise<void> {
  try {
    await onRegistered(material);
  } catch (err) {
    getLogger().warn(
      { err: errMsg(err), materialId: material.materialId },
      'materialIngest: onRegistered hook failed — registry is DERIVED, watcher/backfill will heal',
    );
  }
}

/** 标记重建章界 → Material.chapters 投影（reuse 与 reingest-skipped-manual 共用）。 */
function chaptersFromRebuilt(rebuilt: MarkerRebuild): Material['chapters'] {
  return rebuilt.chapters.map((c, i) => ({
    index: i,
    title: c.title,
    charStart: c.charStart,
    charEnd: c.charEnd,
    paraStart: c.paraStart,
    paraEnd: c.paraEnd,
    confidence: c.confidence,
    method: c.method,
  }));
}

// ── 幂等分支共享装配（CR-8）──
//
// REUSE（reused）/ 人工保留（reingest-skipped-manual）的「标记重建 → 装配 → 登记 → 返回」
// 块原在字幕/五格式姊妹分支各持一份复制且已发散（charCount 基面 / contentHash 基面）——正是
// CR-001 当年合并要防的漂移类。抽此共享函数，差异点显式参数化：
//   - `charCount`：字幕 = 剥标记重建文本长度；五格式 = 本次归一化解析长度；
//   - `contentHash`：字幕 = 确定性拼合 hash（幂等门基面，非整理稿）；五格式 = normalized hash；
//   - `outcome` / `parseNotes`：调用方按分支语义组装。
// 「未变判定谓词」与「内容变更路径」（CR-001 hash 先后顺序两分支相反——字幕 hash 优先、五格式
// blank 比对优先）语义真发散，留在各分支内联（见下方两分支注释），不强行塞参数。

interface ReuseAssembleInput {
  scopeInput: MaterialIngestScope;
  rel: string;
  derivedRel: string;
  format: MaterialFormat;
  via: string;
  scanned: boolean;
  nonUtf8: boolean;
  parseNotes: string[];
  /** 差异点①：REUSE 装配的字符计数基面（字幕 = reconstructed；五格式 = normalized）。 */
  charCount: number;
  /** 差异点②：REUSE 装配的 contentHash 基面（字幕 = 拼合 hash；五格式 = normalized hash）。 */
  contentHash: string;
  existingDerived: string;
  /**
   * C2 防清 belt：登记库既有行（markers=0 时调用方经 getRegisteredMaterial 缝取）。重建零章
   * 且既有行章界非空 → 保留既有 chapters + chapterDetection；null/缺省 = 无可保留（诚实零章）。
   */
  registeredMaterial?: Material | null;
  now: () => Date;
  onRegistered: (material: Material) => Promise<void> | void;
  outcome: Extract<IngestMaterialOutcome, 'reused' | 'reingest-skipped-manual'>;
}

/** C2 防清 belt note（markers=0 保留既有章界——诚实标注保留行为，相 B 重索引收敛真实值）。 */
const MISSING_MARKERS_PRESERVE_NOTE = '章标记缺失：已保留既有章界，待重索引收敛为真实值。';

/** 从既有派生 .md 的标记行重建章界并装配 REUSE/人工保留结果（字幕与五格式幂等分支共用，CR-8）。 */
async function assembleReusedFromMarkers(input: ReuseAssembleInput): Promise<IngestMaterialResult> {
  const markers = parseChapterMarkers(input.existingDerived);
  const rebuilt = rebuildChaptersFromMarkers(input.existingDerived, markers);
  // C2 防清 belt：markers=0（章标记丢失/被剥——R10 应用内编辑往返/外部编辑器）重建零章——既有
  // 登记行章界非空且派生仍有正文时保留既有章界 + 分章结论（同 preserveCuratedProvenance 防清
  // 哲学；chapters 与 chapterDetection 同源保留，守 F-18 两处同值纪律），不落 0 章中间行
  // （F1「0 章|章界待校对」假态/F12 cleared 窗口根因）；相 B 重索引 autoResplit 读磁盘派生
  // 重切、registrationConverged 必不相等 → 事务覆写真实值，belt 不拦收敛。既有行零章（首登/
  // 挂起/failed）或派生已被清空（CR-11 同哲学——不为空派生伪造结构）→ 维持诚实零章现状。
  const registered = input.registeredMaterial ?? null;
  const preserveRegistered =
    registered !== null && rebuilt.chapters.length === 0 && input.existingDerived.trim() !== '';
  const material = assembleMaterial({
    scopeInput: input.scopeInput,
    rel: input.rel,
    format: input.format,
    via: input.via,
    scanned: input.scanned,
    nonUtf8: input.nonUtf8,
    parseNotes: preserveRegistered
      ? [...input.parseNotes, MISSING_MARKERS_PRESERVE_NOTE]
      : input.parseNotes,
    charCount: input.charCount,
    contentHash: input.contentHash,
    chapters: preserveRegistered ? registered.chapters : chaptersFromRebuilt(rebuilt),
    chapterDetection: preserveRegistered
      ? registered.quality.chapterDetection
      : { method: rebuilt.docMethod, confidence: rebuilt.docConfidence, matchedFormats: [] },
    now: input.now,
  });
  await notifyRegistered(input.onRegistered, material);
  return { ok: true, material, derivedRelPath: input.derivedRel, outcome: input.outcome };
}

/** 原件内容变更后人工章标记丢失的诚实 note（字幕/五格式共用同一文案，CR-8 抽出防漂移）。 */
function noteManualMarkerLoss(markers: readonly ParsedChapterMarker[], parseNotes: string[]): void {
  if (markers.some((m) => m.method === 'manual')) {
    parseNotes.push('原件内容变更后人工章标记不再保留（已知限制：内容变更回自动分章，.orison/history 有旧版快照）。');
  }
}

/** CR-001 登记缝读取（never-throws）：未装配/抛错 → null（退回「视为内容变更」自动路径）。 */
async function readRegisteredContentHash(deps: MaterialIngestDeps, materialId: string): Promise<string | null> {
  if (!deps.getRegisteredContentHash) return null;
  try {
    return await deps.getRegisteredContentHash(materialId);
  } catch {
    return null;
  }
}

/**
 * C2 belt 登记缝读取（never-throws）：未装配/抛错/缺行/**零章行**（首登/挂起/failed——无可
 * 保留）→ null（belt 不触发，诚实零章现状）。零章判空在缝侧收口，调用方不重复判。
 */
async function readRegisteredMaterialForBelt(deps: MaterialIngestDeps, materialId: string): Promise<Material | null> {
  if (!deps.getRegisteredMaterial) return null;
  try {
    const row = await deps.getRegisteredMaterial(materialId);
    return row !== null && row.chapters.length > 0 ? row : null;
  } catch {
    return null;
  }
}

interface AssembleInput {
  scopeInput: MaterialIngestScope;
  rel: string;
  format: MaterialFormat;
  via: string;
  scanned: boolean;
  nonUtf8: boolean;
  parseNotes: string[];
  charCount: number;
  contentHash: string;
  chapters: Material['chapters'];
  chapterDetection: Material['quality']['chapterDetection'];
  now: () => Date;
}

/**
 * Material 装配（provenance 摄取期缺省：medium='other'/tier='unspecified'/作者族 null——
 * UI 后补，F-05；E10.2a：字幕格式 medium 默认 'video'、description 摄取期 null 同型后补）。
 * status：llm-fallback 挂起（零章界）→ low-confidence（F-09——章界与检索解耦，Wave C 对
 * 零章材料全文单伪章照索引）；其余成功路径 → ready。
 */
function assembleMaterial(input: AssembleInput): Material {
  const stem = path.posix.basename(input.rel, path.posix.extname(input.rel));
  return {
    materialId: materialIdFor(input.scopeInput.scope, materialSourcePath(input.scopeInput.scope, input.rel)),
    scope: input.scopeInput.scope,
    projectId: input.scopeInput.projectId,
    kind: 'prose',
    name: stem,
    format: input.format,
    provenance: {
      medium: isSubtitleFormat(input.format) ? 'video' : 'other',
      tier: 'unspecified',
      sourcePath: materialSourcePath(input.scopeInput.scope, input.rel),
      via: input.via,
      extractor: 'builtin-text',
      ingestedAt: input.now().toISOString(),
      author: null,
      lang: null,
      originDate: null,
      description: null,
    },
    quality: {
      ok: !(input.scanned || input.nonUtf8),
      scanned: input.scanned,
      nonUtf8: input.nonUtf8,
      parseNotes: input.parseNotes,
      charCount: input.charCount,
      chapterDetection: input.chapterDetection,
    },
    chapters: input.chapters,
    chunkSpans: [], // 索引时回填（Wave C materialIndexer，F-02——与登记更新同事务）
    contentHash: input.contentHash,
    status:
      input.chapterDetection.method === 'llm-fallback' && input.chapters.length === 0 ? 'low-confidence' : 'ready',
  };
}

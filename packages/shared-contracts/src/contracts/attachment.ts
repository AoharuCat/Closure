import { z } from 'zod';

// ── 选段契约（UI ↔ agent 「选段 → AI 评阅 → 回写」标准契约）──
//
// 历史轨迹：原 `apps/desktop/client/ui/src/shared/types/attachment.ts` 为 UI 侧源；agent 侧
// `apps/desktop/agent/src/runtime/workflow.ts` 镜像 `MessageSelectionAnchor` / `MessageAttachment`
// （手动 keep-in-sync）。Story 7.1 落 shared-contracts 作跨包类型源（mirror shared-contracts 是
// 跨包类型源头的惯例）：RevisionIntent.scope.anchor 须复用 SelectionAnchor（design §2.1 不重定义），
// 其消费者跨 shared-contracts（revision-intent.ts）/ ui（编辑器选区）/ agent（未来直读）。
//
// agent 侧 MessageSelectionAnchor / MessageAttachment 暂保留为 mirror（7.1 不动 agent 运行时契约，
// minimize blast radius；未来统一为共享类型是 cleanup 候选非本 story scope）。
//
// 零 migration：纯 additive（UI 侧 attachment.ts 改为 re-export shim 保持所有现有 import 路径不变）。

/**
 * Locates a selected passage so it can be re-found in the latest manuscript text
 * even after edits drift the original offsets.
 * - `quote`: the exact selected text (primary relocation key)
 * - `prefix` / `suffix`: surrounding context used to disambiguate duplicate quotes
 * - `rangeHint`: character offsets at capture time (best-effort, may be stale)
 */
export interface SelectionAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  rangeHint: { from: number; to: number };
}

/** Zod mirror of {@link SelectionAnchor}（RevisionIntent.scope.anchor schema 引用）。 */
// BMad CR F8：quote 加 .min(1)——空 quote 永远 locate-failed（findExactOccurrenceRanges 空串返 []），
// 在 schema 层拦（mirror lockedItemSchema.field .min(1)）。prefix/suffix 留空合法（边界选区无前/后文）。
export const selectionAnchorSchema = z.object({
  quote: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  rangeHint: z.object({
    from: z.number().int(),
    to: z.number().int(),
  }),
});

/**
 * A passage selected in the editor, carried as a structured attachment with its
 * provenance (chapter or file) and anchor.
 */
export interface SelectionAttachment {
  type: 'selection';
  id: string;
  label: string;
  text: string;
  sourceType: 'chapter' | 'file';
  chapterId?: string;
  filePath?: string;
  anchor: SelectionAnchor;
}

/** Lightweight pointer to a whole chapter. */
export interface ChapterAttachment {
  type: 'chapter';
  id: string;
  label: string;
}

/**
 * Lightweight pointer to a whole open file.
 *
 * 附件语义自证字段（task 09-01 agent-chat-attachments R1.2b/R1.2c，2026-09-01）：仅
 * **上传路径**（外部文件拷入 inbox/ 后挂附件）会 set 这四个字段——open files / 结构
 * pattern / 资产图片等既有 file 附件不带字段，渲染零变化。agent 侧 mirror
 * `apps/desktop/agent/src/runtime/workflow.ts` 的 `MessageAttachment` file 变体同步加
 * （手动 keep-in-sync 既有惯例）。零 migration：纯 additive optional，旧 attachments
 * / 会话 jsonl 无字段读回 undefined。
 */
export interface FileAttachment {
  type: 'file';
  id: string;
  label: string;
  /**
   * 机械预览（同步，进件即有）：解析内核解码后开头 ~200 字单行化（GBK 等非 UTF-8 由
   * 内核触发转换提示而非喂乱码）。防「凭文件名猜内容」的第一层。
   */
  preview?: string;
  /**
   * LLM 一句话定性（≤50 字，只依据内容，章摘要 synopsis 同型机制；异步回填不阻塞
   * Send，失败静默降级 preview-only）。防「凭文件名猜内容」的第二层。
   */
  description?: string;
  /** description 生成时间（epoch ms）——staleness 判定输入（fileMtime > describedAt = 文件晚于描述）。 */
  describedAt?: number;
  /** 挂附件时文件最后改动时间（epoch ms，stat 取）。 */
  fileMtime?: number;
}

/**
 * Chat 图片附件（task 09-01 agent-chat-attachments B 波 / dogfood #45）：用户在
 * Agent 对话框上传/拖入/粘贴的图片，进件时字节已落盘 `<project>/inbox/images/`——
 * 附件只携带**指针**（path + b64hash），绝不内嵌 b64（会话 jsonl 防膨胀；字节活
 * 统一收在 shell——agent 是纯编排层零 FS，ADR-2）。agent 侧 mirror
 * `apps/desktop/agent/src/runtime/workflow.ts` 的 `MessageAttachment` image 变体
 * 同步加（手动 keep-in-sync 既有惯例）。零 migration：纯 additive union 变体。
 */
export interface ImageAttachment {
  type: 'image';
  id: string;
  label: string;
  /** 项目相对路径（`inbox/images/<file>`）——agent 历史里可读、工具可按路径访问的指针。 */
  path: string;
  /** 落盘图片字节的 sha256 指纹（shell 转述缓存 key / 历史重放去重依据）。 */
  b64hash: string;
}

/** Any attachment that can be pinned to a message. */
export type Attachment = ChapterAttachment | FileAttachment | SelectionAttachment | ImageAttachment;

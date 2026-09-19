/**
 * author_profile_update tool handler (Story 8.6 R4, design D5/D6 / §3.1).
 *
 * 作者档案 = `~/.orison/author_profile.md` 自由 markdown（机器级跨项目文件——作者可读可改，
 * D5；**非 creative field**，不进 project.yaml 体系）。leader 在互动中隔几次记一笔作者观察
 * （什么水平/习惯/沟通偏好，短笔记防档案膨胀——档案全文每 turn 注入 leader 系统 prompt）。
 *
 * **append dated entry 不整文件重写**（防覆盖作者手改）：每条 = `## YYYY-MM-DD HH:mm\n<note>\n`
 * （纯本地时间戳，产品代码无 Date 限制问题），永远追加在文件尾部，从不重新生成既有内容。
 *
 * 双档落盘（mirror settingMdHandlers 专用 envelope 分流先例）：
 * - autoApply=true（auto 档 KD1）：直接追加落盘 + 返摘要（appendAuthorProfileNote core）。
 * - autoApply 缺省/false（suggest 默认）：不写盘。返**专用** `{type:'author_profile_patch',
 *   note, before, after, filePath}` envelope（非 field_patch——机器级文件非 creative field，
 *   PatchReviewPanel 装不下，mirror setting_md_patch 专用分流）。UI 专用卡片（词级 diff）→
 *   accept 走专用 IPC `author-profile:apply`（authorProfileIpc.ts）**重新追加当前 note**
 *   （永不落盘 stale after 快照——档案在提议与采纳之间可能被作者手改，重放 note 不会覆写）。
 *
 * Path（mirror craft-kb 目录处理，craftKbPaths.ts）：`os.homedir()`（home 单源，与
 * db/index.ts getDbPath 及 agent / local-bff 侧一致；tests mock node:os 的 homedir 到
 * throwaway home 或用 _setAuthorProfilePathForTest override，真 ~/.orison 永不被测试触碰）。
 * 目录不存在则 mkdir。
 * 路径由 home 派生非 LLM 输入——无穿越面（LLM 只控制 note 文本内容）。
 *
 * autoApply 自审闸门在 agent runLoop（toolPolicy），本 handler 不校验 selfReviewConfirmed
 * （mirror 既有家族）。Handlers NEVER throw。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

let authorProfilePathOverride: string | null = null;

/** Test override for the author-profile file path（mirror _setCraftKbUserDirForTest）。 */
export function _setAuthorProfilePathForTest(filePath: string | null): void {
  authorProfilePathOverride = filePath;
}

/** 作者档案文件：`~/.orison/author_profile.md`（os.homedir() 派生，见文件头）。 */
export function getAuthorProfilePath(): string {
  return (
    authorProfilePathOverride ?? path.join(homedir(), '.orison', 'author_profile.md')
  );
}

/**
 * Entry 文本：`## YYYY-MM-DD HH:mm\n<note>\n`（本地时间，分钟粒度——同分钟多条是合法的）。
 */
export function formatAuthorProfileEntry(note: string, at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `## ${stamp}\n${note}\n`;
}

/**
 * 读档案当前内容（result-object，mirror readSettingMdFile CR-08-16-110）：`ok:true` 且
 * `content` 缺省 = 文件不存在（合法空起步）；`ok:false` = 文件存在但读不了（EACCES/EISDIR）
 * ——调用方不可把读不了当不存在。
 */
type ReadAuthorProfileResult = { ok: true; content?: string } | { ok: false; reason: string };
function readAuthorProfileFile(filePath: string): ReadAuthorProfileResult {
  try {
    if (!existsSync(filePath)) return { ok: true };
    return { ok: true, content: readFileSync(filePath, 'utf-8') };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, filePath }, '[author_profile] profile read failed');
    return { ok: false, reason };
  }
}

/**
 * 现档案尾部末 1 条 entry（最后一个 `## ` 段；无任何 entry 形态内容则空串）——suggest 档
 * envelope 的 before 面与 after 预览的上下文。
 */
export function extractLastEntry(content: string): string {
  if (!content) return '';
  const idx = content.lastIndexOf('\n## ');
  if (idx >= 0) return content.slice(idx + 1).trim();
  // 无换行引导的 `## `：唯一 entry 恰在文件头。
  return content.trim().startsWith('## ') ? content.trim() : '';
}

/** Entry 间分隔（保证 entry 间至少一个空行，至多两个——纯排版，无语义）。 */
function entrySeparator(previous: string): string {
  if (previous.length === 0) return '';
  return previous.endsWith('\n') ? '\n' : '\n\n';
}

/**
 * CR-012（8.6 BMad CR）：note 行首 `#`（含缩进后 `#`，markdown 标题形态）转义——note 里混入
 * `## ` 行会伪造 entry 分段头，extractLastEntry（lastIndexOf('\n## ')）会误截到 note 内部而非
 * 真实末条 entry，破坏「一条 note = 一个 `## ` 段」不变式。逐行把行首 `#` 串转义为 `\#`（渲染时
 * 还原为字面 #，观察内容不丢）；幂等（转义后行首是 `\`，再跑不重复转义）。
 */
export function sanitizeProfileNoteLines(note: string): string {
  return note
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#+)/, (_m, ws: string, hashes: string) =>
      ws + hashes.split('').map((h) => `\\${h}`).join('')))
    .join('\n');
}

/** 追加后尾部预览（suggest 档 after 面）：before entry + 新 entry（display-only，非载荷）。 */
function previewTail(lastEntry: string, newEntry: string): string {
  const trimmedNew = newEntry.trim();
  return lastEntry ? `${lastEntry}\n\n${trimmedNew}` : trimmedNew;
}

/**
 * Persist core（autoApply 路径与 accept IPC `author-profile:apply` 共用，mirror
 * applyAndPersistSettingMd）：mkdir → 读当前 → **追加** dated entry（缺文件 = 合法空起步
 * 首条创建）。appendFileSync 真·追加——绝不重写既有内容（防覆盖作者手改）。永不 throw
 * （失败返 `{ok:false, reason}`）。
 */
export function appendAuthorProfileNote(
  note: string,
  at: Date = new Date(),
): { ok: true; filePath: string } | { ok: false; reason: string } {
  const trimmed = sanitizeProfileNoteLines(note.trim());
  if (!trimmed) return { ok: false, reason: 'note 为空（纯空白）' };

  const filePath = getAuthorProfilePath();
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const entry = formatAuthorProfileEntry(trimmed, at);
    if (!existsSync(filePath)) {
      atomicWriteFileSync(filePath, entry, 'utf-8');
      return { ok: true, filePath };
    }
    const read = readAuthorProfileFile(filePath);
    if (!read.ok) {
      return { ok: false, reason: `无法读取当前档案（${read.reason}）——请检查文件权限，或确认它是常规文件` };
    }
    appendFileSync(filePath, `${entrySeparator(read.content ?? '')}${entry}`, 'utf-8');
    return { ok: true, filePath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, filePath }, '[author_profile] append failed');
    return { ok: false, reason };
  }
}

/**
 * author_profile_update：把一条作者观察追加进作者档案（dated entry，append-only）。
 * suggest 档输出说人话：默认会先呈现给作者，由作者决定是否采纳。
 */
export const authorProfileUpdateHandler: ToolHandler = async ({ params }) => {
  // CR-008 mirror：params null/undefined 头部归一守卫（never-throws 契约）。
  const p = (params ?? {}) as { note?: unknown; autoApply?: unknown };
  const autoApply = p.autoApply === true;
  const note = typeof p.note === 'string' ? p.note.trim() : '';

  if (!note) {
    return {
      title: 'author_profile_update',
      output:
        '作者档案更新已跳过：note 缺失或为空。请提供 note（要记录的作者观察——保持一句话即可）。',
    };
  }

  // ── autoApply 路径：直接追加落盘 ──
  if (autoApply) {
    const result = appendAuthorProfileNote(note);
    if (!result.ok) {
      return {
        title: 'author_profile_update',
        output: `作者档案自动记录失败：${result.reason}。本次笔记未写入，可稍后重试。`,
        metadata: { ok: false, error: result.reason },
      };
    }
    return {
      title: 'author_profile_update',
      output:
        `已记入作者档案（一条带日期的观察笔记，档案随互动持续积累）。`,
      metadata: {
        ok: true,
        applied: true,
        filePath: result.filePath,
        summary: 'author_profile · 1 条观察已记录（自动应用）',
      },
    };
  }

  // ── suggest 路径（默认）：只读 + 预览，返专用 envelope（author_profile_patch，非 field_patch）──
  const filePath = getAuthorProfilePath();
  const read = readAuthorProfileFile(filePath);
  if (!read.ok) {
    // CR-08-16-110 mirror：绝不把「读不了」当「不存在」，也不抛穿 never-throws。
    return {
      title: 'author_profile_update',
      output:
        `作者档案更新被拒：无法读取当前档案（${read.reason}）。请检查文件权限后重试。`,
    };
  }
  // CR-012：envelope note 载荷与 after 预览同样走 sanitize（与 autoApply/accept 落盘路径同一形态——
  // accept 重放 note 时 appendAuthorProfileNote 会再 sanitize 一道，幂等不变形）。
  const sanitizedNote = sanitizeProfileNoteLines(note);
  const before = extractLastEntry(read.content ?? '');
  const after = previewTail(before, formatAuthorProfileEntry(sanitizedNote));

  return {
    title: 'author_profile_update',
    output:
      '作者档案笔记已备好——将追加一条带日期的观察记录，默认会先呈现给作者，由作者决定是否采纳。',
    metadata: {
      type: 'author_profile_patch',
      note: sanitizedNote,
      before,
      after,
      filePath,
    },
  };
};


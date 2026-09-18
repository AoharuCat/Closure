import type { StateCreator } from 'zustand';
import type { SelectionAnchor } from '../types/attachment';
import { resolveAgentConfirmation } from '../api/agent';
import { registerProjectReset } from './resetRegistry';
import { normalizePath } from '../utils/paths';
import { recoverSelectionAnchorFromMessages, type PassageAnchorMessage } from './passageAnchor';
import { getSessionProject } from './agentEvents';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';

/** Whole-chapter rewrite (existing behaviour). Applied by replacing chapter content wholesale. */
export type ChapterPendingDiff = {
  kind: 'chapter';
  id: string;
  toolId: string;
  /** Unique per tool call — used to match the DiffCard to its own diff. */
  toolCallId?: string;
  fileName: string;
  content: string;
  chapterId?: string;
  /**
   * suggest-mode reject support: the tool already wrote to disk at execution
   * time, so reject must undo that write. `previousContent` is the on-disk text
   * before the write (null when the file was newly created → reject deletes it);
   * `filePath` is the absolute path actually written (set for write_file, whose
   * target isn't under chapters/).
   */
  previousContent?: string | null;
  existedBefore?: boolean;
  filePath?: string;
};

/**
 * Passage-level rewrite. The replacement is NOT applied until accept time, when
 * `originalText` is relocated in the *latest* manuscript text via `anchor`.
 */
export type PassagePendingDiff = {
  kind: 'passage';
  id: string;
  toolId: string;
  sourceType: 'chapter' | 'file';
  chapterId?: string;
  filePath?: string;
  originalText: string;
  replacement: string;
  anchor?: SelectionAnchor;
};

export type PendingDiff = ChapterPendingDiff | PassagePendingDiff;

export type PendingToolConfirm = { callId: string; name: string; input: unknown };

/**
 * Tools whose result produces an editable diff instead of a plain tool card.
 * `rewrite_passage` carries passage-level metadata; the others carry whole-chapter
 * `content`. Single source of truth — consumed by both the event dispatcher (which
 * builds the pending diff) and AgentMessageItem (which routes the render).
 *
 * `write_chapter` (Story 4.1 Step 5) does not build a passage/chapter diff — its
 * result carries a `field_patch` metadata of field `chapter_candidate` (the drafted
 * chapter). Including it here lets the dispatcher route that metadata into the
 * patch-review flow (PatchReviewPanel), where accept persists via applyFieldPatches
 * (acceptChapterCandidateCore writes chapters/*.md + project.yaml + story_decisions).
 */
export const WRITE_TOOLS = ['chapter_write', 'write_chapter', 'write_file', 'outline_update', 'overview_update', 'scene_graph_update', 'rewrite_passage', 'genre_contract_update', 'asset_cards_update',
  // Story 2.2 WP-B: setting_md_update routes its own dedicated `setting_md_patch`
  // envelope (extracted in AgentMessageItem BEFORE the WRITE_TOOLS render branch,
  // mirror the findings tier) — listed here so the tool's metadata participates in
  // the write-tool surface (design §7 three-place sync: shell register + agent
  // toolPolicy.DIFF_TOOLS + this list).
  'setting_md_update',
  // Story 2.6: story_decisions_update emits a generic `field_patch` envelope
  // (field 'story_decisions') in suggest mode. It MUST be listed here — the
  // toolId gate at the top of the results loop drops the whole result otherwise
  // (CR-B01: the envelope never reaches PatchReview, the default-mode leader
  // registration path dies silently). Same three-place sync as above.
  'story_decisions_update',
  // Story 8.2: arc_ledger_update emits a generic `field_patch` envelope
  // (field 'arc_registry') in suggest mode — arc beat registration for human
  // review (leader/手 authoring path; the arc-emergence chain node writes with
  // autoApply=true directly). Same three-place sync as above (B01 checklist):
  // shell toolExecution register + agent toolPolicy.DIFF_TOOLS + this list.
  'arc_ledger_update',
  // Story 8.5: the arc-pipeline write trio emits generic `field_patch` envelopes
  // (fields 'growth_curve' / 'pacing_curve' / 'episode_outlines') in suggest
  // mode — arc design + episode outline edits for human review (leader authoring
  // path; autoApply=true in auto mode persists directly). Same three-place sync
  // as above (B01 checklist). Names MUST match the shell registrations
  // character-for-character (B01 was a name-drift miss).
  'growth_curve_update',
  'pacing_curve_update',
  'episode_outlines_update',
  // Story 5.2 backfill (B01 miss found during 8.5 Step 5): emotion_curve_update
  // shipped with a shell handler but no agent-side registration at all — Director's
  // auto-mode allowedTools filter silently dropped it, so auto-mode emotion-target
  // persistence never fired. Same three-place sync as above.
  'emotion_curve_update',
  // Story 8.6: cold-start guidance write duo emits generic `field_patch` envelopes
  // (fields 'creative_brief' / 'creative_preferences') in suggest mode — inspiration
  // record-keeping + working-style preferences for human review (leader authoring
  // path; autoApply=true in auto mode persists directly). Same three-place sync as
  // above. `author_profile_update` is deliberately NOT here — it emits the
  // dedicated `author_profile_patch` envelope (machine-level file, not a creative
  // field), intercepted in AgentMessageItem before the WRITE_TOOLS render branch
  // mirror setting_md_update (agent toolPolicy.ts Story 8.6 note).
  'creative_brief_update',
  // 09-12 子4 W6（bridge Tier 2 面，design §7）：信息释放地图与承诺台账两写工具的
  // field_patch envelope 此前漏登（handler 注释言明 intended 路径 = UI patch-review——
  // 漏登时 suggest 档 envelope 被 toolId 门整条静默丢弃，PatchReview 卡永不出现；HTTP
  // 车道同款潜在断链，bridge Tier 2 面把它们暴露进对话车道后必须可路由）。Same
  // three-place sync as above (B01 checklist)。
  'info_release_map_update',
  'promise_ledger_update',
  'creative_preferences_update'];

/** A possible target location for an unresolved passage rewrite. */
export type PassageCandidate = {
  from: number;
  to: number;
  /** Text surrounding the candidate, for UI highlight/preview. */
  excerpt: string;
};

/**
 * Set when an accepted passage diff could not be applied automatically — either
 * the original text was not found (drifted/edited) or it matched multiple spots.
 * The UI (Phase 2) renders candidate highlights and calls `resolvePassageAt`.
 */
export type PendingPassageResolve = {
  diffId: string;
  sourceType: 'chapter' | 'file';
  chapterId?: string;
  filePath?: string;
  originalText: string;
  replacement: string;
  reason: 'not-found' | 'ambiguous';
  candidates: PassageCandidate[];
};

/** Stable empty array so `?? EMPTY_PENDING_DIFFS` keeps selector references stable. */
export const EMPTY_PENDING_DIFFS: PendingDiff[] = [];

/**
 * dogfood T1 Stage 3（design §5.3 / r8）：五单槽 per-session 键控——本 slice 三槽
 * （pendingToolConfirm / pendingDiffs / pendingPassageResolve）改 `Record<sessionId, ...>`。
 *
 * 动机（r8 坑「后台会话确认卡的前台渲染」）：D3 切会话不 abort 后，后台会话的
 * confirm/diff 事件继续到达——单槽会互相顶（A 会话确认卡漏进 B 会话输入区）。键控后
 * 写入按事件 sessionId 落各自键；前台（AgentInput/AgentConfirmCard 等）只渲染**当前
 * 视图会话**（agentSessionId）的键。后台键留存 = 徽标 awaiting_* 数据源 + 切回再现。
 *
 * 动作全部带 sessionId 参数——确认/接受/拒绝按**卡所属会话**发（agentDiffSlice 旧
 * `get().agentSessionId` 硬编码点废弃，r8 设计要点 3）。
 */
export type AgentDiffSlice = {
  pendingDiffsBySession: Record<string, PendingDiff[] | undefined>;
  acceptDiff: (sessionId: string, id: string) => void;
  rejectDiff: (sessionId: string, id: string) => void;

  pendingPassageResolveBySession: Record<string, PendingPassageResolve | undefined>;
  resolvePassageAt: (sessionId: string, diffId: string, chosenIndex: number) => void;
  cancelPassageResolve: (sessionId: string) => void;

  pendingToolConfirmBySession: Record<string, PendingToolConfirm | undefined>;
  confirmPendingTool: (sessionId: string) => void;
  rejectPendingTool: (sessionId: string) => void;

  /** 事件路由层写入面（agentEvents dispatcher 消费）：append diff / set confirm。 */
  pushPendingDiff: (sessionId: string, diff: PendingDiff) => void;
  setPendingToolConfirm: (sessionId: string, value: PendingToolConfirm | null) => void;
  /** 清某会话全部三槽（deleteAgentSession / cancelAgent 用）。 */
  clearSessionPending: (sessionId: string) => void;
};

type Deps = AgentDiffSlice & {
  agentSessionId: string | null;
  activeSessionRunning: boolean;
  /** agentSessionSlice 的 run 态写入面——确认/拒绝后 run 续跑（原 agentLoading:true 键控版）。 */
  setAgentRunState: (sessionId: string, patch: { phase?: 'running' | 'idle' | 'error'; projectPath?: string; activity?: string }) => void;
  openFiles: { path: string; content: string }[];
  updateFileContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<boolean>;
  openFile: (path: string, name: string, content: string, options?: { kind?: 'text' | 'image' | 'docx' }) => void;
  closeFilesUnder?: (pathOrDir: string) => void;
  currentProject: { path?: string } | null;
  novelChapters: { id: string; sections: { contentFile: string }[] }[];
  refreshWordCount?: () => Promise<void>;
  agentMessages: PassageAnchorMessage[];
};

/**
 * Resolve the on-disk manuscript file for a chapter. The canonical layout is
 * `chapters/<chapterId>.md` (see chapterWriteHandler); when the project document
 * records an explicit `contentFile` for the chapter we honour that instead.
 * Returns an absolute, normalized path, or null if it can't be resolved.
 */
function resolveChapterFilePath(state: Deps, chapterId: string | undefined, fileName: string | undefined): string | null {
  const projectPath = state.currentProject?.path;
  if (!projectPath) return null;

  if (chapterId) {
    const meta = state.novelChapters.find((c) => c.id === chapterId);
    const contentFile = meta?.sections?.[0]?.contentFile;
    if (contentFile) return normalizePath(`${projectPath}/${contentFile}`);
    return normalizePath(`${projectPath}/chapters/${chapterId}.md`);
  }
  if (fileName) {
    // fileName is a bare manuscript name like "chapter-01.md".
    return normalizePath(`${projectPath}/chapters/${fileName}`);
  }
  return null;
}

/**
 * Resolve a passage/file path to an absolute normalized form for tab lookup.
 * Models and tool metadata often pass project-relative paths (`chapters/x.md`)
 * or Windows backslashes; open tabs always store absolute forward-slash paths.
 */
function resolveFileTabPath(state: Deps, filePath: string | undefined): string | null {
  if (!filePath) return null;
  const normalized = normalizePath(filePath);
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
    return normalized;
  }
  const projectPath = state.currentProject?.path;
  if (!projectPath) return normalized;
  return normalizePath(`${projectPath}/${normalized.replace(/^\.\//, '')}`);
}

function findOpenFileByPath(state: Deps, filePath: string | undefined): { path: string; content: string } | undefined {
  const abs = resolveFileTabPath(state, filePath);
  if (!abs) return undefined;
  const exact = state.openFiles.find((f) => normalizePath(f.path) === abs);
  if (exact) return exact;
  // Case-insensitive fallback (Windows paths).
  const lower = abs.toLowerCase();
  return state.openFiles.find((f) => normalizePath(f.path).toLowerCase() === lower);
}

/**
 * Read a chapter's latest content from its open tab, if any. Passage relocation
 * needs the current in-editor text; when the chapter file isn't open there is no
 * in-memory copy to relocate against (returns undefined → caller drops the diff).
 */
function readChapterContent(state: Deps, chapterId: string | undefined): string | undefined {
  const filePath = resolveChapterFilePath(state, chapterId, undefined);
  if (!filePath) return undefined;
  return findOpenFileByPath(state, filePath)?.content;
}

/**
 * Persist whole-chapter content to its `.md` file (the manuscript source of
 * truth). If the file is already open as a tab, route through the tab so the
 * editor view stays in sync; otherwise write straight to disk.
 */
function persistChapterContent(state: Deps, filePath: string, content: string): void {
  const openTab = findOpenFileByPath(state, filePath);
  const tabPath = openTab ? normalizePath(openTab.path) : filePath;
  if (openTab) {
    state.updateFileContent(tabPath, content);
    void state.saveFile(tabPath);
    return;
  }
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  // Open the tab with the new content and save it — this both persists to disk
  // and surfaces the change to the user (matching how an open file would behave).
  state.openFile(filePath, fileName, content, { kind: 'text' });
  void state.saveFile(filePath);
  void state.refreshWordCount?.();
}

// ── passage relocation helpers ──

type TextRange = { from: number; to: number };

function findExactOccurrenceRanges(haystack: string, needle: string): TextRange[] {
  const out: TextRange[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push({ from: idx, to: idx + needle.length });
    from = idx + 1;
  }
  return out;
}

function normalizeLineEndingsWithMap(text: string): { text: string; starts: number[]; ends: number[] } {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      chars.push('\n');
      starts.push(i);
      if (text[i + 1] === '\n') {
        ends.push(i + 2);
        i++;
      } else {
        ends.push(i + 1);
      }
      continue;
    }
    chars.push(ch);
    starts.push(i);
    ends.push(i + 1);
  }
  return { text: chars.join(''), starts, ends };
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Collapse paragraph separators so TipTap `textBetween(..., '\n')` (single \n
 * between blocks) can match markdown source which uses blank lines (`\n\n`).
 * Maps each character in the collapsed string back to the original index range.
 */
function normalizeParagraphBreaksWithMap(text: string): { text: string; starts: number[]; ends: number[] } {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\n') {
      // Collapse runs of blank lines (optionally with spaces) into a single \n.
      let j = i;
      while (j < text.length && (text[j] === '\n' || text[j] === ' ' || text[j] === '\t')) {
        if (text[j] === '\n') j++;
        else {
          // trailing spaces on a blank line
          let k = j;
          while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
          if (text[k] === '\n') j = k + 1;
          else break;
        }
      }
      if (j > i + 1) {
        chars.push('\n');
        starts.push(i);
        ends.push(j);
        i = j;
        continue;
      }
    }
    chars.push(text[i]);
    starts.push(i);
    ends.push(i + 1);
    i++;
  }
  return { text: chars.join(''), starts, ends };
}

function comparableText(text: string): string {
  return normalizeLineEndings(text).replace(/\s+/g, '').trim();
}

function findMappedRanges(
  haystack: string,
  needle: string,
  normalize: (text: string) => { text: string; starts: number[]; ends: number[] },
): TextRange[] {
  const normalizedNeedle = normalize(needle).text;
  if (!normalizedNeedle) return [];
  // Skip when already identical and exact search would find it (caller handles exact first).
  if (normalizedNeedle === needle && haystack.indexOf(needle) !== -1) return [];

  const normalizedHaystack = normalize(haystack);
  if (normalizedHaystack.text === haystack && normalizedNeedle === needle) return [];

  const out: TextRange[] = [];
  let from = 0;
  for (;;) {
    const idx = normalizedHaystack.text.indexOf(normalizedNeedle, from);
    if (idx === -1) break;
    const endIdx = idx + normalizedNeedle.length - 1;
    const originalFrom = normalizedHaystack.starts[idx];
    const originalTo = normalizedHaystack.ends[endIdx];
    if (originalFrom != null && originalTo != null) {
      out.push({ from: originalFrom, to: originalTo });
    }
    from = idx + 1;
  }
  return out;
}

function findLineEndingNormalizedRanges(haystack: string, needle: string): TextRange[] {
  return findMappedRanges(haystack, needle, normalizeLineEndingsWithMap);
}

/** Match when quote uses single newlines between blocks but source has blank lines. */
function findParagraphBreakNormalizedRanges(haystack: string, needle: string): TextRange[] {
  const lineNormalizedHaystack = normalizeLineEndings(haystack);
  const lineNormalizedNeedle = normalizeLineEndings(needle);
  // First try on already line-ending-normalized text with paragraph collapse.
  const ranges = findMappedRanges(
    lineNormalizedHaystack,
    lineNormalizedNeedle,
    normalizeParagraphBreaksWithMap,
  );
  if (ranges.length === 0 || lineNormalizedHaystack === haystack) return ranges;

  // Remap ranges from \n-normalized haystack back to original (may contain \r\n).
  const map = normalizeLineEndingsWithMap(haystack);
  return ranges.map((r) => {
    const from = map.starts[r.from] ?? r.from;
    const to = map.ends[r.to - 1] ?? r.to;
    return { from, to };
  });
}

function findAllOccurrenceRanges(haystack: string, needle: string): TextRange[] {
  const exact = findExactOccurrenceRanges(haystack, needle);
  if (exact.length > 0) return exact;
  const lineEnding = findLineEndingNormalizedRanges(haystack, needle);
  if (lineEnding.length > 0) return lineEnding;
  return findParagraphBreakNormalizedRanges(haystack, needle);
}

function locateExactText(content: string, text: string, anchor?: SelectionAnchor): LocateResult | null {
  const occurrences = findAllOccurrenceRanges(content, text);

  if (occurrences.length === 1) {
    return { status: 'unique', from: occurrences[0].from, to: occurrences[0].to };
  }

  if (occurrences.length > 1) {
    const scored = occurrences
      .map((range) => ({ range, score: scoreOccurrence(content, range.from, range.to - range.from, anchor) }))
      .sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    // Clear winner only if an anchor produced a meaningfully higher score.
    if (anchor && best.score - second.score >= 1) {
      return { status: 'unique', from: best.range.from, to: best.range.to };
    }
    return {
      status: 'ambiguous',
      candidates: occurrences.map((range) => ({ from: range.from, to: range.to, excerpt: makeExcerpt(content, range.from, range.to) })),
    };
  }

  return null;
}

function locateWholeDocumentRewrite(content: string, originalText: string): LocateResult | null {
  const comparableContent = comparableText(content);
  const comparableOriginal = comparableText(originalText);
  if (comparableContent.length < 120 || comparableOriginal.length < 120) return null;

  const shorter = Math.min(comparableContent.length, comparableOriginal.length);
  const longer = Math.max(comparableContent.length, comparableOriginal.length);
  const coverage = shorter / longer;
  if (coverage < 0.85) return null;

  const similarity = diceSimilarity(comparableContent, comparableOriginal);
  if (similarity < 0.72) return null;

  return { status: 'unique', from: 0, to: content.length };
}

function makeExcerpt(content: string, from: number, to: number, pad = 24): string {
  const start = Math.max(0, from - pad);
  const end = Math.min(content.length, to + pad);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

/** Dice coefficient on character bigrams — cheap fuzzy similarity for fallback candidates. */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  for (const [g, count] of ba) {
    const other = bb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

type LocateResult =
  | { status: 'unique'; from: number; to: number }
  | { status: 'ambiguous'; candidates: PassageCandidate[] }
  | { status: 'not-found'; candidates: PassageCandidate[] };

/** Score an occurrence by anchor context (prefix/suffix) and proximity to rangeHint. */
function scoreOccurrence(content: string, idx: number, len: number, anchor?: SelectionAnchor): number {
  if (!anchor) return 0;
  let score = 0;
  if (anchor.prefix) {
    const before = content.slice(Math.max(0, idx - anchor.prefix.length), idx);
    if (before.endsWith(anchor.prefix)) score += 2;
    else score += diceSimilarity(before, anchor.prefix);
  }
  if (anchor.suffix) {
    const after = content.slice(idx + len, idx + len + anchor.suffix.length);
    if (after.startsWith(anchor.suffix)) score += 2;
    else score += diceSimilarity(after, anchor.suffix);
  }
  // Closer to the captured offset is better (small tie-breaker in [0,1)).
  const drift = Math.abs(idx - anchor.rangeHint.from);
  score += 1 / (1 + drift / 100);
  return score;
}

/**
 * Relocate a passage in the latest content.
 * - exactly one exact match → unique
 * - several exact matches → disambiguate via anchor; a clear winner returns unique,
 *   otherwise ambiguous with all occurrences as candidates
 * - no exact match → not-found with best-effort fuzzy paragraph candidates
 */
function locatePassage(content: string, originalText: string, anchor?: SelectionAnchor): LocateResult {
  const originalMatch = locateExactText(content, originalText, anchor);
  if (originalMatch) return originalMatch;

  // The model may echo a lightly edited/truncated originalText. The UI-captured
  // selection anchor is the more trustworthy source when it still exists in the
  // latest manuscript, so use it before falling back to fuzzy suggestions.
  const anchorQuote = anchor?.quote;
  if (anchorQuote && anchorQuote !== originalText) {
    const anchorMatch = locateExactText(content, anchorQuote, anchor);
    if (anchorMatch) return anchorMatch;
  }

  const wholeDocumentMatch = locateWholeDocumentRewrite(content, originalText);
  if (wholeDocumentMatch) return wholeDocumentMatch;

  // No exact match — offer fuzzy paragraph candidates so the UI can highlight.
  const paragraphs: PassageCandidate[] = [];
  const re = /\n{2,}|\n/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  const pushPara = (from: number, to: number) => {
    const text = content.slice(from, to);
    if (text.trim().length > 0) paragraphs.push({ from, to, excerpt: text });
  };
  while ((m = re.exec(content)) !== null) {
    pushPara(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  pushPara(cursor, content.length);

  const ranked = paragraphs
    .map((c) => ({ c, score: diceSimilarity(c.excerpt, originalText) }))
    .sort((a, b) => b.score - a.score)
    .filter((x) => x.score > 0.2)
    .slice(0, 3)
    .map((x) => ({ ...x.c, excerpt: makeExcerpt(content, x.c.from, x.c.to, 0) }));

  return { status: 'not-found', candidates: ranked };
}

export const createAgentDiffSlice: StateCreator<Deps, [], [], AgentDiffSlice> = (set, get) => {
  // dogfood T1 Stage 3（r8 设计要点 5 / [[state-management]]）：键控后项目重置不能盲清
  // 全部键（会误杀其他项目的后台会话挂起卡）——按会话归属（agentEvents 的
  // sessionId→projectPath 映射，事件/发送时记录）过滤，只清**不属于当前（新）项目**
  // 的键。归属未知的键一并清（无法证明属于新项目；新项目的会话一经交互即有映射）。
  // 注意运行中后台 run 的事件还会继续到达并重建其键（预期行为——运行中的挂起态不丢）。
  registerProjectReset(() => {
    // dogfood T1 CR-T1-025：「等待用户」挂起键（confirm/diffs/passageResolve）按定义不再产
    // 事件——批3 的 owner==当前项目过滤会把离开项目的挂起卡整体销毁，切回后确认卡/diff 卡
    // 永久丢（主进程 run 死等确认只能 abort 救；徽标 awaiting 降级 running）。改「按 owner
    // 归属保留」：有归属的键跨项目存活（mirror agentRunStates 策略），渲染面按 sessionId 键控
    // 隔离（AgentConfirmCard/DiffCard 只读视图会话的键）不靠删除；仅清无归属残键（会话从未
    // 登记 project——无法路由的孤儿）。归属登记单源 = agentEvents.getSessionProject。
    const dropUnattributed = (record: Record<string, unknown>): Record<string, unknown> => {
      const next: Record<string, unknown> = {};
      for (const sid of Object.keys(record)) {
        if (getSessionProject(sid) !== undefined) next[sid] = record[sid];
      }
      return next;
    };
    set({
      pendingDiffsBySession: dropUnattributed(get().pendingDiffsBySession) as Record<string, PendingDiff[] | undefined>,
      pendingPassageResolveBySession: dropUnattributed(get().pendingPassageResolveBySession) as Record<string, PendingPassageResolve | undefined>,
      pendingToolConfirmBySession: dropUnattributed(get().pendingToolConfirmBySession) as Record<string, PendingToolConfirm | undefined>,
    });
  });

  return {
  pendingDiffsBySession: {},
  pendingToolConfirmBySession: {},
  pendingPassageResolveBySession: {},

  pushPendingDiff(sessionId, diff) {
    set((s) => ({
      pendingDiffsBySession: {
        ...s.pendingDiffsBySession,
        [sessionId]: [...(s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS), diff],
      },
    }));
  },

  setPendingToolConfirm(sessionId, value) {
    set((s) => {
      if (!value) {
        if (!(sessionId in s.pendingToolConfirmBySession)) return s;
        const next = { ...s.pendingToolConfirmBySession };
        delete next[sessionId];
        return { pendingToolConfirmBySession: next };
      }
      return { pendingToolConfirmBySession: { ...s.pendingToolConfirmBySession, [sessionId]: value } };
    });
  },

  clearSessionPending(sessionId) {
    set((s) => {
      const diffs = { ...s.pendingDiffsBySession };
      const resolves = { ...s.pendingPassageResolveBySession };
      const confirms = { ...s.pendingToolConfirmBySession };
      delete diffs[sessionId];
      delete resolves[sessionId];
      delete confirms[sessionId];
      return {
        pendingDiffsBySession: diffs,
        pendingPassageResolveBySession: resolves,
        pendingToolConfirmBySession: confirms,
      };
    });
  },

  acceptDiff(sessionId, id) {
    const state = get();
    const diff = (state.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).find((d) => d.id === id);
    if (!diff) return;

    if (diff.kind === 'chapter') {
      // Persist to the manuscript .md file (the source of truth). If the file is
      // open as a tab the write routes through it so the editor view stays in
      // sync; otherwise it goes straight to disk.
      const filePath = resolveChapterFilePath(state, diff.chapterId, diff.fileName);
      if (filePath) {
        persistChapterContent(state, filePath, diff.content);
      }
      set((s) => ({
        pendingDiffsBySession: {
          ...s.pendingDiffsBySession,
          [sessionId]: (s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).filter((d) => d.id !== id),
        },
      }));
      return;
    }

    // passage: relocate in the latest content at accept time
    const current = diff.sourceType === 'chapter'
      ? readChapterContent(state, diff.chapterId)
      : findOpenFileByPath(state, diff.filePath)?.content;

    if (current == null) {
      // Source no longer open/available — drop the stale diff.
      set((s) => ({
        pendingDiffsBySession: {
          ...s.pendingDiffsBySession,
          [sessionId]: (s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).filter((d) => d.id !== id),
        },
      }));
      return;
    }

    // 锚回补只在视图会话可靠（agentMessages 是视图消息；后台会话的消息不在 store，
    // 切回后 fetch 对账也不重建锚）。非视图会话落到纯文本精确匹配定位。
    const anchor = state.agentSessionId === sessionId
      ? diff.anchor ?? recoverSelectionAnchorFromMessages(
          state.agentMessages,
          diff.originalText,
          diff.chapterId,
          diff.filePath,
        )
      : diff.anchor;
    const located = locatePassage(current, diff.originalText, anchor);
    if (located.status === 'unique') {
      applyPassage(state, diff.sourceType, diff.chapterId, diff.filePath, current, located.from, located.to, diff.replacement);
      set((s) => ({
        pendingDiffsBySession: {
          ...s.pendingDiffsBySession,
          [sessionId]: (s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).filter((d) => d.id !== id),
        },
      }));
      return;
    }

    // 0 or ambiguous matches → hand off to UI candidate-confirm flow; keep the diff.
    set({
      pendingPassageResolveBySession: {
        ...state.pendingPassageResolveBySession,
        [sessionId]: {
          diffId: diff.id,
          sourceType: diff.sourceType,
          chapterId: diff.chapterId,
          filePath: diff.filePath,
          originalText: diff.originalText,
          replacement: diff.replacement,
          reason: located.status === 'ambiguous' ? 'ambiguous' : 'not-found',
          candidates: located.candidates,
        },
      },
    });
  },

  resolvePassageAt(sessionId, diffId, chosenIndex) {
    const state = get();
    const resolve = state.pendingPassageResolveBySession[sessionId];
    if (!resolve || resolve.diffId !== diffId) return;
    const candidate = resolve.candidates[chosenIndex];
    if (!candidate) return;

    const current = resolve.sourceType === 'chapter'
      ? readChapterContent(state, resolve.chapterId)
      : findOpenFileByPath(state, resolve.filePath)?.content;
    if (current == null) {
      set((s) => ({
        pendingPassageResolveBySession: omitKey(s.pendingPassageResolveBySession, sessionId),
        pendingDiffsBySession: {
          ...s.pendingDiffsBySession,
          [sessionId]: (s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).filter((d) => d.id !== diffId),
        },
      }));
      return;
    }

    applyPassage(state, resolve.sourceType, resolve.chapterId, resolve.filePath, current, candidate.from, candidate.to, resolve.replacement);
    set((s) => ({
      pendingPassageResolveBySession: omitKey(s.pendingPassageResolveBySession, sessionId),
      pendingDiffsBySession: {
        ...s.pendingDiffsBySession,
        [sessionId]: (s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).filter((d) => d.id !== diffId),
      },
    }));
  },

  cancelPassageResolve(sessionId) {
    // Keep the pending diff so the user can retry or reject it explicitly.
    set((s) => ({ pendingPassageResolveBySession: omitKey(s.pendingPassageResolveBySession, sessionId) }));
  },

  rejectDiff(sessionId, id) {
    const state = get();
    const diff = (state.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).find((d) => d.id === id);
    // A chapter/file write already hit disk at tool-execution time (suggest
    // mode reviews after the fact). Rejecting must undo that write, otherwise
    // "reject" silently keeps the agent's change.
    if (diff && diff.kind === 'chapter') {
      void restoreRejectedWrite(state, diff);
    }
    set((s) => ({
      pendingDiffsBySession: {
        ...s.pendingDiffsBySession,
        [sessionId]: (s.pendingDiffsBySession[sessionId] ?? EMPTY_PENDING_DIFFS).filter((d) => d.id !== id),
      },
      pendingPassageResolveBySession: s.pendingPassageResolveBySession[sessionId]?.diffId === id
        ? omitKey(s.pendingPassageResolveBySession, sessionId)
        : s.pendingPassageResolveBySession,
    }));
  },

  /**
   * dogfood T1 CR-T1-028：确认/拒绝的乐观态翻转（run 态 running + 视图 spinner）后
   * resolveAgentConfirmation 若 throw（permission.ts resolvePending 对过期确认抛
   * `pending confirmation not found`——run 已 abort/收尾清了 pending），void 调用无 catch
   * 会双永卡（spinner + run 态 running）。回滚 run 态/视图 loading + toast 提示。
   */
  confirmPendingTool(sessionId) {
    const pending = get().pendingToolConfirmBySession[sessionId];
    if (!pending) return;
    get().setPendingToolConfirm(sessionId, null);
    // r8 设计要点 3：确认按卡所属会话发 + 该会话 run 态续跑（原 agentLoading:true）。
    // 所属会话若是后台（徽标上直接确认的形态预留），视图 loading 不动。
    get().setAgentRunState(sessionId, { phase: 'running' });
    if (get().agentSessionId === sessionId) set({ activeSessionRunning: true });
    void resolveAgentConfirmation(sessionId, pending.callId, true)
      .catch(() => rollbackConfirmResolve(get, set, sessionId));
  },

  rejectPendingTool(sessionId) {
    const pending = get().pendingToolConfirmBySession[sessionId];
    if (!pending) return;
    get().setPendingToolConfirm(sessionId, null);
    get().setAgentRunState(sessionId, { phase: 'running' });
    if (get().agentSessionId === sessionId) set({ activeSessionRunning: true });
    void resolveAgentConfirmation(sessionId, pending.callId, false)
      .catch(() => rollbackConfirmResolve(get, set, sessionId));
  },
  };
};

/** CR-T1-028：resolve 失败（确认已过期/会话已终局）→ 回滚乐观 run 态 + 提示。 */
type ConfirmResolveDeps = AgentDiffSlice & {
  agentSessionId: string | null;
  activeSessionRunning: boolean;
  setAgentRunState: (sessionId: string, patch: { phase?: 'running' | 'idle' | 'error'; projectPath?: string; activity?: string }) => void;
};

function rollbackConfirmResolve(
  get: () => ConfirmResolveDeps & { resolvedLocale?: string },
  set: (partial: Partial<ConfirmResolveDeps>) => void,
  sessionId: string,
): void {
  get().setAgentRunState(sessionId, { phase: 'idle', activity: undefined });
  if (get().agentSessionId === sessionId) set({ activeSessionRunning: false });
  const locale = get().resolvedLocale ?? 'zh-CN';
  useToastStore.getState().showToast(translate(locale, 'agent.confirmResolveFailed'), 'error', 5000);
}

function omitKey<T>(record: Record<string, T | undefined>, key: string): Record<string, T | undefined> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Splice replacement into [from,to) of the latest content and persist to the right source. */
function applyPassage(
  state: Deps,
  sourceType: 'chapter' | 'file',
  chapterId: string | undefined,
  filePath: string | undefined,
  current: string,
  from: number,
  to: number,
  replacement: string,
): void {
  const next = current.slice(0, from) + replacement + current.slice(to);
  if (sourceType === 'chapter' && chapterId) {
    // Persist the spliced chapter to its manuscript file (the source of truth).
    const chapterFile = resolveChapterFilePath(state, chapterId, undefined);
    if (chapterFile) persistChapterContent(state, chapterFile, next);
  } else if (sourceType === 'file' && filePath) {
    const tab = findOpenFileByPath(state, filePath);
    const tabPath = tab ? normalizePath(tab.path) : resolveFileTabPath(state, filePath);
    if (!tabPath) return;
    state.updateFileContent(tabPath, next);
    void state.saveFile(tabPath);
  }
}

/**
 * Undo an already-written chapter/file diff when the user rejects it in suggest
 * mode (the tool wrote to disk at execution time). Restores the pre-write text,
 * or deletes the file if the write created it. Keeps any open editor tab in sync.
 */
async function restoreRejectedWrite(state: Deps, diff: ChapterPendingDiff): Promise<void> {
  const api = window.orisonDesktop;
  if (!api) return;
  // write_file targets an arbitrary path (diff.filePath); chapter writes resolve
  // to chapters/<id>.md.
  const projectPath = state.currentProject?.path;
  const absPath = diff.filePath && projectPath
    ? normalizePath(`${projectPath}/${diff.filePath}`)
    : resolveChapterFilePath(state, diff.chapterId, diff.fileName);
  if (!absPath) return;

  // No snapshot info → can't safely restore; leave disk as-is.
  if (diff.existedBefore === undefined) return;

  if (!diff.existedBefore) {
    // The write created the file — delete it and close any ghost tab.
    try { await api.deleteEntry?.(absPath); } catch { /* best effort */ }
    state.closeFilesUnder?.(absPath);
    return;
  }

  // The file existed — restore its previous content (in the open tab if any).
  const previous = diff.previousContent ?? '';
  const openTab = findOpenFileByPath(state, absPath);
  const tabPath = openTab ? normalizePath(openTab.path) : absPath;
  if (openTab) {
    state.updateFileContent(tabPath, previous);
    void state.saveFile(tabPath);
  } else {
    try { await api.writeFile?.(absPath, previous); } catch { /* best effort */ }
  }
}

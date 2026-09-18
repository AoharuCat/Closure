import { marked } from 'marked';
import TurndownService from 'turndown';
import DOMPurify from 'dompurify';
import { stripFrontmatter } from './frontmatter';

marked.setOptions({
  gfm: true,
  breaks: false,
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

turndown.addRule('strikethrough', {
  filter: ['s', 'del'] as Array<keyof HTMLElementTagNameMap>,
  replacement: (content) => `~~${content}~~`,
});

// ── Serializer escape policy (dogfood R3 / R10) ───────────────────────────
// turndown's default text-node escape rewrites EVERY underscore
// (`book_id` → `book\_id`) and every text-node-start `=` run (`= 正文` →
// `\= 正文`). On the editor's save path that is pure byte drift — the R3
// dogfood derived .md accumulated this escape pollution on every in-app
// save. The defaults are load-bearing in general (escaped output must
// re-parse to the same literals), so only the two offending rules are
// replaced with boundary-aware versions; every other default escape stays:
//  - `_`: an underscore run flanked by letters/digits on BOTH sides can
//    never open or close emphasis (CommonMark intraword rule), so it stays
//    unescaped — `book_id=…` round-trips byte-exact. Word-boundary runs (a
//    space/punctuation/line edge on a side) are still escaped so a literal
//    `_x_` never turns into emphasis on re-parse.
//  - `=`: only an `=` run at a text-node start that forms a whole line can
//    act as a setext underline on re-parse; `= 正文` (content after the
//    run) cannot, and stays unescaped.
// `escape` is a public TurndownService method consulted for every non-code
// text node, so shadowing it on the shared instance retargets every
// serialization through htmlToMarkdown.
const EDITOR_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\/g, '\\\\'],
  [/\*/g, '\\*'],
  [/^-/g, '\\-'],
  [/^\+ /g, '\\+ '],
  [/^(#{1,6}) /g, '\\$1 '],
  [/`/g, '\\`'],
  [/^~~~/g, '\\~~~'],
  [/\[/g, '\\['],
  [/\]/g, '\\]'],
  [/^>/g, '\\>'],
  [/^(\d+)\. /g, '$1\\. '],
];

const SETEXT_UNDERLINE_AT_START_RE = /^(=+)(?=[ \t]*(?:\n|$))/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function escapeUnderscoreRuns(text: string): string {
  if (!text.includes('_')) return text;
  let out = '';
  let runStart = -1;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charAt(i) === '_') {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      const run = text.slice(runStart, i);
      const before = runStart > 0 ? text.charAt(runStart - 1) : '';
      const after = i < text.length ? text.charAt(i) : '';
      const intraword =
        before !== '' && after !== '' && LETTER_OR_DIGIT.test(before) && LETTER_OR_DIGIT.test(after);
      out += intraword ? run : run.replace(/_/g, '\\_');
      runStart = -1;
    }
    if (i < text.length) out += text.charAt(i);
  }
  return out;
}

/** Boundary-aware replacement for turndown's default text-node escape. */
function escapeEditorText(text: string): string {
  let out = text;
  for (const [re, replacement] of EDITOR_ESCAPES) out = out.replace(re, replacement);
  // `=` rule after the pipeline so its inserted backslash is not doubled by
  // the `\\` rule above.
  out = out.replace(SETEXT_UNDERLINE_AT_START_RE, '\\$1');
  return escapeUnderscoreRuns(out);
}

turndown.escape = escapeEditorText;

export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  return (marked.parse(markdown, { async: false }) as string).trimEnd();
}

// ── Model-output rendering (dogfood R3 U1: promoted from features/agent-panel) ──

/**
 * Model-authored markdown → sanitized HTML (marked + DOMPurify). Single source
 * for every surface that renders model output as rich text: agent replies
 * (AgentMessageItem), subagent draft cards, and decon reports (DeconJobPanel).
 * The renderer holds fs/git write-tool IPC access, so raw model output must
 * never run as HTML un-sanitized. Not for editor save paths — those go through
 * htmlToMarkdown round-trips above.
 */
export function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown
    .turndown(html)
    .replace(/^([*+-]) {2,}/gm, '$1 ')
    .replace(/^(\d+\.) {2,}/gm, '$1 ')
    .trim();
}

// ── Round-trip loss detection ──────────────────────────────────────────────
// The TipTap editor only registers StarterKit (no table/image/html nodes). A
// markdown→HTML→TipTap→markdown round-trip silently drops any construct the
// schema doesn't know, so an unsuspecting edit + autosave permanently deletes
// tables, images and HTML blocks. We detect those specific high-value
// constructs and, when they wouldn't survive, fall back to a raw source editor
// rather than corrupting the manuscript. We count constructs before/after
// (rather than full-string equality) because marked+turndown reformats even
// lossless content (list markers, emphasis tokens, blank lines).
//
// Front-matter is exempt (dogfood #109): the editor strips it before the body
// reaches TipTap and re-attaches the captured block byte-exact on every
// write-back (see frontmatter.ts), so it never round-trips through the rich
// editor at all — only the body is judged here.

const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
// A GFM table delimiter row (`---|---`, `| :-- | --: |`). It must contain a
// pipe — a bare `---` line is a horizontal rule / setext underline, which
// writers use as scene breaks and which the round-trip preserves (as `* * *`).
const TABLE_DELIM_RE = /^(?=[^\n]*\|)[\s:|-]*-[\s:|-]*$/gm;
// Raw block/inline HTML tags StarterKit won't round-trip (turndown keeps <a>,
// <strong>, <em>, <code> etc. via its rules, so scope to structural/table/media
// tags that get dropped).
const RAW_HTML_RE = /<\/?(?:table|thead|tbody|tr|td|th|div|span|section|article|figure|figcaption|img|iframe|video|audio|details|summary|mark|sub|sup|kbd)\b[^>]*>/gi;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Remove fenced blocks and inline code, where markdown syntax is literal text. */
function stripCodeSpans(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * True when opening `md` in the TipTap editor would lose content on the next
 * save. Callers should fall back to a raw source editor when this returns true.
 */
export function isMarkdownRoundTripLossy(md: string): boolean {
  if (!md) return false;
  // Front-matter is machine metadata the editor never round-trips (stripped on
  // load, re-attached byte-exact on save — see frontmatter.ts), so it no longer
  // forces source mode by itself. Judge the body only; any construct still
  // present in the body keeps triggering the fallback.
  const body = stripFrontmatter(md);
  // Images: the proxy round-trip below preserves them (turndown ships an <img>
  // rule), but the real editor schema has no image node and drops them — so
  // presence outside code spans is already lossy.
  if (countMatches(stripCodeSpans(body), IMAGE_RE) > 0) return true;

  const roundTripped = htmlToMarkdown(markdownToHtml(body));

  // Any structural HTML in the source that the round-trip strips out.
  if (countMatches(body, RAW_HTML_RE) > countMatches(roundTripped, RAW_HTML_RE)) return true;
  // GFM tables dropped (no table node) — compare delimiter-row counts.
  if (countMatches(body, TABLE_DELIM_RE) > countMatches(roundTripped, TABLE_DELIM_RE)) return true;

  return false;
}


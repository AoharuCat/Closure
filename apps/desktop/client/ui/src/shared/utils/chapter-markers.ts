/**
 * Derived-markdown chapter-marker utilities — single source for the
 * `<!-- mat-chapter ... -->` line contract across the UI (dogfood R3 / R10).
 *
 * Marker lines are machine metadata (ingest/reingest chapter boundaries),
 * never prose: TipTap's document model has no comment node, so a rich-editor
 * round-trip silently deletes every marker line — the R3 dogfood project lost
 * 98 markers in one in-app edit, which cascaded into the 「0 章」 transient
 * and the decon P1b race (F1/F12; evidence: research/marker-stripping-verdict
 * .md). Same contract as `frontmatter.ts` (dogfood #109): the rich editor
 * strips marker lines before the body reaches TipTap and re-splices the
 * captured lines byte-exact at the single write-back point, so editing a
 * derived .md can never delete its chapter boundaries.
 *
 * Round-trip safety: `spliceChapterMarkers(s.body, s.markers) === content`
 * (where `s = stripChapterMarkers(content)`) for any unedited input — CRLF,
 * no trailing newline, a leading BOM, blank gaps and consecutive markers
 * included. Marker lines are captured as the exact matched source substring,
 * never parsed and re-serialized. The marker line shape mirrors
 * shared-contracts `chapter-splitting.ts` MARKER_LINE_RE applied to trimmed
 * lines — independent lines only, leading/trailing blanks tolerated.
 *
 * Anchor semantics: each marker remembers what followed it in the stripped
 * body — the blank gap plus the first non-empty line — and where that
 * substring started. Splice re-inserts the marker immediately before that
 * substring, resolved in three tiers: (1) the recorded position (byte-exact
 * for unedited bodies, disambiguates a duplicate anchor BEFORE the marker);
 * (2) the nearest occurrence at/after the previous marker's anchor
 * (document-order stacking when edits drifted positions); (3) the first
 * non-empty line alone at line start (the editor's serialization may drop
 * the leading gap or normalize blank runs). When no tier matches, the anchor
 * line is gone from the body — the marker is NOT re-spliced and the residual
 * chapter is left for reingest to converge. Duplicate anchor texts always
 * match in document order (nearest at/after the previous match).
 */

/** Whole-line `mat-chapter` comment (independent lines only), captured with leading blanks/BOM and the trailing newline (absent at EOF). */
const MARKER_LINE_RE = /^[ \t\uFEFF]*<!--[ \t]*mat-chapter[ \t]+[^\n]*?-->[ \t]*(?:\r?\n|$)/gm;

export interface ChapterMarker {
  /**
   * The exact matched marker line — leading blanks, comment body and its
   * trailing newline (empty when the marker closed at EOF) — byte-exact for
   * splice, never re-serialized.
   */
  markerLine: string;
  /**
   * Primary anchor: the exact stripped-body substring from where the marker
   * was removed through the end of the first non-empty line that follows
   * (leading blank gap included); all-blank tail when no non-empty line
   * follows; `''` when nothing at all followed (marker at EOF).
   */
  anchorAfter: string;
  /**
   * Trim-tolerant fallback anchor: the first non-empty line alone (no gap,
   * no line ending) — the editor's serialization may drop the gap. Empty
   * when the primary anchor is an all-blank tail.
   */
  anchorLine: string;
  /** Stripped-body offset where the anchor started at capture time. */
  anchorIndex: number;
}

export type ChapterMarkerSplit = {
  /** The document with every marker line removed. */
  body: string;
  /** Captured marker lines in document order. */
  markers: ChapterMarker[];
};

/**
 * Anchor text from a stripped-body offset: through the end of the first
 * non-empty line at/after `from` (the blank gap from `from` included), or the
 * all-blank tail when no non-empty line follows. `anchorAfter` is `''` when
 * `from` is at EOF.
 */
function captureAnchor(body: string, from: number): { anchorAfter: string; anchorLine: string } {
  let lineStart = from;
  for (;;) {
    if (lineStart >= body.length) return { anchorAfter: body.slice(from), anchorLine: '' };
    const nl = body.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? body.length : nl + 1;
    // Line content without its ending (a CRLF line keeps no trailing `\r` —
    // anchorLine must match LF-serialized bodies too).
    const lineText = body.slice(lineStart, nl === -1 ? body.length : nl).replace(/\r$/, '');
    if (lineText.trim() !== '') return { anchorAfter: body.slice(from, lineEnd), anchorLine: lineText };
    lineStart = lineEnd;
  }
}

/** Strip every `mat-chapter` marker line, capturing it byte-exact for splice. */
export function stripChapterMarkers(content: string): ChapterMarkerSplit {
  const markers: ChapterMarker[] = [];
  if (!content.includes('mat-chapter')) return { body: content, markers };

  MARKER_LINE_RE.lastIndex = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (let m = MARKER_LINE_RE.exec(content); m !== null; m = MARKER_LINE_RE.exec(content)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  if (spans.length === 0) return { body: content, markers };

  // Build the stripped body (kept spans concatenated). Anchors are captured
  // against THIS body — in stripped coordinates — so consecutive markers
  // collapse to the same removal point and stack correctly on splice.
  const strippedEnds: number[] = [];
  let body = '';
  let prevEnd = 0;
  for (const span of spans) {
    body += content.slice(prevEnd, span.start);
    strippedEnds.push(body.length);
    prevEnd = span.end;
  }
  body += content.slice(prevEnd);

  for (let i = 0; i < spans.length; i++) {
    const from = strippedEnds[i] ?? 0;
    const { anchorAfter, anchorLine } = captureAnchor(body, from);
    markers.push({
      markerLine: content.slice(spans[i]?.start ?? 0, spans[i]?.end ?? 0),
      anchorAfter,
      anchorLine,
      anchorIndex: from,
    });
  }
  return { body, markers };
}

function anchorPattern(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Every line ending (CRLF or LF) becomes the tolerant `\r?\n` pattern: the
  // editor serializes LF even for CRLF sources, so a captured CRLF anchor
  // must still match the LF body.
  return new RegExp(escaped.replace(/\r?\n/g, '\\r?\\n'), 'g');
}

/**
 * First occurrence of `text` that starts at a line start, at/after `from`.
 * Line endings match tolerantly (`\r?\n`); `-1` when absent or `text` empty.
 */
function indexOfAnchor(haystack: string, text: string, from: number): number {
  if (text === '') return -1;
  const re = anchorPattern(text);
  re.lastIndex = from > 0 ? from : 0;
  for (let m = re.exec(haystack); m !== null; m = re.exec(haystack)) {
    if (m.index === 0 || haystack.charAt(m.index - 1) === '\n') return m.index;
    re.lastIndex = m.index + 1;
  }
  return -1;
}

/**
 * Re-insert captured marker lines into the (possibly edited) editor body —
 * the byte-exact inverse of {@link stripChapterMarkers} for unedited input.
 * Markers whose anchor line the user deleted are not re-spliced.
 */
export function spliceChapterMarkers(body: string, markers: ChapterMarker[]): string {
  if (markers.length === 0) return body;
  let out = body;
  let cursor = 0; // end of the last re-inserted marker line (document-order stacking)
  let shift = 0; // total re-inserted length (keeps recorded anchor offsets valid)
  for (const marker of markers) {
    if (marker.anchorAfter === '') {
      // Nothing followed the marker at capture — re-append at the end.
      out += marker.markerLine;
      continue;
    }
    // Tier 1: recorded position. Tier 2: nearest at/after the previous
    // marker's anchor. Tier 3: the first non-empty line alone (serialization
    // dropped the gap). See the anchor-semantics note atop the file.
    let idx = indexOfAnchor(out, marker.anchorAfter, Math.max(cursor, marker.anchorIndex + shift));
    if (idx === -1) idx = indexOfAnchor(out, marker.anchorAfter, cursor);
    if (idx === -1 && marker.anchorLine !== '') idx = indexOfAnchor(out, marker.anchorLine, cursor);
    if (idx === -1) continue; // anchor line deleted by the user — marker retired
    out = out.slice(0, idx) + marker.markerLine + out.slice(idx);
    cursor = idx + marker.markerLine.length;
    shift += marker.markerLine.length;
  }
  return out;
}

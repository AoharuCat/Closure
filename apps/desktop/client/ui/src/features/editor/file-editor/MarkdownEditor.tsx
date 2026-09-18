import { useCallback, useRef, useState, useEffect } from 'react';
import { useAppStore } from '../../../shared/store/appStore';
import { useShallow } from 'zustand/react/shallow';
import { TiptapEditor, type SelectionInfo } from '../TiptapEditor';
import { DocOutline } from '../DocOutline';
import { EditorStatusBar } from './EditorStatusBar';
import { useI18n } from '../../../shared/i18n/useI18n';
import { getFrontmatterBlock, restoreFrontmatter, stripFrontmatter } from '../../../shared/utils/frontmatter';
import {
  spliceChapterMarkers,
  stripChapterMarkers,
  type ChapterMarkerSplit,
} from '../../../shared/utils/chapter-markers';
import type { FileTab } from '../../../shared/store/fileTabsSlice';
import type { SelectionAttachment } from '../../../shared/types/attachment';
import { randomUUID } from '../../../shared/util/id';

export function MarkdownEditor({ file }: { file: FileTab }) {
  const { updateFileContent, addAttachment, setAgentPanelOpen, sendAgentMessage, resolvedLocale, clearFileReveal } = useAppStore(
    useShallow((s) => ({
      updateFileContent: s.updateFileContent,
      addAttachment: s.addAttachment,
      setAgentPanelOpen: s.setAgentPanelOpen,
      sendAgentMessage: s.sendAgentMessage,
      resolvedLocale: s.resolvedLocale,
      clearFileReveal: s.clearFileReveal,
    })),
  );
  const { t } = useI18n(resolvedLocale);
  const containerRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  // The file currently bound to the live editor instance.
  const fileIdRef = useRef(file.id);
  // Last `savedContent` we reacted to, used to detect save/reload transitions.
  const savedRef = useRef(file.savedContent);
  // Latest markdown the editor holds: seeded with the mounted content, then
  // kept in sync via onChange. Lets us tell a user's own save apart from an
  // external reload/patch when `savedContent` changes. Holds the FULL text
  // (front-matter included) so it stays comparable against `savedContent`.
  const contentRef = useRef(file.content);
  // Leading front-matter block of the bound file (dogfood #109): stripped
  // before the body reaches TipTap (marked would silently drop it) and
  // re-attached byte-exact on every write-back — editing a chapter file must
  // never delete its `order:` line. Re-captured from the incoming content
  // whenever the TiptapEditor instance reseeds below (mount / tab switch /
  // external reload).
  const frontmatterRef = useRef<string | null>(getFrontmatterBlock(file.content));
  // mat-chapter marker snapshot of the bound file (dogfood R3 / R10): derived
  // .md chapter boundaries live in `<!-- mat-chapter ... -->` comment lines,
  // which TipTap's document model cannot hold — strip them before the body
  // reaches the editor and re-splice byte-exact at the single write-back
  // point below, mirroring the front-matter contract. Layering is fixed:
  // markers live in the body, so the strip order is front-matter first then
  // markers, and the splice order is markers into the body first, then
  // front-matter back in front. Re-captured from the incoming content
  // whenever the TiptapEditor instance reseeds (mount / tab switch /
  // external reload), same lifecycle as frontmatterRef.
  //
  // CR-12: the strip is a full-document scan (the R3 dogfood book: 1.4MB /
  // 98 markers), so it must NOT run as a `useRef` initializer or an inline
  // JSX prop — both re-execute on every render, and each autoSave debounce
  // tick re-renders this component with a fresh content string. Memoize once
  // per editor seed, keyed by the exact `${file.id}:${revision}` identity
  // TiptapEditor mounts on: the snapshot re-captures precisely when the
  // editor instance reseeds, and every other render (typing included) reuses
  // it. `value.markers` feeds the write-back splice below; `value.body` is
  // the seed-time editor content.
  const seededStripRef = useRef<{ key: string; value: ChapterMarkerSplit } | null>(null);
  // Body the live editor currently holds: the seed body until the first edit,
  // then the editor's own body-only markdown (handleChange tracks it — the
  // round-trip identity strip(stripFrontmatter(full)).body === markdown makes
  // this exactly what the old per-render strip computed, at zero scan cost).
  const liveBodyRef = useRef<string | null>(null);
  const editorKey = `${file.id}:${revision}`;
  if (seededStripRef.current === null || seededStripRef.current.key !== editorKey) {
    seededStripRef.current = { key: editorKey, value: stripChapterMarkers(stripFrontmatter(file.content)) };
    liveBodyRef.current = null; // reseed: the editor restarts from the seeded body
  }
  const editorBody = liveBodyRef.current ?? seededStripRef.current.value.body;

  useEffect(() => {
    // MarkdownEditor is reused across tab switches (the parent sets no React
    // key), so reset trackers whenever a different file becomes active. The
    // TiptapEditor key carries file.id, so it remounts on its own here.
    if (file.id !== fileIdRef.current) {
      fileIdRef.current = file.id;
      savedRef.current = file.savedContent;
      contentRef.current = file.content;
      frontmatterRef.current = getFrontmatterBlock(file.content);
      // Marker re-capture: seededStripRef already refreshed during the render
      // that first saw the new file.id (its key includes file.id).
      return;
    }
    if (file.savedContent === savedRef.current) return;
    savedRef.current = file.savedContent;
    // (a) User's own save: the store sets savedContent = current content, which
    //     already matches what the editor holds -> skip remount (keep cursor
    //     position and undo history).
    // (b) External reload / agent patch: savedContent becomes content the editor
    //     does not have -> bump revision to remount and reflect the change.
    if (file.savedContent !== contentRef.current) {
      contentRef.current = file.content;
      frontmatterRef.current = getFrontmatterBlock(file.content);
      // Marker re-capture: the revision bump below changes the seed key, so
      // the next render re-captures from the new content before the remounted
      // editor consumes it.
      setRevision((r) => r + 1);
    }
  }, [file.id, file.savedContent, file.content]);

  const handleChange = useCallback(
    (markdown: string) => {
      // `markdown` is the body-only serialization TipTap emits — re-splice
      // the captured marker lines back into the body, then re-attach the
      // captured front-matter before it enters the tab/store. This is the
      // ONLY write path for rich-editor edits (keystroke debounce, blur,
      // unmount and the save-time flush all funnel through TiptapEditor's
      // onChange), so the autoSave chain can never persist a derived .md
      // without its chapter boundaries nor a chapter without its front-matter.
      // Markers whose anchor line the user deleted are not re-spliced
      // (spliceChapterMarkers semantics — residual chapters are left for
      // reingest to converge). Read the ref at call time (not the render's
      // snapshot) so the markers always belong to the CURRENT editor seed.
      const full = restoreFrontmatter(
        frontmatterRef.current,
        spliceChapterMarkers(markdown, seededStripRef.current?.value.markers ?? []),
      );
      contentRef.current = full;
      liveBodyRef.current = markdown;
      updateFileContent(file.path, full);
    },
    [file.path, updateFileContent],
  );

  const handleJumpToLine = useCallback((line: number) => {
    const el = containerRef.current;
    if (!el) return;
    const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const lines = file.content.split('\n');
    let headingIndex = 0;
    for (let i = 0; i < line; i++) {
      if (/^#{1,6}\s+/.test(lines[i])) headingIndex++;
    }
    const target = headings[headingIndex];
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [file.content]);

  const handleSelectionAction = useCallback((action: 'review' | 'attach' | 'continue' | 'polish', sel: SelectionInfo) => {
    const content = contentRef.current;
    const prefix = content.slice(Math.max(0, sel.from - 50), sel.from);
    const suffix = content.slice(sel.to, sel.to + 50);
    const att: SelectionAttachment = {
      type: 'selection',
      id: randomUUID(),
      label: sel.text.slice(0, 20) + (sel.text.length > 20 ? '…' : ''),
      text: sel.text,
      sourceType: 'file',
      filePath: file.path,
      anchor: { quote: sel.text, prefix, suffix, rangeHint: { from: sel.from, to: sel.to } },
    };
    addAttachment(att);
    setAgentPanelOpen(true);
    if (action === 'review') {
      void sendAgentMessage(t('editor.aiReviewPrompt'));
    } else if (action === 'continue') {
      void sendAgentMessage(t('editor.aiContinuePrompt'));
    } else if (action === 'polish') {
      void sendAgentMessage(t('editor.aiPolishPrompt'));
    }
  }, [file.path, addAttachment, setAgentPanelOpen, sendAgentMessage, t]);

  const handleRevealHandled = useCallback(() => {
    clearFileReveal(file.path);
  }, [clearFileReveal, file.path]);

  return (
    <div className="file-editor-md" ref={containerRef}>
      <DocOutline content={file.content} onJump={handleJumpToLine} />
      <TiptapEditor
        key={editorKey}
        content={editorBody}
        format="markdown"
        placeholder="Start writing..."
        onChange={handleChange}
        flush
        bubbleMenu
        onSelectionAction={handleSelectionAction}
        reveal={file.reveal}
        onRevealHandled={handleRevealHandled}
      />
      <EditorStatusBar content={file.content} fileType="Markdown" />
    </div>
  );
}

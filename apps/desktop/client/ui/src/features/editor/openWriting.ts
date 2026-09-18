import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { translate } from '../../shared/i18n/useI18n';
import type { NovelChapterMeta } from '../../shared/store/novelChapterSlice';
import { normalizePath } from '../../shared/utils/paths';

/**
 * Open a chapter's manuscript file as a tab (the source of truth). Given no
 * chapter, opens the most recently edited one. Falls back to the outline page
 * when the project has no chapters yet or the file can't be read, so the
 * "writing" entry point always lands somewhere useful instead of a dead editor.
 *
 * Shared by the overview "Continue writing" action, the world panel's scene jump
 * and the writing page's chapter column so all drive the exact same file-editor
 * flow. (The side-nav writing entry became a page route in task
 * 09-13-writing-page-ui; it is no longer an openWriting caller.)
 *
 * dogfood R2 #20：无章节 fallback 只切大纲页——用户已在大纲页时是视觉 no-op，
 * 点击「无反应」。补 toast 引导（说明为什么落大纲页 + 下一步），反馈不再静默。
 */
export async function openWriting(chapter?: NovelChapterMeta): Promise<void> {
  const state = useAppStore.getState();
  const projectPath = state.currentProject?.path;
  const chapters = state.novelChapters as NovelChapterMeta[];
  const recent = [...chapters].sort((a, b) => b.sortOrder - a.sortOrder);
  const target = chapter ?? recent[0];
  const contentFile = target?.sections?.[0]?.contentFile;
  if (!projectPath || !target || !contentFile) {
    useToastStore.getState().showToast(translate(state.resolvedLocale, 'nav.writingNoChapters'), 'info', 4000);
    state.setActivePage('outline');
    return;
  }
  const filePath = `${normalizePath(projectPath)}/${contentFile}`;
  const name = contentFile.slice(contentFile.lastIndexOf('/') + 1);
  try {
    const content = await window.orisonDesktop?.readFile(filePath);
    state.openFile(filePath, name, content ?? '');
  } catch {
    state.setActivePage('outline');
  }
}

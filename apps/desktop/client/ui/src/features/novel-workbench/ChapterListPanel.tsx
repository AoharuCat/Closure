import { type DragEvent, useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { deriveChaptersFromDisk } from '../../shared/store/chapterDiskDerivation';
import { useToastStore } from '../../shared/store/toastStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { normalizePath } from '../../shared/utils/paths';
import type { NovelChapterMeta } from '../../shared/store/novelChapterSlice';

/**
 * Story 4.1 Step 5（design §3.4）：工作台 leader 触发入口。
 *
 * 章号从 episode.index 派生（creative-fields.ts「章号从 episode.index 派生（非存储键）」
 * / workbenchLayout.ts「章 = episode.index, derived not stored」）——故
 * chapter.sortOrder === episode.index 是本章对应的 episode。
 * 写章链段按 episodeId 触发（write_chapter params.episodeId），用户选章直传 chapterId
 * 绕过映射推断（design §3.3 directChapterId 优先）。
 *
 * 最小形态（不建 E3 横切工作面）：章列表每行加「生成」按钮 → sendAgentMessage（自然语言
 * + episodeId/chapterId 上下文）→ leader runLoop 凭 DEFAULT_CLOSURE_PROMPT 的 write_chapter
 * 引导调工具。leader 决定何时调 / 传什么 brief（design §3.4）。
 */
function findEpisodeForChapter(
  episodeOutlines: unknown,
  sortOrder: number,
): { id: string; title?: string } | undefined {
  if (!Array.isArray(episodeOutlines)) return undefined;
  for (const ep of episodeOutlines) {
    if (ep && typeof ep === 'object' && 'index' in ep && 'id' in ep) {
      const node = ep as { id: unknown; index: unknown; title?: unknown };
      if (typeof node.id === 'string' && node.index === sortOrder) {
        return { id: node.id, title: typeof node.title === 'string' ? node.title : undefined };
      }
    }
  }
  return undefined;
}

export function ChapterListPanel() {
  const {
    chapters, activeId, selectChapter, moveNovelChapter, resolvedLocale,
    sendAgentMessage, projectRunActive, episodeOutlines, projectPath,
  } = useAppStore(
    useShallow((s) => ({
      chapters: s.novelChapters,
      activeId: s.activeChapterId,
      selectChapter: s.selectChapter,
      moveNovelChapter: s.moveNovelChapter,
      resolvedLocale: s.resolvedLocale,
      sendAgentMessage: s.sendAgentMessage,
      // dogfood T1 Stage 3（r8 三分）：生成闸是**项目运行**语义（该项目任一会话在跑都禁——
      // D4 同项目单 run，生成会发 agent 消息触发写章链）。
      projectRunActive: isProjectRunActive(s),
      episodeOutlines: s.creativeFields.episode_outlines,
      projectPath: s.currentProject?.path,
    })),
  );
  const { t } = useI18n(resolvedLocale);

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [creatingFirstChapter, setCreatingFirstChapter] = useState(false);

  const handleGenerate = useCallback(
    (ch: NovelChapterMeta, episode: { id: string; title?: string } | undefined) => {
      // CR-4.1-18：ordinal 兜底（sortOrder undefined → '?'，避免「第 NaN 章」进 sendAgentMessage 文本）。
      // episode 由 render 侧预算并传入；无 episode 时按钮已禁用（write_chapter episodeId 必填，
      // UI 健壮避免 leader 收到无法调工具的消息卡住）。epPart else 分支仅作防御性兜底。
      const ordinal = Number.isFinite(ch.sortOrder) ? ch.sortOrder + 1 : '?';
      const epPart = episode
        ? `（episodeId: ${episode.id}${episode.title ? `「${episode.title}」` : ''}）`
        : `（未在 episode_outlines 找到 index=${ch.sortOrder} 的 episode）`;
      const message = `请生成第 ${ordinal} 章「${ch.title || ch.id}」${epPart}，目标 chapterId: ${ch.id}。请调用 write_chapter 工具触发写章链段。`;
      void sendAgentMessage(message);
    },
    [sendAgentMessage],
  );

  // dogfood R2 #107（R1.2）：零章冷启动空态「新建第一章」——把「用户手动在 chapters/
  // 建文件」这个既有手势自动化。两步走 createEntry（建空文件，父目录缺失自动补）+
  // writeFile（补 skeleton：frontmatter order + # 标题，磁盘派生消费契约见
  // chapterDiskDerivation）。stem 锚当前章数（0-based 对齐 episode.index），标题留给
  // 用户在编辑器里改。
  // 建完**主动派生注册**（mirror useToolEvents.scheduleChapterRefresh 主体）：writeFile
  // 的 shell handler 会 registerSelfWrite 抑制 watcher 广播，本突发的两条 fs 事件都可能
  // 被吞——主动 derive 保证章列表立即注册（setNovelChapters → sync-chapters-meta 落
  // yaml）；watcher 车道（file:changed 事件幸存时）幂等兜底。异步边界后按路径守卫
  // （项目已切换则丢弃，防跨项目串写）。
  const handleCreateFirstChapter = useCallback(async () => {
    const state = useAppStore.getState();
    const projectPath = state.currentProject?.path;
    if (!projectPath || creatingFirstChapter) return;
    setCreatingFirstChapter(true);
    try {
      const nextIndex = state.novelChapters.length;
      const stem = `第${String(nextIndex + 1).padStart(2, '0')}章`;
      const fullPath = normalizePath(`${projectPath}/chapters/${stem}.md`);
      const skeleton = `---\norder: ${nextIndex}\n---\n\n# 未命名章节\n`;
      const created = await window.orisonDesktop?.createEntry(fullPath, false);
      if (created !== true) {
        // createEntry 对已存在路径返 false（防截断真稿）——失败报错，不静默。
        useToastStore.getState().showToast(t('novelChapter.createFirstFailed'), 'error');
        return;
      }
      const written = await window.orisonDesktop?.writeFile(fullPath, skeleton);
      if (written === false) {
        // 空文件中间态无害（派生成无 frontmatter 章按文件名排），报错即止。
        useToastStore.getState().showToast(t('novelChapter.createFirstFailed'), 'error');
        return;
      }
      try {
        const chapters = await deriveChaptersFromDisk(projectPath, state.novelChapters);
        const latest = useAppStore.getState();
        if (latest.currentProject?.path === projectPath) {
          latest.setNovelChapters(chapters);
        }
      } catch {
        // 派生失败静默：文件已上盘，watcher 车道（file:changed → 派生注册）兜底。
      }
    } catch {
      useToastStore.getState().showToast(t('novelChapter.createFirstFailed'), 'error');
    } finally {
      setCreatingFirstChapter(false);
    }
  }, [creatingFirstChapter, t]);

  const handleDragStart = useCallback((e: DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: DragEvent, toIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    const fromIndex = dragIndexRef.current;
    if (fromIndex !== null && fromIndex !== toIndex) {
      moveNovelChapter(fromIndex, toIndex);
    }
    dragIndexRef.current = null;
  }, [moveNovelChapter]);

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    dragIndexRef.current = null;
  }, []);

  if (chapters.length === 0) {
    return (
      <div className="novel-chapter-list-empty">
        <p>{t('novelChapter.emptyList')}</p>
        {projectPath ? (
          <button
            type="button"
            className="novel-chapter-list-empty-create"
            onClick={() => void handleCreateFirstChapter()}
            disabled={creatingFirstChapter}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {t('novelChapter.createFirstChapter')}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="novel-chapter-list" aria-label="Chapter List">
      {chapters.map((ch: NovelChapterMeta, index: number) => {
        const active = ch.id === activeId;
        const isDragOver = dragOverIndex === index;
        // CR-4.1-18：无 episode（章未在 episode_outlines 排出）→ 禁用「生成」按钮（write_chapter
        // episodeId 必填；UI 健壮避免 leader 收到无法调工具的消息卡住。episodeId 保持必填 +
        // readiness gate 不变）。
        const episode = findEpisodeForChapter(episodeOutlines, ch.sortOrder);
        const canGenerate = !projectRunActive && episode !== undefined;
        return (
          <li
            key={ch.id}
            className={`novel-chapter-item${active ? ' novel-chapter-itemActive' : ''}${isDragOver ? ' novel-chapter-item--drag-over' : ''}`}
            data-status={ch.status}
            data-chapter-id={ch.id}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
          >
            <button
              type="button"
              onClick={() => selectChapter(ch.id)}
              className="novel-chapter-button"
            >
              <span className="novel-chapter-title">{ch.title || t('novelChapter.unnamed', { id: ch.id })}</span>
              <span className="novel-chapter-status">{t(`novelChapter.statusValue.${ch.status}`)}</span>
              {ch.summary ? (
                <span className="novel-chapter-summary">{ch.summary}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="novel-chapter-generate-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleGenerate(ch, episode);
              }}
              disabled={!canGenerate}
              title={episode ? t('novelChapter.generateChapter') : t('novelChapter.generateChapterNoEpisode')}
              aria-label={episode ? t('novelChapter.generateChapter') : t('novelChapter.generateChapterNoEpisode')}
            >
              <span className="material-symbols-outlined">auto_awesome</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

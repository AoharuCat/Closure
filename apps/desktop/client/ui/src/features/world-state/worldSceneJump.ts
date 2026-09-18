/**
 * 变更行「跳场景」的 scene → 章映射（dogfood R2 #92，task 08-29-world-state-panel S5；
 * #203 拍板：跳转出口 = 「打开该章正文 md 文件 tab」）。
 *
 * 数据链（全部现成数据源，零新查询）：
 *   patch.evidenceSceneId（SceneNode.id）
 *     → scene_graph.nodes 里找该场（isSceneGraphLike 形态守卫——structure/layout.ts 单源）
 *     → 场的章归属：episodeId（单章场）∪ presentationSpans[].episodeId（跨章场 M:N，
 *       creative-fields.ts presentationSpanSchema）取 episode.index 最小者（首次出现章）
 *     → episode_outlines 按 id 查 index（承载树原子；creative-fields.ts「章号从 episode.index
 *       派生（非存储键）」）
 *     → novelChapters 中 sortOrder === index 的章，且该章**携正文文件**（sections[0].contentFile
 *       非空串——见 readChapterContentFile）
 *     → openWriting(chapter)（features/editor/openWriting.ts——OverviewPage「继续写作」与
 *       写作页章节列同款文件 tab 流：readFile + openFile，本面板复用同一出口）
 *
 * 兜底：episode 归属全缺时回落 presentationOrder.chapter（阅读起始章 ordinal，schema 必填，
 * 与 episode.index 同一章序空间——workbenchLayout「章 = episode.index, derived not stored」）。
 * 任一环节查不到（场不在 scene_graph / episode 未排 / 章未建 / **章未写正文文件**）→ null：
 * UI 置灰不崩（prd 验收 4「无值置灰」——#203 拍板后置灰口径落在「文件可打开性」上，章有行
 * 无文件同样置灰，不落 openWriting 的大纲页 fallback）。
 *
 * 元素级守卫纪律（spec/ui/state-management「数组形状守卫必到元素级」）：creativeFields 的
 * unknown seam 逐节点验 id/index/episodeId 形态，畸形数据静默降级 null。
 */
import { isSceneGraphLike } from '../structure/layout';

/** 章元数据最小面（NovelChapterMeta 的结构子集——测试可自造轻量章）。 */
export interface WorldChapterLike {
  id: string;
  sortOrder: number;
}

/**
 * 跳转目标 = 章元数据本身（泛型透传调用方章类型：面板传 NovelChapterMeta[] → 目标可直喂
 * openWriting；测试传轻量章）。正文文件在 resolve 内元素级校验（章未写 → null）。
 */
export interface WorldSceneChapterTarget<T extends WorldChapterLike = WorldChapterLike> {
  chapter: T;
}

interface SceneEpisodeLink {
  episodeIds: string[];
  fallbackChapterOrdinal: number | null;
}

/** scene_graph.nodes 里按 id 找场并提取章归属线索（元素级守卫——残缺节点跳过）。 */
function readSceneEpisodeLink(sceneGraph: unknown, sceneId: string): SceneEpisodeLink | null {
  if (!isSceneGraphLike(sceneGraph)) return null;
  for (const raw of sceneGraph.nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    if (node.id !== sceneId || typeof node.id !== 'string') continue;
    const episodeIds: string[] = [];
    if (typeof node.episodeId === 'string' && node.episodeId.length > 0) {
      episodeIds.push(node.episodeId);
    }
    const spans = node.presentationSpans;
    if (Array.isArray(spans)) {
      for (const span of spans) {
        if (!span || typeof span !== 'object') continue;
        const epId = (span as Record<string, unknown>).episodeId;
        if (typeof epId === 'string' && epId.length > 0) episodeIds.push(epId);
      }
    }
    const po = node.presentationOrder;
    const chapter = po && typeof po === 'object' ? (po as Record<string, unknown>).chapter : undefined;
    const fallbackChapterOrdinal = typeof chapter === 'number' && Number.isFinite(chapter)
      ? chapter
      : null;
    return { episodeIds, fallbackChapterOrdinal };
  }
  return null;
}

/** episode_outlines 里按 id 收集 index（元素级守卫）。 */
function collectEpisodeIndices(episodeOutlines: unknown): Map<string, number> {
  const indices = new Map<string, number>();
  if (!Array.isArray(episodeOutlines)) return indices;
  for (const raw of episodeOutlines) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    if (typeof entry.index !== 'number' || !Number.isFinite(entry.index)) continue;
    indices.set(entry.id, entry.index);
  }
  return indices;
}

/**
 * 章正文文件读取（元素级守卫）：章未写 = sections 缺失/空/首节畸形/首节无非空 contentFile
 * → null（跳转钮置灰——#203 拍板「开章文件 tab」的置灰语义落在文件可打开性上）。
 */
function readChapterContentFile(chapter: unknown): string | null {
  if (!chapter || typeof chapter !== 'object') return null;
  const sections = (chapter as Record<string, unknown>).sections;
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const first = sections[0];
  if (!first || typeof first !== 'object') return null;
  const contentFile = (first as Record<string, unknown>).contentFile;
  return typeof contentFile === 'string' && contentFile.length > 0 ? contentFile : null;
}

/**
 * scene → 章 定位（纯函数）。返回 null = 查不到映射或章未写正文（跳场景钮置灰）。
 * 跨章场（presentationSpans 多项）取 episode.index 最小的章 = 该场首次出现的章。
 */
export function resolveSceneChapterTarget<T extends WorldChapterLike>(input: {
  sceneGraph: unknown;
  episodeOutlines: unknown;
  chapters: ReadonlyArray<T>;
  sceneId: string;
}): WorldSceneChapterTarget<T> | null {
  const { sceneGraph, episodeOutlines, chapters, sceneId } = input;
  const link = readSceneEpisodeLink(sceneGraph, sceneId);
  if (!link) return null;

  let chapterOrdinal: number | null = null;
  if (link.episodeIds.length > 0) {
    const indices = collectEpisodeIndices(episodeOutlines);
    for (const episodeId of link.episodeIds) {
      const index = indices.get(episodeId);
      if (index === undefined) continue;
      if (chapterOrdinal === null || index < chapterOrdinal) chapterOrdinal = index;
    }
  }
  if (chapterOrdinal === null) chapterOrdinal = link.fallbackChapterOrdinal;
  if (chapterOrdinal === null) return null;

  if (!Array.isArray(chapters)) return null;
  const chapter = chapters.find(
    (ch) => ch && typeof ch === 'object' && ch.sortOrder === chapterOrdinal,
  );
  if (!chapter || readChapterContentFile(chapter) === null) return null;
  return { chapter };
}

/** 面板用解析器工厂：按 sceneId 记忆化（同场出现在多条变更行，逐行重解析浪费）。 */
export function makeSceneJumpResolver<T extends WorldChapterLike>(deps: {
  sceneGraph: unknown;
  episodeOutlines: unknown;
  chapters: ReadonlyArray<T>;
}): (sceneId: string) => WorldSceneChapterTarget<T> | null {
  const cache = new Map<string, WorldSceneChapterTarget<T> | null>();
  return (sceneId: string): WorldSceneChapterTarget<T> | null => {
    if (cache.has(sceneId)) return cache.get(sceneId) ?? null;
    const target = resolveSceneChapterTarget({ ...deps, sceneId });
    cache.set(sceneId, target);
    return target;
  };
}

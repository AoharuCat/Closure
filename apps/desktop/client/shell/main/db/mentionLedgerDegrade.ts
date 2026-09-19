import path from 'node:path';
import { resolveEpisodeIdForChapter } from '@orison/shared-contracts';
import { getProject } from './projectRepository';
import { degradeEpisodeMentions } from './mentionLedgerRepository';
import { getLogger } from '../logger';

// ── Story 8.7 BMad CR-001（方案 A：章落盘统一降档，2026-08-19）──
//
// 对话侧修订后 mention 账降档的落盘统一 hook：design §2.3 的失效语义在链内已由 targeted-revision
// 降档包装兑现，但**对话侧**改章（rewrite_passage accept、7.4 修订 splice 落盘、agent/用户直接写
// chapters/*.md）此前零接线——章正文变了而该章账保持 full 档 + 旧申报 + synopsis 无 stale 标注。
//
// 方案 A 取舍（CR-001 三分支裁决）：落盘点统一调本 hook（侵入小），不做惰性指纹校验（design 原
// 承诺——closure_mention 无章指纹列，读路径校验实现较大且读路径加成本）。
//
// 覆盖的落盘点（grep 找齐的**真实写盘点**，全部 shell 层汇聚）：
// 1. `chapter_write` 工具 handler（chapterHandlers.ts）——agent 会话侧整章重写 + 7.4 auto_revise
//    修订 splice 落盘（write-chapter.ts CR-004 fix 经 registry chapter_write 汇聚到此）；
// 2. `write_file` 工具 handler（fileHandlers.ts）——agent 通用文件写（chapters/*.md 亦可达）；
// 3. `project:write-file` IPC（projectFileIpc.ts）——编辑器侧写盘（rewrite_passage accept 的
//    persistChapterContent → saveFile、整章 diff accept、手编保存、reject 还原全走此通道）。
// 链内 chapter_accept 持久化路径（local-bff acceptChapterCandidate 家族）**不在覆盖面**——accept
// 写的是链段刚产的正文（mention-ledger-node 已为其记账），降档反而错杀新鲜 full 账。
//
// **best-effort 契约**：任何失败（项目未注册 / project.yaml 读不了 / 映射失败 / db 写失败）只 warn
// 不抛——账是 DERIVED 增强层，降档失败不阻正文落盘（正文是唯一文件真相源 ADR-1）。degradeEpisodeMentions
// 自身幂等（重复降档 no-op），链内 targeted-revision 已降档后 7.4 splice 再经 chapter_write 落盘
// 会重复触发本 hook——幂等无害，仅多一次廉价 no-op UPDATE。
//
// 范式判据（ADR-3）：chapterId→episodeId 反向映射（resolveEpisodeIdForChapter 单源）+ registry
// projectId 解析 + 降档调用 = 全纯代码结构查询/机械失效，零语义判断。

/**
 * 章正文写盘后的 mention 账降档（best-effort，永不抛）。
 *
 * @param projectDir 会话/项目根目录（registry 命名空间解析 + project.yaml 读取）。
 * @param chapterId  章 id（= chapters/ 目录文件名 stem，chapter_write 工具的 chapterId 形态——
 *                   与 chapterHandlers chapter_list 增强共用「stem ↔ chapter.id」同一约定）。
 */
export async function degradeMentionLedgerForChapterFile(
  projectDir: string,
  chapterId: string,
): Promise<void> {
  try {
    // 1. registry projectId（未注册 → 静默 no-op：项目没进 db 就没有 mention 账可降）。
    const projectId = getProject(path.resolve(projectDir))?.projectId;
    if (!projectId) return;

    // 2. project.yaml → episode_outlines + novel.chapters（防御 raw 抽取，mirror chapterHandlers
    //    loadChapterListEnrichment 抽取形态；loader 单源 local-bff loadProject——含既有迁移 + 整档校验）。
    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = loadProject(projectDir) as Record<string, unknown> | null;
    if (doc === null) return;
    const rawEpisodes = doc.episode_outlines;
    const rawChapters = (doc.novel as { chapters?: unknown } | undefined)?.chapters;
    if (!Array.isArray(rawEpisodes) || !Array.isArray(rawChapters)) return;
    const episodes = rawEpisodes
      .map((ep) => ep as { id?: unknown; index?: unknown })
      .filter((ep): ep is { id: string; index: number } => typeof ep.id === 'string' && typeof ep.index === 'number');
    const chapters = rawChapters
      .map((ch) => ch as { id?: unknown; sort_order?: unknown })
      .filter((ch): ch is { id: string; sort_order?: number } => typeof ch.id === 'string');

    // 3. 反向映射（canonical 链单源取反；失败 → no-op，不猜）。
    const episodeId = resolveEpisodeIdForChapter(episodes, chapters, chapterId);
    if (episodeId === undefined) return;

    // 4. 复合降档（行降保守档 + synopsis 标 stale + 删信号行，单事务幂等）。
    const result = degradeEpisodeMentions(projectId, episodeId);
    getLogger().info(
      { projectDir, chapterId, episodeId, changedRows: result.changedRows, synopsisMarked: result.synopsisMarked },
      'mentionLedgerDegrade: chapter prose rewritten → mention ledger degraded to conservative (CR-001)',
    );
  } catch (err) {
    getLogger().warn(
      { projectDir, chapterId, err: err instanceof Error ? err.message : String(err) },
      'mentionLedgerDegrade: best-effort degrade failed → skip (prose write stands, ledger stays until re-collect)',
    );
  }
}

/**
 * 写盘路径 → chapterId（文件名 stem）；非章正文文件返 undefined。
 *
 * 判据 = `<projectRoot>/chapters/<stem>.md`（CHAPTERS_DIR 约定：chapter_write/chapter_read/
 * chapter_list 全按此目录寻址，chapterHandlers 现状注释「stem = 文件名去 .md = chapterId 形态」）。
 * settings/、project.yaml、笔记等他路径零成本直过（不触发 loadProject）。子目录（chapters/draft/x.md）
 * 不是工具层可达形态，不认。
 */
export function chapterIdOfChapterFilePath(fullPath: string, projectRoot: string): string | undefined {
  const normalized = fullPath.replace(/\\/g, '/');
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const marker = `${root}/chapters/`;
  // 大小写不敏感 fs（CR-5 / FS#9，门 = 非 linux）：win32 NTFS 与 macOS APFS（默认）
  // 都不区分大小写——目录段大小写漂移（用户在资源管理器/Finder 把 chapters 改成
  // Chapters）不该让判据静默失配——前缀比较按 pathGuard.normalizeForCompare 同款仅在
  // 非 linux 平台归一大小写；stem 仍从原大小写切片（chapterId 与盘上文件名 stem /
  // yaml 注册 id 的精确匹配依赖原大小写，不能随比较归一被小写化）。
  const compareForOs = (value: string): string =>
    process.platform !== 'linux' ? value.toLowerCase() : value;
  if (!compareForOs(normalized).startsWith(compareForOs(marker))) return undefined;
  const rest = normalized.slice(marker.length);
  if (rest.length === 0 || rest.includes('/')) return undefined; // 子目录非章文件形态
  if (!rest.endsWith('.md')) return undefined;
  const stem = rest.slice(0, -3);
  return stem.length > 0 ? stem : undefined;
}

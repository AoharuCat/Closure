import { dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RegisteredProject } from '@orison/shared-contracts';
import { allowPath, assertSafePath, getProjectsRoot } from './pathGuard';
import { watchProject, unwatchProject } from '../fs/projectWatcher';
import { startAssetCardsWatcher, stopAssetCardsWatcher } from '../db/assetCardsWatcher';
import { startSettingMdWatcher, stopSettingMdWatcher } from '../db/settingMdWatcher';
import { startChapterChunkWatcher, stopChapterChunkWatcher } from '../db/chapterChunkWatcher';
import { startProjectMaterialWatcher, stopProjectMaterialWatcher } from '../db/materialWatcher';
import { backfillProjectMaterials } from '../db/materialIndexer';
import { reindexAssetCards } from '../db/assetCardsIndexer';
import { reindexAllSettingMd } from '../db/settingMdIndexer';
import { rebuildChapterChunks } from '../db/chapterChunkIndexer';
import { notifyUI, notifyProjectQuarantined } from './toolNotify';
import { ensureProject, getProject, listProjects, touchProject } from '../db/projectRepository';
import { registerProjectFileIpc } from './projectFileIpc';
import { registerProjectMetaIpc } from './projectMetaIpc';
import { deleteProject, duplicateProject, renameProject } from './projectLifecycle';
import { withProjectLock } from '../fs/projectWriteLock';
import { loadVerifiedProjectDocument } from './projectIdentity';
import { getLogger } from '../logger';

export function registerProjectIpc() {
  const projectsRoot = getProjectsRoot();
  if (!existsSync(projectsRoot)) {
    mkdirSync(projectsRoot, { recursive: true });
  }

  /* ── Dialog-based (user picks path via OS dialog — inherently safe) ── */

  ipcMain.handle('project:pick-directory', async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: projectsRoot,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : allowPath(result.filePaths[0]);
  });

  ipcMain.handle('project:pick-cover-image', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
      ]
    });
    return result.canceled ? null : allowPath(result.filePaths[0]);
  });

  /* ── Project-scoped file operations ── */
  registerProjectFileIpc();

  /* ── Meta sync, docx import/conversion, recursive directory read ── */
  registerProjectMetaIpc();

  /* ── Local project registration (SQLite) ── */
  ipcMain.handle('project:ensure-registration', async (_, input: { projectId?: string; name: string; type: 'novel' | 'script'; localFingerprint: string; path?: string; coverImage?: string }) => {
    const localFingerprint = path.resolve(input.localFingerprint);
    const projectPath = path.resolve(input.path ?? input.localFingerprint);
    if (localFingerprint !== projectPath) throw new Error('Project fingerprint must match project path');
    assertSafePath(projectPath);
    let projectId = input.projectId;
    const existing = getProject(projectPath);
    if (existing && !existing.deletedAt) {
      const verified = await withProjectLock(projectPath, () =>
        loadVerifiedProjectDocument(projectPath, existing));
      // quarantine-notify：打开工程链上的判腐隔离 → 通知中心（renderer 按工程去重）。
      if (verified.quarantined) notifyProjectQuarantined(projectPath, verified.quarantined);
      if (verified.document) projectId = existing.projectId;
    }
    if (projectId) {
      const { loadProjectWithQuarantine } = await import('@orison/desktop-local-bff');
      const { document, quarantined } = loadProjectWithQuarantine(projectPath);
      if (quarantined) notifyProjectQuarantined(projectPath, quarantined);
      if (document?.meta.project_id !== projectId) projectId = undefined;
    }
    const record = ensureProject({ ...input, projectId, localFingerprint, path: projectPath });
    return { projectId: record.projectId, name: record.name, type: record.type };
  });

  // Durable project list for ProjectsPage (survives app version changes / reinstalls).
  ipcMain.handle('project:list-registered', async () => {
    const projects: RegisteredProject[] = [];
    for (const r of listProjects()) {
      const projectPath = path.resolve(r.path ?? r.localFingerprint);
      try {
        const verified = await withProjectLock(projectPath, () =>
          loadVerifiedProjectDocument(projectPath, r));
        // quarantine-notify：冷启动项目列表的加载也可能判腐隔离（早于任何工程打开——
        // 通知在 renderer 先于 current-project 匹配守卫处理，不会被未开工程态吞掉）。
        if (verified.quarantined) notifyProjectQuarantined(projectPath, verified.quarantined);
        if (!verified.document) continue;
        projects.push({
          projectId: r.projectId,
          name: r.name,
          type: r.type,
          path: allowPath(projectPath),
          coverImage: r.coverImage,
          lastOpenedAt: r.lastOpenedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      } catch {
        continue;
      }
    }
    return projects;
  });

  ipcMain.handle('project:touch-registration', async (_, input: { localFingerprint: string; coverImage?: string }) => {
    touchProject(input);
  });

  ipcMain.handle('project:duplicate', async (_, projectPath: string, name: string) => {
    return duplicateProject(projectPath, name);
  });

  ipcMain.handle('project:rename', async (_, projectPath: string, name: string) => {
    return renameProject(projectPath, name);
  });

  ipcMain.handle('project:delete', async (_, projectPath: string) => {
    return deleteProject(projectPath, (target) => shell.trashItem(target));
  });

  /* ── Filesystem watcher (auto-refresh on external changes) ── */
  ipcMain.handle('project:watch', async (_, projectDir: string) => {
    watchProject(projectDir);
    // Story 2.7: also watch project.yaml for asset_cards edits (dedicated watcher
    // — NOT projectWatcher, whose self-write suppression would swallow the app's
    // own field-sync saves). Started alongside watchProject so both share the
    // project-open / project-close lifecycle.
    startAssetCardsWatcher(projectDir);
    // Backfill (GAP1): existing projects' asset_cards were never indexed before
    // this story. Reindex once on project open so old cards land in closure_*
    // immediately. Fire-and-forget: async embeds (slow) must not block project
    // open; hash-skip makes unchanged cards cheap. Emit a `closure:indexed` event
    // only when cards were actually indexed (count>0 success / error) — the
    // renderer toast handler (C段) surfaces it; incremental saves stay silent.
    void reindexAssetCards(projectDir)
      .then(({ reindexed }) => {
        if (reindexed > 0) {
          notifyUI({
            type: 'closure:indexed',
            kind: 'asset_cards',
            projectPath: projectDir,
            count: reindexed,
            status: 'success',
          });
        }
      })
      .catch((err) => {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectDir },
          'asset_cards open-project backfill failed — continuing',
        );
        notifyUI({
          type: 'closure:indexed',
          kind: 'asset_cards',
          projectPath: projectDir,
          count: 0,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    // Story 2.3: also watch `settings/*.md` for long-form setting prose edits
    // (dedicated watcher, same lifecycle as assetCardsWatcher - started here,
    // stopped in project:unwatch + will-quit). Backfill (GAP1): existing
    // projects' settings/*.md were never indexed before this story. Reindex once
    // on project open so old prose lands in closure_* immediately. Fire-and-
    // forget + SILENT (no toast): the 2.7 `closure:indexed` toast message is
    // card-specific ("设定卡片...张"), so a setting_md toast would mislead; the
    // proper setting_md toast + management-page count is Step 4 UI scope. Hash-
    // skip makes unchanged docs cheap; async embeds must not block project open.
    startSettingMdWatcher(projectDir);
    void reindexAllSettingMd(projectDir).catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectDir },
        'setting_md open-project backfill failed - continuing',
      );
    });
    // Story 8.3: also watch `chapters/*.md` for chapter-prose chunk indexing (dedicated
    // watcher, same lifecycle as settingMdWatcher - started here, stopped in
    // project:unwatch + will-quit). Backfill: existing projects' chapters were never
    // chunk-indexed before this story; rebuild once on project open (hash-skip makes
    // unchanged chapters a cheap no-op, orphan sweep clears deleted-while-closed
    // chapters). Fire-and-forget + SILENT (no toast - a chunk-count toast is S4
    // management-page scope); async embeds must not block project open. Project not
    // registered -> no registry projectId -> skip (watcher reindexes on later events
    // once registered).
    startChapterChunkWatcher(projectDir);
    const chapterProjectId = getProject(path.resolve(projectDir))?.projectId;
    if (chapterProjectId) {
      void rebuildChapterChunks(chapterProjectId, projectDir).catch((err) => {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectDir },
          'chapter chunk open-project backfill failed - continuing',
        );
      });
    }
    // Story 10.1 Wave C（F-10）：项目车道 materials/ watcher——同生命周期（started here,
    // stopped in project:unwatch + will-quit, mirror 三先例旁）。Backfill（F-16）：开项目
    // 扫描 materials/ 候选——未登记原件完整摄取（解析→分章→派生 .md→登记→索引），已登记
    // 且派生新鲜走 mtime 快路零解析；orphan 清扫删外部移除的原件行。Fire-and-forget +
    // SILENT（进度/材料页计数归 Wave D）；项目未注册 → backfill 内部跳过（watcher 在注册
    // 后的事件里自愈，mirror chapterChunk 语义）。
    startProjectMaterialWatcher(projectDir);
    void backfillProjectMaterials(projectDir).catch((err) => {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectDir },
        'material open-project backfill failed - continuing',
      );
    });
  });

  ipcMain.handle('project:unwatch', async () => {
    unwatchProject();
    // Story 2.7: stop the asset_cards watcher on project close/switch so no fs
    // watcher / debounce timer outlives the active project (mirror unwatchProject).
    stopAssetCardsWatcher();
    // Story 2.3: stop the setting_md watcher too (same lifecycle as
    // assetCardsWatcher - mirror stopAssetCardsWatcher).
    stopSettingMdWatcher();
    // Story 8.3: stop the chapter chunk watcher too (same lifecycle - mirror
    // stopSettingMdWatcher).
    stopChapterChunkWatcher();
    // Story 10.1: stop the project material watcher too (same lifecycle - mirror
    // stopChapterChunkWatcher; 泄漏守卫：清 debounce timer + pending 集)。
    stopProjectMaterialWatcher();
  });
}

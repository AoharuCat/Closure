import { ipcMain } from 'electron';
import { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, readdirSync, statSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SaveBase64ImageInput } from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { allowPath, assertSafePath, assertWithinProject, resolveCreateParent } from './pathGuard';
import { decodeFileToUtf8 } from '../fs/decodeText';
import { findProjectRootFor, snapshotToLocalHistory, snapshotTreeToLocalHistory } from '../fs/localHistory';
import { registerSelfWrite } from '../fs/projectWatcher';
import { notifyUI } from './toolNotify';
import {
  ALLOWED_IMAGE_DIRS,
  buildProjectPath,
  createImageFileName,
  isBinaryReadable,
  mimeTypeFromExt,
  readDirectoryRecursive,
} from './projectIpcHelpers';
import { searchProjectFiles } from './toolHandlers/fileHandlers';
import { assertNotManagedProjectDocument, isManagedProjectDocumentPath } from './managedProjectDocument';
import { initRepo } from './gitIpc';
import { getLogger } from '../logger';
import { chapterIdOfChapterFilePath, degradeMentionLedgerForChapterFile } from '../db/mentionLedgerDegrade';

/**
 * Per-file word-count cache keyed by absolute path, invalidated by mtime.
 * Lets project:word-count skip re-reading unchanged files across the frequent
 * autosave/watcher-driven refreshes. Pruned to live files on each run.
 */
const wordCountCache = new Map<string, { mtimeMs: number; count: number }>();

/**
 * Build a non-colliding path within `dir` for an arbitrary file/folder name,
 * inserting `-1`, `-2`, ... before the extension if the target already exists.
 */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i++;
  }
  return candidate;
}

/** Names that should never be imported into a project via drag-drop. */
function shouldSkipImport(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Max single-file import size (50 MiB) — blocks bulk secret exfil via import-then-read. */
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
/** Max files per import batch. */
const MAX_IMPORT_BATCH = 100;

/**
 * Reject source paths that are clearly not user drag-drop targets: empty,
 * relative, UNC without drive, or known sensitive locations (ssh keys, orison
 * key store, system dirs). Destination is still project-scoped; this only
 * reduces the "arbitrary local file read via import" blast radius if the
 * renderer is compromised.
 */
function isImportableSourcePath(src: string): boolean {
  if (!src || typeof src !== 'string') return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  // Must be absolute (Windows drive or POSIX root). Reject relative / traversal.
  if (!path.isAbsolute(trimmed)) return false;
  // Reject Windows device paths / alternate data stream tricks.
  if (trimmed.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(trimmed) === false && process.platform === 'win32' && !trimmed.startsWith('\\\\')) {
    // On Windows, absolute paths are drive-letter or UNC.
  }
  const resolved = path.resolve(trimmed);
  if (isSensitiveImportSource(resolved)) return false;
  return true;
}

function isSensitiveImportSource(resolved: string): boolean {
  const lower = resolved.replace(/\\/g, '/').toLowerCase();
  const home = path.resolve(os.homedir()).replace(/\\/g, '/').toLowerCase();
  const denyExact = [
    `${home}/.ssh`,
    `${home}/.gnupg`,
    `${home}/.aws`,
    `${home}/.orison/model/keys`,
    `${home}/.orison/model`,
  ];
  for (const d of denyExact) {
    if (lower === d || lower.startsWith(d + '/')) return true;
  }
  // System dirs (best-effort)
  if (process.platform === 'win32') {
    if (lower.startsWith('c:/windows') || lower.startsWith('c:/program files')) return true;
  } else {
    if (lower.startsWith('/etc') || lower.startsWith('/usr') || lower.startsWith('/bin') || lower.startsWith('/sbin') || lower.startsWith('/root')) {
      return true;
    }
  }
  return false;
}

export function registerProjectFileIpc(): void {
  /* ── Project-scoped file operations (all paths validated) ── */

  ipcMain.handle('project:create-directory', async (_, parentDir: string, name: string) => {
    // 范围外父目录显式报错（带允许根路径），不静默回退默认根——覆盖用户手选
    // 属最恶劣行为（dogfood 2026-08-20 拍板）。错误走对话框 catch → 失败 toast。
    const parent = resolveCreateParent(parentDir);
    if (!parent.ok) throw new Error(parent.reason);
    const safeParentDir = parent.dir;
    assertSafePath(safeParentDir);
    // Reject names with path separators to prevent traversal via name
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('Invalid project name');
    }
    const projectDir = path.join(safeParentDir, name);
    assertSafePath(projectDir);
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }
    // dogfood R2 批次0（地基补项4）：项目目录落地即挂幂等 initRepo（gitIpc 同层直调；已是
    // repo 则 no-op——存量/导入目录复跑安全）——新项目从创建起就有版本管理时间线原点，
    // Timeline opt-in 入口保留给更早的存量项目。失败只 warn 不抛：版本管理开启失败不应
    // 让新建项目失败（恢复体系三层分工：patch 审查=事前 / undo 栈=会话内 / git=跨会话整树）。
    // CR-28（dogfood R2）：空目录上 initRepo 只建 repo、不落空节点——首节点「项目创建」等
    // 初始内容就绪，由 projectMetaIpc 的 save-meta/ensure-document 首写路径挂
    // commitProjectCreateNode（project.yaml + 先行落盘的封面一起进首节点）。
    try {
      await initRepo(projectDir);
    } catch (err) {
      getLogger().warn({ projectDir, err }, 'project:create-directory git init failed — continuing without version management');
    }
    return allowPath(projectDir);
  });

  ipcMain.handle('project:copy-cover-image', async (_, src: string, projectDir: string) => {
    assertSafePath(src);
    assertSafePath(projectDir);
    const ext = path.extname(src);
    const dest = path.join(projectDir, `cover${ext}`);
    assertWithinProject(projectDir, dest);
    // A project has exactly ONE cover. Because the file is named `cover.<ext>`,
    // uploading a different format (png -> jpg) would otherwise leave the old
    // `cover.png` orphaned alongside the new `cover.jpg`, and a stale meta
    // pointer to the old name renders blank. Remove any existing cover.* first
    // so there's never more than one cover file on disk.
    for (const name of readdirSync(projectDir)) {
      if (/^cover\.[^.]+$/i.test(name) && name !== `cover${ext}`) {
        try { unlinkSync(path.join(projectDir, name)); } catch { /* best effort */ }
      }
    }
    copyFileSync(src, dest);
    return dest;
  });

  /* ── Import external files dropped from the OS into the project ──
   * Destination stays project-scoped. Source paths must be absolute, must not
   * escape into sensitive system locations, and are size-capped so a compromised
   * renderer cannot bulk-exfiltrate arbitrary files via import-then-read. */
  ipcMain.handle(
    'project:import-files',
    async (
      _,
      projectDir: string,
      targetRelDir: string,
      sourcePaths: string[],
      allowedExtensions?: string[],
    ) => {
      assertSafePath(projectDir);
      const destDir = targetRelDir && targetRelDir !== '/'
        ? buildProjectPath(projectDir, targetRelDir)
        : projectDir;
      assertWithinProject(projectDir, destDir);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

      // 附件任务 A1（design §1.1 / R1.5）：可选扩展名白名单——白名单在 shell 侧强制，
      // 不信 renderer 过滤。additive：不传（含空数组/非数组）= 完全不启用，既有文件树
      // 拖入路径行为零变化；传入非空数组时按 basename 扩展名（小写 + 补前导点归一，
      // '.MD'/'md' 均归一为 '.md'）校验。
      const extWhitelist =
        Array.isArray(allowedExtensions) && allowedExtensions.length > 0
          ? new Set(
              allowedExtensions.map((ext) => {
                const normalized = String(ext).trim().toLowerCase();
                return normalized.startsWith('.') ? normalized : `.${normalized}`;
              }),
            )
          : null;

      if (!Array.isArray(sourcePaths)) {
        return extWhitelist ? { imported: [], rejected: [] } : [];
      }
      const imported: string[] = [];
      const rejected: string[] = [];
      // Cap batch size to limit abuse if renderer is compromised.
      const batch = sourcePaths.slice(0, MAX_IMPORT_BATCH);
      // CR-018（09-01 CR patch）：附件路径（allowedExtensions 启用）下批量溢出不再
      // 静默丢弃——列入 rejected 带原因（AC2 明确提示）；不传参的文件树老路径静默
      // 切片语义零变化。
      if (extWhitelist) {
        for (const src of sourcePaths.slice(MAX_IMPORT_BATCH)) {
          const name = path.basename(String(src));
          if (name) rejected.push(`${name} (超过单批 ${MAX_IMPORT_BATCH} 个上限)`);
        }
      }

      for (const src of batch) {
        if (!isImportableSourcePath(src)) continue;
        if (!existsSync(src)) continue;
        const baseName = path.basename(src);
        if (shouldSkipImport(baseName)) continue;
        if (extWhitelist && !extWhitelist.has(path.extname(baseName).toLowerCase())) {
          // 部分成功语义（与现 multi 行为一致）：非白名单条目拒收——不拷入、不触发
          // file:changed，文件名列入 rejected 回报 renderer 供明确提示（AC2：inbox/
          // 无残留）；其余合法文件照常处理。
          rejected.push(baseName);
          continue;
        }
        const dest = uniquePath(destDir, baseName);
        assertWithinProject(projectDir, dest);
        if (isManagedProjectDocumentPath(dest)) continue;
        try {
          const stats = statSync(src);
          if (stats.isDirectory()) {
            // Directories: still copy, but reject sensitive roots and cap total size.
            if (isSensitiveImportSource(src)) continue;
            cpSync(src, dest, { recursive: true });
          } else {
            if (stats.size > MAX_IMPORT_FILE_BYTES) {
              // CR-018（09-01 CR patch）：附件路径（allowedExtensions 启用）下大小
              // 拒收明确提示——列入 rejected 带原因（AC2）；不传参的文件树老路径
              // 静默跳过语义零变化。
              if (extWhitelist) rejected.push(`${baseName} (超过 50MB 上限)`);
              continue;
            }
            if (isSensitiveImportSource(src)) continue;
            copyFileSync(src, dest);
          }
          const rel = '/' + path.relative(projectDir, dest).split(path.sep).join('/');
          imported.push(rel);
          notifyUI({ type: 'file:changed', projectPath: projectDir, path: rel });
        } catch {
          // Skip individual files that fail to copy; continue with the rest.
        }
      }
      // 返回形态按白名单启用与否分流（additive）：不启用 = string[]（既有契约逐字节
      // 一致，现有 preload/文件树消费方零漂移）；启用 = { imported, rejected }——
      // rejected 含扩展名拒收（裸文件名）与大小/批量拒收（`文件名 (原因)` 带原因，
      // CR-018）；敏感路径等其余闸的静默跳过语义不变，不混入 rejected。
      return extWhitelist ? { imported, rejected } : imported;
    },
  );

  ipcMain.handle('project:delete-entry', async (_, fullPath: string) => {
    assertSafePath(fullPath);
    if (isManagedProjectDocumentPath(fullPath)) return false;
    try {
      const stat = statSync(fullPath);
      // Deletion is irreversible — keep a local-history snapshot of the text
      // content being removed so a mis-click is recoverable by hand.
      const projectRoot = findProjectRootFor(fullPath);
      if (stat.isDirectory()) {
        if (projectRoot) snapshotTreeToLocalHistory(projectRoot, fullPath);
        rmSync(fullPath, { recursive: true, force: true });
      } else {
        if (projectRoot) snapshotToLocalHistory(projectRoot, fullPath);
        unlinkSync(fullPath);
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('project:rename-entry', async (_, oldPath: string, newPath: string) => {
    assertSafePath(oldPath);
    assertSafePath(newPath);
    if (isManagedProjectDocumentPath(oldPath) || isManagedProjectDocumentPath(newPath)) return false;
    // Reject renaming onto an existing sibling. On POSIX renameSync would
    // silently replace the target (data loss); on Windows it throws. Guard
    // explicitly so the behaviour is consistent and the UI can warn the user.
    // Allow a pure case/spacing change where the resolved target IS the source.
    if (path.resolve(newPath) !== path.resolve(oldPath) && existsSync(newPath)) {
      return false;
    }
    try {
      renameSync(oldPath, newPath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('project:create-entry', async (_, fullPath: string, isDir: boolean) => {
    assertSafePath(fullPath);
    if (isManagedProjectDocumentPath(fullPath)) return false;
    // Reject names containing path separators / traversal (matches
    // create-directory). The name is the last path segment of fullPath.
    const baseName = path.basename(fullPath);
    if (!baseName || baseName === '.' || baseName === '..' || baseName.includes('..')) {
      return false;
    }
    // Never overwrite an existing file/dir: a blind atomicWrite('') here would
    // truncate a real manuscript to empty. Refuse and let the UI report it.
    if (existsSync(fullPath)) return false;
    try {
      if (isDir) {
        mkdirSync(fullPath, { recursive: true });
      } else {
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(fullPath, '', 'utf-8');
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('project:read-file', async (_, fullPath: string) => {
    assertSafePath(fullPath);
    try {
      if (!existsSync(fullPath)) return null;
      // Read raw bytes and detect encoding (UTF-8 / UTF-8-BOM / UTF-16 / GBK).
      // Chinese .txt files are often saved as GBK on Windows; a blind utf-8
      // read would produce mojibake. Newlines are normalized to LF here.
      const buffer = readFileSync(fullPath);
      return decodeFileToUtf8(buffer);
    } catch {
      return null;
    }
  });

  ipcMain.handle('project:read-file-binary', async (_, fullPath: string) => {
    assertSafePath(fullPath);
    try {
      if (!existsSync(fullPath)) return null;
      const ext = path.extname(fullPath).toLowerCase();
      if (!isBinaryReadable(ext)) return null;
      const mimeType = mimeTypeFromExt(ext);
      if (!mimeType) return null;
      const buffer = readFileSync(fullPath);
      return { base64: buffer.toString('base64'), mimeType };
    } catch {
      return null;
    }
  });

  ipcMain.handle('project:search', async (_, projectDir: string, query: string, maxResults?: number) => {
    // Renderer-facing search. The agent tool path (handleToolExecute -> searchHandler)
    // is dev-only HTTP/WS; the UI must use this IPC channel so search works in
    // the packaged app. Shares the structured-search core with the tool handler.
    assertSafePath(projectDir);
    return searchProjectFiles(projectDir, query, maxResults);
  });

  ipcMain.handle('project:write-file', async (_, fullPath: string, content: string) => {
    assertSafePath(fullPath);
    try {
      assertNotManagedProjectDocument(fullPath);
      const dir = path.dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Local-history snapshot of the previous content before it's replaced
      // (covers the editor autosave and the agent-diff accept path alike).
      const projectRoot = findProjectRootFor(fullPath);
      if (projectRoot) snapshotToLocalHistory(projectRoot, fullPath, content);
      // Tell the watcher this is our own write so it doesn't broadcast a
      // file:changed (which would trigger a redundant tree refresh + word-count
      // rescan). Register just before writing so the event is covered.
      registerSelfWrite(fullPath);
      // Always write UTF-8 (no BOM). Combined with read-side LF normalization
      // this gives a stable LF + UTF-8 round-trip. We intentionally do not
      // restore the original encoding/newlines (e.g. GBK or CRLF): normalizing
      // to LF + UTF-8 is the accepted canonical form for the editor.
      atomicWriteFileSync(fullPath, content, 'utf-8');
      // Story 8.7 BMad CR-001：编辑器侧写章正文（rewrite_passage accept 的 persistChapterContent →
      // saveFile、整章 diff accept、手编保存、reject 还原全走本 IPC）→ mention 账 best-effort 降档。
      // 非章路径零成本直过；degrade 内部自捕获（写盘已成功，降档失败只 warn 不影响返回值）。手编/还原
      // 也降档是保守方向的诚实行为（prose 变了旧申报即失效；下次写手触达/重收即恢复 full）。
      if (projectRoot) {
        const chapterId = chapterIdOfChapterFilePath(fullPath, projectRoot);
        if (chapterId !== undefined) {
          await degradeMentionLedgerForChapterFile(projectRoot, chapterId);
        }
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('project:path-exists', async (_, fullPath: string) => {
    assertSafePath(fullPath);
    return existsSync(fullPath);
  });

  ipcMain.handle('project:save-base64-image', async (_, projectDir: string, input: SaveBase64ImageInput & { notify?: boolean }) => {
    assertSafePath(projectDir);
    if (!ALLOWED_IMAGE_DIRS.has(input.directory)) {
      throw new Error('Invalid image directory');
    }

    const fileName = createImageFileName(input);
    const relativePath = `${input.directory}/${fileName}`;
    const fullPath = buildProjectPath(projectDir, relativePath);
    const dir = path.dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    atomicWriteFileSync(fullPath, Buffer.from(input.b64Json, 'base64'));
    // 09-01 附件 B 波（R2.3/复查 M4）：additive `notify` ——chat 进件路径传 true 时落盘后
    // 显式广播 file:changed（文件树/字数刷新确定性到达，不赌平台 watcher 差异）。默认
    // 不开：现有消费者（AssetsPanel 拖入、ImageGenEditor 生成图）自带重载/无需事件，无差别
    // 加事件会白触发资产页全量重载。刻意不用 image:created ——同白触发问题（design §2.1）。
    if (input.notify === true) {
      notifyUI({ type: 'file:changed', projectPath: projectDir, path: `/${relativePath}` });
    }
    return { relativePath, fullPath, fileName };
  });

  ipcMain.handle('project:move-file', async (_, projectDir: string, fromRelativePath: string, toRelativePath: string) => {
    assertSafePath(projectDir);
    const source = buildProjectPath(projectDir, fromRelativePath);
    const destination = buildProjectPath(projectDir, toRelativePath);
    assertNotManagedProjectDocument(source);
    assertNotManagedProjectDocument(destination);
    const dir = path.dirname(destination);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    renameSync(source, destination);
    return destination;
  });

  ipcMain.handle('project:delete-file', async (_, projectDir: string, relativePath: string) => {
    assertSafePath(projectDir);
    const fullPath = buildProjectPath(projectDir, relativePath);
    if (isManagedProjectDocumentPath(fullPath)) return false;
    try {
      if (!existsSync(fullPath)) return true;
      snapshotToLocalHistory(projectDir, fullPath);
      unlinkSync(fullPath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('project:word-count', async (_, projectDir: string) => {
    assertSafePath(projectDir);
    try {
      const entries = readDirectoryRecursive(projectDir, projectDir, 10);
      const files: string[] = [];
      const collect = (list: typeof entries) => {
        for (const e of list) {
          if (e.isDir && e.children) {
            // 附件任务 A1（design D-H / 复查 M5）：字数概览语义 = 项目产出（章节/设定
            // 文档），inbox/ 是对话框上传的外部参考材料——10 万字大纲进 inbox 不应把
            // 项目总字数顶 +10 万（file:changed 驱动的自动刷新还会放大）。根级 inbox
            // 目录整棵剪枝；前导斜杠锚定，其他位置同名目录（如 资料/inbox）与根级
            // 同名文件（inbox.md）不受影响。
            if (e.path === '/inbox' || e.path.startsWith('/inbox/')) continue;
            collect(e.children); continue;
          }
          if (!/\.(md|txt)$/i.test(e.name)) continue;
          files.push(path.join(projectDir, e.path.replace(/^\//, '')));
        }
      };
      collect(entries);

      // Per-file, mtime-keyed cache: only re-read + recount files that actually
      // changed since the last word-count. Reads run via fs.promises so the
      // main process isn't blocked by a synchronous full-project sweep on every
      // autosave/watcher tick (the old behaviour stalled the whole app).
      let total = 0;
      await Promise.all(files.map(async (fullPath) => {
        try {
          const { mtimeMs } = await statAsync(fullPath);
          const cached = wordCountCache.get(fullPath);
          if (cached && cached.mtimeMs === mtimeMs) {
            total += cached.count;
            return;
          }
          // Decode with encoding detection (UTF-8 / BOM / UTF-16 / GBK) so the
          // count matches what the editor shows. Chinese .txt files are often
          // GBK on Windows; a blind utf-8 read produces mojibake -> wrong count.
          const text = decodeFileToUtf8(await readFileAsync(fullPath)).trim();
          const count = text ? text.replace(/\s/g, '').length : 0;
          wordCountCache.set(fullPath, { mtimeMs, count });
          total += count;
        } catch { /* skip unreadable */ }
      }));

      // Drop cache entries for files no longer present so the map can't grow
      // unbounded across renames/deletes within a long-lived session.
      if (wordCountCache.size > files.length) {
        const live = new Set(files);
        for (const key of wordCountCache.keys()) {
          if (!live.has(key)) wordCountCache.delete(key);
        }
      }
      return total;
    } catch {
      return 0;
    }
  });
}

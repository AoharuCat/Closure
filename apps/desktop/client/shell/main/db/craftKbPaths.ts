import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { deriveCraftId, parseCraftMd } from './craftMd';
import { getLogger } from '../logger';

/**
 * Craft KB file-system locations (Story 2.1).
 *
 * Mirrors the OrisonSpace global-directory convention (`~/.orison/{data,logs,
 * model,user}/`): the writable craft KB lives at `~/.orison/craft-kb/` (child5
 * design §1.3 "与全局 skill 目录同层"). A bundled read-only seed directory
 * (`process.resourcesPath/craft-kb/`) holds curated seeds in a packaged app;
 * user docs in `~/.orison/craft-kb/` OVERRIDE bundled docs of the same craft_id
 * (user can edit / replace / drop any seed). 2.1 ships the mechanism but NO seed
 * content (curation deferred to a later user-owned story); tests use fixture md
 * docs under a temp user dir.
 *
 * Home 单源 = `os.homedir()`（与 `db/index.ts` `getDbPath` 及 agent / local-bff 侧一致）；
 * tests mock `node:os` 的 `homedir` 到 throwaway home，真 `~/.orison` 永不被触碰。
 */

let userDirOverride: string | null = null;

/** Test override for the writable craft KB dir (mirror of configIpc's modelDirOverride). */
export function _setCraftKbUserDirForTest(dir: string | null): void {
  userDirOverride = dir;
}

/** Writable user craft KB dir: `~/.orison/craft-kb/`. */
export function getCraftKbUserDir(): string {
  return userDirOverride ?? path.join(homedir(), '.orison', 'craft-kb');
}

/**
 * Bundled read-only seed dir. `process.resourcesPath` is set in a packaged
 * Electron app; in dev it points at Electron's own resources (no app bundling),
 * so the dir is absent and this returns null. Returns null unless the dir truly
 * exists on disk (never return a phantom path).
 */
export function getCraftKbBundledDir(): string | null {
  if (!process.resourcesPath) return null;
  const candidate = path.join(process.resourcesPath, 'craft-kb');
  return existsSync(candidate) ? candidate : null;
}

/** True iff `filePath` falls under the bundled read-only seed dir. */
export function isBundledCraftPath(filePath: string): boolean {
  const bundled = getCraftKbBundledDir();
  if (!bundled) return false;
  const resolved = path.resolve(filePath);
  const resolvedBundled = path.resolve(bundled);
  return resolved === resolvedBundled || resolved.startsWith(resolvedBundled + path.sep);
}

export type CraftMdFile = {
  filePath: string;
  craftId: string;
  sourceKind: 'bundled' | 'user';
};

/**
 * Enumerate craft md docs across both dirs. User docs OVERRIDE bundled docs of
 * the same craft_id (user priority merge - mirror skill resource loading). A
 * `.md` file with no frontmatter `id` derives its craft_id from the filename.
 * Files that cannot be read/parsed are logged + skipped (never throw - one bad
 * doc must not brick the scan).
 *
 * CR-craft-kb-002: a craft_id collision that is NOT the documented "user
 * overrides bundled" case is logged at warn so a silently-dropped doc is
 * visible (esp. user↔user - two user docs with the same craft_id, or a
 * bundled↔bundled packaging bug). The intentional user-over-bundled override
 * stays silent (it is the designed priority merge).
 *
 * CR-craft-kb-003: the scan is RECURSIVE - craft md organized in subfolders
 * (`~/.orison/craft-kb/shuangdian/foo.md`) are indexed too, not only top-level
 * docs. Future-proofs the empty 2.1 KB for the curated-story layout.
 *
 * CR-craft-kb-007: a doc whose derived craft_id is empty/whitespace (a file
 * named `.md`, or a whitespace-only frontmatter `id`) is skipped + warned - an
 * empty craft_id is a legal TEXT PK and would collide with every other empty-id
 * doc, so it must never reach the index.
 */
export function listCraftMdFiles(): CraftMdFile[] {
  const byCraftId = new Map<string, CraftMdFile>();

  // Bundled first (lower priority - user overrides below).
  const bundledDir = getCraftKbBundledDir();
  if (bundledDir) {
    for (const f of listMdFilesIn(bundledDir)) {
      const parsed = safeReadAndParse(f);
      if (!parsed) continue;
      const prev = byCraftId.get(parsed.craftId);
      if (prev) {
        // bundled↔bundled collision = a packaging bug (two seeds share an id).
        getLogger().warn(
          { craftId: parsed.craftId, kept: prev.filePath, dropped: f },
          'craft KB: duplicate craft_id in bundled seeds - dropping later file',
        );
      }
      byCraftId.set(parsed.craftId, { filePath: f, craftId: parsed.craftId, sourceKind: 'bundled' });
    }
  }

  // User dir (higher priority - overrides bundled on craft_id collision).
  const userDir = getCraftKbUserDir();
  for (const f of listMdFilesIn(userDir)) {
    const parsed = safeReadAndParse(f);
    if (!parsed) continue;
    const prev = byCraftId.get(parsed.craftId);
    if (prev) {
      if (prev.sourceKind === 'user') {
        // user↔user collision = two user docs share a craft_id (silent data-drop
        // without this warn). Log so the user can rename one.
        getLogger().warn(
          { craftId: parsed.craftId, kept: prev.filePath, dropped: f },
          'craft KB: duplicate craft_id among user docs - dropping later file',
        );
      }
      // prev.sourceKind === 'bundled' is the documented user-overrides-bundled
      // merge -> silent override (no warn).
    }
    byCraftId.set(parsed.craftId, { filePath: f, craftId: parsed.craftId, sourceKind: 'user' });
  }

  return [...byCraftId.values()];
}

/**
 * Recursively enumerate `.md` files under `dir` (CR-craft-kb-003). Subdirectories
 * are descended into so craft docs organized in folders are indexed. Returns []
 * when the dir is absent / unreadable (never throw - one bad dir must not brick
 * the scan).
 */
function listMdFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      'craft KB: cannot read directory - skipping',
    );
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      // stat failed (broken symlink / race) - skip this entry.
      continue;
    }
    if (isDir) {
      // Recurse into subdirectories (depth unbounded - craft KB is small +
      // user-curated; a runaway loop would require a symlink cycle, and fs
      // readdirSync does not follow symlinks for the recursion target itself).
      out.push(...listMdFilesIn(full));
    } else if (isFile && entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function safeReadAndParse(filePath: string): { craftId: string } | null {
  try {
    // Defer the fs read to the indexer (avoid a double read in production); here
    // we only need the craft_id for dedup. Read once - the indexer re-reads, but
    // craft docs are small + few and the scan runs rarely (startup / rebuild).
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseCraftMd(content);
    const craftId = deriveCraftId(path.basename(filePath), frontmatter);
    // CR-craft-kb-007: empty / whitespace craft_id is a legal TEXT PK and would
    // collide with every other empty-id doc - skip + warn.
    if (!craftId) {
      getLogger().warn(
        { filePath },
        'craft KB: doc derives to an empty craft_id (filename + frontmatter id both empty) - skipping',
      );
      return null;
    }
    return { craftId };
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), filePath },
      'craft KB: cannot parse file - skipping',
    );
    return null;
  }
}

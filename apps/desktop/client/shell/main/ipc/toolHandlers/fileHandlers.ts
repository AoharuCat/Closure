/**
 * File tool handlers — read_file, write_file, list_files, search
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertWithinProject } from '../pathGuard';
import { notifyUI } from '../toolNotify';
import { snapshotToLocalHistory } from '../../fs/localHistory';
import type { ToolHandler } from './types';
import type { ProjectSearchResult } from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { decodeFileToUtf8 } from '@orison/shared-contracts/fs/decodeText';
import { assertNotManagedProjectDocument } from '../managedProjectDocument';
import { chapterIdOfChapterFilePath, degradeMentionLedgerForChapterFile } from '../../db/mentionLedgerDegrade';

export const readFileHandler: ToolHandler = async ({ params, projectDir }) => {
  const { filePath, offset = 0, limit } = params as { filePath: string; offset?: number; limit?: number };
  const fullPath = path.resolve(projectDir, filePath);
  assertWithinProject(projectDir, fullPath);
  if (!existsSync(fullPath)) throw new Error(`未找到文件：${filePath}`);

  // 读侧归一单源（多 OS task R3 / FS#3）：buffer → decodeFileToUtf8（BOM/UTF-16 sniff/GBK 检测 +
  // CRLF/单 CR 归一 LF）。Windows GBK .txt 不再以乱码进 prompt，CRLF 不再把 \r 带给模型
  //（模型按原文写回易产混合行尾）。与编辑器读面（decodeText）同一检测序。
  const content = decodeFileToUtf8(readFileSync(fullPath));
  const lines = content.split('\n');
  const sliced = limit ? lines.slice(offset, offset + limit) : lines.slice(offset);
  const numbered = sliced.map((l, i) => `${offset + i + 1}\t${l}`).join('\n');

  return {
    title: filePath,
    output: numbered,
    metadata: { totalLines: lines.length, returned: sliced.length },
  };
};

export const writeFileHandler: ToolHandler = async ({ params, projectDir }) => {
  const { filePath, content } = params as { filePath: string; content: string };
  const fullPath = path.resolve(projectDir, filePath);
  assertWithinProject(projectDir, fullPath);
  assertNotManagedProjectDocument(fullPath);

  const dir = path.dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Snapshot pre-write content for suggest-mode reject/restore (the write lands
  // now; review happens after). null marks a new file → reject deletes it.
  const existedBefore = existsSync(fullPath);
  const previousContent = existedBefore ? readFileSync(fullPath, 'utf-8') : null;

  // Agent writes are exactly the overwrites local history exists for.
  snapshotToLocalHistory(projectDir, fullPath, content);
  atomicWriteFileSync(fullPath, content, 'utf-8');

  notifyUI({ type: 'file:changed', projectPath: projectDir, path: filePath });
  // Story 8.7 BMad CR-001：agent 经 write_file 直写章正文（chapters/*.md）→ mention 账 best-effort
  // 降档（同 chapter_write 工具接线；非章路径零成本直过，永不抛不阻写盘）。
  const chapterId = chapterIdOfChapterFilePath(fullPath, path.resolve(projectDir));
  if (chapterId !== undefined) {
    await degradeMentionLedgerForChapterFile(projectDir, chapterId);
  }
  return {
    title: filePath,
    output: `已写入 ${filePath}（${content.length} 字符）`,
    metadata: { previousContent, existedBefore },
  };
};

export const listFilesHandler: ToolHandler = async ({ params, projectDir }) => {
  const { dirPath = '.', recursive = false } = params as { dirPath?: string; recursive?: boolean };
  const fullPath = path.resolve(projectDir, dirPath);
  assertWithinProject(projectDir, fullPath);
  if (!existsSync(fullPath)) throw new Error(`未找到目录：${dirPath}`);

  const results: string[] = [];
  function walk(dir: string, prefix: string) {
    const entries = readdirSync(dir);
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const fp = path.join(dir, name);
      const stat = statSync(fp);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) {
        results.push(`${rel}/`);
        if (recursive) walk(fp, rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(fullPath, dirPath === '.' ? '' : dirPath);

  return {
    title: `list: ${dirPath}`,
    output: results.join('\n'),
    metadata: { count: results.length },
  };
};

export const searchHandler: ToolHandler = async ({ params, projectDir }) => {
  const { query, glob: globPattern, maxResults = 50 } = params as { query: string; glob?: string; maxResults?: number };

  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('search: query must be a non-empty string');
  }
  if (query.length > 1000) {
    throw new Error('search: query too long (max 1000 chars)');
  }

  const hits = searchProjectFiles(projectDir, query, maxResults, globPattern);
  const lines = hits.map((h) => `${h.path}:${h.line}: ${h.text}`);

  return {
    title: `search: ${query}`,
    output: lines.length > 0 ? lines.join('\n') : '未找到匹配的内容。',
    metadata: { count: lines.length },
  };
};

/**
 * Structured regex search across a project directory. Shared by the agent
 * `search` tool handler and the renderer-facing `project:search` IPC channel.
 * Returns `{ path, line, text }[]` with paths relative to `projectDir`.
 */
export function searchProjectFiles(
  projectDir: string,
  query: string,
  maxResults = 50,
  globPattern?: string,
): ProjectSearchResult[] {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('search: query must be a non-empty string');
  }
  if (query.length > 1000) {
    throw new Error('search: query too long (max 1000 chars)');
  }

  const results: ProjectSearchResult[] = [];
  // No `g` flag: with regex.test() a sticky lastIndex would skip/alternate
  // matches across lines. Guard invalid patterns so a bad query is a clean
  // error rather than a thrown ReDoS-prone construction.
  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch (err) {
    throw new Error(`search: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }

  function searchDir(dir: string) {
    if (results.length >= maxResults) return;
    const entries = readdirSync(dir);
    for (const name of entries) {
      if (results.length >= maxResults) return;
      if (name.startsWith('.') || name === 'node_modules') continue;
      const fp = path.join(dir, name);
      const stat = statSync(fp);
      if (stat.isDirectory()) {
        searchDir(fp);
      } else {
        if (globPattern && !name.endsWith(globPattern.replace('*', ''))) continue;
        try {
          const content = readFileSync(fp, 'utf-8');
          const fileLines = content.split('\n');
          for (let i = 0; i < fileLines.length; i++) {
            if (regex.test(fileLines[i])) {
              results.push({
                path: path.relative(projectDir, fp),
                line: i + 1,
                text: fileLines[i].trim(),
              });
              if (results.length >= maxResults) return;
            }
          }
        } catch { /* skip binary files */ }
      }
    }
  }
  searchDir(projectDir);

  return results;
}

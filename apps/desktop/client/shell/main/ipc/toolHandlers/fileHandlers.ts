/**
 * File tool handlers — read_file, write_file, list_files, search
 */
import { existsSync, readFileSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertWithinProject, isSafePath } from '../pathGuard';
import { notifyUI } from '../toolNotify';
import { snapshotToLocalHistory } from '../../fs/localHistory';
import type { ToolHandler } from './types';
import type { ProjectSearchResult } from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { decodeFileToUtf8 } from '@orison/shared-contracts/fs/decodeText';
import { assertNotManagedProjectDocument } from '../managedProjectDocument';
import { chapterIdOfChapterFilePath, degradeMentionLedgerForChapterFile } from '../../db/mentionLedgerDegrade';

/**
 * 批量遍历的目录界内判定单点：`isSafePath(projectDir, path.join(dir, name))`——与
 * read_file 的 `assertWithinProject` 同内核（pathGuard 的 realpath 前缀比对；`path.resolve`
 * 词法比对挡不住「项目内路径 realpath 之后落到项目外」的形态）。
 *
 * 实际服务范围（事实描述，勿按「三件共用此判定」读）：只被两处递归体的**目录**分支调用，
 * 且调用点在此之前已对该子项做过 `lstat` 且判过非链接（链接一律不列不钻，见两处递归体）
 * ——即到达本函数的恒是真实目录。三件只读工具在 symlink 形态上的强度一致，由「链接统一
 * 跳过（两处递归体）+ 目录判决收在此单点」共同达成，不是本函数单独提供的性质。
 *
 * 越界项由**调用方跳过**，此处只回答真假——列表/检索是批量操作，单项越界抛错会打断
 * 整体，与三件既有的 never-throws 取向一致；跳过逐项计数（metadata.skipped）防静默。
 */
function entryWithinProject(projectDir: string, dir: string, name: string): boolean {
  return isSafePath(projectDir, path.join(dir, name));
}

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
  const totalLines = lines.length;

  // 越界（offset >= totalLines）恒得空切片 → 旧形态返 `output: ""`，对模型与「空文件 /
  // 读越过界 / 工具故障」同形（真机 F10：模型自填 offset=8000，文件 7578 行 → 静默空串）。
  // 改返友好文案而非空串，且**不抛错**：runLoop 有「连续 3 轮工具全错即中断整轮」闸
  //（loop.ts MAX_CONSECUTIVE_TOOL_ERRORS），抛错会把「模型偶尔翻过头」从静默慢失败升级
  // 成整轮中断。形态对齐同库先例 catalog_entries 的越界分支（显式 total + 回退上界 +
  // 指引重查），措辞适配文件语境。边界干净无需特例：合法非空区间为 0..totalLines-1，
  // `offset === totalLines - 1` 仍是合法页（恰返一行）。
  if (offset >= totalLines) {
    return {
      title: filePath,
      output:
        `offset=${offset} 已超出范围——该文件共 ${totalLines} 行。` +
        `请回退 offset（≤ ${totalLines - 1}）重查；不传 offset 即从头整读。`,
      metadata: { totalLines, returned: 0, hasMore: false },
    };
  }

  const sliced = limit ? lines.slice(offset, offset + limit) : lines.slice(offset);
  const numbered = sliced.map((l, i) => `${offset + i + 1}\t${l}`).join('\n');

  // 续读信号（R3）：判据取「已返回到的绝对行号 < 总行数」——**不得**用
  // `sliced.length === limit`（末页切片恰等于 limit 时会假阳性判成非末页）。
  // 契约：`hasMore` 恒在；`nextOffset` 仅在 `hasMore === true` 时出现（缺键 = 无下一页，
  // 非 0——absent ≠ 0）；不传 limit（整读）时 hasMore 恒假。
  const hasMore = offset + sliced.length < totalLines;
  const nextOffset = offset + sliced.length;
  // 续读信号必须**到达模型**才有效（R3 立意 = 模型不必自己算有没有下一页）：`metadata` 只活
  // 在 UI/管道面——桥车道 MCP 回帧只带 `String(frame.output)`（mcpServer.mjs），纯文本车道
  // 历史工具消息只序列化 `content`（compose.ts）——两条车道的模型都读不到 metadata。故把同一
  // 信号以模型可读的尾注写进 `output`，形态对齐同库先例 catalog_entries 的翻页 footer。
  // 硬约束：**仅 `hasMore === true` 时出现**——`hasMore === false`（含不传 limit 的整读、含
  // 末页、含空文件）输出逐字节不变（GBK/CRLF/UTF-8 三例归一断言与「读 = 读到全部」的提示词
  // 路径都依赖该形态）；`metadata` 的 `hasMore`/`nextOffset` 两键保持不动（另有消费者）。
  const continuationFooter = hasMore
    ? `_共 ${totalLines} 行，本次显示第 ${offset + 1}-${nextOffset} 行——还有更多，翻下一页传 offset=${nextOffset}。_`
    : '';
  return {
    title: filePath,
    output: hasMore ? `${numbered}\n${continuationFooter}` : numbered,
    metadata: {
      totalLines,
      returned: sliced.length,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    },
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
  // 顶层**响亮**失败保留：walk 的 readdir 现对齐 search 侧（失败 = 跳过 + 计数），若顶层
  // 也走该路径，`list_files` 收到文件路径（ENOTDIR）就会退化成「空列表」——模型侧
  // metadata 不可见（桥回帧只带 output），无从分辨「空目录 / 读不动 / 根本不是目录」。
  if (!statSync(fullPath).isDirectory()) throw new Error(`不是目录：${dirPath}`);

  const results: string[] = [];
  let skipped = 0;
  // 界内判定（性能取舍）：只有「目录下钻」需要 realpath——目录项在下去之前判一次
  //（符号链接/junction 经 realpath 现形）；文件项先用 lstat（不跟随），非链接项在已判界
  // 目录之下必然界内 ⇒ 逐文件免付一次 realpath syscall。
  // 链接项（含 Windows junction：lstat 下 isSymbolicLink() 为真）**一律不列不钻**，
  // 见下分支注释——这条统一规则同时覆盖「界外不暴露」与「界内不重复不循环」。
  function walk(dir: string, prefix: string, isRoot = false) {
    // readdir 失败的**递归子目录**（权限/竞态）跳过整棵子树——与 searchDir 侧同款：
    // 同一「目录读不动」在递归体两处一致处置（批量遍历单项失败不打断整体），跳过计数防静默。
    // 顶层区别对待（刻意）：顶层是模型给的**路由**，且 metadata 到不了模型（桥回帧只带
    // output）——读不动若也静默，模型只会看到空列表而无从自纠；故顶层失败维持响亮语义
    //（与 `未找到目录` / `不是目录` 同族）。
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if (isRoot) {
        throw new Error(`目录读不动：${dirPath}（${err instanceof Error ? err.message : String(err)}）`);
      }
      skipped += 1;
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const fp = path.join(dir, name);
      let lstat: ReturnType<typeof lstatSync>;
      try {
        lstat = lstatSync(fp);
      } catch {
        skipped += 1; // dangling link / 读取竞态：不静默消项
        continue;
      }
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstat.isSymbolicLink()) {
        // 链接一律不列不钻（统一规则）：不列 = 与「路径即真实位置」的列表语义一致；
        // 不钻 = 同时消掉两个问题——(1) 与已走过的真实路径重复出结果，
        // (2) 自指/互指链接（A/L → A）把 walk 拖进无限递归（前缀无限增长）。
        skipped += 1;
        continue;
      }
      if (lstat.isDirectory()) {
        if (!entryWithinProject(projectDir, dir, name)) {
          skipped += 1;
          continue;
        }
        results.push(`${rel}/`);
        if (recursive) walk(fp, rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(fullPath, dirPath === '.' ? '' : dirPath, true);

  return {
    title: `list: ${dirPath}`,
    output: results.join('\n'),
    metadata: { count: results.length, skipped },
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

  const { results, skipped } = searchProjectFilesWithStats(projectDir, query, maxResults, globPattern);
  const lines = results.map((h) => `${h.path}:${h.line}: ${h.text}`);

  return {
    title: `search: ${query}`,
    output: lines.length > 0 ? lines.join('\n') : '未找到匹配的内容。',
    metadata: { count: lines.length, skipped },
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
  return searchProjectFilesWithStats(projectDir, query, maxResults, globPattern).results;
}

/** `searchProjectFiles` 的带统计形态：越界跳过项数经返回值透出（不改共享内核的对外返回类型）。 */
export function searchProjectFilesWithStats(
  projectDir: string,
  query: string,
  maxResults = 50,
  globPattern?: string,
): { results: ProjectSearchResult[]; skipped: number } {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('search: query must be a non-empty string');
  }
  if (query.length > 1000) {
    throw new Error('search: query too long (max 1000 chars)');
  }

  const results: ProjectSearchResult[] = [];
  let skipped = 0;
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
    // readdir 失败的目录（权限/竞态）跳过整棵子树，不让批量检索整体抛错。
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      skipped += 1;
      return;
    }
    for (const name of entries) {
      if (results.length >= maxResults) return;
      if (name.startsWith('.') || name === 'node_modules') continue;
      const fp = path.join(dir, name);
      // 与 list_files 同款：只有目录下钻需要 realpath（符号链接/junction 经 realpath
      // 现形）；文件项先 lstat（不跟随），非链接项在已判界目录之下必然界内 ⇒ 免付 realpath。
      // 链接项一律不搜不钻（统一规则，见下分支）。
      let lstat: ReturnType<typeof lstatSync>;
      try {
        lstat = lstatSync(fp);
      } catch {
        skipped += 1; // dangling link / 读取竞态：不静默消项
        continue;
      }
      if (lstat.isSymbolicLink()) {
        // 链接一律不搜不钻（与 list_files 同一条统一规则）：不搜 = 链接不是「项目内容」
        // 的独立位置（真实路径已覆盖）；不钻 = 消掉重复命中与自指/互指链接的无限递归。
        skipped += 1;
        continue;
      }
      if (lstat.isDirectory()) {
        if (!entryWithinProject(projectDir, dir, name)) {
          skipped += 1;
          continue;
        }
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

  return { results, skipped };
}

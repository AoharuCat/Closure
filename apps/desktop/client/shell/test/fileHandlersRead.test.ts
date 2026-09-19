import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 多 OS task R3（research FS#3）：agent read_file 读侧编码/行尾归一。
//
// 旧实现 readFileSync(fullPath, 'utf-8') 裸读：Windows GBK .txt 读出乱码进 prompt、
// CRLF 把 \r 带给模型（模型按原文写回易产混合行尾）。归一后走 shared-contracts
// fs/decodeText 单源（与编辑器读面同一检测序：BOM → UTF-16 sniff → 严格 UTF-8 → GBK）。
//
// mock 形态 mirror chapterDegradeWiring.test.ts：fileHandlers 模块图引用 mentionLedgerDegrade
//（→ db → electron），electron mock 是加载面依赖；read 分支不触 db，降档本体 fake 零 db 依赖。
// ─────────────────────────────────────────────────────────────────────────────

const { degradeMentionLedgerForChapterFile, notifyUI } = vi.hoisted(() => ({
  degradeMentionLedgerForChapterFile: vi.fn(async () => undefined),
  notifyUI: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/tmp', isPackaged: false },
}));
vi.mock('../main/db/mentionLedgerDegrade', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../main/db/mentionLedgerDegrade')>()),
  degradeMentionLedgerForChapterFile,
}));
vi.mock('../main/ipc/toolNotify', () => ({ notifyUI }));

import { readFileHandler } from '../main/ipc/toolHandlers/fileHandlers';

const TMP = path.join(process.cwd(), 'test-tmp-file-handlers-read');

function ctx() {
  return { params: {} as Record<string, unknown>, projectDir: TMP, sessionId: 's1', abort: new AbortController().signal };
}

describe('read_file 读侧编码/行尾归一（多 OS R3 / FS#3）', () => {
  beforeEach(() => {
    rmBestEffort(TMP);
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmBestEffort(TMP);
  });

  it('GBK 文件读出正确中文（裸 utf-8 读出乱码的回归锚）', async () => {
    // 「中文内容测试」的 GBK 字节序列（D6D0 CEC4 C4DA C8DD B2E2 CAD4）——非合法 UTF-8，
    // 旧实现 toString('utf-8') 产出乱码；归一后经 GBK 兜底解出原文。
    const gbkBytes = Buffer.from([
      0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0xb2, 0xe2, 0xca, 0xd4,
    ]);
    writeFileSync(path.join(TMP, 'gbk.txt'), gbkBytes);

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'gbk.txt' } });

    expect(res.output).toContain('中文内容测试');
    expect(res.metadata).toMatchObject({ totalLines: 1, returned: 1 });
  });

  it('CRLF 文件读出 LF（\r 不进模型上下文），行号/切片按归一后的行计', async () => {
    writeFileSync(path.join(TMP, 'crlf.txt'), '第一行\r\n第二行\r\n第三行', 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'crlf.txt' } });

    expect(res.output).not.toContain('\r');
    expect(res.output).toContain('第一行');
    expect(res.metadata).toMatchObject({ totalLines: 3, returned: 3 });

    const sliced = await readFileHandler({
      ...ctx(),
      params: { filePath: 'crlf.txt', offset: 1, limit: 1 },
    });
    expect(sliced.output).toBe('2\t第二行');
  });

  it('UTF-8 无 BOM 常态文件字节不变（零行为变化锚）', async () => {
    writeFileSync(path.join(TMP, 'plain.md'), '# 第一章\n\n正文。', 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'plain.md' } });

    expect(res.output).toBe('1\t# 第一章\n2\t\n3\t正文。');
  });
});

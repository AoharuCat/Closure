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
      params: { filePath: 'crlf.txt', offset: 1, limit: 2 },
    });
    // 取到末页（1+2 === 3）⇒ hasMore 假、无续读尾注——本断言保持「切片/行号按归一后的行计」
    // 的纯口径（尾注形态由下方 F10 describe 专测；若此页有下一页，output 会多一行尾注）。
    expect(sliced.output).toBe('2\t第二行\n3\t第三行');
  });

  it('UTF-8 无 BOM 常态文件字节不变（零行为变化锚）', async () => {
    writeFileSync(path.join(TMP, 'plain.md'), '# 第一章\n\n正文。', 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'plain.md' } });

    expect(res.output).toBe('1\t# 第一章\n2\t\n3\t正文。');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F10 修复批（R2 / R3）：翻页界面两条。
//
// R2 旧形态：`offset >= totalLines` 恒得空切片 → `output: ""`——空串对模型与
//「空文件 / 读越过界 / 工具故障」同形（真机：模型自填 offset=8000，文件 7578 行）。
// 现形态：返友好文案（显式总行数 + 回退上界 + 重查指引），**不抛错**（runLoop 连续全错
// 闸会把「偶尔翻过头」升级成整轮中断；形态对齐 catalog_entries 越界分支先例）。
//
// R3：`metadata` 追加 `hasMore` / `nextOffset`。判据 `offset + returned < totalLines`——
// 不得用 `sliced.length === limit`（末页切片恰等于 limit 时假阳性）。`nextOffset` 仅在
// `hasMore === true` 时出现（缺键 = 无下一页，absent ≠ 0）。
//
// R3 信号面补修（本次）：`metadata` 到不了模型——桥车道 MCP 回帧只带 `String(frame.output)`
//（mcpServer.mjs），纯文本车道历史工具消息只序列化 `content`（compose.ts）。故续读信号同时
// 以**模型可读尾注**写进 `output`，**仅在 `hasMore === true` 时出现**；`hasMore === false`
//（整读/末页/空文件）output 与改动前逐字节一致（下方各 `toBe` 即硬钉断言）。
//
// 夹具沿用本文件同一 TMP（仓库内相对路径，realpath 形态稳定）——勿换 mkdtemp：
// Windows `%TEMP%` 8.3 短名/长名翻转会让 isSafePath 两侧 realpath 形态不一致而误判越界。
// ─────────────────────────────────────────────────────────────────────────────

describe('read_file 翻页界面（F10 修复批 R2/R3）', () => {
  const SIX_LINES = 'l1\nl2\nl3\nl4\nl5\nl6';

  beforeEach(() => {
    rmBestEffort(TMP);
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmBestEffort(TMP);
  });

  it('offset === 总行数（越界边界）返非空文案 + 总行数 + 回退上界，不抛错', async () => {
    writeFileSync(path.join(TMP, 'six.txt'), SIX_LINES, 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'six.txt', offset: 6 } });

    expect(res.output).not.toBe('');
    expect(res.output).toContain('offset=6');
    expect(res.output).toContain('共 6 行');
    expect(res.output).toContain('≤ 5');
    expect(res.metadata).toMatchObject({ totalLines: 6, returned: 0, hasMore: false });
  });

  it('offset 远超总行数（F10 真机形态 offset=8000）同样返文案不抛错', async () => {
    writeFileSync(path.join(TMP, 'six.txt'), SIX_LINES, 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'six.txt', offset: 8000 } });

    expect(res.output).toContain('共 6 行');
    expect(res.output).toContain('≤ 5');
    expect(res.metadata).toMatchObject({ totalLines: 6, returned: 0, hasMore: false });
  });

  it('offset === totalLines - 1（边界正例）正常返回末行，不落越界文案', async () => {
    writeFileSync(path.join(TMP, 'six.txt'), SIX_LINES, 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'six.txt', offset: 5 } });

    expect(res.output).toBe('6\tl6');
    expect(res.metadata).toMatchObject({ totalLines: 6, returned: 1, hasMore: false });
  });

  it('空文件 offset=0 既定行为不变（不是越界文案）', async () => {
    writeFileSync(path.join(TMP, 'empty.txt'), '', 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'empty.txt' } });

    expect(res.output).toBe('1\t');
    expect(res.metadata).toMatchObject({ totalLines: 1, returned: 1, hasMore: false });
  });

  it('剩余行数恰等于 limit（非末页）→ hasMore 真且 nextOffset 指向下一页，output 携模型可见尾注', async () => {
    writeFileSync(path.join(TMP, 'six.txt'), SIX_LINES, 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'six.txt', offset: 0, limit: 3 } });

    // 正文逐字仍是编号行；尾注追加在其后且只在 hasMore=true 时出现——它是**模型可读**的
    // 续读信号（metadata 到不了模型：桥回帧只带 output 文本、纯文本车道只序列化 content）。
    expect(res.output).toBe('1\tl1\n2\tl2\n3\tl3\n_共 6 行，本次显示第 1-3 行——还有更多，翻下一页传 offset=3。_');
    expect(res.output).toContain('还有更多');
    expect(res.output).toContain('offset=3');
    expect(res.metadata).toMatchObject({ totalLines: 6, returned: 3, hasMore: true, nextOffset: 3 });
  });

  it('末页切片恰等于 limit 时不误判为非末页（判据非 sliced.length === limit），且无尾注', async () => {
    writeFileSync(path.join(TMP, 'five.txt'), 'l1\nl2\nl3\nl4\nl5', 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'five.txt', offset: 2, limit: 3 } });

    // output 硬钉逐字节（hasMore=false ⇒ 无尾注，与加信号前完全一致——兼容性红线）。
    expect(res.output).toBe('3\tl3\n4\tl4\n5\tl5');
    expect(res.output).not.toContain('还有更多');
    expect(res.metadata).toMatchObject({ totalLines: 5, returned: 3, hasMore: false });
    expect(res.metadata).not.toHaveProperty('nextOffset');
  });

  it('不传 limit（整读）→ hasMore 假、nextOffset 键不出现，output 无尾注', async () => {
    writeFileSync(path.join(TMP, 'six.txt'), SIX_LINES, 'utf8');

    const res = await readFileHandler({ ...ctx(), params: { filePath: 'six.txt' } });

    // 整读形态的 output 逐字节断言（「读 = 读到全部」的提示词路径依赖它零附加文本）。
    expect(res.output).toBe('1\tl1\n2\tl2\n3\tl3\n4\tl4\n5\tl5\n6\tl6');
    expect(res.output).not.toContain('还有更多');
    expect(res.metadata).toMatchObject({ totalLines: 6, returned: 6, hasMore: false });
    expect(res.metadata).not.toHaveProperty('nextOffset');
  });
});

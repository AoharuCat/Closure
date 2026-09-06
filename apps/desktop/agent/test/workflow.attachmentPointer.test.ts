import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// task 09-01-agent-chat-attachments A3b（R1.2b/R1.2c）：renderAttachmentsIntoContent
// 附件语义自证指针块。字段门控渲染四态（preview-only / 双字段+stale / 双字段+非 stale /
// 无字段走原 else）+ 既有附件（chapter / pattern / selection）零变化回归。
//
// B2（R2.3 / dogfood #45）：createUserMessage 提取 image 附件进 SessionMessage.images
// 指针字段（不内嵌 b64）+ renderAttachmentsIntoContent image 指针行 + 既有分支零变化。
// ─────────────────────────────────────────────────────────────────────────────

/** 与实现同构的本地时区格式化（期望值构造用——TZ 无关地验证 YYYY-MM-DD HH:mm 形态与补零）。 */
function localFmt(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 本地时区分量构造的固定时刻（Date 构造器按本地时区取 epoch → 期望值随机器时区自洽）。
const DESCRIBED_AT = new Date(2026, 7, 31, 14, 20).getTime(); // 2026-08-31 14:20（描述生成）
const MTIME_FRESH = new Date(2026, 7, 31, 9, 15).getTime(); // 早于描述 → 非 stale
const MTIME_STALE = new Date(2026, 8, 1, 9, 15).getTime(); // 2026-09-01 09:15，晚于描述 → stale

describe('A3b — renderAttachmentsIntoContent 附件语义自证指针块（R1.2b/R1.2c）', () => {
  it('preview-only：首行指针 + 预览行 + 引导行（仅后半句，无描述行无 staleness 前缀）', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const out = renderAttachmentsIntoContent('帮我看下这份大纲', [
      { type: 'file', id: 'inbox/未命名文档1.md', label: '未命名文档1.docx', preview: '# 大纲 第一章 ……' },
    ]);
    expect(out).toBe(
      [
        '[引用文件: 未命名文档1.docx] (path: inbox/未命名文档1.md)',
        '预览: # 大纲 第一章 ……',
        '(随消息上传的文件，请先阅读后再依据它回应，勿凭文件名猜测内容)',
      ].join('\n') + '\n---\n帮我看下这份大纲',
    );
  });

  it('双字段 + stale（fileMtime > describedAt）：描述行带生成时间 + 预览行 + 完整 staleness 引导行', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const out = renderAttachmentsIntoContent('正文', [
      {
        type: 'file',
        id: 'inbox/大纲.md',
        label: '大纲.docx',
        preview: '第一卷 潜龙在渊……',
        description: '都市悬疑小说前三卷的分卷大纲，含主线伏笔清单。',
        describedAt: DESCRIBED_AT,
        fileMtime: MTIME_STALE,
      },
    ]);
    expect(out).toBe(
      [
        '[引用文件: 大纲.docx] (path: inbox/大纲.md)',
        `描述(生成于 ${localFmt(DESCRIBED_AT)}): 都市悬疑小说前三卷的分卷大纲，含主线伏笔清单。`,
        '预览: 第一卷 潜龙在渊……',
        `(文件最后改动 ${localFmt(MTIME_STALE)}，晚于描述生成——请以 read_file 实读为准；随消息上传的文件，请先阅读后再依据它回应，勿凭文件名猜测内容)`,
      ].join('\n') + '\n---\n正文',
    );
  });

  it('双字段 + 非 stale（fileMtime < 与 === describedAt 均不算晚于）：引导行仅后半句', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const render = (fileMtime: number) =>
      renderAttachmentsIntoContent('正文', [
        {
          type: 'file',
          id: 'inbox/大纲.md',
          label: '大纲.docx',
          preview: '第一卷 潜龙在渊……',
          description: '都市悬疑小说前三卷的分卷大纲。',
          describedAt: DESCRIBED_AT,
          fileMtime,
        },
      ]);
    for (const mtime of [MTIME_FRESH, DESCRIBED_AT]) {
      const out = render(mtime);
      expect(out).toContain(`描述(生成于 ${localFmt(DESCRIBED_AT)}): 都市悬疑小说前三卷的分卷大纲。`);
      expect(out).toContain('预览: 第一卷 潜龙在渊……');
      // 严格大于才 stale——早于/等于均不带「有改动」前缀。
      expect(out).not.toContain('晚于描述生成');
      expect(out).not.toContain('read_file 实读为准');
      expect(out).toContain('(随消息上传的文件，请先阅读后再依据它回应，勿凭文件名猜测内容)');
    }
  });

  it('description 有而 describedAt 缺省：描述行不带生成时间括注（防御分支，正常路径不出现）', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const out = renderAttachmentsIntoContent('正文', [
      { type: 'file', id: 'inbox/a.md', label: 'a.docx', description: '一份设定集。' },
    ]);
    expect(out).toContain('描述: 一份设定集。');
    expect(out).not.toContain('生成于');
    expect(out).toContain('(随消息上传的文件，请先阅读后再依据它回应，勿凭文件名猜测内容)');
  });

  it('无四字段的既有 file 附件走原 else 渲染零变化（精确锁定）', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const out = renderAttachmentsIntoContent('c', [{ type: 'file', id: 'chapters/第一章.md', label: '第一章' }]);
    expect(out).toBe('[引用文件: 第一章] (path: chapters/第一章.md)\n---\nc');
  });

  it('混合批次：上传附件走门控分支、无字段附件同批走原 else（共存互不干扰）', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const out = renderAttachmentsIntoContent('正文', [
      { type: 'file', id: 'notes/旧笔记.md', label: '旧笔记' },
      { type: 'file', id: 'inbox/大纲.md', label: '大纲.docx', preview: '第一卷……' },
    ]);
    expect(out).toBe(
      [
        '[引用文件: 旧笔记] (path: notes/旧笔记.md)',
        '',
        '[引用文件: 大纲.docx] (path: inbox/大纲.md)',
        '预览: 第一卷……',
        '(随消息上传的文件，请先阅读后再依据它回应，勿凭文件名猜测内容)',
      ].join('\n') + '\n---\n正文',
    );
  });

  it('既有附件零变化回归：chapter / pattern / selection 三分支与无附件直通逐字不变', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    // pattern：id 前缀门控在前，不受新分支影响。
    expect(renderAttachmentsIntoContent('c', [{ type: 'file', id: 'pattern:三幕式', label: '三幕式' }])).toBe(
      '[结构 pattern: 三幕式] (作者选定此结构骨架作起步方向；据此塑造主线，非逐字套用)\n---\nc',
    );
    // chapter。
    expect(renderAttachmentsIntoContent('c', [{ type: 'chapter', id: 'ch_001', label: '第一章' }])).toBe(
      '[引用章节: 第一章] (chapterId: ch_001)\n---\nc',
    );
    // selection：整块引用形态逐字锁定。
    expect(
      renderAttachmentsIntoContent('c', [
        {
          type: 'selection',
          id: 'sel-1',
          label: '开篇',
          text: '夜色像一张潮湿的网。',
          sourceType: 'file',
          filePath: 'chapters/第一章.md',
          anchor: { quote: '夜色像一张潮湿的网。', prefix: '', suffix: '', rangeHint: { from: 0, to: 10 } },
        },
      ]),
    ).toBe(
      [
        '[选段引用 · 开篇]',
        '来源: 文件 chapters/第一章.md',
        '位置提示: 字符 0-10',
        '正文:',
        '"""',
        '夜色像一张潮湿的网。',
        '"""',
        '(用户正在讨论这段正文。)',
      ].join('\n') + '\n---\nc',
    );
    // 无附件：直通（空数组与 undefined 两形态）。
    expect(renderAttachmentsIntoContent('c', [])).toBe('c');
    expect(renderAttachmentsIntoContent('c')).toBe('c');
  });

  it('formatAttachmentTimestamp：YYYY-MM-DD HH:mm 形态 + 单位数补零（本地时区确定性）', async () => {
    const { formatAttachmentTimestamp } = await import('../src/runtime/workflow');
    // 本地分量构造（2026-05-03 07:05）——单位数月/日/时/分全补零，与机器时区无关。
    expect(formatAttachmentTimestamp(new Date(2026, 4, 3, 7, 5).getTime())).toBe('2026-05-03 07:05');
    expect(formatAttachmentTimestamp(DESCRIBED_AT)).toBe(localFmt(DESCRIBED_AT));
  });
});

describe('B2 — createUserMessage image 附件提取 + 图片指针行（R2.3 / dogfood #45）', () => {
  it('image 附件提取进 images 指针字段（path/b64hash/name←label），content 带图片指针行', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const msg = createUserMessage('这张图里是什么', [
      { type: 'image', id: 'img-1', label: '截图1.png', path: 'inbox/images/2026-09-01-a1.png', b64hash: 'sha256-abc' },
    ]);
    expect(msg.role).toBe('user');
    expect(msg.images).toEqual([
      { path: 'inbox/images/2026-09-01-a1.png', b64hash: 'sha256-abc', name: '截图1.png' },
    ]);
    expect(msg.content).toBe(
      '[图片引用 · 截图1.png] (path: inbox/images/2026-09-01-a1.png)\n---\n这张图里是什么',
    );
  });

  it('混合批次：image 提取进 images 字段，file 附件仍走各自渲染分支（同批共存互不干扰）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const msg = createUserMessage('正文', [
      { type: 'file', id: 'inbox/大纲.md', label: '大纲.docx', preview: '第一卷……' },
      { type: 'image', id: 'img-1', label: '配图.png', path: 'inbox/images/pei.png', b64hash: 'h-pei' },
      { type: 'chapter', id: 'ch_001', label: '第一章' },
    ]);
    // images 字段只含 image 条目（file/chapter 不混入）。
    expect(msg.images).toEqual([{ path: 'inbox/images/pei.png', b64hash: 'h-pei', name: '配图.png' }]);
    // content 侧三块按附件顺序渲染：file 门控分支 → image 指针行 → chapter。
    expect(msg.content).toBe(
      [
        '[引用文件: 大纲.docx] (path: inbox/大纲.md)',
        '预览: 第一卷……',
        '(随消息上传的文件，请先阅读后再依据它回应，勿凭文件名猜测内容)',
        '',
        '[图片引用 · 配图.png] (path: inbox/images/pei.png)',
        '',
        '[引用章节: 第一章] (chapterId: ch_001)',
      ].join('\n') + '\n---\n正文',
    );
  });

  it('无 image 附件 → images 键缺席（additive optional：undefined 附件与纯 file/chapter/selection 批次同）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    expect('images' in createUserMessage('c')).toBe(false);
    expect('images' in createUserMessage('c', [])).toBe(false);
    expect('images' in createUserMessage('c', [{ type: 'file', id: 'notes/a.md', label: 'a' }])).toBe(false);
    expect('images' in createUserMessage('c', [{ type: 'chapter', id: 'ch1', label: '一' }])).toBe(false);
  });

  it('kind 盖章与 images 提取共存（dogfood R2 #93 语义不因 B2 变化）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const msg = createUserMessage(
      '事件回注',
      [{ type: 'image', id: 'img-1', label: '链图.png', path: 'inbox/images/c.png', b64hash: 'hc' }],
      'chain_completed_event',
    );
    expect(msg.kind).toBe('chain_completed_event');
    expect(msg.images).toEqual([{ path: 'inbox/images/c.png', b64hash: 'hc', name: '链图.png' }]);
  });

  it('renderAttachmentsIntoContent image 指针行：单行形态精确锁定（无字节/无 b64 泄漏进文本）', async () => {
    const { renderAttachmentsIntoContent } = await import('../src/runtime/workflow');
    const out = renderAttachmentsIntoContent('c', [
      { type: 'image', id: 'img-x', label: '概念图.jpg', path: 'inbox/images/x.jpg', b64hash: 'hx' },
    ]);
    expect(out).toBe('[图片引用 · 概念图.jpg] (path: inbox/images/x.jpg)\n---\nc');
    expect(out).not.toContain('b64hash'); // 指纹不进正文（只在结构化字段/wire part）
    expect(out).not.toContain('data:image');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR-001 决议 b（BMad CR 2026-09-01）：createUserMessage 第 4 参 projectPath
// 透传——调用点（sendMessage/streamMessage）从所在 session 拿 session.projectPath
// 填入每条 image 指针；shell generate 缝据此精确定位读盘根（免注册库多候选扫描）。
// 可选入参：缺省调用（既有两参/三参）不产字段，逐字节零变化。
// ─────────────────────────────────────────────────────────────────────────────

describe('CR-001b — createUserMessage projectPath 透传', () => {
  it('第 4 参透传：每条 image 指针都携带 projectPath（多图同填）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const msg = createUserMessage(
      'c',
      [
        { type: 'image', id: 'img-1', label: '图.png', path: 'inbox/images/g.png', b64hash: 'hg' },
        { type: 'image', id: 'img-2', label: '图2.png', path: 'inbox/images/g2.png', b64hash: 'hg2' },
      ],
      undefined,
      'C:/proj/alpha',
    );
    expect(msg.images).toEqual([
      { path: 'inbox/images/g.png', b64hash: 'hg', name: '图.png', projectPath: 'C:/proj/alpha' },
      { path: 'inbox/images/g2.png', b64hash: 'hg2', name: '图2.png', projectPath: 'C:/proj/alpha' },
    ]);
    // 指针行文本不受影响（projectPath 只进结构化字段，不渲染进 content）。
    expect(msg.content).not.toContain('C:/proj/alpha');
  });

  it('缺省调用零变化：既有两参/三参形态键缺席（ABSENT 非 undefined）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const twoArg = createUserMessage('c', [
      { type: 'image', id: 'img-1', label: '图.png', path: 'inbox/images/g.png', b64hash: 'hg' },
    ]);
    expect(twoArg.images).toEqual([{ path: 'inbox/images/g.png', b64hash: 'hg', name: '图.png' }]);
    expect('projectPath' in twoArg.images![0]!).toBe(false);

    const stamped = createUserMessage(
      'c',
      [{ type: 'image', id: 'img-1', label: '图.png', path: 'inbox/images/g.png', b64hash: 'hg' }],
      'chain_completed_event',
    );
    expect(stamped.images).toEqual([{ path: 'inbox/images/g.png', b64hash: 'hg', name: '图.png' }]);
    expect('projectPath' in stamped.images![0]!).toBe(false);
  });

  it('kind 盖章与 projectPath 透传正交共存（dogfood R2 #93 语义不因 CR-001b 变化）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const msg = createUserMessage(
      '事件回注',
      [{ type: 'image', id: 'img-1', label: '链图.png', path: 'inbox/images/c.png', b64hash: 'hc' }],
      'chain_completed_event',
      'C:/proj/alpha',
    );
    expect(msg.kind).toBe('chain_completed_event');
    expect(msg.images).toEqual([{ path: 'inbox/images/c.png', b64hash: 'hc', name: '链图.png', projectPath: 'C:/proj/alpha' }]);
  });

  it('空串防御：projectPath 为空串时不产字段（缺省回落无字段形态，shell 走既有 fallback）', async () => {
    const { createUserMessage } = await import('../src/runtime/workflow');
    const msg = createUserMessage(
      'c',
      [{ type: 'image', id: 'img-1', label: 'x.png', path: 'inbox/images/x.png', b64hash: 'hx' }],
      undefined,
      '',
    );
    expect('projectPath' in msg.images![0]!).toBe(false);
  });
});

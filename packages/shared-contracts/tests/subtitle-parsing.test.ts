import { describe, expect, it } from 'vitest';
import { SUBTITLE_PARAGRAPH_GAP_MS, joinSubtitleCues, parseSubtitle } from '../src';
import type { SubtitleFormat } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// E10.2a Wave 1：字幕解析（contracts/subtitle-parsing.ts，design §2.2）。
// 重点：三格式剥离正确性 + 畸形容忍（BOM/CRLF/缺序号/坏时间码/NOTE/override/\N/双轨 ass/
// 双语交错）+ join 停顿分段边界/空格规则（不伪造标点）。
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSubtitle — srt', () => {
  it('基本解析：序号/时间码剥离，多行文本按空格规则合并，时间依文件序', () => {
    const raw = [
      '1',
      '00:00:01,000 --> 00:00:04,000',
      '大家好',
      '今天讲第一课',
      '',
      '2',
      '00:00:05,500 --> 00:00:08,000',
      '第二句',
    ].join('\n');
    const r = parseSubtitle(raw, 'srt');
    expect(r.notes).toEqual([]);
    expect(r.cues).toEqual([
      { startMs: 1000, endMs: 4000, text: '大家好今天讲第一课' },
      { startMs: 5500, endMs: 8000, text: '第二句' },
    ]);
  });

  it('容忍 BOM/CRLF/缺序号/尾随空行（design §2.2 容忍面）', () => {
    const raw = '﻿\r\n00:00:01,000 --> 00:00:02,000\r\n带时间戳的一句\r\n\r\n\r\n'
      + '00:00:05,000 --> 00:00:06,000\r\n缺序号的句子\r\n\r\n\r\n';
    const r = parseSubtitle(raw, 'srt');
    expect(r.cues.length).toBe(2);
    expect(r.cues[0]).toEqual({ startMs: 1000, endMs: 2000, text: '带时间戳的一句' });
    expect(r.cues[1].startMs).toBe(5000);
    expect(r.cues[1].text).toBe('缺序号的句子');
    expect(r.notes).toEqual([]);
  });

  it('坏时间码块跳过 + note 计数（degrade 不 drop 邻块）', () => {
    const raw = [
      '1', '00:00:01,000 --> 00:00:02,000', '好块',
      '', '2', '00:00:03 --> 00:00:04,000', '坏时间码（缺毫秒）',
      '', '3', '00:00:05,000 --> 00:00:06,000', '又一个好块',
    ].join('\n');
    const r = parseSubtitle(raw, 'srt');
    expect(r.cues.map((c) => c.text)).toEqual(['好块', '又一个好块']);
    expect(r.notes).toEqual(['跳过 1 个无有效时间码的块']);
  });

  it('毫秒分隔符 . 与行尾坐标尾巴容忍（只锚两枚时间码）', () => {
    const raw = '1\n00:00:01.000 --> 00:00:02.000 X1:100 X2:200 Y1:50 Y2:80\n坐标尾巴不进正文\n';
    const r = parseSubtitle(raw, 'srt');
    expect(r.cues[0]).toEqual({ startMs: 1000, endMs: 2000, text: '坐标尾巴不进正文' });
  });

  it('双语交错整体保留（无轨道信息不拆——两语 cue 全在）', () => {
    const raw = [
      '1', '00:00:01,000 --> 00:00:02,000', '你好',
      '', '2', '00:00:02,000 --> 00:00:03,000', 'Hello',
      '', '3', '00:00:03,000 --> 00:00:04,000', '世界',
    ].join('\n');
    const r = parseSubtitle(raw, 'srt');
    expect(r.cues.map((c) => c.text)).toEqual(['你好', 'Hello', '世界']);
    expect(r.cues.every((c) => c.track === undefined)).toBe(true);
  });

  it('完全无文本（空文件/纯噪声/纯时间码）→ 空 cues + 拒收 note', () => {
    for (const raw of ['', '   \n\n  ', 'not a subtitle at all\njust text\n', '00:00:01,000 --> 00:00:02,000\n']) {
      const r = parseSubtitle(raw, 'srt');
      expect(r.cues).toEqual([]);
      expect(r.notes).toContain('未解析出任何字幕文本');
    }
  });
});

describe('parseSubtitle — vtt', () => {
  it('WEBVTT 头/元数据行/NOTE/STYLE/REGION 块剥离；cue settings 剥离；小时可省略', () => {
    const raw = [
      'WEBVTT - 示例',
      'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000',
      '',
      'NOTE',
      '这是注释块',
      '可以多行',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'REGION',
      'id:fred width:40%',
      '',
      'intro',
      '00:01.000 --> 00:04.000 align:start line:0%',
      '去头部后的正文',
      '',
      '00:00:10.000 --> 00:00:12.000 position:50%',
      '晚一点的那句',
    ].join('\n');
    const r = parseSubtitle(raw, 'vtt');
    expect(r.cues.map((c) => c.text)).toEqual(['去头部后的正文', '晚一点的那句']);
    expect(r.cues[0].startMs).toBe(1000); // 小时省略（MM:SS.mmm）
    expect(r.cues[1].startMs).toBe(10000);
    expect(r.notes).toEqual([]);
  });

  it('内联标签（<c>/<v 名字>/时间戳标签）剥除 + 常见实体解码', () => {
    const raw = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      '<v 张三>大家好</v><c.yellow> 重点</c>',
      '第二行 <00:00:02.000>带时间戳标签 &amp; &lt;b&gt; 实体',
    ].join('\n');
    const r = parseSubtitle(raw, 'vtt');
    // 行合并：尾部「点」是 CJK 边界 → 直接拼接（空格规则，不伪造标点）
    expect(r.cues[0].text).toBe('大家好 重点第二行 带时间戳标签 & <b> 实体');
  });

  it('缺 WEBVTT 头（降级形态）照常解析；无时间码块跳过 + note', () => {
    const raw = ['裸 cue 无头', '00:00:01.000 --> 00:00:02.000', '无头也能解析', '', '孤立文本块'].join('\n');
    const r = parseSubtitle(raw, 'vtt');
    expect(r.cues.map((c) => c.text)).toEqual(['无头也能解析']);
    expect(r.notes).toEqual(['跳过 1 个无有效时间码的块']);
  });

  it('WEBVTT 头粘连首 cue（无空行分隔，CR-12）→ 块内定位时间码行解析，首 cue 文本不丢', () => {
    const raw = [
      'WEBVTT - 粘连形态',
      '00:00:01.000 --> 00:00:02.000',
      '首句粘连',
      '',
      '00:00:05.000 --> 00:00:06.000',
      '第二句',
    ].join('\n');
    const r = parseSubtitle(raw, 'vtt');
    expect(r.cues.map((c) => c.text)).toEqual(['首句粘连', '第二句']);
    expect(r.cues[0]).toEqual({ startMs: 1000, endMs: 2000, text: '首句粘连' });
    expect(r.notes).toEqual([]);
  });

  it('头粘连且带元数据行（X-TIMESTAMP-MAP）→ 元数据行剥除，cue 照常解析（CR-12）', () => {
    const raw = [
      'WEBVTT',
      'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000',
      '00:00:01.000 --> 00:00:02.000',
      '带元数据粘连的首句',
    ].join('\n');
    const r = parseSubtitle(raw, 'vtt');
    expect(r.cues.map((c) => c.text)).toEqual(['带元数据粘连的首句']);
    expect(r.notes).toEqual([]);
  });

  it('裸 `<` 字面不吞（CR-13：收紧标签形态——字母/斜杠/时间码起始才算标签）', () => {
    const raw = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '不等式 3<5>4 严格小于',
      '斜杠数字 </5> 也不是标签',
    ].join('\n');
    const r = parseSubtitle(raw, 'vtt');
    expect(r.cues[0].text).toBe('不等式 3<5>4 严格小于斜杠数字 </5> 也不是标签');
  });

  it('完全无文本 → 空 cues + 拒收 note', () => {
    const r = parseSubtitle('WEBVTT\n\nNOTE\n只有注释没有正文\n', 'vtt');
    expect(r.cues).toEqual([]);
    expect(r.notes).toContain('未解析出任何字幕文本');
  });
});

describe('parseSubtitle — ass', () => {
  const ASS_HEADER = [
    '[Script Info]',
    'Title: 示例',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Outline',
    'Style: Default,Arial,20,&H00FFFFFF,0,2',
    '',
  ].join('\n');
  const EVENTS_FORMAT = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

  it('Format 行列序取 Text；非 Events 段忽略；Comment 行忽略；Text 含逗号不被切列', () => {
    const raw = ASS_HEADER + [
      '[Events]',
      EVENTS_FORMAT,
      'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,注释行不产出',
      'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,第一句，含逗号与第二句',
      'Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,稍后的句子',
    ].join('\n');
    const r = parseSubtitle(raw, 'ass');
    expect(r.notes).toEqual([]);
    expect(r.cues).toEqual([
      { startMs: 1000, endMs: 4000, text: '第一句，含逗号与第二句', track: 0 },
      { startMs: 5000, endMs: 8000, text: '稍后的句子', track: 0 },
    ]);
  });

  it('Format 行缺失：v4.00+ 标准十列兜底', () => {
    const raw = '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,无 Format 行的句子\n';
    const r = parseSubtitle(raw, 'ass');
    expect(r.cues.map((c) => c.text)).toEqual(['无 Format 行的句子']);
  });

  it('override 块剥除 + \\N 换行 + \\h 硬空格', () => {
    const raw = ASS_HEADER + [
      '[Events]',
      EVENTS_FORMAT,
      'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\an8}标题行\\N第二行，继续\\h拼接',
    ].join('\n');
    const r = parseSubtitle(raw, 'ass');
    expect(r.cues[0].text).toBe('标题行\n第二行，继续 拼接');
  });

  it('双轨（Layer 0/1 交错）：文本量最大轨保留 + 其余丢弃记 note + startMs 稳定排序', () => {
    const raw = ASS_HEADER + [
      '[Events]',
      EVENTS_FORMAT,
      // Layer 1（外文轨，Style EN）与 Layer 0（中文轨，Style Default）交错出现，且 Layer 1 有一行时间更早
      'Dialogue: 1,0:00:00.50,0:00:00.90,EN,,0,0,0,,hello',
      'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,中文第一句，这一轨的字更多',
      'Dialogue: 1,0:00:01.00,0:00:04.00,EN,,0,0,0,,first line',
      'Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,中文第二句，继续更长一点',
    ].join('\n');
    const r = parseSubtitle(raw, 'ass');
    expect(r.cues.map((c) => c.text)).toEqual(['中文第一句，这一轨的字更多', '中文第二句，继续更长一点']);
    expect(r.cues.every((c) => c.track === 0)).toBe(true);
    expect(r.cues[0].startMs).toBe(1000); // Layer 1 的 500ms 早期行已随轨道丢弃
    expect(r.notes).toEqual(['多轨字幕：保留文本量最大的 Layer 0/Default（丢弃 Layer 1/EN）']);
  });

  it('同 Layer 异 Style 双轨（CR-7：Layer+Style 复合键——双语 ASS 常见形态）→ 分轨识别，文本量最大轨保留 + note', () => {
    const raw = ASS_HEADER + [
      '[Events]',
      EVENTS_FORMAT,
      // Layer 全 0、Style 分 CN/EN 两轨——Layer 单维分不出（CR-7 修复前既不分离也无 note）
      'Dialogue: 0,0:00:01.00,0:00:04.00,CN,,0,0,0,,中文第一句，这一轨的字更多',
      'Dialogue: 0,0:00:01.00,0:00:04.00,EN,,0,0,0,,hello',
      'Dialogue: 0,0:00:05.00,0:00:08.00,CN,,0,0,0,,中文第二句，继续更长一点',
    ].join('\n');
    const r = parseSubtitle(raw, 'ass');
    expect(r.cues.map((c) => c.text)).toEqual(['中文第一句，这一轨的字更多', '中文第二句，继续更长一点']);
    expect(r.cues.every((c) => c.track === 0)).toBe(true); // track 仍记 Layer（design §2.2）
    expect(r.notes).toEqual(['多轨字幕：保留文本量最大的 Layer 0/CN（丢弃 Layer 0/EN）']);
  });

  it('绘图模式（CR-14）：{\\p1} 后路径坐标不进 Text，至 {\\p0} 恢复；未闭合绘图丢弃余量', () => {
    const raw = ASS_HEADER + [
      '[Events]',
      EVENTS_FORMAT,
      'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}绘图后的正文',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,绘图前文字 {\\p2}m 0 0 l 50 50',
      'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\fad(200,200)\\p1}m 0 0 l 10 10{\\p0}混合标签后的正文',
    ].join('\n');
    const r = parseSubtitle(raw, 'ass');
    expect(r.cues.map((c) => c.text)).toEqual(['绘图后的正文', '绘图前文字', '混合标签后的正文']);
    expect(r.notes).toEqual([]);
  });

  it('坏 Dialogue 行（字段不足/时间码不可解析）跳过 + note；剥完只剩 override 的行不产 cue', () => {
    const raw = [
      '[Events]',
      EVENTS_FORMAT,
      'Dialogue: 0,0:00:01.00,0:00:02.00',
      'Dialogue: 0,bad-start,0:00:02.00,Default,,0,0,0,,坏时间码',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an8}',
    ].join('\n');
    const r = parseSubtitle(raw, 'ass');
    expect(r.cues).toEqual([]);
    expect(r.notes).toContain('跳过 2 行无法解析的 Dialogue 行');
    expect(r.notes).toContain('未解析出任何字幕文本');
  });

  it('无 [Events] 段（纯 Script Info 文件）→ 空 cues + 拒收 note', () => {
    const r = parseSubtitle('[Script Info]\nTitle: no events\n', 'ass');
    expect(r.cues).toEqual([]);
    expect(r.notes).toContain('未解析出任何字幕文本');
  });
});

describe('joinSubtitleCues — 停顿分段与空格规则', () => {
  it('停顿分段：间隔严格大于 gapMs 才分段（恰好 1500 不分 / 1501 分）；段时间范围取段首尾', () => {
    const cues = [
      { startMs: 1000, endMs: 3000, text: '第一句' },
      { startMs: 4500, endMs: 6000, text: '第二句' }, // 距上句末 1500 → 同段
      { startMs: 7501, endMs: 9000, text: '第三句' }, // 距上句末 1501 → 新段
    ];
    const paras = joinSubtitleCues(cues, { gapMs: 1500 });
    expect(paras.length).toBe(2);
    expect(paras[0]).toEqual({ text: '第一句第二句', startMs: 1000, endMs: 6000 });
    expect(paras[1]).toEqual({ text: '第三句', startMs: 7501, endMs: 9000 });
  });

  it('空格规则：CJK 边界直接拼接、拉丁边界补一空格；不伪造标点', () => {
    const cues = [
      { startMs: 0, endMs: 1000, text: 'this is' },
      { startMs: 1100, endMs: 2000, text: 'english' },
      { startMs: 2100, endMs: 3000, text: '中文接上' },
      { startMs: 3100, endMs: 4000, text: '继续拼' },
    ];
    const paras = joinSubtitleCues(cues, { gapMs: 5000 });
    expect(paras).toEqual([{ text: 'this is english 中文接上继续拼', startMs: 0, endMs: 4000 }]);
  });

  it('默认 gapMs = SUBTITLE_PARAGRAPH_GAP_MS（1500 常量导出，design §2.2）；空 cues → 空段数组', () => {
    expect(SUBTITLE_PARAGRAPH_GAP_MS).toBe(1500);
    const cues = [
      { startMs: 0, endMs: 1000, text: '一句' },
      { startMs: 3000, endMs: 4000, text: '隔了两秒' },
    ];
    expect(joinSubtitleCues(cues).length).toBe(2); // 缺省 opts → 默认 1500 → 2000ms 间隔分段
    expect(joinSubtitleCues([])).toEqual([]);
  });

  it('乱序输入按 startMs 稳定排序后串接（不信任文件序、不改入参数组）', () => {
    const cues = [
      { startMs: 5000, endMs: 6000, text: '后来的' },
      { startMs: 1000, endMs: 2000, text: '先来的' },
    ];
    const paras = joinSubtitleCues(cues, { gapMs: 5000 });
    expect(paras).toEqual([{ text: '先来的后来的', startMs: 1000, endMs: 6000 }]);
    expect(cues[0].text).toBe('后来的'); // 入参数组未被就地排序
  });

  it('段内含换行的 cue（ass \\N 产物）：换行保留，跨行拼接不重复补空格', () => {
    const cues = [
      { startMs: 0, endMs: 1000, text: '标题行\n正文行' },
      { startMs: 1100, endMs: 2000, text: '后续句' },
    ];
    const paras = joinSubtitleCues(cues, { gapMs: 1500 });
    expect(paras).toEqual([{ text: '标题行\n正文行后续句', startMs: 0, endMs: 2000 }]);
  });

  it('星面 CJK 段尾不误补空格（CR-15：末码点须代理对感知——U+20000-U+2FA1F 取整码点）', () => {
    // 𠀀 = U+20000（CJK 扩展 B，代理对 D840 DC00）——修复前 codePointAt(len-1) 取到低位代理
    // 0xDC00 误判非 CJK，中文边界间会插入多余空格
    const cues = [
      { startMs: 0, endMs: 1000, text: '星面字收尾𠀀' },
      { startMs: 1100, endMs: 2000, text: '接续' },
    ];
    const paras = joinSubtitleCues(cues, { gapMs: 1500 });
    expect(paras[0].text).toBe('星面字收尾𠀀接续');
    // 对照：BMP CJK 段尾同样直拼（既有行为不回归）
    const bmp = joinSubtitleCues(
      [
        { startMs: 0, endMs: 1000, text: '平面字收尾' },
        { startMs: 1100, endMs: 2000, text: '接续' },
      ],
      { gapMs: 1500 },
    );
    expect(bmp[0].text).toBe('平面字收尾接续');
  });
});

describe('parseSubtitle — 入口分派 fail-loud', () => {
  it('非枚举 format 值 → throw（CR-16：不返回 undefined 让调用方解构崩 TypeError）', () => {
    const bad = 'ssa' as unknown as SubtitleFormat;
    expect(() => parseSubtitle('00:00:01,000 --> 00:00:02,000\n文本\n', bad)).toThrow(/未知字幕格式/);
  });
});

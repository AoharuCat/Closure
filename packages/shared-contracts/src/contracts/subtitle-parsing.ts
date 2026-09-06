// ── E10.2a：字幕解析（srt/vtt/ass → cues + 停顿分段拼合，纯函数，design §2.2）──
//
// 定位：视频字幕文件（B 站经验视频等 .srt/.vtt/.ass）进材料管线的第一段——三格式 → 时间轴
// 文本事件（SubtitleCue[]），再经 joinSubtitleCues 停顿分段拼合成纯文本段落。消费方 = shell
// materialIngest（Wave 2：readFile → parse → join → R3 LLM 书面化整理 → 既有分章/索引管线，
// 检索消费面零新增）。
//
// 设计立场：
// - 范式判据（ADR-3）：剥时间码/样式标签/控制符、按停顿分段是「不理解意义」的机械活，归纯
//   代码；**不伪造标点**——口语碎句的书面化（加标点/去语气词/合并/视觉指代改写）归 R3 LLM
//   整理，本模块只拼不改写。
// - 畸形容忍（mirror craftMd 哲学）：能抠出文本就抠（degrade 不 drop）；时间码坏到无法定位
//   的块跳过 + note 计数（不伪造 0 点硬给）；完全无文本 → 空 cues + note（调用方走既有
//   durable 拒收，AC7）。
// - 多轨（ass 不同 Layer/Style 并存——Layer+Style 复合键分轨，CR-7）：V1 取文本量最大轨，
//   其余丢弃记 note；双语 srt 交错无轨道信息时整体保留不拆——拆不拆、怎么并轨是语义判断，
//   归 R3 LLM 的双语混排规则。
//
// expected_downstream_consumers:
// - shell materialIngest（E10.2a Wave 2）：文本获取分支 format ∈ {srt,ass,vtt} 的解析入口。
// - SubtitleParagraph 时间范围：R3 超长字幕分段整理按段界装箱（锚定不跨段错位）。

export type SubtitleFormat = 'srt' | 'ass' | 'vtt';

/** 单条字幕 cue（时间轴文本事件）。`track`：ass 的 Layer（多轨标识；srt/vtt 无轨道概念缺省）。 */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
  track?: number;
}

/** 解析产物：cues + 诊断 notes（人读——进 quality.parseNotes 的「按什么解析的」可解释回报）。 */
export interface SubtitleParseResult {
  cues: SubtitleCue[];
  notes: string[];
}

/** 停顿分段产物：段文本（多 cue 拼合）+ 段时间范围（R3 分段整理按段界对齐）。 */
export interface SubtitleParagraph {
  text: string;
  startMs: number;
  endMs: number;
}

// ── 通用工具（纯字符串处理，零依赖零 fs/db/Date/random）──

/** BOM 剥除 + 行尾归一（CRLF/CR → LF）——三解析器入口统一过一道（容忍面）。 */
function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 空行切块（块内保留原始行序；连续空行/首尾空行容忍——trim 后空即分界）。 */
function splitBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * CJK 码点判定（空格规则的边界判据）：汉字/假名/谚文/CJK 标点与全角形式（，。「」等）。
 * CJK 边界之间不加空格（中文排版惯例）；非 CJK 边界（拉丁词/数字）之间补一空格。
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // 谚文字母
    (cp >= 0x3000 && cp <= 0x30ff) || // CJK 符号标点（。、「」）+ 假名
    (cp >= 0x3130 && cp <= 0x318f) || // 谚文兼容字母
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角形式（，！？与全角字母数字）
    (cp >= 0x20000 && cp <= 0x2fa1f) // CJK 扩展 B-F + 兼容补充
  );
}

/**
 * 取文本末字符码点（代理对感知，CR-15）：末字符是星面 CJK（U+20000-U+2FA1F，𠀀 等）时
 * UTF-16 编码为代理对——`codePointAt(length-1)` 只取到低位代理（0xDC00-0xDFFF），须回退
 * 一位取整码点，否则误判非 CJK 误补空格。
 */
function lastCodePoint(text: string): number {
  const prevUnit = text.charCodeAt(text.length - 2);
  if (prevUnit >= 0xd800 && prevUnit <= 0xdbff) {
    return text.codePointAt(text.length - 2) as number;
  }
  return text.codePointAt(text.length - 1) as number;
}

/**
 * 文本追加分隔规则（design §2.2 空格规则）：前文尾已是非 CJK 边界（拉丁/数字）才补一空格；
 * CJK 边界或既有空白/换行后直接拼接。**不伪造标点**——碎句原样相接，书面化归 R3 LLM。
 */
function appendText(prev: string, next: string): string {
  if (prev === '') return next;
  const tail = lastCodePoint(prev);
  if (tail === 10 || tail === 32 || isCjkCodePoint(tail)) return prev + next;
  return `${prev} ${next}`;
}

/** 块内多行文本合并（行 trim + 空行滤除 + 空格规则相接）。 */
function mergeLines(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reduce((acc, line) => appendText(acc, line), '');
}

/** srt/vtt 时间码毫秒换算（毫秒字段按 3 位右补零——`5` → 500ms，容忍窄写法）。 */
function toMs(h: string, m: string, s: string, frac: string): number {
  const ms = Number.parseInt(frac.padEnd(3, '0'), 10);
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + ms;
}

/** 空结果统一拒收 note（完全无文本——调用方据此走 durable 拒收）。 */
const EMPTY_NOTE = '未解析出任何字幕文本';

/** 空结果收尾：无任何文本 cue 时统一补拒收 note。 */
function finalize(cues: SubtitleCue[], notes: string[]): SubtitleParseResult {
  if (cues.length === 0 && !notes.includes(EMPTY_NOTE)) notes.push(EMPTY_NOTE);
  return { cues, notes };
}

// ── srt ──

/**
 * srt 时间码行：`HH:MM:SS,mmm --> HH:MM:SS,mmm`。毫秒分隔符 `,`/`.` 容忍；小时 1-3 位
 * 容忍；行尾坐标尾巴（`X1:... Y1:...`）与行内多余 token 不计入（只锚两枚时间码）。
 */
const SRT_TIMING_RE =
  /^(\d{1,3}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function parseSrt(content: string): SubtitleParseResult {
  const notes: string[] = [];
  const cues: SubtitleCue[] = [];
  let skippedBlocks = 0;
  for (const block of splitBlocks(normalizeContent(content))) {
    const timingIdx = block.findIndex((line) => SRT_TIMING_RE.test(line));
    if (timingIdx === -1) {
      skippedBlocks += 1; // 无有效时间码：无法定位时间轴，跳过整块（不伪造 0 点硬给）
      continue;
    }
    const m = SRT_TIMING_RE.exec(block[timingIdx]);
    if (!m) continue; // findIndex 已保证命中，防御分支
    const text = mergeLines(block.slice(timingIdx + 1));
    if (text === '') continue; // 纯时间码块（对位用空 cue）不产
    cues.push({
      startMs: toMs(m[1], m[2], m[3], m[4]),
      endMs: toMs(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  if (skippedBlocks > 0) notes.push(`跳过 ${skippedBlocks} 个无有效时间码的块`);
  return finalize(cues, notes);
}

// ── vtt ──

/** vtt 时间码行：小时可选（`MM:SS.mmm` 合法）；箭头后 cue settings（align:/line: 等）不计。 */
const VTT_TIMING_RE =
  /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

/**
 * vtt 内联标签剥除（CR-13 收紧）：字母/斜杠起始标签（`<c>`/`<c.yellow>`/`<v 名字>`/`</v>`/
 * `<b>`）+ 时间戳标签（`<00:00:01.000>`——数字起始且带冒号的时间码形态）。数字起始非
 * 时间码的裸 `<` 字面（`3<5>4` 类）不是标签，不吞。
 */
const VTT_TAG_RE = /<\/?[a-zA-Z][^>]*>|<\d{2,3}:[^>]*>/g;

/** vtt 常见实体解码（`&amp;` 最后，防 `&amp;lt;` 双重解码；方向标记直接剥）。 */
function decodeVttEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lrm;/g, '')
    .replace(/&rlm;/g, '')
    .replace(/&amp;/g, '&');
}

function vttTimeParts(h: string | undefined, m: string, s: string, frac: string): number {
  return ((h ? Number(h) : 0) * 3600 + Number(m) * 60 + Number(s)) * 1000
    + Number.parseInt(frac.padEnd(3, '0'), 10);
}

function parseVtt(content: string): SubtitleParseResult {
  const notes: string[] = [];
  const cues: SubtitleCue[] = [];
  let skippedBlocks = 0;
  const blocks = splitBlocks(normalizeContent(content));
  for (let i = 0; i < blocks.length; i++) {
    let block = blocks[i];
    // 首块 WEBVTT 头（+ 头部元数据行）：头与首 cue 粘连（无空行分隔的降级形态）时块内定位
    // 到时间码行起解析（CR-12——整块跳过会静默丢首 cue）；纯头块（无粘连 cue）照旧跳过；
    // 缺头当普通块处理。
    if (i === 0 && block[0].startsWith('WEBVTT')) {
      const headerTimingIdx = block.findIndex((line) => VTT_TIMING_RE.test(line));
      if (headerTimingIdx === -1) continue;
      block = block.slice(headerTimingIdx); // 头/元数据行剥除，cue 自时间码行起
    }
    // NOTE / STYLE / REGION 块整块跳过（\b 防 cue id 恰为 NOTES 之类误吞）。
    if (/^(NOTE|STYLE|REGION)\b/.test(block[0])) continue;
    const timingIdx = block.findIndex((line) => VTT_TIMING_RE.test(line));
    if (timingIdx === -1) {
      skippedBlocks += 1;
      continue;
    }
    const m = VTT_TIMING_RE.exec(block[timingIdx]);
    if (!m) continue; // 防御分支
    const text = mergeLines(
      block.slice(timingIdx + 1).map((line) => decodeVttEntities(line.replace(VTT_TAG_RE, ''))),
    );
    if (text === '') continue;
    cues.push({
      startMs: vttTimeParts(m[1], m[2], m[3], m[4]),
      endMs: vttTimeParts(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  if (skippedBlocks > 0) notes.push(`跳过 ${skippedBlocks} 个无有效时间码的块`);
  return finalize(cues, notes);
}

// ── ass ──

/** ass 时间码：`H:MM:SS.cc`（末段是厘秒两位）。 */
const ASS_TIME_RE = /^(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,2})/;

/** ass [Events] 标准列序（Format 行缺失时的兜底——v4.00+ 十列）。 */
const ASS_DEFAULT_FORMAT = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
];

function parseAssTime(field: string): number | null {
  const m = ASS_TIME_RE.exec(field.trim());
  if (!m) return null;
  const cs = Number.parseInt(m[4].padEnd(2, '0'), 10); // 厘秒 → 毫秒（×10；窄写法右补零）
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + cs * 10;
}

/**
 * 按 Format 列数切 Dialogue 字段：**末列（Text）吃余量**——Text 可含逗号，只切前 N-1 个
 * 逗号，余下整体归末列。字段数不足（坏行）返回 null。
 */
function splitAssFields(payload: string, count: number): string[] | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 1; i < count; i++) {
    const comma = payload.indexOf(',', start);
    if (comma === -1) return null;
    fields.push(payload.slice(start, comma));
    start = comma + 1;
  }
  fields.push(payload.slice(start));
  return fields;
}

/**
 * ass 文本清理：`{\...}` override 块剥除、`\N`/`\n` 换行、`\h` 硬空格；逐行 trim 空行滤除。
 * 绘图模式（CR-14）：override 含 `\p<非零>`（scale>0）→ 其后文本是绘图路径坐标（m/l 命令
 * 数字流）不进 Text，直至 `\p0` override 关闭；无关闭块时余量全是路径同样丢弃。同块多个
 * `\p` 取末个（后者覆盖前者）。
 */
function cleanAssText(raw: string): string {
  let stripped = '';
  let pos = 0;
  let drawing = false;
  while (pos < raw.length) {
    const open = raw.indexOf('{', pos);
    if (open === -1) {
      if (!drawing) stripped += raw.slice(pos);
      break;
    }
    if (!drawing) stripped += raw.slice(pos, open);
    const close = raw.indexOf('}', open);
    if (close === -1) {
      if (!drawing) stripped += raw.slice(open); // 未闭合 override：按字面保留（mirror 旧剥除只针对配对块）
      break;
    }
    const block = raw.slice(open + 1, close);
    for (const m of block.matchAll(/\\p[+-]?\d+/g)) {
      drawing = Number.parseInt(m[0].slice(2), 10) !== 0;
    }
    pos = close + 1;
  }
  const expanded = stripped.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
  return expanded
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

function parseAss(content: string): SubtitleParseResult {
  const notes: string[] = [];
  const raw: Array<{ startMs: number; endMs: number; text: string; layer: number; style: string }> = [];
  let inEvents = false;
  let formatCols = ASS_DEFAULT_FORMAT;
  let badLines = 0;
  for (const line of normalizeContent(content).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue; // Script Info / V4+ Styles 等段忽略
    if (/^Format:\s*/i.test(trimmed)) {
      formatCols = trimmed.replace(/^Format:\s*/i, '').split(',').map((col) => col.trim());
      continue;
    }
    if (!/^Dialogue:\s*/i.test(trimmed)) continue; // Comment: 等其余行忽略
    const fields = splitAssFields(trimmed.replace(/^Dialogue:\s*/i, ''), formatCols.length);
    const startIdx = formatCols.indexOf('Start');
    const endIdx = formatCols.indexOf('End');
    const textIdx = formatCols.indexOf('Text');
    const layerIdx = formatCols.indexOf('Layer');
    const styleIdx = formatCols.indexOf('Style');
    if (!fields || startIdx === -1 || endIdx === -1 || textIdx === -1) {
      badLines += 1;
      continue;
    }
    const startMs = parseAssTime(fields[startIdx]);
    const endMs = parseAssTime(fields[endIdx]);
    if (startMs === null || endMs === null) {
      badLines += 1;
      continue;
    }
    const text = cleanAssText(fields[textIdx]);
    if (text === '') continue; // 剥完只剩 override/空白的行（特效空行）不产 cue
    const layer = layerIdx >= 0 ? Number.parseInt(fields[layerIdx], 10) : 0;
    const style = styleIdx >= 0 ? fields[styleIdx].trim() : '';
    raw.push({ startMs, endMs, text, layer: Number.isFinite(layer) ? layer : 0, style });
  }

  // 多轨选择（V1，design §2.2）：按 Layer+Style 复合键分轨（CR-7——同 Layer 异 Style 的双语
  // ASS 是常见形态，Layer 单维分不出既不分离也无 note），文本量（剥空白后字符数）最大轨保留，
  // 其余丢弃记 note；并列取首见轨（稳定）。双语 srt 交错无轨道信息——不适用本分支。
  const trackKey = (c: { layer: number; style: string }) => `${c.layer} ${c.style}`;
  const tracks = [...new Set(raw.map(trackKey))];
  let selected = raw;
  if (tracks.length > 1) {
    const labelByKey = new Map<string, string>();
    const volume = new Map<string, number>();
    for (const c of raw) {
      const key = trackKey(c);
      if (!labelByKey.has(key)) {
        labelByKey.set(key, c.style === '' ? `Layer ${c.layer}` : `Layer ${c.layer}/${c.style}`);
      }
      volume.set(key, (volume.get(key) ?? 0) + c.text.replace(/\s/g, '').length);
    }
    let keep = tracks[0];
    let best = -1;
    for (const track of tracks) {
      const v = volume.get(track) as number;
      if (v > best) {
        best = v;
        keep = track;
      }
    }
    const dropped = tracks.filter((t) => t !== keep);
    notes.push(
      `多轨字幕：保留文本量最大的 ${labelByKey.get(keep) as string}（丢弃 ${dropped
        .map((t) => labelByKey.get(t) as string)
        .join('、')}）`,
    );
    selected = raw.filter((c) => trackKey(c) === keep);
  }

  // startMs 稳定排序（跨轨交错/乱序行容忍；同刻并列保持文件序）
  selected.sort((a, b) => a.startMs - b.startMs);
  const cues: SubtitleCue[] = selected.map((c) => ({
    startMs: c.startMs,
    endMs: c.endMs,
    text: c.text,
    track: c.layer,
  }));
  if (badLines > 0) notes.push(`跳过 ${badLines} 行无法解析的 Dialogue 行`);
  return finalize(cues, notes);
}

// ── 入口分派 ──

/**
 * 三格式解析入口（纯函数；format 由调用方按文件扩展名分派，本函数不做运行时探测）。
 * 畸形容忍语义见文件头——能抠出文本就抠，完全无文本 → 空 cues + note。非枚举 format 值
 * **throw**（CR-16 fail-loud：返回 undefined 会让调用方解构崩 TypeError，直接抛带格式的错）。
 */
export function parseSubtitle(content: string, format: SubtitleFormat): SubtitleParseResult {
  switch (format) {
    case 'srt':
      return parseSrt(content);
    case 'vtt':
      return parseVtt(content);
    case 'ass':
      return parseAss(content);
    default:
      throw new Error(`parseSubtitle: 未知字幕格式 ${String(format)}`);
  }
}

// ── joinSubtitleCues：停顿分段拼合 ──

/** 停顿分段阈值（ms）：相邻 cue 间隔**严格大于**该值 → 段落边界（design §2.2 默认）。 */
export const SUBTITLE_PARAGRAPH_GAP_MS = 1500;

/**
 * cue 串 → 段落数组（停顿分段拼合，design §2.2）。
 *
 * - 时间序串接：入参按 startMs 稳定排序后处理（不信任文件序；原数组不被改动）。
 * - 段落边界：`startMs[i+1] - endMs[i] > gapMs`（缺省 SUBTITLE_PARAGRAPH_GAP_MS）。
 * - 段内拼合：空格规则（appendText——CJK 边界直接拼、非 CJK 边界补一空格）；**不伪造标点**。
 * - 段时间范围：startMs = 段首 cue 起点，endMs = 段内 cue 终点最大值（R3 分段整理对齐段界）。
 * - 空 cues / 空文本 cue 不产段、不占段界。
 */
export function joinSubtitleCues(cues: SubtitleCue[], opts: { gapMs?: number } = {}): SubtitleParagraph[] {
  const gapMs = opts.gapMs ?? SUBTITLE_PARAGRAPH_GAP_MS;
  const paragraphs: SubtitleParagraph[] = [];
  let current: SubtitleParagraph | null = null;
  for (const cue of [...cues].sort((a, b) => a.startMs - b.startMs)) {
    if (cue.text === '') continue;
    if (current !== null && cue.startMs - current.endMs > gapMs) {
      paragraphs.push(current);
      current = null;
    }
    if (current === null) {
      current = { text: cue.text, startMs: cue.startMs, endMs: cue.endMs };
    } else {
      current.text = appendText(current.text, cue.text);
      current.endMs = Math.max(current.endMs, cue.endMs);
    }
  }
  if (current !== null) paragraphs.push(current);
  return paragraphs;
}

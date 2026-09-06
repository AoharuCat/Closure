import { parseStyleSections } from '@orison/desktop-agent';
import type { DeconStylePayload, DeconStyleSectionKey } from '@orison/shared-contracts';
import { DECON_STYLE_SECTION_KEYS } from '@orison/shared-contracts';
import { DECON_STYLE_SECTION_HEADINGS } from './p4Style';

// ── E10.3b（task 09-05）W5：风格卡导出合并（child B design §8「导出动作」——4.7 落点）──
//
// `decon:export-style` 的纯合并面：p4:style 结构化 payload（14 节语义键）merge 写目标项目
// `settings/style.md`——
// - **语义键替换**：parseStyleSections（agent 包导出，W1 入口补挂）解析既有卡，按语义键替换
//   识别节；**未识别节与手写节原样保留**（作者手加的节不因导出丢——合并语义红线）；
// - **卡头/序言保留**：首节 heading 之前的内容（frontmatter / H1 卡头 / 分工注记）逐字保留；
// - **无卡新建**：标准 14 节标题串（DECON_STYLE_SECTION_HEADINGS——W4 单源）+ 标准卡头
//   （值对齐 agent prompts/style-analyzer-agent.yaml:78-104——yaml 是数据文件不可导入，值
//   拷贝 + 出处注记）；
// - **坏形防御** = parseStyleSections 容错（agent 包既有——无节卡整卡当序言保留，不丢用户
//   内容）；fenced 围栏感知（⑬ 节选内的 `## 第X章` 行不误切节——CR-008；**前言切割同款
//   fence 感知**——首节标题串先出现在 fenced 块内时不错切，CR-20）。
//
// IO（readFileSync/atomicWriteFileSync/withProjectLock）归 deconIpc handler——本文件纯函数
// 零 fs（fs-layer 纪律：withProjectLock 写串行化 + atomicWrite 落盘在 handler 面）。
//
// expected_downstream_consumers:
// - deconIpc `decon:export-style` handler（合并执行面）。
// - W6 拆书页导出动作（写前确认 UI 显示 writtenSections——将写入的节）。

/**
 * 标准 14 节标题串（「无卡新建」的卡头——值拷贝自 agent prompts/style-analyzer-agent.yaml
 * :78-104：`# 风格卡片` H1 + 分工注记一行。yaml 是数据文件不可导入，漂移由对拍测试防）。
 */
export const DECON_STYLE_CARD_HEADER = ['# 风格卡片', '', '> 本卡管「像谁」（正面画像）；llmlint 管「不像 AI」（负面清单）——两者互补。'].join(
  '\n',
);

/** 无卡新建时的来源注记行（导出语义说明——再次导出按语义节替换、手写节保留）。 */
export function deconStyleCardSourceNote(bookTitle: string): string {
  return `> 本卡由拆书风格维导出生成（来源《${bookTitle}》）——再次导出按语义节替换，手写节保留。`;
}

/** parseStyleSections 的节形状（agent 包 StyleCardSection 的结构面——入口未导出该型，推断单源）。 */
type ParsedStyleSection = ReturnType<typeof parseStyleSections>[number];

/** 节原文形态（heading + content，卡内逐字——mirror agent style-card sectionText）。 */
function sectionText(section: ParsedStyleSection): string {
  return section.content.trim().length > 0 ? `${section.heading}\n${section.content.trim()}` : section.heading;
}

/**
 * 首节 heading 的 **fence 感知定位**（CR-20）：裸 `body.indexOf(heading)` 会在 heading 串
 * 先出现在 fenced 块（⑬ 节选/⑭ 附录引文里的 `## ` 行）或序言文本内时返回错误位置——前言
 * 错切到围栏内，真节前的原文（含整个 fenced 块）被静默丢。逐行扫描：``` 围栏内的行跳过
 * （mirror agent parseStyleSections 的 inFence 扫描法——style-card.ts 同一 fence 判定），
 * 围栏外的整行等值命中即返回行首偏移。
 */
function indexOfHeadingOutsideFences(body: string, heading: string): number {
  let offset = 0;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
    } else if (!inFence && line === heading) {
      return offset;
    }
    offset += line.length + 1;
  }
  return -1;
}

/** 导出合并结果（writtenSections = 实际写入的节语义键——标准序，确定序）。 */
export interface DeconStyleMergeResult {
  content: string;
  writtenSections: DeconStyleSectionKey[];
}

/**
 * 合并风格卡（纯函数）：
 * - `existingBody === null`（无卡/空卡）→ 标准卡头 + 来源注记 + payload 各节按标准序新建；
 * - 有卡 → 序言（首节 heading 前的原文）+ 逐节：payload 有该语义键且未写过 → 标准标题 +
 *   payload 内容（**首个识别节替换**，后续同键重复节保留原样——手加副本不误删）；否则原样
 *   保留（未识别/手写/重复）；payload 有而卡内没有的节 → 按标准序追加在尾部。
 *
 * 坏形防御：existingBody 无任何可识别 `## ` 节标题 → 整卡当序言保留（parseStyleSections
 * 容错——内容零丢弃），payload 节追加其下。
 */
export function mergeDeconStyleCard(
  existingBody: string | null,
  payload: DeconStylePayload,
  bookTitle: string,
): DeconStyleMergeResult {
  const isFreshCard = existingBody === null || existingBody.trim().length === 0;
  const body = isFreshCard ? '' : existingBody!;
  const sections = isFreshCard ? [] : parseStyleSections(body);

  // 序言 = 首节 heading 之前的原文（frontmatter / H1 卡头 / 分工注记逐字保留）——fence 感知
  // 定位（CR-20：heading 串先出现在 fenced 块内时不错切）。
  let preamble = '';
  if (!isFreshCard) {
    if (sections.length === 0) {
      preamble = body.trimEnd(); // 坏形防御：无节卡整卡保留
    } else {
      const idx = indexOfHeadingOutsideFences(body, sections[0]!.heading);
      preamble = idx > 0 ? body.slice(0, idx).trimEnd() : '';
    }
  }

  const written = new Set<DeconStyleSectionKey>();
  const parts: string[] = [];
  if (isFreshCard) {
    parts.push([DECON_STYLE_CARD_HEADER, deconStyleCardSourceNote(bookTitle)].join('\n'));
  } else if (preamble.length > 0) {
    parts.push(preamble);
  }
  for (const section of sections) {
    const key = section.key;
    if (key !== null && payload.sections[key] !== undefined && !written.has(key)) {
      parts.push(`${DECON_STYLE_SECTION_HEADINGS[key]}\n\n${payload.sections[key]!.trim()}`);
      written.add(key);
    } else {
      parts.push(sectionText(section)); // 手写/未识别/重复节——原样保留
    }
  }
  // payload 有而卡内无的节 → 标准序追加（无卡新建同序——导出两路形态一致）。
  for (const key of DECON_STYLE_SECTION_KEYS) {
    if (payload.sections[key] === undefined || written.has(key)) continue;
    parts.push(`${DECON_STYLE_SECTION_HEADINGS[key]}\n\n${payload.sections[key]!.trim()}`);
    written.add(key);
  }
  return {
    content: `${parts.join('\n\n\n')}\n`,
    writtenSections: DECON_STYLE_SECTION_KEYS.filter((k) => written.has(k)),
  };
}

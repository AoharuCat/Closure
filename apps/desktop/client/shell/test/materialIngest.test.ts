/**
 * Story 10.1 Wave B：摄取编排 ingestMaterial 测试（design §4.2 / prd AC2/AC6/AC8）。
 *
 *   - REAL parseDocumentToMarkdown（txt 直读路径零依赖；epub 走真 jszip fixture）。
 *   - LLM 兜底四路（DI 假 generateText）：成功选择 / 失败回退 / 非法切点整体拒收 /
 *     候选超预算挂起不烧调用〔F-07〕（另含未装配内核挂起路）。
 *   - Wave A 裁决钉死：splitChapters 输出不含 para——章 span 的 para 区间由本波对**派生
 *     文本**计算（chunkChapter 章切片局部段号 ⊆ 章段区间，锚点跨层对齐）。
 *   - 幂等（F-03）：未变原件沿用存档章界（manual 最高优先）；内容变更重跑自动路径；
 *     人工标记随原件变更丢失 = 已知限制（note 诚实回报）。
 *   - 〔E10.2a〕字幕摄取：三格式 fixture 端到端（时间码/样式/控制符剥离 + 停顿分段）/
 *     LLM 整理四态（成功多段串接 / 未装配 / 失败 / 超限）+ 截断防御 + 幂等（原件未变
 *     reused 不重整理）/ 坏结构 durable 拒收。
 *   - 全部 fixtures 自制样文（AC11 版权红线——epub fixture 为 STORE-method zip 自建）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATERIAL_CHUNK_STRATEGIES,
  extractHeadingCandidates,
  materialSchema,
  parseChapterMarkers,
  splitChapters,
  type SubtitleParagraph,
} from '@orison/shared-contracts';
import type { Material } from '@orison/shared-contracts';
import {
  MATERIAL_ALLOWED_EXTENSIONS,
  MATERIAL_IMPORT_MAX_BATCH,
  MATERIAL_LLM_CANDIDATE_BUDGET,
  MATERIAL_LLM_FALLBACK_MIN_CHARS,
  MATERIAL_LLM_FALLBACK_SYSTEM_PROMPT,
  MATERIAL_MAX_FILE_BYTES,
  MAX_POLISH_SEGMENTS,
  POLISH_MAX_TOKENS,
  SEGMENT_CHAR_BUDGET,
  SUBTITLE_POLISH_SYSTEM_PROMPT,
  __clearMaterialLLMCoreForTest,
  boxPolishSegments,
  buildChapterFallbackPrompt,
  derivedRelPathFor,
  ingestMaterial,
  installMaterialLLMCore,
  materialIdFor,
  materialSourcePath,
  normalizeMaterialRelPath,
  normalizeMaterialText,
  parseChapterFallbackResponse,
  splitParagraphBlocks,
  stripChapterMarkerLines,
  type MaterialGenerateText,
  type MaterialIngestScope,
} from '../main/ipc/toolHandlers/materialIngest';
import { parseDocumentToMarkdown } from '../main/ipc/toolHandlers/parseDocumentHandlers';
import { buildDocxFixture, buildEpubFixture, buildPdfFixture } from './fixtures/documentFixtures';
import { rmBestEffort } from './rmBestEffort';

// ── 测试基建 ──

let materialsRoot: string;

beforeEach(() => {
  __clearMaterialLLMCoreForTest();
  materialsRoot = mkdtempSync(path.join(os.tmpdir(), 'material-ingest-'));
});

afterEach(() => {
  __clearMaterialLLMCoreForTest();
  rmBestEffort(materialsRoot);
});

function scope(overrides: Partial<MaterialIngestScope> = {}): MaterialIngestScope {
  return { scope: 'project', materialsRoot, projectId: '00042', ...overrides };
}

/** materials/ 内写原件（返回相对 materials 根的 posix 路径）。 */
function writeSource(rel: string, content: string | Buffer): string {
  const full = path.join(materialsRoot, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return rel;
}

function derivedAbs(rel: string): string {
  return path.join(materialsRoot, derivedRelPathFor(rel));
}

/** 4 章等长样文（章标 + 双段正文——正则 high 置信形态：≥3 命中 + 覆盖 + 均匀）。 */
function chapteredNovel(chapters = 4, bodyLen = 120): string {
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return Array.from({ length: chapters }, (_, i) => {
    const heading = `第${numerals[i]}章 风起之${i}`;
    const body = `${'墨'.repeat(bodyLen)}。\n\n${'雨'.repeat(bodyLen)}。`;
    return `${heading}\n\n${body}`;
  }).join('\n\n');
}

/**
 * ≥2 万字低置信样文（无强章标）：每块一段首短行（弱候选）+ 长正文。
 * blockCount 个块 × ~250 字 → 需 ≥ MATERIAL_LLM_FALLBACK_MIN_CHARS。
 */
function lowConfidenceLongText(blockCount: number, bodyLen = 240): string {
  return Array.from({ length: blockCount }, (_, i) => `小节之${i}\n\n${'墨'.repeat(bodyLen)}。`).join('\n\n');
}

/** 摄取 txt 的真解析依赖（直读路径，零网络零 native）。 */
function realParseDeps(): { parse: typeof parseDocumentToMarkdown } {
  return { parse: (root, rel) => parseDocumentToMarkdown(root, rel) };
}

// ── 纯函数面 ──

describe('常量与路径/身份 helpers', () => {
  it('批量上限 250 独立（≠ import-files 100，F-06）；候选预算 300；单件 50MB；字幕白名单（E10.2a）', () => {
    expect(MATERIAL_IMPORT_MAX_BATCH).toBe(250);
    expect(MATERIAL_LLM_CANDIDATE_BUDGET).toBe(300);
    expect(MATERIAL_LLM_FALLBACK_MIN_CHARS).toBe(20_000);
    expect(MATERIAL_MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(MATERIAL_ALLOWED_EXTENSIONS).toContain('.epub');
    expect(MATERIAL_ALLOWED_EXTENSIONS).toContain('.srt');
    expect(MATERIAL_ALLOWED_EXTENSIONS).toContain('.ass');
    expect(MATERIAL_ALLOWED_EXTENSIONS).toContain('.vtt');
    // 整理档三常量（F-02：分段预算 6000 / 段数封顶 12 / 输出预算 8000 独立于分章兜底 4096）。
    expect(SEGMENT_CHAR_BUDGET).toBe(6000);
    expect(MAX_POLISH_SEGMENTS).toBe(12);
    expect(POLISH_MAX_TOKENS).toBe(8000);
  });

  it('normalizeMaterialRelPath：归一通过；逃逸/.derived/隐藏段拒绝', () => {
    expect(normalizeMaterialRelPath('sub/foo.txt')).toBe('sub/foo.txt');
    expect(normalizeMaterialRelPath('\\sub\\foo.txt')).toBe('sub/foo.txt');
    for (const bad of ['../evil.txt', '/abs.txt', '.derived/foo.md', 'sub/.hidden.txt', '.git/config', '']) {
      expect(normalizeMaterialRelPath(bad)).toBeNull();
    }
  });

  it('materialSourcePath 双轨约定 + materialIdFor 格式（F-19 路径身份）', () => {
    expect(materialSourcePath('project', 'foo.txt')).toBe('materials/foo.txt');
    expect(materialSourcePath('global', 'foo.txt')).toBe('foo.txt');
    const id = materialIdFor('project', 'materials/foo.txt');
    expect(id).toMatch(/^mat-[0-9a-f]{12}$/);
    expect(materialIdFor('global', 'foo.txt')).not.toBe(id);
  });

  it('derivedRelPathFor：relPath 镜像子目录（F-08：materials/sub/foo.txt → .derived/sub/foo.md）', () => {
    expect(derivedRelPathFor('foo.txt')).toBe('.derived/foo.md');
    expect(derivedRelPathFor('sub/foo.txt')).toBe('.derived/sub/foo.md');
    expect(derivedRelPathFor('a/b/c.md')).toBe('.derived/a/b/c.md');
  });

  it('normalizeMaterialText：BOM strip + CRLF/CR→LF', () => {
    expect(normalizeMaterialText('﻿正文')).toBe('正文');
    expect(normalizeMaterialText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('段落基面与标记剥离（chunkChapter 跨层对齐的底座）', () => {
  it('splitParagraphBlocks：空行分块；转场标记与 mat-chapter 标记行不占号', () => {
    const text = '<!-- mat-chapter index=0 method=regex -->\n\n第一段\n\n第二段\n\n---\n\n第三段';
    const blocks = splitParagraphBlocks(text);
    expect(blocks.map((b) => text.slice(b.start, b.end))).toEqual(['第一段', '第二段', '第三段']);
  });

  it('stripChapterMarkerLines：剥标记 + 组合空行，重建 = 原文（composeDerivedText 的逆）', () => {
    const derived = '<!-- mat-chapter index=0 method=regex -->\n\nH0\n\nB0\n\n<!-- mat-chapter index=1 method=regex -->\n\nH1\n\nB1';
    expect(stripChapterMarkerLines(derived)).toBe('H0\n\nB0\n\nH1\n\nB1');
    // 用户手写标记无空行纪律：只删标记行。
    expect(stripChapterMarkerLines('H0\n<!-- mat-chapter index=0 method=manual -->\nH1')).toBe('H0\nH1');
  });
});

describe('LLM 兜底纯函数（约束式）', () => {
  it('buildChapterFallbackPrompt：候选行号+文本+±1 上下文 + 约束指令', () => {
    const candidates = extractHeadingCandidates('卷首语\n\n可能的转折\n\n正文正文正文正文。');
    const prompt = buildChapterFallbackPrompt(candidates, '卷首语\n\n可能的转折\n\n正文正文正文正文。'.split('\n'));
    expect(prompt).toContain('<候选行>');
    expect(prompt).toContain('可能的转折');
    expect(prompt).toContain('卷首语'); // 上一行上下文
    expect(prompt).toContain('{"selected":[]}');
  });

  it('parseChapterFallbackResponse：合法子集去重升序；越界/非整数/非数组整体拒收', () => {
    const candidates = new Set([2, 5, 9]);
    expect(parseChapterFallbackResponse('{"selected":[9,2,2]}', candidates)).toEqual([2, 9]);
    expect(parseChapterFallbackResponse('```json\n{"selected":[5]}\n```', candidates)).toEqual([5]);
    expect(parseChapterFallbackResponse('{"selected":[]}', candidates)).toEqual([]); // 诚实负判合法
    expect(parseChapterFallbackResponse('{"selected":[7]}', candidates)).toBeNull(); // 越界 → 整体拒收
    expect(parseChapterFallbackResponse('{"selected":["2"]}', candidates)).toBeNull(); // 非整数
    expect(parseChapterFallbackResponse('{"picked":[2]}', candidates)).toBeNull(); // 非法结构
    expect(parseChapterFallbackResponse('不是 JSON', candidates)).toBeNull();
  });

  it('MATERIAL_LLM_FALLBACK_SYSTEM_PROMPT：约束文案钉「只能从候选行号中选择」', () => {
    expect(MATERIAL_LLM_FALLBACK_SYSTEM_PROMPT).toContain('只能从候选行号中选择');
  });
});

// ── 摄取主线（regex high）──

describe('ingestMaterial — 正则高置信主线', () => {
  it('happy path：登记可 parse 的 Material + 派生 .md 落盘（标记带 method/confidence）+ onRegistered', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const onRegistered = vi.fn(async (_material: Material) => {});
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), onRegistered, now: () => new Date('2026-09-02T10:00:00Z') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('fresh');
    expect(result.derivedRelPath).toBe('.derived/novel.md');
    expect(() => materialSchema.parse(result.material)).not.toThrow(); // Wave A 集成钉形状
    expect(result.material.materialId).toMatch(/^mat-[0-9a-f]{12}$/);
    expect(result.material.provenance.sourcePath).toBe('materials/novel.txt');
    expect(result.material.provenance.via).toBe('direct-read');
    expect(result.material.provenance.ingestedAt).toBe('2026-09-02T10:00:00.000Z');
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'regex', confidence: 'high' });
    expect(result.material.status).toBe('ready');
    expect(result.material.chapters.length).toBe(4);
    expect(onRegistered).toHaveBeenCalledTimes(1);
    expect(onRegistered.mock.calls[0][0].materialId).toBe(result.material.materialId);
    // 派生文件存在 + 标记往返（method/confidence 保留，F-03）。
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    const markers = parseChapterMarkers(derived);
    expect(markers.length).toBe(4);
    expect(markers.every((m) => m.method === 'regex' && m.confidence === 'high')).toBe(true);
    expect(markers[0].title).toBe('风起之0');
  });

  it('span 装配不变量（Wave A 裁决）：章切片原文逐字 + chunk 局部段号 ⊆ 章段区间 + 重建=原文', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { material } = result;
    const derived = readFileSync(derivedAbs(rel), 'utf-8');

    for (const ch of material.chapters) {
      const slice = derived.slice(ch.charStart, ch.charEnd);
      expect(slice.trim().length).toBeGreaterThan(0);
      const chunks = MATERIAL_CHUNK_STRATEGIES.prose(slice); // Wave C 索引器同款调用形态
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.text).toBe(slice.slice(c.charStart, c.charEnd)); // chunkChapter 输出保证
        expect(ch.paraStart + c.paraStart).toBeGreaterThanOrEqual(ch.paraStart);
        expect(ch.paraStart + c.paraEnd).toBeLessThanOrEqual(ch.paraEnd); // 局部段号不越章界
      }
      expect(ch.paraStart).toBeLessThan(ch.paraEnd);
    }
    // 章区间按序不重叠内容（标记行不属于任何章 span）。
    for (let i = 1; i < material.chapters.length; i++) {
      expect(material.chapters[i].charStart).toBeGreaterThanOrEqual(material.chapters[i - 1].charEnd);
    }
    // 剥标记重建 = 归一化原文（幂等判定底座）。
    expect(stripChapterMarkerLines(derived)).toBe(normalizeMaterialText(chapteredNovel()));
    expect(material.quality.charCount).toBe(normalizeMaterialText(chapteredNovel()).length);
  });

  it('全局车道：sourcePath 无 materials/ 前缀 + projectId=null + id 与项目车道不同', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const result = await ingestMaterial(
      scope({ scope: 'global', projectId: null }),
      rel,
      realParseDeps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.provenance.sourcePath).toBe('novel.txt');
    expect(result.material.projectId).toBeNull();
    expect(result.material.scope).toBe('global');
  });

  it('CRLF 原件归一化后摄取（span 基面 = LF 文本）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel().replace(/\n/g, '\r\n'));
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(derived).not.toContain('\r');
    expect(stripChapterMarkerLines(derived)).toBe(normalizeMaterialText(chapteredNovel()));
  });
});

// ── 分章分流（D2 两段式）──

describe('ingestMaterial — 分章分流', () => {
  it('低置信 <2 万字：伪章直进（method=none 单章，不烧 LLM——F-09/F-25）', async () => {
    const lecture = '这是一份没有任何章标的讲义正文。'.repeat(20); // ~460 字 < 2 万，零命中
    expect(splitChapters(lecture).matchedFormats).toEqual([]);
    const rel = writeSource('lecture.txt', lecture);
    const generateText = vi.fn<MaterialGenerateText>();
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'none', confidence: 'low' });
    expect(result.material.chapters).toHaveLength(1);
    expect(result.material.chapters[0]).toMatchObject({ index: 0, title: null, method: 'none' });
    expect(result.material.status).toBe('ready');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('短篇正则命中 ≥1（序章+第一章，命中 2<3 判 low）：保留 regex 章界不伪灭（CR-002）', async () => {
    const text = ['序章', `${'墨'.repeat(120)}。`, '第一章 风起', `${'雨'.repeat(120)}。`].join('\n\n');
    const split = splitChapters(text);
    expect(split.confidence).toBe('low'); // 命中 <3 → low（但章界真实）
    expect(split.matchedFormats.length).toBeGreaterThan(0);
    const rel = writeSource('short.txt', text);
    const generateText = vi.fn<MaterialGenerateText>();
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generateText).not.toHaveBeenCalled(); // <2 万字不烧 LLM
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'regex', confidence: 'low' });
    expect(result.material.chapters).toHaveLength(2); // 真实章界未被伪章吞掉
    expect(result.material.chapters[0].title).toBeNull(); // 裸「序章」无标题尾
    expect(result.material.chapters[1].title).toBe('风起');
    expect(result.material.chapters.every((c) => c.method === 'regex' && c.confidence === 'low')).toBe(true); // 诚实标注不拔高
    expect(result.material.quality.parseNotes.join('\n')).toContain('低置信');
    // 派生标记带 confidence=low（章界可寻址，10.3 消费形态不缺位）。
    const markers = parseChapterMarkers(readFileSync(derivedAbs(rel), 'utf-8'));
    expect(markers).toHaveLength(2);
    expect(markers.every((m) => m.method === 'regex' && m.confidence === 'low')).toBe(true);
  });

  it('LLM 兜底四路 — ①成功选择：切点=候选行、method=llm-fallback、confidence=low、status=ready', async () => {
    const text = lowConfidenceLongText(90); // ~22.5K 字 ≥ 2 万，弱候选 90 条 ≤ 300
    expect(text.length).toBeGreaterThanOrEqual(MATERIAL_LLM_FALLBACK_MIN_CHARS);
    expect(splitChapters(text).confidence).toBe('low');
    const candidates = extractHeadingCandidates(text);
    expect(candidates.length).toBe(90);
    const selected = [candidates[10].lineIndex, candidates[40].lineIndex, candidates[70].lineIndex];
    const generateText = vi.fn<MaterialGenerateText>(async () => ({
      text: JSON.stringify({ selected }),
    }));
    const rel = writeSource('novel.txt', text);
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0][0];
    expect(call.system).toBe(MATERIAL_LLM_FALLBACK_SYSTEM_PROMPT);
    expect(call.user).toContain(`${candidates[0].lineIndex} | ${candidates[0].text}`);
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'llm-fallback', confidence: 'low' });
    expect(result.material.quality.chapterDetection.llmCapped).toBeUndefined();
    expect(result.material.status).toBe('ready');
    // 前导段 + 3 个选中切点 → 4 章；选中章 title = 候选行文本。
    expect(result.material.chapters).toHaveLength(4);
    expect(result.material.chapters[0].title).toBeNull();
    expect(result.material.chapters[1].title).toBe(candidates[10].text);
    expect(result.material.chapters.every((c) => c.method === 'llm-fallback')).toBe(true);
    // 派生标记 method=llm-fallback（AC2 诚实标注）。
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(parseChapterMarkers(derived).every((m) => m.method === 'llm-fallback')).toBe(true);
  });

  it('LLM 兜底四路 — ②失败回退：挂起低置信态（chapters 空、不硬给、never-throws）', async () => {
    const rel = writeSource('novel.txt', lowConfidenceLongText(90));
    const generateText = vi.fn<MaterialGenerateText>(async () => {
      throw new Error('端点超时');
    });
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.chapters).toEqual([]);
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'llm-fallback', confidence: 'low' });
    expect(result.material.quality.parseNotes.join('\n')).toContain('LLM 兜底调用失败');
    // 挂起 = 裸文本落盘（无标记——重摄取可自愈重试）。
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(parseChapterMarkers(derived)).toEqual([]);
    expect(stripChapterMarkerLines(derived)).toBe(derived);
  });

  it('LLM 兜底四路 — ③非法切点：候选集外行号整体拒收回退挂起（约束式，不可幻位置）', async () => {
    const rel = writeSource('novel.txt', lowConfidenceLongText(90));
    const generateText = vi.fn<MaterialGenerateText>(async () => ({
      text: JSON.stringify({ selected: [0, 99_999] }), // 99999 不在候选集
    }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.chapters).toEqual([]);
    expect(result.material.quality.parseNotes.join('\n')).toContain('整体拒收');
  });

  it('LLM 兜底四路 — ④候选超预算 300：llmCapped=true 挂起，不调 LLM（不静默截断，F-07）', async () => {
    const text = lowConfidenceLongText(320, 60); // 320 候选 > 300；~21K 字 ≥ 2 万
    expect(text.length).toBeGreaterThanOrEqual(MATERIAL_LLM_FALLBACK_MIN_CHARS);
    expect(extractHeadingCandidates(text).length).toBeGreaterThan(MATERIAL_LLM_CANDIDATE_BUDGET);
    const rel = writeSource('novel.txt', text);
    const generateText = vi.fn<MaterialGenerateText>(async () => ({ text: '{"selected":[2]}' }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generateText).not.toHaveBeenCalled(); // 超限直接挂起——截断即假信心
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.quality.chapterDetection.llmCapped).toBe(true);
    expect(result.material.quality.parseNotes.join('\n')).toContain('超过预算');
  });

  it('LLM 内核未装配（deps 与 install 均缺）：挂起 + 诚实 note（never-throws）', async () => {
    const rel = writeSource('novel.txt', lowConfidenceLongText(90));
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.quality.parseNotes.join('\n')).toContain('未装配');
  });

  it('installMaterialLLMCore 装配内核兜底路（deps.generateText 缺省回落 core——接线缝形态）', async () => {
    installMaterialLLMCore({
      generateText: async () => ({ text: '{"selected":[]}' }), // 诚实负判 → 挂起
    });
    const rel = writeSource('novel.txt', lowConfidenceLongText(90));
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.status).toBe('low-confidence');
    expect(result.material.quality.parseNotes.join('\n')).toContain('均非可靠章界');
  });
});

// ── 幂等（F-03）──

describe('ingestMaterial — 幂等与人工校对闭环', () => {
  it('原件未变（自动标记）：沿用存档章界（outcome=reused）+ 不重写派生件', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok && first.outcome).toBe('fresh');

    // 派生 mtime 钉到过去——重摄取若重写会推进 mtime。
    const past = new Date(Date.now() - 60_000);
    utimesSync(derivedAbs(rel), past, past);

    const second = await ingestMaterial(scope(), rel, realParseDeps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reused');
    expect(second.material.chapters).toEqual(first.ok ? first.material.chapters : []);
    expect(second.material.quality.chapterDetection.method).toBe('regex');
    // mtime 未推进 = 未重写（hash-skip 落在管线内，watcher 无自写噪声〔F-12〕）。
    expect(statSync(derivedAbs(rel)).mtimeMs).toBeLessThan(Date.now() - 30_000);
  });

  it('人工标记（method=manual）+ 原件未变：保留不重分章（manual 最高优先）+ 只改标题也生效（AC4）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok).toBe(true);

    // 用户校对：标记翻 manual（去 confidence 属性 = 手写形态）+ 改第二章标题。
    const derivedPath = derivedAbs(rel);
    const edited = readFileSync(derivedPath, 'utf-8')
      .replace(/method=regex confidence=high/g, 'method=manual')
      .replace('title="风起之1"', 'title="亲手改的标题"');
    writeFileSync(derivedPath, edited);

    const second = await ingestMaterial(scope(), rel, realParseDeps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reused');
    expect(second.material.quality.chapterDetection).toMatchObject({ method: 'manual', confidence: 'manual' });
    expect(second.material.chapters).toHaveLength(4);
    expect(second.material.chapters.every((c) => c.method === 'manual' && c.confidence === 'manual')).toBe(true);
    expect(second.material.chapters[1].title).toBe('亲手改的标题'); // F-14 供给面：标题进章界
    // 未重分章 = 派生件未被覆盖（manual 标记仍在）。
    expect(readFileSync(derivedPath, 'utf-8')).toBe(edited);
  });

  it('原件内容变更（自动标记）：重跑自动路径（outcome=reingested）+ 变更 note', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    await ingestMaterial(scope(), rel, realParseDeps());
    writeSource(rel, chapteredNovel(5)); // 4 章 → 5 章
    const second = await ingestMaterial(scope(), rel, realParseDeps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingested');
    expect(second.material.chapters).toHaveLength(5);
    expect(second.material.quality.parseNotes.join('\n')).toContain('重新自动分章');
  });

  it('人工标记 + 原件内容变更：人工标记丢失回自动分章（已知限制，note 诚实回报）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    await ingestMaterial(scope(), rel, realParseDeps());
    const derivedPath = derivedAbs(rel);
    writeFileSync(derivedPath, readFileSync(derivedPath, 'utf-8').replace(/method=regex/g, 'method=manual'));
    writeSource(rel, chapteredNovel(5));
    const second = await ingestMaterial(scope(), rel, realParseDeps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingested');
    expect(second.material.quality.chapterDetection.method).toBe('regex');
    expect(second.material.chapters).toHaveLength(5);
    expect(second.material.quality.parseNotes.join('\n')).toContain('人工章标记不再保留');
  });

  it('人工编辑派生正文 + 原件未变（登记 hash 一致）：不覆写派生、保留人工内容 + note（CR-001）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 登记缝回报首登 content hash——原件身份未变。
    const getRegisteredContentHash = vi.fn(async () => first.material.contentHash);

    // 用户直接编辑派生**正文**（非仅标记）：追加一段人工补记。
    const derivedPath = derivedAbs(rel);
    const edited = `${readFileSync(derivedPath, 'utf-8')}\n\n人工补记：本章伏笔在第三章回收。`;
    writeFileSync(derivedPath, edited);

    const second = await ingestMaterial(scope(), rel, { ...realParseDeps(), getRegisteredContentHash });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingest-skipped-manual');
    expect(second.material.quality.parseNotes.join('\n')).toContain('人工编辑');
    expect(second.material.quality.parseNotes.join('\n')).toContain('未覆写');
    expect(second.material.chapters).toHaveLength(4); // 标记存档章界保留（末章 span 含补记段）
    expect(readFileSync(derivedPath, 'utf-8')).toBe(edited); // 派生未被覆写——人工补记仍在
    expect(getRegisteredContentHash).toHaveBeenCalledTimes(1);
  });

  it('C2 防清 belt：markers=0（章标记被剥）+ 登记行有章 → 保留既有章界 + note（不落 0 章中间行）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // R10 剥离形态：派生 .md 标记全失 + 一处人工正文改动（内容变更 → CR-001 人工保留路径；
    // markers=0 → 标记重建零章——旧形态此处装配 0 章 ready 行 = F1「0 章|章界待校对」假态）。
    const derivedPath = derivedAbs(rel);
    const stripped = `${stripChapterMarkerLines(readFileSync(derivedPath, 'utf-8'))}\n\n人工补记：本章伏笔在第三章回收。`;
    writeFileSync(derivedPath, stripped, 'utf-8');

    const getRegisteredContentHash = vi.fn(async () => first.material.contentHash);
    const getRegisteredMaterial = vi.fn(() => first.material);
    const second = await ingestMaterial(scope(), rel, {
      ...realParseDeps(),
      getRegisteredContentHash,
      getRegisteredMaterial,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingest-skipped-manual');
    // 🔑 既有章界 + 分章结论整体保留（非 0 章中间行；chapters/chapterDetection 同源，守 F-18）。
    expect(second.material.chapters).toEqual(first.material.chapters);
    expect(second.material.quality.chapterDetection).toEqual(first.material.quality.chapterDetection);
    expect(second.material.status).toBe('ready');
    const notes = second.material.quality.parseNotes.join('\n');
    expect(notes).toContain('章标记缺失'); // 诚实标注保留行为（待重索引收敛）
    expect(notes).toContain('人工编辑'); // CR-001 note 照常
    expect(readFileSync(derivedPath, 'utf-8')).toBe(stripped); // 派生人工内容不覆写
    expect(getRegisteredMaterial).toHaveBeenCalledTimes(1);
  });

  it('C2 belt 边界：缝未装配 / 既有行零章（首登挂起）→ 诚实零章现状保持（belt 无可保留不硬给）', async () => {
    // ① 缝未装配（belt 退化——诚实零章，不因缺缝炸/不硬造）。
    const rel = writeSource('novel.txt', chapteredNovel());
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const derivedPath = derivedAbs(rel);
    const stripped = `${stripChapterMarkerLines(readFileSync(derivedPath, 'utf-8'))}\n\n人工补记。`;
    writeFileSync(derivedPath, stripped, 'utf-8');
    const noSeam = await ingestMaterial(scope(), rel, {
      ...realParseDeps(),
      getRegisteredContentHash: async () => first.material.contentHash,
    });
    expect(noSeam.ok).toBe(true);
    if (!noSeam.ok) return;
    expect(noSeam.outcome).toBe('reingest-skipped-manual');
    expect(noSeam.material.chapters).toEqual([]); // 诚实零章（现状保持）
    expect(noSeam.material.quality.parseNotes.join('\n')).not.toContain('章标记缺失');

    // ② 缝装配但既有行零章（llm-fallback 挂起材料——派生本就无标记）：belt 无可保留。
    const rel2 = writeSource('low.txt', lowConfidenceLongText(90));
    const firstLow = await ingestMaterial(scope(), rel2, realParseDeps());
    expect(firstLow.ok).toBe(true);
    if (!firstLow.ok) return;
    expect(firstLow.material.chapters).toEqual([]); // 挂起零章
    const derived2 = derivedAbs(rel2);
    const edited2 = `${readFileSync(derived2, 'utf-8')}\n\n人工补记。`;
    writeFileSync(derived2, edited2, 'utf-8');
    const secondLow = await ingestMaterial(scope(), rel2, {
      ...realParseDeps(),
      getRegisteredContentHash: async () => firstLow.material.contentHash,
      getRegisteredMaterial: () => firstLow.material, // 零章行 → 缝侧判空 → belt 不触发
    });
    expect(secondLow.ok).toBe(true);
    if (!secondLow.ok) return;
    expect(secondLow.material.chapters).toEqual([]); // 诚实零章（无可保留）
    expect(secondLow.material.quality.parseNotes.join('\n')).not.toContain('章标记缺失');
  });

  it('登记 hash 与本次解析不一致（原件真变了）：CR-001 缝不拦——走既有自动路径（reingested）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    await ingestMaterial(scope(), rel, realParseDeps());
    writeSource(rel, chapteredNovel(5)); // 原件 4 章 → 5 章（hash 必变）
    const getRegisteredContentHash = vi.fn(
      async () => 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );
    const second = await ingestMaterial(scope(), rel, { ...realParseDeps(), getRegisteredContentHash });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingested');
    expect(second.material.chapters).toHaveLength(5);
    expect(second.material.quality.chapterDetection.method).toBe('regex');
  });

  it('外部编辑器 CRLF 重存派生 .md：读取归一后判定 reused，manual 标记不丢（CR-017）', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    await ingestMaterial(scope(), rel, realParseDeps());
    const derivedPath = derivedAbs(rel);
    const edited = readFileSync(derivedPath, 'utf-8')
      .replace(/method=regex confidence=high/g, 'method=manual')
      .replace(/\n/g, '\r\n'); // 外部编辑器整档 CRLF 重存（正文一字未动）
    writeFileSync(derivedPath, edited);

    const second = await ingestMaterial(scope(), rel, realParseDeps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reused'); // 行尾差异 ≠ 内容变更
    expect(second.material.quality.chapterDetection).toMatchObject({ method: 'manual', confidence: 'manual' });
    expect(second.material.chapters).toHaveLength(4);
    expect(readFileSync(derivedPath, 'utf-8')).toBe(edited); // 未被重写（CRLF 形态原样保留）
  });
});

// ── epub e2e（真 jszip + 真 parse 内核）──

describe('ingestMaterial — epub 端到端', () => {
  const epubChapter = (heading: string) => `<h1>${heading}</h1><p>${'墨'.repeat(90)}。</p><p>${'雨'.repeat(90)}。</p>`;

  it('好档 epub：format=epub、via=builtin-epub、正文正则分章 + 章可寻址', async () => {
    const rel = writeSource(
      'book.epub',
      buildEpubFixture({
        documents: [
          { href: 'c1.xhtml', body: epubChapter('第一章 风起') },
          { href: 'c2.xhtml', body: epubChapter('第二章 云涌') },
          { href: 'c3.xhtml', body: epubChapter('第三章 潮生') },
        ],
      }),
    );
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => materialSchema.parse(result.material)).not.toThrow();
    expect(result.material.format).toBe('epub');
    expect(result.material.provenance.via).toBe('builtin-epub');
    expect(result.material.quality.chapterDetection.method).toBe('regex');
    expect(result.material.chapters.length).toBe(3);
    expect(result.material.chapters[0].title).toBe('风起');
    // 章可寻址：切片含章题与正文。
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    for (const ch of result.material.chapters) {
      expect(derived.slice(ch.charStart, ch.charEnd)).toContain('墨');
    }
  }, 30_000);

  it('扫描图 epub：诚实降级登记（scanned=true / ok=false / note），不冒充成功也不拒收（AC8）', async () => {
    const rel = writeSource(
      'manga.epub',
      buildEpubFixture({
        documents: [
          { href: 'p1.xhtml', body: '<p>图</p><img src="a.png"/>' },
          { href: 'p2.xhtml', body: '<p>注</p><img src="b.png"/>' },
        ],
      }),
    );
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.quality.scanned).toBe(true);
    expect(result.material.quality.ok).toBe(false);
    expect(result.material.quality.parseNotes.join('\n')).toContain('扫描图');
  }, 30_000);

  it('坏档 epub：结构化 parse-failed（不冒充成功）', async () => {
    const rel = writeSource('bad.epub', Buffer.from('not a zip'));
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('parse-failed');
    expect(result.error).toContain('EPUB 解析失败');
    expect(existsSync(derivedAbs(rel))).toBe(false);
  }, 30_000);
});

// ── docx/pdf 材料线全链（CR-032——解析层 fixture 既有，材料层 e2e 补面）──

describe('ingestMaterial — docx/pdf 材料线全链', () => {
  it('docx：真 mammoth 解析 → 正则分章 → 派生 .md → 登记 Material 全链', async () => {
    // fixture 一行一段（mammoth 段落间空行往返）；3 章 ≥3 命中 + 覆盖 + 均匀 → regex high。
    const paragraphs = chapteredNovel(3).split('\n').filter((line) => line !== '');
    const rel = writeSource('guide.docx', buildDocxFixture(paragraphs.join('\n')));
    const result = await ingestMaterial(scope(), rel, realParseDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => materialSchema.parse(result.material)).not.toThrow();
    expect(result.material.format).toBe('docx');
    expect(result.material.provenance.via).toBe('builtin-mammoth');
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'regex', confidence: 'high' });
    expect(result.material.chapters).toHaveLength(3);
    expect(result.material.chapters[1].title).toBe('风起之1');
    // 派生 .md 落盘 + 章切片含章题与正文（章可寻址，10.3 消费形态）。
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(parseChapterMarkers(derived)).toHaveLength(3);
    expect(derived.slice(result.material.chapters[0].charStart, result.material.chapters[0].charEnd)).toContain('墨');
  }, 30_000);

  it('pdf：真 pdfjs 文本层 → 正则分章（Chapter N 拉丁族）→ 派生 .md → 登记 Material 全链', async () => {
    // fixture 文本层仅 ASCII（WinAnsi——无 CID 字体装不了 CJK，见 documentFixtures 注记）；
    // Chapter N 格式族覆盖拉丁章标。每页正文 ≥50 非空白字符防整档误判 scanned。
    const body = 'A'.repeat(200);
    const rel = writeSource(
      'paper.pdf',
      buildPdfFixture(['Chapter 1 Begin', body, 'Chapter 2 Rise', body, 'Chapter 3 End', body]),
    );
    const result = await ingestMaterial(scope(), rel, realParseDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => materialSchema.parse(result.material)).not.toThrow();
    expect(result.material.format).toBe('pdf');
    expect(result.material.provenance.via).toBe('builtin-pdfjs');
    expect(result.material.quality.chapterDetection).toMatchObject({ method: 'regex', confidence: 'high' });
    expect(result.material.chapters).toHaveLength(3);
    expect(result.material.chapters.map((c) => c.title)).toEqual(['Begin', 'Rise', 'End']);
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(parseChapterMarkers(derived)).toHaveLength(3);
    expect(derived.slice(result.material.chapters[0].charStart, result.material.chapters[0].charEnd)).toContain('Begin');
  }, 30_000);
});

// ── 拒收与失败路径（三档拒收语义）──

describe('ingestMaterial — 拒收与失败路径', () => {
  it('不支持格式（.rtf）→ unsupported-format 拒收（三档之一）', async () => {
    const rel = writeSource('doc.rtf', 'rtf-body');
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-format');
    expect(result.rejection).toBe('unsupported-format');
    expect(result.error).toContain('TXT / MD / DOCX / PDF / EPUB / SRT / ASS / VTT');
  });

  it('.derived 自派生面与逃逸路径 → invalid-path', async () => {
    for (const bad of ['.derived/foo.md', '../evil.txt']) {
      const result = await ingestMaterial(scope(), bad, realParseDeps());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-path');
    }
  });

  it('文件不存在 → missing；空文件 → empty', async () => {
    const missing = await ingestMaterial(scope(), 'nope.txt', realParseDeps());
    expect(!missing.ok && missing.reason).toBe('missing');
    writeSource('empty.txt', '');
    const empty = await ingestMaterial(scope(), 'empty.txt', realParseDeps());
    expect(!empty.ok && empty.reason).toBe('empty');
  });

  it('超 50MB 单件 → too-large 拒收（三档之二；stat 门在解析前）', async () => {
    const rel = writeSource('huge.txt', Buffer.alloc(MATERIAL_MAX_FILE_BYTES + 1, 0x61));
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-large');
    expect(result.rejection).toBe('too-large');
  }, 30_000);

  it('onRegistered 抛错：warn 不阻断（登记层 DERIVED 自愈），ok 照常返回', async () => {
    const rel = writeSource('novel.txt', chapteredNovel());
    const onRegistered = vi.fn(async () => {
      throw new Error('db busy');
    });
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), onRegistered });
    expect(result.ok).toBe(true);
    expect(onRegistered).toHaveBeenCalledTimes(1);
  });
});

// ── 字幕摄取（E10.2a：三格式解析 + 书面化整理 + 幂等——design §2.3/2.4）──

/** srt 时间码（ms → HH:MM:SS,mmm）。 */
function srtTime(totalMs: number): string {
  const h = String(Math.floor(totalMs / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor((totalMs % 3_600_000) / 60_000)).padStart(2, '0');
  const s = String(Math.floor((totalMs % 60_000) / 1000)).padStart(2, '0');
  const f = String(totalMs % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${f}`;
}

/** 生成 srt：每段文本拆两 cue（段内间隔 100ms 紧邻成段），段间停顿 3s（>1500ms 停顿分段阈）。 */
function buildSrt(paragraphTexts: readonly string[]): string {
  const blocks: string[] = [];
  let t = 0;
  paragraphTexts.forEach((text, pIdx) => {
    const half = Math.ceil(text.length / 2);
    [text.slice(0, half), text.slice(half)].forEach((part, cIdx) => {
      const start = t;
      const end = start + 2000;
      blocks.push(`${pIdx * 2 + cIdx + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${part}\n`);
      t = end + (cIdx === 0 ? 100 : 3000); // 段内紧邻 / 段间停顿
    });
  });
  return blocks.join('\n');
}

/**
 * 密集 cue srt（CR-1 fixture 用）：全部 cue 间隔 gapMs ≪ 1500ms 停顿分段阈——join 塌成单段，
 * 复刻 B 站自动字幕形态（30-60min 视频 → 数万字单段，整理档输出上限数学上不可达的根因）。
 */
function buildDenseSrt(cueTexts: readonly string[], gapMs = 100): string {
  const blocks: string[] = [];
  let t = 0;
  cueTexts.forEach((text, i) => {
    const start = t;
    const end = start + 2000;
    blocks.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`);
    t = end + gapMs;
  });
  return blocks.join('\n');
}

/** sha256 内容指纹（contentHash 断言用——与 shell 侧 sha256Content 同式）。 */
function shaOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/** BOM + CRLF 噪声 srt（两段——段间停顿 3s；AC1 噪声容忍）。 */
const SRT_FIXTURE = `\uFEFF${[
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '大家好 今天给大家分享',
  '',
  '2',
  '00:00:06,000 --> 00:00:08,000',
  '一个很实用的写作方法',
  '',
  '',
].join('\r\n')}`;

/** vtt（WEBVTT 头 + NOTE 块 + cue settings + 内联标签——两段）。 */
const VTT_FIXTURE = [
  'WEBVTT',
  '',
  'NOTE 这是一段注释块',
  '',
  '00:01.000 --> 00:03.000 line:90% align:start',
  '<v 张三>大家好</v> <c.yellow>今天</c>讲 vtt',
  '',
  '00:06.000 --> 00:08.000',
  '内联标签剥离后的正文',
  '',
].join('\n');

/** ass（Script Info/V4+ Styles 忽略 + override 块/\\N/\\h 控制符——两段）。 */
const ASS_FIXTURE = [
  '[Script Info]',
  'Title: demo',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour',
  'Style: Default,Arial,20,&H00FFFFFF',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}大家好{\\i0}今天的\\N写作方法',
  'Dialogue: 0,0:00:06.00,0:00:08.00,Default,,0,0,0,,剥掉 override 块与\\h硬空格',
  '',
].join('\n');

describe('ingestMaterial — 字幕摄取（E10.2a）', () => {
  it('boxPolishSegments：段落边界装箱（不跨段拆分；单段超预算自成一箱不截断）', () => {
    const p = (text: string): SubtitleParagraph => ({ text, startMs: 0, endMs: 0 });
    expect(boxPolishSegments([p('a'), p('b'), p('c')], 4)).toEqual(['a\n\nb', 'c']);
    expect(boxPolishSegments([p('x'.repeat(20))], 4)).toEqual(['x'.repeat(20)]);
    expect(boxPolishSegments([], 4)).toEqual([]);
    expect(boxPolishSegments([p('a'), p('b')], SEGMENT_CHAR_BUDGET)).toEqual(['a\n\nb']); // 默认预算
    expect(SUBTITLE_POLISH_SYSTEM_PROMPT).toContain('不引入原文没有的主张'); // 保义红线进 prompt
    expect(SUBTITLE_POLISH_SYSTEM_PROMPT).toContain('双语混排'); // F-19 双语规则进 prompt
  });

  it('boxPolishSegments 超预算单段二次切分（CR-1）：句末标点预算边界就近切、无损重组、无标点极端流保持整段', () => {
    const p = (text: string): SubtitleParagraph => ({ text, startMs: 0, endMs: 0 });
    const punctuated = '甲乙丙丁。'.repeat(3001); // 15005 字 → 6000/6000/3005 三片
    const pieces = boxPolishSegments([p(punctuated)], SEGMENT_CHAR_BUDGET);
    expect(pieces).toHaveLength(3);
    expect(pieces.join('')).toBe(punctuated); // 切分无损（不硬截丢字）
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(SEGMENT_CHAR_BUDGET);
    for (const piece of pieces.slice(0, -1)) expect(piece.endsWith('。')).toBe(true); // 切点落在句末
    // 无句末标点的极端流：不硬截语义——保持整段自成一箱（由截断判定降级 + note 诚实回报）。
    const extreme = 'x'.repeat(SEGMENT_CHAR_BUDGET + 1000);
    expect(boxPolishSegments([p(extreme)], SEGMENT_CHAR_BUDGET)).toEqual([extreme]);
  });

  it('三格式端到端（未装配 LLM → 降级）：时间码/样式/控制符全剥离 + 停顿分段生效 + provenance 默认（AC1/AC3）', async () => {
    const cases = [
      { rel: 'a.srt', fixture: SRT_FIXTURE, format: 'srt', joined: '大家好 今天给大家分享\n\n一个很实用的写作方法' },
      { rel: 'b.vtt', fixture: VTT_FIXTURE, format: 'vtt', joined: '大家好 今天讲 vtt\n\n内联标签剥离后的正文' },
      { rel: 'c.ass', fixture: ASS_FIXTURE, format: 'ass', joined: '大家好今天的\n写作方法\n\n剥掉 override 块与 硬空格' },
    ];
    for (const { rel, fixture, format, joined } of cases) {
      writeSource(rel, fixture);
      const result = await ingestMaterial(scope(), rel, realParseDeps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(() => materialSchema.parse(result.material)).not.toThrow();
      expect(result.material.format).toBe(format);
      expect(result.material.provenance.medium).toBe('video');
      expect(result.material.provenance.via).toBe('builtin-subtitle');
      expect(result.material.provenance.extractor).toBe('builtin-text');
      expect(result.material.provenance.tier).toBe('unspecified');
      // 时间码/样式标签/换行控制符全剥离；停顿分段生效（段间空行）；原件字节未动。
      // （噪声检查在剥标记正文上做——mat-chapter 标记本身的 `-->` 是注释闭合非时间码。）
      const derived = readFileSync(derivedAbs(rel), 'utf-8');
      const stripped = stripChapterMarkerLines(derived);
      expect(stripped).toBe(joined);
      for (const noise of ['-->', '{\\i', '\\N', '\\h', '<v', 'WEBVTT', 'NOTE', 'Dialogue', 'Format:']) {
        expect(stripped).not.toContain(noise);
      }
      // 降级诚实标注（未装配 → 纯拼合 + note），材料照常 ready、检索不断线。
      expect(result.material.quality.parseNotes.join('\n')).toContain('字幕未经书面化整理');
      expect(result.material.quality.parseNotes.join('\n')).toContain('LLM 整理内核未装配');
      expect(result.material.status).toBe('ready');
      expect(result.material.chapters).toHaveLength(1); // 无章标短文本 → 伪章直进（既有行为）
      // CR-19：原件保留断言——摄取只读源文件（原字幕 = 原件不动），摄取后读回字节与写入前一致（AC2）。
      expect(readFileSync(path.join(materialsRoot, rel), 'utf-8')).toBe(fixture);
    }
  });

  it('成功整理（两段串接）：分段串行调用 + seam 预算参数 + 整理稿替换基面 + 成功 note + 拼合身份 hash（AC2/AC4 锚定基面）', async () => {
    const para1 = `第一段主题${'甲'.repeat(3300)}`;
    const para2 = `第二段主题${'乙'.repeat(3300)}`;
    const rel = writeSource('talk.srt', buildSrt([para1, para2]));
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({
      text: input.user.startsWith('第一段') ? `【整理一】${input.user}` : `【整理二】${input.user}`,
    }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generateText).toHaveBeenCalledTimes(2); // 两段各一次（总字数 <2 万无分章兜底）
    const first = generateText.mock.calls[0][0];
    expect(first.system).toBe(SUBTITLE_POLISH_SYSTEM_PROMPT);
    expect(first.user).toBe(para1); // 分段 = 段落边界装箱（3305+3305 > 6000 → 各自成段）
    expect(first.maxTokens).toBe(POLISH_MAX_TOKENS); // F-02 独立预算经 generate seam 下传
    expect(generateText.mock.calls[1][0].user).toBe(para2);
    // 整理稿 = 段落串接（LLM 输出段落），派生 .md 锚定整理稿。
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(stripChapterMarkerLines(derived)).toBe(`【整理一】${para1}\n\n【整理二】${para2}`);
    expect(result.material.quality.parseNotes.join('\n')).toContain('字幕已书面化整理（2 段）');
    expect(result.material.quality.charCount).toBe(`【整理一】${para1}【整理二】${para2}`.length + 2);
    // contentHash = 确定性拼合身份（幂等门基面——非整理稿 hash）。
    expect(result.material.contentHash).toBe(shaOf(`${para1}\n\n${para2}`));
    expect(result.material.chapters).toHaveLength(1); // 整理后文本无章标 → 伪章（既有行为）
  });

  it('整理调用失败 → 整体降级纯拼合 + 诚实 note（never-throws，AC3）', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(400)}`]));
    const generateText = vi.fn<MaterialGenerateText>(async () => {
      throw new Error('端点超时');
    });
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.quality.parseNotes.join('\n')).toContain('字幕未经书面化整理');
    expect(result.material.quality.parseNotes.join('\n')).toContain('整理调用失败');
    expect(stripChapterMarkerLines(readFileSync(derivedAbs(rel), 'utf-8'))).toBe(`主题一${'甲'.repeat(400)}`);
    expect(result.material.status).toBe('ready'); // 降级不失败（检索照常）
  });

  it('分段超上限（>MAX_POLISH_SEGMENTS）→ 整体降级零整理调用（不静默截断）', async () => {
    const paragraphs = Array.from({ length: MAX_POLISH_SEGMENTS + 1 }, (_, i) => `第${i}主题${'甲'.repeat(4000)}`);
    const rel = writeSource('long.srt', buildSrt(paragraphs));
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({ text: input.user })); // 分章兜底若触发安全返回
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generateText.mock.calls.filter((c) => c[0].system === SUBTITLE_POLISH_SYSTEM_PROMPT)).toHaveLength(0);
    expect(result.material.quality.parseNotes.join('\n')).toContain('超过上限');
    expect(result.material.quality.parseNotes.join('\n')).toContain('字幕未经书面化整理');
    expect(stripChapterMarkerLines(readFileSync(derivedAbs(rel), 'utf-8'))).toBe(paragraphs.join('\n\n'));
  });

  it('截断防御：某段响应字数不足输入七成 → 整体降级（不落半截整理稿——保义红线）', async () => {
    const para1 = `第一段主题${'甲'.repeat(3300)}`;
    const para2 = `第二段主题${'乙'.repeat(3300)}`;
    const rel = writeSource('talk.srt', buildSrt([para1, para2]));
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({
      // 第二段返回过短响应（首段 passthrough 保长度）
      text: input.user.startsWith('第一段') ? input.user : '截断了',
    }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result.material.quality.parseNotes.join('\n')).toContain('疑似截断');
    // 整体降级：纯拼合（第一段的整理成果不保留）。
    expect(stripChapterMarkerLines(readFileSync(derivedAbs(rel), 'utf-8'))).toBe(`${para1}\n\n${para2}`);
    expect(result.material.quality.parseNotes.join('\n')).toContain('字幕未经书面化整理');
  });

  it('幂等：原件未变（登记 hash = 拼合身份）→ reused 不重整理 + 派生不重写（既有语义零破坏）', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(200)}`]));
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({ text: `【整理】${input.user}` }));
    const first = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(first.ok).toBe(true);
    const polishCalls = () => generateText.mock.calls.filter((c) => c[0].system === SUBTITLE_POLISH_SYSTEM_PROMPT);
    expect(polishCalls()).toHaveLength(1);

    // 派生 mtime 钉到过去——重摄取若重写会推进 mtime。
    const past = new Date(Date.now() - 60_000);
    utimesSync(derivedAbs(rel), past, past);
    const getRegisteredContentHash = vi.fn(async () => (first.ok ? first.material.contentHash : null));
    const second = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText, getRegisteredContentHash });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reused');
    expect(polishCalls()).toHaveLength(1); // 未重整理（整理稿非确定不重烧）
    expect(statSync(derivedAbs(rel)).mtimeMs).toBeLessThan(Date.now() - 30_000); // 未重写
    expect(readFileSync(derivedAbs(rel), 'utf-8')).toContain('【整理】'); // 旧整理稿保留
    expect(second.material.chapters).toEqual(first.ok ? first.material.chapters : []);
  });

  it('原件内容变更（登记 hash 失配）→ 重新解析整理（reingested）+ 变更 note + 重烧整理调用', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(200)}`]));
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({ text: `【整理】${input.user}` }));
    const first = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(first.ok).toBe(true);
    const firstHash = first.ok ? first.material.contentHash : null;

    writeSource(rel, buildSrt([`主题一改${'乙'.repeat(200)}`])); // 原件真变了
    const getRegisteredContentHash = vi.fn(async () => firstHash);
    const second = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText, getRegisteredContentHash });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingested');
    expect(second.material.quality.parseNotes.join('\n')).toContain('原件内容已变更');
    expect(generateText.mock.calls.filter((c) => c[0].system === SUBTITLE_POLISH_SYSTEM_PROMPT)).toHaveLength(2);
    expect(second.material.contentHash).not.toBe(firstHash);
    expect(readFileSync(derivedAbs(rel), 'utf-8')).toContain('主题一改'); // 新内容已整理落盘
  });

  it('坏结构字幕（AC7）：纯时间码/非字幕内容 → durable parse-failed；空文件 → empty（不崩不静默）', async () => {
    writeSource('timing.srt', '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\n');
    const timing = await ingestMaterial(scope(), 'timing.srt', realParseDeps());
    expect(!timing.ok && timing.reason).toBe('parse-failed');
    expect(!timing.ok && timing.error).toContain('字幕无可提取文本');
    expect(existsSync(derivedAbs('timing.srt'))).toBe(false);

    writeSource('prose.srt', '这是一段没有任何时间码的普通散文。');
    const prose = await ingestMaterial(scope(), 'prose.srt', realParseDeps());
    expect(!prose.ok && prose.reason).toBe('parse-failed');

    writeSource('empty.srt', '');
    const empty = await ingestMaterial(scope(), 'empty.srt', realParseDeps());
    expect(!empty.ok && empty.reason).toBe('empty');
  });

  // ── CR patch 批（2026-09-05 BMad CR：CR-1/2/3/9/10/11/20）──

  it('密集无停顿超长字幕（CR-1）：40k 字单段按句末标点二次切分 → 逐段整理全部成功（不再整体降级）', async () => {
    // B 站自动字幕形态：cue 间隔 ≪1.5s（join 塌成单段），文本带句末标点（口播转写常见形态）。
    const unit = '讲解要点内容。补充说明。'; // 12 字/句（含两个句末标点）
    const cueCount = 3400; // 40800 字 > 6×6000——旧逻辑塌成单段，输出上限下截断门必降级
    const joined = unit.repeat(cueCount);
    const rel = writeSource('dense.srt', buildDenseSrt(Array.from({ length: cueCount }, () => unit)));
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({ text: input.user, finishReason: 'stop' }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const polishCalls = generateText.mock.calls.filter((c) => c[0].system === SUBTITLE_POLISH_SYSTEM_PROMPT);
    // 二次切分生效：多段（>6 段才能覆盖 40k 字）且每段 ≤ 预算（旧逻辑 = 1 段 40600 字）。
    expect(polishCalls.length).toBeGreaterThan(6);
    expect(polishCalls.length).toBeLessThanOrEqual(MAX_POLISH_SEGMENTS);
    for (const call of polishCalls) expect(call[0].user.length).toBeLessThanOrEqual(SEGMENT_CHAR_BUDGET);
    // 切分无损：各段输入串接 = 原拼合全文。
    expect(polishCalls.reduce((n, c) => n + c[0].user.length, 0)).toBe(joined.length);
    // 全部成功：成功 note + 零降级。
    const notes = result.material.quality.parseNotes.join('\n');
    expect(notes).toContain(`字幕已书面化整理（${polishCalls.length} 段）`);
    expect(notes).not.toContain('未经书面化整理');
    // 整理稿 = 分段串接（passthrough mock）落派生 .md。
    expect(stripChapterMarkerLines(readFileSync(derivedAbs(rel), 'utf-8'))).toBe(
      polishCalls.map((c) => c[0].user).join('\n\n'),
    );
  }, 30_000);

  it('截断判定（CR-2）：finishReason=length → 整体降级（权威信号，等长响应比值法判不出）；finishReason=stop + 深度浓缩 → 通过（比值法不再误杀）', async () => {
    // ① finishReason='length'：passthrough 等长响应（比值 100%）仍降级——真截断恰留 >70% 时
    //    比值法假阴性，半截稿落盘违保义红线，权威信号兜住。
    const relA = writeSource('a.srt', buildSrt([`主题一${'甲'.repeat(400)}`]));
    const genA = vi.fn<MaterialGenerateText>(async (input) => ({ text: input.user, finishReason: 'length' }));
    const resultA = await ingestMaterial(scope(), relA, { ...realParseDeps(), generateText: genA });
    expect(resultA.ok).toBe(true);
    if (resultA.ok) {
      const notesA = resultA.material.quality.parseNotes.join('\n');
      expect(notesA).toContain("finishReason='length'");
      expect(notesA).toContain('字幕未经书面化整理');
      expect(stripChapterMarkerLines(readFileSync(derivedAbs(relA), 'utf-8'))).toBe(`主题一${'甲'.repeat(400)}`); // 降级纯拼合
    }
    // ② finishReason='stop' + 浓缩至 ~25%（合法去语气词浓缩——旧比值法假阳性误杀面，权威信号放行）。
    const relB = writeSource('b.srt', buildSrt([`主题一${'甲'.repeat(400)}`]));
    const condensed = `主题一的浓缩版要点。${'乙'.repeat(90)}`;
    const genB = vi.fn<MaterialGenerateText>(async () => ({ text: condensed, finishReason: 'stop' }));
    const resultB = await ingestMaterial(scope(), relB, { ...realParseDeps(), generateText: genB });
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      expect(resultB.material.quality.parseNotes.join('\n')).toContain('字幕已书面化整理（1 段）');
      expect(stripChapterMarkerLines(readFileSync(derivedAbs(relB), 'utf-8'))).toBe(condensed); // 浓缩稿保留
    }
  });

  it('整理稿输出净化（CR-9）：CRLF/ATX 标题前缀/行尾空白/3+ 连空行不直落派生 .md', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(200)}`]));
    const dirty = '# 整理小节\r\n\r\n\r\n\r\n正文第一段。\r\n\r\n\r\n\r\n\r\n## 另一小节\r\n正文第二段  ';
    const generateText = vi.fn<MaterialGenerateText>(async () => ({ text: dirty, finishReason: 'stop' }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(derived).not.toContain('\r'); // CRLF 净化
    expect(derived).not.toMatch(/(^|\n)[\t ]*#{1,6}[\t ]/); // ATX 标题前缀剥净（防 69 格式误判章界）
    expect(derived).not.toMatch(/\n{3,}/); // 3+ 连空行折一段
    // 净化后标题行非章标形态 → 单伪章（章界不被 markdown 残留污染）。
    expect(result.material.chapters).toHaveLength(1);
    expect(stripChapterMarkerLines(derived)).toBe('整理小节\n\n正文第一段。\n\n另一小节\n正文第二段'); // 行尾空白剥净
    expect(result.material.quality.parseNotes.join('\n')).toContain('字幕已书面化整理');
  });

  it('GBK/GB18030 字幕（CR-10）：utf8 替换率超阈 → gb18030 二次解码择优 + note，中文正文非乱码', async () => {
    // GB2312 区位字节手工表（TextDecoder('gb18030') 解码互证——Node 无 gb18030 编码方向，
    // 无法从字符串生成 fixture，只能反向钉字节；表错则下方解码断言红）。
    const GBK_BYTES: Record<string, number[]> = {
      大: [0xb4, 0xf3],
      家: [0xbc, 0xd2],
      好: [0xba, 0xc3],
      中: [0xd6, 0xd0],
      国: [0xb9, 0xfa],
    };
    const gbk = (text: string): Buffer => Buffer.concat([...text].map((ch) => Buffer.from(GBK_BYTES[ch])));
    const buffer = Buffer.concat([
      Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n', 'ascii'),
      gbk('大家好大家好大家好'),
      Buffer.from('\n\n2\n00:00:06,000 --> 00:00:08,000\n', 'ascii'),
      gbk('中国中国'),
      Buffer.from('\n', 'ascii'),
    ]);
    const rel = writeSource('gbk.srt', buffer);
    const result = await ingestMaterial(scope(), rel, realParseDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 择优成功：nonUtf8 不再置位（正文干净 = 材料质量 ok），note 记录解码方式。
    expect(result.material.quality.nonUtf8).toBe(false);
    expect(result.material.quality.ok).toBe(true);
    expect(result.material.quality.parseNotes.join('\n')).toContain('已按 GB18030 解码');
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    expect(derived).toContain('大家好');
    expect(derived).toContain('中国');
    expect(derived).not.toContain('�'); // 零替换符（UTF-8-only 路径会全乱码）
  });

  it('自愈路径 empty 守卫（CR-11）：派生 .md 被清空 + 登记 hash 匹配 → empty 拒收（不装配 ready 空材料）', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(200)}`]));
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 派生 .md 被清空（外部编辑/误删内容），登记 hash 仍匹配（原件未变）。
    writeFileSync(derivedAbs(rel), '');
    const second = await ingestMaterial(scope(), rel, {
      ...realParseDeps(),
      getRegisteredContentHash: async () => first.material.contentHash,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('empty');
    expect(second.error).toContain('派生 .md 已被清空');
  });

  it('保义 plumbing fixture（CR-20）：mock 忠实浓缩（保留全部主句关键词、仅去语气词加标点）→ 主张全在派生稿', async () => {
    // 钉内容不丢的管线面：generate → sanitize → 派生 .md 全链不吞主张。真 LLM 保义抽查仍归
    // 真机验收清单（AC4）——此 fixture 只钉 plumbing。
    const spoken = '嗯 大家好 啊 就是说 今天给大家分享 一个 很实用的 写作方法 对吧 就是 先写大纲 再填正文 然后 每天保持 两千字';
    const condensed = '大家好，今天给大家分享一个很实用的写作方法：先写大纲，再填正文，每天保持两千字。';
    const rel = writeSource('method.srt', buildSrt([spoken]));
    const generateText = vi.fn<MaterialGenerateText>(async () => ({ text: condensed, finishReason: 'stop' }));
    const result = await ingestMaterial(scope(), rel, { ...realParseDeps(), generateText });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const derived = readFileSync(derivedAbs(rel), 'utf-8');
    for (const keyword of ['大家好', '写作方法', '先写大纲', '再填正文', '每天保持', '两千字']) {
      expect(derived).toContain(keyword); // 全部主句主张在派生稿
    }
    expect(derived).not.toContain('嗯'); // 语气词已去除（浓缩确实发生——非 passthrough 假绿）
    expect(derived).not.toContain('对吧');
    expect(result.material.quality.parseNotes.join('\n')).toContain('字幕已书面化整理');
  });

  // ── CR-3 降级自动重烧（A 案，2026-09-05 拍板）。三态之三「已整理 → REUSE 不重烧」由上方
  // 「幂等：原件未变（登记 hash = 拼合身份）→ reused 不重整理」用例覆盖（generateText 在场 +
  // 首轮整理成功 = wasDegraded false 路径）。──

  it('CR-3 ①降级材料 + LLM 可用 → 自动重烧成功：派生翻新 + note 记录 + 恢复正常幂等（第三次 reused 不再烧）', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(200)}`]));
    const first = await ingestMaterial(scope(), rel, realParseDeps()); // 未装配 LLM → 降级纯拼合落库
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.material.quality.parseNotes.join('\n')).toContain('字幕未经书面化整理');
    const joinedHash = first.material.contentHash;

    // LLM 配好后重摄取：登记 hash = 拼合身份（未变）+ derived = 纯拼合（从未整理成功）→ 自动重烧。
    const generateText = vi.fn<MaterialGenerateText>(async (input) => ({ text: `【整理】${input.user}`, finishReason: 'stop' }));
    const second = await ingestMaterial(scope(), rel, {
      ...realParseDeps(),
      generateText,
      getRegisteredContentHash: async () => joinedHash,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reingested');
    expect(generateText).toHaveBeenCalledTimes(1); // 自动重烧一次（fresh 同路径）
    const notes = second.material.quality.parseNotes.join('\n');
    expect(notes).toContain('已自动重新书面化整理');
    expect(notes).toContain('字幕已书面化整理（1 段）');
    expect(readFileSync(derivedAbs(rel), 'utf-8')).toContain('【整理】'); // 派生翻新为整理稿

    // 重烧成功后恢复正常幂等：第三次（LLM 仍在场）→ reused 不再烧。
    const third = await ingestMaterial(scope(), rel, {
      ...realParseDeps(),
      generateText,
      getRegisteredContentHash: async () => joinedHash,
    });
    expect(third.ok && third.outcome).toBe('reused');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('CR-3 ②降级材料 + LLM 不可用 → REUSE 保持纯拼合体 + 降级 note 按实际状态重建（不抹除、不重写）', async () => {
    const rel = writeSource('talk.srt', buildSrt([`主题一${'甲'.repeat(200)}`]));
    const first = await ingestMaterial(scope(), rel, realParseDeps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const joinedHash = first.material.contentHash;
    const past = new Date(Date.now() - 60_000);
    utimesSync(derivedAbs(rel), past, past); // mtime 钉过去——重摄取若重写会推进

    const second = await ingestMaterial(scope(), rel, {
      ...realParseDeps(),
      getRegisteredContentHash: async () => joinedHash, // 仍无 LLM（deps 与 install 均缺）
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome).toBe('reused');
    const notes = second.material.quality.parseNotes.join('\n');
    expect(notes).toContain('字幕未经书面化整理'); // 降级 note 重建（不抹除）
    expect(notes).toContain('LLM 整理内核未装配');
    expect(statSync(derivedAbs(rel)).mtimeMs).toBeLessThan(Date.now() - 30_000); // 未重写
  });
});

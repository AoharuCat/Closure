import { describe, expect, it } from 'vitest';
import {
  MATERIAL_CHUNK_STRATEGIES,
  MATERIAL_DESCRIPTION_MAX_CHARS,
  MATERIAL_FORMATS,
  MATERIAL_ONLINE_CATEGORIES,
  MATERIAL_ONLINE_IMPORT_FAILURE_KINDS,
  MATERIAL_STATUSES,
  chapterChunkSchema,
  chunkChapter,
  desktopIpcSchema,
  materialChapterDetectionSchema,
  materialChapterSpanSchema,
  materialChunkSpanSchema,
  materialSchema,
  splitChapters,
} from '../src';
import type { ChapterMarker } from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 10.1 Wave A：材料域 schema（material.ts，design §2.1）。
// 重点：开放性三预留（D6：medium 词表开放 / kind 开放 / 策略 seam，AC9）+ 唯一 method 源
// （F-18）+ F-05 文档级元数据 nullable（非 optional，字段恒在）+ 身份格式钉死（F-19）。
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_PROVENANCE = {
  medium: 'novel_text',
  tier: 'unspecified' as const,
  sourcePath: 'materials/novel.txt',
  via: 'direct-read',
  extractor: 'builtin-text',
  ingestedAt: '2026-09-02T10:00:00.000Z',
  author: null,
  lang: 'zh',
  originDate: null,
};

/** 造三章样文（章标 + 短正文，自制）。 */
function chapterDoc(bodies: number[]): string {
  return bodies.map((n, i) => `第${i + 1}章\n${'墨'.repeat(n)}。`).join('\n\n');
}

function sampleMaterial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    materialId: 'mat-0123456789ab',
    scope: 'project',
    projectId: '00042',
    kind: 'prose',
    name: '示例长篇',
    format: 'txt',
    provenance: { ...SAMPLE_PROVENANCE },
    quality: {
      ok: true,
      scanned: false,
      nonUtf8: false,
      parseNotes: [],
      charCount: 12345,
      chapterDetection: { method: 'regex', confidence: 'high', matchedFormats: ['第X章·汉字数字'] },
    },
    chapters: [
      {
        index: 0,
        title: '第一章',
        charStart: 0,
        charEnd: 100,
        paraStart: 0,
        paraEnd: 5,
        confidence: 'high',
        method: 'regex',
      },
    ],
    chunkSpans: [{ chapterIndex: 0, chunkIndex: 0, charStart: 0, charEnd: 90, paraStart: 0, paraEnd: 3 }],
    contentHash: `sha256:${'a'.repeat(64)}`,
    status: 'ready',
    ...overrides,
  };
}

describe('materialSchema — 基线与身份格式', () => {
  it('合法样例 parse 通过', () => {
    expect(() => materialSchema.parse(sampleMaterial())).not.toThrow();
  });

  it('materialId 格式钉死 mat-<12hex>（F-19 路径身份）；13 位/大写/无前缀均拒', () => {
    expect(() => materialSchema.parse(sampleMaterial({ materialId: 'mat-0123456789ab' }))).not.toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ materialId: 'mat-0123456789abc' }))).toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ materialId: 'mat-ABCDEF012345' }))).toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ materialId: '0123456789ab' }))).toThrow();
  });

  it('contentHash 格式钉死 sha256:<64hex>；63 位/无前缀均拒（幂等判定底座）', () => {
    expect(() => materialSchema.parse(sampleMaterial({ contentHash: `sha256:${'f'.repeat(64)}` }))).not.toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ contentHash: `sha256:${'f'.repeat(63)}` }))).toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ contentHash: `${'f'.repeat(64)}` }))).toThrow();
  });

  it('scope/projectId：全局车道 projectId=null 合法（D1 双轨同契约）', () => {
    const global = sampleMaterial({ scope: 'global', projectId: null, sourcePath: 'drafts/interview.md' });
    expect(() => materialSchema.parse(global)).not.toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ scope: 'team' }))).toThrow();
  });
});

describe('materialSchema — 开放性三预留（D6 / AC9）', () => {
  it('kind 开放字符串：event_stream 不被拒（V1 代码不实现，schema 预留）', () => {
    expect(() => materialSchema.parse(sampleMaterial({ kind: 'event_stream' }))).not.toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ kind: 'prose' }))).not.toThrow();
  });

  it('medium 开放词表：R1 五值预留（game_files 等）与未来值均不拒；tier 封闭四值', () => {
    for (const medium of ['game_files', 'community_data', 'runtime_hook', 'screen_capture', 'video', 'future_x']) {
      expect(
        () => materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, medium } })),
        medium,
      ).not.toThrow();
    }
    expect(
      () => materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, tier: 'original' } })),
    ).not.toThrow();
    expect(
      () => materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, tier: 'fanfiction' } })),
    ).toThrow();
  });

  it('分块策略 seam：V1 仅注册 prose 且即 chunkChapter（语义分块红线复用，禁另写切分器）', () => {
    expect(Object.keys(MATERIAL_CHUNK_STRATEGIES)).toEqual(['prose']);
    expect(MATERIAL_CHUNK_STRATEGIES.prose).toBe(chunkChapter);
  });

  it('策略产物满足 chapterChunkSchema（seam 输出可直接落章源七列）', () => {
    const text = `第一段。\n\n${'雨'.repeat(300)}。\n\n${'墨'.repeat(300)}。`;
    const chunks = MATERIAL_CHUNK_STRATEGIES.prose(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(() => chapterChunkSchema.parse(c)).not.toThrow();
  });
});

describe('materialSchema — 封闭枚举（格式/状态）', () => {
  it('format 五值白名单：epub 进、rtf 拒（硬骨头格式分期记档不进词表）', () => {
    expect(() => materialSchema.parse(sampleMaterial({ format: 'epub' }))).not.toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ format: 'rtf' }))).toThrow();
  });

  it('status 四值：low-confidence 在列（F-09 章界挂起检索照常）；未来值拒', () => {
    expect(MATERIAL_STATUSES).toEqual(['pending', 'ready', 'low-confidence', 'failed']);
    expect(() => materialSchema.parse(sampleMaterial({ status: 'low-confidence' }))).not.toThrow();
    expect(() => materialSchema.parse(sampleMaterial({ status: 'archived' }))).toThrow();
  });
});

describe('materialProvenance — F-05 文档级元数据（nullable 非 optional，字段恒在）', () => {
  it('author/lang/originDate null 合法（摄取期未知 = null）', () => {
    expect(
      () =>
        materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, author: null, lang: null, originDate: null } })),
    ).not.toThrow();
  });

  it.each(['author', 'lang', 'originDate'])('%s 缺键 = 拒（字段恒在，UI 后补走 null 值更新）', (key) => {
    const provenance = { ...SAMPLE_PROVENANCE } as Record<string, unknown>;
    delete provenance[key];
    expect(() => materialSchema.parse(sampleMaterial({ provenance }))).toThrow();
  });

  it('后补作者元数据合法（10.2 手艺卡「作者立场」来源）', () => {
    expect(
      () =>
        materialSchema.parse(
          sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, author: '某讲师', originDate: '2019' } }),
        ),
    ).not.toThrow();
  });
});

describe('materialChapterDetection — method 唯一源（F-18）', () => {
  it('method 四值全合法（含 none 伪章 / llm-fallback / manual）', () => {
    for (const method of ['regex', 'llm-fallback', 'manual', 'none']) {
      expect(() =>
        materialChapterDetectionSchema.parse({
          method,
          confidence: 'low',
          matchedFormats: [],
        }),
      ).not.toThrow();
    }
    expect(() => materialChapterDetectionSchema.parse({ method: 'auto', confidence: 'low', matchedFormats: [] })).toThrow();
  });

  it('llmCapped 二态：缺省合法、true 保留（F-07 候选超预算挂起的诚实标注）', () => {
    const base = { method: 'llm-fallback', confidence: 'low', matchedFormats: [] } as const;
    expect(materialChapterDetectionSchema.parse(base).llmCapped).toBeUndefined();
    expect(materialChapterDetectionSchema.parse({ ...base, llmCapped: true }).llmCapped).toBe(true);
  });

  it('材料级无 chapteringMethod 冗余字段（F-18：多余键被 strip，不落库不漂移）', () => {
    const parsed = materialSchema.parse(
      sampleMaterial({ chapteringMethod: 'regex' } as Record<string, unknown>),
    ) as Record<string, unknown>;
    expect('chapteringMethod' in parsed).toBe(false);
  });
});

describe('章/chunk span — 摄取时保存段落号+字符区间（锚定供给面）', () => {
  it('materialChapterSpanSchema：method 含 none（伪章）、confidence 含 manual、title 可 null', () => {
    expect(() =>
      materialChapterSpanSchema.parse({
        index: 0,
        title: null,
        charStart: 0,
        charEnd: 5000,
        paraStart: 0,
        paraEnd: 42,
        confidence: 'manual',
        method: 'none',
      }),
    ).not.toThrow();
    expect(() =>
      materialChapterSpanSchema.parse({
        index: 0,
        title: null,
        charStart: 0,
        charEnd: 5000,
        paraStart: 0,
        paraEnd: 42,
        confidence: 'certain',
        method: 'none',
      }),
    ).toThrow();
  });

  it('materialChunkSpanSchema：chapterIndex+chunkIndex 寻址 + 半开区间（全局车道 span 唯一落点，F-02）', () => {
    expect(() =>
      materialChunkSpanSchema.parse({ chapterIndex: 3, chunkIndex: 1, charStart: 120, charEnd: 520, paraStart: 2, paraEnd: 4 }),
    ).not.toThrow();
    expect(() => materialChunkSpanSchema.parse({ chapterIndex: -1, chunkIndex: 0, charStart: 0, charEnd: 1, paraStart: 0, paraEnd: 1 })).toThrow();
  });

  it('与 splitChapters 集成：分章 span 装配 method/confidence/para 后可整组 parse（Wave B 装配路径）', () => {
    const text = chapterDoc([120, 120, 120]);
    const r = splitChapters(text);
    expect(r.chapters.length).toBe(3);
    const spans = r.chapters.map((c) => ({
      ...c,
      paraStart: 0,
      paraEnd: 2,
      confidence: 'manual' as const,
      method: 'regex' as const,
    }));
    expect(() => materialChapterSpanSchema.array().parse(spans)).not.toThrow();
    // ChapterMarker（章标记协议）的 method 词表与章 span 同源——往返不漂移
    const markers: ChapterMarker[] = spans.map((s) => ({ index: s.index, title: s.title, method: s.method }));
    expect(() => materialChapterSpanSchema.parse({ ...spans[0] })).not.toThrow();
    expect(markers.every((m) => m.method === 'regex')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E10.2a（task 09-05）：字幕三格式 + provenance.description（design §2.1）。
// 重点：description default(null) = closure_material 旧行 provenance_json 无键回读容忍
// （零迁移关键项）；format 枚举扩宽；materials:update-name 通道进 enum（契约半）。
// ─────────────────────────────────────────────────────────────────────────────

describe('E10.2a — 字幕三格式 + provenance.description（旧行零迁移）', () => {
  it('MATERIAL_FORMATS += srt/ass/vtt；format 枚举接受三值（ssa 仍拒）', () => {
    expect(MATERIAL_FORMATS).toEqual(['txt', 'md', 'docx', 'pdf', 'epub', 'srt', 'ass', 'vtt']);
    for (const format of ['srt', 'ass', 'vtt'] as const) {
      expect(() => materialSchema.parse(sampleMaterial({ format }))).not.toThrow();
    }
    expect(() => materialSchema.parse(sampleMaterial({ format: 'ssa' }))).toThrow();
  });

  it('旧行无 description 键：parse 通过且补 null（provenance_json 回读容忍，零迁移）', () => {
    const provenance = { ...SAMPLE_PROVENANCE };
    expect('description' in provenance).toBe(false); // 旧行形态
    const parsed = materialSchema.parse(sampleMaterial({ provenance }));
    expect(parsed.provenance.description).toBeNull();
  });

  it('新行带键：简介字符串/null 均合法（摄取期 null，UI 后补；归一归 IPC 层）', () => {
    const filled = materialSchema.parse(
      sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, description: '关于叙事节奏的经验分享' } }),
    );
    expect(filled.provenance.description).toBe('关于叙事节奏的经验分享');
    const nulled = materialSchema.parse(
      sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, description: null } }),
    );
    expect(nulled.provenance.description).toBeNull();
  });

  it('description 上限 2000（CR-6 投影纪律：随 MaterialSummary 行放大列表查询）：2000 恰过 / 2001 拒；null 不受 max 约束', () => {
    expect(MATERIAL_DESCRIPTION_MAX_CHARS).toBe(2000);
    expect(() =>
      materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, description: '简'.repeat(2000) } })),
    ).not.toThrow();
    expect(() =>
      materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, description: '简'.repeat(2001) } })),
    ).toThrow();
  });

  it('via 开放字符串：builtin-subtitle 不拒（E10.2a 字幕解析词表注记）', () => {
    expect(() =>
      materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, via: 'builtin-subtitle' } })),
    ).not.toThrow();
  });

  it('materials:update-name 进 desktopIpcSchema enum（E10.2a 契约半；materials:rename 仍拒）', () => {
    expect(desktopIpcSchema.safeParse({ channel: 'materials:update-name' }).success).toBe(true);
    expect(desktopIpcSchema.safeParse({ channel: 'materials:rename' }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E10.4（task 09-20）W1：在线解析生态契约——provenance.url additive（旧行零迁移，mirror
// description 先例）+ via='web-fetch' 词表 + 在线两 IPC 通道进 enum + 类别/失败分类词表钉死。
// ─────────────────────────────────────────────────────────────────────────────

describe('E10.4 — provenance.url（additive 旧行零迁移）', () => {
  it('旧行无 url 键：parse 通过且补 null（provenance_json 回读容忍，零迁移）', () => {
    const provenance = { ...SAMPLE_PROVENANCE };
    expect('url' in provenance).toBe(false); // 旧行形态
    const parsed = materialSchema.parse(sampleMaterial({ provenance }));
    expect(parsed.provenance.url).toBeNull();
  });

  it('新行带键：URL 字符串/null 均合法，round-trip 保留（在线拉取溯源呈现面）', () => {
    const parsed = materialSchema.parse(
      sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, url: 'https://zh.moegirl.org.cn/示例词条' } }),
    );
    expect(parsed.provenance.url).toBe('https://zh.moegirl.org.cn/示例词条');
    const nulled = materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, url: null } }));
    expect(nulled.provenance.url).toBeNull();
  });

  it("via='web-fetch' 不拒（E10.4 在线拉取解析 provenance——开放字符串词表注记）", () => {
    expect(() =>
      materialSchema.parse(sampleMaterial({ provenance: { ...SAMPLE_PROVENANCE, via: 'web-fetch' } })),
    ).not.toThrow();
  });
});

describe('E10.4 — 在线两通道 IPC 契约（materials:import-online / materials:search-online）', () => {
  it('两通道进 desktopIpcSchema enum（契约半——shell handler W1 占位、W2 落实现；自造通道拒）', () => {
    expect(desktopIpcSchema.safeParse({ channel: 'materials:import-online' }).success).toBe(true);
    expect(desktopIpcSchema.safeParse({ channel: 'materials:search-online' }).success).toBe(true);
    expect(desktopIpcSchema.safeParse({ channel: 'materials:import-web' }).success).toBe(false);
  });

  it('失败分类六档穷举钉死（PRD R1 失败矩阵基线——UI 分文案键集对拍；多档少档都红）', () => {
    expect(MATERIAL_ONLINE_IMPORT_FAILURE_KINDS).toEqual([
      'bad-url',
      'fetch-failed',
      'empty-content',
      'oversize',
      'stem-conflict',
      'ingest-failed',
    ]);
  });

  it('类别四档穷举钉死（UI 类别选择 + medium/tier 预填映射基线——映射表落 shell W2）', () => {
    expect(MATERIAL_ONLINE_CATEGORIES).toEqual(['community-wiki', 'criticism', 'author-interview', 'other']);
  });
});

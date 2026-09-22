/**
 * Story 8.7 S6 builtin registration + classification tests — catalog trio + query_story 扩参
 * （mirror builtin-arc-pipeline.test.ts / builtin-curation.test.ts）。
 *
 * 守门面：
 * - tool ids MUST match the shell handler registrations in toolExecution.ts（remoteToolProxy 按
 *   id 路由，漏注册 = 工具调不通——catalog_entries / get_entry / query_mentions 三处逐字一致）。
 * - classifyTool 'read'（只读工具——readonly/suggest/auto 全可用，零 toolPolicy 登记，AC-10）。
 * - 描述说人话双规则（agent-tools.md，AC-10 守门）：tool description + 全部参数 describe 经
 *   zodToJsonSchema 展开后，实现词汇（产patch/落盘/field_patch/PatchReview/mirror/Story 编号/
 *   文件路径行号）零命中——读者是写小说的 agent，读不到源码/文档/UI。
 * - query_story 扩参（R4）：status/visibility 进 tool surface（shared schema 单源，N5）。
 */
import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool, filterToolsForPolicy } from '../src/runtime/toolPolicy';

registerBuiltinTools();

const TRIO = ['catalog_entries', 'get_entry', 'query_mentions'] as const;

/** 递归收集 JSON schema 里的全部 description 字符串（tool description 由调用方单独拼）。 */
function collectDescriptions(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectDescriptions(item, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.description === 'string') out.push(record.description);
  for (const value of Object.values(record)) collectDescriptions(value, out);
  return out;
}

/** 实现词汇黑名单（agent-tools.md 说人话双规则：说作用不说实现）。 */
const BANNED_VOCAB_PATTERNS: RegExp[] = [
  /产\s*patch/i,
  /落盘/,
  /field_patch/i,
  /PatchReview/i,
  /patch panel/i,
  /\bmirror\b/i,
  /Story\s*8/,
  /文件路径/,
  /行号/,
];

function assertPlainLanguage(where: string, text: string): void {
  for (const pattern of BANNED_VOCAB_PATTERNS) {
    expect(text, `${where} 不应含实现词汇（${pattern}）`).not.toMatch(pattern);
  }
}

describe('registerBuiltinTools — Story 8.7 catalog trio（注册 + id 逐字一致）', () => {
  it('三工具全部注册（id 与 shell toolExecution register 逐字一致）', () => {
    for (const id of TRIO) {
      expect(registry.get(id), `${id} 应已注册`).toBeDefined();
      expect(registry.get(id)!.id).toBe(id);
    }
  });

  it('catalog_entries：过滤 + 翻页 surface（limit cap 100 拒超限）', () => {
    const tool = registry.get('catalog_entries')!;
    const parse = tool.parameters!;
    expect(parse.parse({})).toMatchObject({ limit: 20 }); // offset 缺省 undefined（handler ?? 0）
    expect(parse.parse({ entry_type: 'character', status: 'active', offset: 20, limit: 50 })).toMatchObject({
      entry_type: 'character',
      status: 'active',
      offset: 20,
      limit: 50,
    });
    // limit > 100 zod 层拒（catalog.ts CATALOG_ENTRIES_LIMIT_MAX）。
    expect(() => parse.parse({ limit: 101 })).toThrow();
    expect(() => parse.parse({ offset: -1 })).toThrow();
  });

  it('get_entry：entry_id 必填 surface', () => {
    const parse = registry.get('get_entry')!.parameters!;
    expect(parse.parse({ entry_id: 'erina' })).toEqual({ entry_id: 'erina' });
    expect(() => parse.parse({})).toThrow();
    expect(() => parse.parse({ entry_id: '' })).toThrow();
  });

  it('query_mentions：双向 + presence + view surface', () => {
    const parse = registry.get('query_mentions')!.parameters!;
    expect(parse.parse({})).toEqual({});
    expect(parse.parse({ entry_id: 'erina' })).toEqual({ entry_id: 'erina' });
    expect(parse.parse({ episode_id: 'ep-3', presence: 'mentioned' })).toEqual({
      episode_id: 'ep-3',
      presence: 'mentioned',
    });
    expect(parse.parse({ view: 'gap_stats' })).toEqual({ view: 'gap_stats' });
    // view 开放 enum 外拒。
    expect(() => parse.parse({ view: 'raw' })).toThrow();
    expect(() => parse.parse({ presence: 'ghost' })).toThrow();
  });
});

describe('Story 8.7 分类与 mode filtering（AC-10：全 read 全档可用）', () => {
  it('三工具 classifyTool 全 read（只读——零 toolPolicy 登记即默认）', () => {
    for (const id of TRIO) {
      expect(classifyTool(id), `${id} 应为 read`).toBe('read');
    }
  });

  it('readonly / suggest / auto：三工具全可见', () => {
    for (const mode of ['readonly', 'suggest', 'auto'] as const) {
      const visible = filterToolsForPolicy({ tools: registry.all(), sessionMode: mode }).map((t) => t.id);
      for (const id of TRIO) {
        expect(visible, `${id} ${mode} 档应可用`).toContain(id);
      }
    }
  });
});

describe('描述说人话双规则守门（AC-10——tool description + 参数 describe 全量过黑名单）', () => {
  it('三新工具 + query_story 的 tool description 零实现词汇', () => {
    for (const id of [...TRIO, 'query_story'] as const) {
      const tool = registry.get(id)!;
      expect(tool.description?.length, `${id} description 非空`).toBeGreaterThan(0);
      assertPlainLanguage(`${id} description`, tool.description ?? '');
    }
  });

  it('三新工具 + query_story 的参数 describe（zodToJsonSchema 展开后）零实现词汇', () => {
    for (const id of [...TRIO, 'query_story'] as const) {
      const { $schema: _$schema, ...schema } = zodToJsonSchema(registry.get(id)!.parameters!, {
        target: 'jsonSchema7',
      }) as Record<string, unknown>;
      const descriptions = collectDescriptions(schema);
      expect(descriptions.length, `${id} 参数应带 describe`).toBeGreaterThan(0);
      for (const d of descriptions) {
        assertPlainLanguage(`${id} 参数 describe`, d);
      }
    }
  });
});

describe('query_story 扩参（Story 8.7 R4——shared schema 单源 N5）', () => {
  it('status/visibility 进 tool surface：schema properties 可见 + parse 透传', () => {
    const tool = registry.get('query_story')!;
    const parse = tool.parameters!;
    const parsed = parse.parse({
      query: '主角的剑',
      status: 'active',
      visibility: 'known',
      entry_type: 'prop',
      k: 5,
    });
    expect(parsed).toMatchObject({ status: 'active', visibility: 'known', entry_type: 'prop' });
    expect((parsed as { k: number }).k).toBe(5);
    // k clamp（坏参数不进 SQL）。
    expect((parse.parse({ query: 'x', k: 999 }) as { k: number }).k).toBe(50);
    expect((parse.parse({ query: 'x', k: 0 }) as { k: number }).k).toBe(1);
  });

  it('JSON schema 暴露 status/visibility（LLM 可见性——漏 describe = 参数隐形）', () => {
    const { $schema: _$schema, ...schema } = zodToJsonSchema(registry.get('query_story')!.parameters!, {
      target: 'jsonSchema7',
    }) as { properties?: Record<string, unknown> };
    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['query', 'entry_type', 'status', 'visibility', 'k']),
    );
    // query 带 default（handler 侧空查询友好 miss 契约）→ 非必填；LLM 端缺省可发、不炸 schema。
    expect((schema as { required?: string[] }).required ?? []).not.toContain('query');
  });
});

// ── Story 8.3 S4：query_story 描述更新（正文段落 + 章摘要进检索面——描述须告知该能力）──
describe('query_story 描述更新（Story 8.3——正文段落可查 + 段级出处 advertised）', () => {
  it('description 告知正文段落与章摘要两类新检索对象（agent 选工具的唯一依据）', () => {
    const description = registry.get('query_story')!.description ?? '';
    expect(description).toContain('正文'); // 正文段落片段
    expect(description).toContain('摘要'); // 每章内容摘要
    expect(description).toContain('出处'); // 段级出处（第N章第a-b段）
  });

  it('工具与参数描述仍全量过黑名单（8.7 守门面延续覆盖 query_story）', () => {
    const tool = registry.get('query_story')!;
    assertPlainLanguage('query_story description', tool.description ?? '');
    const { $schema: _$schema, ...schema } = zodToJsonSchema(tool.parameters!, {
      target: 'jsonSchema7',
    }) as Record<string, unknown>;
    for (const d of collectDescriptions(schema)) {
      assertPlainLanguage('query_story 参数 describe', d);
    }
  });
});

// ── 09-20 F17（R12 残留措辞统一，F16 同族）：present_result 工具描述（HTTP 车道 leader
// 可见面——桥车道走 bridgeExecutor 覆写不读此处）。措辞家族四处同步：agents.ts 桥 agent
// body / bridgeExecutor.ts 覆写 / 本描述 / workflow.ts interaction 能力段（各自有守门断言）。
// 旧承重词「正文」可被后向推导出「章节正文写在对话里」授权，禁回。──
describe('present_result 描述措辞（R12 家族 HTTP 站点守门）', () => {
  it('呈现纪律句用「呈现性回复文字」限定（与桥侧覆写同句基线）；旧「呈现给用户看的正文」禁回', () => {
    const description = registry.get('present_result')!.description ?? '';
    expect(description).toContain(
      '呈现给用户看的呈现性回复文字（讨论/说明/评审等，不含章节正文/改稿产物）必须写在调用本工具的同一条消息里',
    );
    expect(description).not.toContain('呈现给用户看的正文');
  });
});

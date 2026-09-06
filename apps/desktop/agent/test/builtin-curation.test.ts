/**
 * Story 3.6 WP9 builtin registration + classification tests — save_craft_doc /
 * asset_cards_update (mirror builtin-web-search.test.ts).
 *
 * Asserts: tool ids + zod surfaces (ids MUST match the shell handler
 * registrations in toolExecution.ts — remoteToolProxy routes by id), the
 * classification split that gates the 人审闭环 (策展 write / 设定卡 diff / 研究
 * read — AC9「全 9 工具分类一致」), toolPolicy mode filtering (shared behavior
 * surface — save blocked in suggest like write_file; asset_cards_update kept
 * like scene_graph_update), and the permission DEFAULT_RULES write-rule match
 * for save_craft_doc (skill-VM path class 'write' not 'external' fallback).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool, filterToolsForPolicy } from '../src/runtime/toolPolicy';
import { createPermissionService } from '../src/runtime/permission';

registerBuiltinTools();

/** Story 3.6 全部 9 工具（D1 工具面总表）——分类一致性一次断言（AC9）。 */
const RESEARCH_TOOLS_READ = ['wiki_search', 'wiki_read', 'web_search', 'web_fetch', 'render_page', 'parse_document', 'analyze_image'];

describe('registerBuiltinTools — Story 3.6 WP9 save_craft_doc builtin', () => {
  it('registers with required craft_type/title/content + optional provenance params', () => {
    const tool = registry.get('save_craft_doc');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('save_craft_doc');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      craft_type: 'shuangdian',
      title: '先抑后扬',
      content: '## 结构\n三段式。',
      tags: ['爽点'],
      sourceUrl: 'https://example.com/x',
      sourceNote: 'CC BY-NC-SA',
      filename: 'my-note',
    });
    expect(params.craft_type).toBe('shuangdian');

    // All optional — bare required triple parses
    expect(() => parse.parse({ craft_type: 'c', title: 't', content: 'b' })).not.toThrow();
    // Required — missing each one rejects
    expect(() => parse.parse({ title: 't', content: 'b' })).toThrow();
    expect(() => parse.parse({ craft_type: 'c', content: 'b' })).toThrow();
    expect(() => parse.parse({ craft_type: 'c', title: 't' })).toThrow();
  });

  it('description carries craft_type vocab guidance + query_craft 检回语义 (LLM-facing)', () => {
    const tool = registry.get('save_craft_doc')!;
    expect(tool.description).toContain('craft 参考');
    expect(tool.description).toContain('query_craft');
    expect(tool.description).toContain('craft_type 词表');
  });

  it('classifies as write（显式写用户库——readonly/suggest 拦，mirror write_file）', () => {
    expect(classifyTool('save_craft_doc')).toBe('write');
  });
});

describe('registerBuiltinTools — Story 3.6 WP9 asset_cards_update builtin', () => {
  it('registers with bounded action array（assetCardActionSchema surface）', () => {
    const tool = registry.get('asset_cards_update');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('asset_cards_update');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      actions: [
        { op: 'add_card', card: { id: 'c1', type: 'character', name: '阿米娅' } },
        { op: 'update_card', cardId: 'c1', patch: { summary: '补' } },
        { op: 'remove_card', cardId: 'ghost' },
      ],
    });
    expect((params.actions as unknown[])).toHaveLength(3);

    // 非法 action（缺 name 的 add_card）在 zod 层拒——LLM 看 schema error 非 silent default
    expect(() => parse.parse({ actions: [{ op: 'add_card', card: { id: 'c1', type: 'character' } }] })).toThrow();
    expect(() => parse.parse({})).toThrow(); // actions 必填
    // P16 (CR 2026-08-15)：空 actions 数组不是一次编辑——zod 层拒（shell handler
    // 对绕过 schema 的宽松 provider 早返友好，不产零变更 patch）。
    expect(() => parse.parse({ actions: [] })).toThrow();
  });

  it('classifies as diff（field_patch 人审——suggest 可用 mirror scene_graph_update）', () => {
    expect(classifyTool('asset_cards_update')).toBe('diff');
  });
});

describe('Story 3.6 AC9：全 9 研究工具分类一致（策展 write / 设定卡 diff / 研究 read）', () => {
  it('7 研究工具全 read', () => {
    for (const id of RESEARCH_TOOLS_READ) {
      expect(classifyTool(id), `${id} 应为 read`).toBe('read');
    }
  });

  it('save_craft_doc=write / asset_cards_update=diff', () => {
    expect(classifyTool('save_craft_doc')).toBe('write');
    expect(classifyTool('asset_cards_update')).toBe('diff');
  });
});

describe('query_craft tags 参数面（E10.2b W4.2 三处同步——agent 侧）', () => {
  it('registers optional tags: string[] + 描述带标签发现/组合用法（LLM-facing）', () => {
    const tool = registry.get('query_craft')!;
    expect(tool).toBeDefined();

    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    // tags 可选——既有调用面零改动；带 tags 解析通过并保留数组。
    expect(() => parse.parse({ query: '爽点' })).not.toThrow();
    const parsed = parse.parse({ query: '情绪', tags: ['爽文', '都市'], k: 5 });
    expect(parsed.tags).toEqual(['爽文', '都市']);
    // tags 非字符串数组拒（schema 层守门——shell handler never-throws 之前的第一道）。
    expect(() => parse.parse({ query: 'x', tags: '爽文' })).toThrow();
    expect(() => parse.parse({ query: 'x', tags: [''] })).toThrow();

    // 描述文本：手艺卡块 + 标签行（标签发现机制）+ tags OR 召回语义。
    expect(tool.description).toContain('手艺卡');
    expect(tool.description).toContain('标签: #');
    expect(tool.description).toContain('任一命中即召回');
  });
});

describe('toolPolicy mode filtering（共享行为面——零回归 + 新工具分档）', () => {
  const ids = (mode: 'readonly' | 'suggest' | 'auto') =>
    filterToolsForPolicy({ tools: registry.all(), sessionMode: mode }).map((t) => t.id);

  it('readonly：save/asset 全拦（write+diff 均不可用），研究 read 工具保留', () => {
    const visible = ids('readonly');
    expect(visible).not.toContain('save_craft_doc');
    expect(visible).not.toContain('asset_cards_update');
    expect(visible).toContain('web_search');
    expect(visible).toContain('query_craft');
  });

  it('suggest：save 拦（mirror write_file 既有行为），asset_cards_update 保留（mirror scene_graph_update）', () => {
    const visible = ids('suggest');
    expect(visible).not.toContain('save_craft_doc');
    expect(visible).not.toContain('write_file'); // 既有 write 拦截行为不变（零回归锚点）
    expect(visible).toContain('asset_cards_update');
    expect(visible).toContain('scene_graph_update');
  });

  it('auto：两者均可用', () => {
    const visible = ids('auto');
    expect(visible).toContain('save_craft_doc');
    expect(visible).toContain('asset_cards_update');
  });
});

describe('permission DEFAULT_RULES：save_craft_doc 正式匹配 write 规则（skill-VM 路径）', () => {
  it('evaluate(save_craft_doc) -> ask + class write（非 external fallback）', () => {
    const service = createPermissionService();
    const decision = service.evaluate({ sessionId: 's1', toolName: 'save_craft_doc' });
    expect(decision.action).toBe('ask');
    expect(decision.class).toBe('write');
  });

  it('asset_cards_update 落 external/ask fallback（mirror scene_graph_update 既有形态）', () => {
    const service = createPermissionService();
    const decision = service.evaluate({ sessionId: 's1', toolName: 'asset_cards_update' });
    expect(decision.action).toBe('ask');
    expect(decision.class).toBe('external');
  });
});

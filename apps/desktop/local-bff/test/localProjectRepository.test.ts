import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyPatchOperations,
  createEmptyProjectDocument,
  saveProject,
  loadProject,
  loadProjectWithQuarantine,
  migrateLegacyProjectJsonWithQuarantine,
  applyFieldPatches,
  applyFieldPatchesWithSkipped,
  bootstrapProjectFromMeta,
  migrateLegacyProjectJson
} from '../sync/localProjectRepository';
import type { ProjectFieldPatch } from '@orison/shared-contracts';
import YAML from 'yaml';

const TEST_PROJECT_DIR = path.join(process.cwd(), 'test-tmp-local-project');

/**
 * T22-bff：隔离目标项目外化——备份落 `~/.orison/quarantine/<项目目录名>/`。测试
 * 经 ORISON_QUARANTINE_ROOT 注入缝把根指到 tmp（防污染开发机真实 home）；顶层
 * before/after 全文件生效（判腐用例散布多个 describe）。
 */
const TEST_QUARANTINE_ROOT = path.join(process.cwd(), 'test-tmp-quarantine');
/** 判腐备份的期望落点（per-project 子目录 = 项目目录名兜底口径）。 */
const testQuarantineProjectDir = () =>
  path.join(TEST_QUARANTINE_ROOT, path.basename(TEST_PROJECT_DIR));

beforeEach(() => {
  process.env.ORISON_QUARANTINE_ROOT = TEST_QUARANTINE_ROOT;
});

afterEach(() => {
  delete process.env.ORISON_QUARANTINE_ROOT;
  if (existsSync(TEST_QUARANTINE_ROOT)) {
    rmSync(TEST_QUARANTINE_ROOT, { recursive: true, force: true });
  }
});

describe('local project repository helpers', () => {
  afterEach(() => {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('creates an empty local project document with storyboard root', () => {
    const project = createEmptyProjectDocument('Orison Demo');

    expect(project.meta.name).toBe('Orison Demo');
    expect(project.meta.type).toBe('novel');
    expect(project.storyboard.shots).toEqual([]);
  });

  it('bootstrapProjectFromMeta 从 project.json 重建文档并保留全部 meta 字段', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_PROJECT_DIR, 'project.json'),
      JSON.stringify({
        name: '剧本项目', type: 'script',
        logline: 'L', synopsis: 'S', genre: 'G', theme: 'T', writing_style: 'W', tone: 'TN'
      }),
      'utf8'
    );

    const doc = bootstrapProjectFromMeta(TEST_PROJECT_DIR);

    expect(doc.meta.name).toBe('剧本项目');
    expect(doc.meta.type).toBe('script');
    expect(doc.meta.logline).toBe('L');
    expect(doc.meta.synopsis).toBe('S');
    expect(doc.meta.genre).toBe('G');
    expect(doc.meta.theme).toBe('T');
    expect(doc.meta.writing_style).toBe('W');
    expect(doc.meta.tone).toBe('TN');
    // 纯内存构造，不应自行落盘。
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.yaml'))).toBe(false);
  });

  it('bootstrapProjectFromMeta 无 project.json 时用目录名兜底', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });

    const doc = bootstrapProjectFromMeta(TEST_PROJECT_DIR);

    expect(doc.meta.name).toBe(path.basename(TEST_PROJECT_DIR));
    expect(doc.meta.type).toBe('novel');
  });

  it('migrateLegacyProjectJson 把 project.json 收敛进 project.yaml（含 coverImage/projectId）并删除 json', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_PROJECT_DIR, 'project.json'),
      JSON.stringify({
        name: '迁移项目', type: 'script', logline: 'L', synopsis: 'S',
        coverImage: 'assets/cover.png', projectId: '12345'
      }),
      'utf8'
    );

    const doc = migrateLegacyProjectJson(TEST_PROJECT_DIR);

    expect(doc).not.toBeNull();
    expect(doc!.meta.name).toBe('迁移项目');
    expect(doc!.meta.type).toBe('script');
    expect(doc!.meta.logline).toBe('L');
    expect(doc!.meta.synopsis).toBe('S');
    expect(doc!.meta.cover_image).toBe('assets/cover.png');
    expect(doc!.meta.project_id).toBe('12345');
    // json 被删除，yaml 成为唯一真相源
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.json'))).toBe(false);
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.yaml'))).toBe(true);
    // 重新加载一致
    const reloaded = loadProject(TEST_PROJECT_DIR);
    expect(reloaded!.meta.cover_image).toBe('assets/cover.png');
    expect(reloaded!.meta.project_id).toBe('12345');
  });

  it('migrateLegacyProjectJson 已有 project.yaml 时仅补缺字段，不覆盖 yaml 既有值', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    // yaml 已有 logline，json 带不同 logline + 额外 coverImage
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Yaml 名', 'novel', { logline: 'yaml-logline' }));
    writeFileSync(
      path.join(TEST_PROJECT_DIR, 'project.json'),
      JSON.stringify({ name: 'Json 名', logline: 'json-logline', coverImage: 'c.png' }),
      'utf8'
    );

    const doc = migrateLegacyProjectJson(TEST_PROJECT_DIR);

    expect(doc!.meta.name).toBe('Yaml 名');           // yaml 既有 name 不被覆盖
    expect(doc!.meta.logline).toBe('yaml-logline');    // yaml 既有 logline 不被覆盖
    expect(doc!.meta.cover_image).toBe('c.png');        // yaml 缺失的字段从 json 补齐
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.json'))).toBe(false);
  });

  it('migrateLegacyProjectJson 无 json 时返回现有 yaml（或 null），不做写删', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    expect(migrateLegacyProjectJson(TEST_PROJECT_DIR)).toBeNull();

    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('仅 yaml', 'novel'));
    const doc = migrateLegacyProjectJson(TEST_PROJECT_DIR);
    expect(doc!.meta.name).toBe('仅 yaml');
  });

  it('applies a replace patch (no-op for removed outline paths)', () => {
    const project = createEmptyProjectDocument('Demo');

    const updated = applyPatchOperations(project, [
      {
        op: 'replace',
        path: 'outline.acts[0].summary',
        value: 'New value'
      }
    ]);

    expect(updated.meta.version).toBe(2);
  });

  it('saveProject / loadProject 往返一致', () => {
    const project = createEmptyProjectDocument('Round Trip Test');
    saveProject(TEST_PROJECT_DIR, project);

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.name).toBe('Round Trip Test');
    expect(loaded!.meta.type).toBe('novel');
  });

  it('loadProject 对不存在的路径返回 null', () => {
    const loaded = loadProject(path.join(TEST_PROJECT_DIR, 'nonexistent'));
    expect(loaded).toBeNull();
  });

  it('saveProject 保存新创作字段后 loadProject 能读取', () => {
    const project = createEmptyProjectDocument('Creative Fields Test');
    const withFields = {
      ...project,
      world_setting: {
        premise: '永夜都市',
        era: '近未来',
        locations: [],
        rules: [],
        power_structures: [],
        taboos: [],
        visual_language: [],
        tone_rules: [],
        open_questions: []
      },
      asset_cards: [
        { id: 'c1', type: 'character' as const, name: '侦探', summary: '孤独调查者', tags: [], relationships: [], sourceRefs: [], status: 'active' as const, locked: false }
      ]
    };

    saveProject(TEST_PROJECT_DIR, withFields as any);
    const loaded = loadProject(TEST_PROJECT_DIR);

    expect(loaded!.world_setting).toBeDefined();
    expect(loaded!.world_setting!.premise).toBe('永夜都市');
    expect(loaded!.asset_cards).toBeDefined();
    expect(loaded!.asset_cards!.length).toBe(1);
    expect(loaded!.asset_cards![0].name).toBe('侦探');
  });

  // ── Story 2.6：applyFieldPatches story_decisions 分支（重放守卫单源 applyDecisionActions）──

  it('story_decisions patch：register 重放 -> novel.story_decisions 写入 + meta bump', () => {
    const project = createEmptyProjectDocument('Story Decisions Test');
    saveProject(TEST_PROJECT_DIR, project);

    applyFieldPatches(TEST_PROJECT_DIR, {
      runId: 'run_sd_1',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'story_decisions',
          action: 'set',
          data: {
            actions: [
              { op: 'register', decision: { id: 'd1', summary: '女主真背叛', reason: '妹妹被挟持', risk: '铺垫不足读者弃书', status: 'open', source: 'user' } },
            ],
          },
          fieldVersion: 1,
          generatedBy: 'leader',
        },
      ],
    });

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded!.novel!.story_decisions).toHaveLength(1);
    expect(loaded!.novel!.story_decisions![0].id).toBe('d1');
    expect(loaded!.novel!.story_decisions![0].status).toBe('open');
    expect(loaded!.novel!.story_decisions![0].source).toBe('user');
    expect(typeof loaded!.novel!.story_decisions![0].createdAt).toBe('string');
  });

  it('story_decisions patch：重放对 fresh 状态应用（staging 后磁盘已被改，register 撞 id 守卫拒）', () => {
    const project = createEmptyProjectDocument('Story Decisions Conflict Test');
    saveProject(TEST_PROJECT_DIR, project);

    // 磁盘上已有 decided d1（模拟 staging 与 accept 之间他人写入）。
    const seeded = loadProject(TEST_PROJECT_DIR)!;
    seeded.novel = { chapters: [], story_decisions: [
      { id: 'd1', summary: '已有', reason: 'r', risk: 'k', alternatives: [], status: 'decided', source: 'workbench', createdAt: '2026-08-01T00:00:00Z' },
    ] };
    saveProject(TEST_PROJECT_DIR, seeded);

    // envelope 携带 register d1（staging 时 d1 不存在）；fresh 状态下 decided->decided 非法 -> 拒。
    expect(() =>
      applyFieldPatches(TEST_PROJECT_DIR, {
        runId: 'run_sd_2',
        createdAt: new Date().toISOString(),
        patches: [
          {
            field: 'story_decisions',
            action: 'set',
            data: {
              actions: [
                { op: 'register', decision: { id: 'd1', summary: 'staging 时的', reason: 'r', risk: 'k', alternatives: [], status: 'decided', source: 'workbench' } },
              ],
            },
            fieldVersion: 1,
            generatedBy: 'leader',
          },
        ],
      }),
    ).toThrow();
  });

  it('story_decisions patch：user-source 决策无 force 的 supersede -> throw（守卫拒非静默）', () => {
    const project = createEmptyProjectDocument('Story Decisions Guard Test');
    saveProject(TEST_PROJECT_DIR, project);
    const seeded = loadProject(TEST_PROJECT_DIR)!;
    seeded.novel = { chapters: [], story_decisions: [
      { id: 'd1', summary: '作者拍板', reason: 'r', risk: 'k', alternatives: [], status: 'decided', source: 'user', createdAt: '2026-08-01T00:00:00Z' },
    ] };
    saveProject(TEST_PROJECT_DIR, seeded);

    expect(() =>
      applyFieldPatches(TEST_PROJECT_DIR, {
        runId: 'run_sd_3',
        createdAt: new Date().toISOString(),
        patches: [
          {
            field: 'story_decisions',
            action: 'set',
            data: {
              actions: [
                { op: 'supersede', oldId: 'd1', decision: { id: 'd2', summary: 'AI 想取代', reason: 'r', risk: 'k', alternatives: [], status: 'decided', source: 'workbench' } },
              ],
            },
            fieldVersion: 1,
            generatedBy: 'leader',
          },
        ],
      }),
    ).toThrow();
  });

  it('story_decisions patch：envelope 带 force=true -> user-source supersede 通过', () => {
    const project = createEmptyProjectDocument('Story Decisions Force Test');
    saveProject(TEST_PROJECT_DIR, project);
    const seeded = loadProject(TEST_PROJECT_DIR)!;
    seeded.novel = { chapters: [], story_decisions: [
      { id: 'd1', summary: '作者拍板', reason: 'r', risk: 'k', alternatives: [], status: 'decided', source: 'user', createdAt: '2026-08-01T00:00:00Z' },
    ] };
    saveProject(TEST_PROJECT_DIR, seeded);

    applyFieldPatches(TEST_PROJECT_DIR, {
      runId: 'run_sd_4',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'story_decisions',
          action: 'set',
          data: {
            force: true,
            actions: [
              { op: 'supersede', oldId: 'd1', decision: { id: 'd2', summary: '作者改主意', reason: 'r', risk: 'k', alternatives: [], status: 'decided', source: 'user' } },
            ],
          },
          fieldVersion: 1,
          generatedBy: 'leader',
        },
      ],
    });

    const loaded = loadProject(TEST_PROJECT_DIR);
    const decisions = loaded!.novel!.story_decisions!;
    expect(decisions).toHaveLength(2);
    expect(decisions.find((d) => d.id === 'd1')!.status).toBe('superseded');
    expect(decisions.find((d) => d.id === 'd1')!.supersededBy).toBe('d2');
    expect(decisions.find((d) => d.id === 'd2')!.status).toBe('decided');
  });

  it('story_decisions patch：actions 空或缺省 -> 静默跳过（零副作用不 bump 之外失败）', () => {
    const project = createEmptyProjectDocument('Story Decisions Empty Test');
    saveProject(TEST_PROJECT_DIR, project);

    expect(() =>
      applyFieldPatches(TEST_PROJECT_DIR, {
        runId: 'run_sd_5',
        createdAt: new Date().toISOString(),
        patches: [
          { field: 'story_decisions', action: 'set', data: {}, fieldVersion: 1, generatedBy: 'leader' },
        ],
      }),
    ).not.toThrow();
    expect(loadProject(TEST_PROJECT_DIR)!.novel?.story_decisions).toBeUndefined();
  });

  it('applyFieldPatches 正确更新字段和元信息', () => {
    const project = createEmptyProjectDocument('Patch Test');
    saveProject(TEST_PROJECT_DIR, project);

    const fieldPatch: ProjectFieldPatch = {
      runId: 'run_test_123',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'world_setting',
          action: 'set',
          data: { premise: '赛博朋克', era: '2077', locations: [], rules: [], power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: [] },
          fieldVersion: 1,
          generatedBy: 'asset-loader-agent'
        },
        {
          field: 'asset_cards',
          action: 'set',
          data: [{ id: 'c1', type: 'character', name: 'V', summary: '主角', tags: [], relationships: [], sourceRefs: [], status: 'active', locked: false }],
          fieldVersion: 1,
          generatedBy: 'asset-loader-agent'
        }
      ]
    };

    const updated = applyFieldPatches(TEST_PROJECT_DIR, fieldPatch);

    expect(updated.world_setting).toBeDefined();
    expect(updated.world_setting!.premise).toBe('赛博朋克');
    expect(updated.asset_cards).toBeDefined();
    expect(updated.asset_cards!.length).toBe(1);
    expect(updated.field_metadata).toBeDefined();
    expect(updated.field_metadata!.world_setting).toBeDefined();
    expect(updated.field_metadata!.world_setting!.version).toBe(1);
    expect(updated.field_metadata!.world_setting!.source).toBe('agent');
    expect(updated.meta.version).toBe(2);
  });

  it('applyFieldPatches 跳过 fieldVersion 早于当前版本的过期补丁', () => {
    const project = createEmptyProjectDocument('Stale Patch Test');
    saveProject(TEST_PROJECT_DIR, project);

    // 先写入 version 3 的字段
    applyFieldPatches(TEST_PROJECT_DIR, {
      runId: 'run_v3',
      createdAt: new Date().toISOString(),
      patches: [{
        field: 'world_setting',
        action: 'set',
        data: { premise: '当前内容', era: '', locations: [], rules: [], power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: [] },
        fieldVersion: 3,
        generatedBy: 'agent-a'
      }]
    });

    // 再尝试用 version 2(过期)的补丁覆盖,应被跳过
    const updated = applyFieldPatches(TEST_PROJECT_DIR, {
      runId: 'run_v2_stale',
      createdAt: new Date().toISOString(),
      patches: [{
        field: 'world_setting',
        action: 'set',
        data: { premise: '过期内容', era: '', locations: [], rules: [], power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: [] },
        fieldVersion: 2,
        generatedBy: 'agent-b'
      }]
    });

    expect(updated.world_setting!.premise).toBe('当前内容');
    expect(updated.field_metadata!.world_setting!.version).toBe(3);
  });

  // Story 3.1 WP5: locked 字段不再静默 skip——applyFieldPatchesWithSkipped 收集
  // skipped[] 回传调用方（IPC → UI/leader 知会作者）。
  it('applyFieldPatchesWithSkipped 收集 locked 字段到 skipped[] 并返回 applied', () => {
    const project = createEmptyProjectDocument('Skipped Lock Test');
    saveProject(TEST_PROJECT_DIR, project);

    // 先应用一次 world_setting patch 以建立 metadata（version → 1）
    const seedData = { premise: '初始', era: '', locations: [], rules: [], power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: [] };
    applyFieldPatches(TEST_PROJECT_DIR, {
      runId: 'run_seed',
      createdAt: new Date().toISOString(),
      patches: [{ field: 'world_setting', action: 'set', data: seedData, fieldVersion: 1, generatedBy: 'agent-seed' }]
    });

    // 锁定 world_setting
    const loaded = loadProject(TEST_PROJECT_DIR)!;
    const locked = {
      ...loaded,
      field_metadata: {
        ...loaded.field_metadata,
        world_setting: { ...loaded.field_metadata!.world_setting!, locked: true }
      }
    };
    saveProject(TEST_PROJECT_DIR, locked);

    const fieldPatch: ProjectFieldPatch = {
      runId: 'run_locked',
      createdAt: new Date().toISOString(),
      patches: [{
        field: 'world_setting',
        action: 'set',
        data: { premise: '被锁定不应写入', era: '', locations: [], rules: [], power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: [] },
        fieldVersion: 2,
        generatedBy: 'agent-x'
      }]
    };

    const { applied, skipped } = applyFieldPatchesWithSkipped(TEST_PROJECT_DIR, fieldPatch);

    // locked 字段未被写入（仍是 seed 的 '初始'）
    expect(applied.world_setting?.premise).toBe('初始');
    // skipped 收集了 locked 原因
    expect(skipped).toEqual([{ field: 'world_setting', reason: 'locked' }]);
  });

  // Story 3.4（C-A5 footgun 修）：applyFieldPatchesWithSkipped creative 分支补 markStaleFields 对称调用。
  // 此前该函数写 creative field + 清自身 stale（stale:false）但不标下游 stale → propagation 断
  // （field:apply-agent-patch 路径与 field:sync 路径行为不对称）。修后改 asset_cards 应标 scene_graph
  // 等下游 stale（mirror onFieldEdited 行为）。
  it('applyFieldPatchesWithSkipped 对 creative field patch 标下游 stale（C-A5 footgun 修）', () => {
    const project = createEmptyProjectDocument('Stale Propagation Test');
    saveProject(TEST_PROJECT_DIR, project);

    const fieldPatch: ProjectFieldPatch = {
      runId: 'run_stale_test',
      createdAt: new Date().toISOString(),
      patches: [{
        field: 'asset_cards',
        action: 'set',
        data: [{ id: 'c1', type: 'character', name: '角色A', summary: '', tags: [], relationships: [], sourceRefs: [], status: 'active', locked: false }],
        fieldVersion: 1,
        generatedBy: 'agent-test'
      }]
    };

    applyFieldPatchesWithSkipped(TEST_PROJECT_DIR, fieldPatch);

    // 重读验证持久化
    const loaded = loadProject(TEST_PROJECT_DIR)!;
    // 被 patch 的字段自身 stale=false（刚写）
    expect(loaded.field_metadata!.asset_cards!.stale).toBe(false);
    // 下游应被标 stale（mirror onFieldEdited 行为）
    expect(loaded.field_metadata!.world_setting!.stale).toBe(true);
    expect(loaded.field_metadata!.outline!.stale).toBe(true);
    expect(loaded.field_metadata!.scene_graph?.stale).toBe(true); // Story 3.4 新边
    expect(loaded.field_metadata!.episode_outlines?.stale).toBe(true);
  });

  it('applyFieldPatchesWithSkipped 对 scene_graph 新边：改 outline → scene_graph stale', () => {
    const project = createEmptyProjectDocument('Scene Graph Edge Test');
    saveProject(TEST_PROJECT_DIR, project);

    const fieldPatch: ProjectFieldPatch = {
      runId: 'run_outline_test',
      createdAt: new Date().toISOString(),
      patches: [{
        field: 'outline',
        action: 'set',
        data: { central_conflict: '核心冲突', major_turning_points: [], ending_direction: '结局', constraints: [] },
        fieldVersion: 1,
        generatedBy: 'agent-test'
      }]
    };

    applyFieldPatchesWithSkipped(TEST_PROJECT_DIR, fieldPatch);

    const loaded = loadProject(TEST_PROJECT_DIR)!;
    expect(loaded.field_metadata!.outline!.stale).toBe(false);
    // outline → scene_graph（Story 3.4 新边）
    expect(loaded.field_metadata!.scene_graph?.stale).toBe(true);
    expect(loaded.field_metadata!.growth_curve?.stale).toBe(true);
  });

  it('applyFieldPatchesWithSkipped batch：同 batch 内被 patch 的下游不被重标 stale', () => {
    // 边缘 case：batch 同时 patch A 和 B（A→B），B 刚被写 stale:false，不应被 A 的传播覆盖回 true。
    const project = createEmptyProjectDocument('Batch Skip Test');
    saveProject(TEST_PROJECT_DIR, project);

    const fieldPatch: ProjectFieldPatch = {
      runId: 'run_batch_test',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'asset_cards',
          action: 'set',
          data: [{ id: 'c1', type: 'character', name: '角色', summary: '', tags: [], relationships: [], sourceRefs: [], status: 'active', locked: false }],
          fieldVersion: 1,
          generatedBy: 'agent-test'
        },
        {
          field: 'outline',
          action: 'set',
          data: { central_conflict: '冲突', major_turning_points: [], ending_direction: '结局', constraints: [] },
          fieldVersion: 1,
          generatedBy: 'agent-test'
        }
      ]
    };

    applyFieldPatchesWithSkipped(TEST_PROJECT_DIR, fieldPatch);

    const loaded = loadProject(TEST_PROJECT_DIR)!;
    // 两者刚被 patch → stale=false（不被对方传播覆盖）
    expect(loaded.field_metadata!.asset_cards!.stale).toBe(false);
    expect(loaded.field_metadata!.outline!.stale).toBe(false);
    // 未在 batch 中的下游仍被标 stale
    expect(loaded.field_metadata!.scene_graph?.stale).toBe(true);
    expect(loaded.field_metadata!.growth_curve?.stale).toBe(true);
  });

  it('loadProject 对空或损坏的 project.yaml 返回 null 而非抛错', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    // 空文件 -> YAML.parse 得到 null
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), '', 'utf8');
    expect(loadProject(TEST_PROJECT_DIR)).toBeNull();

    // 标量(非对象)内容
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), 'just-a-string', 'utf8');
    expect(loadProject(TEST_PROJECT_DIR)).toBeNull();
  });

  it('loadProject 自愈：从「合法前缀 + 残留尾巴」损坏中抢救数据并备份坏文件', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    // 复刻真实损坏特征：合法文档到 `shots: []` 结束，后接旧版本残留尾巴
    // （孤儿 updated_at + 垃圾字节），且合法前缀的 meta 缺 updated_at。
    const corrupt = [
      'meta:',
      '  id: 2bb8e07a-d41a-4785-8dfc-cef994ee42b4',
      '  name: X',
      '  type: novel',
      '  project_id: "00001"',
      '  version: 10',
      '  created_at: 2026-06-13T15:44:39.644Z',
      'novel:',
      '  chapters: []',
      'storyboard:',
      '  shots: []',
      '35Zz',
      '  updated_at: 2026-06-13T17:02:46.8',
    ].join('\n');
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), corrupt, 'utf8');

    const doc = loadProject(TEST_PROJECT_DIR);

    // 合法前缀里的真实数据被保留，而非丢弃后用目录名兜底。
    expect(doc).not.toBeNull();
    expect(doc!.meta.id).toBe('2bb8e07a-d41a-4785-8dfc-cef994ee42b4');
    expect(doc!.meta.name).toBe('X');
    expect(doc!.meta.version).toBe(10);
    expect(doc!.meta.project_id).toBe('00001');
    // 损坏截断丢失的必填字段被补默认值，使其通过 schema 校验。
    expect(typeof doc!.meta.updated_at).toBe('string');
    expect(doc!.storyboard.shots).toEqual([]);

    // 坏文件被改名备份（never silently destroyed），原路径让位给自愈重写。
    // T22-bff：备份落**项目外**隔离区（文件树不再出现吓人的 .corrupt-* 残留）。
    const inProject = readdirSync(TEST_PROJECT_DIR).filter((f) => f.includes('.corrupt-'));
    expect(inProject.length).toBe(0);
    const quarantined = readdirSync(testQuarantineProjectDir()).filter((f) => f.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
  });

  it('loadProject 自愈：完全无法解析时返回 null 并备份，交给 bootstrap 重建', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    // 单行不平衡 flow，任何前缀都解析失败，没有可抢救的对象。
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), '{[unbalanced: flow', 'utf8');

    expect(loadProject(TEST_PROJECT_DIR)).toBeNull();
    const inProject = readdirSync(TEST_PROJECT_DIR).filter((f) => f.includes('.corrupt-'));
    expect(inProject.length).toBe(0);
    const quarantined = readdirSync(testQuarantineProjectDir()).filter((f) => f.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
  });

  it('applyFieldPatches 支持 chapter_candidate 类型的补丁', () => {
    const project = createEmptyProjectDocument('Chapter Candidate Patch');
    // 预置一个章节（新结构：sections）
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: 'ch_001',
            title: '旧标题',
            sort_order: 0,
            sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
            status: 'generating',
            last_run_id: 'run_pre',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const chapterPatch = {
      runId: 'run_candidate_1',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            chapterId: 'ch_001',
            runId: 'run_candidate_1',
            candidate: {
              title: '第1章 新标题',
              content: '更新后的章节内容。',
              summary: '新摘要。',
              wordCount: 42,
            },
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
      ],
    };

    const updated = applyFieldPatches(TEST_PROJECT_DIR, chapterPatch);

    // 验证章节元数据已更新
    expect(updated.novel).toBeDefined();
    expect(updated.novel!.chapters[0].title).toBe('第1章 新标题');
    expect(updated.novel!.chapters[0].summary).toBe('新摘要。');
    expect(updated.novel!.chapters[0].word_count).toBe(42);
    expect(updated.novel!.chapters[0].status).toBe('draft');

    // 验证 meta version 递增
    expect(updated.meta.version).toBe(2);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // #107 check 批补缝：chapter_candidate accept 覆写保序——candidate.content 是 draft
  // 正文（无 frontmatter），整体覆盖会把已注册章文件的 frontmatter `order:`（#107 登记载体）
  // 物理抹掉 → 派生重排错位。修法 = 旧文件有 frontmatter 且新内容无 → 旧块回拼
  // （shared-contracts preserveChapterFrontmatter，mirror novelProjectRepository 同款）。
  // ───────────────────────────────────────────────────────────────────────────

  it('#107 check 批：chapter_candidate 覆写带 frontmatter 的已注册章 → order 保留（正文替换）', () => {
    const project = createEmptyProjectDocument('FM Preserve Patch');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: '第01章-旧章',
            title: '旧章',
            sort_order: 0,
            sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/第01章-旧章.md' }],
            status: 'draft',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);
    const mdDir = path.join(TEST_PROJECT_DIR, 'chapters');
    if (!existsSync(mdDir)) mkdirSync(mdDir, { recursive: true });
    writeFileSync(path.join(mdDir, '第01章-旧章.md'), '---\norder: 0\n---\n\n# 旧章\n\n旧正文。', 'utf8');

    const chapterPatch = {
      runId: 'run_fm_patch',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            chapterId: '第01章-旧章',
            runId: 'run_fm_patch',
            candidate: { title: '新章', content: '# 新标题\n\n新正文。' },
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
      ],
    };

    applyFieldPatches(TEST_PROJECT_DIR, chapterPatch);

    const md = readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/第01章-旧章.md'), 'utf8');
    expect(md).toBe('---\norder: 0\n---\n# 新标题\n\n新正文。');
    // 章节元数据照常更新（保序不改变 accept 语义）。
    const updated = loadProject(TEST_PROJECT_DIR)!;
    expect(updated.novel!.chapters[0].title).toBe('新章');
  });

  it('#107 check 批：外编 CRLF 旧章 → 回拼落盘纯 LF（读侧归一，\\r 零残留）', () => {
    const project = createEmptyProjectDocument('FM Preserve CRLF');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: '第01章-旧章',
            title: '旧章',
            sort_order: 0,
            sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/第01章-旧章.md' }],
            status: 'draft',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);
    const mdDir = path.join(TEST_PROJECT_DIR, 'chapters');
    if (!existsSync(mdDir)) mkdirSync(mdDir, { recursive: true });
    writeFileSync(
      path.join(mdDir, '第01章-旧章.md'),
      '---\r\norder: 0\r\n---\r\n\r\n# 旧章\r\n\r\n旧正文。',
      'utf8',
    );

    const chapterPatch = {
      runId: 'run_fm_crlf',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            chapterId: '第01章-旧章',
            runId: 'run_fm_crlf',
            candidate: { title: '新章', content: '# 新标题\n\n新正文。' },
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
      ],
    };

    applyFieldPatches(TEST_PROJECT_DIR, chapterPatch);

    const md = readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/第01章-旧章.md'), 'utf8');
    expect(md).toBe('---\norder: 0\n---\n# 新标题\n\n新正文。');
    expect(md.includes('\r')).toBe(false);
  });

  it('4.1 Step 4：chapter_candidate 补丁带 storyDecisions → 追加到 novel.story_decisions（经 core）', () => {
    const project = createEmptyProjectDocument('Chapter Candidate StoryDecisions');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: 'ch_001',
            title: '旧标题',
            sort_order: 0,
            sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
            status: 'generating',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const decision = {
      id: 'accept-run_x',
      summary: '正文偏离计划',
      reason: '角色硬气',
      alternatives: [],
      risk: '须校正',
      status: 'decided' as const,
      source: 'accept_as_truth' as const,
      relatedEpisodeId: 'ep1',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const chapterPatch = {
      runId: 'run_x',
      createdAt: '2026-08-01T00:00:00.000Z',
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            chapterId: 'ch_001',
            runId: 'run_x',
            candidate: { title: '第1章 新', content: '新内容。' },
            storyDecisions: [decision],
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
      ],
    };

    const updated = applyFieldPatches(TEST_PROJECT_DIR, chapterPatch);

    // story_decisions 追加到 novel.story_decisions（经 acceptChapterCandidateCore）
    expect(updated.novel!.story_decisions).toEqual([decision]);
    // 章节元数据也更新（core 共用逻辑）
    expect(updated.novel!.chapters[0].title).toBe('第1章 新');
    expect(updated.novel!.chapters[0].status).toBe('draft');
    // markdown 文件落盘
    expect(readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/ch_001.md'), 'utf8')).toBe('新内容。');
  });

  // CR-4.1-04：core null（章未注册 / 无 section）不再静默 skip + 假版本 bump——applyFieldPatches 收集
  // 错误 loop-end throw，使 applyAgentFieldPatch IPC reject → UI creativeFieldsSlice .catch → toast。
  it('CR-4.1-04：chapter_candidate 指向未注册章 → throw（非静默丢 + 假版本 bump）', () => {
    const project = createEmptyProjectDocument('Chapter Not Registered');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: 'ch_001',
            title: '已注册章',
            sort_order: 0,
            sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
            status: 'generating',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const chapterPatch = {
      runId: 'run_missing_ch',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            // ch_999 不在 novel.chapters → core 返 null。
            chapterId: 'ch_999',
            runId: 'run_missing_ch',
            candidate: { title: '幽灵章', content: '不该落盘。' },
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
      ],
    };

    // throw 而非静默 resolve——文案含 chapterId，对齐 standalone acceptChapterCandidate。
    expect(() => applyFieldPatches(TEST_PROJECT_DIR, chapterPatch)).toThrow(/ch_999/);

    // 幽灵章正文不该落盘（core null 不写 md）。
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'chapters/ch_999.md'))).toBe(false);
  });

  // CR-4.1-04 + CR-4.1-05 协同：同 batch 多 candidate，有效项落盘 + 失败项 throw（不互丢、不静默）。
  it('CR-4.1-04：同 batch 有效 + 无效 chapter_candidate → 有效项落盘，throw 报无效项', () => {
    const project = createEmptyProjectDocument('Mixed Candidate Batch');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: 'ch_001',
            title: '有效章',
            sort_order: 0,
            sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
            status: 'generating',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const chapterPatch = {
      runId: 'run_mixed',
      createdAt: new Date().toISOString(),
      patches: [
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            chapterId: 'ch_001',
            runId: 'run_mixed',
            candidate: { title: '有效章 新标题', content: '有效章正文。' },
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
        {
          field: 'chapter_candidate' as any,
          action: 'set' as const,
          data: {
            chapterId: 'ch_999', // 未注册
            runId: 'run_mixed',
            candidate: { title: '幽灵章', content: '不该落盘。' },
          },
          fieldVersion: 1,
          generatedBy: 'draft-writer-agent',
        },
      ],
    };

    // throw 报无效项（ch_999），但不吞掉有效项。
    expect(() => applyFieldPatches(TEST_PROJECT_DIR, chapterPatch)).toThrow(/ch_999/);
    // 有效项正文落盘（CR-4.1-04：有效 candidate 仍照常 persist，仅失败项 throw）。
    expect(readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/ch_001.md'), 'utf8')).toBe('有效章正文。');
    // 幽灵章正文不落盘。
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'chapters/ch_999.md'))).toBe(false);
  });

  it('旧格式文档（含 assets.characters）加载时自动派生 asset_cards', () => {
    const project = createEmptyProjectDocument('Legacy Test');
    const withOldAssets = {
      ...project,
      assets: {
        characters: [
          { id: 'char_1', name: '张三', appearance: '高大', personality: '沉稳' }
        ],
        locations: [
          { id: 'loc_1', name: '办公室', description: '现代风格' }
        ]
      }
    };

    saveProject(TEST_PROJECT_DIR, withOldAssets as any);
    const loaded = loadProject(TEST_PROJECT_DIR);

    expect(loaded!.assets).toBeDefined();
    expect(loaded!.asset_cards).toBeDefined();
    expect(loaded!.asset_cards!.length).toBe(1);
    expect(loaded!.asset_cards![0].name).toBe('张三');
    expect(loaded!.asset_cards![0].type).toBe('character');
  });

  it('旧格式 outline 会迁移到 outline_v2，而不是被直接丢弃', () => {
    const project = createEmptyProjectDocument('Legacy Outline Test');
    const withLegacyOutline = {
      ...project,
      outline: {
        title: '旧提纲标题',
        logline: '旧 logline',
        genre: '悬疑',
        theme: '真相与背叛',
        acts: [
          { id: 'act_1', title: '开端', summary: '主角进入案件' },
          { id: 'act_2', title: '反转', summary: '真凶浮现' },
        ],
      },
    };

    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withLegacyOutline), 'utf8');
    const loaded = loadProject(TEST_PROJECT_DIR);

    expect(loaded!.outline_v2).toBeDefined();
    expect(loaded!.meta.logline).toBe('旧 logline');
    expect(loaded!.meta.genre).toBe('悬疑');
    expect(loaded!.meta.theme).toBe('真相与背叛');
    expect(loaded!.meta.synopsis).toContain('开端');
    expect(loaded!.meta.synopsis).toContain('主角进入案件');
    // Story 1.2: major_turning_points upgraded to typed anchors. Legacy string
    // '反转' migrates to {type:'core-anchor', label:'反转'} (design §6).
    expect(loaded!.outline_v2!.major_turning_points).toContainEqual({ type: 'core-anchor', label: '反转' });
  });

  it('pre-1.2 outline_v2 string[] turning points + scene_graph string visibility 迁移到 typed/union (CR-003/CR-004)', () => {
    const project = createEmptyProjectDocument('Pre-1.2 Migration Test');
    const withOldShapes = {
      ...project,
      outline_v2: {
        ...(project.outline_v2 ?? {}),
        major_turning_points: ['发现真相', '背叛'],  // pre-1.2 string[] form
      },
      scene_graph: {
        nodes: [],
        edges: [],
        lines: [
          { id: 'line_1', name: '主线', topology_role: 'converging', visibility: 'open' },
        ],
      },
    };

    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withOldShapes), 'utf8');
    const loaded = loadProject(TEST_PROJECT_DIR);

    // CR-003/CR-009: string[] major_turning_points → typed anchors; project loads (not silent-reset).
    expect(loaded).not.toBeNull();
    expect(loaded!.outline_v2!.major_turning_points).toContainEqual({ type: 'core-anchor', label: '发现真相' });
    expect(loaded!.outline_v2!.major_turning_points).toContainEqual({ type: 'core-anchor', label: '背叛' });
    // CR-004/CR-010: string visibility literal → discriminated union {status:'open'}.
    expect(loaded!.scene_graph!.lines[0].visibility).toEqual({ status: 'open' });
  });

  it('pre-1.3 scene_graph with cropped edge types migrates to CAUSAL/SUSPENSE-only (CR-019/CR-009)', () => {
    const project = createEmptyProjectDocument('Pre-1.3 Edge Crop Test');
    const withOldEdges = {
      ...project,
      scene_graph: {
        nodes: [
          { id: 's1', lineTags: ['l1'], storyTime: 1, presentationOrder: { chapter: 0, pos: 0 }, role: 'normal' },
          { id: 's2', lineTags: ['l1'], storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, role: 'normal' },
          { id: 's3', lineTags: ['l1'], storyTime: 3, presentationOrder: { chapter: 0, pos: 2 }, role: 'normal' },
        ],
        edges: [
          { id: 'e1', from: 's1', to: 's2', type: 'CAUSAL' },        // kept
          { id: 'e2', from: 's2', to: 's3', type: 'SUSPENSE' },      // kept
          { id: 'e3', from: 's1', to: 's3', type: 'FORESHADOW' },    // cropped
          { id: 'e4', from: 's2', to: 's1', type: 'REVERSAL' },      // cropped
          { id: 'e5', from: 's1', to: 's2', type: 'SHARED-MOTIF' },  // cropped
          { id: 'e6', from: 's3', to: 's1', type: 'WORLD-COUPLING' },// cropped
        ],
        lines: [{ id: 'l1', name: '主线', topology_role: 'converging', convergence_target: 's3' }],
      },
    };

    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withOldEdges), 'utf8');
    const loaded = loadProject(TEST_PROJECT_DIR);

    // CR-019/CR-009: strict parse would otherwise throw on cropped edge types ->
    // whole project judged corrupt + rebuilt empty. Migration drops them so the
    // project loads (not silent-reset) and only CAUSAL/SUSPENSE edges remain.
    expect(loaded).not.toBeNull();
    expect(loaded!.scene_graph).toBeDefined();
    expect(loaded!.scene_graph!.edges).toHaveLength(2);
    expect(loaded!.scene_graph!.edges.map((e) => e.type).sort()).toEqual(['CAUSAL', 'SUSPENSE']);
    expect(loaded!.scene_graph!.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Story 6.5 Phase B：foreshadow_registry → promise_registry loadProject 就地迁移。
  // 范式：迁移 transform = 纯代码机械映射（Phase A transformForeshadowToPromise），无 LLM。
  // 复用既有 5 个迁移先例的模式（:96-224 outline→outline_v2 / assets.characters→asset_cards /
  // scene_edge FORESHADOW crop）。直接 YAML 写盘绕过 schema 验证，模拟旧版本持久化的项目。
  // ════════════════════════════════════════════════════════════════════════════

  it('旧格式 foreshadow_registry 迁移到 promise_registry（全 status 映射 + parse 通过 + foreshadow 删除）', () => {
    // 模拟旧版本（Phase A 前）持久化的项目：含已退役的 foreshadow_registry。
    // 不经 saveProject（新 schema 会拒收 foreshadow_registry），直接 YAML 写盘。
    const project = createEmptyProjectDocument('Legacy Foreshadow Migration');
    const withOldForeshadow = {
      ...project,
      foreshadow_registry: {
        items: [
          { id: 'fs_planted', title: '神秘钥匙', content: '主角捡到古老钥匙', status: 'planted', plant_ref: 'scene_1' },
          { id: 'fs_resolved', title: '身世之谜', content: '主角真实身世', status: 'resolved', plant_ref: 'scene_1', actual_resolve_ref: 'scene_20' },
          { id: 'fs_abandoned', title: '废弃线', content: '弃用的线索', status: 'abandoned' },
        ],
        version: 3,
        updatedBy: 'user',
      },
    };

    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withOldForeshadow), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);

    // 迁移成功 → parse 通过（否则整项目判 corrupt + 重建空，interface-contracts convention）。
    expect(loaded).not.toBeNull();
    // promise_registry 已建（迁移产物）。
    expect(loaded!.promise_registry).toBeDefined();
    // foreshadow_registry 已删（退役 key 留在 parsed 会判 corrupt）。
    expect((loaded as any).foreshadow_registry).toBeUndefined();

    // status 映射（design §6）：planted→open / resolved→fulfilled / abandoned→abandoned。
    const promises = loaded!.promise_registry!.promises;
    expect(promises).toHaveLength(3);
    const byId = new Map(promises.map((p) => [p.id, p]));
    expect(byId.get('fs_planted')!.status).toBe('open');
    expect(byId.get('fs_resolved')!.status).toBe('fulfilled');
    expect(byId.get('fs_abandoned')!.status).toBe('abandoned');

    // beats 生成：planted 1 beat（plant）+ resolved 2 beats（plant+payoff）+ abandoned 0 beat。
    const beats = loaded!.promise_registry!.beats;
    expect(beats).toHaveLength(3);
    const plantedBeats = beats.filter((b) => b.promiseId === 'fs_planted');
    expect(plantedBeats).toHaveLength(1);
    expect(plantedBeats[0].kind).toBe('plant');
    expect(plantedBeats[0].sceneRef).toBe('scene_1');
    const resolvedBeats = beats.filter((b) => b.promiseId === 'fs_resolved');
    expect(resolvedBeats).toHaveLength(2);
    expect(resolvedBeats.map((b) => b.kind).sort()).toEqual(['payoff', 'plant']);
  });

  it('foreshadow→promise 迁移零删数据（title/content→summary/importance/tags/relations 保留）', () => {
    const project = createEmptyProjectDocument('Zero Data Loss Migration');
    const withOldForeshadow = {
      ...project,
      foreshadow_registry: {
        items: [
          {
            id: 'fs_key',
            title: 'red key',
            content: 'A red key appears before the locked tower.',
            status: 'pending',
            plant_ref: 'scene_1',
            importance: 0.8,
            tags: ['主线', '关键'],
            category: 'item',
            related_asset_ids: ['prop_red_key'],
            related_foreshadow_ids: ['fs_other'],
            notes: '手动备注',
            hint_text: '钥匙发光暗示',
          },
        ],
        version: 7,
        updatedBy: 'user',
      },
    };

    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withOldForeshadow), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();

    const promise = loaded!.promise_registry!.promises[0];
    // id/title 直映；content → summary；importance 保留。
    expect(promise.id).toBe('fs_key');
    expect(promise.title).toBe('red key');
    expect(promise.summary).toBe('A red key appears before the locked tower.');
    expect(promise.importance).toBe(0.8);
    // 迁移标记：source_type=migrated_foreshadow + category=setup_payoff（foreshadow 是 setup_payoff 子类）。
    expect(promise.source_type).toBe('migrated_foreshadow');
    expect(promise.category).toBe('setup_payoff');
    // tags 迁移 + 原 category 追加为 fs:<category>（零删数据）。
    expect(promise.tags).toContain('主线');
    expect(promise.tags).toContain('关键');
    expect(promise.tags).toContain('fs:item');
    // relations 保留（related_foreshadow_ids → related_promise_ids，id 不变字段改名）。
    expect(promise.related_asset_ids).toEqual(['prop_red_key']);
    expect(promise.related_promise_ids).toEqual(['fs_other']);
    // notes 拼接（零删数据——hint/resolution 无 Promise 等价字段，进 notes 保留）。
    expect(promise.notes).toContain('手动备注');
    expect(promise.notes).toContain('[暗示] 钥匙发光暗示');
    // version/updatedBy 保留。
    expect(loaded!.promise_registry!.version).toBe(7);
    expect(loaded!.promise_registry!.updatedBy).toBe('user');
  });

  it('无 foreshadow_registry 的新项目不受迁移影响', () => {
    // 新项目（Phase A 后持久化）：无 foreshadow_registry，迁移条件跳过。
    const project = createEmptyProjectDocument('No Foreshadow Unaffected');
    saveProject(TEST_PROJECT_DIR, project);

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.name).toBe('No Foreshadow Unaffected');
    // promise_registry 未设（optional，无 foreshadow 可迁移）。
    expect(loaded!.promise_registry).toBeUndefined();
  });

  it('已有 promise_registry 不被 foreshadow 迁移覆盖（&& !promise_registry 守卫）', () => {
    // 已迁移或新建的项目：已有 promise_registry（手填/agent 产），无 foreshadow_registry。
    // 迁移条件 `foreshadow_registry && !promise_registry` 不满足 → 跳过，promise_registry 保留。
    const project = createEmptyProjectDocument('Existing Promise Preserved');
    const withPromise = {
      ...project,
      promise_registry: {
        promises: [
          { id: 'existing_p', title: '已有 Promise', summary: '不应被覆盖', importance: 0.9 },
        ],
        beats: [],
        version: 5,
        updatedBy: 'agent',
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withPromise), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.promise_registry).toBeDefined();
    expect(loaded!.promise_registry!.promises).toHaveLength(1);
    expect(loaded!.promise_registry!.promises[0].id).toBe('existing_p');
    expect(loaded!.promise_registry!.promises[0].title).toBe('已有 Promise');
    expect(loaded!.promise_registry!.version).toBe(5);
    expect(loaded!.promise_registry!.updatedBy).toBe('agent');
  });

  it('malformed foreshadow_registry（全坏条目）→ per-element 容错产空 registry + delete 旧 key（降级不 wedge）', () => {
    // E5 fix（CR-E5）：transform 内 per-element safeParse 容错——单个坏 foreshadow 条目（缺 content / status
    // 越界等）不丢全 registry，坏条目跳过 + console.warn，好条目正常迁移（mirror CR-4.1-07 story_decisions 先例）。
    // 旧 registry-level safeParse gate 已移除（1 坏条目致整 registry safeParse 失败 → 丢全 registry 好数据）。
    // 此测试：全坏条目（1 个缺 content）→ per-element 全跳过 → 产合法空 registry（非 undefined，transform 输出
    // 恒经 promiseRegistrySchema.parse 校验）。loadProject 不 crash、不判 corrupt。
    const project = createEmptyProjectDocument('Malformed Foreshadow');
    const withMalformed = {
      ...project,
      foreshadow_registry: {
        items: [
          { id: 'fs_bad', title: '缺 content 的 entry' } // content 是 required（.min(1) 无 default）→ safeParse 失败
        ],
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withMalformed), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = loadProject(TEST_PROJECT_DIR);
    // 不 crash、不判 corrupt（loadProject 返非 null，整项目其他数据存活）。
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.name).toBe('Malformed Foreshadow');
    // promise_registry 为合法空 registry（per-element 全跳过 → 0 好条目，transform 输出空 registry，非 undefined）。
    expect(loaded!.promise_registry).toBeDefined();
    expect(loaded!.promise_registry!.promises).toEqual([]);
    expect(loaded!.promise_registry!.beats).toEqual([]);
    // foreshadow_registry 已删（退役 key 留在 parsed 会判 corrupt）。
    expect((loaded as any).foreshadow_registry).toBeUndefined();
    // 坏条目被 console.warn 跳过（transform per-element 容错信号）。
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('E5：1 坏 + 多好 foreshadow 条目 → 好条目迁移 + 坏条目跳过（per-element 容错，不丢全 registry）', () => {
    // E5 fix 核心断言：registry-level safeParse gate 移除后，1 坏条目不再致整 registry 丢失。
    // 19 好 + 1 坏 → 19 好迁移成 promise + 1 坏 console.warn 跳过，registry 不丢好数据。
    const project = createEmptyProjectDocument('Mixed Foreshadow');
    const goodEntries = Array.from({ length: 19 }, (_, i) => ({
      id: `fs_good_${i}`,
      title: `好条目 ${i}`,
      content: `内容 ${i}`,
      status: 'planted',
      plant_ref: `scene_${i}`,
    }));
    const withMixed = {
      ...project,
      foreshadow_registry: {
        items: [
          ...goodEntries,
          { id: 'fs_bad', title: '缺 content 的坏条目' }, // content required 缺 → safeParse 失败 → 跳过
        ],
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withMixed), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.promise_registry).toBeDefined();
    // 19 好条目全迁移（1 坏跳过，不丢全 registry）。
    expect(loaded!.promise_registry!.promises).toHaveLength(19);
    expect(loaded!.promise_registry!.promises.map((p) => p.id)).toContain('fs_good_0');
    expect(loaded!.promise_registry!.promises.map((p) => p.id)).not.toContain('fs_bad');
    // 坏条目被 console.warn 跳过（per-element 容错）。
    expect(warn).toHaveBeenCalled();
    // foreshadow_registry 已删。
    expect((loaded as any).foreshadow_registry).toBeUndefined();
    warn.mockRestore();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Story 8.5 Step 2：growth_curve array canonical（宽容读 union）+ outline_v2 假字段重命名
  // loadProject 迁移（design §2.1 D2 / §7 D3，mirror 上方 foreshadow-migration 直接 YAML 写盘
  // 绕过新 schema 的 fixture 模式——模拟 8.5 前旧版本持久化的项目）。
  // ════════════════════════════════════════════════════════════════════════════

  it('旧单条 growth_curve → array canonical（包成数组 + 值全保留 + defaults 填充，零 migration）', () => {
    // 旧 schema 声明是单条 growthCurveSchema（Step 2 前的持久化形态）。
    const project = createEmptyProjectDocument('Legacy Single Growth Curve');
    const withLegacy = {
      ...project,
      growth_curve: {
        character_id: 'char-lin',
        start_state: '山村少年，隐忍求存',
        wound_or_lack: '被灭门之痛',
        desire: '查清真相复仇',
        need: '放下恨意守护活着的人',
        turning_points: [{ turning_point: '发现父亲遗信', linked_episode_ids: ['ep3'] }],
        end_state: '执剑者',
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withLegacy), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    // 迁移/归一成功 → parse 通过（否则整项目判 corrupt + 重建空）。
    expect(loaded).not.toBeNull();
    // 输出恒 array canonical（growthCurveFieldSchema union transform）。
    expect(Array.isArray(loaded!.growth_curve)).toBe(true);
    expect(loaded!.growth_curve).toHaveLength(1);
    const curve = loaded!.growth_curve![0];
    // 值全保留（零数据丢失）。
    expect(curve.character_id).toBe('char-lin');
    expect(curve.start_state).toBe('山村少年，隐忍求存');
    expect(curve.wound_or_lack).toBe('被灭门之痛');
    expect(curve.desire).toBe('查清真相复仇');
    expect(curve.need).toBe('放下恨意守护活着的人');
    expect(curve.end_state).toBe('执剑者');
    expect(curve.turning_points).toEqual([{ turning_point: '发现父亲遗信', linked_episode_ids: ['ep3'] }]);
    // defaults 填充（regressions/linked_episode_ids）。
    expect(curve.regressions).toEqual([]);
    expect(curve.linked_episode_ids).toEqual([]);
  });

  it('Record 形态 growth_curve → array（key 补缺 character_id，值内自带优先）', () => {
    // 历史宽容读容忍形态：Record<character_id, curve>。值内 character_id 与 key 不一致时值内优先。
    const project = createEmptyProjectDocument('Legacy Record Growth Curve');
    const withRecord = {
      ...project,
      growth_curve: {
        'char-zhao': { start_state: '庙祝之女，外冷内热' }, // 无 character_id → key 补
        'char-alias': { character_id: 'char-lin', start_state: '山村少年' }, // 值内自带 → 优先
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withRecord), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(Array.isArray(loaded!.growth_curve)).toBe(true);
    const byId = new Map(loaded!.growth_curve!.map((c) => [c.character_id, c]));
    // key 补缺：'char-zhao'。
    expect(byId.get('char-zhao')!.start_state).toBe('庙祝之女，外冷内热');
    // 值内优先：key 'char-alias' 的值落到 'char-lin'。
    expect(byId.get('char-lin')!.start_state).toBe('山村少年');
    expect(byId.has('char-alias')).toBe(false);
  });

  it('outline_v2 旧假字段键 → arc_design_notes/pacing_design_notes 就地迁移（零数据丢失 + 旧键删）', () => {
    // 8.5 前 OutlineEditor 持久化的自由草稿位：outline_v2.growth_curve / pacing_curve_text。
    // 与顶层结构化 creative field 同名不同物 → 改名消歧（design D3），迁移保留草稿内容。
    const project = createEmptyProjectDocument('Legacy Outline Draft Keys');
    const withLegacyOutline = {
      ...project,
      outline_v2: {
        central_conflict: '旧秩序与新生代的对抗',
        major_turning_points: [{ type: 'core-anchor', label: '围城之战' }],
        growth_curve: '林昭：从逃避到直面（草稿）',
        pacing_curve_text: '前三卷蓄力，第四卷爆发（草稿）',
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withLegacyOutline), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    // 新键承接旧值（零数据丢失）。
    expect(loaded!.outline_v2!.arc_design_notes).toBe('林昭：从逃避到直面（草稿）');
    expect(loaded!.outline_v2!.pacing_design_notes).toBe('前三卷蓄力，第四卷爆发（草稿）');
    // 旧键不在输出（schema 无此键 + 迁移显式 delete）。
    expect((loaded!.outline_v2 as any).growth_curve).toBeUndefined();
    expect((loaded!.outline_v2 as any).pacing_curve_text).toBeUndefined();
    // 其余 outline_v2 字段不受迁移影响。
    expect(loaded!.outline_v2!.central_conflict).toBe('旧秩序与新生代的对抗');
    expect(loaded!.outline_v2!.major_turning_points).toEqual([{ type: 'core-anchor', label: '围城之战' }]);
  });

  it('outline_v2 新旧键并存 → 新键优先不被旧键覆盖（守卫：新键缺才写）', () => {
    // 手工迁移过 / 混合编辑过的 yaml 可能两键并存——新键（真实编辑目标）优先，旧键删除。
    const project = createEmptyProjectDocument('Both Keys Present');
    const withBoth = {
      ...project,
      outline_v2: {
        arc_design_notes: '新版弧草稿（手编）',
        growth_curve: '旧版弧草稿（不应覆盖新键）',
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withBoth), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.outline_v2!.arc_design_notes).toBe('新版弧草稿（手编）');
    expect((loaded!.outline_v2 as any).growth_curve).toBeUndefined();
  });

  it('新键空串 + 旧键有值 → 旧值承接迁移（CR-009：falsy 守卫，空串≠已设内容，防旧草稿静默删）', () => {
    // 手编 yaml 把新键建成空串（如 UI 清空过一次）后残留旧键——`=== undefined` 守卫会跳过迁移、
    // 随后 delete 旧键 = 旧草稿零提示丢失。falsy 守卫（对齐同函数 meta 迁移 `!parsed.meta.logline`）
    // 让旧值承接。
    const project = createEmptyProjectDocument('Empty New Key Migration');
    const withEmptyNewKey = {
      ...project,
      outline_v2: {
        arc_design_notes: '',
        growth_curve: '林昭：从逃避到直面（旧草稿不应丢）',
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withEmptyNewKey), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.outline_v2!.arc_design_notes).toBe('林昭：从逃避到直面（旧草稿不应丢）');
    expect((loaded!.outline_v2 as any).growth_curve).toBeUndefined();
  });

  it('新形态项目（array growth_curve + 新键 outline）round-trip 不受迁移影响', () => {
    // 8.5 后 canonical 持久化形态：saveProject 写 → loadProject 读，等价 round-trip。
    const project = createEmptyProjectDocument('Canonical Round Trip');
    project.growth_curve = [
      {
        character_id: 'char-a',
        start_state: '起点',
        turning_points: [],
        regressions: [],
        linked_episode_ids: [],
      },
      {
        character_id: 'char-b',
        start_state: '起点B',
        desire: '想要自由',
        turning_points: [],
        regressions: [],
        linked_episode_ids: [],
      },
    ];
    project.outline_v2 = {
      phases: [],
      major_turning_points: [],
      constraints: [],
      arc_design_notes: '弧设计草稿',
      pacing_design_notes: '节奏草稿',
    };
    saveProject(TEST_PROJECT_DIR, project);

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.growth_curve).toHaveLength(2);
    expect(loaded!.growth_curve!.map((c) => c.character_id)).toEqual(['char-a', 'char-b']);
    expect(loaded!.growth_curve![1].desire).toBe('想要自由');
    expect(loaded!.outline_v2!.arc_design_notes).toBe('弧设计草稿');
    expect(loaded!.outline_v2!.pacing_design_notes).toBe('节奏草稿');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // C1 真机遍历修复批（2026-08-27）：meta.created_at/updated_at 时间戳格式归一化迁移 +
  // 判腐 catch 留诊断。背景：PyYAML 离线手术把两键 dump 成 YAML1.1 空格分隔 timestamp，
  // z.string().datetime() 拒收整份文档 → 静默隔离 + 空项目重建（真实事故）。fixture 沿用
  // 「直接 YAML 写盘绕过新 schema」模式——模拟外部工具写出的形态。
  // ════════════════════════════════════════════════════════════════════════════

  it('loadProject 归一化：PyYAML 空格分隔时间戳 → ISO-T（项目不再被整体判腐隔离）', () => {
    const project = createEmptyProjectDocument('PyYAML Timestamp Migration');
    const withPyYamlTimestamps = {
      ...project,
      meta: {
        ...project.meta,
        // 真实事故形态：PyYAML dump 的 UTC offset 带微秒小数。
        created_at: '2026-08-27 13:25:37.123456+00:00',
        // 无小数、无时区的裸空格分隔形态。
        updated_at: '2026-08-27 13:26:00',
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withPyYamlTimestamps), 'utf8');

    // 迁移前此处 strict parse 必拒收 → backupCorruptFile + null + 空项目重建。
    const loaded = loadProject(TEST_PROJECT_DIR);

    expect(loaded).not.toBeNull();
    expect(loaded!.meta.name).toBe('PyYAML Timestamp Migration');
    // 归一目标形：ISO-T + Z；微秒截到 3 位毫秒。
    expect(loaded!.meta.created_at).toBe('2026-08-27T13:25:37.123Z');
    expect(loaded!.meta.updated_at).toBe('2026-08-27T13:26:00Z');
  });

  it('loadProject 归一化：亚毫秒/超 3 位小数截断到恰 3 位毫秒', () => {
    const project = createEmptyProjectDocument('Fraction Truncation Test');
    const withOddFractions = {
      ...project,
      meta: {
        ...project.meta,
        created_at: '2020-01-02 03:04:05.8',          // 单位数字补齐 .800
        updated_at: '2020-01-02 03:05:06.99999999',   // 长 tail 截前 3 位
      },
    };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(withOddFractions), 'utf8');

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.created_at).toBe('2020-01-02T03:04:05.800Z');
    expect(loaded!.meta.updated_at).toBe('2020-01-02T03:05:06.999Z');
  });

  it('loadProject 归一化：已合法 ISO-T 时间戳原样保留不被改写', () => {
    const project = createEmptyProjectDocument('Legal ISO Round Trip');
    project.meta.created_at = '2024-05-06T07:08:09.123Z';
    project.meta.updated_at = '2024-05-07T00:00:00Z';
    saveProject(TEST_PROJECT_DIR, project);

    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded!.meta.created_at).toBe('2024-05-06T07:08:09.123Z'); // 原样，含既有小数
    expect(loaded!.meta.updated_at).toBe('2024-05-07T00:00:00Z');     // 无小数不加 .000
  });

  it('loadProject 判腐 catch：schema reject 时先留诊断凭据再备份置 null（行为不变）', () => {
    const base = createEmptyProjectDocument('Bad Doc Diagnostics');
    // name min(1) 违反 → 最后的 strict parse 稳定抛错（此前静默吞掉拒因）。
    const bad = { ...base, meta: { ...base.meta, name: '' } };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(bad), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = loadProject(TEST_PROJECT_DIR);

      expect(loaded).toBeNull(); // 行为不变：仍返回 null
      // 诊断凭据：前缀 + Zod error message + 文件路径。
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('[loadProject] schema reject — quarantining');
      expect(typeof warn.mock.calls[0][1]).toBe('string');
      expect(warn.mock.calls[0][2]).toBe(path.join(TEST_PROJECT_DIR, 'project.yaml'));
      // 备份不变：坏文件被改名保存（never silently destroyed）——T22-bff 起落项目外隔离区。
      const inProject = readdirSync(TEST_PROJECT_DIR).filter((f) => f.includes('.corrupt-'));
      expect(inProject.length).toBe(0);
      const quarantined = readdirSync(testQuarantineProjectDir()).filter((f) => f.includes('.corrupt-'));
      expect(quarantined.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('loadProjectWithQuarantine 判腐事实透出（quarantine-notify）', () => {
  afterEach(() => {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('schema 非法 → document null + quarantined{backupPath 指向真实备份, reason 非空, recovered:false}', () => {
    // mirror 1399 行用例的构造法：name min(1) 违反 → strict parse 稳定拒收。
    const base = createEmptyProjectDocument('Quarantine Notify');
    const bad = { ...base, meta: { ...base.meta, name: '' } };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(bad), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = loadProjectWithQuarantine(TEST_PROJECT_DIR);

      expect(result.document).toBeNull();
      expect(result.quarantined).not.toBeNull();
      expect(result.quarantined!.recovered).toBe(false);
      expect(typeof result.quarantined!.reason).toBe('string');
      expect(result.quarantined!.reason.length).toBeGreaterThan(0);
      // backupPath 是真实落盘的备份文件（通知文案要展示它的文件名）。
      expect(result.quarantined!.backupPath).toMatch(/project\.yaml\.corrupt-/);
      expect(existsSync(result.quarantined!.backupPath!)).toBe(true);
      // T22-bff：备份在**项目外**隔离区（per-project 子目录 = 项目目录名兜底口径），
      // 项目目录内不再出现 .corrupt-* 残留（盲态#11「文件树吓人」防复发锁）。
      expect(result.quarantined!.backupPath).toContain(TEST_QUARANTINE_ROOT);
      expect(result.quarantined!.backupPath).toContain(path.basename(TEST_PROJECT_DIR));
      expect(result.quarantined!.backupPath).not.toContain(TEST_PROJECT_DIR);
      // 原路径已让位（被改名，不再是原文件）。
      expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.yaml'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('正常加载 → quarantined null（零隔离事实，AC2 前半）', () => {
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Healthy Project'));

    const result = loadProjectWithQuarantine(TEST_PROJECT_DIR);

    expect(result.document!.meta.name).toBe('Healthy Project');
    expect(result.quarantined).toBeNull();
  });

  it('YAML 解析失败但前缀抢救成功 → document 非 null + quarantined{recovered:true, backupPath 真实}', () => {
    // mirror 553 行自愈用例的损坏 fixture（合法前缀 + 残留尾巴）。
    const corrupt = [
      'meta:',
      '  id: 2bb8e07a-d41a-4785-8dfc-cef994ee42b4',
      '  name: X',
      '  type: novel',
      '  project_id: "00001"',
      '  version: 10',
      '  created_at: 2026-06-13T15:44:39.644Z',
      'novel:',
      '  chapters: []',
      'storyboard:',
      '  shots: []',
      '35Zz',
      '  updated_at: 2026-06-13T17:02:46.8',
    ].join('\n');
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), corrupt, 'utf8');

    const result = loadProjectWithQuarantine(TEST_PROJECT_DIR);

    // 抢救出的文档存活（数据未丢）。
    expect(result.document).not.toBeNull();
    expect(result.document!.meta.name).toBe('X');
    // 同时隔离事实成立：原坏文件被改名备份，且抢救成功 → recovered true。
    expect(result.quarantined).not.toBeNull();
    expect(result.quarantined!.recovered).toBe(true);
    expect(result.quarantined!.backupPath).toMatch(/\.corrupt-/);
    expect(existsSync(result.quarantined!.backupPath!)).toBe(true);
  });

  it('YAML 完全无法解析（无前缀可抢救）→ document null + quarantined{recovered:false}', () => {
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), '{[unbalanced: flow', 'utf8');

    const result = loadProjectWithQuarantine(TEST_PROJECT_DIR);

    expect(result.document).toBeNull();
    expect(result.quarantined).not.toBeNull();
    expect(result.quarantined!.recovered).toBe(false);
    expect(typeof result.quarantined!.reason).toBe('string');
    expect(existsSync(result.quarantined!.backupPath!)).toBe(true);
  });

  it('migrateLegacyProjectJsonWithQuarantine（无 project.json）→ 透传 loadProject 的隔离事实', () => {
    const base = createEmptyProjectDocument('Migrate Quarantine');
    const bad = { ...base, meta: { ...base.meta, name: '' } };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(bad), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = migrateLegacyProjectJsonWithQuarantine(TEST_PROJECT_DIR);

      expect(result.document).toBeNull();
      expect(result.quarantined).not.toBeNull();
      expect(result.quarantined!.backupPath).toMatch(/\.corrupt-/);
    } finally {
      warn.mockRestore();
    }
  });
});

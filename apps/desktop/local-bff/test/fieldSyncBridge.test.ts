import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createEmptyProjectDocument, saveProject, loadProject } from '../sync/localProjectRepository';
import { onFieldEdited, toggleFieldLock } from '../sync/fieldSyncBridge';

const TEST_PROJECT_DIR = path.join(process.cwd(), 'test-tmp-field-sync');

// 判腐隔离根钉进测试目录：quarantineRootDir 的 env 缺省回落真机 ~/.orison/quarantine，
// 不设则每次判腐用例都在真实 home 落 project.yaml.corrupt-* 备份（测试污染）。
process.env.ORISON_QUARANTINE_ROOT = path.join(TEST_PROJECT_DIR, 'quarantine');

describe('fieldSyncBridge', () => {
  afterEach(() => {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('编辑 relationship_graph 后生成 sync event 并标记下游 stale', () => {
    const project = createEmptyProjectDocument('Sync Test');
    saveProject(TEST_PROJECT_DIR, project);

    const newGraph = {
      nodes: [{ id: 'n1', assetCardId: 'c1', label: '侦探', type: 'character', locked: false }],
      edges: [{ id: 'e1', from: 'n1', to: 'n1', relationType: 'rivalry', strength: 5, polarity: 'positive', visibility: 'public', locked: false }],
      version: 1,
      updatedBy: 'user'
    };

    const { syncEvent, staleFields } = onFieldEdited(
      TEST_PROJECT_DIR,
      'relationship_graph',
      newGraph
    );

    // 验证 sync event
    expect(syncEvent.id).toMatch(/^evt_/);
    expect(syncEvent.source).toBe('user');
    expect(syncEvent.field).toBe('relationship_graph');
    expect(syncEvent.fromVersion).toBe(0);
    expect(syncEvent.toVersion).toBe(1);

    // 验证下游 stale 字段
    expect(staleFields).toContain('world_setting');
    expect(staleFields).toContain('outline');
    expect(staleFields).toContain('episode_outlines');
    expect(staleFields).toContain('growth_curve');
    expect(staleFields).toContain('pacing_curve');
    expect(staleFields).toContain('emotion_curve');
  });

  it('编辑 outline 后只标记曲线和集纲为 stale', () => {
    const project = createEmptyProjectDocument('Outline Sync');
    saveProject(TEST_PROJECT_DIR, project);

    const { staleFields } = onFieldEdited(
      TEST_PROJECT_DIR,
      'outline',
      { title: '新大纲', logline: '测试', central_conflict: '冲突', synopsis: '故事梗概', major_turning_points: [], ending_direction: '结局' }
    );

    expect(staleFields).toContain('growth_curve');
    expect(staleFields).toContain('pacing_curve');
    expect(staleFields).toContain('emotion_curve');
    expect(staleFields).toContain('episode_outlines');
    expect(staleFields).not.toContain('outline');
    expect(staleFields).not.toContain('asset_cards');
    expect(staleFields).not.toContain('relationship_graph');
  });

  it('编辑后 field_metadata 版本递增且 stale 字段被标记', () => {
    const project = createEmptyProjectDocument('Meta Test');
    saveProject(TEST_PROJECT_DIR, project);

    onFieldEdited(TEST_PROJECT_DIR, 'asset_cards', [
      { id: 'c1', type: 'character', name: '测试', summary: '测试角色', tags: [], relationships: [], sourceRefs: [], status: 'active', locked: false }
    ]);

    // 再次读取验证持久化
    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();

    expect(loaded!.field_metadata!.asset_cards!.version).toBe(1);
    expect(loaded!.field_metadata!.asset_cards!.source).toBe('user');
    expect(loaded!.field_metadata!.asset_cards!.stale).toBe(false);

    // 下游应被标记 stale
    expect(loaded!.field_metadata!.world_setting!.stale).toBe(true);
    expect(loaded!.field_metadata!.outline!.stale).toBe(true);
    expect(loaded!.field_metadata!.episode_outlines!.stale).toBe(true);
  });

  it('编辑 promise_registry 后标记 episode_outlines 为 stale', () => {
    const project = createEmptyProjectDocument('Promise Sync');
    saveProject(TEST_PROJECT_DIR, project);

    // Story 6.5：promise_registry 替代 foreshadow_registry（creative field 改名 + 泛化）。
    // shape = { promises, beats, version, updatedBy }（promiseRegistrySchema，mirror InfoReleaseMap）。
    const newPromise = {
      promises: [
        { id: 'p_001', title: '神秘钥匙', summary: '主角捡到古老钥匙——读者欠的债' }
      ],
      beats: [],
      version: 0,
      updatedBy: 'user'
    };

    const { syncEvent, staleFields } = onFieldEdited(
      TEST_PROJECT_DIR,
      'promise_registry',
      newPromise
    );

    expect(syncEvent.field).toBe('promise_registry');
    expect(syncEvent.toVersion).toBe(1);

    // promise_registry 下游：episode_outlines（workflow-sync 依赖图 :37）
    expect(staleFields).toContain('episode_outlines');

    // 确认持久化：promise_registry 的 key 被正确写入（FIELD_TO_KEY :15 改名后）
    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded!.promise_registry).toBeDefined();
    expect(loaded!.field_metadata!.promise_registry!.version).toBe(1);
    expect(loaded!.field_metadata!.episode_outlines!.stale).toBe(true);
  });

  it('编辑 asset_cards 后 promise_registry 也应标记为 stale', () => {
    const project = createEmptyProjectDocument('Asset to Promise');
    saveProject(TEST_PROJECT_DIR, project);

    const newAssets = [
      { id: 'c1', type: 'character' as const, name: '新角色', summary: '', tags: [], relationships: [], sourceRefs: [], status: 'active' as const, locked: false }
    ];

    const { staleFields } = onFieldEdited(TEST_PROJECT_DIR, 'asset_cards', newAssets);

    // asset_cards 下游含 promise_registry（workflow-sync 依赖图 :14）
    expect(staleFields).toContain('promise_registry');
  });

  it('编辑只有 project.json 的项目时自愈创建 project.yaml（回归：Project not found）', () => {
    // 复现 bug：新建项目只写了 project.json，从无 project.yaml。
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(
      path.join(TEST_PROJECT_DIR, 'project.json'),
      JSON.stringify({
        name: '我的小说', type: 'script', coverImage: null, projectId: 'p1',
        logline: '一句话梗概', synopsis: '完整故事梗概', genre: '悬疑', theme: '救赎',
        writing_style: '冷硬', tone: '黑暗'
      }),
      'utf8'
    );
    expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.yaml'))).toBe(false);

    // 旧逻辑会抛 "Project not found"；现在应自愈。
    const { syncEvent, staleFields } = onFieldEdited(TEST_PROJECT_DIR, 'outline', {
      central_conflict: '冲突', major_turning_points: [], ending_direction: '结局', constraints: []
    });

    expect(syncEvent.field).toBe('outline');
    expect(syncEvent.toVersion).toBe(1);
    expect(staleFields).toContain('episode_outlines');

    // project.yaml 被创建，且 name/type + 全部概览 meta 字段都取自 project.json
    // （不只是 name/type——否则概览页填的元信息会漂移丢失）。
    const loaded = loadProject(TEST_PROJECT_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.name).toBe('我的小说');
    expect(loaded!.meta.type).toBe('script');
    expect(loaded!.meta.logline).toBe('一句话梗概');
    expect(loaded!.meta.synopsis).toBe('完整故事梗概');
    expect(loaded!.meta.genre).toBe('悬疑');
    expect(loaded!.meta.theme).toBe('救赎');
    expect(loaded!.meta.writing_style).toBe('冷硬');
    expect(loaded!.meta.tone).toBe('黑暗');
    expect(loaded!.outline_v2).toBeDefined();
  });

  it('编辑 locked 字段时抛出错误', () => {
    const project = createEmptyProjectDocument('Lock Test');
    saveProject(TEST_PROJECT_DIR, project);

    // 先写入一次以创建 metadata，然后手动锁定
    onFieldEdited(TEST_PROJECT_DIR, 'world_setting', {
      premise: '初始', era: '', locations: [], rules: [],
      power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: []
    });

    // 手动锁定字段
    const loaded = loadProject(TEST_PROJECT_DIR)!;
    const locked = {
      ...loaded,
      field_metadata: {
        ...loaded.field_metadata,
        world_setting: { ...loaded.field_metadata!.world_setting!, locked: true }
      }
    };
    saveProject(TEST_PROJECT_DIR, locked);

    // 尝试编辑 locked 字段应抛出
    expect(() => onFieldEdited(TEST_PROJECT_DIR, 'world_setting', {
      premise: '被锁定不应写入', era: '', locations: [], rules: [],
      power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: []
    })).toThrow('locked');
  });

  // Story 3.1 WP5: toggleFieldLock 仅翻转 field_metadata[field].locked——不 bump
  // version、不触发下游 stale（区别于 onFieldEdited 的用户编辑路径）。
  it('toggleFieldLock 翻转 locked 且不 bump version / 不触发 stale', () => {
    // 直接装配 field_metadata（不走 onFieldEdited——它会标下游 stale，污染断言）。
    const project = createEmptyProjectDocument('Toggle Lock Test');
    const seeded = {
      ...project,
      field_metadata: {
        ...project.field_metadata,
        world_setting: { version: 1, source: 'user' as const, locked: false, dependsOn: [], stale: false }
      }
    };
    saveProject(TEST_PROJECT_DIR, seeded);
    const before = loadProject(TEST_PROJECT_DIR)!;
    const versionBefore = before.field_metadata!.world_setting!.version;
    expect(versionBefore).toBe(1);
    expect(before.field_metadata!.world_setting!.locked).toBe(false);

    // 锁定：locked 翻 true，version 不变
    toggleFieldLock(TEST_PROJECT_DIR, 'world_setting');
    const locked = loadProject(TEST_PROJECT_DIR)!;
    expect(locked.field_metadata!.world_setting!.locked).toBe(true);
    expect(locked.field_metadata!.world_setting!.version).toBe(versionBefore);

    // 下游字段不被新标 stale（onFieldEdited 会标 world_setting 编辑的下游；
    // toggleFieldLock 不应——outline/episode_outlines 仍保持 seed 时的 false）。
    expect(locked.field_metadata!.outline?.stale ?? false).toBe(false);
    expect(locked.field_metadata!.episode_outlines?.stale ?? false).toBe(false);

    // 再翻一次：解锁，version 仍不变
    toggleFieldLock(TEST_PROJECT_DIR, 'world_setting');
    const unlocked = loadProject(TEST_PROJECT_DIR)!;
    expect(unlocked.field_metadata!.world_setting!.locked).toBe(false);
    expect(unlocked.field_metadata!.world_setting!.version).toBe(versionBefore);
  });

  // Story 6.5 A1（CR-A1 critical，block AC2）：onFieldEdited options.source='agent' 让自动链段节点
  // （emergence promise-emergence-node）复用同一落盘流（version bump + markStaleFields + parse + save），
  // 区别仅 source='agent'（非 'user'）。缺省（无 options）= 用户手编流 source='user'，向后兼容。
  it('A1：options.source="agent" → field_metadata.source + syncEvent.source 均为 agent（emergence 自动落盘）', () => {
    const project = createEmptyProjectDocument('Agent Source Test');
    saveProject(TEST_PROJECT_DIR, project);

    const { syncEvent } = onFieldEdited(
      TEST_PROJECT_DIR,
      'promise_registry',
      { promises: [{ id: 'p1', title: 'T', summary: 'S' }], beats: [], version: 0, updatedBy: 'agent' },
      { source: 'agent', reason: 'Promise 涌现登记（emergence node 自动落盘）' },
    );

    // syncEvent source='agent'（非 'user'）+ reason 来自 options（非默认「用户编辑了 ...」）。
    expect(syncEvent.source).toBe('agent');
    expect(syncEvent.reason).toBe('Promise 涌现登记（emergence node 自动落盘）');
    expect(syncEvent.field).toBe('promise_registry');

    // field_metadata.source='agent' + version bump + 下游 stale 传播（同用户编辑流）。
    const loaded = loadProject(TEST_PROJECT_DIR)!;
    expect(loaded.field_metadata!.promise_registry!.source).toBe('agent');
    expect(loaded.field_metadata!.promise_registry!.version).toBe(1);
    expect(loaded.field_metadata!.episode_outlines?.stale).toBe(true);
    // promise_registry data 落盘正确。
    expect(loaded.promise_registry!.promises).toHaveLength(1);
    expect(loaded.promise_registry!.promises[0].id).toBe('p1');
  });

  it('A1：缺省 options → source="user"（向后兼容，用户手编流不变）', () => {
    const project = createEmptyProjectDocument('Default Source Test');
    saveProject(TEST_PROJECT_DIR, project);

    const { syncEvent } = onFieldEdited(
      TEST_PROJECT_DIR,
      'promise_registry',
      { promises: [], beats: [], version: 0 },
    );

    // 缺省 options → source='user'（向后兼容，既有用户手编流行为不变）。
    expect(syncEvent.source).toBe('user');
    expect(syncEvent.reason).toBe('用户编辑了 promise_registry');
    const loaded = loadProject(TEST_PROJECT_DIR)!;
    expect(loaded.field_metadata!.promise_registry!.source).toBe('user');
  });

  // quarantine-notify（2026-08-27）：onFieldEdited 的 loadProject 判腐隔离事实必须透出——
  // 否则隔离静默变 bootstrap 空文档落盘（本字段之外的数据全丢而用户零感知）。
  it('判腐隔离透出：yaml schema 非法时 quarantined 携带备份路径与拒因（而非静默 bootstrap）', () => {
    const base = createEmptyProjectDocument('Field Sync Quarantine');
    const bad = { ...base, meta: { ...base.meta, name: '' } };
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    writeFileSync(path.join(TEST_PROJECT_DIR, 'project.yaml'), YAML.stringify(bad), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = onFieldEdited(
        TEST_PROJECT_DIR,
        'promise_registry',
        { promises: [], beats: [], version: 0 },
      );

      expect(result.quarantined).not.toBeNull();
      expect(result.quarantined!.recovered).toBe(false);
      // CR-10：备份落点必须钉在本测试目录的隔离根内——文件顶部 ORISON_QUARANTINE_ROOT
      // env seam 真实生效的判据（quarantineRootDir 调用时读 env），真机
      // ~/.orison/quarantine 零触碰才有本断言。backupPath 类型含 null（隔离失败面），
      // `?.` 使 null/前缀不符双双落到断言失败。
      expect(result.quarantined!.backupPath).toMatch(/project\.yaml\.corrupt-/);
      expect(
        result.quarantined!.backupPath?.startsWith(path.join(TEST_PROJECT_DIR, 'quarantine')),
      ).toBe(true);
      expect(typeof result.quarantined!.reason).toBe('string');
      // 落盘语义不变：bootstrap 兜底重建后本字段照常写入（行为与改造前一致）。
      const loaded = loadProject(TEST_PROJECT_DIR)!;
      expect(loaded.field_metadata!.promise_registry!.version).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlatYaml, stringifyFlatYaml, type ModelConfig } from '@orison/shared-contracts';

// Mirror modelConfigIpc.test.ts harness: configIpc pulls db/indexers/loggers —
// mock the whole family so the preset handlers can be driven without Electron/db.
const { handle, safeStorage, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, rebuildChapterChunks, listChapterSummaries, reindexChapterSummaryEntry, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  reindexAssetCards: vi.fn(),
  reindexAllSettingMd: vi.fn(),
  rebuildChapterChunks: vi.fn(),
  listChapterSummaries: vi.fn(),
  reindexChapterSummaryEntry: vi.fn(),
  getProjectById: vi.fn(),
  getProject: vi.fn(),
  getDb: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  app: { getPath: () => `${process.cwd()}/test-tmp-user-data` },
}));

vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/chapterChunkIndexer', () => ({ rebuildChapterChunks }));
vi.mock('../main/db/chapterSummaryIndexer', () => ({ reindexChapterSummaryEntry }));
vi.mock('../main/db/worldStateRepository', () => ({ listChapterSummaries }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { _setModelConfigDirForTest, registerConfigIpc, readActiveTaskPreset, readTaskModelSlots } from '../main/ipc/configIpc';

const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-task-presets');
const SIDECAR = () => path.join(TEST_MODEL_DIR, 'task-models.yaml');
const PRESETS_DIR = () => path.join(TEST_MODEL_DIR, 'task-model-presets');
const presetPath = (name: string) => path.join(PRESETS_DIR(), `${name}.yaml`);

const SAVE_CONFIG: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'Main relay',
      protocol: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example.com/v1',
      models: [{ id: 'gpt-4o', alias: 'GPT-4o', capability: 'text', enabled: true }],
    },
  ],
};

/** Deterministic stat keys — consecutive same-length writes collide on mtimeMs. */
function pinMtime(file: string, ms: number) {
  const at = new Date(ms);
  utimesSync(file, at, at);
}

function handlerFor(channel: string): (event: unknown, input?: unknown) => unknown {
  registerConfigIpc();
  const call = handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`channel not registered: ${channel}`);
  return call[1] as (event: unknown, input?: unknown) => unknown;
}

beforeEach(() => {
  handle.mockReset();
  reindexAll.mockReset();
  reindexAll.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });
  reindexAllCraft.mockReset();
  reindexAllCraft.mockResolvedValue({ reindexed: 0, dimChanged: false, newDim: null });
  reindexAssetCards.mockReset();
  reindexAssetCards.mockResolvedValue({ reindexed: 0, orphaned: 0 });
  getProjectById.mockReset();
  getProjectById.mockReturnValue(undefined);
  getDb.mockReset();
  getDb.mockReturnValue({ prepare: () => ({ all: () => [] }) });
  warn.mockReset();
  info.mockReset();
  _setModelConfigDirForTest(TEST_MODEL_DIR);
  rmBestEffort(TEST_MODEL_DIR);
});

afterEach(() => {
  _setModelConfigDirForTest(null);
  rmBestEffort(TEST_MODEL_DIR);
});

// Hand-edited sidecar seed with the FULL assignment family: refs + thinking
// policy + a fallback chain whose entry carries its own policy. The preset
// snapshot must round-trip ALL of it (AC: 快照零丢失).
const FULL_SIDECAR_LINES = [
  'writer-draft.keyId: key_001',
  'writer-draft.modelId: qwen-max',
  'writer-draft.thinking: high',
  'writer-draft.fallbacks.0.keyId: key_001',
  'writer-draft.fallbacks.0.modelId: qwen-flash',
  'writer-draft.fallbacks.0.thinking: low',
  'dialogue.keyId: key_001',
  'dialogue.modelId: qwen-max',
  'dialogue.thinkingCustom: "8192"',
];

describe('taskPresets handlers (C3.2 W2 多套预设)', () => {
  it('save snapshots the current sidecar verbatim; apply restores it and sets the marker (AC 往返)', async () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(SIDECAR(), FULL_SIDECAR_LINES.join('\n') + '\n', 'utf-8');

    const save = handlerFor('taskPresets:save');
    expect(save({}, { name: 'cloud-quality' })).toEqual({ ok: true });

    // Preset file exists, shape = task-models.yaml 同构, full fidelity.
    const presetSlots = readTaskModelSlots(presetPath('cloud-quality'));
    expect(presetSlots).toEqual(readTaskModelSlots());
    const presetFlat = parseFlatYaml(readFileSync(presetPath('cloud-quality'), 'utf-8'));
    expect(presetFlat['writer-draft.thinking']).toBe('high');
    expect(presetFlat['writer-draft.fallbacks.0.modelId']).toBe('qwen-flash');
    expect(presetFlat['writer-draft.fallbacks.0.thinking']).toBe('low');
    // Numeric-string policy values ride through the writer unquoted, so flat
    // re-parse coerces them back to number — the semantic string form is the
    // reader's canonicalization (asserted via the presetSlots equality above).
    expect(String(presetFlat['dialogue.thinkingCustom'])).toBe('8192');
    // Preset files never carry the activePreset marker.
    expect(presetFlat.activePreset).toBeUndefined();

    // Manually change the current designations (different slot content).
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: other-model\n', 'utf-8');
    expect(readActiveTaskPreset()).toBeUndefined();

    const apply = handlerFor('taskPresets:apply');
    expect(apply({}, { name: 'cloud-quality' })).toEqual({ ok: true });

    // AC: 切回预设 → 各档与预设内容一致且 activePreset 指向该预设.
    expect(readTaskModelSlots()).toEqual(presetSlots);
    expect(readActiveTaskPreset()).toBe('cloud-quality');
    const mainFlat = parseFlatYaml(readFileSync(SIDECAR(), 'utf-8'));
    expect(mainFlat.activePreset).toBe('cloud-quality');
  });

  it('manual save-model clears the marker (renderer payload strip → 自定义), assignments survive', async () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(SIDECAR(), FULL_SIDECAR_LINES.join('\n') + '\n', 'utf-8');
    expect(handlerFor('taskPresets:save')({}, { name: 'cloud-quality' })).toEqual({ ok: true });
    expect(handlerFor('taskPresets:apply')({}, { name: 'cloud-quality' })).toEqual({ ok: true });
    expect(readActiveTaskPreset()).toBe('cloud-quality');

    // Simulate the renderer round-trip: it loaded a config WITH activePreset and
    // saves after a manual slot edit. The save face strips the marker → the
    // sidecar rewrite lands without the key.
    pinMtime(SIDECAR(), 1_700_000_000_000);
    const payload: ModelConfig = {
      ...SAVE_CONFIG,
      taskModels: { dialogue: { keyId: 'key_001', modelId: 'hand-picked' } },
      activePreset: 'cloud-quality',
    };
    await handlerFor('config:save-model')({}, payload);

    expect(readActiveTaskPreset()).toBeUndefined();
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'hand-picked' } });
  });

  it('list returns name/slotCount/hasFallbacks and skips corrupt presets', () => {
    mkdirSync(PRESETS_DIR(), { recursive: true });
    writeFileSync(
      presetPath('plain'),
      'dialogue.keyId: key_001\ndialogue.modelId: qwen-max\n',
      'utf-8',
    );
    writeFileSync(
      presetPath('with-chain'),
      [
        'writer-draft.keyId: key_001',
        'writer-draft.modelId: qwen-max',
        'writer-draft.fallbacks.0.keyId: key_001',
        'writer-draft.fallbacks.0.modelId: qwen-flash',
      ].join('\n') + '\n',
      'utf-8',
    );
    // All entries bad → normalizes to undefined → not listed.
    writeFileSync(
      presetPath('corrupt'),
      'retired-slot.keyId: key_001\nretired-slot.modelId: m\n',
      'utf-8',
    );

    const list = handlerFor('taskPresets:list')({}) as Array<{ name: string; slotCount: number; hasFallbacks: boolean }>;
    expect(list.map((p) => p.name)).toEqual(['plain', 'with-chain']);
    expect(list[0]).toEqual({ name: 'plain', slotCount: 1, hasFallbacks: false });
    expect(list[1]).toEqual({ name: 'with-chain', slotCount: 1, hasFallbacks: true });
  });

  it('CR-3: a stem that fails the preset-name schema (my.preset.yaml) is skipped in list + warned — no dead-end UI entry', () => {
    mkdirSync(PRESETS_DIR(), { recursive: true });
    writeFileSync(
      presetPath('legal-one'),
      'dialogue.keyId: key_001\ndialogue.modelId: qwen-max\n',
      'utf-8',
    );
    // The dot fails taskPresetNameSchema ([A-Za-z0-9_-]{1,64}) — apply/delete by
    // this name would always 400, so listing it would be a dead-end entry.
    writeFileSync(
      presetPath('my.preset'),
      'dialogue.keyId: key_001\ndialogue.modelId: qwen-max\n',
      'utf-8',
    );
    warn.mockClear();

    const list = handlerFor('taskPresets:list')({}) as Array<{ name: string }>;
    expect(list.map((p) => p.name)).toEqual(['legal-one']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'my.preset.yaml' }),
      'task preset file name is not a legal preset name — skipped in list',
    );
  });

  it('CR-12: a marker pointing at a missing preset file reads as unset + warn (dangling marker)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // Hand-rolled sidecar with a marker naming a preset that does not exist
    // (out-of-band delete / rollback left the key behind).
    writeFileSync(
      SIDECAR(),
      stringifyFlatYaml({ activePreset: 'ghost-preset', 'dialogue.keyId': 'key_001', 'dialogue.modelId': 'm' }),
      'utf-8',
    );
    warn.mockClear();

    expect(readActiveTaskPreset()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'ghost-preset' }),
      'activePreset marker points at a missing preset file — reporting unset (dangling marker)',
    );
    // Assignments survive the reconcile untouched.
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'm' } });
  });

  it('CR-1: deleting the active preset with an unreadable sidecar skips the rewrite — assignments file untouched', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(SIDECAR(), FULL_SIDECAR_LINES.join('\n') + '\n', 'utf-8');
    const save = handlerFor('taskPresets:save');
    save({}, { name: 'p-cr1' });
    expect(handlerFor('taskPresets:apply')({}, { name: 'p-cr1' })).toEqual({ ok: true });
    expect(readActiveTaskPreset()).toBe('p-cr1');
    const goodContent = readFileSync(SIDECAR(), 'utf-8');

    // Force the lenient slot reader to serve `undefined` for the CURRENT file:
    // seed its mtime+size cache with a same-stat-key zero-valid-entry read
    // (mirror the 串档 test's stat-pinning trick — a real read failure would
    // need fs-level permission games). readActiveTaskPreset is cache-free and
    // still sees the marker, so the delete handler takes the active path.
    const badContent = 'x'.repeat(goodContent.length); // same bytes → same size
    writeFileSync(SIDECAR(), badContent, 'utf-8');
    pinMtime(SIDECAR(), 1_700_000_000_000);
    expect(readTaskModelSlots()).toBeUndefined(); // cache now holds the miss under this stat key
    writeFileSync(SIDECAR(), goodContent, 'utf-8'); // restore good content, SAME size
    pinMtime(SIDECAR(), 1_700_000_000_000); // same mtime → cache HIT serves undefined
    warn.mockClear();

    expect(handlerFor('taskPresets:delete')({}, { name: 'p-cr1' })).toEqual({ ok: true });
    expect(existsSync(presetPath('p-cr1'))).toBe(false);
    // CR-1 断言：指派文件原地不动（无守卫时 writeTaskModels(undefined) 会整文件删除）。
    expect(readFileSync(SIDECAR(), 'utf-8')).toBe(goodContent);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'p-cr1' }),
      'task preset delete: sidecar read failed — activePreset marker left in place, assignments untouched',
    );
  });

  it('typed errors: invalid name / unknown preset / save with no assignments (模式 A, no throw)', () => {
    const save = handlerFor('taskPresets:save');
    const apply = handlerFor('taskPresets:apply');
    const del = handlerFor('taskPresets:delete');

    // Name schema: [A-Za-z0-9_-]{1,64} — traversal and separators impossible.
    expect(save({}, { name: '../escape' })).toEqual({ ok: false, error: 'invalid-name' });
    expect(save({}, { name: '' })).toEqual({ ok: false, error: 'invalid-name' });
    expect(save({}, { name: '中文名' })).toEqual({ ok: false, error: 'invalid-name' });
    expect(save({}, { name: 'x'.repeat(65) })).toEqual({ ok: false, error: 'invalid-name' });
    expect(apply({}, { name: 'no-such-preset' })).toEqual({ ok: false, error: 'not-found' });
    expect(del({}, { name: 'no-such-preset' })).toEqual({ ok: false, error: 'not-found' });
    // No sidecar on disk → nothing to snapshot.
    expect(save({}, { name: 'empty-seed' })).toEqual({ ok: false, error: 'no-slots' });
    expect(existsSync(presetPath('empty-seed'))).toBe(false);
  });

  it('apply accepts a directly hand-seeded preset file — a scalar `fallbacks: []` never poisons the write (CR-18 preset face)', () => {
    mkdirSync(PRESETS_DIR(), { recursive: true });
    writeFileSync(
      SIDECAR(),
      'dialogue.keyId: key_001\ndialogue.modelId: current-model\n',
      'utf-8',
    );
    writeFileSync(
      presetPath('hand-seeded'),
      [
        'writer-draft.keyId: key_001',
        'writer-draft.modelId: qwen-max',
        // CR-18: a hand-edited `fallbacks: []` scalar rides into the parsed map,
        // but the chain scanner never reads it — the lenient reader drops it, so
        // the apply gate (zod .min(1) two-state contract) sees a legal shape.
        'writer-draft.fallbacks: []',
      ].join('\n') + '\n',
      'utf-8',
    );
    expect(readTaskModelSlots(presetPath('hand-seeded'))).toEqual({
      'writer-draft': { keyId: 'key_001', modelId: 'qwen-max' },
    });

    expect(handlerFor('taskPresets:apply')({}, { name: 'hand-seeded' })).toEqual({ ok: true });
    expect(readTaskModelSlots()).toEqual({ 'writer-draft': { keyId: 'key_001', modelId: 'qwen-max' } });
    expect(readActiveTaskPreset()).toBe('hand-seeded');
  });

  it('delete removes the file; deleting the ACTIVE preset clears the marker and keeps assignments', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(SIDECAR(), FULL_SIDECAR_LINES.join('\n') + '\n', 'utf-8');
    const save = handlerFor('taskPresets:save');
    const del = handlerFor('taskPresets:delete');
    save({}, { name: 'p-active' });
    save({}, { name: 'p-other' });

    // Deleting a NON-active preset leaves marker + assignments untouched.
    expect(del({}, { name: 'p-other' })).toEqual({ ok: true });
    expect(existsSync(presetPath('p-other'))).toBe(false);
    expect(existsSync(presetPath('p-active'))).toBe(true);
    expect(readActiveTaskPreset()).toBeUndefined();

    // Apply, then delete the active one: marker cleared, assignments intact.
    expect(handlerFor('taskPresets:apply')({}, { name: 'p-active' })).toEqual({ ok: true });
    const assignmentsBefore = readTaskModelSlots();
    expect(del({}, { name: 'p-active' })).toEqual({ ok: true });
    expect(existsSync(presetPath('p-active'))).toBe(false);
    expect(readActiveTaskPreset()).toBeUndefined();
    expect(readTaskModelSlots()).toEqual(assignmentsBefore);
  });

  it('preset reads bypass the mtime+size cache — no 串档 in either direction (复核 must-fix#3)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    mkdirSync(PRESETS_DIR(), { recursive: true });
    // Prime the primary-sidecar cache.
    writeFileSync(SIDECAR(), 'dialogue.keyId: key_001\ndialogue.modelId: main-model\n', 'utf-8');
    pinMtime(SIDECAR(), 1_700_000_000_000);
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'main-model' } });

    // A preset whose stat can be pinned IDENTICAL to the cached main sidecar —
    // a shared cache would serve main's slots for the preset file.
    writeFileSync(
      presetPath('twin'),
      'dialogue.keyId: key_001\ndialogue.modelId: preset-model\n',
      'utf-8',
    );
    pinMtime(presetPath('twin'), 1_700_000_000_000);
    expect(readTaskModelSlots(presetPath('twin'))).toEqual({
      dialogue: { keyId: 'key_001', modelId: 'preset-model' },
    });

    // Reverse direction: rewrite the preset (same stat key as before) — a preset
    // cache would serve the stale copy; direct reads see the new content.
    writeFileSync(
      presetPath('twin'),
      'dialogue.keyId: key_001\ndialogue.modelId: preset-model-v2\n',
      'utf-8',
    );
    pinMtime(presetPath('twin'), 1_700_000_000_000);
    expect(readTaskModelSlots(presetPath('twin'))).toEqual({
      dialogue: { keyId: 'key_001', modelId: 'preset-model-v2' },
    });

    // The main cache survived the preset reads untouched.
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'main-model' } });
  });

  it('preset file write is the same projection as the sidecar writer (one projection, zero drift)', async () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(SIDECAR(), FULL_SIDECAR_LINES.join('\n') + '\n', 'utf-8');
    handlerFor('taskPresets:save')({}, { name: 'mirror' });
    // Projection identity: identical KEY SETS (the writer emits exactly the
    // assignment's keys) and semantically identical slots through the lenient
    // reader. (Raw flat value equality is too strict: numeric-string policy
    // values like "8192" re-parse as numbers after the unquoted write — the
    // reader canonicalizes them back to the schema's string form.)
    const mainFlat = parseFlatYaml(readFileSync(SIDECAR(), 'utf-8'));
    const presetFlat = parseFlatYaml(readFileSync(presetPath('mirror'), 'utf-8'));
    expect(Object.keys(presetFlat).sort()).toEqual(Object.keys(mainFlat).sort());
    expect(readTaskModelSlots(presetPath('mirror'))).toEqual(readTaskModelSlots());
  });

  it('apply round-trips through stringify/parse — flat numeric thinkingCustom survives (round-trip discipline)', () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    writeFileSync(SIDECAR(), FULL_SIDECAR_LINES.join('\n') + '\n', 'utf-8');
    handlerFor('taskPresets:save')({}, { name: 'numeric' });
    // Overwrite the main sidecar, then apply through the full write/read cycle.
    rmSync(SIDECAR(), { force: true });
    expect(handlerFor('taskPresets:apply')({}, { name: 'numeric' })).toEqual({ ok: true });
    expect(readTaskModelSlots()).toEqual({
      'writer-draft': {
        keyId: 'key_001',
        modelId: 'qwen-max',
        thinking: 'high',
        fallbacks: [{ keyId: 'key_001', modelId: 'qwen-flash', thinking: 'low' }],
      },
      dialogue: { keyId: 'key_001', modelId: 'qwen-max', thinkingCustom: '8192' },
    });
  });

  it('stringifyFlatYaml writes the marker as a flat key the old reader ignores (rollback safety)', async () => {
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    mkdirSync(PRESETS_DIR(), { recursive: true });
    // CR-12: the marker reader reconciles against the preset file's existence —
    // seed it so the marker reads back (the test's subject is the flat-key form,
    // not the dangling-marker path).
    writeFileSync(
      presetPath('some-preset'),
      'dialogue.keyId: key_001\ndialogue.modelId: m\n',
      'utf-8',
    );
    // The marker key is invisible to readTaskModelSlots (slot-enum-only reader).
    writeFileSync(
      SIDECAR(),
      stringifyFlatYaml({ activePreset: 'some-preset', 'dialogue.keyId': 'key_001', 'dialogue.modelId': 'm' }),
      'utf-8',
    );
    expect(readTaskModelSlots()).toEqual({ dialogue: { keyId: 'key_001', modelId: 'm' } });
    expect(readActiveTaskPreset()).toBe('some-preset');
  });
});

import { app, dialog, ipcMain, safeStorage } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ApiKeyEntry,
  ImportedFont,
  ModelCapability,
  ModelConfig,
  ModelProtocol,
  ModelRef,
  ResearchNetConfig,
  SlotAssignment,
  SlotFallbackEntry,
  TaskModelSlot,
  UserPreferencesConfig,
} from '@orison/shared-contracts';
import { parseFlatYaml, stringifyFlatYaml, modelConfigSaveSchema, taskModelSlotSchema, slotAssignmentSchema, DEFAULT_USER_PREFERENCES, DEFAULT_RESEARCH_NET_CONFIG, researchNetConfigSchema, resolveModelInfo, THINKING_PROFILES, isVectorArmDegraded, clampInterfaceScale, clampUsageRetentionDays, BLOCKED_CUSTOM_HEADER_NAMES, MODEL_DEFAULT_RANGES, MODEL_PRICING_RANGE, KEY_TIMEOUT_SECONDS_RANGE, customHeaderNameSchema, customHeaderValueSchema, flatQuoted, type FlatConfigValue } from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { getLogger } from '../logger';
import { getResearchSession } from '../research/researchSession';
import { reindexAll } from '../db/closureIndexer';
import { reindexAllCraft } from '../db/closureCraftIndexer';
import { reindexAssetCards } from '../db/assetCardsIndexer';
import { reindexAllSettingMd } from '../db/settingMdIndexer';
import { rebuildChapterChunks } from '../db/chapterChunkIndexer';
import { reindexChapterSummaryEntry } from '../db/chapterSummaryIndexer';
import { listChapterSummaries } from '../db/worldStateRepository';
import { getDb } from '../db/index';
import { getProjectById } from '../db/projectRepository';
import { isSqliteVecAvailable } from '../db/sqliteVecLoader';
import { isEmbeddingSweepInflight, runWithEmbeddingSweepGate } from '../db/embeddingSweepGate';
import { allowPath } from './pathGuard';

const DEFAULT_MODEL_CONFIG: ModelConfig = { keys: [] };

let modelDirOverride: string | null = null;

export function _setModelConfigDirForTest(dir: string | null) {
  modelDirOverride = dir;
  // CR-004: the task-models sidecar cache is keyed by stat only — a dir switch
  // must drop it, or the new dir would be served the previous dir's slots.
  taskModelsCache = undefined;
}

/**
 * Model-config dir (default `~/.orison/model`). Exported for sibling sidecar
 * modules (research/searchConfig.ts `search-config.yaml`) so ALL sidecars share
 * one dir resolution — no second copy of the path to drift.
 */
export function getModelDir(): string {
  return modelDirOverride ?? path.join(os.homedir(), '.orison', 'model');
}

function getKeysDir(): string {
  return path.join(getModelDir(), 'keys');
}

function getUserPreferencesPath(): string {
  return path.join(os.homedir(), '.orison', 'user', 'preferences.yaml');
}

/** True when the last write fell back to plaintext (no OS keyring). */
let plaintextKeyWarningLogged = false;

/**
 * Best-effort secret encryption via the OS keyring. Exported for sibling
 * sidecar modules (search-config.yaml API keys) so secrets share one
 * encryption path — never a second implementation to drift.
 */
export function encrypt(value: string): string {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64');
    }
  } catch { /* fall through */ }
  // No keyring (common on some Linux setups): store plaintext but warn once so
  // operators know API keys sit unencrypted under ~/.orison/model/keys/.
  if (!plaintextKeyWarningLogged) {
    plaintextKeyWarningLogged = true;
    getLogger().warn(
      'safeStorage encryption unavailable — API keys will be stored in plaintext under ~/.orison/model/keys/',
    );
  }
  return value;
}

/** Whether OS-level secret encryption is available (for UI warnings). */
export function isApiKeyEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Decrypt an {@link encrypt} output; hand-edited plaintext passes through. Exported for sibling sidecars. */
export function decrypt(value: string): string {
  if (!value) return '';
  // Only attempt safeStorage decryption if value looks like base64-encoded encrypted data
  // (safeStorage output is typically 80+ chars of pure base64 with padding)
  const isLikelyEncrypted = value.length > 60 && /^[A-Za-z0-9+/]+=*$/.test(value);
  if (!isLikelyEncrypted) return value;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(value, 'base64');
      return safeStorage.decryptString(buf);
    }
  } catch { /* decryption failed */ }
  return value;
}

/* ── Read path ── */

/**
 * dogfood 2026-08-21（#41 追修）：读取时重算每个模型的派生字段（alias/capability）。
 * 二者都是 model-registry 的确定性输出且 UI 不可编辑——registry 修 bug 后（截断 alias
 * 「Embedding Qwen/Qwen3-Embedd」、误标 text 的 Qwen3-Reranker-8B），存量配置靠用户
 * 手动「获取模型列表」才能自愈，实际没人会做；加载即重算，全量配置零操作收敛。
 * enabled 是用户 authored 状态，原样保留。
 */
function healDerivedModelFields(keys: ApiKeyEntry[]): ApiKeyEntry[] {
  return keys.map((key) => ({
    ...key,
    models: key.models.map((m) => {
      const info = resolveModelInfo(m.id);
      // 09-12 agy provider：CLI 键的 alias 是 `agy models` TSV 的官方显示名（比 registry
      // 族名兜底更权威——gemini-* 全落「Gemini」×N 不可分辨），heal 只重算 capability，
      // 非空 alias 原样保留；capability 仍以 registry 为准（两形态同一推断源）。
      if (key.protocol === 'antigravity-cli' && m.alias.trim()) {
        return { ...m, alias: m.alias, capability: info.capability };
      }
      return { ...m, alias: info.alias, capability: info.capability };
    }),
  }));
}

function readModelConfig(): ModelConfig {
  const embeddingModel = readEmbeddingModel();
  const rerankModel = readRerankModel();
  const visionModel = readVisionModel();
  const taskModels = readTaskModelSlots();
  const keysDir = getKeysDir();
  if (!existsSync(keysDir)) {
    // Try migration from old profiles
    const migrated = migrateFromProfiles();
    if (migrated) return { ...migrated, keys: healDerivedModelFields(migrated.keys), embeddingModel, rerankModel, visionModel, taskModels };
    return { ...DEFAULT_MODEL_CONFIG, embeddingModel, rerankModel, visionModel, taskModels };
  }

  const files = readdirSync(keysDir).filter((f) => f.endsWith('.yaml'));
  const keys: ApiKeyEntry[] = [];

  for (const file of files) {
    const entry = readKeyFile(path.join(keysDir, file));
    if (entry) keys.push(entry);
  }

  return { keys: healDerivedModelFields(keys), embeddingModel, rerankModel, visionModel, taskModels };
}

function redactModelConfig(config: ModelConfig): ModelConfig {
  return {
    keys: config.keys.map((key) => ({
      ...key,
      apiKey: '',
    })),
    // embeddingModel is a `{keyId, modelId}` ref with no secret — pass through
    // so the renderer can display the current designation.
    embeddingModel: config.embeddingModel,
    rerankModel: config.rerankModel,
    visionModel: config.visionModel,
    // taskModels refs carry no secret either — same pass-through so the
    // settings page can display the current slot designations (C3.2).
    taskModels: config.taskModels,
  };
}

/* ── Embedding-model sidecar (VS1 KB indexing preset) ── */
//
// `embeddingModel` is a top-level ModelConfig field, but keys are stored as
// one-YAML-per-key under `keys/`. Persist the ref in a sidecar file next to
// `keys/` so it round-trips across save/load. Absent file → undefined (auto).

function getEmbeddingModelPath(): string {
  return path.join(getModelDir(), 'embedding-model.yaml');
}

function readEmbeddingModel(): ModelRef | undefined {
  try {
    const p = getEmbeddingModelPath();
    if (!existsSync(p)) return undefined;
    const raw = parseFlatYaml(readFileSync(p, 'utf-8'));
    const keyId = typeof raw.keyId === 'string' ? raw.keyId.trim() : '';
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!keyId || !modelId) return undefined;
    return { keyId, modelId };
  } catch {
    return undefined;
  }
}

function writeEmbeddingModel(ref: ModelRef | undefined): void {
  const p = getEmbeddingModelPath();
  if (!ref) {
    if (existsSync(p)) rmSync(p, { force: true });
    return;
  }
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = {
    keyId: ref.keyId,
    modelId: ref.modelId,
  };
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

/* ── Rerank-model sidecar (Story 2.1 KB retrieval rerank preset) ── */
//
// Mirror of the embedding-model sidecar: `rerankModel` is a top-level ModelConfig
// field, but keys are stored one-YAML-per-key under `keys/`. Persist the ref in a
// sidecar `rerank-model.yaml` next to `keys/` so it round-trips across save/load.
// Absent file -> undefined (auto-detect via capability === 'rerank').

function getRerankModelPath(): string {
  return path.join(getModelDir(), 'rerank-model.yaml');
}

function readRerankModel(): ModelRef | undefined {
  try {
    const p = getRerankModelPath();
    if (!existsSync(p)) return undefined;
    const raw = parseFlatYaml(readFileSync(p, 'utf-8'));
    const keyId = typeof raw.keyId === 'string' ? raw.keyId.trim() : '';
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!keyId || !modelId) return undefined;
    return { keyId, modelId };
  } catch {
    return undefined;
  }
}

function writeRerankModel(ref: ModelRef | undefined): void {
  const p = getRerankModelPath();
  if (!ref) {
    if (existsSync(p)) rmSync(p, { force: true });
    return;
  }
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = {
    keyId: ref.keyId,
    modelId: ref.modelId,
  };
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

/* ── Vision-model sidecar (Story 3.6 R9b image-analysis preset) ── */
//
// Mirror of the embedding/rerank-model sidecars: `visionModel` is a top-level
// ModelConfig field, but keys are stored one-YAML-per-key under `keys/`. Persist
// the ref in a sidecar `vision-model.yaml` next to `keys/` so it round-trips
// across save/load. Absent file -> undefined (vision path degrades to the
// MANUAL export protocol; the main text model is never blind-tried).

function getVisionModelPath(): string {
  return path.join(getModelDir(), 'vision-model.yaml');
}

function readVisionModel(): ModelRef | undefined {
  try {
    const p = getVisionModelPath();
    if (!existsSync(p)) return undefined;
    const raw = parseFlatYaml(readFileSync(p, 'utf-8'));
    const keyId = typeof raw.keyId === 'string' ? raw.keyId.trim() : '';
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!keyId || !modelId) return undefined;
    return { keyId, modelId };
  } catch {
    return undefined;
  }
}

function writeVisionModel(ref: ModelRef | undefined): void {
  const p = getVisionModelPath();
  if (!ref) {
    if (existsSync(p)) rmSync(p, { force: true });
    return;
  }
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = {
    keyId: ref.keyId,
    modelId: ref.modelId,
  };
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

/* ── Task-model sidecar (C3.2 task-oriented routing slots) ── */
//
// Mirror of the embedding/rerank/vision-model sidecars: `taskModels` is a
// top-level ModelConfig record (slot → `{keyId, modelId}`), but keys are
// stored one-YAML-per-key under `keys/`. Persist the whole record in a sidecar
// `task-models.yaml` (flat dotted keys — same encoding as `models.N.id` in the
// key files) so it round-trips across save/load. Absent file → undefined —
// every slot falls back to the provider default sentinel (auto-pick).

function getTaskModelsPath(): string {
  return path.join(getModelDir(), 'task-models.yaml');
}

/**
 * Legal `slot.thinking` values, derived from the contract single source
 * (`slotAssignmentSchema`'s enum — note it deliberately has no `custom` member:
 * a non-empty `slot.thinkingCustom` string means level=custom). Read-side
 * hand-edit tolerance checks against this set; the zod save path enforces the
 * same enum loudly for renderer payloads.
 */
const SLOT_THINKING_LEVELS: ReadonlySet<string> = new Set(
  slotAssignmentSchema.shape.thinking.unwrap().options,
);

/**
 * Thinking-policy flat-key reader (09-12 子2 fallback chains, design §2): ONE
 * two-layer legality judgement (shape enum → per-model registry kind →
 * THINKING_PROFILES) shared by the main slot assignment AND the fallback-chain
 * entries — each entry's policy must be judged against ITS OWN model (kinds
 * differ across the chain), so the main assignment's profile can never be
 * reused. Returns only the legal fields; illegal hand-edited values drop just
 * that policy field with a warn (CR-008/CR-016 semantics unchanged for the
 * main assignment — warn context/message bytes are identical there).
 * `label` names the field in the warn text: 'slot.thinking' for the main
 * assignment, `slot.fallbacks.N.thinking` for a chain entry.
 */
function readSlotPolicyFields(
  raw: ReturnType<typeof parseFlatYaml>,
  prefix: string,
  modelId: string,
  warnCtx: Record<string, unknown>,
  label: string,
): Pick<SlotAssignment, 'thinking' | 'thinkingCustom'> {
  const fields: Pick<SlotAssignment, 'thinking' | 'thinkingCustom'> = {};
  // CR-016: per-model legality (registry kind → THINKING_PROFILES). Kindless
  // models (qwen etc.) are NOT judged — registry silence is not a legality
  // verdict, and their policy fields ride along untouched.
  const policyProfile = (() => {
    const kind = resolveModelInfo(modelId).thinking;
    return kind ? THINKING_PROFILES[kind] : undefined;
  })();
  const thinking = raw[`${prefix}.thinking`];
  if (thinking !== undefined) {
    const trimmed = typeof thinking === 'string' ? thinking.trim() : '';
    const level = trimmed as NonNullable<SlotAssignment['thinking']>;
    const shapeIllegal = !SLOT_THINKING_LEVELS.has(trimmed);
    const modelIllegal =
      !shapeIllegal &&
      policyProfile !== undefined &&
      level !== 'auto' &&
      !(
        policyProfile.levels.includes(level) &&
        (level !== 'off' || policyProfile.offLegal)
      );
    if (shapeIllegal) {
      getLogger().warn(
        { ...warnCtx, value: String(thinking) },
        `task-models sidecar: illegal ${label} value — thinking policy ignored for this slot`,
      );
    } else if (modelIllegal) {
      getLogger().warn(
        { ...warnCtx, modelId, value: trimmed },
        `task-models sidecar: ${label} value not legal for this model — thinking policy ignored for this slot`,
      );
    } else {
      fields.thinking = level;
    }
  }
  const thinkingCustom = raw[`${prefix}.thinkingCustom`];
  if (thinkingCustom !== undefined) {
    // Number coercion: parseFlatYaml parses unquoted numerics as numbers, and
    // a numeric BUDGET is a legitimate custom value ("8192" written by the
    // save path round-trips unquoted and comes back as number 8192).
    // Canonicalize to the schema's string form; booleans/null/comment garbage
    // stay illegal.
    const asString =
      typeof thinkingCustom === 'number' && Number.isFinite(thinkingCustom)
        ? String(thinkingCustom)
        : typeof thinkingCustom === 'string'
          ? thinkingCustom.trim()
          : '';
    // Comment-tolerance mirrors CR-008: both inline tails (`v # note`) and
    // comment-only values (`key: # note`) are rejected here.
    if (!asString || asString.includes(' #') || asString.startsWith('#')) {
      getLogger().warn(
        warnCtx,
        `task-models sidecar: illegal ${label}Custom value — custom policy ignored for this slot`,
      );
    } else if (policyProfile !== undefined && policyProfile.customHint === 'none') {
      // CR-016: the model is not customizable — a stored custom value can
      // never be sent; drop it here so the resolver and the UI never see a
      // dead policy.
      getLogger().warn(
        { ...warnCtx, modelId },
        `task-models sidecar: ${label}Custom not supported by this model — custom policy ignored for this slot`,
      );
    } else {
      fields.thinkingCustom = asString;
    }
  }
  return fields;
}

/**
 * Read the task-routing slot designations (C3.2 + 08-25 thinking policy).
 * Hand-edit tolerant — the disk file is the ONE lenient face of the slot
 * contract: an entry under an unknown slot key is never read (only the six
 * enum members are looked up), and an entry with a non-string, blank-after-trim,
 * or comment-contaminated ref field is skipped without failing the whole read.
 * The thinking policy keys (`slot.thinking` / `slot.thinkingCustom`) follow the
 * same per-key leniency: an illegal value drops just that policy field (warn),
 * never the slot's ref — at TWO layers (CR-016): shape (enum member / string
 * form) and per-model legality (registry kind → THINKING_PROFILES: off on a
 * forced kind, tiers the profile lacks, custom on a non-customizable kind). The zod save path is the loud-reject counterpart
 * (unknown record keys fail `modelConfigSaveSchema.parse` — see
 * contracts.test.ts). Returns undefined when nothing valid is on disk (all
 * slots auto-pick). Exported for the agentIpc slot-resolver injection.
 *
 * CR-004 mtime+size-gated cache: the resolver sits on a hot path (one chain
 * assembly resolves 12+ slots, a dialogue turn up to ~50 steps), so each read
 * stat()s the sidecar and only re-reads+parses when the stat changed — same
 * "fresh query" semantics (a settings change rewrites the file and takes effect
 * immediately; nothing is cached across a dir switch or a save). Warns fire
 * only on an actual re-read, never per cached call (CR-005).
 */
let taskModelsCache: { mtimeMs: number; size: number; slots: ModelConfig['taskModels'] } | undefined;

export function readTaskModelSlots(): ModelConfig['taskModels'] {
  // stat captured outside the inner try so the failure path can cache the miss
  // keyed by the same stat (a persistently unreadable file warns once per file
  // change, not per resolve call).
  let stat: Stats | undefined;
  try {
    const p = getTaskModelsPath();
    try {
      stat = statSync(p);
    } catch {
      // Missing file (never configured / cleared back to Auto) — also drops any
      // cache entry from when the file existed.
      taskModelsCache = undefined;
      return undefined;
    }
    if (
      taskModelsCache &&
      taskModelsCache.mtimeMs === stat.mtimeMs &&
      taskModelsCache.size === stat.size
    ) {
      return taskModelsCache.slots;
    }
    const raw = parseFlatYaml(readFileSync(p, 'utf-8'));
    const slots: Partial<Record<TaskModelSlot, SlotAssignment>> = {};
    for (const slot of taskModelSlotSchema.options) {
      const keyId = raw[`${slot}.keyId`];
      const modelId = raw[`${slot}.modelId`];
      if (typeof keyId !== 'string' || !keyId.trim()) continue;
      if (typeof modelId !== 'string' || !modelId.trim()) continue;
      // CR-008 hand-edit tolerance: a trailing shell comment (`keyId: v1 # note`)
      // rides into the parsed value as `v1 # note`. Never ingest comment text as
      // a ref component — skip the slot and warn (bounded by re-read frequency).
      if (keyId.includes(' #') || modelId.includes(' #')) {
        getLogger().warn(
          { slot },
          'task-models sidecar: entry value contains a trailing comment (" #") — slot skipped; write "key: value" lines without trailing comments',
        );
        continue;
      }
      const assignment: SlotAssignment = { keyId: keyId.trim(), modelId: modelId.trim() };
      // Thinking policy keys (08-25): per-key leniency — an illegal hand-edited
      // value drops just the policy field (warn), never the slot itself. An
      // absent key leaves the field off the assignment entirely (auto). The
      // two-layer legality now lives in readSlotPolicyFields (shared with the
      // fallback entries below — per-model, so each target model is judged
      // against its own registry kind).
      const policy = readSlotPolicyFields(raw, slot, assignment.modelId, { slot }, 'slot.thinking');
      if (policy.thinking !== undefined) assignment.thinking = policy.thinking;
      if (policy.thinkingCustom !== undefined) assignment.thinkingCustom = policy.thinkingCustom;
      // ── 09-12 子2 fallback chain：`${slot}.fallbacks.N.*` flat 键连续扫描 ──
      // 索引 0..N 顺序读，keyId/modelId 缺失（含注释尾污染）即链止；条目与主指派或
      // 前序条目重复 → warn + drop（读侧容忍——去重不入 schema，UI 侧已选禁用是第一道）；
      // 条目 thinking 合法性逐条判定（同 helper、各自模型）。链挂 assignment 上 ⇒ 本循环
      // 只有主指派有效才进来（缺 keyId/modelId 的 slot 早 continue），auto-pick 档无链。
      // 零有效条目 → fallbacks 字段不出现（二态契约——写侧同款）。
      // CR-18（09-12 子2 CR 批）：本 flat 读路径对空数组形态**天然免疫**（手编 yaml 写
      // `slot.fallbacks: []` 解析为标量键、链扫描按 `fallbacks.N.*` 子键进行，空数组根本
      // 进不了 assignment）——空数组的 lenient 归一单点在 save 面
      // normalizeTaskModelsForParse（parse 前 `[]` → 缺席），读侧无需第二处。
      const chain: NonNullable<SlotAssignment['fallbacks']> = [];
      const seenRefs = new Set([JSON.stringify([assignment.keyId, assignment.modelId])]);
      for (let i = 0; ; i++) {
        const entryPrefix = `${slot}.fallbacks.${i}`;
        const fbKeyId = raw[`${entryPrefix}.keyId`];
        const fbModelId = raw[`${entryPrefix}.modelId`];
        if (typeof fbKeyId !== 'string' || !fbKeyId.trim()) break;
        if (typeof fbModelId !== 'string' || !fbModelId.trim()) break;
        if (fbKeyId.includes(' #') || fbModelId.includes(' #')) {
          // CR-008 family: never ingest comment text as a ref component — the
          // chain stops at this entry (a mid-chain gap), the slot and earlier
          // entries survive.
          getLogger().warn(
            { slot, entry: i },
            'task-models sidecar: fallback entry value contains a trailing comment (" #") — chain stops at this entry',
          );
          break;
        }
        const entryKey = fbKeyId.trim();
        const entryModel = fbModelId.trim();
        const refKey = JSON.stringify([entryKey, entryModel]);
        if (seenRefs.has(refKey)) {
          getLogger().warn(
            { slot, entry: i, keyId: entryKey, modelId: entryModel },
            'task-models sidecar: duplicate fallback entry (matches the main assignment or an earlier entry) — entry dropped',
          );
          continue;
        }
        seenRefs.add(refKey);
        const entry: SlotFallbackEntry = { keyId: entryKey, modelId: entryModel };
        const entryPolicy = readSlotPolicyFields(
          raw,
          entryPrefix,
          entryModel,
          { slot, entry: i },
          `slot.fallbacks.${i}.thinking`,
        );
        if (entryPolicy.thinking !== undefined) entry.thinking = entryPolicy.thinking;
        if (entryPolicy.thinkingCustom !== undefined) entry.thinkingCustom = entryPolicy.thinkingCustom;
        chain.push(entry);
      }
      if (chain.length > 0) assignment.fallbacks = chain;
      slots[slot] = assignment;
    }
    const result = Object.keys(slots).length > 0 ? slots : undefined;
    taskModelsCache = { mtimeMs: stat.mtimeMs, size: stat.size, slots: result };
    return result;
  } catch (err) {
    // CR-005: never silent — an unreadable sidecar silently re-points every
    // slot to auto-pick, which is indistinguishable from "not configured"
    // unless the failure is logged. Cache the miss so the warn is per file
    // change, not per call.
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'task-models sidecar read failed — every slot falls back to auto-pick',
    );
    if (stat) taskModelsCache = { mtimeMs: stat.mtimeMs, size: stat.size, slots: undefined };
    else taskModelsCache = undefined;
    return undefined;
  }
}

function writeTaskModels(slots: ModelConfig['taskModels']): void {
  const p = getTaskModelsPath();
  // Mirror embedding convention: undefined — or an empty record (the UI cleared
  // every slot back to "Auto") — removes the sidecar so a reload yields
  // undefined, never a lingering stale designation.
  if (!slots || Object.keys(slots).length === 0) {
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true, recursive: true });
      } catch (err) {
        // CR-005: a failed removal (exotic — e.g. a path locked by another
        // handle) must NOT block config:save-model; warn so stale designations
        // surviving a "clear every slot" save stay visible.
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err) },
          'task-models sidecar removal failed — stale slot designations may survive this save',
        );
      }
    }
    return;
  }
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = {};
  for (const [slot, assignment] of Object.entries(slots) as Array<[TaskModelSlot, SlotAssignment | undefined]>) {
    if (!assignment) continue;
    flat[`${slot}.keyId`] = assignment.keyId;
    flat[`${slot}.modelId`] = assignment.modelId;
    // Thinking policy (08-25): written only when set, so an existing sidecar
    // without the keys round-trips unchanged (zero migration). Values arrive
    // schema-validated here — writeTaskModels only runs after
    // modelConfigSaveSchema.parse on the save path.
    if (assignment.thinking) flat[`${slot}.thinking`] = assignment.thinking;
    if (assignment.thinkingCustom) flat[`${slot}.thinkingCustom`] = assignment.thinkingCustom;
    // 09-12 子2 fallback chain (design §2): flat keys `${slot}.fallbacks.N.*`,
    // written only when the assignment carries a chain — an existing sidecar
    // without the keys round-trips unchanged (zero migration, the two-state
    // write-side discipline: zero entries = keys stay absent). Entries arrive
    // schema-validated here — writeTaskModels only runs after
    // modelConfigSaveSchema.parse on the save path.
    if (assignment.fallbacks?.length) {
      assignment.fallbacks.forEach((entry, i) => {
        flat[`${slot}.fallbacks.${i}.keyId`] = entry.keyId;
        flat[`${slot}.fallbacks.${i}.modelId`] = entry.modelId;
        if (entry.thinking) flat[`${slot}.fallbacks.${i}.thinking`] = entry.thinking;
        if (entry.thinkingCustom) flat[`${slot}.fallbacks.${i}.thinkingCustom`] = entry.thinkingCustom;
      });
    }
  }
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

/**
 * CR-18（09-12 子2 CR 批）：taskModels lenient 归一——slot 的 `fallbacks` 为**空数组**时
 * 剥键（空链 ≡ 无链，slotAssignmentSchema `.min(1)` 二态契约的空侧），归一后再过
 * modelConfigSaveSchema.parse。语义等价归一而非校验放宽：非空链照常严格 parse
 *（`.min(1)` 对「链上条目」的约束原样保留），只是空数组不再砖死整次 parse（此前一个
 * slot 携 `fallbacks: []` 的载荷 = 用户连无关设置都存不了）。
 *
 * 归一**单点**在本 helper：侧车 flat 读路径天然免疫（readTaskModelSlots 按
 * `slot.fallbacks.N.*` 键连续扫描，手编 yaml 写 `fallbacks: []` 根本进不了 assignment
 * ——空数组形态只可能经 save 载荷回流）；agent 投递侧 assignmentFallbackChain 的
 * `?.length` 门保留为第二道（单处防御）。
 */
function normalizeTaskModelsForParse(config: ModelConfig): ModelConfig {
  const taskModels = config?.taskModels;
  if (!taskModels) return config;
  let changed = false;
  const normalized: NonNullable<ModelConfig['taskModels']> = {};
  for (const [slot, assignment] of Object.entries(taskModels) as Array<[TaskModelSlot, SlotAssignment | undefined]>) {
    if (assignment && Array.isArray(assignment.fallbacks) && assignment.fallbacks.length === 0) {
      const { fallbacks: _empty, ...rest } = assignment;
      normalized[slot] = rest;
      changed = true;
    } else {
      normalized[slot] = assignment;
    }
  }
  return changed ? { ...config, taskModels: normalized } : config;
}

/* ── Research net proxy sidecar (Story 3.6 WP2, R13 / design D6) ── */
//
// Mirror of the embedding/rerank/vision-model sidecars: the research network
// proxy tier persists in `research-net.yaml` next to `keys/` and round-trips
// across save/load. Applied at startup (main/index.ts) + re-applied on every
// write so a settings change takes effect without a restart.
//
// Three tiers (Cherry Studio product mirror) map onto the RESEARCH partition
// session's `setProxy` (researchSession.ts, P2 CR 2026-08-15 — edge#112):
// the tier steers ONLY the research session (netFetch + the render_page
// sandbox window ride it), NEVER `session.defaultSession` — a research proxy
// setting (especially `off`) must not change proxying for the app's UI,
// model gateway, or updater traffic.
//
// Known limitation: session-level proxy AUTHENTICATION is not supported
// (Electron #21269). Workaround = a local auth-free proxy at the system level;
// the settings page must surface this (WP10).

function getResearchNetPath(): string {
  return path.join(getModelDir(), 'research-net.yaml');
}

/** Default custom-tier bypass list (localhost always bypasses the proxy). */
export const DEFAULT_PROXY_BYPASS = 'localhost,127.0.0.1,::1';

/**
 * Custom-tier `proxyBypassRules` value (the Electron 37 `setProxy` field):
 * the default loopback entries + the user's extra hosts (comma-joined). The
 * default is always kept — a custom proxy that intercepts localhost would
 * break localhost endpoint probes.
 */
export function resolveProxyBypassList(custom?: string): string {
  const trimmed = custom?.trim();
  return trimmed ? `${DEFAULT_PROXY_BYPASS},${trimmed}` : DEFAULT_PROXY_BYPASS;
}

/**
 * Read the persisted research net config. Absent/corrupt/invalid file degrades
 * to the default (`system`) — a broken proxy config must not brick research,
 * and `system` is always a sane fallback (Chromium auto-detects).
 */
export function readResearchNetConfig(): ResearchNetConfig {
  try {
    const p = getResearchNetPath();
    if (!existsSync(p)) return { ...DEFAULT_RESEARCH_NET_CONFIG };
    const raw = parseFlatYaml(readFileSync(p, 'utf-8'));
    const parsed = researchNetConfigSchema.safeParse({
      proxyMode: raw.proxyMode ?? DEFAULT_RESEARCH_NET_CONFIG.proxyMode,
      proxyUrl: typeof raw.proxyUrl === 'string' && raw.proxyUrl.trim() ? raw.proxyUrl : undefined,
      proxyBypass: typeof raw.proxyBypass === 'string' && raw.proxyBypass.trim() ? raw.proxyBypass : undefined,
    });
    return parsed.success ? parsed.data : { ...DEFAULT_RESEARCH_NET_CONFIG };
  } catch {
    return { ...DEFAULT_RESEARCH_NET_CONFIG };
  }
}

/**
 * Apply a proxy tier to the RESEARCH partition session (best-effort — never
 * throws; defaultSession is never touched, P2/edge#112). Instantiating the
 * session here also installs its private-net request guard early.
 */
export function applyResearchProxy(config: ResearchNetConfig): void {
  try {
    const ses = getResearchSession();
    if (config.proxyMode === 'custom' && config.proxyUrl?.trim()) {
      ses
        .setProxy({
          proxyRules: config.proxyUrl.trim(),
          proxyBypassRules: resolveProxyBypassList(config.proxyBypass),
        })
        .catch((err) => logProxyFailure('custom', err));
    } else if (config.proxyMode === 'off') {
      ses
        .setProxy({ mode: 'direct' })
        .catch((err) => logProxyFailure('off', err));
    } else {
      // 'system' — and a malformed custom entry (no URL) falls back here too:
      // a partition session follows the system proxy (incl. WPAD/PAC) by
      // default; stating it explicitly is a no-op that keeps the tier honest
      // after an 'off' → 'system' toggle (D6 rationale).
      ses
        .setProxy({ mode: 'system' })
        .catch((err) => logProxyFailure('system', err));
    }
  } catch (err) {
    logProxyFailure(config.proxyMode, err);
  }
}

function logProxyFailure(mode: string, err: unknown): void {
  getLogger().warn(
    { err: err instanceof Error ? err.message : String(err), mode },
    'applyResearchProxy: setProxy failed — research network keeps the previous proxy state',
  );
}

/** Read the persisted config and apply it (startup path, main/index.ts). */
export function applyResearchProxyFromDisk(): void {
  applyResearchProxy(readResearchNetConfig());
}

/**
 * Persist the research net config and re-apply it immediately (write path).
 * Validates via the schema — an invalid tier (e.g. `custom` without proxyUrl)
 * throws ZodError to the caller instead of silently persisting a dead config.
 */
export function writeResearchNetConfig(config: ResearchNetConfig): void {
  const parsed = researchNetConfigSchema.parse(config);
  const p = getResearchNetPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = { proxyMode: parsed.proxyMode };
  if (parsed.proxyUrl) flat.proxyUrl = parsed.proxyUrl;
  if (parsed.proxyBypass) flat.proxyBypass = parsed.proxyBypass;
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
  applyResearchProxy(parsed);
}

function readKeyFile(filePath: string): ApiKeyEntry | null {
  try {
    const raw = parseFlatYaml(readFileSync(filePath, 'utf-8'));
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) return null;

    const name = typeof raw.name === 'string' ? raw.name : id;
    const protocol = readProtocol(raw.protocol);
    // 09-12 agy provider：CLI 键的 baseUrl/apiKey 不落盘（写侧分支），缺席读回
    // undefined；HTTP 键两行恒在场（旧文件逐字节不变）。cliExecutable 仅 CLI 键携带。
    const cliExecutable =
      typeof raw.cliExecutable === 'string' && raw.cliExecutable.trim()
        ? raw.cliExecutable.trim()
        : undefined;
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined;
    const apiKey = typeof raw.apiKey === 'string' ? decrypt(raw.apiKey) : undefined;

    // 09-12 子3（design §7 读侧 lenient）：传输面四键 + 模型 defaults/extraBody/pricing
    // 按缺席处理一切病态形态（mirror readCapability 风格——盘上手改坏值不炸加载，
    // save 面 refine 才是强闸）。二态布尔只认 true（false ≡ ABSENT）。CR-5：lenient
    // 丢弃不再零诊断——每个「在场但不可用」的值 warn 留痕（坏值静默变缺席 = 用户配置
    // 神秘丢失无迹可查）。
    const warnCtx = { keyId: id, file: path.basename(filePath) };
    const customHeaders = readCustomHeaders(raw, warnCtx);
    const timeoutSeconds = readTimeoutSeconds(raw.timeoutSeconds, warnCtx);
    const streamingDisabled = raw.streamingDisabled === true || raw.streamingDisabled === 'true';
    const verifySsl = raw.verifySsl === true || raw.verifySsl === 'true';

    const models: ApiKeyEntry['models'] = [];
    for (let i = 0; ; i++) {
      const modelId = raw[`models.${i}.id`];
      if (typeof modelId !== 'string' || !modelId) break;
      const defaults = readModelDefaults(raw, i, { ...warnCtx, modelIndex: i });
      const extraBody = readModelExtraBody(raw[`models.${i}.extraBody`], { ...warnCtx, modelIndex: i });
      const pricing = readModelPricing(raw, i, { ...warnCtx, modelIndex: i });
      models.push({
        id: modelId,
        capability: readCapability(raw[`models.${i}.capability`]),
        alias: typeof raw[`models.${i}.alias`] === 'string' ? raw[`models.${i}.alias`] as string : modelId,
        enabled: raw[`models.${i}.enabled`] === true || raw[`models.${i}.enabled`] === 'true',
        ...(defaults ? { defaults } : {}),
        ...(extraBody ? { extraBody } : {}),
        ...(pricing ? { pricing } : {}),
      });
    }

    return {
      id,
      name,
      protocol,
      baseUrl,
      apiKey,
      models,
      ...(cliExecutable ? { cliExecutable } : {}),
      ...(Object.keys(customHeaders).length > 0 ? { customHeaders } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(streamingDisabled ? { streamingDisabled } : {}),
      ...(verifySsl ? { verifySsl } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 子3：flat 键 `headers.<Name>` 连续收集——lenient 读侧三道闸（CR-2/CR-3 09-12 子3
 * CR 批，全部与 save 面单源）：
 * 1. 名过 `customHeaderNameSchema`（token 子集正则单源 import——手抄正则与 schema 漂移
 *    是 CR-3 的第二半）；2. 名过 `BLOCKED_CUSTOM_HEADER_NAMES`（wire 序列化关键头黑名单
 *    同源 import——手改盘文件的 Authorization/Host 不得零过滤零日志地骑进该 key 的每个
 *    请求）；3. 值过 `customHeaderValueSchema`（控制字符/超长——CR/LF 进 undici
 *    Headers.set 抛错 = 该 key 全请求死，CR-17 复发级）。
 * 数值/布尔形态宽容回 String（手编 yaml 不加引号的 header 值）。丢弃一律 warn（CR-5）。
 */
function readCustomHeaders(
  raw: ReturnType<typeof parseFlatYaml>,
  warnCtx: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('headers.')) continue;
    const name = key.slice('headers.'.length);
    if (!customHeaderNameSchema.safeParse(name).success) {
      getLogger().warn(
        { ...warnCtx, name },
        'key file: illegal custom header name — header dropped (save face rejects it loudly; fix the file)',
      );
      continue;
    }
    if (BLOCKED_CUSTOM_HEADER_NAMES.has(name.toLowerCase())) {
      getLogger().warn(
        { ...warnCtx, name },
        'key file: custom header name is a wire-serialization header (blocked) — header dropped',
      );
      continue;
    }
    const asString =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : null;
    if (asString === null) {
      getLogger().warn(
        { ...warnCtx, name },
        'key file: custom header value is not a usable scalar — header dropped',
      );
      continue;
    }
    if (!customHeaderValueSchema.safeParse(asString).success) {
      getLogger().warn(
        { ...warnCtx, name },
        'key file: illegal custom header value (control characters / over 8192 chars) — header dropped',
      );
      continue;
    }
    headers[name] = asString;
  }
  return headers;
}

/**
 * 子3 per-key 超时读（CR-4/CR-7 09-12 子3 CR 批）：正整数 + 域上界（KEY_TIMEOUT_SECONDS
 * 单源——9999999 这种数日级 abort 窗按缺席处理）。在场但非法 → warn（CR-5）。
 */
function readTimeoutSeconds(value: unknown, warnCtx: Record<string, unknown>): number | undefined {
  if (value === undefined) return undefined;
  const usable =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= KEY_TIMEOUT_SECONDS_RANGE.min &&
    value <= KEY_TIMEOUT_SECONDS_RANGE.max;
  if (!usable) {
    getLogger().warn(
      { ...warnCtx, value: String(value), max: KEY_TIMEOUT_SECONDS_RANGE.max },
      'key file: illegal timeoutSeconds — treated as absent (must be an integer within the allowed range)',
    );
    return undefined;
  }
  return value;
}

/** 子3 模型默认参数六字段（与 modelDefaultsSchema 字段名同源；数值域 = MODEL_DEFAULT_RANGES 单源，CR-7）。 */
const MODEL_DEFAULT_FIELDS = ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'contextWindow', 'maxOutputTokens'] as const;

function readModelDefaults(
  raw: ReturnType<typeof parseFlatYaml>,
  index: number,
  warnCtx: Record<string, unknown>,
): ApiKeyEntry['models'][number]['defaults'] {
  const collected: Record<string, number> = {};
  for (const field of MODEL_DEFAULT_FIELDS) {
    const value = raw[`models.${index}.defaults.${field}`];
    if (value === undefined) continue;
    const range = MODEL_DEFAULT_RANGES[field];
    // CR-4：contextWindow/maxOutputTokens 是 int 字段——0/负/小数进链路会把预算/压缩
    // 红线数学毒化到 0（读侧 finite-only 放行是三处链路的源头洞）。CR-7：范围外
    // （temperature 99 → 每请求 400）同样按缺席 + warn。
    const usable =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (!range.integer || Number.isInteger(value)) &&
      value >= range.min &&
      value <= range.max;
    if (!usable) {
      getLogger().warn(
        { ...warnCtx, field, value: String(value) },
        'key file: illegal model default value — field dropped (out of the schema domain)',
      );
      continue;
    }
    collected[field] = value;
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

/** 子3：extraBody 单键 JSON-string（flat YAML dotted-key 无法忠实承载嵌套 JSON——design §4.3）。非对象产物按缺席。 */
function readModelExtraBody(
  value: unknown,
  warnCtx: Record<string, unknown>,
): ApiKeyEntry['models'][number]['extraBody'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    getLogger().warn(warnCtx, 'key file: illegal extraBody form — treated as absent');
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      getLogger().warn(warnCtx, 'key file: extraBody is not a JSON object — treated as absent');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // 坏 JSON 按缺席（warn 留痕，CR-5——静默丢弃让盘上配置神秘消失无迹可查）。
    getLogger().warn(warnCtx, 'key file: extraBody is broken JSON — treated as absent');
    return undefined;
  }
}

/** 子3 模型单价三字段（per 1M tokens，纯数字；域 = MODEL_PRICING_RANGE 单源，CR-7）。 */
const MODEL_PRICING_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'] as const;

function readModelPricing(
  raw: ReturnType<typeof parseFlatYaml>,
  index: number,
  warnCtx: Record<string, unknown>,
): ApiKeyEntry['models'][number]['pricing'] {
  const collected: Record<string, number> = {};
  for (const field of MODEL_PRICING_FIELDS) {
    const value = raw[`models.${index}.pricing.${field}`];
    if (value === undefined) continue;
    const usable =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MODEL_PRICING_RANGE.min &&
      value <= MODEL_PRICING_RANGE.max;
    if (!usable) {
      getLogger().warn(
        { ...warnCtx, field, value: String(value) },
        'key file: illegal model pricing value — field dropped (must be a non-negative finite number)',
      );
      continue;
    }
    collected[field] = value;
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

function readProtocol(value: unknown): ModelProtocol {
  // 09-12 agy provider：第三枚举成员原样透传——读侧吞掉会把 CLI 键静默降级成
  // 空 baseUrl 的 openai-compatible（生成必炸且难溯源）。
  if (value === 'anthropic-compatible' || value === 'antigravity-cli') return value;
  return 'openai-compatible';
}

function readCapability(value: unknown): ModelCapability {
  // CR-craft-kb-001: 'rerank' MUST be in the allowlist, else a config reload
  // silently downgrades an auto-detected rerank model's capability to 'text'
  // (the catch-all return) -> resolveRerankModel never auto-detects it again
  // after the first restart. Mirror of the 'embedding' allowlist entry.
  if (value === 'image' || value === 'video' || value === 'embedding' || value === 'rerank') return value;
  return 'text';
}

/* ── Write path ── */

function writeModelConfig(config: ModelConfig): void {
  const keysDir = getKeysDir();
  if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
  const existing = readModelConfig();
  const existingById = new Map(existing.keys.map((key) => [key.id, key]));

  const validIds = new Set(config.keys.map((k) => k.id));

  // Remove deleted keys
  for (const file of readdirSync(keysDir).filter((f) => f.endsWith('.yaml'))) {
    const id = file.replace(/\.yaml$/, '');
    if (!validIds.has(id)) rmSync(path.join(keysDir, file), { force: true });
  }

  // Write each key
  for (const key of config.keys) {
    const flat: Record<string, FlatConfigValue> = {
      id: key.id,
      name: key.name,
      protocol: key.protocol,
    };
    if (key.protocol === 'antigravity-cli') {
      // 09-12 agy provider：CLI 键不落 HTTP 凭据（schema 形态互斥的盘面镜像），
      // cliExecutable 是该形态的判别载荷。模型列表与 HTTP 键同形。
      if (key.cliExecutable) flat.cliExecutable = key.cliExecutable;
    } else {
      // HTTP 键写入序（id/name/protocol/baseUrl/apiKey）与旧实现逐键一致——旧文件字节不变。
      const apiKey = key.apiKey || existingById.get(key.id)?.apiKey || '';
      flat.baseUrl = key.baseUrl ?? '';
      flat.apiKey = encrypt(apiKey);
      // 09-12 子3：传输面三键（headers 平铺 `headers.<Name>` / timeoutSeconds /
      // streamingDisabled）——条件展开，二态不落空值（CLI 键 refine 拒收这三个字段，
      // 只可能出现在 HTTP 分支）。verifySsl 在分支外两形态共写（CLI 容忍——refine 放行，
      // 无消费面）。CR-6：header 字符串值一律 flatQuoted（写侧引号包裹）——裸写时
      // yes/no/true/false/null/精确数值族的字符串会被 parseScalar 重释成布尔/数值/null
      // （'null' 直接丢头），引号形态经 JSON 对称还原逐字保真。
      if (key.customHeaders && Object.keys(key.customHeaders).length > 0) {
        for (const [headerName, headerValue] of Object.entries(key.customHeaders)) {
          flat[`headers.${headerName}`] = flatQuoted(headerValue);
        }
      }
      if (typeof key.timeoutSeconds === 'number') flat.timeoutSeconds = key.timeoutSeconds;
      if (key.streamingDisabled === true) flat.streamingDisabled = true;
    }
    if (key.verifySsl === true) flat.verifySsl = true;
    key.models.forEach((model, i) => {
      flat[`models.${i}.id`] = model.id;
      flat[`models.${i}.capability`] = model.capability;
      flat[`models.${i}.alias`] = model.alias;
      flat[`models.${i}.enabled`] = model.enabled;
      // 09-12 子3：模型默认参数 / extraBody（单键 JSON-string——flat dotted-key 无法
      // 忠实承载嵌套 JSON）/ 单价——全部条件展开（缺席字段不落键，旧文件字节不变）。
      if (model.defaults) {
        for (const field of MODEL_DEFAULT_FIELDS) {
          const value = model.defaults[field];
          if (typeof value === 'number') flat[`models.${i}.defaults.${field}`] = value;
        }
      }
      if (model.extraBody && Object.keys(model.extraBody).length > 0) {
        flat[`models.${i}.extraBody`] = JSON.stringify(model.extraBody);
      }
      if (model.pricing) {
        for (const field of MODEL_PRICING_FIELDS) {
          const value = model.pricing[field];
          if (typeof value === 'number') flat[`models.${i}.pricing.${field}`] = value;
        }
      }
    });
    atomicWriteFileSync(path.join(keysDir, `${key.id}.yaml`), stringifyFlatYaml(flat), 'utf-8');
  }

  // Persist the top-level embedding-model preset (sidecar). `undefined` clears
  // any previous designation so the UI "Auto" choice actually unsets it.
  writeEmbeddingModel(config.embeddingModel);
  // Persist the top-level rerank-model preset (sidecar, mirror embeddingModel).
  writeRerankModel(config.rerankModel);
  // Persist the top-level vision-model preset (sidecar, mirror embeddingModel).
  writeVisionModel(config.visionModel);
  // Persist the task-routing slot designations (sidecar, mirror embeddingModel
  // — undefined or an empty record removes the file, see writeTaskModels).
  writeTaskModels(config.taskModels);
}

/* ── Migration from old profile-based config ── */

function migrateFromProfiles(): ModelConfig | null {
  const profilesDir = path.join(getModelDir(), 'profiles');
  if (!existsSync(profilesDir)) return null;

  const files = readdirSync(profilesDir).filter((f) => f.endsWith('.yaml'));
  if (files.length === 0) return null;

  const keys: ApiKeyEntry[] = [];
  for (const file of files) {
    try {
      const raw = parseFlatYaml(readFileSync(path.join(profilesDir, file), 'utf-8'));
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id) continue;

      const name = typeof raw.name === 'string' ? raw.name : id;
      const protocol = readProtocol(raw.protocol);
      const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
      const apiKey = typeof raw.apiKey === 'string' ? decrypt(raw.apiKey) : '';

      const models: ApiKeyEntry['models'] = [];
      for (let i = 0; ; i++) {
        const modelId = raw[`models.${i}.id`];
        if (typeof modelId !== 'string' || !modelId) break;
        const cap = raw[`models.${i}.capabilities`];
        const capability = typeof cap === 'string' && cap.includes('image') ? 'image' as const
          : typeof cap === 'string' && cap.includes('video') ? 'video' as const
          : 'text' as const;
        const alias = typeof raw[`models.${i}.alias`] === 'string' ? raw[`models.${i}.alias`] as string : modelId;
        models.push({ id: modelId, capability, alias, enabled: true });
      }

      if (models.length > 0) keys.push({ id, name, protocol, baseUrl, apiKey, models });
    } catch { /* skip broken files */ }
  }

  if (keys.length === 0) return null;

  const config: ModelConfig = { keys };
  writeModelConfig(config);
  return config;
}

/* ── User preferences ── */

function readUserPreferences(): UserPreferencesConfig {
  try {
    const p = getUserPreferencesPath();
    if (!existsSync(p)) return { ...DEFAULT_USER_PREFERENCES };
    const raw = parseFlatYaml(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    return {
      theme: typeof raw?.theme === 'string' ? raw.theme : DEFAULT_USER_PREFERENCES.theme,
      locale: typeof raw?.locale === 'string' ? raw.locale : DEFAULT_USER_PREFERENCES.locale,
      autoCheckUpdates:
        typeof raw?.autoCheckUpdates === 'boolean'
          ? raw.autoCheckUpdates
          : DEFAULT_USER_PREFERENCES.autoCheckUpdates,
      updateManifestUrl:
        typeof raw?.updateManifestUrl === 'string' && raw.updateManifestUrl.length > 0
          ? raw.updateManifestUrl
          : undefined,
      readingFontFamily:
        typeof raw?.readingFontFamily === 'string' && raw.readingFontFamily.length > 0
          ? raw.readingFontFamily
          : undefined,
      readingFontWeight:
        typeof raw?.readingFontWeight === 'number'
          ? raw.readingFontWeight
          : DEFAULT_USER_PREFERENCES.readingFontWeight,
      readingFontScale:
        typeof raw?.readingFontScale === 'number'
          ? raw.readingFontScale
          : DEFAULT_USER_PREFERENCES.readingFontScale,
      paragraphIndent:
        typeof raw?.paragraphIndent === 'boolean'
          ? raw.paragraphIndent
          : DEFAULT_USER_PREFERENCES.paragraphIndent,
      showWordCount:
        typeof raw?.showWordCount === 'boolean'
          ? raw.showWordCount
          : DEFAULT_USER_PREFERENCES.showWordCount,
      autoSaveEnabled:
        typeof raw?.autoSaveEnabled === 'boolean'
          ? raw.autoSaveEnabled
          : DEFAULT_USER_PREFERENCES.autoSaveEnabled,
      autoSaveInterval:
        typeof raw?.autoSaveInterval === 'number'
          ? raw.autoSaveInterval
          : DEFAULT_USER_PREFERENCES.autoSaveInterval,
      spellCheck:
        typeof raw?.spellCheck === 'boolean'
          ? raw.spellCheck
          : DEFAULT_USER_PREFERENCES.spellCheck,
      wordCountGoal:
        typeof raw?.wordCountGoal === 'number'
          ? raw.wordCountGoal
          : DEFAULT_USER_PREFERENCES.wordCountGoal,
      editorLineHeight:
        typeof raw?.editorLineHeight === 'number'
          ? raw.editorLineHeight
          : DEFAULT_USER_PREFERENCES.editorLineHeight,
      contextCompaction: {
        // Clamp to the legal 50–100 range on read (the UI slider constrains,
        // but the flat YAML is hand-editable); illegal/missing falls back to the
        // default (95) — zero migration for preferences.yaml files written
        // before this key existed.
        redlinePercent:
          typeof raw?.['contextCompaction.redlinePercent'] === 'number' &&
          Number.isFinite(raw['contextCompaction.redlinePercent'])
            ? Math.min(100, Math.max(50, raw['contextCompaction.redlinePercent']))
            : DEFAULT_USER_PREFERENCES.contextCompaction!.redlinePercent,
      },
      wallpaperUrl:
        typeof raw?.wallpaperUrl === 'string' && raw.wallpaperUrl.length > 0
          ? raw.wallpaperUrl
          : undefined,
      wallpaperOpacity:
        // Clamp to the legal 0.1–1 range on read (the UI slider constrains, but
        // the flat YAML is hand-editable); illegal/missing falls back to the
        // default (1) — same zero-migration story as contextCompaction above.
        typeof raw?.wallpaperOpacity === 'number' && Number.isFinite(raw.wallpaperOpacity)
          ? Math.min(1, Math.max(0.1, raw.wallpaperOpacity))
          : DEFAULT_USER_PREFERENCES.wallpaperOpacity,
      // 磨砂强度（08-29 开关→滑杆）：读路径归一零迁移——新键 number 钳 0–50 整数；
      // 旧布尔键 wallpaperFrost（固定 20px 开关）仅在新键缺席/非法时折算：
      // true → 20、false/缺省 → 0。读写两侧同守一道钳（wallpaperOpacity 同款）。
      wallpaperFrostBlur:
        typeof raw?.wallpaperFrostBlur === 'number' && Number.isFinite(raw.wallpaperFrostBlur)
          ? Math.min(50, Math.max(0, Math.round(raw.wallpaperFrostBlur)))
          : raw?.wallpaperFrost === true
            ? 20
            : DEFAULT_USER_PREFERENCES.wallpaperFrostBlur,
      // R8 全局界面缩放：读路径钳回合法带（0.85–1.3）；非法/缺键回默认 1（存量文件零迁移）。
      interfaceScale: clampInterfaceScale(raw?.interfaceScale),
      // 09-12 usage-panel R5 用量保留窗：读路径钳回合法带 [7,730]（UI 输入框约束，但
      // flat YAML 可手改）；非法/缺键回默认 90（存量文件零迁移，interfaceScale 同款）。
      usageRetentionDays: clampUsageRetentionDays(raw?.usageRetentionDays),
    };
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
}

function writeUserPreferences(config: UserPreferencesConfig): void {
  const p = getUserPreferencesPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const flat: Record<string, string | number | boolean | null> = {
    theme: config.theme,
    locale: config.locale,
    autoCheckUpdates: config.autoCheckUpdates ?? true,
  };
  if (config.updateManifestUrl) flat.updateManifestUrl = config.updateManifestUrl;
  if (config.readingFontFamily) flat.readingFontFamily = config.readingFontFamily;
  if (typeof config.readingFontWeight === 'number') flat.readingFontWeight = config.readingFontWeight;
  if (typeof config.readingFontScale === 'number') flat.readingFontScale = config.readingFontScale;
  if (typeof config.paragraphIndent === 'boolean') flat.paragraphIndent = config.paragraphIndent;
  if (typeof config.showWordCount === 'boolean') flat.showWordCount = config.showWordCount;
  if (typeof config.autoSaveEnabled === 'boolean') flat.autoSaveEnabled = config.autoSaveEnabled;
  if (typeof config.autoSaveInterval === 'number') flat.autoSaveInterval = config.autoSaveInterval;
  if (typeof config.spellCheck === 'boolean') flat.spellCheck = config.spellCheck;
  if (typeof config.wordCountGoal === 'number') flat.wordCountGoal = config.wordCountGoal;
  if (typeof config.editorLineHeight === 'number') flat.editorLineHeight = config.editorLineHeight;
  if (
    config.contextCompaction &&
    typeof config.contextCompaction.redlinePercent === 'number'
  ) {
    flat['contextCompaction.redlinePercent'] = config.contextCompaction.redlinePercent;
  }
  if (config.wallpaperUrl) flat.wallpaperUrl = config.wallpaperUrl;
  if (typeof config.wallpaperOpacity === 'number') flat.wallpaperOpacity = config.wallpaperOpacity;
  // 磨砂强度：**写时钳制** 0–50 整数（照 interfaceScale 写时钳制先例——越界值不先
  // 落盘）；NaN/Infinity 不写键（盘面保持干净可手改）。只写新键 wallpaperFrostBlur，
  // 旧布尔键不再写（读路径折算兜底存量，升级后首次保存自然收敛到新键）。
  if (
    typeof config.wallpaperFrostBlur === 'number' &&
    Number.isFinite(config.wallpaperFrostBlur)
  ) {
    flat.wallpaperFrostBlur = Math.min(50, Math.max(0, Math.round(config.wallpaperFrostBlur)));
  }
  // R8：界面缩放**写时钳制**（BMad CR 组4：读写两侧同守一道钳——此前只有读路径
  // clampInterfaceScale 自愈，越界值会先落盘，盘面短暂携带非法值）。有限数值落盘前
  // 钳回合法带；NaN/Infinity 仍不写键（盘面保持干净可手改）。
  if (typeof config.interfaceScale === 'number' && Number.isFinite(config.interfaceScale)) {
    flat.interfaceScale = clampInterfaceScale(config.interfaceScale);
  }
  // 09-12 usage-panel R5：用量保留窗**写时钳制** [7,730]（clamp-before-persist 保磁盘
  // 恒合法——越界值不先落盘，mirror interfaceScale 先例）；NaN/Infinity 不写键（盘面
  // 保持干净可手改）。
  if (typeof config.usageRetentionDays === 'number' && Number.isFinite(config.usageRetentionDays)) {
    flat.usageRetentionDays = clampUsageRetentionDays(config.usageRetentionDays);
  }
  atomicWriteFileSync(p, stringifyFlatYaml(flat), 'utf-8');
}

export function readUserPreferencesFromDisk(): UserPreferencesConfig {
  return readUserPreferences();
}

/* ── Imported fonts ── */

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];
const FONT_MIME: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getFontsDir(): string {
  return path.join(app.getPath('userData'), 'fonts');
}

/** Build an ImportedFont from a file on disk, or null if unreadable. */
function readImportedFont(file: string): ImportedFont | null {
  try {
    const ext = path.extname(file).toLowerCase();
    const mime = FONT_MIME[ext] ?? 'application/octet-stream';
    const base64 = readFileSync(file).toString('base64');
    return {
      family: path.basename(file, path.extname(file)),
      dataUrl: `data:${mime};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

/** Enumerate fonts the user has imported into userData/fonts. */
function listImportedFonts(): ImportedFont[] {
  const dir = getFontsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => FONT_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .map((name) => readImportedFont(path.join(dir, name)))
    .filter((f): f is ImportedFont => f !== null)
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** Open a file picker, copy chosen font files into userData/fonts, return the full list. */
async function importFonts(): Promise<ImportedFont[]> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Fonts', extensions: FONT_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled) return listImportedFonts();
  const dir = getFontsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const src of result.filePaths) {
    const ext = path.extname(src).toLowerCase();
    if (!FONT_EXTENSIONS.includes(ext)) continue;
    try {
      copyFileSync(src, path.join(dir, path.basename(src)));
    } catch {
      // Skip files that can't be copied; the rest still import.
    }
  }
  return listImportedFonts();
}

/* ── App wallpaper（08-25 全窗口背景；镜像 importFonts 范式）── */

const WALLPAPER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];

function getWallpaperDir(): string {
  return path.join(app.getPath('userData'), 'wallpaper');
}

/**
 * Open a file picker (single image), copy the chosen file into
 * `userData/wallpaper/<basename>` (same-name re-import overwrites), and return
 * an `orison-file:///` URL for the COPY — never the source path — so moving or
 * deleting the source file afterwards cannot break the background. Null when
 * the dialog is canceled or the picked file is not a supported image.
 */
async function importWallpaper(): Promise<{ url: string } | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: WALLPAPER_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled) return null;
  const src = result.filePaths[0];
  if (!WALLPAPER_EXTENSIONS.includes(path.extname(src).toLowerCase())) return null;
  const dir = getWallpaperDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(src));
  copyFileSync(src, dest);
  // Forward slashes: the renderer feeds this into both <img src> and a CSS
  // `url("...")` string — CSS quoted-string parsing eats bare backslashes
  // (escape sequences), and the protocol resolver normalizes either form.
  return { url: `orison-file:///${dest.replace(/\\/g, '/')}` };
}

/** Delete every file inside `userData/wallpaper` (the directory itself is kept). */
function clearWallpaper(): void {
  const dir = getWallpaperDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // Skip entries that can't be removed; the rest still clear.
    }
  }
}

/* ── Resolver helpers reused by gateway / story-sync IPC ── */

export function readModelConfigFromDisk(): ModelConfig {
  return readModelConfig();
}

function _getModelDirForTest(): string {
  return getModelDir();
}

/* ── VS1 KB: embedding-model swap → reindex (CR-01 / AC7) ── */
//
// `config:save-model` has no projectId context (settings are global). When the
// embedding-model designation changes, the derived vector index of EVERY project
// must be rebuilt: vectors are not comparable across models (research
// `embedding-model-swap-compatibility-2026-07-23.md` §2.4 — different models live
// in different geometric spaces even at the same dim), so the old vectors are
// meaningless under the new model. VS1 is single-project; multi-project = full
// sweep, which is the correct global behavior on a model swap (the vec0 table is
// shared across projects, and every project's vectors must re-embed).

/**
 * Pure predicate (CR-01): did the embedding-model designation change between two
 * configs? Deep-equal on `{keyId, modelId}`. Both-absent → false (no change);
 * exactly one absent → true (designation added or removed); both present but
 * differing in keyId or modelId → true. Treats `null` and `undefined` alike
 * (absent). Exported for unit testing.
 */
export function embeddingModelChanged(
  before: ModelRef | undefined | null,
  after: ModelRef | undefined | null,
): boolean {
  const a = before ?? undefined;
  const b = after ?? undefined;
  if (a === undefined && b === undefined) return false;
  if (a === undefined || b === undefined) return true;
  return a.keyId !== b.keyId || a.modelId !== b.modelId;
}

/**
 * Reindex every project that has `closure_entry` rows under the newly-saved
 * embedding model (CR-01/AC7). Reads `SELECT DISTINCT project_id FROM
 * closure_entry` and calls `reindexAll(projectId)` for each. Best-effort: a
 * per-project failure is logged and the loop continues (one bad project must not
 * abort the others); the whole sweep is wrapped so a config save NEVER fails due
 * to a reindex error. Exported for unit testing (with a mocked getDb/reindexAll).
 *
 * dogfood #39（T2 Batch C1，2026-08-25）两处扩展：
 * - **恢复面补章源**：`entry_vec` 的 dim 重建是全库事件（DROP 时 E1 迁移清
 *   `content_hash` → 章源行 pending），而 `reindexAll` 只重嵌 project_assets——不补
 *   章源则扫后索引永远 stale（启动 reconcile 的 stale 判定会每次启动重扫、永不收敛）。
 *   mirror 手动重建（`closureIndexIpc`）的五源恢复面。
 * - **`opts.force`**：缺省 `true`（save-model 触发 = 授权的模型迁移，全量重嵌）。
 *   启动 reconcile 的「仅 pending 积压、模型一致」形态传 `false`——健康行 hash-skip
 *   零成本，只重试待补行（向量空间未变，重嵌健康行是纯浪费）。章摘要 skip 谓词含存量
 *   模型比对（CR-T2-001：同维换模型 hash 不清时仍重嵌到新模型，非只靠 force）。craft 表
 *   （closure_craft_vec）是独立 vec0 表 + 独立 dim 处理，`reindexAllCraft` 恒 force
 *   （craft 库小，全量成本有界）。
 *
 * CR-T2-003/013（dogfood T2 patch 批，2026-08-25）三处修补：
 * - **幽灵项目行清理**：`closure_entry.project_id` 查不到注册库 path（项目已注销/注册表
 *   被清）的行是派生垃圾——其 pending 计入全局 degraded 判定，令 reconcile 每次启动
 *   空转重扫永不收敛。扫中逐 project 清除（closure_entry 触发器同步 FTS；entry_vec 按
 *   project_id 删，gated vec 扩展），warn 留痕。防御性：软归档（deleted_at）项目仍可从
 *   回收站恢复，getProjectById 不滤 deleted_at → 不会被清。
 * - **craft 侧同谓词分档**：`opts.configuredModelId` 提供时按 `isVectorArmDegraded` 判
 *   craft 库真降级才跑 `reindexAllCraft`（其内部恒 force 整库重嵌）——否则启动 reconcile
 *   的仅积压形态会每次启动全量重嵌 craft（ADR-12 投入纪律）。undefined（无法判定，旧
 *   调用方/测试直调）→ 保守跑（mirror 旧行为）；null（未配置模型）→ 不跑（predicate
 *   语义：未配置 ≠ 降级）。调用方：启动 reconcile 传已解析的 modelId；save-model 传
 *   `parsed.embeddingModel?.modelId ?? null`。
 * - **`listChapterSummaries` try 包裹**：db 关闭/表缺失时枚举抛错不得逃出循环（否则剩余
 *   项目与 craft 重嵌全部被跳过，违背单项目失败不中止）——warn 后 continue 该项目摘要面。
 */
export async function reindexAllForChangedModel(
  opts: { force?: boolean; configuredModelId?: string | null } = {},
): Promise<void> {
  const force = opts.force !== false;
  let rows: Array<{ project_id: string }>;
  try {
    const db = getDb();
    rows = db.prepare('SELECT DISTINCT project_id FROM closure_entry').all() as Array<{ project_id: string }>;
  } catch (err) {
    // The vec/derived tables may not exist yet (fresh install, no assets) or the
    // db may be unavailable — nothing to reindex, and a config save must not fail.
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err) },
      'closure reindexAll: cannot enumerate projects — skipping (nothing to reindex)',
    );
    return;
  }
  for (const { project_id } of rows) {
    const projectPath = getProjectById(project_id)?.path;
    if (!projectPath) {
      // CR-T2-003②：幽灵项目行（注册库查无 path）——派生垃圾，清之（含 pending——否则
      // 全局 degraded 判定被它们顶成永真，reconcile 每次启动空转）。best-effort：清不动
      // 只 warn，不阻扫的其余项目。
      try {
        const db = getDb();
        const purged = db.transaction(() => {
          const del = db.prepare('DELETE FROM closure_entry WHERE project_id=?').run(project_id);
          if (isSqliteVecAvailable()) {
            db.prepare('DELETE FROM entry_vec WHERE project_id=?').run(project_id);
          }
          return del.changes;
        })();
        getLogger().warn(
          { projectId: project_id, purged },
          'closure reindexAll: ghost project rows purged (no registry entry) - continuing',
        );
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectId: project_id },
          'closure reindexAll: ghost purge failed - skipping project',
        );
      }
      continue;
    }
    try {
      getLogger().info({ projectId: project_id }, 'closure reindexAll: starting (embedding model changed)');
      const result = await reindexAll(project_id, { force });
      getLogger().info(
        {
          projectId: project_id,
          reindexed: result.reindexed,
          dimChanged: result.dimChanged,
          newDim: result.newDim,
        },
        'closure reindexAll: done (embedding model changed)',
      );
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), projectId: project_id },
        'closure reindexAll: per-project reindex failed - continuing',
      );
    }

    // Story 2.7 GAP2: reindex the project's asset_cards (setting cards) under the
    // new embedding model too. reindexAll only covers project_assets (its rows);
    // asset_cards live in project.yaml and share the same per-project vec0 space,
    // so a model swap invalidates their vectors as well. force=true bypasses the
    // content-hash skip (body unchanged but vectors must regenerate). Best-effort:
    // never blocks the sweep.（projectPath 已在循环首解析——幽灵项目在上方已清出循环。）
    if (projectPath) {
      try {
        const cardResult = await reindexAssetCards(projectPath, { force });
        getLogger().info(
          { projectId: project_id, reindexed: cardResult.reindexed, orphaned: cardResult.orphaned },
          'asset_cards reindex: done (embedding model changed)',
        );
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectId: project_id },
          'asset_cards reindex: failed after embedding-model change - continuing',
        );
      }
    }

    // Story 2.3 (BMad CR B1): mirror the 2.7 GAP2 block for setting_md. A model
    // swap DROPs+reCREATEs entry_vec GLOBALLY (all source_kinds), deleting setting_md
    // vectors; reindexAllSettingMd re-embeds them under the new model (force=true
    // bypasses the content-hash skip). Without this, setting_md vector/KNN retrieval
    // is silently broken after a model swap until a manual rebuild. Same projectPath
    // + best-effort (never blocks the sweep).
    if (projectPath) {
      try {
        const settingResult = await reindexAllSettingMd(projectPath, { force });
        getLogger().info(
          { projectId: project_id, reindexed: settingResult.reindexed, orphaned: settingResult.orphaned },
          'setting_md reindex: done (embedding model changed)',
        );
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectId: project_id },
          'setting_md reindex: failed after embedding-model change - continuing',
        );
      }
    }

    // dogfood #39（T2 Batch C1）：恢复面补章源（mirror 手动重建 `closure:rebuild-story-index`
    // 的 chunk + summary 两步）。chunk force 随扫（模型迁移须全量重嵌；仅积压形态 hash-skip
    // 健康章）；章摘要非 force（skip 谓词含存量模型比对 CR-T2-001——E1 迁移后 hash 已 NULL
    // 必重嵌；同维换模型存量旧模型也重嵌；健康模型健康摘要零成本 hash-skip）。
    if (projectPath) {
      try {
        const chapterResult = await rebuildChapterChunks(project_id, projectPath, { force });
        getLogger().info(
          { projectId: project_id, reindexed: chapterResult.reindexed, orphaned: chapterResult.orphaned },
          'chapter chunk reindex: done (embedding model changed)',
        );
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectId: project_id },
          'chapter chunk reindex: failed after embedding-model change - continuing',
        );
      }
      // CR-T2-013：枚举自身也包 try——db 关闭/表缺失时 listChapterSummaries 抛错不得逃出
      // 循环（否则剩余项目与 craft 重嵌全部被跳过，违背单项目失败不中止）。本项目的摘要
      // 面放弃（warn 留痕），后续项目照常。
      let summaries: Array<{ episodeId: string }>;
      try {
        summaries = listChapterSummaries(project_id);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectId: project_id },
          'chapter_summary reindex: cannot enumerate summaries - continuing with next project',
        );
        summaries = [];
      }
      let summaryReindexed = 0;
      for (const { episodeId } of summaries) {
        try {
          await reindexChapterSummaryEntry(project_id, projectPath, episodeId);
          summaryReindexed += 1;
        } catch (err) {
          getLogger().warn(
            { err: err instanceof Error ? err.message : String(err), projectId: project_id, episodeId },
            'chapter_summary reindex: failed after embedding-model change - continuing',
          );
        }
      }
      if (summaryReindexed > 0) {
        getLogger().info(
          { projectId: project_id, reindexed: summaryReindexed },
          'chapter_summary reindex: done (embedding model changed)',
        );
      }
    }
  }

  // Story 2.1: the global craft KB shares the same embedding model + vec0 dim, so
  // an embedding-model swap invalidates closure_craft_vec too. Re-embed the craft
  // docs under the new model (best-effort - a failure is logged, never blocks).
  //
  // CR-T2-003①（2026-08-25）：craft 侧同谓词分档——`reindexAllCraft` 内部恒 force 整库
  // 双向量重嵌，非收敛 pending 形态（启动 reconcile force=false 只重试待补行）下若照跑，
  // 会每次启动全量重嵌 craft 库（ADR-12 投入纪律）。真 degraded（pending 积压 / 存量模型
  // ≠ 配置）才跑；信号不可读（undefined configuredModelId 或 db 错）→ 保守跑 mirror 旧行为。
  let craftDegraded = true;
  if (opts.configuredModelId !== undefined) {
    try {
      const db = getDb();
      const craftPendingRow = db
        .prepare('SELECT COUNT(*) AS n FROM closure_craft_entry WHERE content_hash IS NULL')
        .get() as { n: number } | undefined;
      const craftModelRows = db
        .prepare('SELECT DISTINCT model FROM closure_craft_entry WHERE model IS NOT NULL')
        .all() as Array<{ model: string }>;
      craftDegraded = isVectorArmDegraded({
        configuredModelId: opts.configuredModelId,
        pending: Number(craftPendingRow?.n ?? 0),
        storedModels: craftModelRows.map((r) => r.model),
      });
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'craft reindexAllCraft: degradation signals unreadable - running conservatively',
      );
    }
  }
  if (!craftDegraded) {
    getLogger().info('craft reindexAllCraft: skipped - craft vector index healthy (CR-T2-003 tiering)');
  } else {
    try {
      getLogger().info('craft reindexAllCraft: starting (embedding model changed)');
      const craftResult = await reindexAllCraft();
      getLogger().info(
        { reindexed: craftResult.reindexed, dimChanged: craftResult.dimChanged, newDim: craftResult.newDim },
        'craft reindexAllCraft: done (embedding model changed)',
      );
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'craft reindexAllCraft: failed after embedding-model change - continuing',
      );
    }
  }
}

export function registerConfigIpc() {
  // The wallpaper copies live under userData/wallpaper, which is OUTSIDE
  // pathGuard's allowed roots (project root only) — the orison-file protocol's
  // assertSafePath would 403 the renderer's background fetch. Authorize the
  // directory once here; main/index.ts stays untouched.
  allowPath(getWallpaperDir());
  ipcMain.handle('config:load-model', () => redactModelConfig(readModelConfig()));
  ipcMain.handle('config:save-model', async (_, config: ModelConfig) => {
    // Capture the PRE-save embedding-model designation, then persist. The parse
    // validates the renderer payload (and is the source of `after`).
    // CR-18（09-12 子2 CR 批）：parse 前过 taskModels lenient 归一——slot 的空
    // `fallbacks: []` 归一为缺席（空链 ≡ 无链），不砖死整次 parse；非空链严格面不变。
    const before = readModelConfig();
    const parsed = modelConfigSaveSchema.parse(normalizeTaskModelsForParse(config));
    writeModelConfig(parsed);

    // CR-01/AC7: if the embedding-model designation changed, reindex every
    // project's derived vector index under the new model. FIRE-AND-FORGET:
    // reindexAll is async + does network embeds (slow — potentially minutes on a
    // large library), so the IPC returns immediately after the config is
    // persisted and the reindex runs in the background (logger records
    // start/done per project). Awaiting would hang the settings UI. The config
    // save itself NEVER fails due to a reindex error — reindexAllForChangedModel
    // wraps every step in try/catch, and the trailing .catch is belt-and-
    // suspenders against an unexpected throw so no unhandled rejection escapes.
    if (embeddingModelChanged(before.embeddingModel, parsed.embeddingModel)) {
      // CR-T2-005：与在途扫互斥（启动 reconcile / 前一次迁移扫可能还在跑）——并发重嵌竞争
      // entry_vec 的 DROP/重建。选「跳过 + 下次启动 reconcile 兜底」而非排队：reconcile 以
      // designation 比对确定性自愈，无需内存队列。扫自身经 runWithEmbeddingSweepGate 置闸，
      // 任意来源的在途扫（含本路径自己触发的）都拦得到。
      if (isEmbeddingSweepInflight()) {
        getLogger().warn(
          'closure reindexAll: sweep already in flight - deferring model-swap rebuild to next launch reconcile',
        );
      } else {
        // CR-T2-003①：configuredModelId 传新 designation（无则 null = predicate 判不降级、
        // craft 侧跳过——未配置模型下重嵌只会全员失败，无意义）。
        const configuredModelId = parsed.embeddingModel?.modelId ?? null;
        void runWithEmbeddingSweepGate(() => reindexAllForChangedModel({ configuredModelId })).catch((err) => {
          getLogger().warn(
            { err: err instanceof Error ? err.message : String(err) },
            'closure reindexAll: unexpected failure after embedding-model change',
          );
        });
      }
    }
  });
  ipcMain.handle('config:is-key-encryption-available', () => isApiKeyEncryptionAvailable());
  ipcMain.handle('config:load-user-preferences', () => readUserPreferences());
  ipcMain.handle('config:save-user-preferences', (event, config: UserPreferencesConfig) => {
    writeUserPreferences(config);
    // R8：界面缩放改动即时生效——落盘后对本窗口 webContents 施加 Chromium 页面级
    // 缩放（机制选型见 shared-contracts clampInterfaceScale 处注释），无需重启。
    if (Number.isFinite(config.interfaceScale)) {
      const sender = event.sender as unknown as
        | { setZoomFactor?: (factor: number) => void }
        | undefined;
      // 生产路径恒有 sender.setZoomFactor；可选链是 shell 单测传 {} 事件对象的注入缝。
      sender?.setZoomFactor?.(clampInterfaceScale(config.interfaceScale));
    }
  });
  ipcMain.handle('config:list-imported-fonts', () => listImportedFonts());
  ipcMain.handle('config:import-fonts', () => importFonts());
  ipcMain.handle('config:import-wallpaper', () => importWallpaper());
  ipcMain.handle('config:clear-wallpaper', () => clearWallpaper());
}

import type {
  ApiKeyEntry,
  DiscoveredModel,
  ModelCapability,
  ModelProtocol,
} from '@orison/shared-contracts';
import {
  customHeaderNameSchema,
  KEY_TIMEOUT_SECONDS_RANGE,
  MODEL_DEFAULT_RANGES,
  MODEL_PRICING_RANGE,
} from '@orison/shared-contracts';

/** 子3：模型默认参数六字段的 string 中间态（空串 = 未填；空串写侧不落键）。 */
export type KeyDraftModelDefaults = {
  temperature: string;
  topP: string;
  frequencyPenalty: string;
  presencePenalty: string;
  contextWindow: string;
  maxOutputTokens: string;
};

/** 子3：模型单价三字段的 string 中间态（per 1M tokens，纯数字）。 */
export type KeyDraftModelPricing = {
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion: string;
};

export type KeyDraftModel = {
  id: string;
  alias: string;
  capability: ModelCapability;
  enabled: boolean;
  defaults: KeyDraftModelDefaults;
  /** JSON 原文中间态（空串 = 无 extraBody；合法性在 applyDraft 前置校验）。 */
  extraBody: string;
  pricing: KeyDraftModelPricing;
};

/** 子3：自定义请求头编辑行（record 是持久化形态，数组是编辑面增删行形态）。 */
export type KeyDraftHeader = { name: string; value: string };

export type KeyDraft = {
  id: string | null;
  name: string;
  protocol: ModelProtocol;
  apiKey: string;
  baseUrl: string;
  /** CLI 形态（antigravity-cli）判别载荷；HTTP 形态恒空串（不进 key 载荷）。 */
  cliExecutable: string;
  customHeaders: KeyDraftHeader[];
  /** 数值 string 中间态（空串 = 未填）。 */
  timeoutSeconds: string;
  streamingDisabled: boolean;
  verifySsl: boolean;
  models: KeyDraftModel[];
};

export function emptyModelDefaults(): KeyDraftModelDefaults {
  return {
    temperature: '',
    topP: '',
    frequencyPenalty: '',
    presencePenalty: '',
    contextWindow: '',
    maxOutputTokens: '',
  };
}

export function emptyModelPricing(): KeyDraftModelPricing {
  return { inputPerMillion: '', outputPerMillion: '', cachedInputPerMillion: '' };
}

export function emptyKeyDraft(): KeyDraft {
  return {
    id: null,
    name: '',
    protocol: 'openai-compatible',
    apiKey: '',
    baseUrl: '',
    cliExecutable: '',
    customHeaders: [],
    timeoutSeconds: '',
    streamingDisabled: false,
    verifySsl: false,
    models: [],
  };
}

/** 与 contracts `modelDefaultsSchema` 六字段同源的字段清单（schema 域由 save 面 zod 强闸）。 */
const DEFAULT_FIELDS = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'contextWindow',
  'maxOutputTokens',
] as const;

const PRICING_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'] as const;

function numToStr(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function defaultsToDraft(defaults: DiscoveredModel['defaults']): KeyDraftModelDefaults {
  return {
    temperature: numToStr(defaults?.temperature),
    topP: numToStr(defaults?.topP),
    frequencyPenalty: numToStr(defaults?.frequencyPenalty),
    presencePenalty: numToStr(defaults?.presencePenalty),
    contextWindow: numToStr(defaults?.contextWindow),
    maxOutputTokens: numToStr(defaults?.maxOutputTokens),
  };
}

function pricingToDraft(pricing: DiscoveredModel['pricing']): KeyDraftModelPricing {
  return {
    inputPerMillion: numToStr(pricing?.inputPerMillion),
    outputPerMillion: numToStr(pricing?.outputPerMillion),
    cachedInputPerMillion: numToStr(pricing?.cachedInputPerMillion),
  };
}

/** extraBody 的规范化文本形态（keyToDraft / isKeyDirty 同一口径——round-trip 稳定）。 */
function extraBodyToDraft(extraBody: DiscoveredModel['extraBody']): string {
  return extraBody && Object.keys(extraBody).length > 0 ? JSON.stringify(extraBody, null, 2) : '';
}

export function keyToDraft(key: ApiKeyEntry): KeyDraft {
  return {
    id: key.id,
    name: key.name,
    protocol: key.protocol,
    // CLI 键的 baseUrl/apiKey/cliExecutable 在 key 上均可缺席（形态互斥）——草稿面
    // 保持 string 形态（表单按 protocol 切换字段可见性），缺席归一为 ''。
    apiKey: key.apiKey ?? '',
    baseUrl: key.baseUrl ?? '',
    cliExecutable: key.cliExecutable ?? '',
    customHeaders: Object.entries(key.customHeaders ?? {})
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    timeoutSeconds: numToStr(key.timeoutSeconds),
    streamingDisabled: key.streamingDisabled === true,
    verifySsl: key.verifySsl === true,
    models: key.models.map((m) => ({
      id: m.id,
      alias: m.alias,
      capability: m.capability,
      enabled: m.enabled,
      defaults: defaultsToDraft(m.defaults),
      extraBody: extraBodyToDraft(m.extraBody),
      pricing: pricingToDraft(m.pricing),
    })),
  };
}

/**
 * 数值 string 中间态 → number（空串/纯空白 = 未填 undefined；NaN/十六进制/科学计数法
 * 丢弃——CR-8：`Number()` 会把 '0x10'/'1e3' 静默重释成 16/1000 落盘变形，只认十进制
 * 字面量形态；非法输入由 findKeyDraftIssue 前置拦截，此处防御性丢弃防 silent bad payload）。
 */
const DECIMAL_FORM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function draftNum(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed || !DECIMAL_FORM.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** CLI 键只保 contextWindow（form refine 拒其余采样/上限面——协议切换后草稿残留防泄漏）。 */
function draftDefaultsToSchema(
  defaults: KeyDraftModelDefaults,
  cli: boolean,
): DiscoveredModel['defaults'] {
  const collected: Record<string, number> = {};
  for (const field of DEFAULT_FIELDS) {
    if (cli && field !== 'contextWindow') continue;
    const parsed = draftNum(defaults[field]);
    if (parsed !== undefined) collected[field] = parsed;
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

function draftPricingToSchema(pricing: KeyDraftModelPricing): DiscoveredModel['pricing'] {
  const collected: Record<string, number> = {};
  for (const field of PRICING_FIELDS) {
    const parsed = draftNum(pricing[field]);
    if (parsed !== undefined) collected[field] = parsed;
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

/** 草稿 headers 数组 → record（空名行丢弃；空 map = undefined——二态字段写侧不落空对象）。 */
export function draftCustomHeadersRecord(draft: KeyDraft): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const { name, value } of draft.customHeaders) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    record[trimmed] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export function draftToKey(draft: KeyDraft, fallbackId: string): ApiKeyEntry {
  const isCli = draft.protocol === 'antigravity-cli';
  const base = {
    id: draft.id ?? fallbackId,
    name: draft.name.trim() || fallbackId,
    protocol: draft.protocol,
    models: draft.models.filter((m) => m.id.trim().length > 0).map<DiscoveredModel>((m) => {
      const entry: DiscoveredModel = {
        id: m.id.trim(),
        alias: m.alias.trim() || m.id.trim(),
        capability: m.capability,
        enabled: m.enabled,
      };
      const defaults = draftDefaultsToSchema(m.defaults, isCli);
      if (defaults) entry.defaults = defaults;
      // extraBody CLI 键禁（refine）——CLI 分支不投影；坏 JSON 由 findKeyDraftIssue 前置
      // 拦截，此处 try/catch 防御性丢弃（非对象产物同样丢弃）。
      if (!isCli && m.extraBody.trim()) {
        try {
          const parsed: unknown = JSON.parse(m.extraBody);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            entry.extraBody = parsed as Record<string, unknown>;
          }
        } catch {
          /* 防御性丢弃 */
        }
      }
      const pricing = draftPricingToSchema(m.pricing);
      if (pricing) entry.pricing = pricing;
      return entry;
    }),
  };
  // CLI 形态（09-12 agy provider）：cliExecutable 是判别载荷；baseUrl 不进载荷
  //（save face 形态互斥——CLI 键携带 baseUrl 即拒收）；apiKey 走 save face 的
  // '' 哨兵（该面 apiKey 必填 string，CLI 分支容忍 ''——写侧不落盘 HTTP 凭据）。
  // 子3：CLI 键的传输面三件套（headers/超时/流式禁用）不进载荷（refine 拒）；
  // verifySsl CLI 容忍（refine 放行，无消费面）。
  if (isCli) {
    return {
      ...base,
      apiKey: '',
      cliExecutable: draft.cliExecutable.trim(),
      ...(draft.verifySsl ? { verifySsl: true } : {}),
    };
  }
  const customHeaders = draftCustomHeadersRecord(draft);
  const timeoutSeconds = draftNum(draft.timeoutSeconds);
  return {
    ...base,
    apiKey: draft.apiKey,
    baseUrl: draft.baseUrl.replace(/\/+$/, ''),
    ...(customHeaders ? { customHeaders } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(draft.streamingDisabled ? { streamingDisabled: true } : {}),
    ...(draft.verifySsl ? { verifySsl: true } : {}),
  };
}

function normalizeDraftHeaders(headers: KeyDraftHeader[]): KeyDraftHeader[] {
  return headers
    .map(({ name, value }) => ({ name: name.trim(), value }))
    .filter((h) => h.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** headers dirty 判定：trim + 按 name 排序后逐项比较（纯顺序差异/空白差异非 dirty）。 */
function headersDirty(draftHeaders: KeyDraftHeader[], keyHeaders: Record<string, string> | undefined): boolean {
  const draftSide = normalizeDraftHeaders(draftHeaders);
  const keySide = Object.entries(keyHeaders ?? {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (draftSide.length !== keySide.length) return true;
  for (let i = 0; i < draftSide.length; i++) {
    if (draftSide[i]!.name !== keySide[i]!.name) return true;
    if (draftSide[i]!.value !== keySide[i]!.value) return true;
  }
  return false;
}

/** 单模型子3 字段 dirty 判定（persisted number 经 String() 同口径；数字草稿先 trim 再比
 * ——CR-11：对齐 headersDirty 的 trim 归一，「 0.7」vs「0.7」纯空白差异非 dirty；extraBody
 * 按规范化 JSON 文本比较——用户重新格式化算 dirty 可接受，保存后自愈回规范化形态）。 */
function modelParamsDirty(d: KeyDraftModel, k: { defaults?: DiscoveredModel['defaults']; extraBody?: DiscoveredModel['extraBody']; pricing?: DiscoveredModel['pricing'] }): boolean {
  for (const field of DEFAULT_FIELDS) {
    if (d.defaults[field].trim() !== numToStr(k.defaults?.[field])) return true;
  }
  for (const field of PRICING_FIELDS) {
    if (d.pricing[field].trim() !== numToStr(k.pricing?.[field])) return true;
  }
  return d.extraBody !== extraBodyToDraft(k.extraBody);
}

export function isKeyDirty(draft: KeyDraft, key: ApiKeyEntry | undefined): boolean {
  if (!key) {
    return Boolean(
      draft.name || draft.apiKey || draft.cliExecutable || draft.customHeaders.length > 0 || draft.models.length > 0 ||
        // CR-10：transport-only 编辑也算未保存改动——新键只配了超时/流式禁用/跳过证书
        // 三件套时 dirty 必须为 true，否则无警告丢弃（切键/关页即静默蒸发）。
        draft.timeoutSeconds.trim() || draft.streamingDisabled || draft.verifySsl,
    );
  }
  if (draft.name !== key.name) return true;
  if (draft.protocol !== key.protocol) return true;
  // CLI 键缺席字段按草稿同口径（''）归一再比——不缺席化会把 CLI 键恒判 dirty。
  if (draft.apiKey !== (key.apiKey ?? '')) return true;
  if (draft.baseUrl !== (key.baseUrl ?? '')) return true;
  if (draft.cliExecutable !== (key.cliExecutable ?? '')) return true;
  if (draft.timeoutSeconds !== numToStr(key.timeoutSeconds)) return true;
  if (draft.streamingDisabled !== (key.streamingDisabled === true)) return true;
  if (draft.verifySsl !== (key.verifySsl === true)) return true;
  if (headersDirty(draft.customHeaders, key.customHeaders)) return true;
  if (draft.models.length !== key.models.length) return true;
  for (let i = 0; i < draft.models.length; i++) {
    const d = draft.models[i]!;
    const k = key.models[i];
    if (!k) return true;
    if (d.id !== k.id || d.alias !== k.alias || d.capability !== k.capability || d.enabled !== k.enabled) return true;
    if (modelParamsDirty(d, k)) return true;
  }
  return false;
}

/** applyDraft 前置校验的发现（key = i18n 键；vars 喂 t() 原生插值）。 */
export type KeyDraftIssue = { key: string; vars?: Record<string, string | number> };

/**
 * 子3（design §5.1/§5.2）：保存前的本地化前置校验——非法数字形态（NaN/十六进制/科学
 * 计数法）与坏 JSON 会被投影函数静默丢弃（silent no-op），必须在此响亮拦截；header 名域
 * 与 contracts 同源（customHeaderNameSchema——wire 序列化关键头 blocklist 由 save 面 zod
 * 强闸，拒收经 applyDraft 的 catch 落 notice）。
 *
 * CR-7（09-12 子3 CR 批）：数值域核校同样前置到本地——域从 shared-contracts 常量单源
 * import（MODEL_DEFAULT_RANGES / MODEL_PRICING_RANGE / KEY_TIMEOUT_SECONDS_RANGE），
 * temperature 55 / timeout 90.5 这类值在本地就报字段名，不再死在保存面的 generic zod
 * 文案；禁手抄范围字面量。CR-8：'0x10'/'1e3' 经 Number() 重释落盘的形态在数字形态检查
 * 拒。CR-9：header 名 case-insensitive 去重（X-Tag/x-tag 同名冲突上 wire）。
 */
export function findKeyDraftIssue(draft: KeyDraft): KeyDraftIssue | null {
  const seenHeaderNames = new Set<string>();
  for (const { name } of draft.customHeaders) {
    const trimmed = name.trim();
    if (!trimmed) continue; // 空名行 = 未填行，投影时丢弃（非错误）
    if (!customHeaderNameSchema.safeParse(trimmed).success) {
      return { key: 'settings.customHeaderNameInvalid', vars: { name: trimmed } };
    }
    const lower = trimmed.toLowerCase();
    if (seenHeaderNames.has(lower)) {
      return { key: 'settings.customHeaderNameDuplicate', vars: { name: trimmed } };
    }
    seenHeaderNames.add(lower);
  }
  for (const model of draft.models) {
    for (const field of DEFAULT_FIELDS) {
      const raw = model.defaults[field].trim();
      if (!raw) continue;
      const parsed = draftNum(raw);
      if (parsed === undefined) {
        return { key: 'settings.modelParamNumberInvalid', vars: { model: model.id, field } };
      }
      const range = MODEL_DEFAULT_RANGES[field];
      if (range.integer) {
        // 整数族（contextWindow/maxOutputTokens）：0/负/小数统一按「需为正整数」报。
        if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
          return { key: 'settings.modelParamIntegerInvalid', vars: { model: model.id, field } };
        }
      } else if (parsed < range.min || parsed > range.max) {
        return {
          key: 'settings.modelParamRangeInvalid',
          vars: { model: model.id, field, min: range.min, max: range.max },
        };
      }
    }
    for (const field of PRICING_FIELDS) {
      const raw = model.pricing[field].trim();
      if (!raw) continue;
      const parsed = draftNum(raw);
      if (parsed === undefined) {
        return { key: 'settings.modelParamNumberInvalid', vars: { model: model.id, field } };
      }
      if (parsed < MODEL_PRICING_RANGE.min || parsed > MODEL_PRICING_RANGE.max) {
        return { key: 'settings.pricingRangeInvalid', vars: { model: model.id, field } };
      }
    }
    const extraBody = model.extraBody.trim();
    if (extraBody) {
      try {
        const parsed: unknown = JSON.parse(extraBody);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { key: 'settings.extraBodyInvalid', vars: { model: model.id } };
        }
      } catch {
        return { key: 'settings.extraBodyInvalid', vars: { model: model.id } };
      }
    }
  }
  const timeout = draft.timeoutSeconds.trim();
  if (timeout) {
    const parsed = draftNum(timeout);
    if (parsed === undefined) {
      return { key: 'settings.modelParamNumberInvalid', vars: { model: draft.name || draft.id || '', field: 'timeoutSeconds' } };
    }
    if (!Number.isInteger(parsed)) {
      return { key: 'settings.modelParamIntegerInvalid', vars: { model: draft.name || draft.id || '', field: 'timeoutSeconds' } };
    }
    if (parsed < KEY_TIMEOUT_SECONDS_RANGE.min || parsed > KEY_TIMEOUT_SECONDS_RANGE.max) {
      return {
        key: 'settings.modelParamRangeInvalid',
        vars: {
          model: draft.name || draft.id || '',
          field: 'timeoutSeconds',
          min: KEY_TIMEOUT_SECONDS_RANGE.min,
          max: KEY_TIMEOUT_SECONDS_RANGE.max,
        },
      };
    }
  }
  return null;
}

/**
 * CR-15：range 占位文案从域常量派生（禁手抄范围字面量——「0–2」手写串是与 zod 域漂移的
 * 第二真相源）。负下界字段加空格（「-2 – 2」既有视觉形态），非负下界紧排（「0–2」）。
 */
export function formatParamRangeLabel(range: { min: number; max: number }): string {
  return range.min < 0 ? `${range.min} – ${range.max}` : `${range.min}–${range.max}`;
}

export function nextKeyId(keys: ApiKeyEntry[]): string {
  const existing = new Set(keys.map((k) => k.id));
  let index = 1;
  while (existing.has(`key_${String(index).padStart(3, '0')}`)) index += 1;
  return `key_${String(index).padStart(3, '0')}`;
}

function _formatModelLabel(key: ApiKeyEntry, modelId: string): string {
  const entry = key.models.find((m) => m.id === modelId);
  return `${key.name} · ${entry?.alias ?? modelId}`;
}

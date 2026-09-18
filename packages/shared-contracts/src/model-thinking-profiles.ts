import type { UnifiedLevel } from './contracts/generation';
import type { ModelLimits, ThinkingKind } from './contracts/model';

// Single source for the unified-level → vendor-parameter translation
// (thinking adapters task, 2026-08-25). Pure data + pure functions — no Node
// APIs, so the renderer imports it directly (UI option filtering needs no new
// IPC). Facts anchored to research A (vendor-thinking-api-params.md); design
// §1.3/§1.4 are the decision record.
//
// Capability axis (this file, keyed by modelId via the registry) vs policy
// axis (taskModels sidecar, per slot): "CAN this model be turned off / which
// tiers does it accept" lives here; "does THIS slot want it off / how strong"
// is user state and never enters this file.

/** How a model surfaces reasoning content in responses (expectation management). */
export type ThinkingExternalForm =
  | 'reasoning-field' // OpenAI-compat `reasoning_content` (GLM / Kimi / DeepSeek ecosystem)
  | 'thinking-blocks' // Anthropic thinking content blocks (+ thinking_delta when streaming)
  | 'none'            // Chat Completions of the OpenAI first-party endpoints (usage counter only)
  | 'unknown';        // unverified (e.g. Gemini compat endpoint)

/** What a `custom` thinking value looks like for a model. */
export type ThinkingCustomHint =
  | 'enum'    // vendor-native tier name (validated against customEnumValues)
  | 'numeric' // token budget number (validated against numericRange)
  | 'none';   // not customizable (on/off or non-injectable)

/** Round-trip obligation for reasoning content in tool loops / multi-turn. */
export type ThinkingRoundTrip =
  | 'required' // omitting it is a hard error (DeepSeek+tools, Kimi K3, Claude thinking blocks)
  | 'optional' // sending it back is accepted but ignored (GLM standard API, Kimi k2.6 keep=null)
  | 'none';    // nothing to send back (no reasoning surfaced on this path)

export type ThinkingProfile = {
  /** Selectable unified levels (excludes `auto`; empty = not injectable in v1). */
  levels: UnifiedLevel[];
  /** false → 'off' is illegal on this model (UI greys it out with a reason). */
  offLegal: boolean;
  /** How the model surfaces reasoning in responses. */
  externalForm: ThinkingExternalForm;
  /** What a `custom` value looks like (vendor tier name / token budget / unsupported). */
  customHint: ThinkingCustomHint;
  /** enum hint: the legal vendor values (validateCustom checks membership). */
  customEnumValues?: string[];
  /** numeric hint: inclusive [min, max] budget range. */
  numericRange?: [number, number];
  /** Injecting thinking controls must strip `temperature` (vendor rejects or ignores it). */
  dropTemperature: boolean;
  /** max_tokens floor while thinking is on — covered by the top-out default, a lower bound only. */
  minTotalTokens?: number;
  /** Round-trip obligation for reasoning content (drives compaction preservation). */
  reasoningRoundTrip: ThinkingRoundTrip;
};

/**
 * Unified-level → vendor-value mapping result. `effort` carries the vendor
 * effort string — or, for claude-budget, the budget_tokens NUMBER as a string
 * (the protocol layer converts; one mapping channel for both shapes). `on`
 * carries the vendor switch; `on: false` = disabled.
 */
export type MappedThinkingLevel = {
  effort?: string;
  on?: boolean;
};

const ON: UnifiedLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export const THINKING_PROFILES: Record<ThinkingKind, ThinkingProfile> = {
  'glm-forced-effort': {
    // GLM-5.3 (research A §1): thinking.type accepts 'enabled' only (disabled
    // errors); reasoning_effort low/high/max, default max, other values error
    // → medium pre-maps to high. Temperature has no documented lock (examples
    // use 1.0 but no stated constraint — do not assume one).
    levels: ON,
    offLegal: false,
    externalForm: 'reasoning-field',
    customHint: 'enum',
    customEnumValues: ['low', 'high', 'max'],
    dropTemperature: false,
    reasoningRoundTrip: 'optional', // standard API clears history by default (preserved mode is opt-in)
  },
  'glm-forced-basic': {
    // GLM-4.7 / 4.5V: thinking always on; no reasoning_effort field — every
    // non-off level maps to plain "on" (mapLevel emits no effort).
    levels: ON,
    offLegal: false,
    externalForm: 'reasoning-field',
    customHint: 'none',
    dropTemperature: false,
    reasoningRoundTrip: 'optional',
  },
  'glm-dynamic-effort': {
    // GLM-5.2: on/off; widest effort set with vendor-side collapse
    // (none|minimal→stop, low|medium→high, xhigh→max). Unified low/medium
    // pre-map to high; xhigh etc. are reachable via custom only.
    levels: ON,
    offLegal: true,
    externalForm: 'reasoning-field',
    customHint: 'enum',
    customEnumValues: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    dropTemperature: false,
    reasoningRoundTrip: 'optional',
  },
  'glm-dynamic-basic': {
    // GLM-5.1 / 5 / 5-Turbo / 4.6 and the older-4.x fallback: on/off switch
    // only, no effort field.
    levels: ON,
    offLegal: true,
    externalForm: 'reasoning-field',
    customHint: 'none',
    dropTemperature: false,
    reasoningRoundTrip: 'optional',
  },
  'kimi-k3': {
    // K3 (research A §2): thinking + preserved always on (disabled errors;
    // official guidance is to not send thinking.type at all); effort
    // low/high/max (default max); max_completion_tokens parameter name;
    // temperature fixed at 1.0.
    levels: ON,
    offLegal: false,
    externalForm: 'reasoning-field',
    customHint: 'enum',
    customEnumValues: ['low', 'high', 'max'],
    dropTemperature: true,
    minTotalTokens: 16_000, // official guidance for tool loops (reasoning+content share the budget)
    reasoningRoundTrip: 'required', // assistant reasoning_content must be echoed back in full
  },
  'kimi-k2': {
    // k2.5/k2.6: thinking.type enabled/disabled (default on); no effort field;
    // temperature not modifiable.
    levels: ON,
    offLegal: true,
    externalForm: 'reasoning-field',
    customHint: 'none',
    dropTemperature: true,
    reasoningRoundTrip: 'optional', // k2.6 keep=null drops history by default (round-trip ignored)
  },
  'kimi-k27-forced': {
    // CR-009: k2.7 (incl. -code / -code-highspeed) split out of kimi-k2 — the
    // four-model table in research A §2 differs materially: thinking.type
    // accepts 'enabled' only (disabled ERRORS → offLegal false), there is no
    // effort field, and Preserved thinking is ALWAYS on (`thinking.keep`
    // defaults to 'all'; any other value errors) — every historical
    // assistant reasoning_content must be echoed back verbatim each turn,
    // hence round-trip 'required'. Temperature not modifiable (1.0 fixed).
    levels: ON,
    offLegal: false,
    externalForm: 'reasoning-field',
    customHint: 'none',
    dropTemperature: true,
    reasoningRoundTrip: 'required', // Preserved always on (keep default 'all')
  },
  'deepseek-v4': {
    // V4 (research A §4): on/off; effort low/high/max — the request side also
    // accepts medium/xhigh and collapses them to high; sampling params are
    // silently ignored while thinking is on.
    levels: ON,
    offLegal: true,
    externalForm: 'reasoning-field',
    customHint: 'enum',
    customEnumValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    dropTemperature: true,
    reasoningRoundTrip: 'required', // with tools: omitting prior reasoning_content → 400
  },
  'claude-forced': {
    // Fable 5 / Mythos 5: thinking.type 'adaptive' or omitted (disabled →
    // 400); effort low~max; raw CoC never returned (display omitted by
    // default — the injector requests 'summarized'); sampling params rejected.
    levels: ON,
    offLegal: false,
    externalForm: 'thinking-blocks',
    customHint: 'enum',
    customEnumValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    dropTemperature: true,
    minTotalTokens: 64_000, // official guidance for the xhigh/max tiers
    reasoningRoundTrip: 'required', // thinking blocks must round-trip verbatim (same model)
  },
  'claude-5': {
    // Opus 5 / Sonnet 5: adaptive (omitting thinking = ON); off legal — Opus 5
    // only at effort ≤ high, which unified 'off' satisfies by sending no
    // effort at all.
    levels: ON,
    offLegal: true,
    externalForm: 'thinking-blocks',
    customHint: 'enum',
    customEnumValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    dropTemperature: true,
    minTotalTokens: 64_000,
    reasoningRoundTrip: 'required',
  },
  'claude-4x': {
    // 4.6/4.7/4.8: adaptive is the only way ON; omitting thinking = off;
    // budget_tokens → 400 on these generations.
    levels: ON,
    offLegal: true,
    externalForm: 'thinking-blocks',
    customHint: 'enum',
    customEnumValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    dropTemperature: true,
    minTotalTokens: 64_000,
    reasoningRoundTrip: 'required',
  },
  'claude-budget': {
    // 4.5/3.7 legacy extended thinking: enabled + budget_tokens (min 1024,
    // must stay below max_tokens). Unified levels map to budget numbers in
    // mapLevel; the protocol layer lifts max_tokens above the budget.
    levels: ON,
    offLegal: true,
    externalForm: 'thinking-blocks',
    customHint: 'numeric',
    // CR-020: this is the BASE range for models whose limits are unknown.
    // validateCustom raises the ceiling to limits.maxOutputTokens - 1 when the
    // caller passes the model's official limits (budget must stay BELOW
    // max_tokens, which itself is bounded by the output ceiling).
    numericRange: [1024, 32768],
    dropTemperature: true, // legacy rule: with thinking on, temperature must stay at its default
    reasoningRoundTrip: 'required',
  },
  gemini: {
    // Compat-endpoint thinking passthrough is UNVERIFIED (research A §3) — v1
    // injects nothing (empty levels); expectation management only. Revisit
    // after the dogfood probe.
    levels: [],
    offLegal: true,
    externalForm: 'unknown',
    customHint: 'none',
    dropTemperature: false,
    reasoningRoundTrip: 'none',
  },
  'openai-o': {
    // o-series: always thinks (no switch); documented tiers top out at high
    // (xhigh/max belong to gpt-5.1+); Chat Completions returns NO reasoning
    // content (usage counter only); only default temperature is accepted.
    levels: ON,
    offLegal: false,
    externalForm: 'none',
    customHint: 'enum',
    customEnumValues: ['low', 'medium', 'high'],
    dropTemperature: true,
    reasoningRoundTrip: 'none',
  },
  gpt5: {
    // gpt-5 family: no switch; off ≈ effort 'none' (gpt-5.1+; gpt-5 may 400 →
    // param-strip retry backstop); Chat Completions returns NO reasoning
    // content; only default temperature is accepted.
    levels: ON,
    offLegal: true,
    externalForm: 'none',
    customHint: 'enum',
    customEnumValues: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    dropTemperature: true,
    reasoningRoundTrip: 'none',
  },
};

// Legacy Claude extended-thinking budget numbers per unified level (design §1.4).
// CR-020: max=32768 is the BASELINE for models whose limits are unknown — when
// the model's official limits are known and larger, the limits-aware
// numericRange in validateCustom is authoritative (custom can go above 32768).
const CLAUDE_BUDGET_LEVELS: Record<Exclude<UnifiedLevel, 'off'>, string> = {
  low: '2048',
  medium: '8192',
  high: '16384',
  max: '32768',
};

/**
 * Translate a unified level into the vendor effort value / switch state.
 * Legality is NOT enforced here — `offLegal` gates the UI and the protocol
 * layer guards illegal runtime combinations (e.g. off on a forced model
 * degrades to the closest legal setting with a warning). `auto` maps to an
 * empty result (nothing to inject — the pre-feature default), and `custom`
 * values bypass this function entirely (the caller validates them with
 * validateCustom and passes the accepted string through).
 *
 * medium pre-maps to high for the four kinds whose vendor set lacks a native
 * medium tier (design §1.4; research A mapping tables: GLM-5.3 rejects
 * medium outright, GLM-5.2 / DeepSeek collapse low|medium→high server-side,
 * Kimi K3 accepts low/high/max only). Claude and OpenAI keep medium natively.
 */
export function mapLevel(kind: ThinkingKind, level: UnifiedLevel | 'auto'): MappedThinkingLevel {
  switch (kind) {
    case 'gemini':
      // v1 does not inject for Gemini (compat passthrough unverified).
      return {};
    case 'glm-forced-effort':
    case 'glm-dynamic-effort':
    case 'kimi-k3':
    case 'deepseek-v4':
      if (level === 'auto') return {};
      if (level === 'off') return { on: false };
      return { effort: level === 'medium' ? 'high' : level };
    case 'glm-forced-basic':
    case 'glm-dynamic-basic':
    case 'kimi-k2':
    case 'kimi-k27-forced':
      // Effort-less families: every non-off level is plain "on".
      if (level === 'auto') return {};
      return { on: level !== 'off' };
    case 'claude-forced':
    case 'claude-5':
    case 'claude-4x':
      // Claude effort is native across low~max (medium included).
      if (level === 'auto') return {};
      if (level === 'off') return { on: false };
      return { effort: level };
    case 'claude-budget':
      // Legacy: the effort channel carries budget_tokens as a numeric string.
      if (level === 'auto') return {};
      if (level === 'off') return { on: false };
      return { effort: CLAUDE_BUDGET_LEVELS[level] };
    case 'openai-o':
      // No switch exists; documented tiers top out at high, so unified max
      // maps down instead of provoking a 400. Illegal off (offLegal=false)
      // still reports {on:false} for the runtime guard to degrade.
      if (level === 'auto') return {};
      if (level === 'off') return { on: false };
      return { effort: level === 'max' ? 'high' : level };
    case 'gpt5':
      // No switch: off is expressed as effort 'none' (gpt-5.1+; gpt-5's
      // rejection falls back to the param-strip retry at the protocol layer).
      if (level === 'auto') return {};
      if (level === 'off') return { effort: 'none' };
      return { effort: level };
  }
}

/**
 * Validate a custom thinking value against the model's profile: enum kinds
 * must match a listed vendor tier; numeric kinds must be an integer inside
 * the inclusive range. Returns the normalized value to send (enum value
 * as-is; numeric as the parsed integer string) or a human-readable reason.
 *
 * CR-020: `limits` (optional) makes the numeric ceiling model-aware — for
 * claude-budget the budget must stay BELOW max_tokens, which itself is
 * bounded by the model's official output ceiling, so a model with a known
 * 64K output limit accepts budgets up to limits.maxOutputTokens - 1 instead
 * of the hardcoded 32768 base. Without limits, the profile's base
 * numericRange applies unchanged.
 */
export function validateCustom(
  kind: ThinkingKind,
  custom: string,
  limits?: Partial<ModelLimits>,
): { ok: true; value: string } | { ok: false; reason: string } {
  const profile = THINKING_PROFILES[kind];
  if (profile.customHint === 'enum') {
    const allowed = profile.customEnumValues ?? [];
    if (allowed.includes(custom)) return { ok: true, value: custom };
    return {
      ok: false,
      reason: `unsupported thinking tier '${custom}' for ${kind} (allowed: ${allowed.join(', ') || 'none'})`,
    };
  }
  if (profile.customHint === 'numeric') {
    const [min, baseMax] = profile.numericRange ?? [0, Number.MAX_SAFE_INTEGER];
    // CR-020: known limits REPLACE the base ceiling (not just raise it) — the
    // vendor constraint is budget < max_tokens ≤ output ceiling, so a model
    // with a smaller known ceiling tightens the range too.
    // 09-12 子3: limits is per-field partial (user-override synthesis) — an
    // ABSENT maxOutputTokens means the ceiling is unknown → base range.
    const max = limits?.maxOutputTokens !== undefined ? limits.maxOutputTokens - 1 : baseMax;
    const budget = Number(custom);
    if (Number.isInteger(budget) && budget >= min && budget <= max) {
      return { ok: true, value: String(budget) };
    }
    return {
      ok: false,
      reason: `thinking budget for ${kind} must be an integer between ${min} and ${max}`,
    };
  }
  return { ok: false, reason: `${kind} does not support custom thinking values` };
}

export type FlatConfigValue = string | number | boolean | null | FlatQuotedString;
export type FlatConfig = Record<string, FlatConfigValue>;

/**
 * Write-side marker (CR-6 09-12 子3 CR 批): serialize the carried string as a
 * double-quoted JSON string EVEN when the bare charset would pass — for values
 * whose bare form `parseScalar` would reinterpret (the literal `null`, the
 * YAML bools `true`/`false`/`yes`/`no`/`on`/`off`, strict-decimal numerics like
 * `12345`) so a string round-trips as the exact string. Per-value opt-in at
 * the call site (custom-header values quote; every other writer keeps the
 * historical bare form byte-for-byte).
 */
export type FlatQuotedString = { readonly flatQuoted: string };

/** Wrap a string so `stringifyFlatYaml` emits it double-quoted (see {@link FlatQuotedString}). */
export function flatQuoted(value: string): FlatQuotedString {
  return { flatQuoted: value };
}

export function parseFlatYaml(text: string): FlatConfig {
  const result: FlatConfig = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf(':');
    if (index < 0) continue;

    const key = line.slice(0, index).trim();
    const rawValue = line.slice(index + 1).trim();
    if (!key) continue;

    result[key] = parseScalar(rawValue);
  }
  return result;
}

export function stringifyFlatYaml(config: FlatConfig): string {
  return `${Object.entries(config)
    .map(([key, value]) => `${key}: ${formatScalar(value)}`)
    .join('\n')}\n`;
}

function parseScalar(value: string): FlatConfigValue {
  if (value === '' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  // 双引号值走 JSON.parse 对称反转义（写侧 formatScalar 的 JSON.stringify 产
  // `\\`/`\"`/控制符转义——旧实现只剥 `\"` 不剥 `\\`，含反斜杠的值（Windows
  // cliExecutable 路径）每轮 save/load 反斜杠翻倍累积腐化）。手写异形（非合法
  // JSON）宽限回落剥引号原样取内文。
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  // Only coerce strict decimal literals — never hex/octal ("0x1f"), leading-zero
  // strings ("007"), or values that lose precision on round-trip (long IDs).
  // This keeps all-digit identifiers and keys as strings.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && String(asNumber) === value) return asNumber;
  }
  return value;
}

function formatScalar(value: FlatConfigValue): string {
  if (value === null) return 'null';
  // flatQuoted marker: always double-quoted JSON form (CR-6 — the string-family
  // round-trip guarantee), regardless of the bare charset verdict below.
  if (typeof value === 'object') return JSON.stringify(value.flatQuoted);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

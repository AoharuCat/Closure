/**
 * 磁盘命名单源：Windows 保留名 + 非法字符 + 控制字符 + 结尾点/空格 + 长度帽。
 *
 * 双语义，调用方按链路性质二选一：
 * - 用户输入链（项目名 / 文件树手建名）用 `assertSafeDiskName`——拒绝不改写，
 *   替改用户意图会静默偏离输入；类型化 `DiskNameViolationError` 带 reason，
 *   用户可见文案由调用方按 reason 组织。
 * - 自动派生链（章 stem / 导出基名 / 图片显式传名 / 材料派生 .md）用
 *   `sanitizeDiskName`——机械变换（非法/控制字符 → '-'、结尾点空格剔除、
 *   保留名加 '-doc' 后缀），输出保证通过 `findDiskNameViolation`。
 *
 * 保留名按首个点之前的主名段比对（Windows 设备名语义：CON.md 在旧 Windows
 * 同样映射设备；report.con 合法），大小写不敏感。控制字符覆盖 0x00-0x1f 与
 * DEL(0x7f)。非法字符集与章 stem 清洗（sanitizeChapterStemSegment）同族，
 * 收敛调用方时以本模块为准。
 *
 * 边界：空串/纯点空格串不属五类违规（find 对 '' 返回 null，sanitize 会把它
 * 清成空串）——空名判定留给调用方，各链路已有自己的空名回退（'untitled' /
 * 'image' / 'export'）。settingMd / craft 的白名单 slugify 链不走本模块
 * （slugify 是另一层语义，已含完整防护，保持原状）。
 */

/** 默认文件名长度帽（对照 settingMd/craft slug 帽；MAX_PATH 余量）。 */
export const DEFAULT_DISK_NAME_MAX_LENGTH = 80;

/** 项目名长度帽（项目目录在盘上是最深的路径前缀，帽收紧到 60 保深路径余量）。 */
export const PROJECT_NAME_MAX_LENGTH = 60;

/**
 * Windows 保留设备名全集（小写存储，比对前归一大小写）。裸保留名（或保留名
 * 主名段，如 CON.md）在旧 Windows 会映射设备/产生灵异行为。
 */
export const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export type DiskNameViolationReason =
  | 'reserved'
  | 'illegal-char'
  | 'trailing-dot-space'
  | 'control-char'
  | 'too-long';

export interface DiskNameOptions {
  /** 长度帽（`too-long` 判据）；缺省 80。项目名链传 60。 */
  maxLength?: number;
}

const ILLEGAL_DISK_CHARS = /[<>:"/\\|?*]/;
// 控制字符本身就是这里的判收对象（C0+DEL）——命名卫生单源的核心字符类。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const TRAILING_DOT_OR_SPACE = /[. ]+$/;

/** 保留名比对主名段：首个点之前（无点即全名）。 */
function reservedStemOf(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

function isReservedStem(name: string): boolean {
  return WINDOWS_RESERVED_NAMES.has(reservedStemOf(name).toLowerCase());
}

/**
 * 检查磁盘名违规，返回五类原因之一，null = 合法。判定序固定：
 * reserved → illegal-char → trailing-dot-space → control-char → too-long。
 */
export function findDiskNameViolation(
  name: string,
  opts?: DiskNameOptions,
): DiskNameViolationReason | null {
  const maxLength = opts?.maxLength ?? DEFAULT_DISK_NAME_MAX_LENGTH;
  if (isReservedStem(name)) return 'reserved';
  if (ILLEGAL_DISK_CHARS.test(name)) return 'illegal-char';
  if (TRAILING_DOT_OR_SPACE.test(name)) return 'trailing-dot-space';
  if (CONTROL_CHARS.test(name)) return 'control-char';
  if (name.length > maxLength) return 'too-long';
  return null;
}

/**
 * 五类违规的用户可见中文文案（DiskNameViolationError.message 拼装单源——renderer
 * 把 message 直接透成失败 toast）。reason 代码仍随 message 一起携带，程序化子串
 * 消费（按 'reserved' / 'too-long' 等匹配）不破。
 */
const VIOLATION_MESSAGES: Record<DiskNameViolationReason, string> = {
  reserved: '名称命中 Windows 保留设备名（CON、NUL、COM1 等）',
  'illegal-char': '名称含 Windows 非法字符（< > : " / \\ | ? *）',
  'trailing-dot-space': '名称不能以点号或空格结尾',
  'control-char': '名称含不可见的控制字符',
  'too-long': '名称超出长度上限',
};

/** 用户输入链的类型化失败（reason 供调用方映射逻辑；message 中文可直接透出）。 */
export class DiskNameViolationError extends Error {
  readonly reason: DiskNameViolationReason;
  readonly diskName: string;

  constructor(diskName: string, reason: DiskNameViolationReason) {
    super(`不能使用名称「${diskName}」：${VIOLATION_MESSAGES[reason]}（${reason}）`);
    this.name = 'DiskNameViolationError';
    this.diskName = diskName;
    this.reason = reason;
  }
}

/** 用户输入链拒绝面：违规即抛 `DiskNameViolationError`，合法名原样放行。 */
export function assertSafeDiskName(name: string, opts?: DiskNameOptions): void {
  const reason = findDiskNameViolation(name, opts);
  if (reason) throw new DiskNameViolationError(name, reason);
}

/** 保留名后缀插在扩展名之前（CON → CON-doc；CON.md → CON-doc.md）。 */
function insertReservedSuffix(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? `${name}-doc` : `${name.slice(0, dot)}-doc${name.slice(dot)}`;
}

/**
 * 截断到帽（CR-2b 代理对边界安全）：截断点恰落在高位代理（0xD800-0xDBFF）上时
 * 再削一位——孤立代理是无效 UTF-16 码点，落盘/比较/展示行为未定义。
 */
function truncateToCap(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  let out = s.slice(0, maxLength);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** 结尾点/空格复修（截断会把内部点/空格暴露成结尾形态）。 */
function repairTail(s: string): string {
  return s.replace(TRAILING_DOT_OR_SPACE, '');
}

/**
 * 自动派生链变换：非法/控制字符 → '-'，截断到帽，结尾点/空格剔除，保留名加
 * '-doc' 后缀。幂等（对输出重跑恒等）；输出保证通过 `findDiskNameViolation`。
 * 截断本身会制造两类新违规，故截断后必须复检：
 * - 把非保留名削成保留名（'const' 帽 3 → 'con'）；
 * - 把 '-doc' 闪避后缀削掉、保留名主名段重新裸露（'CON.md' 帽 4 → 'CON-doc.md'
 *   → 'CON-'；'com5.txt' 帽 4 → 'com5'）。
 * 处置 = 重插 '-doc' 再截断复修，迭代至稳定（上限 4 轮防死循环）；超短帽下
 * '-doc' 放不进帽内会振荡（'con' ↔ 'con-doc'，帽 3），此时以末字符替换 '-'
 * 兜底强制脱离保留名集（保留名最短 3 字符且不含 '-'，结果必 ≤ 帽且幂等）。
 */
export function sanitizeDiskName(name: string, opts?: DiskNameOptions): string {
  const maxLength = opts?.maxLength ?? DEFAULT_DISK_NAME_MAX_LENGTH;
  // 控制字符替换面同上（C0+DEL → '-'）。
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-');
  out = repairTail(out);
  if (isReservedStem(out)) {
    out = insertReservedSuffix(out);
  }
  out = repairTail(truncateToCap(out, maxLength));
  for (let i = 0; i < 4 && isReservedStem(out); i++) {
    out = repairTail(truncateToCap(insertReservedSuffix(out), maxLength));
  }
  if (isReservedStem(out)) {
    out = `${out.slice(0, -1)}-`;
  }
  return out;
}

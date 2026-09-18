import type { GenerationLane, ThinkingControl } from '@orison/shared-contracts';

// ── Antigravity CLI 参数面（09-12 agy provider，design §3.3）──
//
// 形态（装机实测 agy 1.2.2）：
//   agy --input-format stream-json --output-format stream-json
//       --disable-slash-commands --model <slug> --print-timeout <lane 映射>
//       [--effort low|medium|high]
//
// ⚠️ 不传 `-p`：stream-json 输入模式下 -p 传入的 prompt 被丢弃（官方文档 + 装机实
// 测），且 Go flag 解析坑——`-p` 会把后续 flag 名当 prompt 值吞掉（实测报错实证）。
// stdin 逐行驱动（长驻会话，见 sessions.ts）。

/**
 * lane → `--print-timeout` 映射（design §3.3 复核 M4）。⚠️ 此参数是**单 turn 总等待**
 * 语义（非首事件窗）——不可照搬 HTTP lane 首窗值（60s/240s）：
 *   - dialogue（leader 对话）：单 turn 总额 3m 足够；
 *   - background（链/写手长生成）：12m 覆盖长生成 + 余量；
 *   - 缺省：agy 默认 5m。
 * CLI 分派在协议层顶部早退，不经既有超时包装——print-timeout 即唯一时长闸，外层
 * 兜底 kill = print-timeout + PRINT_TIMEOUT_GRACE_MS（防 agy 自身超时机制失效）。
 */
const PRINT_TIMEOUT_BY_LANE: Record<GenerationLane, { arg: string; ms: number }> = {
  dialogue: { arg: '3m', ms: 3 * 60_000 },
  background: { arg: '12m', ms: 12 * 60_000 },
};
const PRINT_TIMEOUT_DEFAULT: { arg: string; ms: number } = { arg: '5m', ms: 5 * 60_000 };

/** 外层兜底 kill 的额外宽限（叠加在 print-timeout 之上，design §3.3）。 */
export const PRINT_TIMEOUT_GRACE_MS = 60_000;

export function printTimeoutForLane(lane: GenerationLane | undefined): { arg: string; ms: number } {
  // 枚举外值安全回落默认 5m（agent 缝经 agentIpc `as any` 直调豁免 zod parse——
  // CR-35 同指纹的运行时垃圾 lane 会真到这；裸查表 undefined 会让调用方
  // printTimeout.arg 抛 TypeError）。不刷屏 warn：一次性观测在网关 normalize 已有。
  return (lane !== undefined ? PRINT_TIMEOUT_BY_LANE[lane] : undefined) ?? PRINT_TIMEOUT_DEFAULT;
}

/**
 * ThinkingControl → `--effort` 子集映射（design §3.3）：low/medium/high → 同名；
 * auto/off/max/custom/缺席 → 不传（Gemini 族 effort 编码在 slug 后缀里——用户选 slug
 * 即选档；实测校准留真机验收）。常量表 + 单测锁定。
 */
export function effortArgForThinking(thinking: ThinkingControl | undefined): 'low' | 'medium' | 'high' | undefined {
  const level = thinking?.level;
  if (level === 'low' || level === 'medium' || level === 'high') return level;
  return undefined;
}

/**
 * 桥 turn print-timeout（子4 design §5.5）：write_chapter 内嵌整链时长 >> dialogue 3m
 * 档——独立常量 30m（W0-6 实测 `--print-timeout 30m` 接受；到期 agy 返回已产出部分 +
 * stderr 警告 + 成功退出，兜底行为面友好）。纯文本 turn 维持 lane 映射不变。
 */
export const BRIDGE_PRINT_TIMEOUT: { arg: string; ms: number } = { arg: '30m', ms: 30 * 60_000 };

/**
 * 桥 turn 外层兜底宽限（design §5.5：桥档 +5m）——与纯文本 `PRINT_TIMEOUT_GRACE_MS`
 * （60s）分档常量，勿混用：30m 档下 60s belt 余量不足（agy 自身 print-timeout 机制
 * 失效时的最后防线），design 定谳 +5m。
 */
export const BRIDGE_PRINT_TIMEOUT_GRACE_MS = 5 * 60_000;

export interface CliArgsInput {
  model: string;
  lane?: GenerationLane;
  thinking?: ThinkingControl;
  /** 覆盖 print-timeout（桥 turn 传 BRIDGE_PRINT_TIMEOUT）；缺省 = lane 映射。 */
  printTimeout?: { arg: string; ms: number };
}

/** 组装 spawn 参数数组（纯函数；无 `-p` 形态——见文件头）。 */
export function buildCliArgs(input: CliArgsInput): string[] {
  const printTimeout = input.printTimeout ?? printTimeoutForLane(input.lane);
  const args: string[] = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--model', input.model,
    '--print-timeout', printTimeout.arg,
  ];
  const effort = effortArgForThinking(input.thinking);
  if (effort !== undefined) {
    args.push('--effort', effort);
  }
  return args;
}

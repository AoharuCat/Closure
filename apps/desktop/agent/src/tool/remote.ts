import { z } from 'zod';
import { defineTool } from './define';
import type { ToolDefinition, ToolResult } from '../types';

export type ExecuteToolFn = (toolId: string, params: unknown, ctx: { projectDir: string; sessionId: string; abort: AbortSignal }) => Promise<ToolResult>;

let _executeTool: ExecuteToolFn | undefined;

/**
 * Inject (or clear, with `undefined`) the ExecuteToolFn seam. Accepting
 * `undefined` lets tests restore the pre-injection state in afterEach
 *（CR-24 测试卫生：beforeEach 注入 / afterEach 还原配对——残留 stub 会跨 describe
 * 泄漏成假执行环境）。
 */
export function setExecuteToolFn(fn: ExecuteToolFn | undefined) {
  _executeTool = fn;
}

function getExecuteToolFn(): ExecuteToolFn {
  if (!_executeTool) throw new Error('executeTool not initialized — call setExecuteToolFn first');
  return _executeTool;
}

/**
 * 直调注入的 ExecuteToolFn（转发到 shell toolExecution）。remoteToolProxy 的 execute 与本地
 * 包装工具（dogfood R2：outline_update 的 quality-gate 包装，outline-quality-gates.ts——包装
 * 不改执行路径，只做结果后处理）共用本单源，防转发语义两处漂移。
 */
export async function executeRemoteTool(
  toolId: string,
  params: unknown,
  ctx: { projectPath: string; sessionId: string; abort: AbortSignal },
): Promise<ToolResult> {
  const fn = getExecuteToolFn();
  return fn(toolId, params, {
    projectDir: ctx.projectPath,
    sessionId: ctx.sessionId,
    abort: ctx.abort,
  });
}

export function remoteToolProxy<T>(def: {
  id: string;
  description: string;
  parameters: z.ZodType<T>;
}): ToolDefinition<T> {
  return Object.assign(
    defineTool({
      ...def,
      async execute(params, ctx) {
        return executeRemoteTool(def.id, params, ctx);
      },
    }),
    { [REMOTE_PROXY_TOOL_FLAG]: true as const },
  );
}

/**
 * 注册形态标记（09-20 F17 桥车道工具对等 design §1.1）：remoteToolProxy 注册件带本标记
 * （proxy——执行经 setExecuteToolFn 注入缝转发 shell）；defineTool 直建件天然 local（进程内
 * ctx 执行，无标记）。`isRemoteProxyTool` 是形态判定单源——registry.getLocalToolDefinition
 * 据此分派，不维护第二份本地工具 id 清单（防漂移；15 件枚举基准留档 research/g6 §1.1）。
 */
const REMOTE_PROXY_TOOL_FLAG = '__orisonRemoteProxyTool';

/** 注册形态判定（单源）：remoteToolProxy 注册的 proxy 件 → true；defineTool 直建件 → false。 */
export function isRemoteProxyTool(tool: ToolDefinition): boolean {
  return (tool as unknown as Record<string, unknown>)[REMOTE_PROXY_TOOL_FLAG] === true;
}

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
  return defineTool({
    ...def,
    async execute(params, ctx) {
      return executeRemoteTool(def.id, params, ctx);
    },
  });
}

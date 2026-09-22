import type { ToolDefinition } from '../types';
import { isRemoteProxyTool } from './remote';

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  /**
   * 本地工具取件（09-20 F17 桥车道工具对等 design §1.1）：proxy 件（remoteToolProxy 注册
   * ——执行经 setExecuteToolFn 注入缝转发 shell）返回 undefined；defineTool 直建件
   * （write_chapter / dispatch_* / spawn_agent 族——进程内 ToolContext 执行）原样返回。
   * 桥车道执行缝（shell agyBridge executeBridgeToolCall）的分派判据——单源判定，不维护
   * 第二份本地工具 id 清单（防漂移；枚举基准留档 research/g6 §1.1）。
   */
  getLocalToolDefinition(id: string): ToolDefinition | undefined {
    const tool = this.tools.get(id);
    if (tool === undefined || isRemoteProxyTool(tool)) return undefined;
    return tool;
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  ids(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Test-only reset for this module singleton (mirror of the UI layer's
   * `__clearProjectResets` helper). Wiring tests call it in beforeEach so the
   * chain e2e "registry empty → draft-writer legacy direct-write" path and the
   * "registerBuiltinTools → two-phase" path are each assembled from an explicit
   * registry state instead of depending on describe execution order.
   */
  __clearForTest(): void {
    this.tools.clear();
  }
}

export const registry = new ToolRegistry();

/** 模块级取件面（agent 包根再导出——design §1.1；单源走 registry 实例方法）。 */
export function getLocalToolDefinition(id: string): ToolDefinition | undefined {
  return registry.getLocalToolDefinition(id);
}

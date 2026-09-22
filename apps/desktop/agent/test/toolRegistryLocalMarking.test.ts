import { describe, expect, it, afterEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/tool/define';
import { isRemoteProxyTool, remoteToolProxy } from '../src/tool/remote';
import { getLocalToolDefinition, registry } from '../src/tool/registry';
import { registerBuiltinTools } from '../src/tool/builtin';

// ── 09-20 F17 W0（桥车道工具对等 design §1.1）：registry 注册形态标记 ──
//
// 判定面单源：remoteToolProxy 注册件带 proxy 标记（执行经 setExecuteToolFn 注入缝转发
// shell）；defineTool 直建件天然 local（进程内 ToolContext 执行）。getLocalToolDefinition
// 是桥车道执行缝（shell agyBridge executeBridgeToolCall）的分派判据——本文件钉死：
//   1. 两形态判定不串（proxy 不命中 / local 命中且原样返回）；
//   2. 内置注册后本地件 = 20 件精确清单（G6 枚举 15 件 + outline_update 勘正——quality-gate
//      委托包装判 local 是正确语义 + 09-21 后台派发族四件；漏带/多带形态即刻红，防桥车道
//      分派面与真相漂移）。

afterEach(() => {
  registry.__clearForTest();
});

describe('registry 注册形态标记（design §1.1 分派判据单源）', () => {
  it('remoteToolProxy 件 → proxy 标记 + getLocalToolDefinition 不命中（代理执行留 shell 统一通道）', () => {
    const proxy = remoteToolProxy({ id: 'stub_proxy_tool', description: '代理件', parameters: z.object({}) });
    registry.register(proxy);
    expect(isRemoteProxyTool(proxy)).toBe(true);
    expect(getLocalToolDefinition('stub_proxy_tool')).toBeUndefined();
  });

  it('defineTool 件 → 无 proxy 标记 + getLocalToolDefinition 原样返回（同一对象引用）', () => {
    const local = defineTool({
      id: 'stub_local_tool',
      description: '本地件',
      parameters: z.object({}),
      async execute() {
        return { title: 't', output: 'ok' };
      },
    });
    registry.register(local);
    expect(isRemoteProxyTool(local)).toBe(false);
    expect(getLocalToolDefinition('stub_local_tool')).toBe(local);
    // registry.get 原行为不变（两形态都取得到——getLocalToolDefinition 只收窄面）。
    expect(registry.get('stub_local_tool')).toBe(local);
    expect(registry.get('stub_proxy_tool')).toBeUndefined(); // 未注册（上一用例已 clear）
  });

  it('未注册 id → undefined（不 throw）', () => {
    expect(getLocalToolDefinition('no_such_tool')).toBeUndefined();
  });

  it('registerBuiltinTools 后：本地件恰 20 件（G6 枚举基准 + outline_update 勘正 + 后台派发族）/ 代理件全不命中', () => {
    registry.__clearForTest();
    registerBuiltinTools();
    const localIds = registry
      .all()
      .filter((t) => !isRemoteProxyTool(t))
      .map((t) => t.id)
      .sort();
    // G6 §1.1 枚举基准 15 件 + outline_update 勘正：其注册是 quality-gate 委托包装
    //（outline-quality-gates.ts defineTool + executeRemoteTool 转发——G6 误归代理件）。
    // 判据下为本地件是**正确语义**：桥车道本地分支执行包装 → 质量门警示段与 HTTP 车道
    // 同样生效（转发零变，经注入缝直达 shell handler）。新增本地工具漏带/多带即刻红。
    // 09-21-subagent-bg-decouple W1：后台派发族四件（spawn_agent_bg + status/result/cancel）
    // 均为 defineTool 直建件（bg 记账直读模块级 BgTaskRegistry，mirror batch_status 先例）。
    expect(localIds).toEqual([
      'batch_status',
      'bg_task_cancel',
      'bg_task_result',
      'bg_tasks_status',
      'diagnose_impacts',
      'dispatch_episode_planner',
      'dispatch_researcher',
      'dispatch_story_planner',
      'dispatch_style_analyzer',
      'end_batch',
      'outline_update',
      'present_result',
      'set_participation_gear',
      'skill',
      'skill_resource_list',
      'skill_resource_read',
      'spawn_agent',
      'spawn_agent_bg',
      'start_batch',
      'write_chapter',
    ]);
    // 主缺口件命中（G1：write_chapter 面内断路 / dispatch_* 面外的执行缝判据）。
    expect(getLocalToolDefinition('write_chapter')?.id).toBe('write_chapter');
    expect(getLocalToolDefinition('dispatch_story_planner')?.id).toBe('dispatch_story_planner');
    // 代理件不命中（走 shell 统一通道——桥车道不得经 registry 绕一圈 remoteToolProxy）。
    expect(getLocalToolDefinition('read_file')).toBeUndefined();
    expect(getLocalToolDefinition('chapter_write')).toBeUndefined();
    expect(getLocalToolDefinition('scene_graph_update')).toBeUndefined();
    // outline_update 命中（quality-gate 委托包装——本地件，见上注）。
    expect(getLocalToolDefinition('outline_update')?.id).toBe('outline_update');
  });
});

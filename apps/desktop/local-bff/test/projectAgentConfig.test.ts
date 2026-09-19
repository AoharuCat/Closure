import { describe, expect, it } from 'vitest';
import { resolveProjectAgentConfigRoot } from '../orchestration/config/projectAgentConfig';

describe('project agent config root', () => {
  it('maps a project path to the default agent config directory', () => {
    const root = resolveProjectAgentConfigRoot('I:/workspace/demo');
    expect(root).toBe('I:/workspace/demo/project-config/agents');
  });

  it('反斜杠项目路径归一为 POSIX 斜杠形态（不产混合分隔符，多 OS R7/FS#12）', () => {
    expect(resolveProjectAgentConfigRoot('I:\\workspace\\demo')).toBe(
      'I:/workspace/demo/project-config/agents',
    );
    // 尾反斜杠同场剥除。
    expect(resolveProjectAgentConfigRoot('I:\\workspace\\demo\\')).toBe(
      'I:/workspace/demo/project-config/agents',
    );
  });

  it('尾正斜杠输入不产生双斜杠（原语义保持）', () => {
    expect(resolveProjectAgentConfigRoot('I:/workspace/demo/')).toBe(
      'I:/workspace/demo/project-config/agents',
    );
  });
});

/**
 * 项目级 agent 配置根：`<projectPath>/project-config/agents`。
 *
 * 输出恒为 POSIX `/` 分隔形态：入参先做反斜杠归一再剥尾分隔符（多 OS task R7 / FS#12——
 * Windows 反斜杠形态的项目路径不再产出混合分隔符；正斜杠输入的产出逐字节不变）。
 */
export function resolveProjectAgentConfigRoot(projectPath: string) {
  return `${projectPath.replace(/\\/g, '/').replace(/\/$/, '')}/project-config/agents`;
}

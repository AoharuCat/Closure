import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { parseAgentPromptYaml, loadAgentPrompt, setPromptsBaseDir } from '../src/prompt/agentPrompt';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.2 / implement.md 2.3：loadAgentPrompt / parseAgentPromptYaml。
// parseAgentPromptYaml = 纯函数 → plain vitest（含 BOM / 无 frontmatter / malformed / 正常 system+user）。
// loadAgentPrompt = 集成测（读真实 prompts/draft-writer-agent.yaml，证 FS 路径解析 + yaml 加载）。
// ─────────────────────────────────────────────────────────────────────────────

const BOM = String.fromCharCode(0xfeff);

const NORMAL_YAML = [
  'system: |',
  '  你是一个专业的故事写作者。根据章节任务卡撰写高质量初稿。',
  '  始终使用中文写作。',
  '',
  'user: |',
  '  请根据以下信息撰写初稿：',
  '  章节任务：{{chapterTask}}',
  '  故事大纲：{{storyPlan}}',
  '  请输出包含 title、text 的 JSON。',
].join('\n');

describe('parseAgentPromptYaml（纯函数 yaml 解析）', () => {
  it('正常 system+user 段：两段都解析为字符串', () => {
    const r = parseAgentPromptYaml(NORMAL_YAML);
    expect(r.system).toContain('专业的故事写作者');
    expect(r.system).toContain('始终使用中文写作');
    expect(r.userTemplate).toContain('章节任务：{{chapterTask}}');
    expect(r.userTemplate).toContain('故事大纲：{{storyPlan}}');
  });

  it('无 frontmatter fence（prompts 常态：纯 yaml 文档）整篇 load', () => {
    // prompts/*.yaml 是顶层 system:/user: 的纯 yaml，无 `---` frontmatter fence。
    // 与 craftMd 的 frontmatter+body 结构不同——这里整篇 yaml.load。
    const r = parseAgentPromptYaml('system: |\n  hello\nuser: |\n  world {{x}}\n');
    expect(r.system).toBe('hello\n');
    expect(r.userTemplate).toBe('world {{x}}\n');
  });

  it('BOM（U+FEFF）前缀被剥离，system/user 正确解析', () => {
    // Windows Notepad 常存 BOM；不剥则 js-yaml 把 BOM 当首 key 的一部分 → system 段取不到。
    const r = parseAgentPromptYaml(BOM + NORMAL_YAML);
    expect(r.system).toContain('专业的故事写作者');
    expect(r.userTemplate).toContain('{{chapterTask}}');
  });

  it('malformed yaml → degrade 到空 {system:"", userTemplate:""}（不抛）', () => {
    // mirror craftMd「degrade, don't drop」：malformed 不抛，返回空让链段降级。
    const malformed = 'system: |\n  bad: : : value\nuser: {invalid\n';
    const r = parseAgentPromptYaml(malformed);
    expect(r.system).toBe('');
    expect(r.userTemplate).toBe('');
  });

  it('缺 user 段 → userTemplate 空串，system 仍解析', () => {
    const r = parseAgentPromptYaml('system: |\n  only system here\n');
    expect(r.system).toBe('only system here\n');
    expect(r.userTemplate).toBe('');
  });

  it('缺 system 段 → system 空串', () => {
    const r = parseAgentPromptYaml('user: |\n  only user\n');
    expect(r.system).toBe('');
    expect(r.userTemplate).toBe('only user\n');
  });

  it('空字符串 → 两段空串', () => {
    const r = parseAgentPromptYaml('');
    expect(r.system).toBe('');
    expect(r.userTemplate).toBe('');
  });

  it('system/user 非 string（如数字/数组）→ 该字段空串', () => {
    const r = parseAgentPromptYaml('system: 42\nuser: [a, b]\n');
    expect(r.system).toBe('');
    expect(r.userTemplate).toBe('');
  });

  it('纯函数确定性：同输入两次调用结果相同', () => {
    const a = parseAgentPromptYaml(NORMAL_YAML);
    const b = parseAgentPromptYaml(NORMAL_YAML);
    expect(a).toEqual(b);
  });
});

describe('loadAgentPrompt（集成：读真实 prompts/<role>.yaml）', () => {
  it('读 draft-writer-agent.yaml → 返回非空 system + userTemplate（证 FS 路径解析正确）', async () => {
    // 路径解析：import.meta.url → src/prompt/ → ../../prompts/ → apps/desktop/agent/prompts/
    const r = await loadAgentPrompt('draft-writer-agent');
    expect(r.system.length).toBeGreaterThan(0);
    expect(r.userTemplate.length).toBeGreaterThan(0);
  });

  it('system 段是 yaml 契约内容（非运行时默认 systemPrompt "You are Closure"）', async () => {
    // 核心断言（design §4.2 verify-point）：节点用 yaml system，不是 runChildAgent 的 .md/默认 system。
    const r = await loadAgentPrompt('draft-writer-agent');
    expect(r.system).not.toContain('You are Closure');
  });

  it('userTemplate 含 {{var}} 占位（交 renderTemplate 渲染）', async () => {
    const r = await loadAgentPrompt('draft-writer-agent');
    expect(r.userTemplate).toMatch(/\{\{chapterTask\}\}/);
  });

  it('multi-review-agent.yaml 同样可加载（system + userTemplate 非空）', async () => {
    const r = await loadAgentPrompt('multi-review-agent');
    expect(r.system.length).toBeGreaterThan(0);
    expect(r.userTemplate).toMatch(/\{\{draftText\}\}/);
  });

  it('缺失的 role → degrade 到空 {system:"", userTemplate:""}（不抛）', async () => {
    const r = await loadAgentPrompt('nonexistent-agent-xyz');
    expect(r.system).toBe('');
    expect(r.userTemplate).toBe('');
  });

  it('CR-9a：模块级 cache——同 role 多次调用返同一引用（FS 只读一次）', async () => {
    // prompts/*.yaml 静态资源，进程内不变；cache 避免每 node.run 读 FS（dogfood 一链段 4-6 次 generate）。
    const a = await loadAgentPrompt('draft-writer-agent');
    const b = await loadAgentPrompt('draft-writer-agent');
    expect(a).toBe(b); // 同一缓存对象引用（非重读重 parse）
  });
});

// ── dogfood #48（2026-08-21）：bundled 运行时的基址注入缝 ──
// electron-vite 把 agent 打进 shell dist/main/index.cjs 后 import.meta.url heuristic
// 解析到 shell/prompts（ENOENT → degrade empty → researcher 丢 brief 三连实录）。
// setPromptsBaseDir 由 shell 启动 wiring 注入真实基址；此处验证注入生效 + cache 重置。
describe('setPromptsBaseDir 注入（dogfood #48）', () => {
  afterEach(() => {
    // 还原默认 heuristic，避免污染同文件其它 describe 的默认路径断言。
    setPromptsBaseDir(path.resolve(__dirname, '..', 'prompts'));
  });

  it('注入后从新基址加载 role 契约', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'prompts-base-'));
    try {
      writeFileSync(
        path.join(tmp, 'stub-agent.yaml'),
        'system: |\n  stub system\nuser: |\n  stub {{brief}}\n',
        'utf-8',
      );
      setPromptsBaseDir(tmp);
      const r = await loadAgentPrompt('stub-agent');
      expect(r.system).toBe('stub system\n');
      expect(r.userTemplate).toBe('stub {{brief}}\n');
    } finally {
      rmBestEffort(tmp);
    }
  });

  it('切换基址清空 cache——同 role 换基址后读到新内容', async () => {
    const tmpA = mkdtempSync(path.join(os.tmpdir(), 'prompts-a-'));
    const tmpB = mkdtempSync(path.join(os.tmpdir(), 'prompts-b-'));
    try {
      writeFileSync(path.join(tmpA, 'swap-agent.yaml'), 'system: |\n  A\nuser: |\n  A\n', 'utf-8');
      writeFileSync(path.join(tmpB, 'swap-agent.yaml'), 'system: |\n  B\nuser: |\n  B\n', 'utf-8');
      setPromptsBaseDir(tmpA);
      expect((await loadAgentPrompt('swap-agent')).system).toBe('A\n');
      setPromptsBaseDir(tmpB);
      expect((await loadAgentPrompt('swap-agent')).system).toBe('B\n');
    } finally {
      rmBestEffort(tmpA);
      rmBestEffort(tmpB);
    }
  });
});

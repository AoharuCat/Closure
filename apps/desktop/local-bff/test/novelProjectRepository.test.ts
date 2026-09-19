import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyProjectDocument, loadProject, saveProject } from '../sync/localProjectRepository';
import {
  loadChapterMetadata,
  loadChapterMarkdown,
  acceptChapterCandidate,
} from '../sync/novelProjectRepository';

const TEST_PROJECT_DIR = path.join(process.cwd(), 'test-tmp-novel-project');

describe('novel project repository', () => {
  afterEach(() => {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('loadChapterMetadata 读取章节元数据（从 project.yaml 的 novel.chapters）', () => {
    const project = createEmptyProjectDocument('Chapter Meta Test');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: 'ch_001',
            title: '第1章 暗夜降临',
            sort_order: 0,
            sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md', word_count: 2500 }],
            summary: '主角来到暗城。',
            summary_source: 'ai',
            status: 'draft',
            word_count: 2500,
          },
          {
            id: 'ch_002',
            title: '第2章 迷局',
            sort_order: 1,
            sections: [{ id: 'ch_002_s1', sort_order: 0, content_file: 'chapters/ch_002.md' }],
            status: 'generating',
            last_run_id: 'run_abc123',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const chapter = loadChapterMetadata(TEST_PROJECT_DIR, 'ch_001');

    expect(chapter).not.toBeNull();
    expect(chapter!.id).toBe('ch_001');
    expect(chapter!.title).toBe('第1章 暗夜降临');
    expect(chapter!.sections[0].content_file).toBe('chapters/ch_001.md');
    expect(chapter!.status).toBe('draft');
  });

  it('loadChapterMetadata 对不存在的章节ID返回 null', () => {
    const project = createEmptyProjectDocument('Not Found Test');
    saveProject(TEST_PROJECT_DIR, project);

    const chapter = loadChapterMetadata(TEST_PROJECT_DIR, 'ch_nonexistent');
    expect(chapter).toBeNull();
  });

  it('loadChapterMarkdown 读取章节 markdown 内容', () => {
    // 创建 project.yaml + 对应的 md 文件
    const project = createEmptyProjectDocument('Markdown Test');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          { id: 'ch_001', title: '第1章', sort_order: 0, sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    // 写入 markdown 文件
    const mdDir = path.join(TEST_PROJECT_DIR, 'chapters');
    mkdirSync(mdDir, { recursive: true });
    writeFileSync(path.join(mdDir, 'ch_001.md'), '# 第1章\n\n夜幕降临，主角踏入暗城。', 'utf8');

    const content = loadChapterMarkdown(TEST_PROJECT_DIR, 'chapters/ch_001.md');

    expect(typeof content).toBe('string');
    expect(content!.length).toBeGreaterThan(0);
    expect(content).toContain('第1章');
  });

  it('loadChapterMarkdown 对不存在的文件返回 null', () => {
    const content = loadChapterMarkdown(TEST_PROJECT_DIR, 'chapters/不存在.md');
    expect(content).toBeNull();
  });

  it('loadChapterMarkdown CRLF 章文读出 LF（外部编辑器行尾归一，多 OS R3）', () => {
    const project = createEmptyProjectDocument('CRLF Test');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          { id: 'ch_001', title: '第1章', sort_order: 0, sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const mdDir = path.join(TEST_PROJECT_DIR, 'chapters');
    mkdirSync(mdDir, { recursive: true });
    // 外部编辑器（Windows 记事本系）CRLF 存盘形态——归一后 \r 不进同步链。
    writeFileSync(path.join(mdDir, 'ch_001.md'), '第一段\r\n第二段\r\n', 'utf8');

    const content = loadChapterMarkdown(TEST_PROJECT_DIR, 'chapters/ch_001.md');

    expect(content).toBe('第一段\n第二段\n');
  });

  it('acceptChapterCandidate 写入 markdown 并更新 chapter 元数据', () => {
    const project = createEmptyProjectDocument('Accept Test');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: 'ch_001',
            title: '旧标题',
            sort_order: 0,
            sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }],
            status: 'generating',
            last_run_id: 'run_test456',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const candidate = {
      title: '第1章 新标题',
      content: '夜幕降临，主角踏入暗城。\n\n这是一座永不眠的城市。',
      summary: '主角初到暗城的新版摘要。',
      wordCount: 42,
    };

    acceptChapterCandidate(TEST_PROJECT_DIR, 'ch_001', 'run_accept1', candidate);

    // 验证 markdown 已写入
    const mdPath = path.join(TEST_PROJECT_DIR, 'chapters/ch_001.md');
    expect(existsSync(mdPath)).toBe(true);
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('夜幕降临');

    // 验证 project.yaml 中元数据已更新
    const updated = loadChapterMetadata(TEST_PROJECT_DIR, 'ch_001');
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('第1章 新标题');
    expect(updated!.summary).toBe('主角初到暗城的新版摘要。');
    expect(updated!.word_count).toBe(42);
    expect(updated!.status).toBe('draft');
  });

  it('acceptChapterCandidate 仅含最小内容时正确写入', () => {
    const project = createEmptyProjectDocument('Min Candidate');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          { id: 'ch_001', title: '最小章', sort_order: 0, sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }], status: 'generating' },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    acceptChapterCandidate(TEST_PROJECT_DIR, 'ch_001', 'run_min', { content: '最小内容。' });

    const mdPath = path.join(TEST_PROJECT_DIR, 'chapters/ch_001.md');
    expect(existsSync(mdPath)).toBe(true);
    expect(readFileSync(mdPath, 'utf8')).toBe('最小内容。');
  });

  // ── Story 4.1 Step 4：acceptChapterCandidate 经 core + story_decisions 追加 ──

  it('4.1 Step 4：storyDecisions 追加到 novel.story_decisions（accept 登记 decided decision）', () => {
    const project = createEmptyProjectDocument('StoryDecision Append');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          { id: 'ch_001', title: '第1章', sort_order: 0, sections: [{ id: 'ch_001_s1', sort_order: 0, content_file: 'chapters/ch_001.md' }] },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);

    const decision = {
      id: 'accept-run_d1',
      summary: '正文偏离计划',
      reason: '角色突然硬气',
      alternatives: [],
      risk: '后续章节须校正',
      status: 'decided' as const,
      source: 'accept_as_truth' as const,
      relatedEpisodeId: 'ep1',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    acceptChapterCandidate(
      TEST_PROJECT_DIR,
      'ch_001',
      'run_d1',
      { content: '正文内容' },
      [decision],
    );

    // 重新 load 验证 story_decisions 落盘
    const updated = loadChapterMetadata(TEST_PROJECT_DIR, 'ch_001');
    const doc = loadProject(TEST_PROJECT_DIR) as any;
    expect(doc.novel.story_decisions).toEqual([decision]);
    expect(updated!.status).toBe('draft');
  });

  it('4.1 Step 4：chapter 不存在 → throw（core 返 null，mirror 4.0 前显式失败）', () => {
    const project = createEmptyProjectDocument('Missing Chapter');
    saveProject(TEST_PROJECT_DIR, project);

    expect(() =>
      acceptChapterCandidate(TEST_PROJECT_DIR, 'ch_nonexistent', 'r1', { content: 'x' }),
    ).toThrow(/not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #107 check 批补缝：accept 覆写保序——candidate.content 是 draft 正文（无 frontmatter），
// 整体覆盖会把已注册章文件的 frontmatter `order:`（#107 登记载体）物理抹掉 → 派生重排错位。
// 修法 = 旧文件有 frontmatter 且新内容无 → 旧块回拼（shared-contracts
// preserveChapterFrontmatter 单源）。历史 body-only 章（无 frontmatter）零行为变化。
// ─────────────────────────────────────────────────────────────────────────────

describe('acceptChapterCandidate 覆写保序（#107 check 批）', () => {
  afterEach(() => {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  function seedProjectWithChapterFile(mdContent: string): void {
    const project = createEmptyProjectDocument('FM Preserve Test');
    const withNovel = {
      ...project,
      novel: {
        chapters: [
          {
            id: '第01章-旧章',
            title: '旧章',
            sort_order: 0,
            sections: [{ id: 's1', sort_order: 0, content_file: 'chapters/第01章-旧章.md' }],
            status: 'draft',
          },
        ],
      },
    };
    saveProject(TEST_PROJECT_DIR, withNovel as any);
    const mdDir = path.join(TEST_PROJECT_DIR, 'chapters');
    if (!existsSync(mdDir)) mkdirSync(mdDir, { recursive: true });
    writeFileSync(path.join(mdDir, '第01章-旧章.md'), mdContent, 'utf8');
  }

  it('旧文件带 frontmatter order + body-only 候选 → 覆写后 order 保留（正文替换）', () => {
    seedProjectWithChapterFile('---\norder: 0\n---\n\n# 旧章\n\n旧正文。');
    acceptChapterCandidate(TEST_PROJECT_DIR, '第01章-旧章', 'run_fm1', {
      content: '# 新标题\n\n新正文。',
    });
    const md = readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/第01章-旧章.md'), 'utf8');
    expect(md).toBe('---\norder: 0\n---\n# 新标题\n\n新正文。');
  });

  it('候选自带 frontmatter（#107 全形态）→ 原样写入，不双拼', () => {
    seedProjectWithChapterFile('---\norder: 0\n---\n\n# 旧章\n\n旧正文。');
    const fullForm = '---\norder: 0\n---\n\n# 新章\n\n新正文。';
    acceptChapterCandidate(TEST_PROJECT_DIR, '第01章-旧章', 'run_fm2', { content: fullForm });
    const md = readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/第01章-旧章.md'), 'utf8');
    expect(md).toBe(fullForm);
  });

  it('历史 body-only 章文件（无 frontmatter）→ 候选原样写入（零行为变化）', () => {
    seedProjectWithChapterFile('# 旧章\n\n旧正文。');
    acceptChapterCandidate(TEST_PROJECT_DIR, '第01章-旧章', 'run_fm3', {
      content: '# 新标题\n\n新正文。',
    });
    const md = readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/第01章-旧章.md'), 'utf8');
    expect(md).toBe('# 新标题\n\n新正文。');
  });

  it('外编 CRLF 旧章 → 回拼落盘纯 LF（读侧归一，\\r 零残留）', () => {
    seedProjectWithChapterFile('---\r\norder: 0\r\n---\r\n\r\n# 旧章\r\n\r\n旧正文。');
    acceptChapterCandidate(TEST_PROJECT_DIR, '第01章-旧章', 'run_fm4', {
      content: '# 新标题\n\n新正文。',
    });
    const md = readFileSync(path.join(TEST_PROJECT_DIR, 'chapters/第01章-旧章.md'), 'utf8');
    expect(md).toBe('---\norder: 0\n---\n# 新标题\n\n新正文。');
    expect(md.includes('\r')).toBe(false);
  });
});

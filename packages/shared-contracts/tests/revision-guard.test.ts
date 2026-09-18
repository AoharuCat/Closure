import { describe, expect, it } from 'vitest';
import {
  revisionGuardArtifactSchema,
  guardVerdictSchema,
  guardFindingSchema,
  parseRevisionGuard,
  coerceRevisionGuard,
  filterValidFindings,
  GUARD_DRIFT_PATTERNS,
  GUARD_DRIFT_PATTERN_LABELS_ZH,
  AUTHOR_VOICE_DIMENSIONS,
  resumeChapterChainInputSchema,
  type GuardFinding,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.2（design §1.2）：revision-guard artifact schema + parse。
// 纯 Zod schema → plain vitest（无 fs/db/LLM）。覆盖：
// - guardVerdictSchema：clean/soft-violation/hard-violation 3 档 + 非法 reject
// - guardFindingSchema：pattern（自由 string 非封闭 enum）+ violatedScope + authority（hard/soft）
//   + evidence{before,after,explanation} 必填
// - GUARD_DRIFT_PATTERNS 策展词表（6 类，prior 非门禁）+ LABELS_ZH + AUTHOR_VOICE_DIMENSIONS
// - revisionGuardArtifactSchema：verdict 必填 + findings default([]) + summary default('') + l1Report optional
// - parseRevisionGuard：三路径鲁棒（fenced / brace-match / 整体）+ 非法 → null（caller escalate fallback）
// - coerceRevisionGuard：合法对象 → verdict/findings/summary / 畸形 → undefined
// - 🔑 pattern 自由 string：词表外值（如未来新模式）schema 接受（非封闭 enum，语义归 LLM）
// ─────────────────────────────────────────────────────────────────────────────

/** 合法 GuardFinding fixture（漂移模式①语义倒退）。 */
const GOOD_FINDING: GuardFinding = {
  pattern: 'semantic-retreat',
  violatedScope: '角色性格',
  authority: 'hard',
  evidence: {
    before: '他研究控制面板',
    after: '他拆控制面板',
    explanation: '「研究」是观察理解（已过破坏阶段），「拆」是无视上下文进展的动作倒退',
  },
};

describe('guardVerdictSchema（Story 7.2 三层处置 dispatch enum）', () => {
  it('3 档合法', () => {
    expect(guardVerdictSchema.parse('clean')).toBe('clean');
    expect(guardVerdictSchema.parse('soft-violation')).toBe('soft-violation');
    expect(guardVerdictSchema.parse('hard-violation')).toBe('hard-violation');
  });

  it('非法 verdict reject', () => {
    expect(() => guardVerdictSchema.parse('warning')).toThrow();
    expect(() => guardVerdictSchema.parse('')).toThrow();
  });
});

describe('guardFindingSchema（pattern 自由 string 非封闭 enum）', () => {
  it('全字段合法', () => {
    expect(guardFindingSchema.parse(GOOD_FINDING)).toEqual(GOOD_FINDING);
  });

  it('authority hard/soft 2 档 + 非法 reject', () => {
    expect(guardFindingSchema.parse({ ...GOOD_FINDING, authority: 'soft' }).authority).toBe('soft');
    expect(() => guardFindingSchema.parse({ ...GOOD_FINDING, authority: 'medium' })).toThrow();
  });

  it('🔑 pattern 词表外值合法（非封闭 enum，语义归 LLM）', () => {
    // 未来新漂移模式（词表外）schema 接受——非 z.enum() 门禁。
    const futurePattern = guardFindingSchema.parse({
      ...GOOD_FINDING,
      pattern: 'future-new-drift-kind',
    });
    expect(futurePattern.pattern).toBe('future-new-drift-kind');
  });

  it('pattern/violatedScope/explanation 非空（.min(1) 拒空串）', () => {
    expect(() => guardFindingSchema.parse({ ...GOOD_FINDING, pattern: '' })).toThrow();
    expect(() => guardFindingSchema.parse({ ...GOOD_FINDING, violatedScope: '' })).toThrow();
    expect(() =>
      guardFindingSchema.parse({ ...GOOD_FINDING, evidence: { ...GOOD_FINDING.evidence, explanation: '' } }),
    ).toThrow();
  });

  it('evidence 三字段必填', () => {
    expect(() => {
      const { before: _omit, ...rest } = GOOD_FINDING.evidence;
      void _omit;
      guardFindingSchema.parse({ ...GOOD_FINDING, evidence: rest });
    }).toThrow();
  });
});

describe('GUARD_DRIFT_PATTERNS 策展词表（prior 非门禁）', () => {
  it('6 类漂移模式（用户案例提炼）', () => {
    expect(GUARD_DRIFT_PATTERNS).toEqual([
      'semantic-retreat',
      'viewpoint-loss',
      'agency-removal',
      'tone-rhythm-cut',
      'verbal-tic',
      'imagery-downgrade',
    ]);
  });

  it('LABELS_ZH 覆盖全部 6 类', () => {
    for (const p of GUARD_DRIFT_PATTERNS) {
      expect(GUARD_DRIFT_PATTERN_LABELS_ZH[p]).toBeTruthy();
    }
  });

  it('AUTHOR_VOICE_DIMENSIONS 5 维（默认 soft 作者声音）', () => {
    expect(AUTHOR_VOICE_DIMENSIONS).toEqual(['tone', 'viewpoint', 'rhythm', 'imagery', 'agency']);
  });
});

describe('revisionGuardArtifactSchema', () => {
  it('verdict 必填 + findings/summary default', () => {
    const parsed = revisionGuardArtifactSchema.parse({ verdict: 'clean' });
    expect(parsed.verdict).toBe('clean');
    expect(parsed.findings).toEqual([]);
    expect(parsed.summary).toBe('');
  });

  it('findings 数组合法（soft-violation 带越界项）', () => {
    const artifact = revisionGuardArtifactSchema.parse({
      verdict: 'soft-violation',
      findings: [GOOD_FINDING],
      summary: '软锁越界',
    });
    expect(artifact.findings).toHaveLength(1);
    expect(artifact.verdict).toBe('soft-violation');
  });

  it('l1Report/beforeText/afterText optional（节点填，L2 输出可缺）', () => {
    const artifact = revisionGuardArtifactSchema.parse({
      verdict: 'clean',
      findings: [],
    });
    expect(artifact.l1Report).toBeUndefined();
    expect(artifact.beforeText).toBeUndefined();
  });

  it('forceAccepted/skipped optional', () => {
    const artifact = revisionGuardArtifactSchema.parse({
      verdict: 'clean',
      forceAccepted: true,
      skipped: false,
    });
    expect(artifact.forceAccepted).toBe(true);
  });

  it('缺 verdict reject', () => {
    expect(() => revisionGuardArtifactSchema.parse({ findings: [] })).toThrow();
  });
});

describe('parseRevisionGuard（三路径鲁棒，mirror parseRevisionIntent）', () => {
  it('路径 1：fenced ```json 块', () => {
    const content = '分析如下：\n```json\n{"verdict":"soft-violation","findings":[],"summary":"软锁越界"}\n```\n结束';
    const parsed = parseRevisionGuard(content);
    expect(parsed?.verdict).toBe('soft-violation');
    expect(parsed?.summary).toBe('软锁越界');
  });

  it('路径 2：brace-match（无 fence，narration-tolerant）', () => {
    const content = '我的判定是 {"verdict":"clean","findings":[],"summary":"通过"} 就这样';
    const parsed = parseRevisionGuard(content);
    expect(parsed?.verdict).toBe('clean');
  });

  it('路径 3：整体 JSON（无 fence 单对象）', () => {
    const content = '{"verdict":"hard-violation","findings":[{"pattern":"semantic-retreat","violatedScope":"结局","authority":"hard","evidence":{"before":"a","after":"b","explanation":"c"}}],"summary":"硬锁越界"}';
    const parsed = parseRevisionGuard(content);
    expect(parsed?.verdict).toBe('hard-violation');
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0].pattern).toBe('semantic-retreat');
  });

  it('multi-fence tolerant：取首个合法块', () => {
    const content = '```json\n{"bad":1}\n```\n中间\n```json\n{"verdict":"clean","findings":[],"summary":""}\n```';
    const parsed = parseRevisionGuard(content);
    expect(parsed?.verdict).toBe('clean');
  });

  it('非法 JSON / 无 verdict → null（caller escalate fallback → hard-violation）', () => {
    expect(parseRevisionGuard('')).toBeNull();
    expect(parseRevisionGuard('纯文本无 JSON')).toBeNull();
    expect(parseRevisionGuard('{"foo":"bar"}')).toBeNull(); // 缺 verdict
    expect(parseRevisionGuard('{"verdict":"warning"}')).toBeNull(); // 非法 verdict
  });

  it('含 findings 的完整解析（shape 守卫）', () => {
    const content = '{"verdict":"soft-violation","findings":[{"pattern":"verbal-tic","violatedScope":"tone","authority":"soft","evidence":{"before":"解析","after":"算死","explanation":"万能副词"}}],"summary":"口癖注入"}';
    const parsed = parseRevisionGuard(content);
    expect(parsed?.findings[0]).toEqual({
      pattern: 'verbal-tic',
      violatedScope: 'tone',
      authority: 'soft',
      evidence: { before: '解析', after: '算死', explanation: '万能副词' },
    });
  });
});

describe('coerceRevisionGuard（shape 守卫，in-process 构造防御）', () => {
  it('合法对象 → verdict/findings/summary', () => {
    const result = coerceRevisionGuard({ verdict: 'clean', findings: [], summary: '' });
    expect(result?.verdict).toBe('clean');
    expect(result?.findings).toEqual([]);
  });

  it('畸形 → undefined', () => {
    expect(coerceRevisionGuard({ verdict: 'bad' })).toBeUndefined();
    expect(coerceRevisionGuard(null)).toBeUndefined();
    expect(coerceRevisionGuard('not-an-object')).toBeUndefined();
  });
});

describe('BMad CR CR-EDGE-003：findings per-element filter（单条畸形不丢整个 verdict）', () => {
  it('5 好 + 1 坏 finding → 保 5 好，verdict 不丢（不升级 hard-violation）', () => {
    // 坏 finding 缺 explanation（guardFindingSchema 要求 .min(1)）。
    const good = (n: string) => ({
      pattern: 'semantic-retreat',
      violatedScope: n,
      authority: 'hard' as const,
      evidence: { before: 'b', after: 'a', explanation: 'ok' },
    });
    const content = JSON.stringify({
      verdict: 'soft-violation',
      findings: [good('s1'), good('s2'), good('s3'), good('s4'), good('s5'), { pattern: 'bad', violatedScope: 'x', authority: 'hard', evidence: { before: 'b', after: 'a', explanation: '' } }],
      summary: '软锁',
    });
    const parsed = parseRevisionGuard(content);
    expect(parsed?.verdict).toBe('soft-violation');
    expect(parsed?.findings).toHaveLength(5); // 坏那条丢，5 好保
  });

  it('findings 非数组 → 空数组（不丢 verdict）', () => {
    const content = '{"verdict":"clean","findings":"not-array","summary":""}';
    const parsed = parseRevisionGuard(content);
    expect(parsed?.verdict).toBe('clean');
    expect(parsed?.findings).toEqual([]);
  });

  it('filterValidFindings 直接调：混好坏 → 过滤坏条目', () => {
    const result = filterValidFindings([
      { pattern: 'verbal-tic', violatedScope: 'tone', authority: 'soft', evidence: { before: 'a', after: 'b', explanation: 'c' } },
      { pattern: '', violatedScope: 'x', authority: 'hard', evidence: { before: '', after: '', explanation: '' } }, // 全坏
      'not-an-object',
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].pattern).toBe('verbal-tic');
  });
});

describe('BMad CR CR-001：resumeChapterChainInputSchema refinement（guardOverride 仅 redo 合法）', () => {
  it('guardOverride + redo 合法', () => {
    const result = resumeChapterChainInputSchema.safeParse({
      projectPath: '/p', sessionId: 's', action: 'redo', guardOverride: 'force-accept',
    });
    expect(result.success).toBe(true);
  });

  it('guardOverride + continue → reject（soft-violation pause 时 guard 在 completedNodes，continue 跳过）', () => {
    const result = resumeChapterChainInputSchema.safeParse({
      projectPath: '/p', sessionId: 's', action: 'continue', guardOverride: 'force-accept',
    });
    expect(result.success).toBe(false);
  });

  it('无 guardOverride + continue 合法（既有路径零回归）', () => {
    const result = resumeChapterChainInputSchema.safeParse({
      projectPath: '/p', sessionId: 's', action: 'continue',
    });
    expect(result.success).toBe(true);
  });
});

describe('CR-13（09-13 CR 修复批）：editedDraft 空白串拒收（trim 非空 refine）', () => {
  it('accept + 有实质内容 editedDraft 合法', () => {
    const result = resumeChapterChainInputSchema.safeParse({
      projectPath: '/p', sessionId: 's', action: 'accept', editedDraft: '# 第一章\n\n正文',
    });
    expect(result.success).toBe(true);
  });

  it('accept + whitespace-only editedDraft → reject（防 F1a 以空白覆写正文）', () => {
    const result = resumeChapterChainInputSchema.safeParse({
      projectPath: '/p', sessionId: 's', action: 'accept', editedDraft: " \n\t ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('editedDraft'))).toBe(true);
    }
  });
});

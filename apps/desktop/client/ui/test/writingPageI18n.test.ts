/**
 * 写作页 i18n 齐平守卫（task 09-13-writing-page-ui W7）。
 *
 * 1. **zh/en 键集完全相等**（本任务三文件：writing.yaml / chain.yaml / agent.yaml——结构性
 *    diff，加键漏一侧即红；mirror settingPageI18n.test.ts 谱）。agent.yaml 是全 app 级大
 *    文件（~441 键），本任务 W4/W5 增量的 parity 也被全文件断言罩住。
 * 2. **两 locale 叶子值均非空字符串**（空文案 = 渲染空白）。
 * 3. **静态消费键全在位**（源扫描防漂移）：扫 features/writing/** + ReviewPendingNotice +
 *    chapterReviewSlice 里出现的 `writing.*` / `chain.*` / `agent.*` 字符串字面量，逐键断言
 *    两 locale 在位——比手抄清单强（组件新引用键漏 yaml 即红，不依赖人维护清单）。模板
 *    字面量（`chain.sev.${severity}` 类）不含 ${ 前的完整键，由第 4 条域枚举兜住。
 * 4. **动态键域全在位**：23 节点名表（nodeCatalog 单源 import 对拍）/ 段名 + 段说明
 *    （CHAIN_NODE_SEGMENTS 派生）/ severity 词表（mirror chainTimelineView.severityLabel
 *    known 集）/ phase 三层 + 状态词 / run 状态 5 值 / pauseKind 7 值（mirror
 *    reviewPhase.ReviewPauseKind）/ 打回快捷理由 4 / escalate 勾选 3 值 / 终态产物区
 *    outcome metric + unit 键（ChainOutcome 模板拼键，mirror chainTimelineView
 *    .OutcomeCountRow metric union）。
 * 5. **插值占位完整**：写作页全部带参键的 {name} 占位逐键在位（丢占位 = 渲染裸模板）。
 * 6. **translate 冒烟**：chain.yaml / writing.yaml 是本任务新文件——eager glob 加载链真见到
 *    新文件（放错目录/解析失败静默即红；缺键回落裸键名探针）。
 *
 * 直读 yaml 原文（?raw + js-yaml）而非经 translate——结构比较需要完整键树（mirror
 * settingPageI18n / worldStateI18n 注记）。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zhWritingRaw from '../src/shared/i18n/zh-CN/writing.yaml?raw';
import enWritingRaw from '../src/shared/i18n/en-US/writing.yaml?raw';
import zhChainRaw from '../src/shared/i18n/zh-CN/chain.yaml?raw';
import enChainRaw from '../src/shared/i18n/en-US/chain.yaml?raw';
import zhAgentRaw from '../src/shared/i18n/zh-CN/agent.yaml?raw';
import enAgentRaw from '../src/shared/i18n/en-US/agent.yaml?raw';
import { translate } from '../src/shared/i18n/useI18n';
import { CHAIN_NODE_CATALOG, CHAIN_NODE_SEGMENTS } from '../src/features/writing/nodeCatalog';
import type { OutcomeCountRow } from '../src/features/writing/chainTimelineView';

function flattenEntries(node: unknown, prefix: string, out: Map<string, unknown>): void {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') flattenEntries(value, path, out);
      else out.set(path, value);
    }
  }
}

function localeEntries(raw: string, root: string): Map<string, unknown> {
  const doc = yaml.load(raw) as Record<string, unknown>;
  const out = new Map<string, unknown>();
  flattenEntries(doc?.[root], '', out);
  return out;
}

const NAMESPACES = [
  { name: 'writing', zh: localeEntries(zhWritingRaw, 'writing'), en: localeEntries(enWritingRaw, 'writing'), floor: 70 },
  { name: 'chain', zh: localeEntries(zhChainRaw, 'chain'), en: localeEntries(enChainRaw, 'chain'), floor: 60 },
  { name: 'agent', zh: localeEntries(zhAgentRaw, 'agent'), en: localeEntries(enAgentRaw, 'agent'), floor: 430 },
] as const;

const nsIndex: Record<string, (typeof NAMESPACES)[number]> = Object.fromEntries(
  NAMESPACES.map((n) => [n.name, n]),
);

describe('写作页 i18n 齐平（zh/en × writing/chain/agent）', () => {
  it('两 locale 键集完全相等（加键漏一侧即红）', () => {
    // W1-W5 交付基线：writing 78 / chain 67 / agent 441（floor = 防整体解析失败静默过）。
    expect(nsIndex.writing.zh.size).toBeGreaterThan(70);
    expect(nsIndex.chain.zh.size).toBeGreaterThan(60);
    expect(nsIndex.agent.zh.size).toBeGreaterThan(430);
    for (const ns of NAMESPACES) {
      expect(
        [...ns.zh.keys()].sort(),
        `${ns.name} 两 locale 键集漂移（zh-only：${[...ns.zh.keys()].filter((k) => !ns.en.has(k)).join(', ')}；en-only：${[...ns.en.keys()].filter((k) => !ns.zh.has(k)).join(', ')}）`,
      ).toEqual([...ns.en.keys()].sort());
    }
  });

  it('所有叶子值均为非空字符串（两 locale）', () => {
    for (const ns of NAMESPACES) {
      for (const [locale, entries] of [['zh-CN', ns.zh], ['en-US', ns.en]] as const) {
        expect(entries.size, `${ns.name}/${locale} 键树为空（yaml 解析失败守门）`).toBeGreaterThan(0);
        for (const [key, value] of entries) {
          expect(typeof value, `${ns.name}/${locale} ${key} 值须为字符串`).toBe('string');
          expect(String(value).trim().length, `${ns.name}/${locale} ${key} 存在空文案值`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('静态消费键全在位（源扫描：features/writing + ReviewPendingNotice + chapterReviewSlice）', () => {
    // 扫描本任务代码里出现的 'writing.*' / 'chain.*' / 'agent.*' 引号字面量（含 t() 三元分支
    // 形态——比只匹配 t( 调用宽，字符串即消费意图）。模板字面量动态键不在此列（下条域枚举）。
    // 定位 ui 包 src 根：import.meta.url 在 vitest 模块运行器下可能非 file: scheme——回退
    // 从 cwd 向上找包根（vitest.config.ts + src/shared/i18n 双标记，--root 调用形态免疫）。
    const resolveSrcRoot = (): string => {
      try {
        const viaUrl = fileURLToPath(new URL('../src', import.meta.url));
        if (existsSync(viaUrl)) return viaUrl;
      } catch { /* fallthrough——非 file: scheme */ }
      let dir = process.cwd();
      for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'vitest.config.ts')) && existsSync(join(dir, 'src/shared/i18n'))) return join(dir, 'src');
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      throw new Error('无法定位 ui 包 src 目录（源扫描）');
    };
    const rootDir = resolveSrcRoot();
    const scanDirs = [join(rootDir, 'features/writing')];
    const scanFiles = [join(rootDir, 'features/agent-panel/ReviewPendingNotice.tsx'), join(rootDir, 'shared/store/chapterReviewSlice.ts')];
    const keyRe = /['"`](writing|chain|agent)\.[A-Za-z0-9_.-]+['"`]/g;
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name.name)) scanFiles.push(p);
      }
    };
    for (const dir of scanDirs) walk(dir);
    for (const file of scanFiles) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(keyRe)) found.add(m[0].slice(1, -1));
    }
    expect(found.size, '源扫描应见到键（0 = 扫描路径/正则失效）').toBeGreaterThan(100);
    const missing: string[] = [];
    for (const key of [...found].sort()) {
      const [nsName, ...rest] = key.split('.');
      const ns = nsIndex[nsName];
      const shortKey = rest.join('.');
      if (!ns) continue; // 非本任务三命名空间的引用不在此守卫（novelChapter.* 等另有归属）
      if (!ns.zh.has(shortKey) || !ns.en.has(shortKey)) missing.push(`${key}（zh:${ns.zh.has(shortKey)} en:${ns.en.has(shortKey)}）`);
    }
    expect(missing, `静态消费键缺 yaml 条目：\n${missing.join('\n')}`).toEqual([]);
  });

  it('动态键域全在位（23 节点表 / 段 / severity / phase / run 状态 / pauseKind / 快捷理由 / 勾选）', () => {
    // 23 节点名表：nodeCatalog 单源 import（对拍 gate 在 test/chainTimeline.test.ts——此处
    // 守 i18n 落值侧；节点数 = 设计常量 23，链序变更时两测试同步红）。
    expect(Object.keys(CHAIN_NODE_CATALOG).length).toBe(23);
    for (const [nodeId, entry] of Object.entries(CHAIN_NODE_CATALOG)) {
      expect(entry.i18nKey, `nodeCatalog ${nodeId} i18nKey 应为 chain.node.<id>`).toBe(`chain.node.${nodeId}`);
      expect(nsIndex.chain.zh.has(`node.${nodeId}`), `chain.node.${nodeId} zh 缺`).toBe(true);
      expect(nsIndex.chain.en.has(`node.${nodeId}`), `chain.node.${nodeId} en 缺`).toBe(true);
    }
    // 段名 + 段说明（CHAIN_NODE_SEGMENTS 派生；说明键 = `<id>Info` 组合形态）。
    for (const { id, i18nKey } of CHAIN_NODE_SEGMENTS) {
      expect(i18nKey).toBe(`chain.segment.${id}`);
      expect(nsIndex.chain.zh.has(`segment.${id}`)).toBe(true);
      expect(nsIndex.chain.en.has(`segment.${id}`)).toBe(true);
      expect(nsIndex.chain.zh.has(`segment.${id}Info`), `chain.segment.${id}Info zh 缺（SegmentHead 说明行）`).toBe(true);
      expect(nsIndex.chain.en.has(`segment.${id}Info`)).toBe(true);
    }
    // severity 词表（mirror chainTimelineView.severityLabel known 集）。
    for (const sev of ['hard', 'soft', 'block', 'warn', 'info', 'missing', 'under-developed']) {
      expect(nsIndex.chain.zh.has(`sev.${sev}`), `chain.sev.${sev} zh 缺`).toBe(true);
      expect(nsIndex.chain.en.has(`sev.${sev}`)).toBe(true);
    }
    // 思考 phase 三层 + 通用/状态词（ReasoningGroup/phaseLabel 消费族）。
    for (const phase of ['research', 'writing', 'declaration', 'other', 'live', 'doneReview']) {
      expect(nsIndex.chain.zh.has(`phase.${phase}`)).toBe(true);
      expect(nsIndex.chain.en.has(`phase.${phase}`)).toBe(true);
    }
    // run 状态 5 值（ChainRunState.status 全集——ChainRunMetaBar 动态拼键）。
    for (const status of ['running', 'paused', 'completed', 'error', 'aborted']) {
      expect(nsIndex.writing.zh.has(`run.status.${status}`)).toBe(true);
      expect(nsIndex.writing.en.has(`run.status.${status}`)).toBe(true);
    }
    // pauseKind 7 值（mirror reviewPhase.ReviewPauseKind——ReviewPhaseView 动态拼键）。
    for (const kind of ['final', 'escalate', 'brief', 'suspension', 'guard', 'draft', 'stub']) {
      expect(nsIndex.writing.zh.has(`review.pauseKind.${kind}`)).toBe(true);
      expect(nsIndex.writing.en.has(`review.pauseKind.${kind}`)).toBe(true);
    }
    // 终稿打回快捷理由 chips 4（FinalReviewCard 硬编码键族）。
    for (let i = 1; i <= 4; i++) {
      expect(nsIndex.writing.zh.has(`review.final.reason${i}`)).toBe(true);
      expect(nsIndex.writing.en.has(`review.final.reason${i}`)).toBe(true);
    }
    // escalate 勾选三态（EscalateAdjudicationCard 动态拼键）。
    for (const pick of ['accept', 'revise', 'ignore']) {
      expect(nsIndex.writing.zh.has(`review.escalate.pick.${pick}`)).toBe(true);
      expect(nsIndex.writing.en.has(`review.escalate.pick.${pick}`)).toBe(true);
    }
    // 终态产物区 outcome metric + unit 键（ChainOutcome 模板拼键 `writing.outcome.${row.metric}`
    // ——静态扫描见不到模板字面量，故入域枚举）。清单 mirror chainTimelineView
    // .OutcomeCountRow 的 metric union（counts 行两值；notes 行是预渲染 line 透传不拼键，
    // 不入域）；unit 键与 metric 一一对应（ChainOutcome 单位行三元，Record 键控补全集）。
    const OUTCOME_COUNT_KEYS: Array<OutcomeCountRow['metric']> = ['worldEvents', 'promises'];
    const OUTCOME_UNIT_BY_METRIC: Record<OutcomeCountRow['metric'], string> = {
      worldEvents: 'unitEvents',
      promises: 'unitItems',
    };
    for (const metric of OUTCOME_COUNT_KEYS) {
      expect(nsIndex.writing.zh.has(`outcome.${metric}`), `writing.outcome.${metric} zh 缺`).toBe(true);
      expect(nsIndex.writing.en.has(`outcome.${metric}`)).toBe(true);
      const unit = OUTCOME_UNIT_BY_METRIC[metric];
      expect(nsIndex.writing.zh.has(`outcome.${unit}`), `writing.outcome.${unit} zh 缺`).toBe(true);
      expect(nsIndex.writing.en.has(`outcome.${unit}`)).toBe(true);
    }
  });

  it('插值占位完整（写作页全部带参键，两 locale）', () => {
    const expectations: Array<[nsName: string, key: string, placeholders: string[]]> = [
      // writing.*
      ['writing', 'run.chapter', ['n', 'title']],
      ['writing', 'run.modelFallback', ['from']],
      ['writing', 'review.final.summaryReasons', ['n']],
      ['writing', 'review.final.loops', ['n']],
      ['writing', 'review.final.loopsCapped', ['n']],
      ['writing', 'review.final.acceptWithEdits', ['n']],
      ['writing', 'review.escalate.itemsCount', ['n']],
      ['writing', 'review.escalate.submitCounts', ['accept', 'revise']],
      // chain.*
      ['chain', 'lap.label', ['n']],
      ['chain', 'lap.summary', ['count', 'decision']],
      ['chain', 'lap.summaryWithReason', ['count', 'decision', 'reason']],
      ['chain', 'thinking.summary', ['n']],
      ['chain', 'tools.summary', ['n']],
      ['chain', 'prose.words', ['n']],
      ['chain', 'artifact.count', ['n']],
      ['chain', 'artifact.truncated', ['total']],
      ['chain', 'artifact.findingsSummary', ['n']],
      ['chain', 'artifact.itemsSummary', ['label', 'n']],
      ['chain', 'artifact.routeSummary', ['decision']],
      ['chain', 'chip.findings', ['hard', 'soft']],
      ['chain', 'chip.findingsHard', ['hard']],
      ['chain', 'chip.findingsSoft', ['soft']],
      // agent.*（本任务 W4/W5 消费面：终稿 toast + 字数）
      ['agent', 'reviewFinalAccepted', ['title']],
      ['agent', 'reviewFinalAcceptedReview', ['title']],
      ['agent', 'reviewWordCount', ['count']],
    ];
    for (const [nsName, key, placeholders] of expectations) {
      const ns = nsIndex[nsName];
      for (const [locale, entries] of [['zh-CN', ns.zh], ['en-US', ns.en]] as const) {
        const value = String(entries.get(key));
        for (const name of placeholders) {
          expect(value, `${nsName}.${key} ${locale} 丢 {${name}} 占位`).toContain(`{${name}}`);
        }
      }
    }
  });
});

describe('translate 冒烟（新 yaml 文件进 eager glob 加载链）', () => {
  it('chain.yaml / writing.yaml 两 locale 可解析（缺键回落裸键名探针）', () => {
    // chain.yaml / writing.yaml 是本任务新增文件——放错目录/解析失败会静默回落裸键名。
    expect(translate('zh-CN', 'chain.node.route-agent')).not.toBe('chain.node.route-agent');
    expect(translate('en-US', 'chain.sev.under-developed')).not.toBe('chain.sev.under-developed');
    expect(translate('zh-CN', 'writing.chapters.title')).not.toBe('writing.chapters.title');
    expect(translate('en-US', 'writing.review.pauseKind.stub')).not.toBe('writing.review.pauseKind.stub');
    expect(translate('zh-CN', 'agent.reviewPendingJump')).not.toBe('agent.reviewPendingJump');
    expect(translate('en-US', 'agent.reviewPendingJump')).not.toBe('agent.reviewPendingJump');
  });
});

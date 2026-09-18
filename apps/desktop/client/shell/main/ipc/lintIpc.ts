/**
 * C1.2 llmlint IPC（design §4 / implement.md Step 7）：全稿静态扫描 + LLM 语境判断 + 机械修复应用。
 *
 * 三 handler（模式 A——稳定 error code，不抛；mirror closureIndexIpc / closureChainIpc 姿态）：
 * - `lint:scan-full`：project.yaml 枚举章正文（mirror runBackfill 章枚举：sections[0].content_file
 *   canonical + 越界跳过防御；跳章入 `skipped` 返回——CR-011 不再静默）→ 逐章引擎全量扫描
 *   （review 不过滤，桶投影归消费侧；章级 try/catch——CR-010 单章抛错不吞前章结果；章间
 *   setImmediate 让路——CR-008 同步引擎循环会占住主进程事件循环）→ aggregateFullReport →
 *   withProjectLock 内落 `.orison/lint/full-report.json`（CR-009，与 apply-fix 刷新同锁纪律）→
 *   返回报告 + 章定位面 + dry-run 机械修复补丁（fixability:auto 仅 2 条规则，D6）+ skipped。
 * - `lint:classify`：**shell 直调模型网关**（D5——不走 agent 派发：全稿 classify 无会话上下文依赖，
 *   mirror visionAnalysis.ts 直调姿态）：resolveTaskModel('review-judge')（agent 包导出单源——
 *   CR-026，与 agentIpc setTaskSlotResolver 注入同一解析函数，不再手写复刻）语义 = taskModels
 *   档位 → 缺省 default 哨兵自动选择 → model-protocols generateText 单次结构化判定（maxTokens
 *   8192 + finishReason 截断检测——CR-012）；输入 = full-report review=agent 桶命中含 density
 *   指纹（projectLintReportForL2 聚合封顶投影——与 L2 prompt 注入同源单源，防漂移；density-only
 *   稿也进 LLM——CR-013）；JSON 解析失败一次重试；解析成功但 verdicts 空/全 unknown = 诚实空
 *   成功（degraded:false 不重试——CR-012）；覆盖不足标 partial；未配置模型/调用失败/无报告 →
 *   {degraded:true, verdicts:[]}（graceful，静态报告独立完整，R3）。
 * - `lint:apply-fix`：输入 = 作者勾选的 LintFixPatch 集（确认流在 UI 报告面——不静默改稿，D6）→
 *   withProjectLock 内逐章**按当前正文重放**确定性修复（projectAutoFixes 幂等重推导——补丁 span 是
 *   扫描时点产物，正文可能在确认前被编辑，绝不作写坐标；文件路径以 project.yaml 为权威，不信
 *   renderer 载荷；章级 try/catch——CR-010 单章失败不吞前章已写结果）→ atomicWrite 写章文件
 *   （mirror acceptChapterCandidate 锁与写法）→ 重扫刷新章账（writeLintChapterLedger 单源，
 *   与 post-settle 同语义）+ full-report 对应章。
 * - `lint:model-probe`（CR-014）：轻量探测「review-judge 档 + resolveModel 是否可解析」——与
 *   classify 同一解析链（resolveTaskModel('review-judge') → 缺省 default 哨兵 → resolveModel），
 *   纯配置解析零网络调用，永不抛（解析失败 → {available:false}）。探测语义单源在 shell：
 *   renderer 侧旧的「任一启用模型」自启发式与 default 哨兵自动选择语义不一致（review-judge
 *   档绑了已禁用模型时旧 probe 仍亮绿灯），已撤。
 * - 章文件读取（scan-full / apply-fix）：decodeFileToUtf8 编码探测读（CR-003——project:read-file
 *   同款；中文 .txt 常 GBK，盲读 utf-8 产 mojibake，apply-fix 重写会把 U+FFFD 永久写回）；
 *   写回恒 UTF-8（修后自然归整）。
 *
 * 范式判据（ADR-3）：枚举/聚合/落盘/重放 = 纯代码机械；命中真假与修复方向 = 语义，归 classify LLM
 * 通道或作者确认——本文件静态部分永不产语义结论。
 *
 * rulesets 生产路径：vendored 引擎默认 `import.meta.url` 解析在 bundle 下指向 `dist/rulesets`
 * ——由 electron.vite.config.ts lintRulesetsCopyPlugin 静态拷贝兜住（vendor README「已知注意点」）。
 */
import { ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  LintApplyFixChapterResult,
  LintApplyFixResult,
  LintChapterFile,
  LintClassifyResult,
  LintFixPatch,
  LintFullReport,
  LintModelProbeResult,
  LintScanFullResult,
  LintSkippedChapter,
} from '@orison/shared-contracts';
import {
  lintFixPatchSchema,
  lintFullReportSchema,
} from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import {
  aggregateFullReport,
  assignmentFallbackChain,
  assignmentThinkingControl,
  getLintEngine,
  projectLintReportForL2,
  resolveTaskModel,
  writeLintChapterLedger,
} from '@orison/desktop-agent';
import { readModelConfigFromDisk } from './configIpc';
import { handleGenerateText, ModelResolutionError, resolveModel } from './modelGatewayIpc';
import { assertSafePath } from './pathGuard';
import { decodeFileToUtf8 } from '../fs/decodeText';
import { withProjectLock } from '../fs/projectWriteLock';
import { getLogger } from '../logger';

/** 全稿报告落盘路径（单源——scan-full 写 / classify 与 apply-fix 读刷新共用）。 */
function lintFullReportPath(projectPath: string): string {
  return path.join(projectPath, '.orison', 'lint', 'full-report.json');
}

/** project.yaml 章结构最小子集（novel.chapters[] 元素；mirror runBackfill 的 Landable 读取）。 */
interface LandableChapterLike {
  id?: unknown;
  title?: unknown;
  sections?: Array<{ content_file?: unknown }>;
}

/** enumerateChapterFiles 产物：可扫章定位面 + 跳章清单（CR-011——跳章不再静默）。 */
interface EnumeratedChapters {
  chapters: LintChapterFile[];
  skipped: LintSkippedChapter[];
}

/**
 * 枚举已落盘章正文（mirror workflow.ts runBackfill 章枚举）：novel.chapters →
 * sections[0].content_file（canonical 单 section 规范——producer（acceptChapterCandidateCore）只写
 * sections[0]，reader 对齐；多 section 章**跟随先例只扫 sections[0]**，多余 section 计入
 * skipped + warn——CR-011，不自作主张拼接）；越界（路径穿越）与未落盘（文件不存在）章跳过 +
 * warn（不崩）。每类跳章同时入 skipped 返回（UI 后续消费，reason 码契约见 LintSkippedChapter）。
 */
function enumerateChapterFiles(
  projectPath: string,
  doc: Record<string, unknown>,
): EnumeratedChapters {
  const novel = (doc as { novel?: { chapters?: unknown } }).novel;
  const chapters = Array.isArray(novel?.chapters) ? (novel!.chapters as LandableChapterLike[]) : [];
  const resolvedProject = path.resolve(projectPath);
  const out: LintChapterFile[] = [];
  const skipped: LintSkippedChapter[] = [];
  for (const chapter of chapters) {
    const chapterId = typeof chapter?.id === 'string' ? chapter.id : undefined;
    if (!chapterId || chapterId.length === 0) {
      skipped.push({ chapterId: 'unknown', reason: 'no-content-file', note: 'chapter id missing' });
      continue;
    }
    const contentFile =
      typeof chapter?.sections?.[0]?.content_file === 'string'
        ? chapter.sections[0].content_file
        : undefined;
    if (!contentFile || contentFile.length === 0) {
      skipped.push({ chapterId, reason: 'no-content-file' });
      continue;
    }
    const resolvedContent = path.resolve(resolvedProject, contentFile);
    const withinProject =
      resolvedContent === resolvedProject || resolvedContent.startsWith(resolvedProject + path.sep);
    if (!withinProject) {
      getLogger().warn(
        { projectPath, contentFile, chapterId },
        'lintIpc: content_file escapes project dir → skip chapter',
      );
      skipped.push({ chapterId, reason: 'escapes-project-dir' });
      continue;
    }
    if (!existsSync(resolvedContent)) {
      // 未落盘章（R2「含未完成章」= 有正文文件的章）
      skipped.push({ chapterId, reason: 'not-landed' });
      continue;
    }
    // 多 section 章：跟随 batch 先例只扫 sections[0]；多余带正文的 section 计入 skipped + warn
    // （作者可见有内容未扫，非静默丢弃；拼接改口径属产品决策，超出 CR-011 授权范围）。
    const extraSections = (chapter.sections ?? [])
      .slice(1)
      .filter((s) => typeof s?.content_file === 'string' && s.content_file.length > 0);
    if (extraSections.length > 0) {
      getLogger().warn(
        { projectPath, chapterId, extraSections: extraSections.length },
        'lintIpc: multi-section chapter → scanning sections[0] only (batch precedent; extras recorded as skipped)',
      );
      skipped.push({
        chapterId,
        reason: 'multi-section',
        note: `${extraSections.length} extra section(s) with content_file not scanned`,
      });
    }
    out.push({
      chapterId,
      title: typeof chapter.title === 'string' && chapter.title.length > 0 ? chapter.title : chapterId,
      filePath: resolvedContent,
    });
  }
  return { chapters: out, skipped };
}

/**
 * 全稿报告落盘（mkdir + 原子写，mirror lintLedger 写法）。
 *
 * 🔒 锁纪律（CR-009）：**调用方负责 withProjectLock**——scan-full 独占获取（与 apply-fix 的
 * 章文件写/报告刷新同锁串行，防并发写留 stale 报告）；apply-fix 路径已在既有锁内直调本函数
 * （withProjectLock 不可重入——锁内再取锁会死锁）。
 */
function persistFullReport(projectPath: string, report: LintFullReport): void {
  const filePath = lintFullReportPath(projectPath);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
}

/**
 * 章间让路一拍（CR-008）：ipcMain.handle 的 async handler 跑在 Electron 主进程事件循环上——
 * 「IPC 异步」只免除 renderer 阻塞，主进程同步引擎循环仍占住事件循环（其余 IPC / 窗口事件
 * 全部排队）。每章处理后 setImmediate 让路一拍，多章全稿扫描期间应用保持可响应。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ── lint:classify prompt + 解析（D5：shell 直调单次结构化判定）──

/** 裁判系统 prompt（中文编辑角色；静态命中不定罪——真假判断是 LLM 职责，范式判据）。 */
const LINT_CLASSIFY_SYSTEM_PROMPT = [
  '你是一名严格的中文小说编辑，负责审查静态 lint 工具的命中清单。',
  '静态规则只定位「疑似 AI 味文字痕迹」，不判断真假——结合引文样例判断真阳比例与修复方向是你的职责。',
  '对每个规则组：结合引文样例判断该组命中中真阳（确属 AI 味/机械文风问题，而非作者有意为之的风格或误报）的比例，输出 0 到 1 的小数（truePositiveRatio）。',
  '用一句中文给出修复方向（note）：真阳组说明怎么改；基本误报的组说明为何是误报。',
  '只输出一个 JSON 对象，不要任何其他文字，不要 Markdown 代码块：',
  '{"verdicts":[{"ruleId":"<规则id>","truePositiveRatio":0.0,"note":"..."}]}',
  'verdicts 必须覆盖输入清单中的每一个规则组，不得编造清单外的规则 id。',
].join('\n');

/** JSON 解析失败一次重试时的追加提示（design §4：解析失败重试一次，非调用失败重试）。 */
const LINT_CLASSIFY_RETRY_NUDGE =
  '上一次回复无法解析为 JSON。请重新输出，且只输出 JSON 对象本身（不要代码块围栏、不要解释文字）。';

/** classify 降级结果（R3：未配置模型/调用失败/无报告——静态报告独立完整）。 */
const LINT_CLASSIFY_DEGRADED: LintClassifyResult = { verdicts: [], degraded: true };

/** classify 输出预算（CR-012：4096 对 25 规则组 verdict + note 会截断；8192 留足余量）。 */
const LINT_CLASSIFY_MAX_TOKENS = 8192;

/**
 * 解析 classify 输出（剥代码围栏 → 取首尾大括号 → JSON.parse → 逐项校验）。
 * 幻觉防线：只收 knownRuleIds 内的 verdict（清单外 ruleId 丢弃）；比例夹取 [0,1]。
 *
 * 返回值三态（CR-012）：
 * - `null` = **不可解析**（无 JSON / 非对象 / verdicts 非数组）→ caller 决定重试/降级；
 * - `{ verdicts: [] }` = **解析成功但零有效 verdict**（模型诚实空判 / 全部 ruleId 幻觉被滤）
 *   → 诚实空成功（degraded:false），**不重试**——重试一个已成功解析的输出是误重试；
 * - `{ verdicts: [...] }` = 正常结果。
 */
function parseClassifyVerdicts(
  text: string,
  knownRuleIds: Set<string>,
): { verdicts: LintClassifyResult['verdicts'] } | null {
  const stripped = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(raw)) return null;
  const verdicts: LintClassifyResult['verdicts'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as { ruleId?: unknown; truePositiveRatio?: unknown; note?: unknown };
    if (typeof v.ruleId !== 'string' || !knownRuleIds.has(v.ruleId)) continue;
    const ratio = Number(v.truePositiveRatio);
    if (!Number.isFinite(ratio)) continue;
    verdicts.push({
      ruleId: v.ruleId,
      truePositiveRatio: Math.min(1, Math.max(0, ratio)),
      note: typeof v.note === 'string' ? v.note : '',
    });
  }
  return { verdicts };
}

/** callLintClassify 结果三态：成功 / 可重试（仅 JSON 不可解析）/ 终态失败（调用失败/截断）。 */
type ClassifyCallResult =
  | { kind: 'ok'; verdicts: LintClassifyResult['verdicts'] }
  | { kind: 'unparseable' }
  | { kind: 'terminal' };

/** 单次 classify 调用（ref 驱动——经网关环入口 handleGenerateText，链/无链同路）。 */
async function callLintClassify(
  ref: import('@orison/shared-contracts').ModelRef,
  userPrompt: string,
  knownRuleIds: Set<string>,
  withRetryNudge: boolean,
  thinking?: import('@orison/shared-contracts').ThinkingControl,
  fallbacks?: Array<import('@orison/shared-contracts').GenerateFallbackEntry>,
  /** CR-19：降级日志上下文（原预检 try/catch 持有的 projectPath 随预检撤除移入本参）。 */
  projectPath?: string,
): Promise<ClassifyCallResult> {
  const messages = [
    { role: 'system' as const, content: LINT_CLASSIFY_SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: withRetryNudge ? `${userPrompt}\n\n${LINT_CLASSIFY_RETRY_NUDGE}` : userPrompt,
    },
  ];
  let text: string;
  let finishReason: unknown;
  try {
    // 09-12 子2（复核 H1 重接）：classify 直调面改经网关环入口（in-process handleGenerateText）
    // ——无链快径字节级现行为；配链时 review-judge 档回退链生效。resolveModel 上移进环
    //（per-attempt 解析，配置腐化可跳家）。
    const response = await handleGenerateText({
      ref,
      request: {
        model: ref.modelId,
        messages,
        temperature: 0.2,
        maxTokens: LINT_CLASSIFY_MAX_TOKENS,
        // 09-12 usage-panel：lint 语境判断 = review-judge 档（与路由同 slot 名，design §0 表）。
        taskType: 'review-judge',
        // S4c（task 08-25 design「lintIpc review-judge 同链」）：思考策略随档——agent 链的
        // review-judge 档节点经 assignmentThinkingControl 归一注入，本直调面同链同源；
        // 未配 → undefined 不带字段 = auto（字节级不变）。
        ...(thinking ? { thinking } : {}),
      },
      ...(fallbacks?.length ? { fallbacks } : {}),
    });
    text = response.text ?? '';
    finishReason = (response as { finishReason?: unknown }).finishReason;
  } catch (err) {
    // CR-19（09-12 子2 CR 批）：「没配模型」distinct 降级日志收编到失败点——预检已撤
    //（原预检 resolveModel 结果丢弃 + 双解析双读盘 TOCTOU），ModelResolutionError
    //（resolveModel 的纯配置失败类型：键删/模型缺失/禁用/缺凭据）在此甄别同一条
    // distinct 日志路径，语义与原预检等价（resolveModel 在环入口同步抛，零网络）。
    if (err instanceof ModelResolutionError) {
      getLogger().warn(
        { err: err.message, projectPath },
        'lintIpc classify: no model resolvable (review-judge slot / auto-pick) → degraded',
      );
    } else {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'lintIpc classify: generateText failed → degraded',
      );
    }
    // design §4：重试只针对 JSON 解析，调用失败直接降级。
    return { kind: 'terminal' };
  }
  // 截断检测（CR-012）：finishReason 'length' = 输出被 maxTokens 切断——即便残余恰好拼出合法
  // JSON 也不可信（verdicts 可能只覆盖前半清单）。同输入重跑无意义 → 终态 degraded（不重试）。
  if (finishReason === 'length') {
    getLogger().warn(
      { finishReason, textChars: text.length },
      'lintIpc classify: output truncated by token limit → degraded (raise maxTokens or shrink findings)',
    );
    return { kind: 'terminal' };
  }
  const parsed = parseClassifyVerdicts(text, knownRuleIds);
  return parsed ? { kind: 'ok', verdicts: parsed.verdicts } : { kind: 'unparseable' };
}

export function registerLintIpc(): void {
  // ── lint:scan-full（R2 全稿扫描）──
  ipcMain.handle(
    'lint:scan-full',
    async (_, input: { projectPath?: string }): Promise<LintScanFullResult> => {
      const projectPath = typeof input?.projectPath === 'string' ? input.projectPath : '';
      if (!projectPath) return { ok: false, error: 'no-project' };
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'operation-failed', message: `projectPath rejected: ${msg}` };
      }

      let doc: Record<string, unknown> | null;
      try {
        const { loadProject } = await import('@orison/desktop-local-bff');
        doc = loadProject(projectPath) as Record<string, unknown> | null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        getLogger().error({ err: msg, projectPath }, 'lintIpc scan-full: loadProject threw');
        return { ok: false, error: 'operation-failed', message: `loadProject failed: ${msg}` };
      }
      if (!doc) {
        return {
          ok: false,
          error: 'project-not-found',
          message: `project.yaml at ${projectPath} could not be loaded (corrupt or missing)`,
        };
      }

      const engine = await getLintEngine();
      if (!engine) {
        return { ok: false, error: 'engine-unavailable', message: 'lint rulesets load failed' };
      }

      // 枚举 + 逐章扫描。引擎同步纯函数会占住主进程事件循环——每章处理后让路一拍（CR-008），
      // 其余章级异常全部章内 try/catch 兜住（CR-010 模式 A：单章失败入 skipped，不吞前章结果、
      // handler 永不 reject）。
      const enumerated = enumerateChapterFiles(projectPath, doc);
      const chapterFiles = enumerated.chapters;
      const skipped: LintSkippedChapter[] = [...enumerated.skipped];
      const chapterReports: LintFullReport['chapters'] = [];
      const fixPatches: LintFixPatch[] = [];
      for (const chapter of chapterFiles) {
        let text: string;
        try {
          // CR-003 编码探测读（project:read-file 同款）：盲读 utf-8 会把 GBK/UTF-16/BOM 章读成
          // mojibake，且 apply-fix 重写会把 U+FFFD 永久固化进正文。
          text = decodeFileToUtf8(readFileSync(chapter.filePath));
        } catch (err) {
          getLogger().warn(
            { err: err instanceof Error ? err.message : String(err), chapterId: chapter.chapterId },
            'lintIpc scan-full: chapter prose unreadable → skip',
          );
          skipped.push({ chapterId: chapter.chapterId, reason: 'unreadable' });
          continue;
        }
        try {
          chapterReports.push(engine.scanText(text, { chapterId: chapter.chapterId }));
          // dry-run 机械修复投影（fixability:auto；不落盘——应用归 lint:apply-fix + 作者确认，D6）。
          const projection = engine.projectAutoFixes({
            text,
            chapterId: chapter.chapterId,
            filePath: chapter.filePath,
          });
          fixPatches.push(...projection.patches);
        } catch (err) {
          getLogger().warn(
            { err: err instanceof Error ? err.message : String(err), chapterId: chapter.chapterId },
            'lintIpc scan-full: chapter scan threw → skip chapter (prior chapters kept)',
          );
          skipped.push({ chapterId: chapter.chapterId, reason: 'scan-failed' });
        }
        await yieldToEventLoop();
      }

      const report = aggregateFullReport(chapterReports);
      try {
        // CR-009 锁纪律：与 apply-fix 的章文件写/报告刷新同锁串行（防并发留 stale 报告）。
        await withProjectLock(projectPath, () => {
          persistFullReport(projectPath, report);
        });
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err), projectPath },
          'lintIpc scan-full: full-report persist failed (report still returned; rescan rebuilds)',
        );
      }
      getLogger().info(
        {
          projectPath,
          chapters: report.stats.chapters,
          total: report.stats.total,
          high: report.stats.high,
          fixPatches: fixPatches.length,
          skipped: skipped.length,
        },
        'lintIpc scan-full: scan completed',
      );
      return { ok: true, report, chapterFiles, fixPatches, skipped };
    },
  );

  // ── lint:classify（R3 LLM 语境判断，可选增强——降级不阻塞）──
  ipcMain.handle(
    'lint:classify',
    async (_, input: { projectPath?: string }): Promise<LintClassifyResult> => {
      const projectPath = typeof input?.projectPath === 'string' ? input.projectPath : '';
      if (!projectPath) return LINT_CLASSIFY_DEGRADED;
      try {
        assertSafePath(projectPath);
      } catch {
        return LINT_CLASSIFY_DEGRADED;
      }

      // 读最近一次全稿扫描产物（classify 是扫描后的跟进动作；无报告 = 无可判对象 → degraded）。
      let report: LintFullReport | null = null;
      try {
        const raw = readFileSync(lintFullReportPath(projectPath), 'utf-8');
        const parsed = lintFullReportSchema.safeParse(JSON.parse(raw));
        if (parsed.success) report = parsed.data;
      } catch {
        // 缺文件/坏 JSON → 下方 report null 分支统一 degraded
      }
      if (!report) {
        getLogger().info(
          { projectPath },
          'lintIpc classify: no full-report on disk → degraded (run a scan first)',
        );
        return LINT_CLASSIFY_DEGRADED;
      }

      // agent 桶跨章合并 → 聚合封顶投影（projectLintReportForL2 单源——与 L2 prompt 注入同口径，
      // 25 规则/3 引文/40 字上限防 prompt 膨胀；投影内再过滤 review==='agent' 是防御）。
      const merged = {
        issues: report.chapters.flatMap((c) => c.issues),
        densityIssues: report.chapters.flatMap((c) => c.densityIssues),
      };
      const projection = projectLintReportForL2(merged);
      if (
        !projection ||
        (projection.findings.length === 0 && projection.densityIssues.length === 0)
      ) {
        // 无 agent 桶命中且无密度指纹 = 无可判对象（诚实空，非降级——LLM 通道未失败）。
        // CR-013：空判据含 density——density-only 稿（零 issue 命中但密度超标）同样有可判对象。
        return { verdicts: [], degraded: false };
      }

      // 模型解析（C3.2 任务档语义，CR-026 单源）：resolveTaskModel = agent 包导出的 slot 解析
      // 函数（agentIpc setTaskSlotResolver 注入同一函数——手写复刻已撤，防语义 drift）。
      // review-judge 档显式配置优先；缺档/未注入 resolver → undefined → default 哨兵 →
      // resolveModel 自动选择（首个启用模型）。
      // S4c：assignment 单次解析——ref 与思考策略同源（thinking 未配 → undefined = auto）。
      // 09-12 子2：ref + 回退链透传给环入口（callLintClassify 内 handleGenerateText）。
      // CR-19（09-12 子2 CR 批）：可用性预检撤除——原预检跑完整 resolveModel 后丢弃结果
      //（双解析 + 双读盘 TOCTOU）；真实解析在环内 per-attempt 权威进行，「没配模型」的
      // distinct 降级日志改由失败点按 ModelResolutionError 甄别（callLintClassify catch），
      // 语义等价且零二次解析。
      const assignment = resolveTaskModel('review-judge');
      const classifyRef = assignment ?? { keyId: 'default', modelId: 'default' };
      const classifyThinking = assignmentThinkingControl(assignment);
      const classifyFallbacks = assignmentFallbackChain(assignment);

      // 幻觉防线白名单含 density 规则 id（CR-013：density-only 稿的 verdict 不被当幻觉丢弃）。
      const knownRuleIds = new Set([
        ...projection.findings.map((f) => f.ruleId),
        ...projection.densityIssues.map((d) => d.ruleId),
      ]);
      const userPrompt = [
        '以下是静态 lint 工具在全稿扫描中的命中清单（按规则聚合，含去重引文样例）与密度指纹。',
        '',
        JSON.stringify({
          findings: projection.findings,
          densityIssues: projection.densityIssues,
          truncated: projection.truncated,
        }),
        '',
        '请按系统指令逐规则组输出 verdicts JSON（清单与密度指纹中的每个规则 id 都须覆盖）。',
      ].join('\n');

      // 单次判定；仅 **不可解析** 一次重试（design §4——重试只针对 JSON 解析；调用失败/截断
      // 是终态失败，同输入重跑无意义，直接降级）。
      let outcome = await callLintClassify(classifyRef, userPrompt, knownRuleIds, false, classifyThinking, classifyFallbacks, projectPath);
      if (outcome.kind === 'unparseable') {
        outcome = await callLintClassify(classifyRef, userPrompt, knownRuleIds, true, classifyThinking, classifyFallbacks, projectPath);
      }
      if (outcome.kind !== 'ok') {
        getLogger().warn(
          { projectPath, outcome: outcome.kind },
          'lintIpc classify: no usable output (unparseable after retry / call failed / truncated) → degraded',
        );
        return LINT_CLASSIFY_DEGRADED;
      }
      if (outcome.verdicts.length === 0) {
        // CR-012：解析成功但零有效 verdict（诚实空判/全部 ruleId 幻觉被滤）= 诚实空成功——
        // 不重试（重试已成功解析的输出是误重试）、不降级（LLM 通道未失败）。
        getLogger().info(
          { projectPath, knownRuleIds: knownRuleIds.size },
          'lintIpc classify: parsed with zero valid verdicts → honest empty',
        );
        return { verdicts: [], degraded: false };
      }
      // 覆盖不足标记（CR-012）：verdicts 非空但未覆盖全部输入规则组 → partial=true（additive）。
      const covered = new Set(outcome.verdicts.map((v) => v.ruleId));
      const partial = [...knownRuleIds].some((id) => !covered.has(id));
      getLogger().info(
        { projectPath, verdicts: outcome.verdicts.length, known: knownRuleIds.size, partial },
        'lintIpc classify: verdicts parsed',
      );
      return {
        verdicts: outcome.verdicts,
        degraded: false,
        ...(partial ? { partial: true } : {}),
      };
    },
  );

  // ── lint:apply-fix（R4 机械修复——确认流后的应用，不静默改稿）──
  // patches 校验用 lintFixPatchSchema.array().min(1)（schema 方法组合——shell 无 zod 直依赖，
  // schema 单源在 shared-contracts，mirror closureChainIpc 复用 shared schema 的姿态）。
  const applyFixPatchesSchema = lintFixPatchSchema.array().min(1);
  ipcMain.handle(
    'lint:apply-fix',
    async (_, input: unknown): Promise<LintApplyFixResult> => {
      const projectPath =
        input && typeof (input as { projectPath?: unknown }).projectPath === 'string'
          ? (input as { projectPath: string }).projectPath
          : '';
      if (!projectPath) return { ok: false, error: 'no-project' };
      const parsedPatches = applyFixPatchesSchema.safeParse(
        (input as { patches?: unknown } | null)?.patches,
      );
      if (!parsedPatches.success) {
        return {
          ok: false,
          error: 'invalid-patches',
          message: parsedPatches.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        };
      }
      const patches: LintFixPatch[] = parsedPatches.data;
      try {
        assertSafePath(projectPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'operation-failed', message: `projectPath rejected: ${msg}` };
      }

      const engine = await getLintEngine();
      if (!engine) {
        return { ok: false, error: 'engine-unavailable', message: 'lint rulesets load failed' };
      }

      let doc: Record<string, unknown> | null;
      try {
        const { loadProject } = await import('@orison/desktop-local-bff');
        doc = loadProject(projectPath) as Record<string, unknown> | null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'operation-failed', message: `loadProject failed: ${msg}` };
      }
      if (!doc) {
        return { ok: false, error: 'project-not-found' };
      }

      // 文件路径权威源 = project.yaml（renderer 载荷里的 filePath 只是扫描时点信息，不作写坐标）。
      const chapterFileById = new Map(
        enumerateChapterFiles(projectPath, doc).chapters.map((cf) => [cf.chapterId, cf]),
      );
      // 按章分组（勾选粒度 = 章——确认弹层列章与条数；引擎重放按章全量确定性修复）。
      const patchesByChapter = new Map<string, LintFixPatch[]>();
      for (const patch of patches) {
        const bucket = patchesByChapter.get(patch.chapterId);
        if (bucket) bucket.push(patch);
        else patchesByChapter.set(patch.chapterId, [patch]);
      }

      try {
        return await withProjectLock(projectPath, async (): Promise<LintApplyFixResult> => {
          const results: LintApplyFixChapterResult[] = [];
          const rescanned = new Map<string, LintFullReport['chapters'][number]>();
          for (const [chapterId, chapterPatches] of patchesByChapter) {
            const chapter = chapterFileById.get(chapterId);
            if (!chapter) {
              results.push({
                chapterId,
                filePath: chapterPatches[0]!.filePath,
                changes: 0,
                written: false,
                note: 'chapter-not-found',
              });
              continue;
            }
            // 章级 try/catch 全覆盖（CR-010 模式 A）：单章任何抛错（读/重放/写/重扫）只落该章
            // result（note 标因），前章已写结果照常返回，handler 永不 reject。
            try {
              let text: string;
              try {
                // CR-003 编码探测读（scan-full 同款；写回恒 UTF-8——修后自然归整）。
                text = decodeFileToUtf8(readFileSync(chapter.filePath));
              } catch (err) {
                getLogger().warn(
                  { err: err instanceof Error ? err.message : String(err), chapterId },
                  'lintIpc apply-fix: chapter prose unreadable → skip',
                );
                results.push({
                  chapterId,
                  filePath: chapter.filePath,
                  changes: 0,
                  written: false,
                  note: 'unreadable',
                });
                continue;
              }
              // 幂等重放：按当前正文重推导确定性修复（正文可能在扫描后被编辑）。
              const projection = engine.projectAutoFixes({
                text,
                chapterId,
                filePath: chapter.filePath,
              });
              if (!projection.changed) {
                results.push({
                  chapterId,
                  filePath: chapter.filePath,
                  changes: 0,
                  written: false,
                  note: 'nothing-to-fix',
                });
                continue;
              }
              try {
                atomicWriteFileSync(chapter.filePath, projection.fixedText, 'utf-8');
              } catch (err) {
                getLogger().warn(
                  { err: err instanceof Error ? err.message : String(err), chapterId },
                  'lintIpc apply-fix: chapter write failed → skip',
                );
                results.push({
                  chapterId,
                  filePath: chapter.filePath,
                  changes: 0,
                  written: false,
                  note: 'write-failed',
                });
                continue;
              }
              // 章账刷新（writeLintChapterLedger 单源——last-write-wins + graceful，与 post-settle 同语义）。
              await writeLintChapterLedger({ projectPath, chapterId, text: projection.fixedText });
              try {
                rescanned.set(chapterId, engine.scanText(projection.fixedText, { chapterId }));
              } catch (err) {
                getLogger().warn(
                  { err: err instanceof Error ? err.message : String(err), chapterId },
                  'lintIpc apply-fix: rescan failed (full-report entry left stale)',
                );
              }
              results.push({
                chapterId,
                filePath: chapter.filePath,
                changes: projection.patches.length,
                written: true,
              });
            } catch (err) {
              getLogger().warn(
                { err: err instanceof Error ? err.message : String(err), chapterId },
                'lintIpc apply-fix: chapter-level error → skip chapter (prior chapters kept)',
              );
              results.push({
                chapterId,
                filePath: chapter.filePath,
                changes: 0,
                written: false,
                note: 'chapter-error',
              });
            }
          }

          // full-report 对应章刷新（有 full-report 才刷新；无 = 从未全稿扫描，跳过）。
          if (rescanned.size > 0) {
            try {
              const raw = readFileSync(lintFullReportPath(projectPath), 'utf-8');
              const parsedReport = lintFullReportSchema.safeParse(JSON.parse(raw));
              if (parsedReport.success) {
                const refreshed = parsedReport.data.chapters.map(
                  (chapterReport) => rescanned.get(chapterReport.chapterId) ?? chapterReport,
                );
                // CR-018：generatedAt 语义 = 最后一次**全稿扫描**时间——apply-fix 刷新只换章
                // 数据，不冒充新扫描（aggregateFullReport 会盖当前时刻，须以原值为准）。
                const refreshedReport = aggregateFullReport(refreshed);
                persistFullReport(projectPath, {
                  ...refreshedReport,
                  generatedAt: parsedReport.data.generatedAt,
                });
              }
            } catch (err) {
              getLogger().warn(
                { err: err instanceof Error ? err.message : String(err), projectPath },
                'lintIpc apply-fix: full-report refresh failed (chapter ledgers already written)',
              );
            }
          }

          getLogger().info(
            { projectPath, chapters: results.length, written: results.filter((r) => r.written).length },
            'lintIpc apply-fix: fixes applied',
          );
          return { ok: true, results };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        getLogger().error({ err: msg, projectPath }, 'lintIpc apply-fix: failed');
        return { ok: false, error: 'operation-failed', message: msg };
      }
    },
  );

  // ── lint:model-probe（CR-014：语境判断模型可用性探测——shell 单源）──
  // 与 lint:classify 的模型解析同链（resolveTaskModel('review-judge') → 缺省 default 哨兵 →
  // resolveModel），纯配置解析零网络调用。解析成功即 available——真连通性由 classify 自身
  // 的 graceful degraded 兜底（R3），probe 只回答「按钮该不该亮」。
  ipcMain.handle('lint:model-probe', (): LintModelProbeResult => {
    try {
      const config = readModelConfigFromDisk();
      const ref = resolveTaskModel('review-judge') ?? { keyId: 'default', modelId: 'default' };
      resolveModel(ref, config);
      return { available: true };
    } catch {
      return { available: false };
    }
  });
}

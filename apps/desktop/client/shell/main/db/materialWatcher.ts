/**
 * Story 10.1 Wave C：materials/ 双车道 watcher（design §4.3 / prd R7）。
 *
 * 两形态（lane 差异仅在看守目录与前缀映射，核心逻辑共享一套 factory）：
 * - 项目车道 `<project>/materials/`：**看守项目目录**（非 materials/ 本身——mirror
 *   settingMdWatcher：atomicWrite 原子 rename 破坏单文件 watch；看守项目目录还能捕获
 *   会话中途创建的 materials/ 目录），事件按 `materials/` 前缀过滤。接线走 projectIpc
 *   `project:watch` / `project:unwatch`（F-10——与 assetCards/settingMd/chapterChunk 三
 *   先例同生命周期：项目开 start / 切换/关 stop + will-quit 清理，泄漏守卫同款）。
 * - 全局车道 `~/.orison/materials/`：craftKbWatcher 全局形态（看守材料根本身，目录缺席
 *   则建空目录；main/index.ts whenReady 启动扫描 + start，will-quit stop）。
 *
 * 事件路由（扩展名白名单 `.txt/.md/.markdown/.docx/.pdf/.epub`，shell 侧强制不信上层）：
 * - **dot 首段通用过滤（CR-013，'.derived' 除外）**——`.orison/history` 删除快照写盘、编辑器
 *   锁文件（`.#foo.txt` 等带白名单扩展的 dot 文件）不再依赖「materials/ 前缀」单层巧合兜底，
 *   路由层直接拦下零入队；'.derived' 维持重索引路由。
 * - 原件事件 → registerMaterial（完整管线：解析→质量诊断→分章→派生 .md→登记→索引）。
 * - `materials/.derived/`（或全局 `.derived/`）下 **.md 变更 → 重索引不重解析**（AC4 校对
 *   路径：章标记是文件层真相源，reindexMaterial 经 parseChapterMarkers 取新章界；零解析
 *   = docx/pdf/端点全免）。derived 相对路径 → materialId 解析经登记行匹配（db 掉了/未登记
 *   → 留给 backfill 自愈，跳过不报错）。
 * - 非 .md 的 .derived 内容（临时文件等）忽略；filename 不可用（null，rename 类平台省略）
 *   → 保守整车道 backfill（宁多扫不漏进件，mirror settingMd F7）。
 *
 * 🔑 F-12 自写双事件声明：先例（assetCards/settingMd/craftKb/chapterChunk）的前提「indexer
 * 从不写被监目录」被材料管线打破——ingest 写派生 .md 进被监树，watcher 会看到**原件 +
 * 派生**双事件。正确性依据（三道闸）：①`.derived` 路径路由到重索引（不重跑 ingest——不
 * 产新写入，事件链终止）；②重索引 hash-skip 吸收同内容重跑（registerMaterial 内部触发的
 * reindex 与派生事件触发的 reindex 收敛为一次 embed）；③Wave B ingest 对内容逐字一致的
 * 派生 .md 跳过写盘（materialIngest 第 7 步）——校对未变时的 watcher 噪声自吸收。
 * 测试 materialWatcher.test.ts 含双事件用例钉死收敛。
 *
 * Linux 递归 watch 不可用 / 瞬时失败 → 降级启动扫描 + 手动重摄取（mirror 家族）。
 */
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  MATERIAL_ALLOWED_EXTENSIONS,
} from '../ipc/toolHandlers/materialIngest';
import {
  backfillGlobalMaterials,
  backfillProjectMaterials,
  derivedRelPathForMaterial,
  getGlobalMaterialsRoot,
  listMaterialRowsForLane,
  registerMaterial,
  reindexMaterial,
  resolveMaterialLane,
  type MaterialSummaryRow,
} from './materialIndexer';
import { watchDir, type DirWatcher } from '../fs/watchFactory';
import { assertSafePath } from '../ipc/pathGuard';
import { getLogger } from '../logger';
import { sendMaterialChanged } from '../ipc/materialNotify';

/** Coalesce rapid events (editor bursts / 批量拷贝) into one flush。 */
const DEBOUNCE_MS = 500;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface LaneWatcherConfig {
  lane: () => { scope: 'project'; projectDir: string } | { scope: 'global' };
  /** 看守目录。 */
  watchedDir: () => string;
  /** 看守目录相对事件路径 → materials 根内相对路径；null = 与本车道无关。 */
  toRelInMaterials: (watchedRel: string) => string | null;
  /** 目录缺席时建空目录（全局车道 mirror craftKbWatcher；项目车道看守项目目录不建）。 */
  ensureDir: boolean;
  /** filename 不可用时的保守 backfill。 */
  runBackfill: () => Promise<unknown>;
  logLabel: string;
}

function makeLaneWatcher(cfg: LaneWatcherConfig): { start: () => void; stop: () => void } {
  let activeWatcher: DirWatcher | null = null;
  let activeDir: string | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  const pendingRegister = new Set<string>();
  const pendingReindexDerived = new Set<string>();
  let pendingBackfill = false;

  function schedule(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush().catch((err) => {
        // trailing catch belt（mirror 家族）：per-item 已吞错，此处兜未预期形态。
        getLogger().warn({ err: errMsg(err) }, `${cfg.logLabel}: debounced flush failed - continuing`);
      });
    }, DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    const lane = cfg.lane();
    // 广播事件基（Wave D F-23 收尾接线）：watcher 驱动的变更与 IPC 面同走 material:changed，
    // UI 列表实时刷新（reason 映射：register 成功→reingested——不用 imported，避免误增 UI
    // 导入进度计数；orphaned→deleted；重索引/backfill→reindexed）。lane 不可解析（项目未注册）
    // → 静默跳过广播，写路径不受影响。
    const resolvedLane = resolveMaterialLane(lane);
    const notifyBase = resolvedLane
      ? { scope: resolvedLane.scope, projectId: resolvedLane.projectId }
      : null;
    const registerRels = [...pendingRegister];
    pendingRegister.clear();
    const derivedRels = [...pendingReindexDerived];
    pendingReindexDerived.clear();
    const doBackfill = pendingBackfill;
    pendingBackfill = false;

    for (const rel of registerRels) {
      try {
        const result = await registerMaterial(lane, rel);
        if (notifyBase !== null && result.materialId !== undefined) {
          if (result.outcome === 'registered' || result.outcome === 'reused') {
            sendMaterialChanged({ ...notifyBase, materialId: result.materialId, reason: 'reingested' });
          } else if (result.outcome === 'orphaned') {
            sendMaterialChanged({ ...notifyBase, materialId: result.materialId, reason: 'deleted' });
          }
        }
      } catch (err) {
        getLogger().warn({ err: errMsg(err), rel }, `${cfg.logLabel}: register failed - continuing`);
      }
    }
    if (derivedRels.length > 0) {
      // derived 相对路径 → 登记行匹配（同 stem 异扩展镜像冲突形态：多行命中 → 全部重索引，
      // hash-skip 吸收；未登记/坏行 → 跳过留给 backfill 自愈）。摘要投影行（CR-033——derived
      // 路由只消费 materialId + provenance.sourcePath + scope/projectId 面）。
      let rows: MaterialSummaryRow[] = [];
      try {
        rows = listMaterialRowsForLane(lane);
      } catch (err) {
        getLogger().warn({ err: errMsg(err) }, `${cfg.logLabel}: derived routing enumerate failed`);
      }
      for (const drel of derivedRels) {
        for (const row of rows) {
          if (derivedRelPathForMaterial(row) !== drel) continue;
          try {
            await reindexMaterial(row.materialId);
            sendMaterialChanged({
              scope: row.scope,
              projectId: row.projectId,
              materialId: row.materialId,
              reason: 'reindexed',
            });
          } catch (err) {
            getLogger().warn(
              { err: errMsg(err), materialId: row.materialId },
              `${cfg.logLabel}: derived-triggered reindex failed - continuing`,
            );
          }
        }
      }
    }
    if (doBackfill) {
      try {
        await cfg.runBackfill();
        if (notifyBase !== null) {
          // scope 级事件（无 materialId）：保守 backfill 后的整列表刷新信号。
          sendMaterialChanged({ ...notifyBase, reason: 'reindexed' });
        }
      } catch (err) {
        getLogger().warn({ err: errMsg(err) }, `${cfg.logLabel}: conservative backfill failed - continuing`);
      }
    }
  }

  return {
    start() {
      const dir = path.resolve(cfg.watchedDir());
      if (activeDir === dir && activeWatcher) return; // 幂等（同目录重复 start）
      stopInternal();
      if (cfg.ensureDir && !existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch (err) {
          getLogger().warn(
            { err: errMsg(err), dir },
            `${cfg.logLabel}: cannot create materials dir - skipping watch`,
          );
          return;
        }
      }
      try {
        activeWatcher = watchDir(dir, (_event, filename) => {
          if (filename === null) {
            pendingBackfill = true; // 平台省略 filename（rename 类）→ 保守整车道扫描
            schedule();
            return;
          }
          const rel = cfg.toRelInMaterials(filename.replace(/\\/g, '/'));
          if (rel === null) return;
          const firstSeg = rel.split('/')[0]!;
          // CR-013：dot 首段通用过滤（'.derived' 除外）——.orison/history 快照写盘、编辑器
          // 锁文件（.#foo.txt 等带白名单扩展的 dot 文件）在路由层直接拦下零入队，不再依赖
          // 项目车道「materials/ 前缀」单层巧合兜底（全局车道看守根本身，无该巧合可用）。
          if (firstSeg.startsWith('.') && firstSeg !== '.derived') return;
          if (firstSeg === '.derived') {
            if (rel.toLowerCase().endsWith('.md')) {
              pendingReindexDerived.add(rel);
              schedule();
            }
            return;
          }
          const ext = path.posix.extname(rel).toLowerCase();
          if ((MATERIAL_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
            pendingRegister.add(rel);
            schedule();
          }
        });
        activeDir = dir;
        activeWatcher.on('error', (err) => {
          getLogger().warn({ err: errMsg(err), dir }, `${cfg.logLabel} watcher error`);
          stopInternal();
        });
        getLogger().info({ dir }, `${cfg.logLabel} started`);
      } catch (err) {
        // Linux 递归 watch 不可用 / 瞬时失败 → 降级启动扫描 + 手动重摄取（mirror 家族）。
        getLogger().warn(
          { err: errMsg(err), dir },
          `${cfg.logLabel} unavailable - startup/backfill scan + manual reingest still work`,
        );
        activeWatcher = null;
        activeDir = null;
      }
    },
    stop: stopInternal,
  };

  function stopInternal(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingRegister.clear();
    pendingReindexDerived.clear();
    pendingBackfill = false;
    if (activeWatcher) {
      try {
        activeWatcher.close();
      } catch {
        // ignore close errors
      }
      activeWatcher = null;
    }
    activeDir = null;
  }
}

// ── 项目车道（project:watch / project:unwatch 接线；re-point = 先 stop 再 start）──

let projectLaneDir: string | null = null;

const projectLaneWatcher = makeLaneWatcher({
  lane: () => ({ scope: 'project', projectDir: projectLaneDir ?? '' }),
  watchedDir: () => projectLaneDir ?? '',
  toRelInMaterials: (watchedRel) =>
    watchedRel.startsWith('materials/') ? watchedRel.slice('materials/'.length) : null,
  ensureDir: false,
  runBackfill: () => backfillProjectMaterials(projectLaneDir ?? ''),
  logLabel: 'material watcher (project)',
});

/** 项目车道看守开始（project:watch 挂点；同项目幂等，切换项目 re-point 旧句柄）。 */
export function startProjectMaterialWatcher(projectDir: string): void {
  assertSafePath(projectDir);
  projectLaneDir = projectDir;
  projectLaneWatcher.start();
}

/** 项目车道看守停止（project:unwatch + will-quit 挂点——泄漏守卫，清 pending debounce）。 */
export function stopProjectMaterialWatcher(): void {
  projectLaneDir = null;
  projectLaneWatcher.stop();
}

// ── 全局车道（main/index.ts whenReady 启动 + will-quit 清理，craftKbWatcher 全局形态）──

const globalLaneWatcher = makeLaneWatcher({
  lane: () => ({ scope: 'global' }),
  watchedDir: () => getGlobalMaterialsRoot(),
  toRelInMaterials: (watchedRel) => watchedRel,
  ensureDir: true,
  runBackfill: () => backfillGlobalMaterials(),
  logLabel: 'material watcher (global)',
});

/** 全局车道看守开始（app 启动挂点；幂等）。 */
export function startGlobalMaterialWatcher(): void {
  globalLaneWatcher.start();
}

/** 全局车道看守停止（will-quit 挂点）。 */
export function stopGlobalMaterialWatcher(): void {
  globalLaneWatcher.stop();
}

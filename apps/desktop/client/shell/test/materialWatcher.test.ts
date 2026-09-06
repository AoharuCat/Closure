/**
 * Story 10.1 Wave C：materialWatcher（双车道）测试——mirror chapterChunkWatcher.test.ts 形态：
 * indexer mock（registerMaterial/reindexMaterial/backfill 捕获调用——本体在
 * materialIndexer.test.ts 真跑锚定）；事件源经 watchFactory 注入缝合成；debounce + 路由 +
 * 生命周期走真实实现（真定时器 waitFor 等 debounce 窗）。
 *
 * 覆盖：触发面（原件白名单 / .derived .md 重索引路由〔AC4〕/ 非白名单忽略 / null filename
 * 保守 backfill）/ **F-12 双事件用例**（原件 + 自写派生 .md 同窗 → register 一次 + reindex
 * 一次，不循环）/ debounce 合并 / stop 生命周期 / **CR-013 dot 首段通用过滤**（.orison/
 * history 快照、.git、编辑器锁文件零入队）。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TMP 每测唯一（mkdtemp，残留 tmpdir 交系统清理）。
const tmpBox = vi.hoisted(() => ({ dir: '' }));
let TMP = '';

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => tmpBox.dir,
    isPackaged: false,
  },
}));

const {
  registerMaterial,
  reindexMaterial,
  listMaterialRowsForLane,
  backfillGlobalMaterials,
  backfillProjectMaterials,
} = vi.hoisted(() => ({
  registerMaterial: vi.fn(
    async (_lane: unknown, _rel: string) => ({ outcome: 'registered', materialId: 'mat-registered' }),
  ),
  reindexMaterial: vi.fn(async (_materialId: string) => ({ outcome: 'written', chunkCount: 1 })),
  listMaterialRowsForLane: vi.fn((_lane: unknown) => [] as Array<{ materialId: string; provenance: { sourcePath: string } }>),
  backfillGlobalMaterials: vi.fn(async () => ({ registered: 0, skipped: 0, orphaned: 0 })),
  backfillProjectMaterials: vi.fn(async (_projectDir: string) => ({ registered: 0, skipped: 0, orphaned: 0 })),
}));

// materialNotify mock（Wave D 收尾接线断言面）：sendMaterialChanged spy。
const { sendMaterialChanged } = vi.hoisted(() => ({ sendMaterialChanged: vi.fn() }));
vi.mock('../main/ipc/materialNotify', () => ({ sendMaterialChanged }));

// materialIndexer mock：register/reindex/backfill spy + derived 路由的取数面。derivedRelPathForMaterial
// 用真实映射逻辑（strip materials/ 前缀 → .derived/<stem>.md），钉 watcher 路由与登记行匹配。
vi.mock('../main/db/materialIndexer', () => ({
  registerMaterial,
  reindexMaterial,
  listMaterialRowsForLane,
  backfillGlobalMaterials,
  backfillProjectMaterials,
  getGlobalMaterialsRoot: () => path.join(tmpBox.dir, 'materials'),
  resolveMaterialLane: (lane: { scope: string; projectDir?: string }) =>
    lane.scope === 'global'
      ? { scope: 'global', materialsRoot: path.join(tmpBox.dir, 'materials'), projectId: null }
      : {
          scope: 'project',
          materialsRoot: path.join(lane.projectDir ?? '', 'materials'),
          projectId: 'proj-test',
        },
  derivedRelPathForMaterial: (m: { provenance: { sourcePath: string } }) => {
    const rel = m.provenance.sourcePath.replace(/^materials\//, '');
    const stem = rel.replace(/\.[^.]+$/, '');
    const dir = stem.includes('/') ? stem.slice(0, stem.lastIndexOf('/')) : '';
    const base = stem.slice(dir === '' ? 0 : dir.length + 1);
    return dir === '' ? `.derived/${base}.md` : `.derived/${dir}/${base}.md`;
  },
  // 以下导出本测试不消费，mock 完整性（import 面存在即可）。
  getMaterialRow: vi.fn(),
  listMaterialRows: vi.fn(),
  upsertMaterialRow: vi.fn(),
  deleteMaterialRows: vi.fn(),
  relInMaterialsOfSourcePath: vi.fn(),
  materialChapterRef: (id: string, i: number) => `${id}.ch${i}`,
  materialEntryId: (p: string, id: string, i: number, n: number) => `${p}:${id}.ch${i}#c${n}`,
  materialChunkCraftId: (id: string, i: number, n: number) => `mat:${id}.ch${i}#c${n}`,
  MATERIAL_SOURCE_KIND: 'material',
  MATERIAL_CHUNK_SOURCE_KIND: 'material_chunk',
  MATERIAL_EMBED_BATCH_SIZE: 32,
}));

import { allowPath } from '../main/ipc/pathGuard';
import {
  startGlobalMaterialWatcher,
  startProjectMaterialWatcher,
  stopGlobalMaterialWatcher,
  stopProjectMaterialWatcher,
} from '../main/db/materialWatcher';
import { setWatchFactory, type WatchFn } from '../main/fs/watchFactory';

// ── fake watch 源（注入缝）：捕获 watcher 注册的回调，测试合成事件驱动 ──

interface FakeHandle {
  cb: (event: string, filename: string | null) => void;
  closed: boolean;
}
const fakeWatches: { dir: string; handle: FakeHandle }[] = [];

const fakeWatchFn: WatchFn = (dir, cb) => {
  const handle: FakeHandle = { cb, closed: false };
  fakeWatches.push({ dir, handle });
  return {
    close() {
      handle.closed = true;
    },
    on() {
      // fake 源不产 error 事件。
    },
  };
};

function emitWatchEvent(dir: string, filename: string | null): void {
  let sawClosedHandle = false;
  for (let i = fakeWatches.length - 1; i >= 0; i -= 1) {
    const w = fakeWatches[i]!;
    if (path.resolve(w.dir) !== path.resolve(dir)) continue;
    if (w.handle.closed) {
      sawClosedHandle = true;
      continue;
    }
    w.handle.cb('change', filename);
    return;
  }
  if (!sawClosedHandle) {
    throw new Error(
      `emitWatchEvent: 目录从未注册活句柄（${dir}）——先 start 再 emit；目录拼错或时序错，负向断言疑似空洞`,
    );
  }
}

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForCalls(spy: { mock: { calls: unknown[][] } }, n: number, timeoutMs = 5000) {
  const start = Date.now();
  while (spy.mock.calls.length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${n} calls (got ${spy.mock.calls.length})`);
    }
    await tick(50);
  }
}

/** 登记行 fixture（watcher 只读 materialId + provenance.sourcePath 两个面）。 */
function row(materialId: string, sourcePath: string) {
  return { materialId, provenance: { sourcePath } };
}

describe('materialWatcher（Story 10.1 Wave C，双车道）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TMP = tmpBox.dir = mkdtempSync(path.join(os.tmpdir(), 'material-watcher-'));
    allowPath(TMP);
    stopProjectMaterialWatcher();
    stopGlobalMaterialWatcher();
    fakeWatches.length = 0;
    setWatchFactory(fakeWatchFn);
  });
  afterEach(() => {
    stopProjectMaterialWatcher();
    stopGlobalMaterialWatcher();
    setWatchFactory(null);
    fakeWatches.length = 0;
  });

  it('项目车道原件事件（白名单扩展）→ registerMaterial(project lane, rel)', async () => {
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, 'materials/novel.txt');
    emitWatchEvent(TMP, 'materials/sub/depth.pdf');
    await waitForCalls(registerMaterial, 2);
    expect(registerMaterial).toHaveBeenCalledWith({ scope: 'project', projectDir: TMP }, 'novel.txt');
    expect(registerMaterial).toHaveBeenCalledWith({ scope: 'project', projectDir: TMP }, 'sub/depth.pdf');
  });

  it('全局车道原件事件 → registerMaterial(global lane, rel)', async () => {
    startGlobalMaterialWatcher();
    const globalRoot = path.join(TMP, 'materials'); // mock 的 getGlobalMaterialsRoot
    emitWatchEvent(globalRoot, '讲义.epub');
    await waitForCalls(registerMaterial, 1);
    expect(registerMaterial).toHaveBeenCalledWith({ scope: 'global' }, '讲义.epub');
  });

  it('.derived .md 变更 → 重索引路由（登记行匹配；不重摄取——AC4 校对路径）', async () => {
    listMaterialRowsForLane.mockReturnValue([
      row('mat-aaaaaaaaaaaa', 'materials/novel.txt'), // → .derived/novel.md
      row('mat-bbbbbbbbbbbb', 'materials/other.md'), // → .derived/other.md
    ] as never);
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, 'materials/.derived/novel.md');
    await waitForCalls(reindexMaterial, 1);
    expect(reindexMaterial).toHaveBeenCalledWith('mat-aaaaaaaaaaaa');
    expect(registerMaterial).not.toHaveBeenCalled(); // 🔑 重索引不重解析
  });

  it('F-12 双事件用例：原件 + 自写派生 .md 同窗 → register 一次 + reindex 一次（收敛不循环）', async () => {
    // registerMaterial 落登记后，派生 .md 写盘事件随之而来（同 debounce 窗）。
    registerMaterial.mockImplementation(async () => {
      listMaterialRowsForLane.mockReturnValue([row('mat-cccccccccccc', 'materials/foo.txt')] as never);
      return { outcome: 'registered', materialId: 'mat-cccccccccccc' };
    });
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, 'materials/foo.txt'); // 用户拷入原件
    await waitForCalls(registerMaterial, 1);
    emitWatchEvent(TMP, 'materials/.derived/foo.md'); // ingest 自写派生（F-12 自写双事件）
    await waitForCalls(reindexMaterial, 1);
    expect(reindexMaterial).toHaveBeenCalledTimes(1); // 路由到重索引（非再摄取 → 链终止）
    expect(registerMaterial).toHaveBeenCalledTimes(1);
    // 窗内不再有新触发（无循环）：等过 debounce 窗 + 余量。
    await tick(900);
    expect(registerMaterial).toHaveBeenCalledTimes(1);
    expect(reindexMaterial).toHaveBeenCalledTimes(1);
  });

  it('F-23 收尾接线：watcher 变更广播 material:changed（register→reingested / derived 重索引→reindexed）', async () => {
    // 自持实现（F-12 用例的 mockImplementation 跨测存续——clearAllMocks 只清调用记录）。
    registerMaterial.mockImplementation(async () => ({ outcome: 'registered', materialId: 'mat-registered' }));
    listMaterialRowsForLane.mockReturnValue([
      { ...row('mat-aaaaaaaaaaaa', 'materials/novel.txt'), scope: 'project', projectId: 'proj-test' },
    ] as never);
    startProjectMaterialWatcher(TMP);
    // ① 原件事件 → register 成功（hoisted 默认 outcome=registered/mat-registered）→ 广播 reingested。
    emitWatchEvent(TMP, 'materials/novel.txt');
    await waitForCalls(sendMaterialChanged, 1);
    expect(sendMaterialChanged).toHaveBeenCalledWith({
      scope: 'project',
      projectId: 'proj-test',
      materialId: 'mat-registered',
      reason: 'reingested',
    });
    // ② 派生 .md 编辑（AC4 校对路径）→ 重索引 → 广播 reindexed（row 携带 scope/projectId）。
    emitWatchEvent(TMP, 'materials/.derived/novel.md');
    await waitForCalls(reindexMaterial, 1);
    await waitForCalls(sendMaterialChanged, 2);
    expect(sendMaterialChanged).toHaveBeenLastCalledWith({
      scope: 'project',
      projectId: 'proj-test',
      materialId: 'mat-aaaaaaaaaaaa',
      reason: 'reindexed',
    });
  });

  it('同 stem 异扩展镜像冲突：derived 事件命中多行 → 全部重索引（hash-skip 吸收面）', async () => {
    listMaterialRowsForLane.mockReturnValue([
      row('mat-dddddddddddd', 'materials/foo.txt'),
      row('mat-eeeeeeeeeeee', 'materials/foo.md'),
    ] as never);
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, 'materials/.derived/foo.md');
    await waitForCalls(reindexMaterial, 2);
    const ids = reindexMaterial.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['mat-dddddddddddd', 'mat-eeeeeeeeeeee']);
  });

  it('filename 不可用（null，rename 类平台省略）→ 保守整车道 backfill', async () => {
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, null);
    await waitForCalls(backfillProjectMaterials, 1);
    expect(backfillProjectMaterials).toHaveBeenCalledWith(TMP);
    expect(registerMaterial).not.toHaveBeenCalled();
  });

  it('null filename 在全局车道 → backfillGlobalMaterials', async () => {
    startGlobalMaterialWatcher();
    const globalRoot = path.join(TMP, 'materials');
    emitWatchEvent(globalRoot, null);
    await waitForCalls(backfillGlobalMaterials, 1);
  });

  it('非白名单 / .derived 非 .md / 项目车道非 materials 前缀：零触发', async () => {
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, 'materials/archive.zip');
    emitWatchEvent(TMP, 'materials/.derived/tmp');
    emitWatchEvent(TMP, 'chapters/ch_001.md'); // 章正文（chapterChunk watcher 的面）
    emitWatchEvent(TMP, 'settings/magic.md'); // 设定散文（settingMd watcher 的面）
    await tick(900); // 过 debounce 窗 + 余量
    expect(registerMaterial).not.toHaveBeenCalled();
    expect(reindexMaterial).not.toHaveBeenCalled();
    expect(backfillProjectMaterials).not.toHaveBeenCalled();
  });

  it('CR-013：dot 首段通用过滤——.orison/history 快照 / .git / 编辑器锁文件零入队', async () => {
    startProjectMaterialWatcher(TMP);
    // 删除快照写盘（D8 四清的 .orison/history 兜底——项目车道看守项目目录，事件直达本 watcher）。
    emitWatchEvent(TMP, '.orison/history/materials%2Fnovel.txt.1690000000000.txt');
    // materials/ 内 dot 目录（项目车道 materials/ 前缀通过，唯一防线就是 dot 首段过滤）。
    emitWatchEvent(TMP, 'materials/.git/objects.txt');
    // 编辑器锁文件（白名单扩展 .txt 的 dot 文件——extname('.#novel.txt')='.txt' 会过白名单）。
    emitWatchEvent(TMP, 'materials/.#novel.txt');
    emitWatchEvent(TMP, 'materials/.DS_Store/novel.txt');
    await tick(900);
    expect(registerMaterial).not.toHaveBeenCalled();
    expect(reindexMaterial).not.toHaveBeenCalled();
    expect(backfillProjectMaterials).not.toHaveBeenCalled();
  });

  it('debounce 合并：同窗多原件 → 窗后一次 flush 全量处理', async () => {
    startProjectMaterialWatcher(TMP);
    emitWatchEvent(TMP, 'materials/a.txt');
    emitWatchEvent(TMP, 'materials/b.docx');
    emitWatchEvent(TMP, 'materials/c.md');
    await tick(250); // debounce 窗内：尚未 flush
    expect(registerMaterial).not.toHaveBeenCalled();
    await waitForCalls(registerMaterial, 3);
    const rels = registerMaterial.mock.calls.map((c) => (c[1] as string)).sort();
    expect(rels).toEqual(['a.txt', 'b.docx', 'c.md']);
  });

  it('stop 后不再触发（生命周期）+ 项目切换 re-point 旧句柄关闭', async () => {
    const projectA = path.join(TMP, 'project-a');
    const projectB = path.join(TMP, 'project-b');
    allowPath(projectA);
    allowPath(projectB);
    startProjectMaterialWatcher(projectA);
    startProjectMaterialWatcher(projectB); // 切换：A 停、B 起
    emitWatchEvent(projectA, 'materials/x.txt');
    emitWatchEvent(projectB, 'materials/y.txt');
    await waitForCalls(registerMaterial, 1);
    expect(registerMaterial).toHaveBeenCalledWith({ scope: 'project', projectDir: projectB }, 'y.txt');
    expect(registerMaterial.mock.calls.map((c) => c[1])).not.toContain('x.txt');

    stopProjectMaterialWatcher();
    emitWatchEvent(projectB, 'materials/z.txt');
    await tick(900);
    expect(registerMaterial).toHaveBeenCalledTimes(1);
  });

  it('全局 stop 后不再触发', async () => {
    startGlobalMaterialWatcher();
    const globalRoot = path.join(TMP, 'materials');
    stopGlobalMaterialWatcher();
    emitWatchEvent(globalRoot, 'later.txt');
    await tick(900);
    expect(registerMaterial).not.toHaveBeenCalled();
  });
});

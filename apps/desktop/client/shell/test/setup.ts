// worker 拆卸崩溃病根兜底——DB 句柄显式 close + 终结器排干（08-29 vitest 4 迁移专项 S1）：
// 每个测试文件收尾时关闭 main/db 模块级单例句柄（closeDb 含 sqlite-vec 扩展态
// 复位），随后强制 GC——两段合起来把 better-sqlite3 ObjectWrap 的析构确定性
// 挪到 env 活着时执行，压掉 worker 拆卸期的原生崩彩票（node ObjectWrap 拆卸
// 回归 nodejs/node#65195 家族：任何在 env 死后析构的 wrapper 都会撞
// `RemoveEnvironmentCleanupHook (env) != nullptr` 断言 abort）。
//
// 动态 import 放 afterAll 内（非顶层静态 import）：几乎每个 shell 测试文件先
// vi.mock('electron', ...) 再 import '../main/db/index'——setup 静态 import 会先以
// 未 mock 的 electron（app=undefined）把 db/index 钉进模块缓存，而 vi.mock 不作用于
// 已缓存模块 → 该文件全部 getDb() 调用崩掉。afterAll 时点解析到测试已加载的同一单例。
//
// 容错（10 文件 vi.mock 掉整个 db/index 不导 closeDb 的形态）：mock 模块无真句柄
// 可关——typeof 守卫 + try/catch 静默跳过，不为兜底钩子本身制造 suite 级红。
//
// 运行时启 gc：--expose-gc 对 worker_threads 的 execArgv 非法（node 直接
// ERR_WORKER_INVALID_EXEC_ARGV），改用 v8.setFlagsFromString + vm 新上下文取回
// （node 官方 trick，threads/forks 两池通用）。失败则静默 no-op。
import { afterAll, afterEach } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { _resetBreakerForTest } from '../main/ipc/circuitBreaker';

// CR-18（c3-2 CR 批）：熔断进程内态全局兜底复位——fallback loop 族测试故意打 eligible
// 失败（429/503/timeout），不复位会在套件 <60s 窗内跨用例累计到阈值中途 open，制造
// 顺序依赖红。circuitBreaker.ts 是零依赖纯模块，静态 import 不踩 setup 注释里的
// electron/db mock 缓存坑；各测试文件自己的 per-case reset 保留（双保险），新增制造
// eligible 失败的测试文件无需再自行接线。
afterEach(() => {
  _resetBreakerForTest();
});

// better-sqlite3 加载探针（dogfood R2 #101②）：Electron ABI 构建的 binding 在
// plain-Node vitest 下加载失败 → shell 的真 db 测试套件整族 skip——此前这个
// skip 完全静默，撞 ABI 的开发者无从知道「为什么全 skip」。此横幅只 warn 不
// fail：plain-Node 全 skip 是既定合法形态（Electron 真跑法另立，见
// spec/core/testing-discipline.md），skip 语义不变。错误文本原样带出：加载错误
// 自带双方 NODE_MODULE_VERSION 号（二进制按 X 编译 / 当前运行时要 Y），无需
// 也不建 Electron↔ABI 映射表（硬编码表每升 Electron 就烂）。⚠ 输出走
// process.stderr.write 而非 console.warn：vitest 4 默认 silent:'passed-only'
// 会把 console.* 拦截吞进通过的测试，横幅就看不见了（探针=可见性，绕开拦截）。
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  // 去重：vitest 4 threads 池 + isolation 给每个测试文件独立 worker（实测
  // worker id 1..N，无跨文件进程内状态），裸打会每文件一条横幅（本机全量
  // ~120 条刷屏）。只让 worker 1 打 + env 标记兜底 worker 复用形态；env 无
  // VITEST_WORKER_ID 时退化为纯 env 标记（宁可重复刷屏，不可横幅静默死）。
  const workerId = process.env.VITEST_WORKER_ID;
  const isFirstWorker = workerId === undefined || workerId === '1';
  if (isFirstWorker && !process.env.ORISON_SQLITE3_ABI_PROBE_WARNED) {
    process.env.ORISON_SQLITE3_ABI_PROBE_WARNED = '1';
    process.stderr.write(
      '\n⚠ better-sqlite3 在当前运行时加载失败——shell 的真 db 测试套件将整族 skip。\n' +
        `  错误：${err instanceof Error ? err.message : err}\n` +
        '  跑测试用 node ABI：pnpm rebuild -r better-sqlite3\n' +
        '  跑应用用 Electron ABI：pnpm rebuild:native\n',
    );
  }
}

try {
  v8.setFlagsFromString('--expose_gc');
  (globalThis as { gc?: () => void }).gc = vm.runInNewContext('gc') as () => void;
} catch {
  // 运行时启 gc 失败（V8 版本面变化等）——兜底降级为无 gc
}

afterAll(async () => {
  try {
    const mod = (await import('../main/db/index')) as { closeDb?: () => void };
    if (typeof mod.closeDb === 'function') mod.closeDb();
  } catch {
    // mock 形态解析失败——无真句柄，无物可关
  }
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
  }
});

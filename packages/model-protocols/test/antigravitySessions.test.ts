import { describe, expect, it } from 'vitest';
import {
  AgySessionPool,
  AgyFakeHomeCollisionError,
  agySessionKeyId,
  DEFAULT_AGY_PROCESS_CAP,
  createCliAbortError,
} from '../src/antigravityCli/sessions';
import { fakePoolEnv, type FakePoolEnv } from './antigravityCliFakes';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const SPEC = { executable: 'agy', args: ['--input-format', 'stream-json'] };

function makePool(env: FakePoolEnv, opts?: { cap?: number; idleTtlMs?: number; sweepIntervalMs?: number }) {
  return new AgySessionPool(env.deps, opts);
}

describe('antigravityCli sessions（进程池，design §3.1）', () => {
  it('同键 turn 串行：busy 排队，先完后再进（官方红线：等 result 再写下一行）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's1', keyId: 'k1', modelId: 'm1' };
    const gate = deferred<void>();
    const order: string[] = [];

    const p1 = pool.runTurn(key, SPEC, undefined, async () => {
      order.push('t1-start');
      await gate.promise;
      order.push('t1-end');
      return 'r1';
    });
    await flush();
    expect(order).toEqual(['t1-start']);

    const p2 = pool.runTurn(key, SPEC, undefined, async () => {
      order.push('t2-start');
      return 'r2';
    });
    await flush();
    // t1 未完：t2 不得进入。
    expect(order).toEqual(['t1-start']);

    gate.resolve();
    expect(await p1).toBe('r1');
    expect(await p2).toBe('r2');
    expect(order).toEqual(['t1-start', 't1-end', 't2-start']);
    // 同键复用同一进程（零重 spawn）。
    expect(env.spawns).toHaveLength(1);
    pool.dispose();
  });

  it('并发帽 + idle LRU 逐出：满帽时逐出最旧 idle（绝不杀在途）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env, { cap: 2 });
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();

    const p1 = pool.runTurn({ sessionKey: 'a', keyId: 'k', modelId: 'm' }, SPEC, undefined, () => gate1.promise);
    const p2 = pool.runTurn({ sessionKey: 'b', keyId: 'k', modelId: 'm' }, SPEC, undefined, () => gate2.promise);
    await flush();
    expect(env.spawns).toHaveLength(2);

    // 第三键：全表 busy → 排队不 spawn。
    const p3 = pool.runTurn({ sessionKey: 'c', keyId: 'k', modelId: 'm' }, SPEC, undefined, async (s) => {
      await s.writeLine('{"event":"user"}');
      return 'r3';
    });
    await flush();
    expect(env.spawns).toHaveLength(2);

    // 释放 b → b 转 idle（表内）→ c 唤醒：逐出 idle b（LRU）→ spawn c。
    gate2.resolve();
    expect(await p2).toBeUndefined();
    expect(await p3).toBe('r3');
    expect(env.spawns).toHaveLength(3);
    // b 的进程被优雅关停（close stdin）；a 的在途进程绝不被杀/关。
    expect(env.spawns[1]!.stdinEnded).toBe(true);
    expect(env.spawns[1]!.killed).toBe(false);
    expect(env.spawns[0]!.stdinEnded).toBe(false);
    gate1.resolve();
    await p1;
    pool.dispose();
  });

  it('LRU 只看 idle 集：busy 进程 lastUsedAt 更旧也不被逐出（复核 H1）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env, { cap: 2 });
    const gateBusy = deferred<void>();

    // a 先开跑（busy，lastUsedAt 较旧）。
    const pa = pool.runTurn({ sessionKey: 'a', keyId: 'k', modelId: 'm' }, SPEC, undefined, () => gateBusy.promise);
    await flush();
    env.advanceNow(50_000); // a 的 lastUsedAt 停在 50s 前

    // b 完成一次短 turn（idle，lastUsedAt 较新）。
    await pool.runTurn({ sessionKey: 'b', keyId: 'k', modelId: 'm' }, SPEC, undefined, async () => 'rb');
    expect(env.spawns).toHaveLength(2);

    // c 到来满帽 → 逐出候选只能是 idle 的 b（不是更旧的 busy a）。
    const pc = pool.runTurn({ sessionKey: 'c', keyId: 'k', modelId: 'm' }, SPEC, undefined, async () => 'rc');
    expect(await pc).toBe('rc');
    expect(env.spawns).toHaveLength(3);
    expect(env.spawns[0]!.stdinEnded).toBe(false); // busy a 未被动
    expect(env.spawns[0]!.killed).toBe(false);
    expect(env.spawns[1]!.stdinEnded).toBe(true); // idle b 被逐出
    gateBusy.resolve();
    await pa;
    pool.dispose();
  });

  it('默认并发帽 = 3（导出常量）', () => {
    expect(DEFAULT_AGY_PROCESS_CAP).toBe(3);
    expect(agySessionKeyId({ sessionKey: 's', keyId: 'k', modelId: 'm' })).toBe('s::k::m');
  });

  it('idle TTL 清扫：超时 idle 会话被优雅关停出表，busy 永不清扫', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env, { idleTtlMs: 1000, sweepIntervalMs: 500 });
    await pool.runTurn({ sessionKey: 's', keyId: 'k', modelId: 'm' }, SPEC, undefined, async () => 'r');
    expect(env.spawns).toHaveLength(1);
    expect(pool['entries'].size).toBe(1); // idle 留存

    // 未超时清扫：无事发生。
    env.advanceNow(500);
    env.fireTimers();
    expect(env.spawns[0]!.stdinEnded).toBe(false);

    // 超时清扫：优雅关停 + 出表。
    env.advanceNow(600);
    env.fireTimers();
    expect(env.spawns[0]!.stdinEnded).toBe(true);
    expect(pool['entries'].size).toBe(0);
    expect(env.removedDirs).toContain(env.spawns[0]!.spawnArgs.cwd);

    // 下次调用 → 冷启动新进程。
    await pool.runTurn({ sessionKey: 's', keyId: 'k', modelId: 'm' }, SPEC, undefined, async () => 'r2');
    expect(env.spawns).toHaveLength(2);
    pool.dispose();
  });

  it('会话作废：invalidate → kill + 出表，下次冷启动新进程', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    await pool.runTurn(key, SPEC, undefined, async (session) => {
      session.invalidate('test');
      return 'r';
    });
    expect(env.spawns[0]!.killed).toBe(true);
    expect(pool['entries'].size).toBe(0);
    await pool.runTurn(key, SPEC, undefined, async () => 'r2');
    expect(env.spawns).toHaveLength(2);
    pool.dispose();
  });

  it('fn 抛非 abort 错且进程存活：会话保留（idle 复用，不无谓重启）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    await expect(
      pool.runTurn(key, SPEC, undefined, async () => {
        throw new Error('model error');
      }),
    ).rejects.toThrow('model error');
    // 会话保留：同键下一 turn 复用同进程。
    await pool.runTurn(key, SPEC, undefined, async (session) => {
      await session.writeLine('line');
      return 'ok';
    });
    expect(env.spawns).toHaveLength(1);
    expect(env.spawns[0]!.writtenLines).toEqual(['line']);
    pool.dispose();
  });

  it('abort × 队列（复核 M6）：排队中被 abort → AbortError 上抛，不 spawn 不占位', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env, { cap: 1 });
    const gate = deferred<void>();
    const p1 = pool.runTurn({ sessionKey: 'a', keyId: 'k', modelId: 'm' }, SPEC, undefined, () => gate.promise);
    await flush();

    const controller = new AbortController();
    const p2 = pool.runTurn({ sessionKey: 'b', keyId: 'k', modelId: 'm' }, SPEC, controller.signal, async () => 'never');
    await flush();
    expect(env.spawns).toHaveLength(1); // 排队不 spawn

    controller.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.spawns).toHaveLength(1); // 未占位未 spawn

    gate.resolve();
    await p1;
    pool.dispose();
  });

  it('在途 turn abort → 作废会话（kill + 出表）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const controller = new AbortController();
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    const p = pool.runTurn(key, SPEC, controller.signal, async () => {
      controller.abort();
      throw createCliAbortError();
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.spawns[0]!.killed).toBe(true);
    expect(pool['entries'].size).toBe(0);
    pool.dispose();
  });

  it('restart（分歧冷重启）：原位换新进程 + 镜像清空，旧进程优雅关停', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    let seenAfterRestart: readonly string[] | undefined;
    await pool.runTurn(key, SPEC, undefined, async (session) => {
      expect(session.seenHashes).toEqual([]);
      session.commitSeenHashes(['h1', 'h2']);
      expect(session.seenHashes).toEqual(['h1', 'h2']);
      await session.restart();
      seenAfterRestart = session.seenHashes;
      return 'ok';
    });
    expect(seenAfterRestart).toEqual([]);
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.stdinEnded).toBe(true); // 旧进程优雅关停
    expect(env.spawns[0]!.killed).toBe(false);
    // 表项仍在（同键下一 turn 复用第二个进程，不再 spawn）。
    await pool.runTurn(key, SPEC, undefined, async (session) => {
      expect(session.seenHashes).toEqual([]);
      return 'ok2';
    });
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[1]!.stdinEnded).toBe(false);
    pool.dispose();
  });

  it('oneshot（无 sessionKey 单发）：turn 毕即弃（优雅关停 + 出表 + 目录清理），下次单发新进程', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    await pool.runOneshot(SPEC, undefined, async (session) => {
      await session.writeLine('one');
      return 'ok';
    });
    expect(env.spawns).toHaveLength(1);
    expect(env.spawns[0]!.writtenLines).toEqual(['one']);
    expect(env.spawns[0]!.stdinEnded).toBe(true);
    expect(env.spawns[0]!.killed).toBe(false);
    expect(env.removedDirs).toContain(env.spawns[0]!.spawnArgs.cwd);
    expect(pool['entries'].size).toBe(0);

    await pool.runOneshot(SPEC, undefined, async () => 'ok2');
    expect(env.spawns).toHaveLength(2);
    pool.dispose();
  });

  it('进程意外退出：表项自清，下次冷启动', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    await pool.runTurn(key, SPEC, undefined, async () => 'r1');
    expect(pool['entries'].size).toBe(1);
    env.spawns[0]!.exit(1); // 意外退出
    expect(pool['entries'].size).toBe(0);
    expect(env.removedDirs).toContain(env.spawns[0]!.spawnArgs.cwd);
    await pool.runTurn(key, SPEC, undefined, async () => 'r2');
    expect(env.spawns).toHaveLength(2);
    pool.dispose();
  });

  it('同键并发首获共享同一 spawn（单飞，CR-4）：一进程 + 串行保持', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    const order: string[] = [];
    // 两路同时首获：不 await 第一路——mkdtemp 的 await 间隙内第二路进入 acquire。
    const p1 = pool.runTurn(key, SPEC, undefined, async () => {
      order.push('t1');
      return 'r1';
    });
    const p2 = pool.runTurn(key, SPEC, undefined, async () => {
      order.push('t2');
      return 'r2';
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1, r2]).toEqual(['r1', 'r2']);
    expect(order).toEqual(['t1', 't2']); // 同键串行红线保持
    expect(env.spawns).toHaveLength(1); // 单飞：无双 spawn 无孤儿
    pool.dispose();
  });

  it('restart 换柄（CR-7）：旧柄 tap/观察者卸除——旧进程晚到行不喂旧 turn，新柄事件正常', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    await pool.runTurn(key, SPEC, undefined, async (session) => {
      const oldLines: string[] = [];
      session.setLineTap((l) => oldLines.push(l));
      await session.restart();
      // 旧进程优雅关停期间的晚到行：不得喂进旧 tap（读错流）。
      env.spawns[0]!.emitLine('late-from-old');
      expect(oldLines).toEqual([]);
      // 新柄 tap 正常收流。
      const newLines: string[] = [];
      session.setLineTap((l) => newLines.push(l));
      env.spawns[1]!.emitLine('from-new');
      expect(newLines).toEqual(['from-new']);
      return 'ok';
    });
    pool.dispose();
  });

  it('写在途换柄（CR-7）：restart 竞争写 → 响亮报错，不静默当成功写', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    await pool.runTurn(key, SPEC, undefined, async (session) => {
      const first = env.spawns[0]!;
      const release = deferred<void>();
      first.writeLine = (line: string) => {
        first.writtenLines.push(line);
        return release.promise; // 写 promise 挂起，直到 restart 完成
      };
      const write = session.writeLine('x');
      const assertion = expect(write).rejects.toThrow('handle swapped');
      await session.restart();
      release.resolve();
      await assertion;
      return 'ok';
    });
    pool.dispose();
  });

  it('dispose 后拒绝新调用（CR-15 会话侧半）：不 spawn 不占用', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    pool.dispose();
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    await expect(pool.runTurn(key, SPEC, undefined, async () => 'x')).rejects.toThrow(/disposed/);
    await expect(pool.runOneshot(SPEC, undefined, async () => 'x')).rejects.toThrow(/disposed/);
    expect(env.spawns).toHaveLength(0);
  });

  it('dispose 竞态（CR-15）：spawn 在途时 dispose → 新柄即弃 + 调用方收 disposed 错（无孤儿）', async () => {
    const env = fakePoolEnv();
    const gate = deferred<void>();
    env.deps.mkdtemp = async (prefix) => {
      await gate.promise; // spawn 在途挂起，制造 dispose 窗口
      return `${prefix}0`;
    };
    const pool = makePool(env);
    const key = { sessionKey: 's', keyId: 'k', modelId: 'm' };
    const p = pool.runTurn(key, SPEC, undefined, async () => 'x');
    await flush();
    pool.dispose();
    gate.resolve();
    await expect(p).rejects.toThrow(/disposed/);
    await flush();
    expect(env.spawns).toHaveLength(1); // spawn 确已发生
    expect(env.spawns[0]!.stdinEnded).toBe(true); // 即刻优雅关停——无孤儿进程
  });

  // ── 子4 E1：env / homeDir / prepareHome / 假宿引用计数（纯文本路径零行为变化）──

  it('spec.env 透传子进程（β 通道 USERPROFILE/HOME）；缺省 = spawn opts 无 env 键（纯文本零变化）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const homeDir = '/fake-home/session-a';
    await pool.runTurn(
      { sessionKey: 'b1', keyId: 'k', modelId: 'm' },
      { ...SPEC, env: { USERPROFILE: homeDir, HOME: homeDir } },
      undefined,
      async () => 'r',
    );
    expect(env.spawns[0]!.spawnArgs.env).toEqual({ USERPROFILE: homeDir, HOME: homeDir });
    // 纯文本 SPEC（无 env/homeDir）：opts.env 缺席。
    await pool.runTurn({ sessionKey: 'b2', keyId: 'k', modelId: 'm' }, SPEC, undefined, async () => 'r');
    expect(env.spawns[1]!.spawnArgs.env).toBeUndefined();
    pool.dispose();
  });

  it('假宿生命周期：首占 prepareHome → 进程退出归零即删；prepareHome 失败 = spawn 失败', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const key = { sessionKey: 'h1', keyId: 'k', modelId: 'm' };
    const homeDir = '/fake-home/h1';
    const preparedDirs: string[] = [];
    const spec = { ...SPEC, homeDir, prepareHome: async (dir: string) => { preparedDirs.push(dir); } };

    await pool.runTurn(key, spec, undefined, async () => 'r1');
    expect(preparedDirs).toEqual([homeDir]);
    // 进程仍 idle 在表（未退出）——假宿未删。
    expect(env.removedDirs).not.toContain(homeDir);

    // 同会话再 turn（复用进程）→ prepareHome 不重跑。
    await pool.runTurn(key, spec, undefined, async () => 'r2');
    expect(preparedDirs).toHaveLength(1);

    // 作废（进程 kill 退出）→ 假宿引用归零 → removeDir（与临时 cwd 同批）。
    await pool.runTurn(key, spec, undefined, async (session) => {
      session.invalidate('test');
      return 'r3';
    });
    expect(env.spawns[0]!.killed).toBe(true);
    expect(env.removedDirs).toContain(homeDir);
    pool.dispose();
  });

  it('假宿 prepareHome 抛出 → spawn 失败（无进程占位），后续可重试', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const spec = {
      ...SPEC,
      homeDir: '/fake-home/fail',
      prepareHome: async () => { throw new Error('gemini copy failed'); },
    };
    await expect(
      pool.runTurn({ sessionKey: 'f1', keyId: 'k', modelId: 'm' }, spec, undefined, async () => 'x'),
    ).rejects.toThrow('gemini copy failed');
    expect(env.spawns).toHaveLength(0); // 失败 = spawn 失败——不留半启动进程
    // 重试（prepareHome 换成功实现）→ 正常 spawn。
    const spec2 = { ...SPEC, homeDir: '/fake-home/fail' };
    await pool.runTurn({ sessionKey: 'f1', keyId: 'k', modelId: 'm' }, spec2, undefined, async () => 'ok');
    expect(env.spawns).toHaveLength(1);
    pool.dispose();
  });

  it('假宿归属撞段（CR-10）：同 homeDir 不同 homeOwner → typed 拒绝（不静默共用配置）', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const specA = { ...SPEC, homeDir: '/fake-home/collide', homeOwner: 'session-a' };
    await pool.runTurn({ sessionKey: 'a', keyId: 'k', modelId: 'm' }, specA, undefined, async () => 'r1');
    // A 的进程 idle 在表（claim 持有 owner=session-a）——B 不同 owner 落同 dir 即拒。
    const specB = { ...SPEC, homeDir: '/fake-home/collide', homeOwner: 'session-b' };
    await expect(
      pool.runTurn({ sessionKey: 'b', keyId: 'k', modelId: 'm' }, specB, undefined, async () => 'r2'),
    ).rejects.toThrow(AgyFakeHomeCollisionError);
    expect(env.spawns).toHaveLength(1); // B 零 spawn 占位
    // 同 owner 复用路径不受影响（A 再 turn 正常）。
    await pool.runTurn({ sessionKey: 'a', keyId: 'k', modelId: 'm' }, specA, undefined, async () => 'r3');
    expect(env.spawns).toHaveLength(1);
    // 未声明 owner 的占用不参与撞段判定（向后兼容——纯文本路径不设 homeDir）。
    const specNoOwner = { ...SPEC, homeDir: '/fake-home/plain' };
    await pool.runTurn({ sessionKey: 'c', keyId: 'k', modelId: 'm' }, specNoOwner, undefined, async () => 'r4');
    expect(env.spawns).toHaveLength(2);
    pool.dispose();
  });

  it('restart 交接期假宿不删：引用计数保持 ≥1，prepareHome 不重跑；末柄退出才删', async () => {
    const env = fakePoolEnv();
    const pool = makePool(env);
    const homeDir = '/fake-home/restart';
    const prepared: string[] = [];
    const spec = { ...SPEC, homeDir, prepareHome: async (dir: string) => { prepared.push(dir); } };
    await pool.runTurn({ sessionKey: 'r1', keyId: 'k', modelId: 'm' }, spec, undefined, async (session) => {
      await session.restart(); // 新柄 spawn（refs 1→2）；旧柄优雅关停退出（refs 2→1）
      expect(env.spawns).toHaveLength(2);
      expect(prepared).toHaveLength(1); // 不重拷
      return 'ok';
    });
    // 新柄仍 idle 在表 → 假宿未删。
    expect(env.removedDirs).not.toContain(homeDir);
    pool.dispose(); // 新柄关停退出 → refs 归零 → 删。
    await flush();
    expect(env.removedDirs).toContain(homeDir);
  });

  it('CR-9：onCommitSeenHashes 观察者抛错不侵入控制流——记账照常推进 + warn 落账（不误报写失败）', async () => {
    const env = fakePoolEnv();
    // 观察缝抛错：旧实现裸调观察者，throw 沿调用方 async 体上抛（首行路径 = 未处理
    // rejection；纠正路径 = 被误报成写失败 + 502 作废会话）。
    env.deps.onCommitSeenHashes = () => {
      throw new Error('observer boom');
    };
    const pool = makePool(env);
    await pool.runTurn({ sessionKey: 's1', keyId: 'k1', modelId: 'm1' }, SPEC, undefined, async (session) => {
      await session.writeLine('one');
      // 观察者抛错被吞在观察缝内：commitSeenHashes 本体照常落账（镜像「已发」语义）。
      expect(() => session.commitSeenHashes(['h1'])).not.toThrow();
      expect(session.seenHashes).toEqual(['h1']);
      return 'ok';
    });
    expect(env.warns.some((w) => w.includes('onCommitSeenHashes observer threw'))).toBe(true);
    expect(env.spawns[0]!.writtenLines).toEqual(['one']); // 写路径零影响
    expect(env.spawns[0]!.killed).toBe(false); // 不因观察者失败误作废会话
    pool.dispose();
  });
});

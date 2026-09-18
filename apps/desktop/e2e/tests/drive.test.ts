import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  parseSelector,
  locatorFor,
  locatorFromBody,
  timeoutFromBody,
  isLikelyKeyField,
  navButtonCssFor,
  PAGE_NAV_ICON,
  dispatchRoute,
  type DriveContext,
} from '../src/drive.js';

/**
 * Unit tests for the drive server (Phase C gate). No Electron launch - the
 * handlers are driven against a mock Page that records every call, and
 * dispatchRoute's routing + error handling is exercised directly.
 */

// ---------------------------------------------------------------------------
// Mock Page (records calls; returns canned values).
// ---------------------------------------------------------------------------

interface RecordedCall {
  fn: string;
  args: unknown[];
}

interface MockOptions {
  a11y?: 'object' | 'null' | 'throw';
  innerText?: string;
  onKeyPage?: boolean;
  checked?: boolean;
  /** When set, the named locator method rejects (to exercise error handling). */
  reject?: 'click' | 'fill' | 'innerText' | 'waitFor' | 'isChecked';
}function makeMockWindow(opts: MockOptions = {}): { win: Page; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const maybeReject = (name: string, fn: () => Promise<unknown>): Promise<unknown> => {
    if (opts.reject === name) return Promise.reject(new Error(`${name} boom`));
    return fn();
  };

  // A self-returning mock locator so `.locator(...).locator(...)` chains work.
  const mockLoc = {
    click: (o?: unknown) => maybeReject('click', async () => calls.push({ fn: 'loc.click', args: [o] })),
    fill: (t: unknown, o?: unknown) =>
      maybeReject('fill', async () => calls.push({ fn: 'loc.fill', args: [t, o] })),
    innerText: (o?: unknown) =>
      maybeReject('innerText', async () => {
        calls.push({ fn: 'loc.innerText', args: [o] });
        return opts.innerText ?? 'mock-text';
      }),
    waitFor: (o?: unknown) => maybeReject('waitFor', async () => calls.push({ fn: 'loc.waitFor', args: [o] })),
    isChecked: (o?: unknown) =>
      maybeReject('isChecked', async () => {
        calls.push({ fn: 'loc.isChecked', args: [o] });
        return opts.checked ?? false;
      }),
    setInputFiles: (files: unknown, o?: unknown) =>
      Promise.resolve(calls.push({ fn: 'loc.setInputFiles', args: [files, o] })),
    first: () => {
      calls.push({ fn: 'loc.first', args: [] });
      return mockLoc;
    },
    filter: () => {
      calls.push({ fn: 'loc.filter', args: [] });
      return mockLoc;
    },
    locator: (sel: unknown) => {
      calls.push({ fn: 'loc.locator', args: [sel] });
      return mockLoc;
    },
    count: async () => 1,
  };

  const win = {
    locator: (sel: unknown, o?: unknown) => {
      calls.push({ fn: 'locator', args: [sel, o] });
      return mockLoc;
    },
    getByText: (text: unknown) => {
      calls.push({ fn: 'getByText', args: [text] });
      return mockLoc;
    },
    ariaSnapshot: (o?: unknown) => {
      calls.push({ fn: 'ariaSnapshot', args: [o] });
      if (opts.a11y === 'throw') return Promise.reject(new Error('a11y boom'));
      if (opts.a11y === 'null') return Promise.resolve('');
      return Promise.resolve('- page:\n  - main: mock aria snapshot');
    },
    evaluate: (fn: unknown) => {
      calls.push({ fn: 'evaluate', args: [fn] });
      const src = String(fn);
      if (src.includes('innerText')) return Promise.resolve(opts.innerText ?? 'mock-body-text');
      if (src.includes('querySelector')) return Promise.resolve(opts.onKeyPage ?? false);
      return Promise.resolve(undefined);
    },
    keyboard: { press: (k: unknown) => Promise.resolve(calls.push({ fn: 'keyboard.press', args: [k] })) },
  };

  return { win: win as unknown as Page, calls };
}

function makeCtx(win: Page, screenshotFn?: DriveContext['screenshotFn']): { ctx: DriveContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-drive-'));
  const ctx: DriveContext = { window: win, artifactsDir: dir, screenshotFn };
  return { ctx, dir };
}

function callsOf(calls: RecordedCall[], fn: string): RecordedCall[] {
  return calls.filter((c) => c.fn === fn);
}

// ===========================================================================
// parseSelector (pure)
// ===========================================================================

test.describe('parseSelector (pure)', () => {
  test('data:<attr>=<value> -> data descriptor', () => {
    expect(parseSelector('data:node-id=scene-1')).toEqual({
      kind: 'data',
      attr: 'node-id',
      value: 'scene-1',
    });
  });

  test('data: with a value containing "=" keeps it in the value', () => {
    expect(parseSelector('data:edge-id=a=b')).toEqual({ kind: 'data', attr: 'edge-id', value: 'a=b' });
  });

  test('text:<text> -> text descriptor', () => {
    expect(parseSelector('text:结构')).toEqual({ kind: 'text', text: '结构' });
  });

  test('bare CSS selector -> css descriptor', () => {
    expect(parseSelector('.agent-input-textarea')).toEqual({ kind: 'css', selector: '.agent-input-textarea' });
  });

  test('data: without "=" falls back to css', () => {
    expect(parseSelector('data:node-id')).toEqual({ kind: 'css', selector: 'data:node-id' });
  });

  test('data: with empty attr falls back to css', () => {
    expect(parseSelector('data:=value')).toEqual({ kind: 'css', selector: 'data:=value' });
  });
});

// ===========================================================================
// locatorFor / locatorFromBody (mock window)
// ===========================================================================

test.describe('locatorFor / locatorFromBody', () => {
  test('data descriptor -> [data-attr="value"] css', () => {
    const { win, calls } = makeMockWindow();
    locatorFor(win, 'data:node-id=scene-1');
    expect(callsOf(calls, 'locator')).toEqual([{ fn: 'locator', args: ['[data-node-id="scene-1"]', undefined] }]);
  });

  test('text descriptor -> getByText', () => {
    const { win, calls } = makeMockWindow();
    locatorFor(win, 'text:结构');
    expect(callsOf(calls, 'getByText')).toEqual([{ fn: 'getByText', args: ['结构'] }]);
  });

  test('css descriptor -> window.locator(selector)', () => {
    const { win, calls } = makeMockWindow();
    locatorFor(win, '.patch-review-apply-btn');
    expect(callsOf(calls, 'locator')).toEqual([
      { fn: 'locator', args: ['.patch-review-apply-btn', undefined] },
    ]);
  });

  test('locatorFromBody prefers selector over text', () => {
    const { win, calls } = makeMockWindow();
    locatorFromBody(win, { selector: '.x', text: 'ignored' });
    expect(callsOf(calls, 'locator')).toHaveLength(1);
    expect(callsOf(calls, 'getByText')).toHaveLength(0);
  });

  test('locatorFromBody uses text when no selector', () => {
    const { win, calls } = makeMockWindow();
    locatorFromBody(win, { text: 'hello' });
    expect(callsOf(calls, 'getByText')).toEqual([{ fn: 'getByText', args: ['hello'] }]);
  });

  test('locatorFromBody throws when neither selector nor text', () => {
    const { win } = makeMockWindow();
    expect(() => locatorFromBody(win, {})).toThrow('missing "selector" or "text"');
  });
});

// ===========================================================================
// timeoutFromBody / isLikelyKeyField / navButtonCssFor (pure)
// ===========================================================================

test.describe('timeoutFromBody (pure)', () => {
  test('returns a positive number', () => {
    expect(timeoutFromBody({ timeout: 5000 })).toBe(5000);
  });

  test('falls back to default for missing / invalid', () => {
    expect(timeoutFromBody({})).toBe(10_000);
    expect(timeoutFromBody({ timeout: 0 })).toBe(10_000);
    expect(timeoutFromBody({ timeout: -1 })).toBe(10_000);
    expect(timeoutFromBody({ timeout: NaN })).toBe(10_000);
    expect(timeoutFromBody({ timeout: '5000' })).toBe(10_000);
  });

  test('honours a custom default', () => {
    expect(timeoutFromBody({}, 30_000)).toBe(30_000);
  });
});

test.describe('isLikelyKeyField (pure)', () => {
  test('refuses api-key-ish selectors', () => {
    expect(isLikelyKeyField('.form-field-input[type="password"]')).toBe(true);
    expect(isLikelyKeyField('data:field=apiKey')).toBe(true);
    expect(isLikelyKeyField('[aria-label="API Key"]')).toBe(true);
    expect(isLikelyKeyField('.model-settings .key-input')).toBe(true);
    expect(isLikelyKeyField('.profile-editor [data-key]')).toBe(true);
    expect(isLikelyKeyField('input.api-key')).toBe(true);
  });

  test('allows non-key selectors', () => {
    expect(isLikelyKeyField('.agent-input-textarea')).toBe(false);
    expect(isLikelyKeyField('.patch-review-apply-btn')).toBe(false);
    expect(isLikelyKeyField('[data-node-id="scene-1"]')).toBe(false);
    expect(isLikelyKeyField('.model-settings .model-name')).toBe(false);
  });
});

test.describe('navButtonCssFor (pure)', () => {
  test('returns css targeting the icon ligature for known pages', () => {
    expect(navButtonCssFor('structure')).toBe(
      '.icon-rail-btn:has(span.material-symbols-outlined:text-is("account_tree"))',
    );
    expect(navButtonCssFor('overview')).toBe(
      '.icon-rail-btn:has(span.material-symbols-outlined:text-is("dashboard"))',
    );
  });

  test('returns null for unknown pages', () => {
    expect(navButtonCssFor('nope')).toBeNull();
  });

  test('PAGE_NAV_ICON mirrors navItems.ts icons', () => {
    expect(PAGE_NAV_ICON).toEqual({
      overview: 'dashboard',
      outline: 'auto_stories',
      structure: 'account_tree',
      assets: 'perm_media',
      image_gen: 'image',
    });
  });
});

// ===========================================================================
// dispatchRoute - handlers (mock window)
// ===========================================================================

test.describe('dispatchRoute: POST /click', () => {
  test('clicks by selector (data:)', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/click', new URLSearchParams(), { selector: 'data:node-id=scene-1' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'locator')[0].args[0]).toBe('[data-node-id="scene-1"]');
    expect(callsOf(calls, 'loc.click')).toHaveLength(1);
  });

  test('clicks by bare text', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/click', new URLSearchParams(), { text: '结构' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'getByText')).toEqual([{ fn: 'getByText', args: ['结构'] }]);
  });

  test('missing selector+text -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/click', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('missing');
  });

  test('click rejection -> {ok:false,error} (server never crashes)', async () => {
    const { win } = makeMockWindow({ reject: 'click' });
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/click', new URLSearchParams(), { selector: '.x' }, ctx);
    expect(res).toEqual({ ok: false, error: 'click boom' });
  });
});

test.describe('dispatchRoute: POST /type', () => {
  test('fills the located input', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/type', new URLSearchParams(), { selector: '.x', text: 'hello' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'loc.fill')[0].args[0]).toBe('hello');
  });

  test('missing text -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/type', new URLSearchParams(), { selector: '.x' }, ctx);
    expect(res.ok).toBe(false);
  });
});

test.describe('dispatchRoute: POST /snapshot', () => {
  test('screenshots + returns screenshotPath + a11y domText', async () => {
    const { win } = makeMockWindow({ a11y: 'object' });
    const screenshotCalls: string[] = [];
    const { ctx, dir } = makeCtx(win, async (_w, step) => {
      screenshotCalls.push(step);
    });
    const res = await dispatchRoute('POST', '/snapshot', new URLSearchParams(), { step: 'plan' }, ctx);
    expect(res.ok).toBe(true);
    expect(screenshotCalls).toEqual(['plan']);
    expect(res.screenshotPath).toBe(join(dir, 'plan.png'));
    expect(typeof res.domText).toBe('string');
    expect(res.domText).toContain('aria snapshot');
    expect(res.warning).toBeUndefined();
  });

  test('falls back to innerText when a11y is null', async () => {
    const { win } = makeMockWindow({ a11y: 'null', innerText: 'body text' });
    const { ctx } = makeCtx(win, async () => {});
    const res = await dispatchRoute('POST', '/snapshot', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(true);
    expect(res.domText).toBe('body text');
  });

  test('falls back to innerText when a11y throws', async () => {
    const { win } = makeMockWindow({ a11y: 'throw', innerText: 'fallback' });
    const { ctx } = makeCtx(win, async () => {});
    const res = await dispatchRoute('POST', '/snapshot', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(true);
    expect(res.domText).toBe('fallback');
  });

  test('default step is "snapshot"', async () => {
    const { win } = makeMockWindow({ a11y: 'object' });
    const screenshotCalls: string[] = [];
    const { ctx, dir } = makeCtx(win, async (_w, step) => {
      screenshotCalls.push(step);
    });
    const res = await dispatchRoute('POST', '/snapshot', new URLSearchParams(), {}, ctx);
    expect(screenshotCalls).toEqual(['snapshot']);
    expect(res.screenshotPath).toBe(join(dir, 'snapshot.png'));
  });

  test('refuses snapshot when the model-settings page is visible (key leakage guard)', async () => {
    const { win } = makeMockWindow({ a11y: 'object', onKeyPage: true });
    const { ctx } = makeCtx(win, async () => {});
    const res = await dispatchRoute('POST', '/snapshot', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('refused');
    expect(res.error).toContain('model-settings');
    expect(res.error).toContain('API key');
  });
});

test.describe('dispatchRoute: GET /read', () => {
  test('returns the element innerText', async () => {
    const { win } = makeMockWindow({ innerText: 'scene text' });
    const { ctx } = makeCtx(win);
    const qs = new URLSearchParams('selector=.x');
    const res = await dispatchRoute('GET', '/read', qs, {}, ctx);
    expect(res).toEqual({ ok: true, text: 'scene text' });
  });

  test('refuses a likely key field', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const qs = new URLSearchParams('selector=input[type%3D"password"]');
    const res = await dispatchRoute('GET', '/read', qs, {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('refused');
  });

  test('missing selector -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('GET', '/read', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('selector');
  });
});

test.describe('dispatchRoute: POST /send-agent-message', () => {
  test('fills the AgentInput textarea + clicks send', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/send-agent-message', new URLSearchParams(), { text: '写辉夜姬' }, ctx);
    expect(res).toEqual({ ok: true });
    const locatorCalls = callsOf(calls, 'locator').map((c) => c.args[0]);
    expect(locatorCalls).toEqual(['.agent-input-textarea', '.agent-input-btn']);
    expect(callsOf(calls, 'loc.fill')[0].args[0]).toBe('写辉夜姬');
    expect(callsOf(calls, 'loc.click')).toHaveLength(1);
  });

  test('missing text -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/send-agent-message', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
  });
});

test.describe('dispatchRoute: POST /accept-patch', () => {
  test('no field -> just clicks apply', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/accept-patch', new URLSearchParams(), {}, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'loc.click')).toHaveLength(1);
    expect(callsOf(calls, 'locator').map((c) => c.args[0])).toContain('.patch-review-apply-btn');
    expect(callsOf(calls, 'loc.isChecked')).toHaveLength(0);
  });

  test('field unchecked -> toggles checkbox then applies', async () => {
    const { win, calls } = makeMockWindow({ checked: false });
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/accept-patch', new URLSearchParams(), { field: '场景图谱' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'loc.isChecked')).toHaveLength(1);
    expect(callsOf(calls, 'loc.click')).toHaveLength(2); // checkbox + apply
  });

  test('field already checked -> only applies (no toggle)', async () => {
    const { win, calls } = makeMockWindow({ checked: true });
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/accept-patch', new URLSearchParams(), { field: '场景图谱' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'loc.isChecked')).toHaveLength(1);
    expect(callsOf(calls, 'loc.click')).toHaveLength(1); // apply only
  });

  test('field row not found (isChecked rejects) -> still applies', async () => {
    const { win, calls } = makeMockWindow({ reject: 'isChecked' });
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/accept-patch', new URLSearchParams(), { field: 'x' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'loc.click')).toHaveLength(1); // apply still fires
  });
});

test.describe('dispatchRoute: POST /wait', () => {
  test('waits for a selector (first + visible)', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/wait', new URLSearchParams(), { selector: '.x' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'loc.first')).toHaveLength(1);
    expect(callsOf(calls, 'loc.waitFor')).toHaveLength(1);
    const waitArg = callsOf(calls, 'loc.waitFor')[0].args[0] as { state?: string };
    expect(waitArg.state).toBe('visible');
  });

  test('missing selector+text -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/wait', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
  });
});

test.describe('dispatchRoute: POST /switch-page', () => {
  test('clicks the structure nav button', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/switch-page', new URLSearchParams(), { page: 'structure' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'locator')[0].args[0]).toBe(
      '.icon-rail-btn:has(span.material-symbols-outlined:text-is("account_tree"))',
    );
  });

  test('unknown page -> {ok:false} listing known pages', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/switch-page', new URLSearchParams(), { page: 'nope' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown page');
    expect(res.error).toContain('structure');
  });

  test('missing page -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/switch-page', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
  });
});

test.describe('dispatchRoute: POST /press-key', () => {
  test('presses the key', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/press-key', new URLSearchParams(), { key: 'Enter' }, ctx);
    expect(res).toEqual({ ok: true });
    expect(callsOf(calls, 'keyboard.press')[0].args[0]).toBe('Enter');
  });

  test('missing key -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/press-key', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
  });
});

test.describe('dispatchRoute: POST /set-input-files', () => {
  test('sets files on the located input', async () => {
    const { win, calls } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const files = ['D:/a/novel.txt', 'D:/a/other.epub'];
    const res = await dispatchRoute('POST', '/set-input-files', new URLSearchParams(), { selector: '.materials-fileinput', files }, ctx);
    expect(res).toEqual({ ok: true });
    const c = callsOf(calls, 'loc.setInputFiles')[0];
    expect(c.args[0]).toEqual(files);
  });

  test('missing/empty files -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const empty = await dispatchRoute('POST', '/set-input-files', new URLSearchParams(), { selector: '.a', files: [] }, ctx);
    expect(empty.ok).toBe(false);
    const missing = await dispatchRoute('POST', '/set-input-files', new URLSearchParams(), { selector: '.a' }, ctx);
    expect(missing.ok).toBe(false);
  });

  test('non-string file entry -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/set-input-files', new URLSearchParams(), { selector: '.a', files: ['ok', ''] }, ctx);
    expect(res.ok).toBe(false);
  });
});

test.describe('dispatchRoute: POST /close + unknown routes', () => {
  test('POST /close -> {ok:true,closing:true}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('POST', '/close', new URLSearchParams(), {}, ctx);
    expect(res).toEqual({ ok: true, closing: true });
  });

  test('unknown route -> {ok:false}', async () => {
    const { win } = makeMockWindow();
    const { ctx } = makeCtx(win);
    const res = await dispatchRoute('DELETE', '/whatever', new URLSearchParams(), {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown route');
  });
});

// ===========================================================================
// cleanup
// ===========================================================================

test.afterAll(() => {
  // tmp dirs are OS-managed; no per-test cleanup needed (mkdtempSync creates
  // unique dirs). This is a placeholder so the suite reads symmetrically.
  void rmSync(join(tmpdir(), 'e2e-drive-cleanup-marker'), { force: true });
});

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { launchApp } from './launch.js';
import { screenshot, writeLog, artifactsDirFor } from './artifacts.js';
import { activeTaskStorySlug } from './checklist/parse.js';

/**
 * Drive server (Phase C core / design §2-§3).
 *
 * The harness is NOT a test script. It is a long-lived Electron instance + HTTP
 * server that lets the Claude main session drive the real app as a real user
 * (curl the operation interface + Read the screenshots) to walk a creative flow
 * and find UI/functional bugs. No .spec.ts assertions - Claude judges the UI by
 * reading the screenshot + a11y snapshot returned from /snapshot.
 *
 * Lifecycle: `tsx src/drive.ts` launches the app (visible window, real preload +
 * IPC) + listens on localhost:3137. Stdout prints `DRIVE_READY http://...` once
 * the window is ready (Claude greps this line). `/close` or SIGINT tears down
 * Electron + server + exits. The app store is NOT exposed on `window` (only the
 * `window.orisonDesktop` IPC bridge is), so every operation is driven through
 * Playwright Page interactions (clicks / fills / keyboard), not store mutation.
 */

export const DRIVE_PORT = 3137;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * dogfood R2 #98：Windows Hyper-V 动态保留段可吞默认口（本机 3082-3181 含 3137，
 * listen EACCES 而非 EADDRINUSE——保留段随重启漂移，e2e 首撞）。ORISON_DRIVE_PORT
 * env 覆盖（mirror shell 的 ORISON_CDP_PORT 先例），合法 1-65535 才生效。
 */
function drivePortFromEnv(): number {
  const raw = process.env.ORISON_DRIVE_PORT;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 65535) return n;
  }
  return DRIVE_PORT;
}

// ---------------------------------------------------------------------------
// Selector resolution (pure / easily unit-testable).
// ---------------------------------------------------------------------------

export type SelectorDescriptor =
  | { kind: 'data'; attr: string; value: string }
  | { kind: 'text'; text: string }
  | { kind: 'css'; selector: string };

/**
 * Parse a selector string into a descriptor.
 *
 * - `data:<attr>=<value>` -> data-attribute locator, e.g.
 *   `data:node-id=scene-1` -> `[data-node-id="scene-1"]`. Story 1.5 already
 *   exposes `data-node-id` / `data-lane-id` / `data-edge-id` / `data-skeleton`
 *   / `data-drop-col` / `data-mode` / `data-axis` / `data-scene-id`, so data-*
 *   is the preferred (most stable) targeting strategy.
 * - `text:<text>` -> visible-text locator (Playwright `getByText`).
 * - anything else -> treated as a raw CSS selector.
 *
 * Malformed `data:` (no `=` or empty attr) falls back to CSS so the caller gets
 * a clear "element not found" rather than a parser crash.
 */
export function parseSelector(selector: string): SelectorDescriptor {
  if (selector.startsWith('data:')) {
    const rest = selector.slice('data:'.length);
    const eq = rest.indexOf('=');
    if (eq < 0) return { kind: 'css', selector };
    const attr = rest.slice(0, eq);
    const value = rest.slice(eq + 1);
    if (!attr) return { kind: 'css', selector };
    return { kind: 'data', attr, value };
  }
  if (selector.startsWith('text:')) {
    return { kind: 'text', text: selector.slice('text:'.length) };
  }
  return { kind: 'css', selector };
}

/** Build a Playwright Locator for a selector string on the given window. */
export function locatorFor(window: Page, selector: string): Locator {
  const desc = parseSelector(selector);
  switch (desc.kind) {
    case 'data':
      return window.locator(`[data-${desc.attr}="${desc.value}"]`);
    case 'text':
      return window.getByText(desc.text);
    case 'css':
      return window.locator(desc.selector);
  }
}

/**
 * Resolve a `{selector?|text?}` request body to a Locator. `selector` (which
 * itself may be `data:`/`text:`/css) takes priority; a bare `text` is a
 * convenience shortcut for visible-text targeting. Throws if neither is present
 * (dispatchRoute converts the throw into `{ok:false,error}`).
 */
export function locatorFromBody(
  window: Page,
  body: { selector?: string; text?: string },
): Locator {
  if (body.selector) return locatorFor(window, body.selector);
  if (body.text) return window.getByText(body.text);
  throw new Error('missing "selector" or "text"');
}

/** Resolve a positive timeout (ms) from a request body, falling back to default. */
export function timeoutFromBody(body: { timeout?: unknown }, def = DEFAULT_TIMEOUT_MS): number {
  const t = body.timeout;
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t;
  return def;
}

// ---------------------------------------------------------------------------
// 1.5 UI element selectors (single source of truth = the component files).
// ---------------------------------------------------------------------------

// AgentInput.tsx: textarea.agent-input-textarea is the message input; the
// send/stop button shares class agent-input-btn (only one renders at a time -
// send when idle, stop when loading - so the class is unambiguous when idle).
const AGENT_INPUT_TEXTAREA_SEL = '.agent-input-textarea';
const AGENT_INPUT_SEND_BTN_SEL = '.agent-input-btn';

// PatchReviewPanel.tsx: apply button.patch-review-apply-btn; each field row is
// label.patch-review-item containing span.patch-review-field (the LOCALIZED
// field name) + input[type=checkbox]. The field id is not exposed on the DOM,
// so /accept-patch's optional `field` is matched against the visible label.
const PATCH_APPLY_BTN_SEL = '.patch-review-apply-btn';
const PATCH_ITEM_SEL = '.patch-review-item';
const PATCH_FIELD_SEL = '.patch-review-field';

// ---------------------------------------------------------------------------
// SideNav page switching (mirrors side-nav/navItems.ts).
// ---------------------------------------------------------------------------

/**
 * Map of switchable page id -> the material-symbols-outlined ligature rendered
 * inside its SideNav button. Mirrors `navItems.ts` (overview/outline/structure/
 * assets/image_gen). The ligature text is locale-independent, unlike the nav
 * button's aria-label which is i18n'd (`t('nav.<id>')`), so matching on the icon
 * span is the most stable cross-locale strategy. The store is not on `window`,
 * so switching pages = clicking the nav button (no evaluate shortcut).
 */
export const PAGE_NAV_ICON: Record<string, string> = {
  overview: 'dashboard',
  outline: 'auto_stories',
  structure: 'account_tree',
  assets: 'perm_media',
  image_gen: 'image',
};

/** CSS for the SideNav button of a page, or `null` if the page is unknown. */
export function navButtonCssFor(page: string): string | null {
  const icon = PAGE_NAV_ICON[page];
  if (!icon) return null;
  return `.icon-rail-btn:has(span.material-symbols-outlined:text-is("${icon}"))`;
}

// ---------------------------------------------------------------------------
// API-key field guard (design §6 / constraints: drive server never touches the
// key value). /read refuses selectors that look like they target the key input.
// ---------------------------------------------------------------------------

/**
 * True if a selector looks like it targets an API-key / secret field.
 *
 * The selector is compacted (non-alphanumerics dropped) so "api key", "api-key",
 * "api_key", "apikey" and attribute-bracketed forms (`[aria-label="API Key"]`)
 * all collapse to the same `apikey` token. A bare `key` or the shared
 * `form-field-input` class is only treated as a key field inside the
 * model-settings / profile-editor / model-library page (which hosts the key
 * input) to avoid false positives elsewhere. /read uses innerText (not
 * inputValue), so this is defense-in-depth rather than a live leak (BMad CR L11).
 */
export function isLikelyKeyField(selector: string): boolean {
  const c = selector.toLowerCase().replace(/[^a-z0-9]/g, '');
  const onKeyPage =
    c.includes('modelsettings') ||
    c.includes('profileeditor') ||
    c.includes('modellibrarypage');
  return (
    c.includes('apikey') ||
    c.includes('password') ||
    (onKeyPage && (c.includes('key') || c.includes('formfieldinput')))
  );
}

// ---------------------------------------------------------------------------
// Handler context + response shape.
// ---------------------------------------------------------------------------

export interface DriveContext {
  window: Page;
  artifactsDir: string;
  /** Injectable so unit tests avoid the real fs (defaults to artifacts.screenshot). */
  screenshotFn?: (window: Page, step: string, dir: string) => Promise<void>;
  /** Injectable run-log writer (defaults to artifacts.writeLog). */
  logFn?: (dir: string, msg: string) => void;
}

export type DriveResponse = {
  ok: boolean;
  error?: string;
  /** Extra payload fields (screenshotPath / domText / text / warning / closing). */
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Operation handlers. Each throws on error (dispatchRoute converts to
// {ok:false,error}); returns {ok:true,...} on success.
// ---------------------------------------------------------------------------

interface ClickBody {
  selector?: string;
  text?: string;
  timeout?: number;
  /** Mouse button (default left). 'right' -> contextmenu gesture. */
  button?: 'left' | 'right' | 'middle';
  /** Offset from the element's top-left corner (Playwright `position`). */
  position?: { x: number; y: number };
}
interface TypeBody { selector?: string; text?: string; timeout?: number }
interface SnapshotBody { step?: string }
interface SendAgentMessageBody { text: string }
interface AcceptPatchBody { field?: string; timeout?: number }
interface WaitBody { selector?: string; text?: string; timeout?: number }
interface SwitchPageBody { page: string; timeout?: number }
interface HoverBody { selector?: string; text?: string; timeout?: number }
interface EvalBody { expression: string }
interface PressKeyBody { key: string }
interface SetInputFilesBody { selector?: string; text?: string; files: string[]; timeout?: number }

/**
 * POST /set-input-files {selector?|text?, files, timeout?} -> set files on an
 * `<input type="file">` (dogfood R3：材料页/附件上传的「浏览」按钮真实用户路径——
 * Playwright 注入真路径，renderer 侧 `File.path` 有值，与用户从 OS 文件对话框选文件
 * 走的是同一条 change 事件链）。多 input 同 class 时调用方用 `css=X >> nth=i` 消歧。
 */
export async function handleSetInputFiles(ctx: DriveContext, body: SetInputFilesBody): Promise<DriveResponse> {
  if (!Array.isArray(body.files) || body.files.length === 0) {
    throw new Error('missing "files" (non-empty string array of absolute paths)');
  }
  for (const f of body.files) {
    if (typeof f !== 'string' || f.length === 0) throw new Error('"files" must be non-empty strings');
  }
  const loc = locatorFromBody(ctx.window, body);
  await loc.setInputFiles(body.files, { timeout: timeoutFromBody(body) });
  return { ok: true };
}

/** POST /click {selector?|text?, timeout?, button?, position?} -> click the element. */
export async function handleClick(ctx: DriveContext, body: ClickBody): Promise<DriveResponse> {
  const loc = locatorFromBody(ctx.window, body);
  await loc.click({
    timeout: timeoutFromBody(body),
    ...(body.button ? { button: body.button } : {}),
    ...(body.position ? { position: body.position } : {}),
  });
  return { ok: true };
}

/** POST /hover {selector?|text?, timeout?} -> hover the element (line-fold reveal, handles). */
export async function handleHover(ctx: DriveContext, body: HoverBody): Promise<DriveResponse> {
  const loc = locatorFromBody(ctx.window, body);
  await loc.hover({ timeout: timeoutFromBody(body) });
  return { ok: true };
}

/**
 * POST /eval {expression} -> run a page-context expression, return its JSON value.
 * Gesture / geometry primitive for the C1 structure-page traversal (R9 replayable
 * asset): synthetic pointermove sequences (resize drag), HTML5 DnD (synthetic
 * dragstart/dragover/drop with DataTransfer), and geometry reads (getBoundingClientRect
 * fan-outs for chrome-sticky assertions). Dev-gated like the rest of the harness —
 * attach only reaches a dev instance's CDP port.
 */
export async function handleEval(ctx: DriveContext, body: EvalBody): Promise<DriveResponse> {
  if (!body.expression || typeof body.expression !== 'string') {
    return { ok: false, error: 'eval requires a string "expression"' };
  }
  const value = await ctx.window.evaluate(body.expression);
  return { ok: true, value: value === undefined ? null : value };
}

/** POST /type {selector?|text?, text, timeout?} -> fill the input. */
export async function handleType(ctx: DriveContext, body: TypeBody): Promise<DriveResponse> {
  if (!body.text) throw new Error('missing "text"');
  const loc = locatorFromBody(ctx.window, body);
  await loc.fill(body.text, { timeout: timeoutFromBody(body) });
  return { ok: true };
}

/**
 * POST /snapshot {step?} -> screenshot the window to `<step>.png` in the
 * artifacts dir + return a textual DOM snapshot for Claude to judge the UI.
 *
 * The DOM snapshot prefers Playwright's aria snapshot (`page.ariaSnapshot`,
 * the successor to the removed `page.accessibility.snapshot()` - structured +
 * more precise than raw innerText for understanding the interface; `mode: 'ai'`
 * yields element refs + iframe content optimized for Claude consumption) and
 * falls back to `document.body.innerText` when the aria snapshot is unavailable
 * or empty.
 *
 * API-key leakage guard (硬约束 2 / BMad CR M1+M6): the model-settings page hosts
 * the key input, and a screenshot / aria snapshot there would pull the key value
 * into Claude's context. So /snapshot REFUSES ({ok:false}) when the
 * model-settings page is visible (real classes: `.model-library-page` root +
 * `.model-profile-editor`), or when detection itself fails (fail-safe). This
 * costs no coverage because model-settings is existing UI e2e does not validate
 * (硬约束 3); the key is filled there, validation happens on other pages.
 *
 * `step` is sanitized to a safe basename (BMad CR L1): path separators / `..` /
 * Windows-illegal chars collapse to `-`, so `step:"planning/scene-1"` cannot
 * escape the artifacts dir or silently fail to write.
 */
export async function handleSnapshot(ctx: DriveContext, body: SnapshotBody): Promise<DriveResponse> {
  const rawStep = body.step && body.step.trim() ? body.step.trim() : 'snapshot';
  const step = rawStep.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'snapshot';

  // Refuse to snapshot the model-settings page (API key leakage guard).
  try {
    const onKeyPage = await ctx.window.evaluate(
      () => !!document.querySelector('.model-library-page, .model-profile-editor'),
    );
    if (onKeyPage) {
      return {
        ok: false,
        error:
          'refused: model-settings page is visible - screenshot disabled to prevent API key leakage. Switch to another page (the key input lives here).',
      };
    }
  } catch {
    return {
      ok: false,
      error:
        'refused: could not determine whether the model-settings page is visible (API key leakage guard). Switch to another page before snapshotting.',
    };
  }

  const screenshotFn = ctx.screenshotFn ?? screenshot;
  const screenshotPath = resolve(ctx.artifactsDir, `${step}.png`);
  await screenshotFn(ctx.window, step, ctx.artifactsDir);

  let domText = '';
  try {
    const aria = await ctx.window.ariaSnapshot({ mode: 'ai' });
    if (aria) domText = aria;
  } catch {
    // aria snapshot unavailable -> fall through to innerText
  }
  if (!domText) {
    try {
      domText = await ctx.window.evaluate(() => document.body.innerText);
    } catch {
      domText = '';
    }
  }

  return { ok: true, screenshotPath, domText };
}

/** GET /read?selector= -> read an element's innerText. Refuses key fields. */
export async function handleRead(ctx: DriveContext, selector: string | null): Promise<DriveResponse> {
  if (!selector) throw new Error('missing "selector" query param');
  if (isLikelyKeyField(selector)) {
    throw new Error('refused: selector targets a likely API key field (drive server never reads key values)');
  }
  const loc = locatorFor(ctx.window, selector);
  const text = await loc.innerText({ timeout: DEFAULT_TIMEOUT_MS });
  return { ok: true, text };
}

/** POST /send-agent-message {text} -> fill the AgentInput textarea + click send. */
export async function handleSendAgentMessage(
  ctx: DriveContext,
  body: SendAgentMessageBody,
): Promise<DriveResponse> {
  if (!body.text) throw new Error('missing "text"');
  await ctx.window.locator(AGENT_INPUT_TEXTAREA_SEL).fill(body.text);
  await ctx.window.locator(AGENT_INPUT_SEND_BTN_SEL).click();
  return { ok: true };
}

/**
 * POST /accept-patch {field?, timeout?} -> click the PatchReviewPanel apply
 * button. `field` (the VISIBLE field label) optionally ensures that field's
 * checkbox is checked first; patchSelections default to checked
 * (creativeFieldsSlice), so the toggle only fires if the author previously
 * unchecked it. If the field row isn't found, falls through to apply-all.
 */
export async function handleAcceptPatch(ctx: DriveContext, body: AcceptPatchBody): Promise<DriveResponse> {
  const timeout = timeoutFromBody(body);
  if (body.field) {
    const cb = ctx.window
      .locator(`${PATCH_ITEM_SEL}:has(${PATCH_FIELD_SEL}:text-is("${body.field}"))`)
      .locator('input[type="checkbox"]');
    try {
      const checked = await cb.isChecked({ timeout });
      if (!checked) await cb.click({ timeout });
    } catch {
      // field row not found / not visible -> skip selection, apply whatever is selected
    }
  }
  await ctx.window.locator(PATCH_APPLY_BTN_SEL).click({ timeout });
  return { ok: true };
}

/** POST /wait {selector?|text?, timeout?} -> wait for the element/text to be visible. */
export async function handleWait(ctx: DriveContext, body: WaitBody): Promise<DriveResponse> {
  const loc = locatorFromBody(ctx.window, body);
  // .first() so a text wait does not strict-mode-violate when the text appears in
  // multiple places (wait = "exists", not "exactly one").
  await loc.first().waitFor({ timeout: timeoutFromBody(body), state: 'visible' });
  return { ok: true };
}

/** POST /switch-page {page, timeout?} -> click the SideNav button for the page. */
export async function handleSwitchPage(ctx: DriveContext, body: SwitchPageBody): Promise<DriveResponse> {
  if (!body.page) throw new Error('missing "page"');
  const css = navButtonCssFor(body.page);
  if (!css) {
    throw new Error(`unknown page "${body.page}". Known: ${Object.keys(PAGE_NAV_ICON).join(', ')}`);
  }
  await ctx.window.locator(css).click({ timeout: timeoutFromBody(body) });
  return { ok: true };
}

/** POST /press-key {key} -> press a keyboard key (e.g. Enter / Escape). */
export async function handlePressKey(ctx: DriveContext, body: PressKeyBody): Promise<DriveResponse> {
  if (!body.key) throw new Error('missing "key"');
  await ctx.window.keyboard.press(body.key);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route dispatch (the HTTP layer's only job is wire -> dispatchRoute -> wire).
// ---------------------------------------------------------------------------

/**
 * Dispatch a parsed HTTP request to the matching handler. Every handler error is
 * caught and returned as `{ok:false,error}` so the server never crashes (C6).
 * `POST /close` returns `{ok:true,closing:true}`; the HTTP layer tears down the
 * app + server AFTER flushing that response.
 */
export async function dispatchRoute(
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  ctx: DriveContext,
): Promise<DriveResponse> {
  const route = `${method} ${pathname}`;
  try {
    switch (route) {
      case 'POST /click':
        return await handleClick(ctx, (body ?? {}) as ClickBody);
      case 'POST /hover':
        return await handleHover(ctx, (body ?? {}) as HoverBody);
      case 'POST /eval':
        return await handleEval(ctx, (body ?? {}) as EvalBody);
      case 'POST /type':
        return await handleType(ctx, (body ?? {}) as TypeBody);
      case 'POST /snapshot':
        return await handleSnapshot(ctx, (body ?? {}) as SnapshotBody);
      case 'GET /read':
        return await handleRead(ctx, query.get('selector'));
      case 'POST /send-agent-message':
        return await handleSendAgentMessage(ctx, (body ?? {}) as SendAgentMessageBody);
      case 'POST /accept-patch':
        return await handleAcceptPatch(ctx, (body ?? {}) as AcceptPatchBody);
      case 'POST /wait':
        return await handleWait(ctx, (body ?? {}) as WaitBody);
      case 'POST /switch-page':
        return await handleSwitchPage(ctx, (body ?? {}) as SwitchPageBody);
      case 'POST /press-key':
        return await handlePressKey(ctx, (body ?? {}) as PressKeyBody);
      case 'POST /set-input-files':
        return await handleSetInputFiles(ctx, (body ?? {}) as SetInputFilesBody);
      case 'POST /close':
        return { ok: true, closing: true };
      default:
        return { ok: false, error: `unknown route: ${route}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// HTTP server + Electron lifecycle.
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

/**
 * Listen with an error handler (BMad CR M2). Without this, EADDRINUSE (a leftover
 * drive/Electron process holding the port) fires an uncaught 'error' event and
 * DRIVE_READY is never printed, so Claude's background bash hangs forever.
 */
function listenPromise(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('error', onError);
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `port ${port} is already in use - a leftover drive server / Electron ` +
              `process may still be running. Kill it (on Windows: taskkill /F /IM ` +
              `electron.exe) and retry.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    server.on('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Close the Electron app with a hard timeout (BMad CR M3). A hung renderer /
 * blocking modal can make `app.close()` never resolve; racing it against a 3s
 * timeout guarantees SIGINT / `/close` always reaches `process.exit`.
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  try {
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // teardown is best-effort
  }
}

/**
 * Launch the app + start the HTTP drive server. Resolves once `DRIVE_READY` is
 * about to be printed. Returns the server + app handles (mainly for
 * introspection; teardown is driven by `/close` / SIGINT).
 */
export async function startDriveServer(port = DRIVE_PORT): Promise<{
  server: Server;
  app: ElectronApplication;
  window: Page;
}> {
  const { app, window } = await launchApp();
  await window.waitForLoadState('domcontentloaded');

  const story = activeTaskStorySlug() ?? 'manual';
  const artifactsDir = artifactsDirFor(story);

  const ctx: DriveContext = {
    window,
    artifactsDir,
    screenshotFn: screenshot,
    logFn: writeLog,
  };

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://localhost:${port}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid request url' });
      return;
    }

    let body: unknown = {};
    if (req.method && req.method !== 'GET') {
      try {
        body = await readBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }

    let result: DriveResponse;
    try {
      result = await dispatchRoute(req.method ?? 'GET', url.pathname, url.searchParams, body, ctx);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    ctx.logFn?.(artifactsDir, `${req.method ?? 'GET'} ${url.pathname} -> ok=${result.ok}`);
    sendJson(res, 200, result);

    // /close: defer teardown so this response flushes first; closeApp has a
    // timeout so a hung Electron cannot block exit indefinitely (BMad CR M3+L10).
    if (result.ok && result.closing) {
      setImmediate(async () => {
        await closeApp(app);
        server.close();
        process.exit(0);
      });
    }
  });

  await listenPromise(server, port);
  writeLog(artifactsDir, `drive server listening on http://localhost:${port} (story=${story})`);
  // The readiness signal Claude greps for in the background bash output.
  console.log(`DRIVE_READY http://localhost:${port}`);

  const shutdown = async (): Promise<void> => {
    await closeApp(app);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  return { server, app, window };
}

// ---------------------------------------------------------------------------
// Script entry (tsx src/drive.ts). Tests import this module without triggering
// the server, so the isMain guard must NOT fire under the playwright runner.
// ---------------------------------------------------------------------------
const isMain = (() => {
  const scriptPath = process.argv[1] ?? '';
  try {
    if (import.meta.url === pathToFileURL(scriptPath).href) return true;
  } catch {
    // ignore
  }
  return scriptPath.endsWith('drive.ts');
})();

if (isMain) {
  startDriveServer(drivePortFromEnv()).catch((e) => {
    console.error('drive server failed to start:', e);
    process.exit(1);
  });
}

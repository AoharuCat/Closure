/**
 * analyze_image tool handler (Story 3.6 WP7, R11 / design D5).
 *
 * `analyze_image {imagePath? | imageUrl?, prompt}` — visual analysis of ONE
 * image via the WP1 vision kernel (`runVisionAnalysis`, design D3-D5):
 *
 *   - imagePath: project-RELATIVE path (mirror parse_document /
 *     imageHandlers). Resolved + `assertWithinProject` — an escaped path
 *     THROWS (pattern B: an LLM probing ../../etc/passwd is an invariant
 *     violation, not a graceful-degrade case).
 *   - imageUrl: SSRF-guarded binary download (`assertPublicHttpUrl`, allowlist
 *     = configured SearXNG + docParser endpoint hosts, D7) via `netFetch`
 *     with a 10MB cap; redirects are re-guarded per hop (netGuard
 *     caller-duty contract, mirror web_fetch).
 *   - The declared mimeType comes from the file extension (local) or the
 *     response Content-Type (URL) — the KERNEL sniffs the real format from
 *     magic bytes and corrects the pair that goes on the wire (D3
 *     strict-match invariant), so a lying extension never 400s the provider.
 *
 * Output protocol (R9b three-layer dispatch lives in the kernel):
 *   - `mode:'vision'` → the analysis text (+ 来源 provenance, R6).
 *   - `mode:'manual'` → the manual round-trip protocol (D5): the kernel saved
 *     the image to `<project>/.orison/research-media/` + copied it to the
 *     clipboard; this handler renders the relay package (image path +
 *     suggestedPrompt) so the leader can relay it to the author verbatim
 *     (DEFAULT_CLOSURE_PROMPT Research 段 manual 视觉转告协议 — the leader
 *     NEVER fabricates image content, red line).
 *
 * NEVER throws outside the path-escape invariant (mirror fetchHandlers /
 * parseDocumentHandlers, R8): invalid params, missing file, empty file,
 * SSRF block, network failure, oversize download, kernel failure all degrade
 * to friendly outputs. All network/FS/vision work lives here in the shell
 * (agent 纯编排零网络, spec/agent/agent-tools.md injection boundary).
 * classifyTool defaults to 'read' (readonly/suggest/auto).
 *
 * Params are hand-coerced — no zod in this package (mirror wikiHandlers /
 * fetchHandlers); the agent-side tool definition carries the zod surface the
 * LLM sees.
 *
 * Testability: `createAnalyzeImageHandler` accepts injectable analyze /
 * fetchBinary / guard / config-loader seams — unit tests run with ZERO
 * network and ZERO electron (the vision kernel is covered separately in
 * visionAnalysis.test.ts with real buffers).
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocParserConfig, SearchConfig } from '@orison/shared-contracts';
import { assertWithinProject } from '../pathGuard';
import { getLogger } from '../../logger';
import { netFetch, readBodyWithCap } from '../../research/netFetch';
import { assertPublicHttpUrl } from '../../research/netGuard';
import { runVisionAnalysis, type VisionAnalysisResult } from '../../research/visionAnalysis';
import { readSearchConfig } from '../../research/searchConfig';
import { readDocParserConfig } from '../../research/docParserConfig';
import { researchFetchAllowlist } from './fetchHandlers';
import type { ToolHandler, ToolExecuteResponse } from './types';

// ── Constants ──

/** Download budget for imageUrl input (design D3 sends ≤5MB after downscale; 10MB leaves headroom for a heavy original). */
export const ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Binary downloads get a longer budget than the 10s text default (large images on slow links). */
export const ANALYZE_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

// ── Param coercion (no zod in this package — mirror wikiHandlers) ──

export function coerceAnalyzeImageParams(
  params: Record<string, unknown>,
): { imagePath?: string; imageUrl?: string; prompt?: string } {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return {
    imagePath: str(params.imagePath),
    imageUrl: str(params.imageUrl),
    prompt: str(params.prompt),
  };
}

/**
 * Declared mimeType from a file extension (LOCAL input only). The kernel
 * sniffs the real format and corrects mismatches (D3) — this is a hint, never
 * trusted on the wire. Unknown extensions → '' (kernel still sniffs the bytes).
 */
export function mimeFromImageExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return '';
  }
}

// ── Binary fetch seam (URL input) ──

export interface FetchedBinary {
  status: number;
  ok: boolean;
  /** Final URL after redirects (fetch follows by default). */
  finalUrl: string;
  contentType: string;
  buffer: Buffer;
}

export type BinaryFetcher = (
  url: string,
  signal: AbortSignal,
  opts?: { allowlist?: readonly string[] },
) => Promise<FetchedBinary>;

/**
 * Default fetcher: netFetch with the per-hop redirect guard (P1 — every
 * redirect Location is re-guarded before the next hop) and the P3 streaming
 * download cap (an oversize image is CUT mid-stream, never fully buffered).
 */
export async function netFetchBinary(
  url: string,
  signal: AbortSignal,
  opts: { allowlist?: readonly string[] } = {},
): Promise<FetchedBinary> {
  const guard = opts.allowlist
    ? (next: string) => assertPublicHttpUrl(next, opts.allowlist!)
    : undefined;
  const res = await netFetch(url, { signal }, { timeoutMs: ANALYZE_IMAGE_DOWNLOAD_TIMEOUT_MS, guard });
  const contentType = res.headers.get('content-type') ?? '';
  const buffer = await readBodyWithCap(res, ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES, url);
  return { status: res.status, ok: res.ok, finalUrl: res.url || url, contentType, buffer };
}

/** Load the docParser config for the allowlist without ever throwing (never-throws, R8). */
function safeLoadDocParser(load: () => DocParserConfig): DocParserConfig {
  try {
    return load();
  } catch {
    return {};
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Output builders (never a throw) ──

function invalidParamsOutput(): ToolExecuteResponse {
  return {
    title: 'analyze_image',
    output:
      '参数无效，请提供 prompt（分析指令，如「识别图中文字」/「描述画面内容」/「提取图中设定信息」）'
      + '和图片来源二选一：imagePath（项目内相对路径）或 imageUrl（公网 http/https 地址）。',
    metadata: { error: 'invalid-params' },
  };
}

function ssrfBlockedOutput(url: string, err: unknown): ToolExecuteResponse {
  const message = err instanceof Error ? err.message : `目标地址被安全策略拦截：${url}`;
  return {
    title: `analyze_image: ${url.slice(0, 40)}`,
    output: `${message}\n（安全策略：仅允许公网 http/https 地址；如需访问本地服务，请在设置「研究与视觉」中把它配置为研究端点。）`,
    metadata: { url, blocked: true },
  };
}

function buildVisionOutput(args: { source: string; result: Extract<VisionAnalysisResult, { mode: 'vision' }> }): ToolExecuteResponse {
  return {
    title: `analyze_image: ${args.source.slice(0, 40)}`,
    output: `${args.result.text}\n\n---\n来源: ${args.source}\n检索日期: ${today()}`,
    metadata: { mode: 'vision', source: args.source },
  };
}

/**
 * Manual round-trip protocol (D5). Rendered so the leader can relay it
 * verbatim — the image path + suggestedPrompt ride the conversation back to
 * the author, who runs a third-party vision chat and pastes the answer back.
 */
export function buildManualOutput(source: string, result: Extract<VisionAnalysisResult, { mode: 'manual' }>): string {
  const image = result.images[0] ?? '（导出失败，见图片所在目录 .orison/research-media/）';
  return [
    '视觉模型未配置。已把图片存到：',
    image,
    '并已复制进剪贴板（可直接粘贴）。',
    '请把这张图和下面的提示词丢到第三方识图应用（千问 VL / 豆包 / GPT-4o 等），把结果直接贴回对话：',
    `提示词：${result.suggestedPrompt || '（请描述这张图片的内容）'}`,
  ].join('\n');
}

function buildManualResponse(source: string, result: Extract<VisionAnalysisResult, { mode: 'manual' }>): ToolExecuteResponse {
  return {
    title: `analyze_image: ${source.slice(0, 40)}`,
    output: buildManualOutput(source, result),
    metadata: {
      mode: 'manual',
      source,
      images: result.images,
      suggestedPrompt: result.suggestedPrompt,
    },
  };
}

function buildFailureOutput(source: string, message: string, extra?: Record<string, unknown>): ToolExecuteResponse {
  return {
    title: `analyze_image: ${source.slice(0, 40)}`,
    output: `${message}\n支持的图片格式：jpeg / png / gif / webp。${source.startsWith('http') ? '请确认 URL 可达。' : '请确认文件路径正确（项目内相对路径）。'}`,
    metadata: { error: message, source, ...extra },
  };
}

// ── Handler ──

export interface AnalyzeImageHandlerDeps {
  /** Vision kernel (default: runVisionAnalysis; tests inject a stub). */
  analyze?: typeof runVisionAnalysis;
  /** Binary fetcher for imageUrl input (default: netFetchBinary). */
  fetchBinary?: BinaryFetcher;
  /** SSRF guard (default: assertPublicHttpUrl). */
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
  loadConfig?: () => SearchConfig;
  /** WP6 seam: docParser endpoint host joins the SSRF allowlist. */
  loadDocParserConfig?: () => DocParserConfig;
}

export function createAnalyzeImageHandler(deps: AnalyzeImageHandlerDeps = {}): ToolHandler {
  const analyze = deps.analyze ?? runVisionAnalysis;
  const fetchBinary = deps.fetchBinary ?? netFetchBinary;
  const guard = deps.guard ?? assertPublicHttpUrl;
  const loadConfig = deps.loadConfig ?? readSearchConfig;
  const loadDocParserConfig = deps.loadDocParserConfig ?? readDocParserConfig;

  return async ({ params, projectDir, abort }) => {
    const coerced = coerceAnalyzeImageParams(params);
    if (!coerced.prompt || (!coerced.imagePath && !coerced.imageUrl)) {
      return invalidParamsOutput();
    }
    const prompt = coerced.prompt;
    // Deterministic precedence when both are given: the local file avoids the
    // network round-trip (and the bytes are already on disk).
    const source = coerced.imagePath ?? coerced.imageUrl!;

    let buffer: Buffer;
    let declaredMime: string;
    if (coerced.imagePath) {
      // ── Local file branch (mirror parse_document path safety) ──
      const fullPath = path.resolve(projectDir, coerced.imagePath);
      // THROWS on escape (pattern B — invariant violation, not graceful-degrade).
      assertWithinProject(projectDir, fullPath);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return buildFailureOutput(source, `图片文件不存在或不是普通文件：${coerced.imagePath}`);
      }
      // P3: the local branch carries the same 10MB ceiling — a "local" file
      // must not balloon the main process where the URL path cannot.
      const size = statSync(fullPath).size;
      if (size > ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES) {
        return buildFailureOutput(
          source,
          `图片过大（${size} 字节，超过 ${ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES} 上限）。请压缩或裁剪后重试。`,
          { bytes: size },
        );
      }
      try {
        buffer = await readFile(fullPath);
      } catch (err) {
        return buildFailureOutput(source, `读取图片失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (buffer.length === 0) {
        return buildFailureOutput(source, `图片文件为空：${coerced.imagePath}`);
      }
      declaredMime = mimeFromImageExtension(path.extname(coerced.imagePath));
    } else {
      // ── URL branch (SSRF guard + capped binary download, mirror web_fetch) ──
      const url = coerced.imageUrl!;
      let allowlist: string[] = [];
      try {
        allowlist = researchFetchAllowlist(loadConfig(), safeLoadDocParser(loadDocParserConfig));
      } catch {
        // Config read failure → empty allowlist (guard stays fail-closed).
      }
      try {
        await guard(url, allowlist);
      } catch (err) {
        return ssrfBlockedOutput(url, err);
      }

      let fetched: FetchedBinary;
      try {
        // The allowlist rides the options so the DEFAULT fetcher re-guards
        // every redirect hop (P1); injected test stubs ignore the extra arg.
        fetched = await fetchBinary(url, abort, { allowlist });
      } catch (err) {
        return buildFailureOutput(url, `下载图片失败：${err instanceof Error ? err.message : String(err)}。可先 web_search 找到可用来源，或请用户把图保存进项目后用 imagePath。`);
      }
      if (!fetched.ok) {
        return buildFailureOutput(url, `下载图片失败：HTTP ${fetched.status}。`, { status: fetched.status });
      }
      // Redirect re-validation (netGuard contract: callers re-validate per hop).
      if (fetched.finalUrl && fetched.finalUrl !== url) {
        try {
          await guard(fetched.finalUrl, allowlist);
        } catch (err) {
          return ssrfBlockedOutput(fetched.finalUrl, err);
        }
      }
      if (fetched.buffer.length === 0) {
        return buildFailureOutput(url, '下载的图片为空（0 字节）。');
      }
      if (fetched.buffer.length > ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES) {
        // Belt-and-suspenders: the DEFAULT fetcher already cuts mid-stream
        // (readBodyWithCap), an injected/custom fetcher is capped here.
        return buildFailureOutput(
          url,
          `图片过大（${fetched.buffer.length} 字节，超过 ${ANALYZE_IMAGE_MAX_DOWNLOAD_BYTES} 下载上限）。请换更小的图，或请用户把图保存进项目后用 imagePath。`,
          { bytes: fetched.buffer.length },
        );
      }
      buffer = fetched.buffer;
      const ct = fetched.contentType.split(';')[0].trim().toLowerCase();
      declaredMime = ct.startsWith('image/') ? ct : '';
    }

    // ── Vision kernel (never throws; three-layer dispatch R9b) ──
    let result: VisionAnalysisResult;
    try {
      result = await analyze({
        imageB64: buffer.toString('base64'),
        mimeType: declaredMime,
        prompt,
        projectDir,
      });
    } catch (err) {
      // Belt-and-suspenders (R8): the kernel never throws, but an unforeseen
      // failure must still degrade to a friendly output.
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err), source },
        'analyze_image: unexpected kernel failure',
      );
      return buildFailureOutput(source, `视觉分析失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (result.mode === 'manual') {
      return buildManualResponse(source, result);
    }
    return buildVisionOutput({ source, result });
  };
}

// Default handler wired into toolExecution (id aligns with the agent-side
// remoteToolProxy registration in agent/src/tool/builtin.ts).
export const analyzeImageHandler: ToolHandler = createAnalyzeImageHandler();

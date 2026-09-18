/**
 * Vision analysis kernel (Story 3.6 WP1, R9/R9b, design D3-D5).
 *
 * Shell-side seam shared by the research tool handlers (`analyze_image`,
 * `render_page` screenshots, `parse_document` scan fallback). The agent NEVER
 * calls vision directly — this kernel is the only place image bytes become a
 * multimodal parts message (agent 纯编排零网络, spec/agent/agent-tools.md).
 *
 * Three-layer dispatch (R9b):
 *   1. `visionModel` sidecar configured → pre-validate → call the model with
 *      a parts message;
 *   2. NOT configured → NEVER blind-call the main text model (a middleman that
 *      silently strips images turns the "analysis" into a hallucination — red
 *      line) → manual export;
 *   3. manual export (D5): image saved to `<project>/.orison/research-media/`
 *      + copied to the clipboard + suggestedPrompt returned, so the leader can
 *      relay the manual round-trip protocol (paste into a third-party vision
 *      chat, paste the answer back).
 *
 * Pre-validation (D3, pure code — zero new dependencies):
 *   - the media_type SENT always strictly matches the image bytes' real format
 *     (sniffed via magic bytes; Anthropic 400s on mismatch). A mismatched
 *     DECLARED mimeType is corrected to the sniffed format (the invariant is
 *     about what goes on the wire, and correcting beats rejecting — the bytes
 *     never change, so a rejection could never succeed on retry);
 *   - format whitelist jpeg/png/gif/webp (exactly the vision-API-supported set
 *     — anything else sniffs to null and fails friendly);
 *   - >5MB or longest edge >1568 → downscale via `nativeImage.resize` (survey:
 *     Anthropic per-image cap / recommended long edge).
 *
 * NEVER throws — every failure degrades to a friendly message or the manual
 * export (mirror of the `query_craft` handler contract). `mode` discriminates
 * the PROTOCOL (was a manual export package produced?), not success/failure:
 * a `vision`-mode result whose text explains a failure is the query_craft
 * "output carries the friendly miss" pattern.
 */
import { clipboard, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateText } from '@orison/model-protocols';
import type { ModelRef, TextGenerationResponse } from '@orison/shared-contracts';
import { readModelConfigFromDisk } from '../ipc/configIpc';
import { resolveModel } from '../ipc/modelGatewayIpc';
import { getLogger } from '../logger';
import { pruneMediaDirBestEffort } from './renderCapture';

// ── Limits + whitelist (D3) ──

/** Anthropic per-image payload cap (survey, multimodal-parsing). */
export const VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Recommended long-edge cap — larger images are downscaled before sending. */
export const VISION_MAX_EDGE = 1568;

export type SniffedImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** Formats both the sniffer recognizes and the vision APIs accept. */
export const VISION_FORMAT_WHITELIST: readonly SniffedImageFormat[] = ['png', 'jpeg', 'gif', 'webp'];

const MIME_BY_FORMAT: Record<SniffedImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Sniff the real image format from magic bytes. Pure (no electron, no fs) —
 * the DECLARED mimeType is never trusted blind: Anthropic strictly 400s when
 * media_type does not match the actual bytes, and middlemen/re-encoders may
 * hand back a different format than the caller asked for.
 */
export function sniffImageFormat(buffer: Buffer): SniffedImageFormat | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png'; // 89 50 4E 47 0D 0A 1A 0A
  }
  if (buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'; // FF D8 FF
  }
  if (buffer.length >= 6
    && buffer.toString('ascii', 0, 3) === 'GIF') {
    return 'gif'; // GIF87a / GIF89a
  }
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'; // RIFF....WEBP
  }
  return null;
}

// ── Pre-validation (pure code + nativeImage probe/resize) ──

export type PreparedVisionImage =
  | { ok: true; buffer: Buffer; mimeType: string; note?: string }
  | { ok: false; reason: string };

/**
 * Validate + normalize the image payload so the bytes/mimeType pair we finally
 * send always agrees (and fits the size budget). Never throws — parse failures
 * return `{ok:false, reason}` for the caller to surface.
 */
export function prepareVisionImage(imageB64: string, declaredMimeType: string): PreparedVisionImage {
  // Tolerate a data-URL-wrapped payload (defensive: some callers hand back the
  // full `data:image/png;base64,...` form).
  const b64 = imageB64.includes('base64,')
    ? imageB64.slice(imageB64.indexOf('base64,') + 'base64,'.length)
    : imageB64;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return { ok: false, reason: '图片 base64 解码失败' };
  }
  if (buffer.length === 0) {
    return { ok: false, reason: '图片数据为空' };
  }

  const sniffed = sniffImageFormat(buffer);
  if (!sniffed) {
    return { ok: false, reason: '无法识别图片格式（仅支持 jpeg/png/gif/webp）' };
  }

  const sniffedMime = MIME_BY_FORMAT[sniffed];
  const declared = declaredMimeType.trim().toLowerCase();
  const note = declared !== sniffedMime
    ? `声明的 mimeType(${declared || '(空)'} 与字节实际格式(${sniffedMime})不符，已按实际格式发送`
    : undefined;

  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) {
    // nativeImage cannot decode every whitelisted format from a buffer (some
    // gif/webp builds). Within the byte budget we can still send the original
    // bytes (vision APIs accept all four formats); oversized + undecodable is
    // the only dead end — we have no way to shrink it without new deps.
    if (buffer.length > VISION_MAX_IMAGE_BYTES) {
      return { ok: false, reason: '图片超过 5MB 且无法本地解码缩放' };
    }
    return { ok: true, buffer, mimeType: sniffedMime, note };
  }

  const { width, height } = img.getSize();
  if (buffer.length <= VISION_MAX_IMAGE_BYTES
    && Math.max(width, height) <= VISION_MAX_EDGE) {
    return { ok: true, buffer, mimeType: sniffedMime, note };
  }

  // Downscale (aspect ratio preserved — only the long edge is given). The
  // re-encoded PNG is the final payload, so mimeType matches by construction.
  const resized = width >= height
    ? img.resize({ width: VISION_MAX_EDGE })
    : img.resize({ height: VISION_MAX_EDGE });
  const png = resized.isEmpty() ? Buffer.alloc(0) : resized.toPNG();
  if (png.length > 0 && png.length <= VISION_MAX_IMAGE_BYTES) {
    return { ok: true, buffer: png, mimeType: 'image/png', note };
  }
  // Degenerate resize output — fall back to the original if it fits the byte
  // budget (edges over the cap but decodable is better than nothing), else fail.
  if (buffer.length <= VISION_MAX_IMAGE_BYTES) {
    return { ok: true, buffer, mimeType: sniffedMime, note };
  }
  return { ok: false, reason: '图片缩放失败且原图超过 5MB' };
}

// ── Kernel (three-layer dispatch) ──

export type VisionAnalysisResult =
  | { mode: 'vision'; text: string }
  | { mode: 'manual'; images: string[]; suggestedPrompt: string };

export async function runVisionAnalysis(opts: {
  imageB64: string;
  mimeType: string;
  prompt: string;
  projectDir: string;
}): Promise<VisionAnalysisResult> {
  let prepared: PreparedVisionImage;
  try {
    prepared = prepareVisionImage(opts.imageB64, opts.mimeType);
  } catch (err) {
    return { mode: 'vision', text: `图片预处理失败：${errMsg(err)}，无法进行视觉分析。` };
  }
  if (!prepared.ok) {
    return { mode: 'vision', text: `图片预处理失败：${prepared.reason}，无法进行视觉分析。` };
  }
  if (prepared.note) {
    getLogger().warn({ note: prepared.note }, 'visionAnalysis: image payload adjusted');
  }

  let resolved: ReturnType<typeof resolveModel>;
  try {
    const config = readModelConfigFromDisk();
    // R9b: no visionModel designated → manual export. The main text model is
    // NEVER blind-tried with an image (silent strip = hallucination, not a
    // degradation).
    if (!config.visionModel) {
      return exportManualVision(prepared.buffer, opts.prompt, opts.projectDir);
    }
    resolved = resolveModel(config.visionModel, config);
  } catch (err) {
    getLogger().warn(
      { err: errMsg(err) },
      'visionAnalysis: visionModel resolve failed — degrading to manual',
    );
    return exportManualVision(prepared.buffer, opts.prompt, opts.projectDir);
  }

  try {
    const response: TextGenerationResponse = await generateText(resolved, {
      model: resolved.modelId,
      // 09-12 usage-panel：视觉分析主调用 = vision-analysis 流程标签（design §0 表；
      // canary 探针是设置页诊断调用，刻意不标注）。
      taskType: 'vision-analysis',
      messages: [{
        role: 'user',
        content: [
          ...(opts.prompt ? [{ type: 'text' as const, text: opts.prompt }] : []),
          {
            type: 'image' as const,
            image: { b64Json: prepared.buffer.toString('base64'), mimeType: prepared.mimeType },
          },
        ],
      }],
    });
    return { mode: 'vision', text: response.text || '（视觉模型返回了空回复）' };
  } catch (err) {
    // Generation failure (network / endpoint rejects the image) degrades to
    // the manual round-trip, never a thrown error (R8 graceful degradation).
    getLogger().warn(
      { err: errMsg(err) },
      'visionAnalysis: vision generation failed — degrading to manual',
    );
    return exportManualVision(prepared.buffer, opts.prompt, opts.projectDir);
  }
}

/**
 * Manual export protocol (D5): save the image under
 * `<project>/.orison/research-media/<ts>-<rand>.png` (mkdir recursive), copy
 * it to the clipboard, and return the suggestedPrompt so the leader can relay
 * the round-trip to the user. The random suffix (P12, CR 2026-08-15) keeps
 * PARALLEL exports in the same millisecond from overwriting each other; the
 * directory-wide retention sweep runs on export too (research-media is
 * research-intermediate storage, never an asset store). The clipboard copy is
 * best-effort — the saved file is the durable artifact.
 */
function exportManualVision(buffer: Buffer, prompt: string, projectDir: string): VisionAnalysisResult {
  try {
    const dir = path.join(projectDir, '.orison', 'research-media');
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const rand = randomUUID().slice(0, 8);
    const img = nativeImage.createFromBuffer(buffer);
    let file: string;
    if (!img.isEmpty()) {
      file = path.join(dir, `${ts}-${rand}.png`);
      writeFileSync(file, img.toPNG());
      try {
        clipboard.writeImage(img);
      } catch (err) {
        getLogger().warn({ err: errMsg(err) }, 'visionAnalysis: clipboard copy failed (file export still ok)');
      }
    } else {
      // nativeImage could not decode (e.g. some webp builds) — save the raw
      // bytes under the sniffed extension and skip the clipboard copy.
      const ext = sniffImageFormat(buffer) ?? 'img';
      file = path.join(dir, `${ts}-${rand}.${ext}`);
      writeFileSync(file, buffer);
    }
    pruneMediaDirBestEffort(dir);
    return { mode: 'manual', images: [file], suggestedPrompt: prompt };
  } catch (err) {
    getLogger().warn({ err: errMsg(err) }, 'visionAnalysis: manual export failed');
    return { mode: 'vision', text: `图片无法分析：视觉模型未配置且手动导出失败（${errMsg(err)}）。` };
  }
}

// ── Canary probe (D4): silent-strip detection ──
//
// Middlemen that silently strip image parts are community-confirmed; a probe
// with a known answer is the mechanical gate against configuring such an
// endpoint as the visionModel (it would look like it works while every
// "analysis" is a hallucination).

/**
 * 64×64 PNG: white background, black「闭」glyph (project-name character).
 * Pre-generated base64 constant — nativeImage cannot draw text, and a
 * runtime-rendered probe would tie this check to system font availability.
 */
export const CANARY_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJ3SURBVHhe7ZrrjcIwEITTDF3QBDXQAi3QAR2kglRAAzRAAzRAATkNkpFv2HUW25GCvSPNj1vWwfvhR+LcMHeugQO9yQFwoDc5AA70JgfAgd7kADjQmxwAB3rTagDu9/t8vV45vDlVBfB4POZxHOf9fj8Pw/AyYltWNQAoPBQd+3A4/Mu73W7z5XKp6hLI1QA8n8+P4oOnaXrnocP8eakBNVfVAEAolDsXDEBQEwAw5HgYwtBut/voIHw6nV6fNwEAX8idgFOfHY/H1yhoHgCEhQ9/YzfA4hiGf2jLI+cb83duEgDuAWCrsHZwodrKzt+5SQDfKowYS1Gcl8q1KKvXDsABpAHwfF6ytHVi24xzQpGct0kAHK9hQNCu7QAcgAOIevedVgHAixxbWvXZP70IppR6bLYUxXmpXItsvSaVAIhPi4KlmFYU56VyLbL1mpQLAMOa22hTQiuK81K5Fi33WlAOAKl43ABhSjQPQCo+7nizALRfFz6fz+88KUcrivNSuRZ99togCwAtB8aiF6spAPjVtSEPh3kfqxkAWNE5xpZOipoBgINPjsWWioeaAYBzPI7BmPPaGR/UDACIp0E4Dk+pqTvB+F4fR+Lcjh+MtAVTK4rzUrkWVQcA4Zhbmu94Xc5tNEtFaQ9SUq5VqwBIidtoltYM7Q30TwGQFjzJ1qkC/xQA3AJzu9godGk7ZZcoq3UJAGkhxNBGPAz71Gt2dnjrnCtbr0klACzCAsrXloztc2mLXVJWr9cGAPG12fjlS4uHsnqd+geJWsK0iK+NLRTgpe21RFkAWpID4EBvcgAc6E0OgAO9yQFwoDc5AA70JgfAgd70B2j9X7ASl5uuAAAAAElFTkSuQmCC';

/** The character rendered into {@link CANARY_IMAGE_B64} — the expected answer. */
export const CANARY_EXPECTED_CHAR = '闭';

/** The probe question — asks for the character only, so the check is exact. */
export const CANARY_PROMPT = '这张小图里写了一个汉字，请只回答那个字本身。';

export type VisionCanaryResult =
  | { ok: true; answer: string }
  | {
      ok: false;
      reason: 'resolve-failed' | 'generate-failed' | 'silent-strip';
      message: string;
    };

/**
 * Probe a configured vision model with a known-answer image (D4). Calls the
 * model DIRECTLY — not via `runVisionAnalysis` — because the whole point is to
 * distinguish "call succeeded but the image was ignored" (silent-strip) from
 * transport failures. Settings-page wiring lands in WP10; this is the kernel.
 * Never throws — every outcome is a structured verdict.
 */
export async function canaryProbeVision(ref: ModelRef): Promise<VisionCanaryResult> {
  let resolved: ReturnType<typeof resolveModel>;
  try {
    resolved = resolveModel(ref);
  } catch (err) {
    return { ok: false, reason: 'resolve-failed', message: `无法解析视觉模型配置：${errMsg(err)}` };
  }

  let response: TextGenerationResponse;
  try {
    response = await generateText(resolved, {
      model: resolved.modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'text' as const, text: CANARY_PROMPT },
          {
            type: 'image' as const,
            image: { b64Json: CANARY_IMAGE_B64, mimeType: 'image/png' },
          },
        ],
      }],
    });
  } catch (err) {
    return { ok: false, reason: 'generate-failed', message: `视觉探针调用失败：${errMsg(err)}` };
  }

  const answer = (response.text ?? '').trim();
  if (!answer.includes(CANARY_EXPECTED_CHAR)) {
    return {
      ok: false,
      reason: 'silent-strip',
      message: `视觉探针未通过：模型回复「${answer.slice(0, 80) || '(空)'}」不包含图中的「${CANARY_EXPECTED_CHAR}」——该端点很可能静默剥离了图片（剥图=幻觉风险），请更换视觉模型或改用手动模式。`,
    };
  }
  return { ok: true, answer };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

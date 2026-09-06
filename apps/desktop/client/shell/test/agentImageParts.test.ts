/**
 * resolveImageParts 单测（task 09-01 B3 / dogfood #45，design §2.3 + 复查 M1）。
 *
 * 七态主干：无图快径（引用不变）/ >5MB 两路都归一（M1——vision=true 直传路径也必须过
 * prepareVisionImage）/ vision=true 直传 b64 part / vision 缺席 + visionModel 转述（替换
 * 文本 part + 缓存写入）/ 缓存命中（第二次 generateText 零调用）/ 无 visionModel 降级文本
 * / 路径逃逸拒收。外加：转述失败降级、畸形 part、b64 内联 part 原样过、串行转述、同图
 * 去重、跨项目同名指纹消歧、指纹 miss 存在回退。
 *
 * 第二个 describe = 09-01 CR patch 批（SH-b）：CR-006 空 path 降级 / CR-007 signal 贯穿
 * + 600s ceiling（fake timers）/ CR-019 直传与转述两路归一缓存（文件已删零 IO 实证）/
 * CR-001b projectPath 精确根解析与失效降级 / CR-003a 转述进度事件发射矩阵。
 *
 * Mock 面：electron（nativeImage——真 prepareVisionImage 的解码/缩放探针）、configIpc
 * （readModelConfigFromDisk——经注入缝消费）、@orison/model-protocols（generateText
 * 转述调用）、logger。真实面：resolveImageParts 本体 + 真 prepareVisionImage + 真
 * pathGuard（buildProjectPath assertWithinProject）+ 真 fs（tmp 项目目录）。
 * visionAnalysis/resolveModel/config 读经 agentIpc 的防环注入缝（installAgentImagePartsCore）挂入。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@orison/shared-contracts';
import { rmBestEffort } from './rmBestEffort';

const { nativeImage, readModelConfigFromDisk, generateText, warn } = vi.hoisted(() => ({
  nativeImage: { createFromBuffer: vi.fn() },
  readModelConfigFromDisk: vi.fn(),
  generateText: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({ nativeImage, clipboard: { writeImage: vi.fn() } }));
vi.mock('../main/ipc/configIpc', () => ({ readModelConfigFromDisk }));
vi.mock('@orison/model-protocols', () => ({ generateText }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info: vi.fn(), error: vi.fn() }) }));

import { prepareVisionImage } from '../main/research/visionAnalysis';
import {
  IMAGE_RELAY_CEILING_MS,
  IMAGE_RELAY_PROMPT,
  __clearImageRelayCacheForTest,
  installAgentImagePartsCore,
  resolveImageParts,
} from '../main/ipc/agentImageParts';

// ── Fixtures ──

const BASE_TMP = path.join(process.cwd(), 'test-tmp-agent-image-parts');
const PROJECT_DIR = path.join(BASE_TMP, 'proj');
const OTHER_PROJECT_DIR = path.join(BASE_TMP, 'other-proj');
const IMAGES_DIR = path.join(PROJECT_DIR, 'inbox', 'images');
const OTHER_IMAGES_DIR = path.join(OTHER_PROJECT_DIR, 'inbox', 'images');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REENCODED_PNG = Buffer.concat([PNG_MAGIC, Buffer.from('re-encoded-png-bytes')]);

function pngBytes(padding = 64): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(padding, 7)]);
}

/** Controllable nativeImage stand-in（mirror visionAnalysis.test 同款形态）。 */
function makeImage(opts: { width?: number; height?: number; empty?: boolean } = {}) {
  const size = { width: opts.width ?? 64, height: opts.height ?? 64 };
  const img = {
    isEmpty: () => opts.empty === true,
    getSize: () => ({ ...size }),
    resize: vi.fn(() => img),
    toPNG: () => REENCODED_PNG,
  };
  return img;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeImage(dir: string, name: string, bytes: Buffer): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
  return `inbox/images/${name}`;
}

/** 指针 part（B2 buildImagesParts 的字面线上形态）。 */
function pointerPart(relPath: string, bytes: Buffer) {
  return { type: 'image' as const, image: { path: relPath, b64hash: sha256Hex(bytes) } };
}

const VISION_MAIN: ResolvedModel = {
  keyId: 'k1',
  modelId: 'gpt-4o-mini',
  protocol: 'openai-compatible',
  baseUrl: 'https://main.example.com/v1',
  apiKey: 'sk-main',
  capability: 'text',
  vision: true,
};

const TEXT_MAIN: ResolvedModel = {
  keyId: 'k1',
  modelId: 'qwen-max',
  protocol: 'openai-compatible',
  baseUrl: 'https://main.example.com/v1',
  apiKey: 'sk-main',
  capability: 'text',
};

const VISION_MODEL_REF = { keyId: 'kv', modelId: 'qwen-vl-max' };
const RESOLVED_RELAY_MODEL: ResolvedModel = {
  keyId: 'kv',
  modelId: 'qwen-vl-max',
  protocol: 'openai-compatible',
  baseUrl: 'https://relay.example.com/v1',
  apiKey: 'sk-vision',
  capability: 'text',
};

const resolveModelRefMock = vi.fn(() => RESOLVED_RELAY_MODEL);

/** 带 visionModel 的 config 形态（readModelConfigFromDisk mock 返回值）。 */
function configWithVision() {
  return { keys: [], visionModel: { ...VISION_MODEL_REF } };
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearImageRelayCacheForTest();
  installAgentImagePartsCore({
    prepareImage: prepareVisionImage,
    resolveModelRef: resolveModelRefMock,
    readModelConfig: readModelConfigFromDisk,
  });
  nativeImage.createFromBuffer.mockReset().mockReturnValue(makeImage());
  readModelConfigFromDisk.mockReset().mockReturnValue(configWithVision());
  resolveModelRefMock.mockReset().mockReturnValue(RESOLVED_RELAY_MODEL);
  rmBestEffort(BASE_TMP);
  mkdirSync(IMAGES_DIR, { recursive: true });
});

afterEach(() => {
  rmBestEffort(BASE_TMP);
});

describe('resolveImageParts（B3 generate 缝图片处理）', () => {
  it('无图快径：原 messages 引用返回（string content / 无图 parts / tools 载荷零触碰）', async () => {
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '你好' },
      { role: 'user', content: [{ type: 'text', text: '多模态但无图' }] },
      { role: 'assistant', content: '好的', toolCalls: [{ id: 't1', name: 'x', arguments: '{}' }] },
    ];

    const result = await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] });

    expect(result).toBe(messages); // 同一数组引用——调用方零重打包
    expect(generateText).not.toHaveBeenCalled();
  });

  it('vision=true 直传：指针 part 改写为 b64 part（mime 按字节嗅探），旁支 parts/消息引用保留', async () => {
    const bytes = pngBytes(128);
    const rel = writeImage(IMAGES_DIR, 'cat.png', bytes);
    const userMsg = {
      role: 'user',
      content: [{ type: 'text', text: '这是什么' }, pointerPart(rel, bytes)],
    };
    const otherMsg = { role: 'assistant', content: '之前的话' };
    const messages = [otherMsg, userMsg];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      role: string;
      content: unknown;
    }>;

    expect(result[0]).toBe(otherMsg); // 未受影响消息引用不变
    expect(result[1]).not.toBe(userMsg); // 受影响消息浅拷贝
    expect(result[1].content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image', image: { b64Json: bytes.toString('base64'), mimeType: 'image/png' } },
    ]);
    // 入参不被 mutate（盘上历史/调用方持有的原数组保持指针形态）。
    expect((userMsg.content as unknown[])[1]).toMatchObject({ type: 'image', image: { path: rel } });
    expect(generateText).not.toHaveBeenCalled(); // 直传路零转述调用
  });

  it('M1-直传路：>5MB 图也必须归一（resize 后 re-encode PNG，非原字节直发）', async () => {
    const bigBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(6 * 1024 * 1024, 3)]);
    const rel = writeImage(IMAGES_DIR, 'big.png', bigBytes);
    nativeImage.createFromBuffer.mockReturnValue(makeImage({ width: 800, height: 600 })); // 可解码 → 归一可缩

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '看图' }, pointerPart(rel, bigBytes)],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string; mimeType: string } }>;
    }>;

    const wirePart = result[0].content[1];
    expect(wirePart.type).toBe('image');
    expect(wirePart.image.b64Json).toBe(REENCODED_PNG.toString('base64')); // 归一后字节，非 6MB 原文
    expect(wirePart.image.mimeType).toBe('image/png');
  });

  it('M1-转述路：>5MB 图转述前同样归一（识图模型收到的是 re-encode 后字节）', async () => {
    const bigBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(6 * 1024 * 1024, 3)]);
    const rel = writeImage(IMAGES_DIR, 'big2.png', bigBytes);
    nativeImage.createFromBuffer.mockReturnValue(makeImage({ width: 800, height: 600 }));
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '一张图' });

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '看图' }, pointerPart(rel, bigBytes)],
    }];

    const result = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(result[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 一张图' });
    const [, request] = generateText.mock.calls[0] as unknown as [
      unknown,
      { messages: Array<{ content: Array<{ type: string; image?: { b64Json: string } }> }> },
    ];
    expect(request.messages[0].content[1].image?.b64Json).toBe(REENCODED_PNG.toString('base64'));
  });

  it('vision 缺席 + visionModel：转述替换文本 part + 固定 prompt + resolveModelRef(visionModel, config)', async () => {
    const bytes = pngBytes(96);
    const rel = writeImage(IMAGES_DIR, 'scene.png', bytes);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '一只戴着兜帽的猫' });

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '这是什么' }, pointerPart(rel, bytes)],
    }];

    const result = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(result[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 一只戴着兜帽的猫' });
    expect(resolveModelRefMock).toHaveBeenCalledWith(VISION_MODEL_REF, expect.objectContaining({ visionModel: VISION_MODEL_REF }));
    expect(generateText).toHaveBeenCalledTimes(1);
    const [resolvedArg, request] = generateText.mock.calls[0] as unknown as [
      ResolvedModel,
      { messages: Array<{ content: Array<{ type: string; text?: string; image?: { b64Json: string; mimeType: string } }> }> },
    ];
    expect(resolvedArg).toBe(RESOLVED_RELAY_MODEL);
    expect(request.messages[0].content).toEqual([
      { type: 'text', text: IMAGE_RELAY_PROMPT },
      { type: 'image', image: { b64Json: bytes.toString('base64'), mimeType: 'image/png' } },
    ]);
  });

  it('缓存命中：同图第二轮零识图调用（mock 计数）', async () => {
    const bytes = pngBytes(80);
    const rel = writeImage(IMAGES_DIR, 'twice.png', bytes);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '第二次不再调用' });

    const build = () => [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)],
    }];

    const first = (await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const second = (await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(generateText).toHaveBeenCalledTimes(1); // 第二轮缓存命中
    expect(second[0].content[1]).toEqual(first[0].content[1]);
    expect(second[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 第二次不再调用' });
  });

  it('同载荷同图重复（历史重放多消息）：一次转述，两处同文替换', async () => {
    const bytes = pngBytes(72);
    const rel = writeImage(IMAGES_DIR, 'repeat.png', bytes);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '同一张图' });

    const messages = [
      { role: 'user', content: [{ type: 'text', text: '第一轮' }, pointerPart(rel, bytes)] },
      { role: 'assistant', content: '答' },
      { role: 'user', content: [{ type: 'text', text: '第二轮' }, pointerPart(rel, bytes)] },
    ];

    const result = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: unknown;
    }>;

    expect(generateText).toHaveBeenCalledTimes(1);
    expect((result[0].content as unknown[])[1]).toEqual({ type: 'text', text: '[图片转述] 同一张图' });
    expect((result[2].content as unknown[])[1]).toEqual({ type: 'text', text: '[图片转述] 同一张图' });
  });

  it('无 visionModel：降级说明文本替换（never-throws），不盲试主模型，且降级不入缓存（配置后即愈）', async () => {
    const bytes = pngBytes(88);
    const rel = writeImage(IMAGES_DIR, 'unconfigured.png', bytes);
    readModelConfigFromDisk.mockReturnValue({ keys: [] }); // 无 visionModel

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)],
    }];

    const first = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(first[0].content[1]).toEqual({
      type: 'text',
      text: '[图片未识别：未配置识图模型，可在设置「研究与视觉」配置。请提示用户。]',
    });
    expect(resolveModelRefMock).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled(); // 红线：主文本模型绝不被盲试

    // 配置后同图立即走转述（降级结果未被缓存）。
    readModelConfigFromDisk.mockReturnValue(configWithVision());
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '现在能看了' });
    const second = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(second[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 现在能看了' });
  });

  it('转述调用失败：失败占位文本（含一句错误摘要），不 throw、不入缓存', async () => {
    const bytes = pngBytes(60);
    const rel = writeImage(IMAGES_DIR, 'flaky.png', bytes);
    generateText.mockRejectedValue(new Error('endpoint 502'));

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)],
    }];

    const result = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(result[0].content[1]).toEqual({
      type: 'text',
      text: '[图片未识别：识图转述失败，endpoint 502。请提示用户。]',
    });

    // 不入缓存：失败后重跑（识图恢复）应重新调用。
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '恢复了' });
    const retry = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(retry[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 恢复了' });
  });

  it('路径逃逸拒收：.. 穿越 → 路径不合法降级；不存在的路径 → 未找到降级（均不调识图）', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '问' }, pointerPart('../../secrets.png', pngBytes())] },
      { role: 'user', content: [{ type: 'text', text: '问2' }, pointerPart('inbox/images/ghost.png', pngBytes())] },
    ];

    const result = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect((result[0].content[1].text as string)).toContain('图片路径不合法');
    expect((result[1].content[1].text as string)).toContain('未找到图片文件');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('畸形 image part（无 path 无 b64）→ 降级文本；b64 内联 part 非本模块管辖，原样过', async () => {
    const b64Part = { type: 'image', image: { b64Json: 'aGVsbG8=', mimeType: 'image/png' } };
    const malformed = { type: 'image', image: {} };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '问' }, malformed, b64Part] },
    ];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: unknown[];
    }>;

    expect(result[0].content[1]).toEqual({ type: 'text', text: expect.stringContaining('图片消息格式异常') });
    expect(result[0].content[2]).toBe(b64Part); // 引用不变
  });

  it('多图串行转述（API 并发纪律）：并发峰值恒 1，逐图替换', async () => {
    const bytesA = pngBytes(40);
    const bytesB = pngBytes(56);
    const relA = writeImage(IMAGES_DIR, 'a.png', bytesA);
    const relB = writeImage(IMAGES_DIR, 'b.png', bytesB);
    let active = 0;
    let maxActive = 0;
    generateText.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { model: 'qwen-vl-max', text: '描述' };
    });

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '两图' }, pointerPart(relA, bytesA), pointerPart(relB, bytesB)],
    }];

    const result = (await resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1); // 串行：无并发重叠
    expect(result[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 描述' });
    expect(result[0].content[2]).toEqual({ type: 'text', text: '[图片转述] 描述' });
  });

  it('跨项目同名消歧：指纹命中的项目字节被采用（存在匹配仅兜底）', async () => {
    const bytesA = pngBytes(100);
    const bytesB = pngBytes(200);
    writeImage(IMAGES_DIR, 'same.png', bytesA); // proj（注册序在前）
    writeImage(OTHER_IMAGES_DIR, 'same.png', bytesB); // other-proj（指针指向它的字节）

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart('inbox/images/same.png', bytesB)],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, {
      listProjectDirs: () => [PROJECT_DIR, OTHER_PROJECT_DIR],
    })) as Array<{ content: Array<{ type: string; image: { b64Json: string } }> }>;

    expect(result[0].content[1].image.b64Json).toBe(bytesB.toString('base64')); // 指纹胜出，非首个存在匹配
  });

  it('指纹 miss（落盘后字节被改）：回退存在匹配并 warn，消息继续流', async () => {
    const staleBytes = pngBytes(120);
    const currentBytes = pngBytes(121);
    const rel = writeImage(IMAGES_DIR, 'changed.png', currentBytes);

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart(rel, staleBytes)], // 指纹是旧字节
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;

    expect(result[0].content[1].image.b64Json).toBe(currentBytes.toString('base64'));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: rel }),
      expect.stringContaining('hash miss'),
    );
  });
});

describe('09-01 CR patch 批（SH-b：CR-006 / CR-007 / CR-019 / CR-001b / CR-003a）', () => {
  it('CR-006：空串 path / 空串 b64Json 的 image part 归畸形降级（不再穿透协议层）', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '问' },
        { type: 'image', image: { path: '', b64hash: 'deadbeef' } },
        { type: 'image', image: { b64Json: '' } },
      ],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    // vision=true 路下这两个空形 part 此前原样穿透协议层（指针判定 length>0 拒收 +
    // 畸形判定 typeof-only 放行 = 双守卫缝）。
    expect(result[0].content[1]).toEqual({ type: 'text', text: expect.stringContaining('图片消息格式异常') });
    expect(result[0].content[2]).toEqual({ type: 'text', text: expect.stringContaining('图片消息格式异常') });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('CR-007：signal 贯穿转述调用——协议层收到 ceiling 包装信号，调用方取消原样穿透（含 reason）', async () => {
    const bytes = pngBytes(64);
    const rel = writeImage(IMAGES_DIR, 'cr007-signal.png', bytes);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '描述' });
    const controller = new AbortController();
    const messages = [{ role: 'user', content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)] }];

    await resolveImageParts(messages, TEXT_MAIN, {
      listProjectDirs: () => [PROJECT_DIR],
      signal: controller.signal,
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    const ctx = (generateText.mock.calls[0] as unknown as [unknown, unknown, { signal?: AbortSignal }])[2];
    expect(ctx?.signal).toBeInstanceOf(AbortSignal);
    expect(ctx?.signal).not.toBe(controller.signal); // 600s ceiling 包装信号（非裸透传）
    controller.abort('user-stop');
    expect(ctx?.signal?.aborted).toBe(true); // 停止钮对转述调用生效
    expect(ctx?.signal?.reason).toBe('user-stop'); // 取消原因原样穿透（mirror signalWithCeiling adopt 语义）
  });

  it('CR-007：转述调用 600s ceiling——上限到点中止转述并降级文本（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const bytes = pngBytes(64);
      const rel = writeImage(IMAGES_DIR, 'cr007-ceiling.png', bytes);
      generateText.mockImplementation(
        (_resolved: unknown, _request: unknown, ctx: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            ctx.signal?.addEventListener('abort', () => {
              const reason: unknown = ctx.signal?.reason;
              reject(reason instanceof Error ? reason : new Error('relay aborted'));
            });
          }),
      );
      const messages = [{ role: 'user', content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)] }];

      const pending = resolveImageParts(messages, TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] });
      await vi.advanceTimersByTimeAsync(IMAGE_RELAY_CEILING_MS);
      const result = (await pending) as Array<{ content: Array<{ type: string; text?: string }> }>;

      expect(result[0].content[1].type).toBe('text');
      expect(result[0].content[1].text).toContain('识图转述失败');
      expect(result[0].content[1].text).toContain('exceeded its total ceiling'); // ceiling 的 TimeoutError 消息
    } finally {
      vi.useRealTimers();
    }
  });

  it('CR-019：vision 直传路归一缓存——第二轮零读盘/零归一（文件已删仍直传缓存产物）', async () => {
    const bytes = pngBytes(96);
    const rel = writeImage(IMAGES_DIR, 'cr019-direct.png', bytes);
    const build = () => [{
      role: 'user',
      content: [{ type: 'text', text: '看图' }, pointerPart(rel, bytes)],
    }];

    const first = (await resolveImageParts(build(), VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;
    const b64First = first[0].content[1].image.b64Json;
    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(1); // 第一轮归一一次

    // 盘上证据消失——第二轮必须零 IO（读盘/哈希/归一全免）仍产出同形态 part。
    rmBestEffort(path.join(IMAGES_DIR, 'cr019-direct.png'));
    const second = (await resolveImageParts(build(), VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;

    expect(second[0].content[1].image.b64Json).toBe(b64First);
    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(1); // 归一未重跑
    expect(generateText).not.toHaveBeenCalled(); // 直传路零转述
  });

  it('CR-019：转述路指针命中——第二轮零读盘零转述调用（文件已删仍复用转述文本）', async () => {
    const bytes = pngBytes(76);
    const rel = writeImage(IMAGES_DIR, 'cr019-relay.png', bytes);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '首轮转述' });
    const build = () => [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)],
    }];

    const first = (await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(first[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 首轮转述' });
    expect(generateText).toHaveBeenCalledTimes(1);

    rmBestEffort(path.join(IMAGES_DIR, 'cr019-relay.png'));
    const second = (await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(generateText).toHaveBeenCalledTimes(1); // 指针命中：零重复计费 + 零读盘
    expect(second[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 首轮转述' });
  });

  it('CR-019：归一条目跨模型切换复用——直传缓存后切转述，识图请求用缓存 b64（文件已删）', async () => {
    const bytes = pngBytes(84);
    const rel = writeImage(IMAGES_DIR, 'cr019-switch.png', bytes);
    const build = () => [{
      role: 'user',
      content: [{ type: 'text', text: '看' }, pointerPart(rel, bytes)],
    }];

    const direct = (await resolveImageParts(build(), VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;
    const cachedB64 = direct[0].content[1].image.b64Json;
    expect(generateText).not.toHaveBeenCalled();

    rmBestEffort(path.join(IMAGES_DIR, 'cr019-switch.png'));
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '切换后的转述' });
    const relayed = (await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(relayed[0].content[1]).toEqual({ type: 'text', text: '[图片转述] 切换后的转述' });
    const [, request] = generateText.mock.calls[0] as unknown as [
      unknown,
      { messages: Array<{ content: Array<{ type: string; image?: { b64Json: string } }> }> },
    ];
    expect(request.messages[0].content[1].image?.b64Json).toBe(cachedB64); // 归一产物复用，非重读
  });

  it('CR-001b：projectPath 精确根解析——不扫注册库（空候选清单仍解析成功）', async () => {
    const bytes = pngBytes(68);
    const rel = writeImage(IMAGES_DIR, 'cr001b-precise.png', bytes);
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '问' },
        { type: 'image', image: { path: rel, b64hash: sha256Hex(bytes), projectPath: PROJECT_DIR } },
      ],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;

    expect(result[0].content[1].image.b64Json).toBe(bytes.toString('base64'));
  });

  it('CR-001b：精确指针失效即失效——项目目录不存在 → 降级文本，不回退注册库扫描', async () => {
    const bytes = pngBytes(68);
    // 真项目里同路径文件存在（扫描路本可命中）——精确根失效必须不回退。
    const rel = writeImage(IMAGES_DIR, 'cr001b-ghost-proj.png', bytes);
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '问' },
        {
          type: 'image',
          image: { path: rel, b64hash: sha256Hex(bytes), projectPath: path.join(BASE_TMP, 'no-such-project') },
        },
      ],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(result[0].content[1].text).toContain('项目目录不存在');
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled(); // 未走到归一
  });

  it('CR-001b：精确根下文件缺失 → 降级文本，不回退扫描', async () => {
    const bytes = pngBytes(68);
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '问' },
        {
          type: 'image',
          image: { path: 'inbox/images/never-written.png', b64hash: sha256Hex(bytes), projectPath: PROJECT_DIR },
        },
      ],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;

    expect(result[0].content[1].text).toContain('未找到图片文件');
  });

  it('CR-001b：精确根指纹 miss（盘上字节被改）→ warn + 用现存字节（mirror 存在匹配语义）', async () => {
    const staleBytes = pngBytes(120);
    const currentBytes = pngBytes(121);
    const rel = writeImage(IMAGES_DIR, 'cr001b-changed.png', currentBytes);
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '问' },
        {
          type: 'image',
          image: { path: rel, b64hash: sha256Hex(staleBytes), projectPath: PROJECT_DIR }, // 指纹是旧字节
        },
      ],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;

    expect(result[0].content[1].image.b64Json).toBe(currentBytes.toString('base64'));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: rel, projectPath: PROJECT_DIR }),
      expect.stringContaining('precise-root image hash miss'),
    );
  });

  it('CR-001b：非 string projectPath（畸形形态）视为缺席——回落既有扫描路', async () => {
    const bytes = pngBytes(68);
    const rel = writeImage(IMAGES_DIR, 'cr001b-fallback.png', bytes);
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '问' },
        { type: 'image', image: { path: rel, b64hash: sha256Hex(bytes), projectPath: 123 } },
      ],
    }];

    const result = (await resolveImageParts(messages, VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR] })) as Array<{
      content: Array<{ type: string; image: { b64Json: string } }>;
    }>;

    expect(result[0].content[1].image.b64Json).toBe(bytes.toString('base64'));
  });

  it('CR-003a：多图串行转述——每图开始/完成各一发 {current,total}，按处理序推进', async () => {
    const bytesA = pngBytes(44);
    const bytesB = pngBytes(52);
    const relA = writeImage(IMAGES_DIR, 'cr003a-a.png', bytesA);
    const relB = writeImage(IMAGES_DIR, 'cr003a-b.png', bytesB);
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '描述' });
    const events: Array<{ current: number; total: number }> = [];

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: '两图' }, pointerPart(relA, bytesA), pointerPart(relB, bytesB)],
    }];
    await resolveImageParts(messages, TEXT_MAIN, {
      listProjectDirs: () => [PROJECT_DIR],
      onRelayProgress: (p) => events.push({ ...p }),
    });

    expect(events).toEqual([
      { current: 1, total: 2 }, // 图 1 开始
      { current: 1, total: 2 }, // 图 1 完成
      { current: 2, total: 2 }, // 图 2 开始
      { current: 2, total: 2 }, // 图 2 完成
    ]);
  });

  it('CR-003a：直传路/缓存全命中不发；转述车道照发（含 not-configured 完成）', async () => {
    const bytes = pngBytes(56);
    const rel = writeImage(IMAGES_DIR, 'cr003a-emit.png', bytes);
    const events: Array<{ current: number; total: number }> = [];
    const collect = (p: { current: number; total: number }) => events.push({ ...p });
    const build = () => [{
      role: 'user',
      content: [{ type: 'text', text: '问' }, pointerPart(rel, bytes)],
    }];

    // 直传路（vision=true）：零发射。
    await resolveImageParts(build(), VISION_MAIN, { listProjectDirs: () => [PROJECT_DIR], onRelayProgress: collect });
    expect(events).toEqual([]);

    // 转述车道进入即发射：not-configured（未配 visionModel）也算开始/完成各一发。
    readModelConfigFromDisk.mockReturnValue({ keys: [] });
    await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR], onRelayProgress: collect });
    expect(events).toEqual([{ current: 1, total: 1 }, { current: 1, total: 1 }]);

    // 配置后真转述一次 → 又一对开始/完成；随后缓存全命中 → 零新增。
    readModelConfigFromDisk.mockReturnValue(configWithVision());
    generateText.mockResolvedValue({ model: 'qwen-vl-max', text: '描述' });
    events.length = 0;
    await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR], onRelayProgress: collect });
    expect(events).toEqual([{ current: 1, total: 1 }, { current: 1, total: 1 }]);
    await resolveImageParts(build(), TEXT_MAIN, { listProjectDirs: () => [PROJECT_DIR], onRelayProgress: collect });
    expect(events).toEqual([{ current: 1, total: 1 }, { current: 1, total: 1 }]); // 全命中零新增
  });
});

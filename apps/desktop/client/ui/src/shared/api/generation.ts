import type {
  CliModelDiscoveryResult,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageInput,
  ListCliModelsRequest,
  ListRemoteModelsRequest,
  ModelRef,
  RemoteModel,
  TextGenerationRequest,
  TextGenerationResponse,
} from '@orison/shared-contracts';

export type { RemoteModel };

export type ImageGenerationParams = {
  size?: string;
  n?: number;
  quality?: string;
  background?: string;
  outputFormat?: string;
};

type GenerateImageInput = {
  ref: ModelRef;
  prompt: string;
  params: ImageGenerationParams;
  image?: ImageInput;
  mask?: ImageInput;
};

type GenerateTextInput = {
  ref: ModelRef;
  request: TextGenerationRequest;
};

export async function loadRemoteModels(request: ListRemoteModelsRequest): Promise<RemoteModel[]> {
  if (window.orisonDesktop?.listRemoteModels) {
    return window.orisonDesktop.listRemoteModels(request);
  }
  throw new Error('Desktop model provider bridge is unavailable');
}

// 09-12 agy provider W4：CLI 形态（agy）模型发现——`agy models` TSV 解析，类型化
// 结果（未登录/路径缺失/失败三态带 UI 引导语义）。
export async function discoverCliModels(request: ListCliModelsRequest): Promise<CliModelDiscoveryResult> {
  if (window.orisonDesktop?.listCliModels) {
    return window.orisonDesktop.listCliModels(request);
  }
  throw new Error('Desktop model provider bridge is unavailable');
}

export async function generateImage({
  ref,
  prompt,
  params,
  image,
  mask,
}: GenerateImageInput): Promise<ImageGenerationResponse> {
  if (!window.orisonDesktop?.generateImage) {
    throw new Error('Desktop model gateway is unavailable');
  }
  const request: ImageGenerationRequest = {
    model: ref.modelId,
    prompt,
  };
  if (params.size) request.size = params.size;
  if (params.n) request.n = params.n;
  if (params.quality) request.quality = params.quality;
  if (params.background) request.background = params.background;
  if (params.outputFormat) request.outputFormat = params.outputFormat;
  if (image) request.image = image;
  if (mask) request.mask = mask;
  return window.orisonDesktop.generateImage({ ref, request });
}

async function _generateText({ ref, request }: GenerateTextInput): Promise<TextGenerationResponse> {
  if (!window.orisonDesktop?.generateText) {
    throw new Error('Desktop model gateway is unavailable');
  }
  return window.orisonDesktop.generateText({ ref, request });
}

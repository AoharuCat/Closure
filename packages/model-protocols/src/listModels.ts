import type { RemoteModel } from '@orison/shared-contracts';
import { resolveModelInfo } from '@orison/shared-contracts';
import { getInsecureDispatcher, getJson, normalizeBaseUrl } from './http';
import { ProtocolHttpError } from './errors';
import type { ListModelsRequest } from './types';

export async function listModels(request: ListModelsRequest): Promise<RemoteModel[]> {
  const url = `${normalizeBaseUrl(request.baseUrl)}/models`;
  // 09-12 子3 §3 ⑦：自定义头并入发现请求（ad-hoc 首设 key 场景的网关鉴权闭环）——
  // 同名覆盖内建鉴权头；fallback 重试同样携带。
  const authHeaders: Record<string, string> = request.protocol === 'anthropic-compatible'
    ? { 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${request.apiKey}` };
  const headers = { ...authHeaders, ...request.headers };
  const dispatcher = request.insecure === true ? getInsecureDispatcher() : undefined;
  let body: { data?: Array<{ id?: string }> };
  try {
    body = await getJson<{ data?: Array<{ id?: string }> }>({
      url,
      headers,
      signal: request.signal,
      dispatcher,
    });
  } catch (error) {
    const fallbackUrl = deepSeekAnthropicModelsFallbackUrl(request);
    if (!(error instanceof ProtocolHttpError) || error.status !== 404 || !fallbackUrl) {
      throw error;
    }
    body = await getJson<{ data?: Array<{ id?: string }> }>({
      url: fallbackUrl,
      headers: { authorization: `Bearer ${request.apiKey}`, ...request.headers },
      signal: request.signal,
      dispatcher,
    });
  }

  return (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => {
      const info = resolveModelInfo(id);
      return { id, capability: info.capability, alias: info.alias };
    });
}

function deepSeekAnthropicModelsFallbackUrl(request: ListModelsRequest): string | null {
  if (request.protocol !== 'anthropic-compatible') return null;

  const base = request.baseUrl.replace(/\/+$/, '');
  if (!/\/anthropic$/i.test(base)) return null;

  return `${base.replace(/\/anthropic$/i, '')}/models`;
}

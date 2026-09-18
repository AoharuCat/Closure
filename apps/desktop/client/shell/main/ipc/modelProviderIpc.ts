import { ipcMain } from 'electron';
import type { ListRemoteModelsRequest, ModelProtocol, RemoteModel } from '@orison/shared-contracts';
import { listModels } from '@orison/model-protocols';
import { readModelConfigFromDisk } from './configIpc';

function resolveListModelsRequest(request: ListRemoteModelsRequest): {
  protocol: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  insecure?: boolean;
} {
  if (request.keyId) {
    // CR-25：keyId 路径读盘合并键自带 customHeaders/verifySsl（ipc.ts 契注意图——
    // 「the shell reads the persisted key's own fields」；协议层 listModels 已支持
    // headers/insecure，此前 shell 未接 = 网关鉴权键的模型发现恒 401/431）。键文件
    // 读取与 configIpc 同源（readModelConfigFromDisk 单源，不另开读盘路径）。
    const config = readModelConfigFromDisk();
    const key = config.keys.find((entry) => entry.id === request.keyId);
    if (!key) throw new Error(`Model key '${request.keyId}' not found`);
    // 09-12 agy provider：CLI 形态键（无 HTTP 凭据）不走本端点——其模型发现走
    // agy CLI 专属通道（W4 接线），这里响亮拒绝而非发空 baseUrl 的 HTTP 请求。
    if (key.protocol === 'antigravity-cli' || !key.baseUrl || !key.apiKey) {
      throw new Error(
        `Model key '${request.keyId}' has no HTTP baseUrl/apiKey (CLI-form keys are discovered via the Antigravity CLI, not list-remote-models)`,
      );
    }
    return {
      protocol: key.protocol,
      baseUrl: key.baseUrl,
      apiKey: key.apiKey,
      ...(key.customHeaders && Object.keys(key.customHeaders).length > 0
        ? { headers: { ...key.customHeaders } }
        : {}),
      insecure: key.verifySsl === true,
    };
  }
  if (!request.baseUrl || !request.apiKey) {
    throw new Error('baseUrl and apiKey are required when keyId is not provided');
  }
  // ad-hoc 路径（首键设置）：ListRemoteModelsRequest 自带的 customHeaders/verifySsl
  // 上车（契约注释指定行为——网关经自定义头鉴权时发现请求才不至于恒失败）。
  return {
    protocol: request.protocol ?? 'openai-compatible',
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    ...(request.customHeaders && Object.keys(request.customHeaders).length > 0
      ? { headers: { ...request.customHeaders } }
      : {}),
    insecure: request.verifySsl === true,
  };
}

export function registerModelProviderIpc() {
  ipcMain.handle(
    'model:list-remote-models',
    async (_event, request: ListRemoteModelsRequest): Promise<RemoteModel[]> => {
      return listModels(resolveListModelsRequest(request));
    },
  );
}

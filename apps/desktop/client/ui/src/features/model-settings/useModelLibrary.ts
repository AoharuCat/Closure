import { useMemo, useState } from 'react';
import type {
  ApiKeyEntry,
  ModelConfig,
  RemoteModel,
} from '@orison/shared-contracts';
import { discoverCliModels, loadRemoteModels } from '../../shared/api/generation';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import {
  draftCustomHeadersRecord,
  draftToKey,
  emptyKeyDraft,
  emptyModelDefaults,
  emptyModelPricing,
  findKeyDraftIssue,
  isKeyDirty,
  keyToDraft,
  nextKeyId,
  type KeyDraft,
  type KeyDraftModel,
} from './utils';

export type ModelLibraryState = {
  draft: KeyDraft;
  selectedKey: ApiKeyEntry | null;
  editorMode: 'idle' | 'creating' | 'editing';
  dirty: boolean;
  remoteModels: RemoteModel[];
  refreshing: boolean;
  refreshError: string | null;
  notice: string | null;
  pendingDeleteId: string | null;
  pendingDeleteKey: ApiKeyEntry | null;
  /** CLI 发现撞未登录态（agy 凭据缺失）——编辑器行内引导旗（09-12 W4）。 */
  cliLoginHint: boolean;
};

export type ModelLibraryActions = {
  updateDraft: (values: Partial<KeyDraft>) => void;
  updateModelEntry: (index: number, values: Partial<KeyDraftModel>) => void;
  removeModelEntry: (index: number) => void;
  startNewKey: () => void;
  selectKey: (key: ApiKeyEntry) => void;
  applyDraft: () => Promise<void>;
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  refreshModels: () => Promise<void>;
  dismissNotice: () => void;
};

type Args = {
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => Promise<void>;
  /** t 支持原生 {var} 插值（useI18n 同签名）——CR-25：弃手拼 replace。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
};

export function useModelLibrary({ modelConfig, setModelConfig, t }: Args): ModelLibraryState & ModelLibraryActions {
  const appendOutputEntry = useAppStore((s) => s.appendOutputEntry);
  const showToast = useToastStore((s) => s.showToast);
  const [draft, setDraft] = useState<KeyDraft>(emptyKeyDraft());
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'idle' | 'creating' | 'editing'>('idle');
  const [cliLoginHint, setCliLoginHint] = useState(false);

  const keys = modelConfig.keys;

  const selectedKey = useMemo(
    () => (draft.id ? keys.find((k) => k.id === draft.id) ?? null : null),
    [keys, draft.id],
  );
  const dirty = isKeyDirty(draft, selectedKey ?? undefined);
  const pendingDeleteKey = useMemo(
    () => (pendingDeleteId ? keys.find((k) => k.id === pendingDeleteId) ?? null : null),
    [pendingDeleteId, keys],
  );

  function updateDraft(values: Partial<KeyDraft>) {
    setDraft((prev) => ({ ...prev, ...values }));
  }

  function updateModelEntry(index: number, values: Partial<KeyDraftModel>) {
    setDraft((prev) => {
      const models = [...prev.models];
      models[index] = { ...models[index]!, ...values };
      return { ...prev, models };
    });
  }

  function removeModelEntry(index: number) {
    setDraft((prev) => ({
      ...prev,
      models: prev.models.filter((_, i) => i !== index),
    }));
  }

  function startNewKey() {
    setDraft(emptyKeyDraft());
    setEditorMode('creating');
    setRemoteModels([]);
    setRefreshError(null);
    setNotice(null);
    setCliLoginHint(false);
  }

  function selectKey(key: ApiKeyEntry) {
    setDraft(keyToDraft(key));
    setEditorMode('editing');
    setRemoteModels([]);
    setRefreshError(null);
    setNotice(null);
    setCliLoginHint(false);
  }

  async function applyDraft() {
    const id = draft.id ?? nextKeyId(keys);

    // CLI 形态的判别载荷守卫（schema min(1) 的 UI 前置——空路径的键保存必被拒）。
    if (draft.protocol === 'antigravity-cli' && !draft.cliExecutable.trim()) {
      rejectApply(t('settings.cliExecutableMissing'));
      return;
    }

    // 09-12 子3 W4：保存前本地化前置校验——NaN 数值/坏 JSON 会被投影函数静默丢弃
    //（silent no-op），必须响亮拦截（本地化文案带字段/模型名）。
    const issue = findKeyDraftIssue(draft);
    if (issue) {
      rejectApply(t(issue.key, issue.vars));
      return;
    }

    const newKey = draftToKey(draft, id);

    if (newKey.models.length === 0) {
      rejectApply(t('settings.noModelsWarning'));
      return;
    }

    const updatedKeys = draft.id
      ? keys.map((k) => (k.id === draft.id ? newKey : k))
      : [...keys, newKey];

    // Spread modelConfig to preserve the top-level embeddingModel preset
    // (VS1 KB indexing) across key edits — constructing `{ keys }` literally
    // would otherwise clear the embedding designation on every apply.
    //
    // 09-12 子3 W4（实修）：catch schema rejection——此前 setModelConfig 的 rejection
    //（config:save-model 面 modelConfigSaveSchema.parse：header 名域/blocklist/数值域/
    // CLI 形态互斥）未处理 = unhandled promise rejection，用户看不到任何反馈。现在落
    // notice（本地化兜底文案）+ 输出日志（原始 zod detail 可诊断）。
    // R10：同走 rejectApply——壳侧 schema 拒收与本地前置校验同属「应用被拒」，都要可见。
    try {
      await setModelConfig({ ...modelConfig, keys: updatedKeys });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputEntry({
        scope: 'model',
        level: 'error',
        message: 'Model config save rejected',
        detail: message,
      });
      rejectApply(t('settings.modelSaveRejected'));
      return;
    }
    setDraft(keyToDraft(newKey));
    setEditorMode('editing');
    setNotice(null);
  }

  function requestDelete(id: string) {
    setPendingDeleteId(id);
  }

  function cancelDelete() {
    setPendingDeleteId(null);
  }

  async function confirmDelete() {
    if (!pendingDeleteId) return;
    const updatedKeys = keys.filter((k) => k.id !== pendingDeleteId);
    // Preserve embeddingModel (top-level preset) when deleting a key. If the
    // deleted key was the embedding model's host, the resolver will gracefully
    // fall back to auto-detect (resolveEmbeddingModel path 1 stale → path 2).
    await setModelConfig({ ...modelConfig, keys: updatedKeys });
    setPendingDeleteId(null);
    if (draft.id === pendingDeleteId) {
      setDraft(emptyKeyDraft());
      setEditorMode('idle');
    }
  }

  // dogfood 2026-08-21（#41）改：合并时刷新既有条目的**派生字段**（alias/capability——
  // registry 输出，存量脏数据如截断 alias "Embedding Qwen/Qwen3-Embedd"、旧 registry
  // 时代错标 text 的 Qwen3-Reranker-8B 靠重新拉取自愈），保留用户 authored 的
  // enabled；新 id 追加默认不勾选（#22 拍板）。已从供应商消失的条目原样保留
  // （用户可能仍要用）。旧逻辑只加新 id、既有条目永不刷新——派生字段坏了就永久坏。
  // CR-10（09-12 agy provider CR 批）：合并基线取 setDraft updater 的 prev——发现
  // 请求在途期间用户对草稿的并发输入（勾选启用/删行）不再被渲染闭包里的旧 models
  // 静默回滚。
  function mergeDiscoveredModels(models: RemoteModel[]) {
    setDraft((prev) => {
      const freshById = new Map(models.map((m) => [m.id, m]));
      const merged: KeyDraftModel[] = prev.models.map((existing) => {
        const fresh = freshById.get(existing.id);
        if (!fresh) return existing;
        // 09-12 子3：合并只刷新派生字段（alias/capability）——用户 authored 的
        // defaults/extraBody/pricing 随 `...existing` 原样保留。
        return {
          ...existing,
          alias: fresh.alias,
          capability: fresh.capability,
        };
      });
      const existingIds = new Set(prev.models.map((m) => m.id));
      for (const m of models) {
        if (!existingIds.has(m.id)) {
          merged.push({
            id: m.id,
            alias: m.alias,
            capability: m.capability,
            enabled: false,
            defaults: emptyModelDefaults(),
            extraBody: '',
            pricing: emptyModelPricing(),
          });
        }
      }
      return { ...prev, models: merged };
    });
    // CR-25：t() 原生 {count} 插值（弃手拼 replace）。
    setNotice(t('settings.modelsRefreshed', { count: models.length }));
  }

  async function refreshModels() {
    if (draft.protocol === 'antigravity-cli') {
      await refreshCliModels();
      return;
    }
    if (!draft.baseUrl || (!draft.apiKey && !draft.id)) {
      setRefreshError(t('settings.missingUrlOrKey'));
      return;
    }
    setRefreshing(true);
    setRefreshError(null);
    try {
      // 09-12 子3 W4：ad-hoc 路径（首设 key 未保存无 keyId）携带草稿的 headers/verifySsl
      // ——网关以自定义头鉴权时，发现请求不带头 = key 永远建不起来（keyId 路径 shell 侧
      // CR-25 已代读盘上键合并）。
      const draftHeaders = draftCustomHeadersRecord(draft);
      const models = await loadRemoteModels(draft.id && !draft.apiKey
        ? { keyId: draft.id }
        : {
            protocol: draft.protocol,
            apiKey: draft.apiKey,
            baseUrl: draft.baseUrl,
            ...(draftHeaders ? { customHeaders: draftHeaders } : {}),
            ...(draft.verifySsl ? { verifySsl: true } : {}),
          });
      setRemoteModels(models);
      mergeDiscoveredModels(models);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputEntry({
        scope: 'model',
        level: 'error',
        message: 'Model list request failed',
        detail: message,
      });
      setRefreshError(message);
    } finally {
      setRefreshing(false);
    }
  }

  // 09-12 agy provider W4：CLI 形态发现（`agy models`）。类型化失败三态各有引导文案
  //（未登录走行内提示旗，不占错误 banner）；成功回填 resolvedExecutable——空路径
  // 自动探测后，草稿落具体路径（key schema 要求非空）。
  async function refreshCliModels() {
    setRefreshing(true);
    setRefreshError(null);
    setCliLoginHint(false);
    try {
      const result = await discoverCliModels({ cliExecutable: draft.cliExecutable.trim() });
      if (!result.ok) {
        if (result.error === 'not-logged-in') {
          setCliLoginHint(true);
          return;
        }
        if (result.error === 'executable-not-found') {
          setRefreshError(t('settings.cliExecutableNotFound'));
          return;
        }
        // CR-25：类型化失败之外的兜底——原始英文 detail 不进本地化界面横幅（落输出日志
        // 可诊断），横幅只出本地化文案（key 维度兜底）。
        if (result.detail) {
          appendOutputEntry({
            scope: 'model',
            level: 'error',
            message: 'CLI model list request failed',
            detail: result.detail,
          });
        }
        setRefreshError(t('settings.cliDiscoveryFailed'));
        return;
      }
      setRemoteModels(result.models);
      // CR-10：回填守护移进 updater（比较 prev 而非渲染闭包 draft）——比较与写入原子
      // 化，发现请求在途期间用户的并发输入不被闭包旧值误判/覆盖时序撕裂。
      setDraft((prev) =>
        prev.cliExecutable.trim() === result.resolvedExecutable
          ? prev
          : { ...prev, cliExecutable: result.resolvedExecutable },
      );
      mergeDiscoveredModels(result.models);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputEntry({
        scope: 'model',
        level: 'error',
        message: 'CLI model list request failed',
        detail: message,
      });
      // CR-25：原始英文错误不透进本地化界面横幅——key 维度兜底（本地化文案），诊断
      // 面走上方输出日志。
      setRefreshError(t('settings.cliDiscoveryFailed'));
    } finally {
      setRefreshing(false);
    }
  }

  function dismissNotice() {
    setNotice(null);
  }

  /**
   * R10（dogfood F14）：保存被拒必须「看得见」。既有通道只有 notice 条——它渲染在编辑器
   * 顶部，而「应用」钮在编辑器底部：编辑器比视口长时，提示条落在视口外，用户看到的就是
   * 「点了应用什么也没发生」（真机：温度越界被拦下、文件未变、零提示），无法区分「值非法」
   * 与「保存坏了」。notice 保留（持久、可关闭、可回看），另经 toast 通道（本页
   * AgyBridgeSection 的失败提示同款）给即时可见反馈——两处同文案，同一拒绝事实。
   */
  function rejectApply(message: string): void {
    setNotice(message);
    showToast(message, 'error');
  }

  return {
    draft,
    selectedKey,
    editorMode,
    dirty,
    remoteModels,
    refreshing,
    refreshError,
    notice,
    pendingDeleteId,
    pendingDeleteKey,
    cliLoginHint,
    updateDraft,
    updateModelEntry,
    removeModelEntry,
    startNewKey,
    selectKey,
    applyDraft,
    requestDelete,
    cancelDelete,
    confirmDelete,
    refreshModels,
    dismissNotice,
  };
}

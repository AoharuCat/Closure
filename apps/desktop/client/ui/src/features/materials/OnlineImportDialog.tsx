/**
 * 「在线导入」弹窗（E10.4 W4，design §3）——材料页工具区入口，两 tab：
 *
 * - **URL 直贴**：URL 输入 + 类别选择（四档预填可改）→ 导入 → 逐条结果回报（成功含
 *   outcome 语义 + truncated 如实标注；失败按 shell 六档分类 + invalid-input/unregistered
 *   分文案呈现，mirror 拒收分类形态）。
 * - **关键词搜索**：query → `searchOnlineSources`（web + wiki 既有核心并发合并，零 LLM）
 *   → 结果行（title/url/snippet/来源徽章 + wiki categoryHint 预填批量类别）→ 勾选批量导入。
 *
 * 导入执行：逐 URL 串行调 `materials:import-online`（单 URL 单调用——契约形态；批量上限
 * ≤ MATERIAL_ONLINE_IMPORT_MAX_BATCH = 20——同主机串行大量抓取是封禁邀请，CR-12；shell 通道
 * 单 URL 无批参数，拦截在 UI 面）。列表刷新走既有 `material:changed` 事件面（shell 逐份
 * notify，materialsSlice 订阅链既有接线——refresh-only，'reused'/'imported' 同消费）+
 * 批终局 `loadMaterialsList(true)` belt（事件可丢兜底，mirror importMaterialFiles 终局重拉）。
 *
 * 类别 → 出处预填提示（纯展示镜像）：**写侧权威 = shell `categoryToProvenanceDefaults`**
 * （main/ipc/toolHandlers/onlineMaterial.ts——W2 落点，落库值以它为准）；本表仅供选择时
 * 预览将预填的 medium/tier，改类别词表/映射时先改 shell 再同步此处。
 */
import { useState } from 'react';
import type { MaterialOnlineCategory, OnlineSourceHit } from '@orison/shared-contracts';
import { MATERIAL_ONLINE_CATEGORIES, MATERIAL_ONLINE_IMPORT_MAX_BATCH } from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { useOverlayDismiss } from '../../shared/hooks/useOverlayDismiss';
import { importOnlineMaterial, searchOnlineSources } from '../../shared/api/materials';

/** 类别 → 预填出处提示（纯展示镜像，权威见模块头注）。 */
const CATEGORY_PREFILL_HINT: Record<MaterialOnlineCategory, { medium: string; tier: string }> = {
  'community-wiki': { medium: 'wiki', tier: 'community' },
  criticism: { medium: 'criticism', tier: 'criticism' },
  'author-interview': { medium: 'interview', tier: 'original' },
  other: { medium: 'other', tier: 'unspecified' },
};

/** 单条导入结果（逐条回报行——pending → ok/failed 终态）。 */
type OnlineResultRow =
  | { url: string; status: 'pending' }
  | {
      url: string;
      status: 'ok';
      outcome: 'registered' | 'reused' | 'orphaned';
      name: string;
      truncated: boolean;
    }
  | { url: string; status: 'failed'; error: string; message?: string };

type Scope = 'project' | 'global';

/** 客户端 URL 预检（http/https）——不过关不发 IPC（shell 侧 bad-url 仍兜底）。 */
function normalizeUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function OnlineImportDialog({ onClose }: { onClose: () => void }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const loadMaterialsList = useAppStore((s) => s.loadMaterialsList);
  const showToast = useToastStore((s) => s.showToast);

  const [tab, setTab] = useState<'url' | 'search'>('url');
  const [scope, setScope] = useState<Scope>('global');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<OnlineResultRow[]>([]);

  // CR-14：busy 期关闭禁用——关闭钮 disabled + backdrop dismiss 不触发（防批中关窗丢结果行
  // 且重开并发批次；批次只能等终局）。
  const requestClose = () => {
    if (busy) return;
    onClose();
  };
  const overlayDismiss = useOverlayDismiss(requestClose);

  // URL 直贴 tab。
  const [urlInput, setUrlInput] = useState('');
  const [urlCategory, setUrlCategory] = useState<MaterialOnlineCategory>('community-wiki');

  // 关键词搜索 tab。
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hits, setHits] = useState<OnlineSourceHit[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batchCategory, setBatchCategory] = useState<MaterialOnlineCategory>('other');

  /** 逐条回报行 settle（末条同 URL pending 行——批内 URL 唯一由搜索去重保证）。 */
  const settleRow = (url: string, row: OnlineResultRow) => {
    setResults((prev) => {
      let idx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i]!.url === url && prev[i]!.status === 'pending') {
          idx = i;
          break;
        }
      }
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = row;
      return next;
    });
  };

  /**
   * 逐 URL 串行导入（结果逐条回报；批终局 belt 重拉清单）。onAccepted 在全部守卫通过、
   * 批次确定执行时回调（CR-13：输入清除挂在这里——busy/溢出/无项目早退路径不再静默清掉
   * 已输入内容）。
   */
  const runImportUrls = async (
    urls: string[],
    category: MaterialOnlineCategory,
    onAccepted?: () => void,
  ) => {
    if (busy || urls.length === 0) return;
    if (urls.length > MATERIAL_ONLINE_IMPORT_MAX_BATCH) {
      showToast(t('materials.online.batchOverflow', { max: MATERIAL_ONLINE_IMPORT_MAX_BATCH }), 'warning');
      return;
    }
    const projectId = currentProject?.projectId;
    if (scope === 'project' && projectId === undefined) {
      showToast(t('materials.online.needProject'), 'warning');
      return;
    }
    setBusy(true);
    onAccepted?.();
    try {
      for (const url of urls) {
        setResults((prev) => [...prev, { url, status: 'pending' }]);
        try {
          const result = await importOnlineMaterial({
            url,
            scope,
            category,
            ...(scope === 'project' && projectId !== undefined ? { projectId } : {}),
          });
          if (result.ok) {
            settleRow(url, {
              url,
              status: 'ok',
              outcome: result.outcome,
              name: result.name,
              truncated: result.truncated,
            });
          } else {
            settleRow(url, { url, status: 'failed', error: result.error, ...(result.message ? { message: result.message } : {}) });
          }
        } catch (err) {
          // 桥缺失/坏参（模式 B throw）——按 ingest-failed 档呈现，message 承载原因。
          settleRow(url, {
            url,
            status: 'failed',
            error: 'ingest-failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      setBusy(false);
      // 终局 belt 重拉（material:changed 事件面之外的事件可丢兜底）。
      void loadMaterialsList(true);
    }
  };

  const handleUrlImport = () => {
    const url = normalizeUrlInput(urlInput);
    if (url === null) {
      showToast(t('materials.online.failureKind.bad-url'), 'warning');
      return;
    }
    // CR-13：清输入延迟到批次被接受后——早退路径（busy/溢出/无项目）不清已输入 URL。
    void runImportUrls([url], urlCategory, () => setUrlInput(''));
  };

  const handleSearch = async () => {
    const q = query.trim();
    if (q === '' || searching) return;
    setSearching(true);
    setSearchError(null);
    setHits([]);
    setChecked(new Set());
    try {
      const found = await searchOnlineSources({ query: q });
      setHits(found);
      // wiki 注册表命中提示（shell 逐行给 categoryHint）→ 批量类别预填（首个命中提示）。
      const hint = found.find((h) => h.categoryHint !== undefined)?.categoryHint;
      if (hint !== undefined) setBatchCategory(hint);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const toggleChecked = (url: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const checkedUrls = hits.filter((h) => checked.has(h.url)).map((h) => h.url);
  const projectLaneDead = scope === 'project' && currentProject === null;

  /** 类别下拉 + 预填提示（两 tab 共用渲染）。 */
  const categoryField = (id: 'url' | 'batch', value: MaterialOnlineCategory, onChange: (c: MaterialOnlineCategory) => void) => (
    <label className="materials-online-field">
      <span className="materials-online-label">{t('materials.online.categoryLabel')}</span>
      <select
        className="materials-online-select"
        value={value}
        disabled={busy}
        data-online-category={id}
        onChange={(e) => onChange(e.target.value as MaterialOnlineCategory)}
      >
        {MATERIAL_ONLINE_CATEGORIES.map((c) => (
          <option key={c} value={c}>{t(`materials.online.category.${c}`)}</option>
        ))}
      </select>
      <span className="materials-online-hint" data-online-category-hint={id}>
        {t('materials.online.categoryHint', {
          medium: t(`materials.medium.${CATEGORY_PREFILL_HINT[value].medium}`),
          tier: t(`materials.tier.${CATEGORY_PREFILL_HINT[value].tier}`),
        })}
      </span>
    </label>
  );

  return (
    <div className="materials-online-overlay" role="dialog" aria-modal="true" data-online-dialog="true" {...overlayDismiss}>
      <div className="materials-online-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="materials-online-header">
          <h2 className="materials-online-title">{t('materials.online.title')}</h2>
          <label className="materials-online-field materials-online-field--inline">
            <span className="materials-online-label">{t('materials.online.scopeLabel')}</span>
            <select
              className="materials-online-select"
              value={scope}
              disabled={busy}
              data-online-scope="true"
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="global">{t('materials.scope.global')}</option>
              <option value="project" disabled={currentProject === null}>{t('materials.scope.project')}</option>
            </select>
          </label>
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('materials.online.close')}
            disabled={busy}
            data-online-close="true"
            onClick={requestClose}
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="materials-online-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'url'}
            className={`materials-online-tab${tab === 'url' ? ' is-active' : ''}`}
            data-online-tab="url"
            onClick={() => setTab('url')}
          >
            {t('materials.online.tabUrl')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'search'}
            className={`materials-online-tab${tab === 'search' ? ' is-active' : ''}`}
            data-online-tab="search"
            onClick={() => setTab('search')}
          >
            {t('materials.online.tabSearch')}
          </button>
        </div>

        <div className="materials-online-body">
          {projectLaneDead && (
            <div className="materials-online-warn" data-online-project-dead="true">
              {t('materials.online.needProject')}
            </div>
          )}

          {tab === 'url' && (
            <div className="materials-online-pane" data-online-pane="url">
              <label className="materials-online-field">
                <span className="materials-online-label">{t('materials.online.urlLabel')}</span>
                <input
                  type="text"
                  className="materials-online-input"
                  placeholder={t('materials.online.urlPlaceholder')}
                  value={urlInput}
                  disabled={busy}
                  data-online-url-input="true"
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleUrlImport(); }}
                />
              </label>
              {categoryField('url', urlCategory, setUrlCategory)}
              <div className="materials-online-actions">
                <button
                  type="button"
                  className="materials-browsebtn"
                  disabled={busy || urlInput.trim() === ''}
                  data-online-import="url"
                  onClick={handleUrlImport}
                >
                  {busy ? t('materials.online.importing') : t('materials.online.import')}
                </button>
              </div>
            </div>
          )}

          {tab === 'search' && (
            <div className="materials-online-pane" data-online-pane="search">
              <div className="materials-online-row">
                <input
                  type="text"
                  className="materials-online-input"
                  placeholder={t('materials.online.queryPlaceholder')}
                  value={query}
                  disabled={searching || busy}
                  data-online-query="true"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
                />
                <button
                  type="button"
                  className="materials-browsebtn"
                  disabled={searching || busy || query.trim() === ''}
                  data-online-search="true"
                  onClick={() => { void handleSearch(); }}
                >
                  {searching ? t('materials.online.searching') : t('materials.online.search')}
                </button>
              </div>
              {searchError !== null && (
                <div className="materials-online-warn" data-online-search-error="true">
                  {t('materials.online.searchFailed', { message: searchError })}
                </div>
              )}
              {hits.length === 0 && !searching && searchError === null && (
                <div className="materials-online-hint" data-online-search-empty="true">
                  {t('materials.online.searchEmpty')}
                </div>
              )}
              {hits.length > 0 && (
                <>
                  <div className="materials-online-hits" data-online-hits="true">
                    {hits.map((hit) => {
                      const isWiki = hit.source.startsWith('wiki:');
                      return (
                        <label
                          key={hit.url}
                          className={`materials-online-hit${checked.has(hit.url) ? ' is-checked' : ''}`}
                          data-online-hit={hit.url}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(hit.url)}
                            disabled={busy}
                            data-online-hit-check={hit.url}
                            onChange={() => toggleChecked(hit.url)}
                          />
                          <span className="materials-online-hit-main">
                            <span className="materials-online-hit-head">
                              <span className="materials-badge" data-online-hit-source={isWiki ? 'wiki' : 'web'}>
                                {isWiki ? t('materials.online.sourceWiki') : t('materials.online.sourceWeb')}
                              </span>
                              <span className="materials-online-hit-title">{hit.title}</span>
                            </span>
                            <span className="materials-online-hit-snippet">{hit.snippet}</span>
                            <span className="materials-online-hit-url">{hit.url}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {categoryField('batch', batchCategory, setBatchCategory)}
                  <div className="materials-online-actions">
                    <button
                      type="button"
                      className="materials-browsebtn"
                      disabled={busy || checkedUrls.length === 0}
                      data-online-import="batch"
                      onClick={() => { void runImportUrls(checkedUrls, batchCategory); }}
                    >
                      {busy
                        ? t('materials.online.importing')
                        : t('materials.online.importChecked', { count: checkedUrls.length })}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {results.length > 0 && (
            <div className="materials-online-results" data-online-results="true">
              <span className="materials-online-label">{t('materials.online.resultTitle')}</span>
              {results.map((row, idx) => (
                <div
                  key={`${row.url}-${idx}`}
                  className={`materials-online-result materials-online-result--${row.status}`}
                  data-online-result={row.url}
                  data-online-result-status={row.status}
                >
                  {row.status === 'pending' && <span className="materials-online-hint">{t('materials.online.importing')}</span>}
                  {row.status === 'ok' && (
                    <>
                      <span className="materials-online-result-state">{t(`materials.online.outcome.${row.outcome}`)}</span>
                      <span className="materials-online-result-name">{row.name}</span>
                      {row.truncated && (
                        <span className="materials-badge materials-badge--amber" data-online-truncated="true">
                          {t('materials.online.resultTruncated')}
                        </span>
                      )}
                    </>
                  )}
                  {row.status === 'failed' && (
                    <>
                      <span className="materials-online-result-state materials-online-result-state--fail">
                        {t('materials.online.resultFailed')}
                      </span>
                      <span data-online-failure-kind={row.error}>{t(`materials.online.failureKind.${row.error}`)}</span>
                      {row.message !== undefined && <span className="materials-online-hint">{row.message}</span>}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

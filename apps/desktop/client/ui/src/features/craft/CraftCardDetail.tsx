/**
 * 卡详情 + 编辑视图（E10.2b W5，design §3 视图 2——mockup 定稿）。
 *
 * 轻量表单（字段量小**不上 schema-driven-forms 全引擎**——design §3 拍板；blur/change
 * 落盘 + 回声抑制纪律照 spec/ui/schema-driven-forms，形态 mirror ProvenanceForm）：
 * - **键盘字段 blur 落盘**：title / claim 四件套（condensed 主张 + points/scenarios/
 *   counterexamples 三列表——textarea 每行一条）；**离散字段 change 即存**：词目 select
 *   （**optgroup 按大类分组**——as-built 形态，CR-2b-24 design 同步）/ tags chips 增删
 *   （整组替换——**基面 = 本地最新草稿非 store 远照**，CR-2b-14：两次快速操作第二次
 *   基面含第一次在途改动）/ 分歧 toggle。
 * - **回声抑制保草稿（Pattern 3）**：detail 服务器刷新只在（无未存改动 && 无在途保存）时
 *   重置草稿基线。
 * - **Pattern 3b（单 dirty 旗按字段分歧重算）**：任一字段保存成功后 dirty 按
 *   draftDiffersFrom(最新草稿, result.card) 重算——单字段保存不吞其他字段未 blur 草稿
 *   （CR-4/5）；空 title/condensed blur = 拒绝回显存量 + dirty 按分歧重算（mirror blurName）。
 * - **编辑即降级可见反馈**：已核卡内容编辑成功 → toast「回到待审」+ 状态徽章翻
 *   pending_review（slice 直写 result.card——基线即时刷新）。
 * - **讲法列表**：author / 引文快照 / 锚点坐标 + 跳转（打开材料派生 .md——项目车道应用内
 *   tab + reveal 文本定位；全局车道 clipboard 兜底，mirror 材料页 handleOpenDerived）/
 *   rank 三档控件（认可/正常/不认可——颜色级；rank 改级**不触发卡降级**，与内容编辑和人审
 *   状态动作正交）/ stale 提示。
 * - **状态动作**：标记已核 / 驳回（带理由输入）/ 救回（rejected 卡编辑入口禁用——F-15
 *   必须先救回，本视图 rejected 态全字段只读 + 理由回看）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CRAFT_TEACHING_RANKS,
  type CraftCardPatchInput,
  type CraftCardPatchResult,
  type CraftCardReviewInput,
  type CraftCardStatus,
  type CraftTeaching,
  type CraftTerm,
  type MaterialDetail,
} from '@orison/shared-contracts';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { Tooltip } from '../../shared/components/Tooltip';
import { normalizePath } from '../../shared/utils/paths';
import { readFile } from '../../shared/api/filesystem';
import { copyMaterialPath, getMaterialDetail } from '../../shared/api/materials';
import { craftConfidenceTier, craftRankLabelKey, craftStatusBadgeKey } from './craftView';

/**
 * 来源三级徽章（E10.4 W3 additive）：讲法 originTier 三色——原作 muted（中性事实非成功态，
 * CR-16：materials-badge--muted 与注释语义一致，不用 --ok 成功系）/ 社区 info 蓝 /
 * 批评 amber 警示。缺席（unspecified 材料/旧行零迁移）不渲染徽章，与 originKind/bookTitle
 * 徽章并列同位（讲法行 materials-cell 排）。
 */
const ORIGIN_TIER_BADGE: Record<NonNullable<CraftTeaching['originTier']>, { cls: string; labelKey: string }> = {
  original: { cls: 'materials-badge--muted', labelKey: 'craft.card.tierOriginal' },
  community: { cls: 'materials-badge--info', labelKey: 'craft.card.tierCommunity' },
  criticism: { cls: 'materials-badge--amber', labelKey: 'craft.card.tierCriticism' },
};

/** 键盘字段草稿（points/scenarios/counterexamples 三列表 = textarea 每行一条 join '\n'）。 */
type CardDraft = {
  title: string;
  condensed: string;
  points: string;
  scenarios: string;
  counterexamples: string;
};

function baselineDraft(card: {
  title: string;
  claim: { condensed: string; points: string[]; scenarios: string[]; counterexamples: string[] };
}): CardDraft {
  return {
    title: card.title,
    condensed: card.claim.condensed,
    points: card.claim.points.join('\n'),
    scenarios: card.claim.scenarios.join('\n'),
    counterexamples: card.claim.counterexamples.join('\n'),
  };
}

/** textarea 行归一（split + trim + 去空行——落盘与比较共用单源）。 */
function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 草稿 ↔ 服务器基线字段级分歧（Pattern 3b——保草稿优先）。title/condensed 原样对照
 * （mirror draftDiffersFrom 先例）；三列表按**归一后行集**对照（trailing 空行等纯排版
 * 噪声不算分歧——否则永久武装回声抑制吞刷新）。
 */
function draftDiffersFrom(d: CardDraft, card: Parameters<typeof baselineDraft>[0]): boolean {
  return (
    d.title !== card.title ||
    d.condensed !== card.claim.condensed ||
    linesOf(d.points).join('\n') !== card.claim.points.join('\n') ||
    linesOf(d.scenarios).join('\n') !== card.claim.scenarios.join('\n') ||
    linesOf(d.counterexamples).join('\n') !== card.claim.counterexamples.join('\n')
  );
}

export function CraftCardDetail({ cardId }: { cardId: string }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const currentProject = useAppStore((s) => s.currentProject);
  const card = useAppStore((s) => s.craftCardDetail);
  const detailLoading = useAppStore((s) => s.craftCardDetailLoading);
  const detailError = useAppStore((s) => s.craftCardDetailError);
  const loadCraftCard = useAppStore((s) => s.loadCraftCard);
  const clearCraftCard = useAppStore((s) => s.clearCraftCard);
  const patchCraftCard = useAppStore((s) => s.patchCraftCard);
  const reviewCraftCard = useAppStore((s) => s.reviewCraftCard);
  const terms = useAppStore((s) => s.craftTerms);
  const openFile = useAppStore((s) => s.openFile);
  const showToast = useToastStore((s) => s.showToast);

  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  /** 在途保存计数（连发 blur 期间抑制回声重置）。 */
  const savingRef = useRef(0);
  /** 草稿镜像 ref（Pattern 3b：异步 save 回调读最新草稿，非闭包陈旧值）。 */
  const draftRef = useRef<CardDraft | null>(null);
  const updateDraft = useCallback((next: CardDraft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  /** 驳回理由输入态（展开式——非模态）。 */
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    void loadCraftCard(cardId, false);
  }, [cardId, loadCraftCard]);

  // 回声抑制基线重置：detail 刷新只在（无未存改动 && 无在途保存）时重置草稿。
  useEffect(() => {
    if (card === null || dirty || savingRef.current > 0) return;
    updateDraft(baselineDraft(card));
  }, [card, dirty, updateDraft]);

  const savePatch = async (patch: CraftCardPatchInput['patch']): Promise<CraftCardPatchResult | null> => {
    if (card === null) return null;
    const prevStatus: CraftCardStatus = card.status;
    savingRef.current += 1;
    try {
      const result = await patchCraftCard(cardId, patch);
      if (result.ok) {
        // 编辑即降级可见反馈：已核卡内容编辑 → 状态回待审（R5 uniform）。
        const downgraded = prevStatus === 'verified' && result.card.status === 'pending_review';
        showToast(downgraded ? t('craft.toast.savedDowngraded') : t('craft.toast.saved'), 'success');
        // Pattern 3b：dirty 按字段实际分歧重算（单字段保存不吞其他字段未 blur 草稿）。
        const d = draftRef.current;
        setDirty(d !== null && draftDiffersFrom(d, result.card));
      } else {
        showToast(t('craft.toast.saveFailed', { message: result.message ?? result.error }), 'error');
      }
      return result;
    } catch (err) {
      showToast(t('craft.toast.saveFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
      return null;
    } finally {
      savingRef.current -= 1;
    }
  };

  /** 非空键盘字段 blur（title/condensed——min(1) 契约）：空值拒绝回显 + dirty 重算。 */
  const blurRequiredField = (field: 'title' | 'condensed') => () => {
    if (card === null || draft === null) return;
    const serverValue = field === 'title' ? card.title : card.claim.condensed;
    const next = draft[field].trim();
    if (next === serverValue) return;
    if (next === '') {
      const reverted = { ...draft, [field]: serverValue };
      updateDraft(reverted);
      setDirty(draftDiffersFrom(reverted, card));
      return;
    }
    void savePatch(field === 'title' ? { title: next } : { claim: { condensed: next } });
  };

  /** 三列表字段 blur（允许空表）：归一后与基线同 → 零 IPC。 */
  const blurListField = (field: 'points' | 'scenarios' | 'counterexamples') => () => {
    if (card === null || draft === null) return;
    const serverValue = card.claim[field].join('\n');
    const nextLines = linesOf(draft[field]);
    if (nextLines.join('\n') === serverValue) return;
    void savePatch({ claim: { [field]: nextLines } });
  };

  /** 离散动作（词目/分歧/tags/rank/状态机）落盘——不设草稿，change 即存。 */
  const runReview = async (input: CraftCardReviewInput, successKey: string) => {
    try {
      const result = await reviewCraftCard(input);
      if (result.ok) {
        showToast(t(successKey), 'success');
        setRejectOpen(false);
        setRejectReason('');
      } else {
        showToast(t('craft.toast.reviewFailed', { message: result.message ?? result.error }), 'error');
      }
    } catch (err) {
      showToast(t('craft.toast.reviewFailed', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  /** 锚点回看：打开材料派生 .md（项目车道应用内 tab + reveal 文本定位；全局车道 clipboard 兜底）。 */
  const handleJumpAnchor = async (teaching: CraftTeaching) => {
    let detail: MaterialDetail | null = null;
    try {
      detail = await getMaterialDetail(teaching.materialId);
    } catch {
      detail = null;
    }
    const abs = detail?.derivedAbsPath ?? null;
    if (abs === null) {
      showToast(t('craft.card.anchorMissing'), 'warning');
      return;
    }
    if (detail !== null && detail.material.scope === 'project' && currentProject !== null) {
      try {
        const content = await readFile(abs);
        if (content === null) {
          showToast(t('craft.card.anchorMissing'), 'warning');
          return;
        }
        const normalized = normalizePath(abs);
        // reveal：text 精确定位优先（quote 引文快照），行号兜底（fileTabsSlice 契约）。
        openFile(normalized, normalized.split('/').pop() ?? 'material.md', content, {
          reveal: { line: 1, text: teaching.quote },
        });
        showToast(
          t('craft.card.anchorOpened', { para: `${teaching.anchor.paraStart}–${teaching.anchor.paraEnd}` }),
          'success',
        );
      } catch {
        showToast(t('craft.card.anchorOpenFailed'), 'error');
      }
      return;
    }
    const copied = await copyMaterialPath(abs);
    showToast(
      copied ? t('craft.card.anchorPathCopied', { path: abs }) : t('craft.card.anchorOpenFailed'),
      copied ? 'info' : 'error',
    );
  };

  /** tags 本地基面（CR-2b-14——Pattern 3b 家族）：增删 patch 的基面是本地最新草稿
   * （含在途未回读的改动），勿用 store 远照 card.tags——两次快速操作第二次覆写第一次。 */
  const tagsRef = useRef<string[] | null>(null);
  /** 在途 tags 写计数（回声同步守卫——mirror savingRef 纪律：在途期 card 刷新不重置基面）。 */
  const tagsSavingRef = useRef(0);

  // 基线同步：无在途 tags 写时 card 刷新即重置本地基面（patch 成功回读 result.card 即新基线）。
  useEffect(() => {
    if (card === null || tagsSavingRef.current > 0) return;
    tagsRef.current = card.tags;
  }, [card]);

  /**
   * tags 整组替换保存：失败回退本地基面到操作前值（服务器未变——savePatch 已 toast）；
   * 成功则 result.card 回读 + 计数归零 → 基线同步 effect 采纳服务器回显为新基面。
   */
  const saveTags = async (tags: string[], prev: string[]) => {
    tagsSavingRef.current += 1;
    const result = await savePatch({ tags });
    if (result === null || !result.ok) tagsRef.current = prev;
    tagsSavingRef.current -= 1;
  };

  const addTag = () => {
    if (card === null) return;
    const next = tagInput.trim();
    setTagInput('');
    const base = tagsRef.current ?? card.tags;
    if (next.length === 0 || base.includes(next)) return;
    const tags = [...base, next];
    tagsRef.current = tags;
    void saveTags(tags, base);
  };

  const removeTag = (tag: string) => {
    if (card === null) return;
    const base = tagsRef.current ?? card.tags;
    if (!base.includes(tag)) return;
    const tags = base.filter((x) => x !== tag);
    tagsRef.current = tags;
    void saveTags(tags, base);
  };

  const rejected = card?.status === 'rejected';
  const tier = card !== null ? craftConfidenceTier(card.confidence) : null;
  // 词目 select 选项：active 词目 + 当前词目（pending 也呈现——归类必填，pending 也是行），
  // **optgroup 按大类分组**（as-built 形态，CR-2b-24——大类进组头，非逐项后缀）。
  const termGroups = (() => {
    if (card === null) return [] as Array<{ category: string; terms: CraftTerm[] }>;
    const active = terms.filter((x) => x.status === 'active');
    const current = terms.find((x) => x.termId === card.termId);
    const list =
      current !== undefined && current.status !== 'active' ? [...active, current] : active;
    const groups: Array<{ category: string; terms: CraftTerm[] }> = [];
    for (const term of list) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.category === term.category) last.terms.push(term);
      else groups.push({ category: term.category, terms: [term] });
    }
    return groups;
  })();

  return (
    <div className="materials-page" data-craft-detail={cardId}>
      <div className="materials-toolbar">
        <Tooltip label={t('craft.card.back')} placement="top">
          <button
            type="button"
            className="materials-iconbtn"
            aria-label={t('craft.card.back')}
            onClick={clearCraftCard}
          >
            <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          </button>
        </Tooltip>
        {card !== null && (
          <span
            className={`materials-badge ${
              card.status === 'pending_review'
                ? 'materials-badge--amber'
                : card.status === 'rejected'
                  ? 'materials-badge--danger'
                  : 'materials-badge--ok'
            }`}
            data-craft-status={card.status}
          >
            {t(craftStatusBadgeKey(card.status))}
          </span>
        )}
        {tier !== null && (
          <Tooltip label={t('craft.confidence.tooltip', { value: (card?.confidence ?? 0).toFixed(2) })} placement="top">
            <span className="materials-chip" data-craft-confidence={tier}>
              {t(`craft.confidence.${tier}`)}
            </span>
          </Tooltip>
        )}
        {card?.dispute && (
          <span className="materials-badge materials-badge--warn" data-craft-dispute="true">
            {t('craft.badge.dispute')}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* 状态动作：verify（pending 时）/ reject（pending+verified）/ recover（rejected）。 */}
        {card?.status === 'pending_review' && (
          <button
            type="button"
            className="materials-browsebtn"
            data-craft-action="verify"
            onClick={() => { void runReview({ cardId, action: 'verify' }, 'craft.toast.verified'); }}
          >
            {t('craft.card.verify')}
          </button>
        )}
        {(card?.status === 'pending_review' || card?.status === 'verified') && (
          <button
            type="button"
            className="materials-browsebtn"
            data-craft-action="reject"
            onClick={() => setRejectOpen((v) => !v)}
          >
            {t('craft.card.reject')}
          </button>
        )}
        {rejected && (
          <button
            type="button"
            className="materials-browsebtn"
            data-craft-action="recover"
            onClick={() => { void runReview({ cardId, action: 'recover' }, 'craft.toast.recovered'); }}
          >
            {t('craft.card.recover')}
          </button>
        )}
      </div>

      {/* 驳回理由输入（展开式）+ rejected 理由回看。 */}
      {rejectOpen && card !== null && (
        <div className="materials-form" data-craft-reject-form="true">
          <div className="materials-form-row">
            <label className="materials-form-field" style={{ flex: 1 }}>
              <span className="materials-form-label">{t('craft.card.rejectReasonLabel')}</span>
              <input
                type="text"
                className="materials-form-input"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                data-craft-field="rejectReason"
              />
            </label>
            <button
              type="button"
              className="materials-browsebtn"
              data-craft-action="reject-confirm"
              onClick={() => {
                void runReview(
                  { cardId, action: 'reject', ...(rejectReason.trim().length > 0 ? { rejectReason: rejectReason.trim() } : {}) },
                  'craft.toast.rejected',
                );
              }}
            >
              {t('craft.card.rejectConfirm')}
            </button>
          </div>
        </div>
      )}
      {card !== null && card.status === 'rejected' && card.rejectReason !== null && (
        <div className="materials-form-error" data-craft-reject-reason={card.rejectReason}>
          {t('craft.card.rejectReasonShown', { reason: card.rejectReason })}
        </div>
      )}

      {detailLoading && card === null && <div className="materials-empty">{t('craft.list.loading')}</div>}
      {detailError !== null && (
        <div className="materials-empty materials-empty--error">
          {t('craft.list.error', { message: detailError })}
        </div>
      )}
      {card !== null && draft !== null && (
        <div className="materials-listwrap">
          <div className="materials-form">
            <div className="materials-form-row">
              <label className="materials-form-field" style={{ minWidth: 260 }}>
                <span className="materials-form-label">{t('craft.card.title')}</span>
                <input
                  type="text"
                  className="materials-form-input"
                  value={draft.title}
                  disabled={rejected}
                  onChange={(e) => {
                    setDirty(true);
                    updateDraft({ ...draft, title: e.target.value });
                  }}
                  onBlur={blurRequiredField('title')}
                  data-craft-field="title"
                />
              </label>
              {/* 词目（大类恒跟随 term——F-15 无独立大类编辑；select change 即存）。 */}
              <label className="materials-form-field">
                <span className="materials-form-label">{t('craft.card.term')}</span>
                <select
                  className="materials-form-select"
                  value={card.termId}
                  disabled={rejected}
                  onChange={(e) => {
                    if (e.target.value !== card.termId) void savePatch({ termId: e.target.value });
                  }}
                  data-craft-field="term"
                >
                  {termGroups.map((group) => (
                    <optgroup key={group.category} label={t(`craft.category.${group.category}`)}>
                      {group.terms.map((term) => (
                        <option key={term.termId} value={term.termId}>
                          {term.name}
                          {term.status === 'pending' ? t('craft.terms.pendingSuffix') : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {/* 分歧标记人审确认/取消（R4——LLM 判 + 人审确认；dispute patch）。 */}
              <label className="materials-form-field">
                <span className="materials-form-label">{t('craft.card.disputeToggle')}</span>
                <button
                  type="button"
                  className={`materials-crafttag${card.dispute ? ' is-active' : ''}`}
                  disabled={rejected}
                  onClick={() => { void savePatch({ dispute: !card.dispute }); }}
                  data-craft-action="dispute-toggle"
                >
                  {card.dispute ? t('craft.card.disputeOn') : t('craft.card.disputeOff')}
                </button>
              </label>
            </div>
            {/* tags 自由 chips 增删（R10——整组替换 change 即存；与受控词表正交）。 */}
            <div className="materials-form-row">
              <div className="materials-form-field" style={{ flex: 1 }}>
                <span className="materials-form-label">{t('craft.card.tags')}</span>
                <div className="materials-cell">
                  {card.tags.map((tag) => (
                    <span key={tag} className="materials-chip">
                      #{tag}
                      {!rejected && (
                        <button
                          type="button"
                          className="materials-iconbtn"
                          style={{ width: 16, height: 16 }}
                          aria-label={t('craft.card.tagRemove', { tag })}
                          disabled={rejected}
                          onClick={() => removeTag(tag)}
                          data-craft-action="tag-remove"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 12 }} aria-hidden="true">close</span>
                        </button>
                      )}
                    </span>
                  ))}
                  {!rejected && (
                    <>
                      <input
                        type="text"
                        className="materials-form-input"
                        style={{ width: 140 }}
                        value={tagInput}
                        placeholder={t('craft.card.tagPlaceholder')}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addTag();
                          }
                        }}
                        data-craft-field="tag-input"
                      />
                      <button type="button" className="materials-browsebtn" onClick={addTag} data-craft-action="tag-add">
                        {t('craft.card.tagAdd')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* claim 四件套（condensed 非空硬底；三列表每行一条）。 */}
            <div className="materials-form-row">
              <label className="materials-form-field" style={{ flex: 1, minWidth: 280 }}>
                <span className="materials-form-label">{t('craft.card.condensed')}</span>
                <textarea
                  className="materials-form-input"
                  rows={3}
                  value={draft.condensed}
                  disabled={rejected}
                  onChange={(e) => {
                    setDirty(true);
                    updateDraft({ ...draft, condensed: e.target.value });
                  }}
                  onBlur={blurRequiredField('condensed')}
                  data-craft-field="condensed"
                />
              </label>
            </div>
            {(['points', 'scenarios', 'counterexamples'] as const).map((field) => (
              <div className="materials-form-row" key={field}>
                <label className="materials-form-field" style={{ flex: 1, minWidth: 280 }}>
                  <span className="materials-form-label">{t(`craft.card.${field}`)}</span>
                  <textarea
                    className="materials-form-input"
                    rows={Math.max(2, linesOf(draft[field]).length)}
                    value={draft[field]}
                    disabled={rejected}
                    placeholder={t('craft.card.listFieldPlaceholder')}
                    onChange={(e) => {
                      setDirty(true);
                      updateDraft({ ...draft, [field]: e.target.value });
                    }}
                    onBlur={blurListField(field)}
                    data-craft-field={field}
                  />
                </label>
              </div>
            ))}
          </div>

          {/* 讲法列表（Wikidata statement 形态——author/引文快照/锚点/rank/stale）。 */}
          <div className="craft-grouphead">
            <span className="material-symbols-outlined" aria-hidden="true">format_quote</span>
            <span className="craft-grouphead-name">{t('craft.card.teachings', { count: card.teachings.length })}</span>
          </div>
          {card.teachings.map((teaching) => (
            <div key={teaching.teachingId} className="craft-teaching" data-craft-teaching={teaching.teachingId}>
              <div className="materials-cell">
                <span className="materials-chip materials-chip--tier">
                  {teaching.author ?? t('craft.card.unknownAuthor')}
                </span>
                {/* 来源徽章（E10.3b W6 additive）：拆书实例讲法带书名 chip——教程主张
                    （默认/absent/doc_claim）不显示，与 10.2 既有讲法视觉零 churn。 */}
                {teaching.originKind === 'decon_instance' && (
                  <span
                    className="materials-badge materials-badge--ok"
                    data-craft-origin="decon_instance"
                    data-craft-origin-book={teaching.bookTitle ?? undefined}
                  >
                    {teaching.bookTitle != null && teaching.bookTitle.trim().length > 0
                      ? t('craft.card.originDecon', { book: teaching.bookTitle })
                      : t('craft.card.originDeconNoTitle')}
                  </span>
                )}
                {/* 来源三级徽章（E10.4 W3 additive）：材料 provenance.tier 透传讲法——三色 +
                    缺席不显示（unspecified/旧行零迁移），与 originKind/bookTitle 徽章并列同位。 */}
                {teaching.originTier !== undefined && (
                  <span
                    className={`materials-badge ${ORIGIN_TIER_BADGE[teaching.originTier].cls}`}
                    data-craft-origin-tier={teaching.originTier}
                  >
                    {t(ORIGIN_TIER_BADGE[teaching.originTier].labelKey)}
                  </span>
                )}
                {teaching.stale && (
                  <Tooltip label={t('craft.card.staleHint')} placement="top">
                    <span className="materials-badge materials-badge--amber" data-craft-stale="true">
                      {t('craft.badge.stale')}
                    </span>
                  </Tooltip>
                )}
                <span style={{ flex: 1 }} />
                {/* 锚点回看（材料已删时 getMaterialDetail 落空 → 诚实 warn）。 */}
                <Tooltip
                  label={t('craft.card.anchorHint', {
                    para: `${teaching.anchor.paraStart}–${teaching.anchor.paraEnd}`,
                    chars: `${teaching.anchor.charStart}–${teaching.anchor.charEnd}`,
                  })}
                  placement="top"
                >
                  <button
                    type="button"
                    className="materials-iconbtn"
                    aria-label={t('craft.card.anchorJump')}
                    onClick={() => { void handleJumpAnchor(teaching); }}
                    data-craft-action="anchor-jump"
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
                  </button>
                </Tooltip>
              </div>
              <blockquote className="craft-compare-quote">{teaching.quote}</blockquote>
              {teaching.note !== null && (
                <div className="materials-form-loading">{teaching.note}</div>
              )}
              {/* rank 三档控件（approved=人审显式认可；改级不动卡状态——与编辑降级正交）。 */}
              <div className="materials-cell">
                {CRAFT_TEACHING_RANKS.map((rank) => (
                  <button
                    key={rank}
                    type="button"
                    className={`craft-rankbtn craft-rankbtn--${rank}${teaching.rank === rank ? ' is-active' : ''}`}
                    disabled={rejected}
                    onClick={() => {
                      if (teaching.rank !== rank) {
                        void runReview(
                          { cardId, teachingRank: { teachingId: teaching.teachingId, rank } },
                          'craft.toast.rankSaved',
                        );
                      }
                    }}
                    data-craft-rank={`${teaching.teachingId}:${rank}`}
                  >
                    {t(craftRankLabelKey(rank))}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

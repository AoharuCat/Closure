import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { useI18n } from '../../shared/i18n/useI18n';
import type { NovelChapterMeta } from '../../shared/store/novelChapterSlice';
import { normalizePath } from '../../shared/utils/paths';
import { openWriting } from '../editor/openWriting';
import { WorkingStyleSection } from './WorkingStyleSection';
import { gitIsRepo, gitLog, gitCreateNode, gitStatusCount } from '../../shared/api/git';
import type { GitCommitEntry } from '@orison/shared-contracts';
import type { z } from 'zod';
import type { outlineV2Schema, worldSettingSchema, assetCardSchema, creativeBriefSchema } from '@orison/shared-contracts';

type OutlineV2 = z.infer<typeof outlineV2Schema>;
type WorldSetting = z.infer<typeof worldSettingSchema>;
type AssetCard = z.infer<typeof assetCardSchema>;
type CreativeBrief = z.infer<typeof creativeBriefSchema>;

// Story 2.5：playbook 6 题材 quick-pick 建议（child5 craft seed 6 题材组）。
// 类型穷举 defer 9.4（design §5 F=(b)）——这只是输入辅助 chips，非封闭枚举门禁。
const PLAYBOOK_GENRE_QUICK_PICKS = ['玄幻仙侠', '都市职场', '言情', '历史穿越', '悬疑推理', '科幻末世'];

const DEBOUNCE_MS = 500;

function relativeTime(ts: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const mins = Math.floor((Date.now() - ts * 1000) / 60000);
  if (mins < 1) return t('timeline.timeJustNow');
  if (mins < 60) return t('timeline.timeMinutesAgo', { value: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('timeline.timeHoursAgo', { value: hrs });
  const days = Math.floor(hrs / 24);
  return t('timeline.timeDaysAgo', { value: days });
}

export function OverviewPage() {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const project = useAppStore((s) => s.currentProject);
  const chapters = useAppStore((s) => s.novelChapters) as NovelChapterMeta[];
  const updateProjectMeta = useAppStore((s) => s.updateProjectMeta);
  const saveProject = useAppStore((s) => s.saveProject);
  const showToast = useToastStore((s) => s.showToast);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const setActiveSidebarPanel = useAppStore((s) => s.setActiveSidebarPanel);
  // 设定页跳转闭环（B 波 polish，task 08-30；CR P12/P20 修订）：统计条人物/地点数可点 →
  // 设定页（PatchReviewPanel toast→setActivePage 跳转先例同款通道；setSettingTypeFilter
  // 预选类型——slice 未水合先读回持久化基线再叠加，不覆盖既有视图态，CR P2①）。
  const setSettingTypeFilter = useAppStore((s) => s.setSettingTypeFilter);

  const outline = useAppStore((s) => s.creativeFields.outline) as OutlineV2 | undefined;
  const worldSetting = useAppStore((s) => s.creativeFields.world_setting) as WorldSetting | undefined;
  const assetCards = useAppStore((s) => s.creativeFields.asset_cards) as AssetCard[] | undefined;
  const creativeBrief = useAppStore((s) => s.creativeFields.creative_brief) as CreativeBrief | undefined;

  const jumpToSettingCards = (type: 'character' | 'location') => {
    // CR P20：预选前查该类型真实卡数——地点数是两源合计（asset_cards 优先，无 location 卡
    // 时全量来自 legacy world_setting.locations 回退——统计有数但设定页没有该类卡）。此时
    // 预选会经 effectiveTypeFilter 死过滤回落 'all'＝静默错位（点「地点 5」落全卡列表）；
    // 无卡不预选，显式落 'all'。
    const hasCards = (assetCards ?? []).some((c) => c.type === type);
    setSettingTypeFilter(hasCards ? type : 'all');
    setActivePage('setting');
  };

  // Story 2.5：inline 编辑 genre_tags / world_constitution 走 creativeFieldsSlice.updateField
  // （mirror 既有 creative field 编辑流：set field → version bump → syncField IPC → project.yaml）。
  // commitments 只读展示（design A 决策：编辑走对话非 inline）。
  const updateField = useAppStore((s) => s.updateField);

  const [name, setName] = useState('');
  const [logline, setLogline] = useState('');
  const [synopsis, setSynopsis] = useState('');
  const [versions, setVersions] = useState<GitCommitEntry[]>([]);
  const [coverBust, setCoverBust] = useState(0);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'ok' | 'warn' | 'error' | null>(null);
  const [healthHint, setHealthHint] = useState('');

  // Story 2.5 承诺区 inline 输入框状态（genre_tags / world_constitution）。
  const [genreTagInput, setGenreTagInput] = useState('');
  const [constitutionInput, setConstitutionInput] = useState('');

  // Identity of the project we last hydrated local fields from. Used to
  // re-seed inputs only on a real project switch, not on our own meta writes.
  const hydratedPathRef = useRef<string | null>(null);
  // Gates the debounced flush so we never write back a value we merely loaded.
  const userEditedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Story 3.4（R5）：Tracks the last meta snapshot WE wrote to the store. Used to
  // distinguish our own writes (keystroke → updateProjectMeta → store changes →
  // effect fires) from external changes (agent patch / other panel edits currentProject).
  // When the store meta matches lastWrittenMetaRef, it's our own write → skip re-seed.
  // When it differs AND the user isn't actively typing (userEditedRef=false) → external
  // change → re-seed. Mirror OutlineEditor.tsx self-heal guard (storeOutline !== lastWrittenRef).
  const lastWrittenMetaRef = useRef<{ name: string; logline: string; synopsis: string }>({
    name: '', logline: '', synopsis: ''
  });

  // Hydrate local inputs from the project. Keyed on path for project switches;
  // for same-project content changes (agent patch), re-seed only when the change
  // is external (not our own write) and the user isn't mid-keystroke (userEditedRef gate).
  useEffect(() => {
    if (!project) return;
    const projectPath = project.path ?? null;
    const storeMeta = {
      name: project.name ?? '',
      logline: project.logline ?? '',
      synopsis: project.synopsis ?? '',
    };

    // Project switch: always re-seed.
    if (hydratedPathRef.current !== projectPath) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
      hydratedPathRef.current = projectPath;
      userEditedRef.current = false;
      lastWrittenMetaRef.current = storeMeta;
      setName(storeMeta.name);
      setLogline(storeMeta.logline);
      setSynopsis(storeMeta.synopsis);
      setSnapshotLoading(false);
      return;
    }

    // Same project: skip if this is our own write (updateProjectMeta on each
    // keystroke creates a new currentProject object, firing this effect).
    const last = lastWrittenMetaRef.current;
    if (
      storeMeta.name === last.name &&
      storeMeta.logline === last.logline &&
      storeMeta.synopsis === last.synopsis
    ) {
      return;
    }

    // External change (agent patch / other panel) — re-seed only when the user
    // isn't actively typing (don't steal focus / clobber mid-keystroke).
    if (userEditedRef.current) return;
    lastWrittenMetaRef.current = storeMeta;
    setName(storeMeta.name);
    setLogline(storeMeta.logline);
    setSynopsis(storeMeta.synopsis);
  }, [project]);

  const markEdited = () => {
    userEditedRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!userEditedRef.current) return;
      userEditedRef.current = false;
      void saveProject();
    }, DEBOUNCE_MS);
  };

  // Flush any pending edit on unmount.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (userEditedRef.current) {
      userEditedRef.current = false;
      void saveProject();
    }
  }, [saveProject]);

  // Load recent version nodes for the activity feed. Best-effort: a project
  // with no repo simply shows an empty activity stream.
  const projectPath = project?.path;
  useEffect(() => {
    if (!projectPath) { setVersions([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        if (await gitIsRepo(projectPath)) {
          const log = await gitLog(projectPath, 4);
          if (!cancelled) setVersions(log);
        } else if (!cancelled) {
          setVersions([]);
        }
      } catch {
        if (!cancelled) setVersions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  // Project health check
  useEffect(() => {
    if (!projectPath) { setHealthStatus(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const isRepo = await gitIsRepo(projectPath);
        if (cancelled) return;
        if (!isRepo) {
          setHealthStatus('warn');
          setHealthHint(t('overview.healthNoRepo'));
          return;
        }
        const dirtyCount = await gitStatusCount(projectPath);
        if (cancelled) return;
        if (dirtyCount > 0) {
          setHealthStatus('warn');
          setHealthHint(t('overview.healthUnsaved', { count: dirtyCount }));
          return;
        }
        setHealthStatus('ok');
        setHealthHint(t('overview.healthOk'));
      } catch {
        if (!cancelled) {
          setHealthStatus('error');
          setHealthHint(t('overview.healthError'));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath, versions, t]);

  // Snapshot handler
  const handleSnapshot = async () => {
    if (!projectPath || snapshotLoading) return;
    const capturedProjectPath = projectPath;
    const isCurrentProject = () => normalizePath(
      useAppStore.getState().currentProject?.path ?? '',
    ) === normalizePath(capturedProjectPath);
    setSnapshotLoading(true);
    try {
      const now = new Date();
      const msg = `snapshot: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
      await gitCreateNode(capturedProjectPath, msg);
      if (!isCurrentProject()) return;
      const log = await gitLog(capturedProjectPath, 4);
      if (!isCurrentProject()) return;
      setVersions(log);
      showToast(t('overview.snapshotSuccess'), 'success');
    } catch (err) {
      if (!isCurrentProject()) return;
      const reason = err instanceof Error ? err.message : String(err);
      showToast(t('overview.snapshotFailed', { reason }), 'error');
    } finally {
      if (isCurrentProject()) setSnapshotLoading(false);
    }
  };

  // Stats
  const totalChapters = chapters.length;
  const projectWordCount = useAppStore((s) => s.projectWordCount);
  const refreshWordCount = useAppStore((s) => s.refreshWordCount);
  // Recompute word count when the chapter set changes (not just on mount), so
  // adding/editing chapters reflects without leaving and re-entering the page.
  useEffect(() => { void refreshWordCount(); }, [refreshWordCount, chapters.length]);
  const totalWords = projectWordCount;
  const characterCount = assetCards?.filter((c) => c.type === 'character').length ?? 0;
  // CR-003：地点/规则从 asset_cards 聚合（D5 统一实体到卡），旧项目 fallback world_setting 旧 string[]
  // 字段。asset_cards 优先（新项目经 asset-loader 产卡）；为空时回退 world_setting.locations/rules
  // （既有项目数据在那）。两路任一有值都不显示空——落地公理（避免新项目地点数恒 0）。
  const assetLocationNames = (assetCards ?? [])
    .filter((c) => c.type === 'location')
    .map((c) => c.name);
  const legacyLocationNames = worldSetting?.locations?.map((l) => l.name) ?? [];
  const locationNames = assetLocationNames.length > 0 ? assetLocationNames : legacyLocationNames;
  const locationCount = locationNames.length;
  const assetRuleNames = (assetCards ?? [])
    .filter((c) => c.type === 'rule')
    .map((c) => c.name);
  const legacyRules = worldSetting?.rules ?? [];
  // dogfood R2 #102：world_constitution 是不少项目唯一有数据的世界观载体（本项目 5 条，
  // 同页下方就有 constitution 编辑器）——era/rules/locations 全空时摘要回退到
  // constitution 前几条，而非误显「暂未设定世界观」。
  const worldConstitution = worldSetting?.world_constitution ?? [];
  const ruleLabels =
    assetRuleNames.length > 0 ? assetRuleNames
      : legacyRules.length > 0 ? legacyRules
        : worldConstitution;
  const era = worldSetting?.era;
  const hasWorldSummary = Boolean(era) || ruleLabels.length > 0 || locationNames.length > 0;

  // Phase progress
  const phases = outline?.phases ?? [];
  const currentPhaseIndex = (() => {
    if (phases.length === 0) return -1;
    const lastChapterOrder = chapters.length > 0
      ? Math.max(...chapters.map((c) => c.sortOrder))
      : 0;
    let acc = 0;
    for (let i = 0; i < phases.length; i++) {
      acc += phases[i].estimated_chapters ?? 0;
      if (lastChapterOrder <= acc) return i;
    }
    return phases.length - 1;
  })();

  // Recent chapters (last 3 by sort order)
  const recentChapters = [...chapters]
    .sort((a, b) => b.sortOrder - a.sortOrder)
    .slice(0, 3);

  const hasActivity = versions.length > 0 || recentChapters.length > 0;

  // Open a chapter's manuscript file as a tab (the source of truth). Shared with
  // the writing page chapter column via openWriting() so both drive one flow.
  const openChapter = (chapter?: NovelChapterMeta) => openWriting(chapter);

  // Pick a cover image, copy it into the project as cover.<ext>, and persist it
  // to the project meta — the same flow as project creation. The cover is a
  // first-class project field, not derived from the assets library.
  const handlePickCover = async () => {
    if (!projectPath) return;
    const capturedProjectPath = projectPath;
    const isCurrentProject = () => normalizePath(
      useAppStore.getState().currentProject?.path ?? '',
    ) === normalizePath(capturedProjectPath);
    const src = await window.orisonDesktop?.pickCoverImage();
    if (!src || !isCurrentProject()) return;
    const previousCover = project?.coverImage;
    const dest = await window.orisonDesktop.copyCoverImage(src, capturedProjectPath);
    if (!isCurrentProject()) return;
    updateProjectMeta({ coverImage: dest });
    try {
      await saveProject();
    } catch (err) {
      if (!isCurrentProject()) return;
      // The cover file was copied but the meta write failed (e.g. disk/permission).
      // Roll the in-memory pointer back so the UI doesn't show a cover that
      // vanishes on reload, and tell the user instead of failing silently.
      updateProjectMeta({ coverImage: previousCover });
      const reason = err instanceof Error ? err.message : String(err);
      showToast(t('creative.coverSaveFailed', { reason }), 'error');
      return;
    }
    if (!isCurrentProject()) return;
    // The destination path is stable (cover.<ext>); bump a cache-buster so the
    // <img> re-fetches when the file is replaced in place.
    setCoverBust((n) => n + 1);
  };

  const coverImage = project?.coverImage;

  // ── Story 2.5 GenreContract 承诺区 inline 编辑 handlers ──
  // genre_tags / world_constitution 是简单字段，inline 加删走 creativeFieldsSlice.updateField
  // （set 整个 creative_brief / world_setting，mirror 既有 creative field 编辑流）。
  // commitments 只读（design A：编辑走工作台对话非 inline 表单）。

  const genreTags = creativeBrief?.genre_tags ?? [];
  const commitments = creativeBrief?.commitments ?? [];
  // worldConstitution 已在摘要派生区声明（dogfood R2 #102 摘要回退消费）。

  const addGenreTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || genreTags.includes(trimmed)) return;
    updateField('creative_brief', { ...creativeBrief, genre_tags: [...genreTags, trimmed], rawRequirement: creativeBrief?.rawRequirement ?? '' });
    setGenreTagInput('');
  };
  const removeGenreTag = (tag: string) => {
    updateField('creative_brief', { ...creativeBrief, genre_tags: genreTags.filter((t) => t !== tag), rawRequirement: creativeBrief?.rawRequirement ?? '' });
  };
  const addConstitution = (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return;
    updateField('world_setting', { ...worldSetting, world_constitution: [...worldConstitution, trimmed] });
    setConstitutionInput('');
  };
  const removeConstitution = (idx: number) => {
    updateField('world_setting', { ...worldSetting, world_constitution: worldConstitution.filter((_, i) => i !== idx) });
  };

  return (
    <div className="overview-page">
      {/* ── Hero ── */}
      <section className="overview-hero">
        <div className={`overview-cover${coverImage ? '' : ' overview-cover--empty'}`}>
          {coverImage ? (
            <button
              type="button"
              className="overview-cover-set"
              onClick={() => { void handlePickCover(); }}
              title={t('overview.changeCover')}
            >
              <img className="overview-cover-img" src={`orison-file:///${coverImage}?v=${coverBust}`} alt="" />
              <span className="overview-cover-overlay">
                <span className="material-symbols-outlined">photo_camera</span>
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="overview-cover-placeholder"
              onClick={() => { void handlePickCover(); }}
              title={t('overview.setCover')}
            >
              <span className="material-symbols-outlined">add_photo_alternate</span>
            </button>
          )}
        </div>
        <div className="overview-hero-body">
          <div className="overview-header-row">
            <input
              className="overview-name-input"
              placeholder={t('overview.projectName')}
              value={name}
              onChange={(e) => {
                const value = e.target.value;
                setName(value);
                const resolved = value || (project?.name ?? '');
                updateProjectMeta({ name: resolved });
                lastWrittenMetaRef.current = { ...lastWrittenMetaRef.current, name: resolved };
                markEdited();
              }}
            />
            {project?.type && (
              <span className="overview-type-badge">
                {project.type === 'novel' ? t('overview.typeNovel') : t('overview.typeScript')}
              </span>
            )}
          </div>
          <input
            className="overview-logline-input"
            placeholder={t('overview.loglinePlaceholder')}
            value={logline}
            onChange={(e) => {
              const value = e.target.value;
              setLogline(value);
              updateProjectMeta({ logline: value || undefined });
              lastWrittenMetaRef.current = { ...lastWrittenMetaRef.current, logline: value };
              markEdited();
            }}
          />
          <textarea
            className="overview-synopsis-input"
            placeholder={t('overview.synopsisPlaceholder')}
            value={synopsis}
            onChange={(e) => {
              const value = e.target.value;
              setSynopsis(value);
              updateProjectMeta({ synopsis: value || undefined });
              lastWrittenMetaRef.current = { ...lastWrittenMetaRef.current, synopsis: value };
              markEdited();
            }}
            rows={2}
          />
        </div>
      </section>

      {/* ── Story 2.5 GenreContract 承诺区 ── */}
      <section className="overview-contract">
        <h3 className="overview-section-title">{t('overview.contractSection')}</h3>

        {/* genre_tags：inline chips 加删 + playbook 6 题材 quick-pick */}
        <div className="overview-contract-group">
          <span className="overview-contract-label">{t('overview.contractGenreTags')}</span>
          <div className="overview-contract-tags">
            {genreTags.map((tag) => (
              <span key={tag} className="overview-contract-chip">
                {tag}
                <button
                  type="button"
                  className="overview-contract-chip-remove"
                  onClick={() => { removeGenreTag(tag); }}
                  title={t('overview.contractGenreTagsRemove')}
                  aria-label={t('overview.contractGenreTagsRemove')}
                >×</button>
              </span>
            ))}
            <input
              className="overview-contract-chip-input"
              placeholder={t('overview.contractGenreTagsHint')}
              value={genreTagInput}
              onChange={(e) => { setGenreTagInput(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addGenreTag(genreTagInput); }
              }}
            />
          </div>
          <details className="overview-contract-quickpick">
            <summary className="overview-contract-quickpick-summary">{t('overview.contractGenreTagsQuickPick')}</summary>
            <div className="overview-contract-quickpick-list">
              {PLAYBOOK_GENRE_QUICK_PICKS.filter((g) => !genreTags.includes(g)).map((g) => (
                <button
                  key={g}
                  type="button"
                  className="overview-contract-quickpick-item"
                  onClick={() => { addGenreTag(g); }}
                >{g}</button>
              ))}
            </div>
          </details>
        </div>

        {/* world_constitution：inline 列表加删（impossible list） */}
        <div className="overview-contract-group">
          <span className="overview-contract-label">{t('overview.contractWorldConstitution')}</span>
          {worldConstitution.length > 0 && (
            <ul className="overview-contract-rules">
              {worldConstitution.map((rule, i) => (
                <li key={`${rule}-${i}`} className="overview-contract-rule">
                  <span className="overview-contract-rule-text">{rule}</span>
                  <button
                    type="button"
                    className="overview-contract-rule-remove"
                    onClick={() => { removeConstitution(i); }}
                    title={t('overview.contractWorldConstitutionRemove')}
                    aria-label={t('overview.contractWorldConstitutionRemove')}
                  >×</button>
                </li>
              ))}
            </ul>
          )}
          <input
            className="overview-contract-rule-input"
            placeholder={t('overview.contractWorldConstitutionHint')}
            value={constitutionInput}
            onChange={(e) => { setConstitutionInput(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addConstitution(constitutionInput); }
            }}
          />
        </div>

        {/* commitments：只读展示。dogfood 2026-08-21：「在工作台深化」按钮退役——工作台
            本就常开（13 号 finding 后默认展开），按钮无增量价值；空态留一行备注指路即可。 */}
        <div className="overview-contract-group">
          <span className="overview-contract-label">{t('overview.contractCommitments')}</span>
          {commitments.length > 0 ? (
            <ul className="overview-contract-commitments">
              {commitments.map((c, i) => (
                <li key={`${c.type}-${i}`} className="overview-contract-commitment">
                  <span className="overview-contract-commitment-type">{c.type}</span>
                  <span className="overview-contract-commitment-content">{c.content}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="overview-empty-hint">{t('overview.contractCommitmentsEmpty')}</p>
          )}
        </div>
      </section>

      {/* ── dogfood R2 #22：工作方式卡——creative_preferences 四轴显示与直改（暗数据补面） ── */}
      <WorkingStyleSection />

      {/* ── Quick actions ── */}
      <section className="overview-actions">
        <button type="button" className="overview-action overview-action--primary" onClick={() => { void openChapter(); }}>
          <span className="material-symbols-outlined">edit_note</span>
          {t('overview.continueWriting')}
        </button>
        <button type="button" className="overview-action" onClick={() => setActivePage('outline')}>
          <span className="material-symbols-outlined">account_tree</span>
          {t('overview.openOutline')}
        </button>
        <button type="button" className="overview-action" onClick={() => setActiveSidebarPanel('timeline')}>
          <span className="material-symbols-outlined">history</span>
          {t('overview.openTimeline')}
        </button>
        <button type="button" className="overview-action" onClick={() => { void handleSnapshot(); }} disabled={snapshotLoading}>
          <span className="material-symbols-outlined">save</span>
          {snapshotLoading ? t('overview.snapshotSaving') : t('overview.saveSnapshot')}
        </button>
      </section>

      {/* ── Compact stat strip ── */}
      <section className="overview-stat-strip">
        {healthStatus && (
          <div className={`overview-stat overview-health overview-health--${healthStatus}`} title={healthHint}>
            <span className="material-symbols-outlined">
              {healthStatus === 'ok' ? 'check_circle' : healthStatus === 'warn' ? 'warning' : 'error'}
            </span>
            <span className="overview-stat-label">{healthHint}</span>
          </div>
        )}
        <div className="overview-stat">
          <span className="material-symbols-outlined">menu_book</span>
          <span className="overview-stat-value">{totalChapters}</span>
          <span className="overview-stat-label">{t('overview.chapters')}</span>
        </div>
        <div className="overview-stat">
          <span className="material-symbols-outlined">text_fields</span>
          <span className="overview-stat-value">{totalWords.toLocaleString()}</span>
          <span className="overview-stat-label">{t('overview.words')}</span>
        </div>
        <div
          className="overview-stat overview-stat--link"
          role="button"
          tabIndex={0}
          title={t('nav.setting')}
          data-overview-jump="character"
          onClick={() => jumpToSettingCards('character')}
          onKeyDown={(e) => {
            // div[role=button] 键盘语义补全（CR P12）：Space 默认滚动页面必须 preventDefault；
            // 长按 repeat 连跳一并拦（Enter 同路径）。
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            if (!e.repeat) jumpToSettingCards('character');
          }}
        >
          <span className="material-symbols-outlined">person</span>
          <span className="overview-stat-value">{characterCount}</span>
          <span className="overview-stat-label">{t('overview.characters')}</span>
        </div>
        <div
          className="overview-stat overview-stat--link"
          role="button"
          tabIndex={0}
          title={t('nav.setting')}
          data-overview-jump="location"
          onClick={() => jumpToSettingCards('location')}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            if (!e.repeat) jumpToSettingCards('location');
          }}
        >
          <span className="material-symbols-outlined">location_on</span>
          <span className="overview-stat-value">{locationCount}</span>
          <span className="overview-stat-label">{t('overview.locations')}</span>
        </div>
      </section>

      {/* ── Segmented phase progress ── */}
      {phases.length > 0 && (
        <section className="overview-progress" onClick={() => setActivePage('outline')} role="button" tabIndex={0}>
          <div className="overview-progress-segments">
            {phases.map((p, i) => (
              <div
                key={p.id ?? i}
                className={`overview-progress-segment${i <= currentPhaseIndex ? ' is-done' : ''}${i === currentPhaseIndex ? ' is-current' : ''}`}
                title={p.title}
              />
            ))}
          </div>
          <span className="overview-progress-label">
            {t('overview.phaseProgress', {
              current: currentPhaseIndex + 1,
              total: phases.length,
              name: phases[currentPhaseIndex]?.title ?? '',
            })}
          </span>
        </section>
      )}

      {/* ── Bottom grid: activity feed + world summary ── */}
      <section className="overview-bottom-grid">
        <div className="overview-activity">
          <h3 className="overview-section-title">{t('overview.activity')}</h3>
          {hasActivity ? (
            <ul className="overview-activity-list">
              {versions.map((v) => (
                <li key={v.oid} className="overview-activity-item" onClick={() => setActiveSidebarPanel('timeline')} role="button" tabIndex={0}>
                  <span className="material-symbols-outlined overview-activity-icon">commit</span>
                  <span className="overview-activity-text">
                    {v.tag && <span className="overview-activity-tag">{v.tag}</span>}
                    {v.message.split('\n')[0]}
                  </span>
                  <span className="overview-activity-time">{relativeTime(v.timestamp, t)}</span>
                </li>
              ))}
              {recentChapters.map((ch) => (
                <li key={ch.id} className="overview-activity-item" onClick={() => { void openChapter(ch); }} role="button" tabIndex={0}>
                  <span className="material-symbols-outlined overview-activity-icon">description</span>
                  <span className="overview-activity-text">{ch.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="overview-empty-hint">{t('overview.noActivity')}</p>
          )}
        </div>
        <div className="overview-world-summary">
          <h3 className="overview-section-title">{t('overview.worldSummary')}</h3>
          {hasWorldSummary ? (
            <div className="overview-world-content">
              {era && <p className="overview-world-line">{t('overview.era')}: {era}</p>}
              {ruleLabels.length > 0 && (
                <p className="overview-world-line">{t('overview.rules')}: {ruleLabels.slice(0, 2).join('、')}</p>
              )}
              {locationNames.length > 0 && (
                <p className="overview-world-line">{t('overview.coreLocations')}: {locationNames.slice(0, 3).join('、')}</p>
              )}
            </div>
          ) : (
            <p className="overview-empty-hint">{t('overview.noWorldSetting')}</p>
          )}
        </div>
      </section>
    </div>
  );
}

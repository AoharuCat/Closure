import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n/useI18n';
import { useShallow } from 'zustand/react/shallow';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { GeneralSettingsPage } from './settings/GeneralSettingsPage';
import { AppearanceSettingsPage } from './settings/AppearanceSettingsPage';
import { WritingSettingsPage } from './settings/WritingSettingsPage';
import { AgentSettingsPage } from './settings/AgentSettingsPage';
import { AboutSettingsPage } from './settings/AboutSettingsPage';
import { ModelSettingsPage } from '../../features/model-settings/ModelSettingsPage';
import { KbIndexSettingsPage } from '../../features/kb-index/KbIndexSettingsPage';
import { ResearchSettingsPage } from '../../features/research-settings/ResearchSettingsPage';
import { UsageSettingsPage } from '../../features/usage/UsageSettingsPage';
import { useToastStore } from '../store/toastStore';

type Props = { onClose: () => void };
type SettingsPageId = 'general' | 'appearance' | 'writing' | 'model' | 'agent' | 'kb-index' | 'research' | 'usage' | 'about';

const SETTINGS_PAGES: Array<{ id: SettingsPageId; icon: string; labelKey: string }> = [
  { id: 'general', icon: 'tune', labelKey: 'settings.general' },
  { id: 'appearance', icon: 'palette', labelKey: 'settings.appearance' },
  { id: 'writing', icon: 'edit_note', labelKey: 'settings.writing' },
  { id: 'model', icon: 'hub', labelKey: 'settings.modelConfig' },
  { id: 'agent', icon: 'smart_toy', labelKey: 'settings.agent' },
  { id: 'kb-index', icon: 'database', labelKey: 'settings.kbIndex' },
  { id: 'research', icon: 'travel_explore', labelKey: 'settings.research' },
  { id: 'usage', icon: 'monitoring', labelKey: 'settings.usage' },
  { id: 'about', icon: 'info', labelKey: 'settings.about' },
];

export function SettingsDialog({ onClose }: Props) {
  const {
    resolvedLocale, theme, setTheme, locale, setLocale,
    modelConfig, setModelConfig, loadModelConfig,
    readingFontFamily, setReadingFontFamily,
    readingFontWeight, setReadingFontWeight,
    readingFontScale, setReadingFontScale,
    autoCheckUpdates, setAutoCheckUpdates,
    appVersion, checkForUpdate,
    editorLineHeight, setEditorLineHeight,
    paragraphIndent, setParagraphIndent,
    showWordCount, setShowWordCount,
    autoSaveEnabled, setAutoSaveEnabled, persistPreferences,
    autoSaveInterval, setAutoSaveInterval,
    spellCheck, setSpellCheck,
    wordCountGoal, setWordCountGoal,
    contextRedlinePercent, setContextRedlinePercent,
    wallpaperUrl, setWallpaperUrl,
    wallpaperOpacity, setWallpaperOpacity,
    wallpaperFrostBlur, setWallpaperFrostBlur,
    interfaceScale, setInterfaceScale,
  } = useAppStore(useShallow((s) => ({
    resolvedLocale: s.resolvedLocale,
    theme: s.theme, setTheme: s.setTheme,
    locale: s.locale, setLocale: s.setLocale,
    modelConfig: s.modelConfig, setModelConfig: s.setModelConfig, loadModelConfig: s.loadModelConfig,
    readingFontFamily: s.readingFontFamily, setReadingFontFamily: s.setReadingFontFamily,
    readingFontWeight: s.readingFontWeight, setReadingFontWeight: s.setReadingFontWeight,
    readingFontScale: s.readingFontScale, setReadingFontScale: s.setReadingFontScale,
    autoCheckUpdates: s.autoCheckUpdates, setAutoCheckUpdates: s.setAutoCheckUpdates,
    appVersion: s.appVersion, checkForUpdate: s.checkForUpdate,
    editorLineHeight: s.editorLineHeight, setEditorLineHeight: s.setEditorLineHeight,
    paragraphIndent: s.paragraphIndent, setParagraphIndent: s.setParagraphIndent,
    showWordCount: s.showWordCount, setShowWordCount: s.setShowWordCount,
    autoSaveEnabled: s.autoSaveEnabled, setAutoSaveEnabled: s.setAutoSaveEnabled,
    persistPreferences: s.persistPreferences,
    autoSaveInterval: s.autoSaveInterval, setAutoSaveInterval: s.setAutoSaveInterval,
    spellCheck: s.spellCheck, setSpellCheck: s.setSpellCheck,
    wordCountGoal: s.wordCountGoal, setWordCountGoal: s.setWordCountGoal,
    contextRedlinePercent: s.contextRedlinePercent, setContextRedlinePercent: s.setContextRedlinePercent,
    wallpaperUrl: s.wallpaperUrl, setWallpaperUrl: s.setWallpaperUrl,
    wallpaperOpacity: s.wallpaperOpacity, setWallpaperOpacity: s.setWallpaperOpacity,
    wallpaperFrostBlur: s.wallpaperFrostBlur, setWallpaperFrostBlur: s.setWallpaperFrostBlur,
    interfaceScale: s.interfaceScale, setInterfaceScale: s.setInterfaceScale,
  })));

  const { t } = useI18n(resolvedLocale);
  const showToast = useToastStore((s) => s.showToast);
  const [activePage, setActivePage] = useState<SettingsPageId>('general');
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose);

  const renderPage = () => {
    switch (activePage) {
      case 'general':
        return (
          <GeneralSettingsPage
            t={t}
            theme={theme}
            setTheme={setTheme}
            locale={locale}
            setLocale={setLocale}
            autoCheckUpdates={autoCheckUpdates}
            setAutoCheckUpdates={setAutoCheckUpdates}
            appVersion={appVersion}
            onCheckForUpdate={() => { void checkForUpdate(); }}
            contextRedlinePercent={contextRedlinePercent}
            setContextRedlinePercent={setContextRedlinePercent}
          />
        );
      case 'appearance':
        return (
          <AppearanceSettingsPage
            t={t}
            editorLineHeight={editorLineHeight}
            setEditorLineHeight={setEditorLineHeight}
            readingFontFamily={readingFontFamily}
            setReadingFontFamily={setReadingFontFamily}
            readingFontWeight={readingFontWeight}
            setReadingFontWeight={setReadingFontWeight}
            readingFontScale={readingFontScale}
            setReadingFontScale={setReadingFontScale}
            wallpaperUrl={wallpaperUrl}
            setWallpaperUrl={setWallpaperUrl}
            wallpaperOpacity={wallpaperOpacity}
            setWallpaperOpacity={setWallpaperOpacity}
            wallpaperFrostBlur={wallpaperFrostBlur}
            setWallpaperFrostBlur={setWallpaperFrostBlur}
            interfaceScale={interfaceScale}
            setInterfaceScale={setInterfaceScale}
          />
        );
      case 'writing':
        return (
          <WritingSettingsPage
            t={t}
            paragraphIndent={paragraphIndent}
            setParagraphIndent={setParagraphIndent}
            showWordCount={showWordCount}
            setShowWordCount={setShowWordCount}
            autoSaveEnabled={autoSaveEnabled}
            setAutoSaveEnabled={setAutoSaveEnabled}
            persistPreferences={persistPreferences}
            autoSaveInterval={autoSaveInterval}
            setAutoSaveInterval={setAutoSaveInterval}
            spellCheck={spellCheck}
            setSpellCheck={setSpellCheck}
            wordCountGoal={wordCountGoal}
            setWordCountGoal={setWordCountGoal}
          />
        );
      case 'model':
        return (
          <ModelSettingsPage
            t={t}
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
          />
        );
      case 'agent':
        return (
          <AgentSettingsPage
            t={t}
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
            reloadConfig={loadModelConfig}
          />
        );
      case 'kb-index':
        return <KbIndexSettingsPage t={t} />;
      case 'research':
        return <ResearchSettingsPage t={t} />;
      case 'usage':
        return <UsageSettingsPage t={t} />;
      case 'about':
        return (
          <AboutSettingsPage
            t={t}
            appVersion={appVersion}
            onCopied={() => showToast(t('settings.aboutCopied'), 'success')}
          />
        );
    }
  };

  return (
    <div className="topbar-new-dialog-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="settings-dialog" ref={dialogRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="settings-dialog-header">
          <h2 className="settings-dialog-title">{t('nav.settings')}</h2>
          <button type="button" className="settings-dialog-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="settings-dialog-body settings-dialog-body-with-nav">
          <nav className="settings-dialog-nav" aria-label={t('nav.settings')}>
            {SETTINGS_PAGES.map((page) => (
              <button
                key={page.id}
                type="button"
                className={`settings-dialog-nav-item${activePage === page.id ? ' is-active' : ''}`}
                onClick={() => setActivePage(page.id)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">{page.icon}</span>
                <span>{t(page.labelKey)}</span>
              </button>
            ))}
          </nav>

          <section className="settings-dialog-page">
            {renderPage()}
          </section>
        </div>
      </div>
    </div>
  );
}

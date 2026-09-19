import logoUrl from '../../../assets/logo.png';

// 08-28 快速发布回填：GitHub 公仓 AoharuCat/Closure 上线，外部链接恢复跳转。
const HOMEPAGE_URL = 'https://github.com/AoharuCat/Closure';
const DEVELOPER_URL = 'https://github.com/AoharuCat';
const FEEDBACK_URL = 'https://github.com/AoharuCat/Closure/issues';
const QQ_GROUP = '1106823246';

type Props = {
  t: (key: string) => string;
  appVersion: string;
  onCopied: () => void;
};

function openExternal(url: string): void {
  window.orisonDesktop?.openExternal?.(url);
}

/** Strip protocol for display (https://github.com/foo/bar → github.com/foo/bar). */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export function AboutSettingsPage({ t, appVersion, onCopied }: Props) {
  const copyQQ = async () => {
    if (!QQ_GROUP) return;
    try {
      await navigator.clipboard.writeText(QQ_GROUP);
      onCopied();
    } catch {
      /* clipboard blocked — the number is shown inline, user can copy manually */
    }
  };
  const comingSoon = t('settings.aboutComingSoon');

  return (
    <div className="settings-page about-page">
      <header className="about-hero">
        <div className="about-logo" aria-hidden="true">
          <img src={logoUrl} alt="" />
        </div>
        <div className="about-brand">
          <span className="about-name">Closure</span>
          {appVersion && <span className="about-version">v{appVersion}</span>}
        </div>
        <p className="about-tagline">{t('settings.aboutTagline')}</p>
      </header>

      <div className="about-links">
        <button
          type="button"
          className="about-link-card"
          disabled={!HOMEPAGE_URL}
          onClick={() => HOMEPAGE_URL && openExternal(HOMEPAGE_URL)}
        >
          <span className="about-link-icon material-symbols-outlined" aria-hidden="true">home</span>
          <span className="about-link-text">
            <span className="about-link-label">{t('settings.aboutHomepage')}</span>
            <span className="about-link-value">{HOMEPAGE_URL ? displayUrl(HOMEPAGE_URL) : comingSoon}</span>
          </span>
          <span className="about-link-action material-symbols-outlined" aria-hidden="true">open_in_new</span>
        </button>

        <button
          type="button"
          className="about-link-card"
          disabled={!DEVELOPER_URL}
          onClick={() => DEVELOPER_URL && openExternal(DEVELOPER_URL)}
        >
          <span className="about-link-icon material-symbols-outlined" aria-hidden="true">code</span>
          <span className="about-link-text">
            <span className="about-link-label">{t('settings.aboutDeveloper')}</span>
            <span className="about-link-value">{DEVELOPER_URL ? displayUrl(DEVELOPER_URL) : comingSoon}</span>
          </span>
          <span className="about-link-action material-symbols-outlined" aria-hidden="true">open_in_new</span>
        </button>

        <button
          type="button"
          className="about-link-card"
          disabled={!FEEDBACK_URL}
          onClick={() => FEEDBACK_URL && openExternal(FEEDBACK_URL)}
        >
          <span className="about-link-icon material-symbols-outlined" aria-hidden="true">forum</span>
          <span className="about-link-text">
            <span className="about-link-label">{t('settings.aboutFeedback')}</span>
            <span className="about-link-value">{FEEDBACK_URL ? t('settings.aboutFeedbackValue') : comingSoon}</span>
          </span>
          <span className="about-link-action material-symbols-outlined" aria-hidden="true">open_in_new</span>
        </button>

        <button
          type="button"
          className="about-link-card"
          disabled={!QQ_GROUP}
          onClick={() => { void copyQQ(); }}
          title={t('settings.aboutCopied')}
        >
          <span className="about-link-icon material-symbols-outlined" aria-hidden="true">groups</span>
          <span className="about-link-text">
            <span className="about-link-label">{t('settings.aboutQQGroup')}</span>
            <span className="about-link-value">{QQ_GROUP || comingSoon}</span>
          </span>
          <span className="about-link-action material-symbols-outlined" aria-hidden="true">content_copy</span>
        </button>
      </div>

      <p className="about-license">{t('settings.aboutLicenseNotice')}</p>
    </div>
  );
}

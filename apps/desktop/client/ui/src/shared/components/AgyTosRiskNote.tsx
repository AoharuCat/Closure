/**
 * Agy CLI ToS 灰区风险备注行（09-12 子5，design §6 单文件单源）。
 *
 * 文案单源 = 子1 已落地 i18n 键 `settings.cliTosRiskNote`（zh/en 双语在 settings.yaml，
 * 用户改字只动 yaml 一处）——本组件**只渲染不拼串、不立第二文案**。三个接触面共用：
 * ① 模型配置页 CLI provider 区（原行内 span 本组件化）；② 设置页「用量」段；
 * ③ 子4 同意对话框（后续消费）。
 */
import type { ReactNode } from 'react';

/** 文案键常量（跨接触面统一 import 本常量，禁散写字符串）。 */
export const AGY_TOS_RISK_NOTE_KEY = 'settings.cliTosRiskNote';

type Props = {
  /** 译者（调用方作用域的 useI18n / translate 产物——本组件不自带 hook，保持纯渲染）。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** 追加类名（个别接触面需要更小字号时可覆盖，缺省弱化小字）。 */
  className?: string;
  children?: ReactNode;
};

export function AgyTosRiskNote({ t, className, children }: Props) {
  return (
    <span className={`agytos-risk-note${className ? ` ${className}` : ''}`}>
      {t(AGY_TOS_RISK_NOTE_KEY)}
      {children}
    </span>
  );
}

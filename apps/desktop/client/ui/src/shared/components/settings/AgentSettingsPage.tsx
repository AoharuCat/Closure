import type { ModelConfig } from '@orison/shared-contracts';
import { ModelAssignmentSections } from '../../../features/model-settings/ModelAssignmentSections';

/**
 * 「Agent」设置页。dogfood 2026-08-21（#43）改版：
 *
 * - 原唯一设置项「补丁模式」（autoApplyPatches 全局建议/自动开关）是 OrisonSpace
 *   遗留死配置——除持久化外零消费者（agent 运行时/补丁审阅链全程不读），实际生效的
 *   是工作台权限轴（微观/协助/全自动，per-session）。整链退役。
 * - 本页改为「模型分工」：任务模型（C3.2 六档路由）+ 向量模型 + 重排模型从模型配置
 *   页迁入——模型配置页回归纯「供应商管理」，本页管「哪个环节用哪个模型」。
 */
type Props = {
  /** 带 vars 插值的 t（thinking 档位元信息用到 {limit}/{min}/{max} 插值）。 */
  t: (key: string, vars?: Record<string, string | number>) => string;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => Promise<void>;
  /** C3.2 W2：预设 apply/delete 后的配置重读（store 的 loadModelConfig——只读回不回写）。 */
  reloadConfig?: () => Promise<void>;
};

export function AgentSettingsPage({ t, modelConfig, setModelConfig, reloadConfig }: Props) {
  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.agent')}</h3>
          <p className="settings-page-subtitle">{t('settings.agentSubtitle')}</p>
        </div>
      </div>

      <ModelAssignmentSections t={t} modelConfig={modelConfig} setModelConfig={setModelConfig} reloadConfig={reloadConfig} />
    </div>
  );
}

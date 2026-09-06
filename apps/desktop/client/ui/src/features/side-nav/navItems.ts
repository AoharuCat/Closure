import type { ActivePage } from '../../shared/store/appStore';

export type PageNavItem = { id: ActivePage; icon: string; i18nKey: string };

/** Group 1: Overview + Outline + Structure + Assets + Setting */
export const overviewItem: PageNavItem = { id: 'overview', icon: 'dashboard', i18nKey: 'nav.overview' };
export const outlineItem: PageNavItem = { id: 'outline', icon: 'auto_stories', i18nKey: 'nav.outline' };
export const structureItem: PageNavItem = { id: 'structure', icon: 'account_tree', i18nKey: 'nav.structure' };
export const assetsItem: PageNavItem = { id: 'assets', icon: 'perm_media', i18nKey: 'nav.assets' };
// 「设定」页（task 08-30-asset-cards-visualization，A1 波）：asset_cards 8 类设定卡的
// 浏览/编辑聚合页。id 用单数 'setting'（避开 SettingsDialog 的 app 级 settings 概念）；
// i18n 键 nav.setting 两 locale 已在位（test/settingPageI18n.test.ts 守卫齐平）。
export const settingItem: PageNavItem = { id: 'setting', icon: 'menu_book', i18nKey: 'nav.setting' };
// 「材料」页（Story 10.1 Wave D，D7 拍板独立左导航页）：摄取基座材料库管理面——scope
// 切换（本项目 ↔ 全局库）+ 列表/徽章 + 删除（D8 四清）/重摄取/批量拖入/provenance 后补。
export const materialsItem: PageNavItem = { id: 'materials', icon: 'inventory_2', i18nKey: 'nav.materials' };
// 「手艺」页（E10.2b W5）：经验文档蒸馏人审面——待阅队列/全部卡/废弃区/词表管理四 tab +
// 并排对比 + 材料页联动（蒸馏按钮/N 卡跳转）。紧邻材料页（语料来源→蒸馏产物的工作流序）。
export const craftItem: PageNavItem = { id: 'craft', icon: 'science', i18nKey: 'nav.craft' };
// 「拆书」页（E10.3b W6）：小说拆解管线面——新建拆解（档位/维度/预算预估）/pass 进度 +
// 人审闸门 / 产出阅读（读法·章评·细批·风格）/ 风格卡导出。紧邻手艺页（拆书产物 craft 落卡
// 跳转的手艺人审面）。
export const deconItem: PageNavItem = { id: 'decon', icon: 'auto_stories', i18nKey: 'nav.decon' };

/** Group 2: Production tools */
export const productionItems: PageNavItem[] = [
  { id: 'image_gen', icon: 'image', i18nKey: 'nav.imageGen' },
];


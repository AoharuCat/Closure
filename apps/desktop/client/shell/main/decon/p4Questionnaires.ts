import {
  DECON_DIMENSIONS,
  DECON_EMOTIONAL_BEATS,
  DECON_HOOK_TYPES,
  DECON_INFO_GAP_TYPES,
  DECON_PLOT_PHASES,
  DECON_TRANSITION_TYPES,
  type DeconCraftDimensionId,
  type DeconDimensionId,
} from '@orison/shared-contracts';

// ── E10.3b（task 09-05）W3a：P4 手艺层问题单（纯函数 prompt 构建器——B 的文学内容面）──
//
// 零 db / 零 LLM / 零 fs——本文件只有字符串与拼装函数；runner（p4Craft.ts）归 W3b。
//
// - **问题权威**：本 task design.md §3.1（维度目录 13 项 × 粒度面）+ §3.2（问题单协议四条）
//   + parent design §6.0 矩阵逐行；提问族 = parent research 三 digest。
// - **词汇权威**：钩子 11 型 / 转折 9 型 / 情绪 7 拍 / 四相位 / 信息差 6 型 **从 W1 契约常量
//   取词形（不复制）**；其余词汇轴为本文件单源，词形经《写作思维原理》原文核对不臆造——
//   欲望 9 型（txt:135-147）/ 剧情线 5 族子型（txt:902-933、1084-1088）/ 功能人物 8 类
//   （txt:263-272）/ 人物分级（txt:442-451）/ 信息展现 5 法（txt:785-813）/ 视角 6 型
//   （txt:298-331）/ 世界 8 件套（txt:426-435、1112）/ 整体结构三式（txt:76-104）/
//   线路组织 3 法（txt:934-958）/ 人设 3 思路（txt:598-611）/ 阻碍 8 类（txt:188-201）/
//   六步法（txt:110）。换地图前兆三件来自 wuhang digest（商业实践参照）。
// - **网文语境红线**（feedback-webnovel-framing-no-classical）：全部 prompt 文本平实网文语言；
//   零古典书名零人名、零反向禁令、零学院名号——时间/场景等概念一律操作化白话提问
//   （test 有 grep 守卫钉死）。
// - **弧级证据纪律**：弧级输入是概要 + 统计 + 聚合（非全文），findings 证据只能落在带段落号
//   的原文（抽样段 / 清单附的逐字引文）——概要与统计数字不是原文不能当证据（写进弧级输出
//   契约，防无锚结论混进弧级 findings）。
//
// expected_downstream_consumers:
// - W3b p4Craft.ts（runner）：按 DECON_P4_GRANULARITY 循环 dim × unit，system prompt 用
//   buildDeconP4SystemPrompt。user prompt 分节名对齐（软契约）：本章正文（【P段落号】标记）/
//   本章事实提取 / 本章打标 / 弧内各章概要 / 弧计量统计 / 本弧事实聚合 / 同类场景聚类。
// - W4 p5Output.ts（P5 book_reading）：buildDeconP4BookQuestionnaire 的书级问题单注入
//   （维 1/3/5），DECON_P4_STANCE_PROMPT 前置共用（design §3.2——立场段 P4/P5 共用）。
// - W3b p4Style.ts：style 维**不走本文件**（风格维特化独立模块）。

// ── 词表（受控注入面——mirror closure-craft-card.formatCraftCardCategories 格式）──

/** 词表条目（value = 正典词形〔单源：契约常量或原文核对〕；gloss = 操作化白话解释）。 */
export interface DeconVocabEntry {
  value: string;
  gloss: string;
}

/**
 * 把词表格式化成 prompt 注入文本（纯函数，mirror formatCraftCardCategories 的受控词表
 * 注入格式：【标题（受控…）】头 + 「value：gloss」行）。
 */
export function formatDeconVocabTable(title: string, entries: readonly DeconVocabEntry[]): string {
  return [
    `【${title}（受控——结论表述用表内词形，不要自造新词）】`,
    ...entries.map((e) => `${e.value}：${e.gloss}`),
  ].join('\n');
}

/** 契约枚举 × 释义按位 zip（词形单源自契约常量——gloss 数组与契约常量按位对齐，测试钉长度）。 */
function zipVocab(values: readonly string[], glosses: readonly string[]): DeconVocabEntry[] {
  return values.map((value, i) => ({ value, gloss: glosses[i] ?? '' }));
}

/** 期待感钩子 11 型（词形 = 契约 DECON_HOOK_TYPES）。 */
export const DECON_HOOK_VOCAB: readonly DeconVocabEntry[] = zipVocab(DECON_HOOK_TYPES, [
  '主角被形势逼到墙角，读者想看他怎么破局',
  '排名、榜单、宝物勾起占有欲',
  '人物关系与付出回报勾动情感（英雄救美、望子成龙、信念传承）',
  '主角在众人面前展露实力或真相',
  '集体困境中主角成为唯一的指望',
  '亮出「能解决眼前问题」的能力或方法',
  '金手指、神器、超凡力量登场',
  '未知人物、事件、谜题勾起想知道为什么',
  '主角掌控方法、运筹帷幄的确定性期待',
  '关键信息提前给读者（读者知、主角不知）吊着期待',
  '给出线索让读者形成预期，等着验证',
]);

/** 转折 9 型（词形 = 契约 DECON_TRANSITION_TYPES；三类分组见 gloss）。 */
export const DECON_TRANSITION_VOCAB: readonly DeconVocabEntry[] = zipVocab(DECON_TRANSITION_TYPES, [
  '阻碍递进类——冲突升级，阻碍变得更强',
  '阻碍递进类——原定解决方法失效或被换掉',
  '阻碍递进类——前文信息把读者带偏了方向',
  '目标颠覆类——事件结果偏离原目标',
  '目标颠覆类——结果与预期强烈反差',
  '目标颠覆类——规则或局势改变，颠覆原目标',
  '人物反差类——人物真实目的暴露或改变',
  '人物反差类——人物立场、身份反转',
  '人物反差类——人物关系动态逆转',
]);

/** 情绪动态 7 拍（词形 = 契约 DECON_EMOTIONAL_BEATS）。 */
export const DECON_EMOTIONAL_BEAT_VOCAB: readonly DeconVocabEntry[] = zipVocab(DECON_EMOTIONAL_BEATS, [
  '两难与来回撕扯',
  '事件推着情绪往前走',
  '情绪走高、渐入爽感',
  '情绪压低、积蓄憋屈',
  '先扬后抑或先抑后扬的波动',
  '倒计时、数量、距离带来的持续紧张感',
  '一步比一步紧的阶梯式加码',
]);

/** 剧情段四相位（词形 = 契约 DECON_PLOT_PHASES——单元四步的情绪相位）。 */
export const DECON_PLOT_PHASE_VOCAB: readonly DeconVocabEntry[] = zipVocab(DECON_PLOT_PHASES, [
  '起——立冲突立憋屈，让读者想看主角翻身',
  '承——试探与压抑，情绪往下攒',
  '转——爆发反转，情绪兑现',
  '合——收获余波，把战果与关系落定',
]);

/** 信息差 6 型（词形 = 契约 DECON_INFO_GAP_TYPES）。 */
export const DECON_INFO_GAP_VOCAB: readonly DeconVocabEntry[] = zipVocab(DECON_INFO_GAP_TYPES, [
  '读者知、主角知、他人不知——看旁人被打脸的期待',
  '读者知、主角不知——替主角着急',
  '读者不知、主角不知、他人知——谜团吊人',
  '读者不知、主角知——想看主角怎么翻',
  '叙述把巧合摊开给读者看',
  '主观视角带偏读者的判断',
]);

/** 情节六步法（原文核对原理 txt:110——中观环节名）。 */
export const DECON_SIX_STEPS: readonly DeconVocabEntry[] = [
  { value: '情绪事件', gloss: '开局砸下能勾起情绪的事件' },
  { value: '欲望目标', gloss: '主角明确想要什么' },
  { value: '困境阻碍', gloss: '拿到目标路上的阻力' },
  { value: '解决方法', gloss: '解决途径确立（能力途径或信息途径）' },
  { value: '行动解决', gloss: '正面碰撞、高潮与转折' },
  { value: '解决反馈', gloss: '战果结算与情绪回报' },
];

/** 视角 6 型（原文核对原理 txt:298-331）。 */
export const DECON_VIEWPOINT_TYPES: readonly DeconVocabEntry[] = [
  { value: '旁白镜头视角', gloss: '只叙述旁观可见的，不进心理，像镜头在拍' },
  { value: '上帝全知视角', gloss: '解释所有人的动机与行为，信息全开（适度用于解释剧情）' },
  { value: '主角主观视角', gloss: '只用主角的认知叙述，其余全不知' },
  { value: '友方主观视角', gloss: '切到友方视角看主角，衬托主角' },
  { value: '敌方主观视角', gloss: '切到敌方视角，从轻视到被打脸的反差' },
  { value: '旁观主观视角', gloss: '背景人物的围观反应，补信息、叠情绪' },
];

/** 信息展现 5 法（原文核对原理 txt:785-813）。 */
export const DECON_INFO_DISPLAY_METHODS: readonly DeconVocabEntry[] = [
  { value: '上帝全知信息展现', gloss: '直接告诉读者当前场景里发生着什么' },
  { value: '心理活动内心展现', gloss: '直接展示人物内心独白、认知与判断' },
  { value: '对话限制信息展现', gloss: '让人物在对话里自然透露信息（受身份限制）' },
  { value: '侧面描写信息展现', gloss: '用其他人的反应侧写人物、物品、事件' },
  { value: '行为反应暗示展现', gloss: '用行为、微表情、习惯动作透信息' },
];

/** 代入 5 维（原文核对原理 txt:747 附近——共鸣代入五维）。 */
export const DECON_IMMERSION_DIMENSIONS: readonly DeconVocabEntry[] = [
  { value: '情绪', gloss: '让读者与人物情绪同频' },
  { value: '逻辑', gloss: '因果顺畅，读者跟得上为什么' },
  { value: '场景', gloss: '镜头画面与六觉刻画（五感加代入感受），让读者身临其境' },
  { value: '视角', gloss: '主观视角与心理描写带着读者走' },
  { value: '信息', gloss: '信息给的时机与量刚好维持好奇' },
];

/** 欲望 9 型（原文核对原理 txt:135-147——全名词形，马斯洛五层加四欲）。 */
export const DECON_DESIRE_TYPES: readonly DeconVocabEntry[] = [
  { value: '生理需求-生存欲望', gloss: '迫害与生命危险下的求生动力' },
  { value: '安全需求-需求贪欲', gloss: '更多钱、更好资源、更安全的环境' },
  { value: '爱与归属-情感欲望', gloss: '亲人爱人朋友师徒的情感牵挂' },
  { value: '尊重需求-个人价值表现欲', gloss: '证明自己、人前显圣、高人一等' },
  { value: '自我实现-社会价值表现欲', gloss: '社会认同、个人英雄、全村希望' },
  { value: '外在工具-工具欲', gloss: '渴望得到能解决问题的工具帮手' },
  { value: '超凡力量-神器欲', gloss: '渴望超凡力量（读心、预知、御剑式）' },
  { value: '未知渴望-求知欲', gloss: '想拆开未知谜题的冲动' },
  { value: '符合预期-掌控欲', gloss: '用已知信息推演将发生的事，渴望符合预期' },
];

/** 阻碍 8 类（原文核对原理 txt:188-201）。 */
export const DECON_OBSTACLE_TYPES: readonly DeconVocabEntry[] = [
  { value: '人为暴力阻碍', gloss: '敌方用暴力、权力强行压制' },
  { value: '人为谋略阻碍', gloss: '敌方用计谋设陷阱' },
  { value: '规则限制阻碍', gloss: '规则、制度框住手脚' },
  { value: '自然场景阻碍', gloss: '天气、地形、瘟疫等自然阻隔' },
  { value: '社会规则阻碍', gloss: '社会习俗与舆论压力' },
  { value: '阶层规则阻碍', gloss: '阶层壁垒压人' },
  { value: '前提不足阻碍', gloss: '有方法但准备不够' },
  { value: '内心自身阻碍', gloss: '心理阴影、恐惧、旧伤未愈' },
];

/** 剧情线 5 族（原文核对原理 txt:899-933、1084-1088——子型记入 gloss）。 */
export const DECON_PLOT_LINE_FAMILIES: readonly DeconVocabEntry[] = [
  { value: '持续线', gloss: '主线的延续方式——递进连续、目标转续、搁置断续、悬疑拼续' },
  { value: '前提线', gloss: '为主线的解决提前铺条件——信息前提、能力前提、工具前提、任务前提、条件前提' },
  { value: '延时线', gloss: '把目标暂时挂起、垫节奏——信息延迟、前提延迟、任务延迟、阶梯延迟、拼图延迟' },
  { value: '伏笔线', gloss: '提前埋、关键时刻回收——信息解决、规则解决、工具解决' },
  { value: '支线', gloss: '单元事件补充色彩与节奏——情感支线、职业支线、日常支线、成长支线、工具支线' },
];

/** 线路组织 3 法（原文核对原理 txt:934-958、1081）。 */
export const DECON_LINE_ORGANIZATION_METHODS: readonly DeconVocabEntry[] = [
  { value: '锚点单线法', gloss: '一条主线锚定，事件依次推进' },
  { value: '主副双线法', gloss: '主线加一条副线穿插' },
  { value: '三线交互法', gloss: '弱主线，成长支线加生活支线等多线单元事件推动' },
];

/** 整体结构三式（原文核对原理 txt:76-104、1047——书级判定轴）。 */
export const DECON_OVERALL_STRUCTURES: readonly DeconVocabEntry[] = [
  { value: '总分总莲花式', gloss: '开局定全局目标，事件围绕最终目标推进' },
  { value: '递进阶梯式', gloss: '阶段发展、逐步揭露最终目标' },
  { value: '并列无限式', gloss: '弱主线、独立单元事件重即时体验' },
];

/** 功能人物 8 类（原文核对原理 txt:263-272）。 */
export const DECON_FUNCTIONAL_CHARACTERS: readonly DeconVocabEntry[] = [
  { value: '情绪人物', gloss: '制造情绪拉扯（正面付出或反面迫害）' },
  { value: '困境人物', gloss: '给主角制造持续恶化的困境' },
  { value: '方法人物', gloss: '给主角送解决方法与信息' },
  { value: '冲突人物', gloss: '压轴冲突的对手，越强爽感越足' },
  { value: '背景人物', gloss: '嘲讽质疑攒憋屈、结局震惊释放' },
  { value: '伪装人物', gloss: '误导局势的操控者，再转折的关键' },
  { value: '任务人物', gloss: '强制派发欲望目标（宗门任务、突然遭遇）' },
  { value: '全局人物', gloss: '推动大阶段走向的幕后力量' },
];

/** 人物分级（原文核对原理 txt:442-451）。 */
export const DECON_CHARACTER_TIERS: readonly DeconVocabEntry[] = [
  { value: 'S级立体圆形人物', gloss: '多面立体，全书核心投入' },
  { value: 'A级扁平配角人物', gloss: '单面鲜明，功能明确' },
  { value: 'B级点状龙套人物', gloss: '一句两句带过的功能点' },
  { value: 'C级无形群众人物', gloss: '背景板群体' },
];

/** 人设 3 思路（原文核对原理 txt:598-611）。 */
export const DECON_PERSONA_APPROACHES: readonly DeconVocabEntry[] = [
  { value: '刻板极端人设', gloss: '把某一方面推到极端，快速立住预期' },
  { value: '表里反差人设', gloss: '表面与内心不一致，因经历而反差' },
  { value: '戏剧错位人设', gloss: '特长与场景错位契合，天然的戏剧效果' },
];

/** 世界 8 件套（原文核对原理 txt:426-435、245-261、1112）。 */
export const DECON_WORLD_COMPONENTS: readonly DeconVocabEntry[] = [
  { value: '地图资源', gloss: '地图类型与自然资源分布' },
  { value: '场景氛围', gloss: '具体场景与可利用的地形氛围' },
  { value: '能力体系', gloss: '功法、异能等力量规则' },
  { value: '势力划分', gloss: '正派、反派、中立、弱派、工具派的功能分布' },
  { value: '权利规则', gloss: '社会文明背景与生存规则' },
  { value: '知识工具', gloss: '知识、工具、设施的差距外化' },
  { value: '阶层划分', gloss: '强弱贫富的分层与身份地位' },
  { value: '功能职业', gloss: '炼丹、御兽、建设等职业生态' },
];

/** 换地图前兆三件（wuhang digest——商业实践参照词形）。 */
export const DECON_MAP_CHANGE_PRECURSORS: readonly DeconVocabEntry[] = [
  { value: '资源枯竭', gloss: '当前地图的资源撑不住主角继续成长' },
  { value: '战力崩坏', gloss: '主角实力超出当前地图的天花板' },
  { value: '追杀', gloss: '被更强的力量驱逐出当前地图' },
];

/** 时间三轴（操作化白话——章/弧级提问轴，无正典枚举）。 */
export const DECON_TIME_AXES: readonly DeconVocabEntry[] = [
  { value: '讲述起点', gloss: '从哪一刻讲起，之前的事怎么补' },
  { value: '详略配比', gloss: '完整展开、一句带过、直接跳过的取舍' },
  { value: '重讲取景', gloss: '同一件事重提时换的角度与补的新信息' },
];

/** 造梗三件（R2 维 8 提问族轴）。 */
export const DECON_MEME_AXES: readonly DeconVocabEntry[] = [
  { value: '心动点', gloss: '读者会想截图转发、想安利别人的瞬间' },
  { value: '可讨论物', gloss: '留给读者争论、站队、玩梗的空间' },
  { value: '可挪用件', gloss: '拆出来就能直接学走的造梗手法颗粒' },
];

/** 对照三件（R4-H/I 提问族轴——操作化词形）。 */
export const DECON_CONTRAST_AXES: readonly DeconVocabEntry[] = [
  { value: '对照组', gloss: '一个角色或器物处处给另一个当参照' },
  { value: '变奏对', gloss: '同题场景的两次处理——题目不变、处理变' },
  { value: '避复', gloss: '同类场景反复出现时避开机械重复的手法' },
];

/** 获客漏斗四件（R2 维 1 + wuhang 提问族轴）。 */
export const DECON_FUNNEL_AXES: readonly DeconVocabEntry[] = [
  { value: '耐心值', gloss: '读者肯继续读的意愿余额——消耗在无聊与困惑上，补充在小爽点与期待上' },
  { value: '开篇任务清单', gloss: '开篇章要完成的任务（记住主角、看到处境、看到亮点、看到冲突、知道书讲什么）' },
  { value: '承诺-兑现', gloss: '书名简介立的承诺与开篇兑现程度的对照' },
  { value: '黄金三章', gloss: '开篇前三章决定读者去留的窗口' },
];

/** 伏笔形态 4 种（R4-M 形态学——操作化词形）。 */
export const DECON_FORESHADOW_SHAPES: readonly DeconVocabEntry[] = [
  { value: '道具反复出现', gloss: '一件东西在不同场合露面' },
  { value: '人物未出场先闻名', gloss: '名字先于人到的铺垫' },
  { value: '预言暗示', gloss: '提前放出的断言或征兆' },
  { value: '提前闲笔', gloss: '看似无关、后文才起作用的一笔' },
];

/** 伏笔线 3（原文核对原理 txt:924-926、1086——回收途径三型）。 */
export const DECON_FORESHADOW_LINES: readonly DeconVocabEntry[] = [
  { value: '信息解决', gloss: '回收靠把散落信息拼出关键' },
  { value: '规则解决', gloss: '回收靠发现并反过来利用规则' },
  { value: '工具解决', gloss: '回收靠提前拿到的东西恰好在关键时刻用上' },
];

// ── 共用立场段（design §3.2 四条——P4/P5 生成共用，W4 p5Output 前置）──

/**
 * 手艺层分析立场段（所有 P4/P5 system prompt 的公共前缀）。四条：①学优点默认；②失败对照
 * 需外部材料（书内人物对照组仅作呼应证据）；③每条结论给呼应证据（paraRange+quote），单薄
 * 一条证据撑不起大结论；④结论表述用词表词形。（网文语境红线：平实白话，零古典例零学院名号。）
 */
export const DECON_P4_STANCE_PROMPT = [
  '你是小说拆解的手艺层分析师，站在作者角度倒推：作者在给定分析材料里做对了什么、为什么有效。',
  '分析立场（每条结论都必须遵守）：',
  '- 默认学优点：只找作者做对了什么，不挑刺。要做失败对照（同题材写得差的写法长什么样）需要使用者另行提供外部材料，本书正文里没有能当反例用的失败样本；',
  '- 书里的人物对照组（一个角色处处衬托另一个）是作者刻意安排的手法，只作为结论的呼应证据使用，不当失败样本；',
  '- 每条结论都要给呼应证据：正文里能印证这条结论的位置（伏笔的回收点、衬托的对照物、反复出现的调度安排等），每条证据 = paraRange + quote。单薄的一条证据撑不起大结论——要么找到更多呼应位置，要么不提这条结论；',
  '- 结论表述用问题单给出的拆解词表里的词形，不要自造新词。',
].join('\n');

// ── 输出契约（findings JSON 形状钉死——W1 契约 deconFindingsSchema 对齐）──

/** 章级输出契约（证据锚定 = 本章正文的段落号）。 */
export const DECON_P4_CHAPTER_OUTPUT_CONTRACT = [
  '输出格式（纯 JSON 对象，不要任何解释或前后缀）：',
  '{"findings":[{"insight":"结论一句话（用词表词形表述）","elaboration":"展开两到四句：作者怎么做的、为什么有效","evidence":[{"paraRange":{"start":段落号,"end":段落号},"quote":"原文逐字摘录"}],"craftHint":{"category":"手艺卡大类（可省）","termHint":"词目提示（可省）","tags":["短标签"]}}],"synthesis":"本维在本章的小结（两三句）"}',
  '- paraRange = {"start":段落号,"end":段落号}（半开区间），段落号只能引用输入正文里实际出现的段落号；',
  '- quote = 对应段落区间内的原文逐字摘录（不得改写、不得拼接不同位置的文字）；',
  '- 每条 finding 的 evidence 至少一条——给不出正文位置的结论会被直接丢弃，宁缺毋滥；',
  '- craftHint 只给值得沉淀成手艺卡复用的发现（能直接学走的打法），不值得落卡的填 null。',
].join('\n');

/** 弧级输出契约（弧级输入非全文——证据只能落在带段落号的原文，概要与统计不算）。 */
export const DECON_P4_ARC_OUTPUT_CONTRACT = [
  '输出格式（纯 JSON 对象，不要任何解释或前后缀）：',
  '{"findings":[{"insight":"结论一句话（用词表词形表述）","elaboration":"展开两到四句：作者怎么做的、为什么有效","evidence":[{"paraRange":{"start":段落号,"end":段落号},"quote":"原文逐字摘录"}],"craftHint":{"category":"手艺卡大类（可省）","termHint":"词目提示（可省）","tags":["短标签"]}}],"synthesis":"本维在本弧的小结（两三句）"}',
  '- paraRange = {"start":段落号,"end":段落号}（半开区间），段落号只能引用输入里带段落号标记的原文（抽样段、清单附的原文逐字引文）；各章概要与统计数字不是原文，不能当证据引用——结论必须落到原文位置，落不到的不要提；',
  '- quote = 对应段落区间内的原文逐字摘录（不得改写、不得拼接不同位置的文字）；',
  '- 每条 finding 的 evidence 至少一条——给不出正文位置的结论会被直接丢弃，宁缺毋滥；',
  '- craftHint 只给值得沉淀成手艺卡复用的发现（能直接学走的打法），不值得落卡的填 null。',
].join('\n');

// ── 粒度登记（design §3.1 粒度面列的权威转译——W3b runner 循环骨架）──

/** 问题单粒度（pass unit 形态：章级 ch:N / 弧级 arc:N——契约注释同源）。 */
export type DeconP4Granularity = 'chapter' | 'arc';

/**
 * 维度 → 问题单粒度面（design §3.1 表逐行）。huoke 的章面 = **开篇子集专用问题单**（前
 * min(12, 章数) 章）；wenbi 的章面 = 抽查面（deep 档主战场在 P5 名场面细批）；书级面
 * （huoke/jiegou/shijieguan）住 P5 读法注入——不建 unit='all' 的 pass 行（契约同源）。
 */
export const DECON_P4_GRANULARITY: Readonly<Record<DeconCraftDimensionId, readonly DeconP4Granularity[]>> =
  {
    huoke: ['chapter'],
    qidaigan: ['chapter', 'arc'],
    jiegou: ['arc'],
    renshe: ['arc'],
    shijieguan: ['arc'],
    qingxu: ['chapter', 'arc'],
    wenbi: ['chapter'],
    zaogeng: ['chapter', 'arc'],
    xinxicha: ['chapter', 'arc'],
    shijian: ['chapter', 'arc'],
    fubi: ['arc'],
    duizhao: ['arc'],
  };

// ── 问题单拼装（内部）──

function dimensionLabel(dim: DeconCraftDimensionId): string {
  return DECON_DIMENSIONS.find((d) => d.id === dim)?.label ?? dim;
}

/** 章级通用输入用法行（解读既有标注，不重打——F-08 同族纪律在 P4 面的表述）。 */
const CHAPTER_USAGE =
  '输入用法：结合输入里附的本章正文（带段落号标记）、本章事实提取（章概要、事件、伏笔埋点、信息差标注）与本章打标（钩子、转折、情绪拍、章相位、爽点段、设定说明段）——只解读既有标注和正文，不重新打标。';

/** 弧级通用输入用法行。 */
const ARC_USAGE =
  '输入用法：结合输入里附的弧内各章概要、弧计量统计与本弧事实聚合（出场退场、伏笔埋点、核心事件；带段落号的原文抽样段如提供则一并参考）——站在全书作者的角度回答。';

interface QuestionnaireParts {
  dim: DeconCraftDimensionId;
  face: string;
  purpose: string;
  usage: string;
  questions: readonly string[];
  vocabTables: readonly string[];
}

function assembleQuestionnaire(parts: QuestionnaireParts): string {
  return [
    `【分析任务：${dimensionLabel(parts.dim)}（${parts.face}）】`,
    parts.purpose,
    parts.usage,
    '要回答的问题：',
    ...parts.questions.map((q) => `- ${q}`),
    '',
    ...parts.vocabTables,
  ].join('\n');
}

// ── 章级问题单（design §3.1 粒度面「章」行 + dispatch 章级问题族）──

function buildChapterQuestionnaire(dim: DeconCraftDimensionId): string {
  switch (dim) {
    case 'huoke':
      return assembleQuestionnaire({
        dim,
        face: '开篇章级',
        purpose: '获客漏斗的开篇章面：新读者点进来、决定追不追，就看开头这几章——站在新读者的第一印象角度拆。',
        usage:
          '输入用法：本章是开篇章之一（全书开头的若干章）。结合输入里附的本章正文（带段落号标记）、本章事实提取与本章打标解读；书名和简介在输入的材料信息里带了才对照，没带就只看正文。',
        questions: [
          '开篇任务定位：到本章为止，开篇任务清单完成了哪几项？每项落在第几章第几段？',
          '耐心值账本：站在没耐心的读者角度，本章哪里最可能弃书（信息给得慢、主角惨而没回报、设定看不懂）？作者在危险位置放了什么拉人（小爽点、悬念、钩子）？',
          '第一个对手：第一个反派或第一个正面冲突在第几章出场？等他出场的这段，作者拿什么垫着读者？',
          '承诺对照：书名和简介向读者承诺了什么？本章兑现了多少、剩下的承诺怎么挂住读者？',
          '开场手法：本章（尤其第一章）用什么方式开场（直接进冲突、悬念开局、日常里的反差）？开头多少段之内给读者第一个情绪回报？',
        ],
        vocabTables: [formatDeconVocabTable('获客漏斗拆解词表', DECON_FUNNEL_AXES)],
      });
    case 'qidaigan':
      return assembleQuestionnaire({
        dim,
        face: '章级',
        purpose: '期待感与铺垫的章级面：看作者在这一章怎么建立、维持、兑现读者的期待。',
        usage: CHAPTER_USAGE,
        questions: [
          '六步法定位：本章落在情节六步法的哪一环？作者在这一环上做了什么，让读者愿意翻下一页？',
          '钩子拆解：本章打标里的钩子是哪一型？钩子埋在章内什么位置、冲着哪种读者欲望去？钩子的强度靠什么撑（信息量、情绪浓度、利益攸关）？',
          '期待的建立与兑现：本章新建立了什么期待？兑现了前面的哪些铺垫（对照事实提取里的伏笔埋点）？兑现时给了多少分量——一次给足还是留了尾巴？',
          '铺垫手法：本章为后文铺的东西是明铺（读者看得出在攒）还是暗铺（回头看才发现）？铺的位置选在哪（正事间隙、闲笔、对话）？',
          '张弛与喘息：本章整体是紧是松？紧章里有没有留喘息位，松章里有没有埋下一步的钩子？',
          '断章手法：章末用什么收（悬念、反转、新信息、情绪高点）？为什么在这里断？',
        ],
        vocabTables: [
          formatDeconVocabTable('期待感钩子 11 型', DECON_HOOK_VOCAB),
          formatDeconVocabTable('情节六步法', DECON_SIX_STEPS),
        ],
      });
    case 'qingxu':
      return assembleQuestionnaire({
        dim,
        face: '章级',
        purpose: '情绪与爽点的章级面：看作者怎么在本章里压情绪、抬情绪、兑现爽点。',
        usage: CHAPTER_USAGE,
        questions: [
          '情绪走向逐拍拆：本章情绪动态的拍子怎么排（结合打标——各拍落在哪段）？压下去的拍子攒了什么，抬起来的拍子兑了什么？',
          '章相位：本章主导相位（结合打标）里，作者用什么手段把该相位做足——拉仇恨靠什么、积蓄压多久、释放怎么爆、落袋为安怎么安？',
          '爽点工艺：打标出的爽点段是怎么攒出来的——压了多长、靠什么反差兑现（身份反差、实力反差、认知反差）？爽点落在谁身上（主角自己、旁观者反应、对手崩溃）？',
          '欲望与阻碍配对：本章主要调动哪种读者欲望？配的阻碍是哪类？欲望和阻碍的搭配怎么决定情绪强度——欲望越强、阻碍越狠，情绪冲得越高，本章的搭配强度够不够？',
          '情绪回报节奏：本章的情绪是即时兑付还是压着账？压着的账记在哪（读者心里挂着什么，等什么时机兑）？',
        ],
        vocabTables: [
          formatDeconVocabTable('情绪动态 7 拍', DECON_EMOTIONAL_BEAT_VOCAB),
          formatDeconVocabTable('剧情段四相位', DECON_PLOT_PHASE_VOCAB),
          formatDeconVocabTable('欲望 9 型', DECON_DESIRE_TYPES),
          formatDeconVocabTable('阻碍 8 类', DECON_OBSTACLE_TYPES),
        ],
      });
    case 'wenbi':
      return assembleQuestionnaire({
        dim,
        face: '章级抽查',
        purpose: '文笔与画面感的章级抽查面：看作者写具体段落的功夫——同一处内容为什么这么写而不那么写。',
        usage: CHAPTER_USAGE,
        questions: [
          '信息展现选型：本章几处关键信息的给出方式各是哪一法？为什么这处信息选这种方式给——换成别的方式会丢什么？',
          '代入维度：本章主要靠哪几维把读者拉进去？最强的一维是怎么做到的？',
          '画面与刻画：哪些段落是镜头画面（摆一幅画面让读者自己看）、哪些是六觉刻画（五感加代入感受，引导读者产生对应感觉）？两种怎么配合、跟视角的选择是什么关系？',
          '措辞与句读：找两三处最见功力的用词或句子节奏，说明为什么这里非这么写不可——同一个意思换更省事的写法会损失什么？',
          '进出场笔法：重要人物本章怎么进场或退场——写在什么位置、用什么细节带出、读者的第一眼印象是谁给的？',
        ],
        vocabTables: [
          formatDeconVocabTable('信息展现 5 法', DECON_INFO_DISPLAY_METHODS),
          formatDeconVocabTable('代入 5 维', DECON_IMMERSION_DIMENSIONS),
        ],
      });
    case 'zaogeng':
      return assembleQuestionnaire({
        dim,
        face: '章级',
        purpose: '造梗与互动的章级面：看作者怎么在本章造梗、埋可讨论的东西。',
        usage: CHAPTER_USAGE,
        questions: [
          '心动点定位：本章哪里是读者会想截图转发、想安利别人的瞬间？这个瞬间是用什么攒出来的（反差、命名、金句、名场面拼装）？',
          '造梗手法：本章新造了什么梗（叫法、绰号、口头禅、设定梗）？梗的内核是什么、为什么好笑或上头？',
          '可讨论物：本章给读者留了什么可以争论、站队、玩梗的空间？预埋的位置在哪？',
          '梗的反复：本章回收或强化了前面哪些梗？反复时做了什么变化避免腻？',
          '可挪用件：本章有没有拆出来就能直接学走的造梗手法？拆到可复用的颗粒度。',
        ],
        vocabTables: [formatDeconVocabTable('造梗拆解词表', DECON_MEME_AXES)],
      });
    case 'xinxicha':
      return assembleQuestionnaire({
        dim,
        face: '章级',
        purpose: '信息控制的章级面：看作者在本章怎么安排谁知道什么——读者、主角、其他人物各自的信息位置。',
        usage: CHAPTER_USAGE,
        questions: [
          '信息差解读（核心）：本章事实提取里标好的各处信息差分别是哪一型？作者用这型落差拿到了什么——期待、悬念还是看戏的爽感？只解读既有标注，不要自己重新标注。',
          '视角走位：本章叙述跟谁的视角走？哪里切了视角、切换是为了让读者看见什么或看不见什么？',
          '给与压：本章透露了什么、压住了什么？压住的信息从行文里能不能嗅到存在感（读者知道有东西被藏了）？',
          '读者位置：章末读者比主角多知道什么、少知道什么？这个落差是不是本章最重要的钩子？',
        ],
        vocabTables: [
          formatDeconVocabTable('信息差 6 型', DECON_INFO_GAP_VOCAB),
          formatDeconVocabTable('视角 6 型', DECON_VIEWPOINT_TYPES),
        ],
      });
    case 'shijian':
      return assembleQuestionnaire({
        dim,
        face: '章级',
        purpose: '时间的章级面：看作者在本章对「讲哪段、讲多细、重复讲什么」的取舍。',
        usage: CHAPTER_USAGE,
        questions: [
          '讲述起点：本章从哪一刻讲起？起点之前的事怎么处理（当场补、后文慢慢透、干脆不补）？这个起点为什么好？',
          '详略配比：哪些事完整展开一场戏、哪些一句话带过、哪些直接跳过？取舍服务于什么（情绪、节奏、信息密度）？',
          '重讲取景：本章有没有把前面发生过的事再讲一遍？重讲时换了什么角度、补了什么新货——是攒拼图还是抬情绪？',
          '时间流逝感：读者感觉本章过了多久？作者用什么传达（明说时间、景物变化、人物状态变化、模糊处理）？',
        ],
        vocabTables: [formatDeconVocabTable('时间拆解三轴', DECON_TIME_AXES)],
      });
    default:
      throw new Error(`decon p4: 维度 ${dim} 没有章级问题单（见 DECON_P4_GRANULARITY）`);
  }
}

// ── 弧级问题单（design §3.1 粒度面「弧」行 + dispatch 弧级问题族）──

function buildArcQuestionnaire(dim: DeconCraftDimensionId): string {
  switch (dim) {
    case 'qidaigan':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '期待感与铺垫的弧级面：看这一弧怎么拉长长的期待、怎么在跨度上管理读者的耐心。',
        usage: ARC_USAGE,
        questions: [
          '期待主线：这一弧从立期待到兑现跨了多少章？中间靠什么维持（小兑现、叠加新钩子、中途换目标）？有没有期待断档的段落？',
          '铺垫盘点：本弧为后文埋了什么大铺垫（下一弧或全书级的名场面）？埋点之间的间隔多远（对照计量统计的伏笔密度与埋收跨度）？',
          '转折倒推：本弧的关键转折各是哪一型（对照计量统计的转折分型计数）？每次转折把读者期待拧向哪里、拧完拿什么接住？',
          '钩子盘点：本弧用了哪些型的钩子？有没有连续同型导致钝化的位置？最强的一记钩子是哪个？',
          '张弛调剂：弧内紧张段之间怎么降温（长段推进后插别的事、高潮里插清冷段、刚柔场景交替、大场面之后给余波、大场面之前给小引）？调剂位选在哪？',
          '憋放章距：情绪压最低的章和爆最高的章隔多远？这个距离拿捏了什么？',
        ],
        vocabTables: [
          formatDeconVocabTable('期待感钩子 11 型', DECON_HOOK_VOCAB),
          formatDeconVocabTable('转折 9 型', DECON_TRANSITION_VOCAB),
          formatDeconVocabTable('情绪动态 7 拍', DECON_EMOTIONAL_BEAT_VOCAB),
        ],
      });
    case 'jiegou':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '结构与多线的弧级面：看这一弧自身的骨架怎么搭、几条线怎么穿、地图怎么换。',
        usage: ARC_USAGE,
        questions: [
          '切分解读：这一弧（剧情段切分的结果）边界立得住吗——开弧靠什么事件起势、闭弧的落点落在哪？上一弧的余波怎么带进本弧、本弧的尾巴怎么交给下一弧？',
          '弧内骨架：这一弧从哪开始蓄、在哪转、在哪收？弧的收束给下一弧留了什么接口（新目标、新悬念、新地图预告）？',
          '线路盘点：本弧同时在跑几条线？各条线属于哪族？线与线怎么穿插衔接、互相当什么（铺垫、降温、伏笔）？',
          '线路组织：本弧的主副线关系是哪种？为什么这个规模的故事用这种组织？',
          '换地图逻辑：本弧有没有换地图（新场景、新势力范围、新身份段）？换是主动还是被动？换之前的前兆埋在哪？为什么必须换（旧地图装不下成长、矛盾到头了）？',
          '核心节奏公式：本弧内部反复的标准循环是什么？把循环式子写出来（例如 危机→试错→重开→布局→收网），标注各环节的典型章数；',
          '固定调度：本弧有没有反复出现的调度安排（某类事件发生时总有特定人物或元素在场）？重复带来什么（仪式感、预期锚点、笑点）？',
        ],
        vocabTables: [
          formatDeconVocabTable('剧情线 5 族', DECON_PLOT_LINE_FAMILIES),
          formatDeconVocabTable('线路组织 3 法', DECON_LINE_ORGANIZATION_METHODS),
          formatDeconVocabTable('换地图前兆三件', DECON_MAP_CHANGE_PRECURSORS),
        ],
      });
    case 'renshe':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '人设与成长的弧级面：看这一弧的人物配置表——谁进场谁退场、各自什么功能、谁在成长。',
        usage: ARC_USAGE,
        questions: [
          '出场退场解读：本弧谁进场、谁退场（对照事实聚合的出场退场表）？每次进退场的时机服务于什么（新冲突需要、旧矛盾收口、换地图配套）？',
          '人物分级：本弧活跃人物按投入度怎么分级？各级的笔墨分配差多少、值不值？',
          '功能配置：主要人物各占什么功能位？有没有一人兼多职、一职多人？配置的富余或紧缺说明什么？',
          '人设思路：主要人物的人设走哪条思路？人设怎么制造读者预期、预期又怎么被利用？',
          '成长弧：本弧谁变了、怎么变的？变化的前铺在哪（本弧前段或上一弧）？没变的人物靠什么维持新鲜感？',
          '反派梯度：本弧的主要对手在全书对手梯度里排第几级？比上一级强在哪（实力、智谋、与主角的纠葛）？',
          '笔法指纹：主要角色有没有固定的写法标记（说话方式、口头禅、惯常动作、专属场景）？把名字遮住还能认出是谁吗——这个指纹怎么帮读者记人？',
        ],
        vocabTables: [
          formatDeconVocabTable('功能人物 8 类', DECON_FUNCTIONAL_CHARACTERS),
          formatDeconVocabTable('人物分级', DECON_CHARACTER_TIERS),
          formatDeconVocabTable('人设 3 思路', DECON_PERSONA_APPROACHES),
        ],
      });
    case 'shijieguan':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '世界观容纳度的弧级面：看这一弧往世界里加了什么、怎么加得不堵。',
        usage: ARC_USAGE,
        questions: [
          '八件套动线：本弧动了世界设定的哪几件？每件是前置集中给还是随剧情放？放的位置贴着什么冲突？',
          '设定段解读：对照计量统计的设定说明段分布——设定集中在哪几章、单段最长多少字？有没有拖住节奏的超长说明段？作者怎么把设定揉进冲突或对话里讲？',
          '容纳与自洽：本弧新加的设定跟已有设定有没有打架？新元素进来时留了什么口子（暗示这世界还有更多没讲的）？',
          '换壳测试：把本弧的主线挪到另一个身份或另一张地图，本弧用到的设定骨架还成立吗？哪些是万用件、哪些是本弧专用件？',
          '留白清单：本弧刻意没讲什么？哪些留白是给后文的口子、哪些只是没顾上？',
        ],
        vocabTables: [formatDeconVocabTable('世界 8 件套', DECON_WORLD_COMPONENTS)],
      });
    case 'qingxu':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '情绪与爽点的弧级面：看这一弧整体的蓄放结构——压多久、放多爽、怎么防麻木。',
        usage: ARC_USAGE,
        questions: [
          '蓄放结构：这一弧整体压了多少章、爽点兑了多少次？压得最狠的位置和放得最爽的位置隔多远（对照计量统计的爽点分布与间隔）？',
          '爽点配比：本弧爽点的类型搭配怎么排（打脸、兑现、升级、收获各多少）？连续爽点之间怎么防麻木（降档、换型、垫小低谷）？',
          '稳定看点引擎：本弧有没有稳定供给情绪的固定安排（每几章一个小爽点、固定登场的人物节目）？引擎节律是什么、读者能不能形成依赖？',
          '相位循环：对照计量统计的章相位分布——拉仇恨、积蓄、释放、落袋为安的循环在本弧怎么转？循环有没有变奏（某环拉长、缩短、偶尔跳过）？',
          '欲望-阻碍主力配对：本弧的主要冲突建立在哪种欲望配哪种阻碍上？跟上一弧的配对比，换了哪个部件（换欲望、换阻碍、都换）——换部件怎么保持新鲜感？',
          '欲望升级：本弧调动的读者欲望跟上一弧比升了哪级？升级靠什么事件完成？',
        ],
        vocabTables: [
          formatDeconVocabTable('情绪动态 7 拍', DECON_EMOTIONAL_BEAT_VOCAB),
          formatDeconVocabTable('剧情段四相位', DECON_PLOT_PHASE_VOCAB),
          formatDeconVocabTable('欲望 9 型', DECON_DESIRE_TYPES),
          formatDeconVocabTable('阻碍 8 类', DECON_OBSTACLE_TYPES),
        ],
      });
    case 'zaogeng':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '造梗与互动的弧级面：看这一弧的梗产线与读者社区的互动设计。',
        usage: ARC_USAGE,
        questions: [
          '梗产线：本弧稳定产出什么心动点？产出的节律（平均几章一个可截图瞬间）？产量跟弧的情绪目标配不配？',
          '梗的运营：哪个梗被反复用？反复时怎么翻新（升级、换语境、角色互换）而不腻？哪个梗被放弃了、为什么？',
          '可讨论物布局：本弧给读者留了哪些争论点、站队点、猜测点？各自预埋在哪、打算什么时候回收？',
          '社区抓手：本弧有没有专门给读者玩梗留的素材（口头禅、名场面、可以二创的设定）？',
          '可挪用件：本弧最强的造梗手法拆到可复用的颗粒度。',
        ],
        vocabTables: [formatDeconVocabTable('造梗拆解词表', DECON_MEME_AXES)],
      });
    case 'xinxicha':
      return assembleQuestionnaire({
        dim,
        face: '弧级（读者知识曲线）',
        purpose: '信息控制的弧级面：沿各章概要走一遍读者的知识曲线，看作者怎么经营「读者比角色多知道什么、少知道什么」。',
        usage: ARC_USAGE,
        questions: [
          '读者知识曲线：沿弧内各章概要逐章过——每章末读者比主角多知道什么、少知道什么？曲线的高点（读者知道最多时）和交叉点（主角追上读者认知时）各在哪？作者拿这些落差做了什么（攒悬念、攒爽感、带偏方向）？',
          '信息差配比：对照计量统计的信息差分型计数——本弧以哪几型为主？主型的选择跟本弧的情绪目标配不配（偏打脸的弧和偏解谜的弧该有不同的主型）？',
          '视角策略：本弧的视角分布——为展示主角的强或惨，切到过谁的视角？切换的时机和频率？',
          '长线误导：本弧有没有跨章的主观误导（读者被带着走错方向再翻回来）？误导的伏线铺在哪、翻回来的时机怎么选？',
        ],
        vocabTables: [
          formatDeconVocabTable('信息差 6 型', DECON_INFO_GAP_VOCAB),
          formatDeconVocabTable('视角 6 型', DECON_VIEWPOINT_TYPES),
        ],
      });
    case 'shijian':
      return assembleQuestionnaire({
        dim,
        face: '弧级（频率面）',
        purpose: '时间的弧级面（以重讲频率为主）：看这一弧里哪些事被讲了几遍、跳过了什么、时间跨度怎么管。',
        usage: ARC_USAGE,
        questions: [
          '重讲盘点：本弧哪些事被讲了不止一遍（沿各章概要找同一事件的多次出现）？每次重讲的取景差在哪（换视角、只补一角新信息、纯强调）？重讲是在攒拼图还是在抬情绪？',
          '时间跳跃：弧内跳过了哪些时间段？跳过的部分后来补了吗、怎么补的？跳得干不干净？',
          '跨弧时间：本弧的故事时间跨度多长？作者的计时习惯（按天记、按事件记、模糊处理）？时间感和升级节奏配不配？',
          '取景与节奏：重讲密集的段落和零重讲的段落，读起来的节奏差在哪？作者怎么用重讲密度调呼吸？',
        ],
        vocabTables: [formatDeconVocabTable('时间拆解三轴', DECON_TIME_AXES)],
      });
    case 'fubi':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '伏笔形态学的弧级面：本维核心任务是把埋下的伏笔逐条配对——形态、收法、隔距，回收点必须指得到。',
        usage: ARC_USAGE,
        questions: [
          '埋收配对（核心）：把截至本弧埋下的伏笔逐条配对——每条什么形态、怎么收（明收——直接点破；暗收——不点破、融进剧情）、隔距多少（埋到收隔了几章、大约多少字）。每条「已回收」结论的 evidence 必须包含回收点的原文位置——只指得出埋点、指不出回收点的，归到未回收清单，不要当成已回收来讲；',
          '未回收清单：本弧埋下、截至弧末还没收的伏笔——这些是悬置承诺，逐条列出埋点并标注它吊着什么期待（只描述，不断言回收质量）；',
          '伏笔线类型：本弧的伏笔走哪条线（回收靠什么翻盘）？',
          '埋笔习惯：作者的埋笔偏好是什么（爱埋道具还是爱埋闲笔）？埋的密度和收的节奏怎么配合（对照计量统计的伏笔密度）？',
        ],
        vocabTables: [
          formatDeconVocabTable('伏笔形态 4 种', DECON_FORESHADOW_SHAPES),
          formatDeconVocabTable('伏笔线 3', DECON_FORESHADOW_LINES),
        ],
      });
    case 'duizhao':
      return assembleQuestionnaire({
        dim,
        face: '弧级',
        purpose: '对照与变奏的弧级面：看这一弧怎么用「同类不同写」和「人物互衬」做出层次。',
        usage: ARC_USAGE,
        questions: [
          '同类场景变奏：对照输入附的同类场景聚类——每组同类场景什么不变（同一题目、同一情境）、什么变（处理方式、人物反应、结果走向）？变奏想证明什么或积累什么？',
          '人物对照组：本弧谁在衬托谁？列出对照的对位（身份对位、处境对位、选择对位、结局对位）；有没有器物级的对照（两件东西的象征对位）？',
          '避复手法：同类场景反复出现时，作者怎么避开机械重复（换处理、换视角、换情绪基调、换叙述详略）？',
          '固定调度：本弧反复出现的调度安排（某情境必有某元素在场）——重复的作用是仪式感、预期锚点还是笑点？',
        ],
        vocabTables: [formatDeconVocabTable('对照拆解词表', DECON_CONTRAST_AXES)],
      });
    default:
      throw new Error(`decon p4: 维度 ${dim} 没有弧级问题单（见 DECON_P4_GRANULARITY）`);
  }
}

// ── 构建器（导出面）──

export interface DeconP4SystemPromptInput {
  dimensionId: DeconDimensionId;
  granularity: DeconP4Granularity;
}

/**
 * P4 手艺问题单 system prompt（纯函数）：立场段 + 该维该粒度问题单 + findings 输出契约。
 * style 维与粒度面不匹配时抛错（编程不变量——runner 按 DECON_P4_GRANULARITY 循环不会触达；
 * A/B 测试与 W3b 接线错配在此显式失败）。
 */
export function buildDeconP4SystemPrompt(input: DeconP4SystemPromptInput): string {
  if (input.dimensionId === 'style') {
    throw new Error('decon p4: style 维走 p4Style.ts 风格维管线，不进手艺问题单');
  }
  const faces = DECON_P4_GRANULARITY[input.dimensionId];
  if (faces === undefined || !faces.includes(input.granularity)) {
    throw new Error(
      `decon p4: 维度 ${input.dimensionId} 没有 ${input.granularity} 粒度面（对照 DECON_P4_GRANULARITY）`,
    );
  }
  const questionnaire =
    input.granularity === 'chapter'
      ? buildChapterQuestionnaire(input.dimensionId)
      : buildArcQuestionnaire(input.dimensionId);
  const outputContract =
    input.granularity === 'chapter' ? DECON_P4_CHAPTER_OUTPUT_CONTRACT : DECON_P4_ARC_OUTPUT_CONTRACT;
  return [DECON_P4_STANCE_PROMPT, questionnaire, outputContract].join('\n\n');
}

/** 书级问题单维度（维 1/3/5 的书级面——住 P5 读法注入，不建 pass 行）。 */
export type DeconP4BookDimensionId = 'huoke' | 'jiegou' | 'shijieguan';

/**
 * 书级问题单（维 1/3/5 书级面——W4 p5Output 的 book_reading 注入面）。**只返回问题单本体**：
 * 立场段（DECON_P4_STANCE_PROMPT）由 P5 装配时前置共用；输出形态是读法 markdown（不是
 * findings JSON），输出格式说明归 W4 自己的 prompt 装配——所以这里不带输出契约。
 */
export function buildDeconP4BookQuestionnaire(dimensionId: DeconP4BookDimensionId): string {
  const dim = dimensionId as DeconCraftDimensionId;
  switch (dimensionId) {
    case 'huoke':
      return assembleQuestionnaire({
        dim,
        face: '书级（读法注入）',
        purpose: '获客漏斗的书级面：复盘这本书从书名简介到开篇留存的整体获客设计。',
        usage:
          '输入用法：结合输入里附的弧级概要聚合、开篇章相关材料与材料信息（书名简介带了才对照）。',
        questions: [
          '漏斗全景：书名与简介向读者承诺了什么→开篇怎么接住承诺→前几章的留存设计——每个可能弃书的位置放了什么拉住读者，串成一条漏斗复盘；',
          '类型边界：这本书的类型三栏——类型特点（这个类型必须有什么）、类型禁忌（这个类型绝不碰什么）、惯用套路（这个类型的常见打法）——供写同类书时当先验参考；',
          '受众画像：这本书写给谁——读者画像（阅读偏好、爽点偏好、雷点、大概的阅读场景）。',
        ],
        vocabTables: [formatDeconVocabTable('获客漏斗拆解词表', DECON_FUNNEL_AXES)],
      });
    case 'jiegou':
      return assembleQuestionnaire({
        dim,
        face: '书级（读法注入）',
        purpose: '结构与多线的书级面：全书骨架判定 + 核心节奏公式独立产出 + 换地图全书盘点。',
        usage: '输入用法：结合输入里附的弧级概要聚合与全书计量统计（章字数、剧情段切分、各弧统计）。',
        questions: [
          '整体结构判定：全书属于哪种结构式？混合的话各占多少、怎么拼接？',
          '全书骨架：起结框架（全书从什么起、到什么结）；冷热节奏分半（前半后半的节奏对比、在哪一章换挡）；固定调度模式全书盘点（贯穿全书的重复调度有哪些）；',
          '核心节奏公式（独立小节产出）：把全书反复的标准循环写成公式（例如 危机→试错→重开→布局→收网），标注各环节典型章数与全书循环了几轮；',
          '换地图全书盘点：全书换了几次地图？每次主动还是被动、前兆三件的出现情况、换图后怎么重立规矩；',
          '剧情线全景：全书主线属于哪族、怎么跟其他线组合？线路组织用的哪种法？',
        ],
        vocabTables: [
          formatDeconVocabTable('整体结构三式', DECON_OVERALL_STRUCTURES),
          formatDeconVocabTable('剧情线 5 族', DECON_PLOT_LINE_FAMILIES),
          formatDeconVocabTable('线路组织 3 法', DECON_LINE_ORGANIZATION_METHODS),
          formatDeconVocabTable('换地图前兆三件', DECON_MAP_CHANGE_PRECURSORS),
        ],
      });
    case 'shijieguan':
      return assembleQuestionnaire({
        dim,
        face: '书级（读法注入）',
        purpose: '世界观容纳度的书级面：这套世界的全景展开度与可扩展空间。',
        usage: '输入用法：结合输入里附的弧级概要聚合与全书计量统计（设定段分布、层级字数证据）。',
        questions: [
          '八件套全景：世界 8 件套各自的全书展开度——哪几件是重头、哪几件一笔带过？展开顺序跟剧情阶段怎么咬合？',
          '分层容纳度：世界观分几层、各层的体量证据（对照设定段统计的层级字数分布）——这套世界的可扩展空间还有多大？',
          '换壳测试全书版：把这套世界换一批人物、换一个主角职业还能跑吗？骨架里哪些是万用件？',
          '留白清单全书版：全书刻意没讲的口子——哪些是给后文或续作留的、哪些只是没铺开？',
        ],
        vocabTables: [formatDeconVocabTable('世界 8 件套', DECON_WORLD_COMPONENTS)],
      });
    default:
      throw new Error(`decon p4: 维度 ${dimensionId} 没有书级问题单（书级面只有 维1/3/5）`);
  }
}

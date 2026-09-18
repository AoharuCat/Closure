/**
 * 「写作」页 slice（task 09-13-writing-page-ui W3/W5）。
 *
 * W3 落观察链指针：`selectedChainSessionId`（显式选择优先——W6 多会话条 chip 切换的
 * 写入面；缺省解析 = 项目锚，见 features/writing/chainTimelineView.resolveObservedChainSession）。
 *
 * W5 落相位状态机（design §1.3）：`writingPhase` 主区双相位（run=时间线 / review=审阅）。
 * 相位是**页内态非路由**——放 store 使页间切换不丢（「selectedChainSessionId + 相位态放
 * store」）。驱动拓扑（行为契约，实施在 WritingPage effect）：
 * - **自动进审阅** = 三条件：观察链 paused + 该链 = 当前观察链 + 用户在写作页（页挂载即
 *   在页）。上升沿触发（running→paused 或 回页挂载时已 paused）——「手动收起审阅后链仍
 *   paused」不反复强切（手动优先语义）。
 * - **回运行相位** = 下降沿自动（链离 paused：resume 续跑事件到达 / 终态——aborted/error
 *   终态不进审阅，终态产物区是 W6 面）或用户手动收起（ReviewTopBar「收起审阅」钮）。
 * - ReviewPendingNotice 跳转可显式写 'review'（选链 + 进审阅一次性接线）。
 *
 * 项目切换：指针是纯观察面（不持数据——chainRunBySession/chainTimelineBySession 数据面
 * 由各自模块管理，挂起键跨项目存活是既定策略），切项目清指针 + 相位回 run 缺省解析即可。
 */
import type { StateCreator } from 'zustand';
import { registerProjectReset } from './resetRegistry';

/** 主区双相位（design §1.3：run=运行时间线 / review=审阅相位——终稿手改与暂停卡）。 */
export type WritingPagePhase = 'run' | 'review';

export type WritingPageSlice = {
  /** 写作页观察链 session（null = 缺省解析：项目锚链）。 */
  selectedChainSessionId: string | null;
  setSelectedChainSessionId: (sessionId: string | null) => void;
  /** W5：主区相位（页内态——页间切换不丢；缺省 run）。 */
  writingPhase: WritingPagePhase;
  setWritingPhase: (phase: WritingPagePhase) => void;
};

export const createWritingPageSlice: StateCreator<WritingPageSlice, [], [], WritingPageSlice> = (set) => {
  registerProjectReset(() => {
    set({ selectedChainSessionId: null, writingPhase: 'run' });
  });
  return {
    selectedChainSessionId: null,
    setSelectedChainSessionId: (sessionId) => set({ selectedChainSessionId: sessionId }),
    writingPhase: 'run',
    setWritingPhase: (phase) => set({ writingPhase: phase }),
  };
};

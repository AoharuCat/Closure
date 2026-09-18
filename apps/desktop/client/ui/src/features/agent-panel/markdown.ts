/**
 * MD 渲染单源已提升 `shared/utils/markdown.ts`（dogfood R3 U1——拆书报告消费跨 feature
 * 复用，跨 feature import 先例转正）。此处 re-export 保持既有消费面零改动
 * （AgentMessageItem / DispatchDraftCard）。
 *
 * Sanitize 语义随迁：agent/tool/file content 会到达 renderer（其持有 fs/git 写工具的 IPC
 * 访问权），原始模型输出绝不能作为 HTML 直接执行。
 */
export { renderMarkdown } from '../../shared/utils/markdown';

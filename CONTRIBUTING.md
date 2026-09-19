# Closure 贡献指南

> **English quick start:** fork `AoharuCat/Closure` → branch off `main` → `pnpm install && pnpm rebuild -r better-sqlite3` (Node ABI, required by the test gates) → make your change → `pnpm typecheck && pnpm lint && pnpm test` → open a PR. To run the app itself, rebuild for the Electron ABI first (`pnpm rebuild:native` — see [Native module & ABI](README.md#原生模块与-abi)). CI runs the same three gates on Linux / Windows / macOS. By submitting a contribution you agree it is licensed under AGPL-3.0-or-later. The full guide below is in Chinese.

感谢你愿意为 Closure 出力！这是一份 Alpha 阶段的本地优先 AI 小说创作 IDE（Electron 桌面应用）。本指南覆盖环境搭建、双仓模型、开发流程与提交要求。

## 双仓模型（先读）

Closure 有两个仓库：

- **公仓 [`AoharuCat/Closure`](https://github.com/AoharuCat/Closure)**（`main` 单分支）——发布面与协作面。**所有 Issue 与 Pull Request 落在这里**，CI 在三个平台（Linux / Windows / macOS）上对每个 PR 跑同一组门。
- **私仓 `AoharuCat/Closure-private`**（`dev`）——维护者的开发发生地。改动定期以同步快照（`sync: dev@<hash>`）发布到公仓。

因此公仓的历史是快照形态、没有细粒度开发脉络——这是设计使然，不是事故。**贡献者只需要与公仓打交道**：fork 公仓 → 从 `main` 切分支 → 提 PR。

## 环境准备

- **Node.js** ≥ 20，钉 22.20.0 LTS（版本以 [`.nvmrc`](.nvmrc) 为准——node 24.x 有 ObjectWrap 拆卸原生崩溃回归 [nodejs/node#65195](https://github.com/nodejs/node/issues/65195)，修复发版后回 24 LTS 线（注意 22.23.2 起的 22.x 晚期补丁也带回植——回 24 前勿顺手升 22 小版本））：用 nvm 的话先 `nvm use`；无 nvm 的环境用官方安装包装 22.20.x 亦可
- **pnpm** ≥ 10：仓库通过 `packageManager` 字段钉了确切版本；如果版本不符，`corepack enable` 后 pnpm 会自动切换

## 本地开发

贡献者的真实路径是改代码 + 跑三道门（typecheck / lint / test），这套门跑在 Node 上：

```bash
pnpm install                    # 安装依赖
pnpm rebuild -r better-sqlite3  # 按 Node ABI 重建 better-sqlite3（跑测试前）
# …改代码…
pnpm typecheck && pnpm lint && pnpm test
```

要跑应用（`pnpm dev`）时，先切回 Electron ABI 再启动：

```bash
pnpm rebuild:native # 按 Electron ABI 重建 better-sqlite3（跑应用前）
pnpm dev            # 以开发模式启动 Electron 应用
```

**原生模块与 ABI**：better-sqlite3 必须按**当前运行时**编译——跑测试（`pnpm test`）用 Node ABI（`pnpm rebuild -r better-sqlite3`），跑应用（`pnpm dev`）用 Electron ABI（`pnpm rebuild:native`），两者互斥；切换用途或切换 Node 版本后必须重编。ABI 不匹配时数据库相关测试会整族**静默 skip**（不是测试坏了）——先按目标用途重编，再排查。详见 [README「原生模块与 ABI」](README.md#原生模块与-abi)。

常用根脚本：

| 命令 | 作用 |
|------|------|
| `pnpm dev` | 运行桌面应用（electron-vite dev） |
| `pnpm build` | 构建全部 workspace 包（Turbo） |
| `pnpm build:desktop` | 只构建桌面 shell |
| `pnpm test` | 跑测试套件（Vitest，经 Turbo 按包执行） |
| `pnpm typecheck` | 全包类型检查 |
| `pnpm lint` | ESLint + 依赖边界/安全门（dependency-cruiser） |
| `pnpm rebuild:native` | 按 Electron ABI 重建 better-sqlite3（跑应用前；跑测试用 `pnpm rebuild -r better-sqlite3`） |
| `pnpm package:desktop` | 产出 Windows NSIS 安装包 |

> 注意：不要在仓库根直接跑 `npx vitest run`——单一 node 环境会丢掉各包 vitest 配置（UI 包需要 jsdom），产生大片假失败。全量用 `pnpm test`，单包用 `pnpm --filter <pkg> test`。

## Monorepo 布局

本仓库是 pnpm + Turbo monorepo。完整目录树见 [README](README.md#仓库结构)。速览：

- `apps/desktop/client/shell` — Electron 主进程 + preload + IPC
- `apps/desktop/client/ui` — React 渲染层
- `apps/desktop/agent` — `@orison/desktop-agent` 编排库
- `apps/desktop/local-bff` — 本地项目数据读写层
- `packages/*` — 共享契约（Zod schema）、模型协议、story-sync
- `docs/` — 架构与设计文档

## 开发流程

1. Fork 公仓 `AoharuCat/Closure`，从 `main` 切一个描述性命名的分支。
2. 做你的改动。保持聚焦——一个 PR 只处理一个关注点。
3. **提交 PR 之前**跑：
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
   这与 CI 在三个平台上跑的门完全一致；本地绿了 CI 大概率也绿。
4. 如果你改动了架构边界、存储位置、IPC 面、模型配置或启动行为，**同步更新 `docs/` 中对应的文档**与根 README。哪个文件归哪个主题，见 [`docs/`](docs/)。
5. 向 `main` 提交 PR，写清改了什么、你是怎么测试的。CI 三平台全绿后由维护者合并。

## 发布

维护者打 tag 走 CI Release 链（三平台构建 + GitHub Release 直传）。该链只跑构建与发布、**不含 lint 门**——发布前手动跑一遍 `pnpm lint` 确认干净。

## 代码约定

- 应用与包全部 TypeScript；风格随周围代码。
- 格式由 [`.editorconfig`](.editorconfig) 约束（2 空格缩进、LF、UTF-8）。
- UI 样式使用 `tokens.css` 中的设计令牌——不要硬编码颜色。
- Commit 保持小而聚焦，尽量写 conventional 风格的提交信息（`feat:`、`fix:`、`chore:`、`docs:`）。

## 报告 Bug

开 Issue 并附上：复现步骤、系统信息（操作系统、应用版本——应用内「设置 → 关于」可查当前版本号）。如果界面上出现了错误信息，把错误文字一并贴进 Issue——这会帮大忙。**不要在 Issue 里贴 API Key。**

安全问题**不要**开公开 Issue——见 [SECURITY.md](SECURITY.md)。

## 功能建议

先开 Issue 讨论再动手写大的功能。小而自洽的改进可以直接提 PR。提建议前不妨先看一眼 [README 路线图](README.md#路线图)——已在路线图上的项，说说你的优先级排序也是很有价值的输入。

## 许可证

提交贡献即表示你同意该贡献按 **AGPL-3.0-or-later**（或更新版本）授权。源自 OrisonSpace 的代码保留 Apache-2.0（见 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)）；归属与 provenance 详见 [NOTICE](NOTICE)。

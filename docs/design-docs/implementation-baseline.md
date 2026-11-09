# 实施基线：2026-11-08

## 用户授权与仓库

用户指定 https://github.com/SiyuQian/dsh-computer-use 并说“开工”。因此从计划阶段进入本仓库实施。初始不授权推送；2026-11-09 用户另行要求创建 PR，授权为此提交并推送现有开发分支。远端核实仍为空，main 仅以既有空初始化提交建立 PR 基线。不含合并、软件发布、日常 Profile 安装或私人应用操作授权。

克隆时远端为空，无既有文件、提交、测试或修改。为 native worktree 建立本地空 root commit：`2dd79be492de26f7b8f560258e2edfc4f3560a64`。该提交在采纳本仓库 AGENTS.md 前创建；最初仅本地保留，后获上述 PR 授权才用作远端 main 空基线。未经用户单独请求不自动提交或推送后续工作。

隔离分支：`computer-use-foundation`。工作树由宿主 create_worktree 创建，归本次执行所有，保留待用户集成。准确本地 workspace 记录存于忽略目录 .local，不把用户机器绝对路径发布到软件包。

## 实施路线

- 从空仓库独立建立基础协议、测试和 DSH 适配。
- 当前没有复制参考插件实现；它作为已审阅设计参考，不声称 clean-room。
- 后续复用任意第三方实现必须单独记录来源与许可，不在参考 checkout 中开发。
- 开发包暂用 `@siyuqian/dsh-computer-use`，`private: true`；不代表该 npm 名称可发布或已登记。
- 先实现只暴露状态的安全空 bundle；native 输入在后续卡与 gate 通过前不开放。

## 本机工具链事实

- 测试机：macOS 27.0.1，arm64；不是最低 macOS 14 的兼容证明。
- 可用 Swift 6.4；无用户授予本插件 TCC 的运行证据。
- 使用宿主依赖工具：Node 24.21.0、pnpm 11.28.5。pnpm 使用宿主返回的 Node 与 pnpm.mjs 绝对路径运行，避免 PATH 混用。
- npm 可解析 DSH 0.2.2-rc.1、TypeScript 6.0.3、Vitest 4.1.10。实现以 lockfile 固定版本。

## DSH SDK 事实

当前 GUI 所用 DSH 封装在应用 ASAR 中，运行时 package manifest 为 `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1`，Cordis 为 4.1.0。不是此前参考项目声明的 0.2.1-rc.5。

安装归档只读提取到 .local/sdk-inspection 供核查，不改应用安装目录。发布/开发声明从 npm 安装的相同版本 package 获取，不伪造 vendor declaration。

已检查的边界：

- ToolsService.register 要求 output schema/render，返回 disposer；注册通过 Cordis scope layer 自动收尾。
- 执行管线把原始 Tool arguments 写入 Session tool/call，再写 tool/result content。私有输入即使插件 logger 脱敏也可能留在宿主日志。
- approval 有 ask/never 两种 policy，never 不请求 answerer，缺 approval 能力必须失败关闭。

精确 API 与运行验证证据将由 CU-001/002 的兼容报告补充。未发现可用的字段级 redaction 前，真实私人数据模式为 no-go。只允许 fixture/公开测试数据，不改官方 Session 审计。

## 当前状态

CU-000 的仓库/工作树/路线调查已完成。CU-001–003 的基础发现/registry/schema/host-binding 切片已验证，真实 Profile、UI、native、模型 gate 保留。具体证据见 [验证记录](<../verification/foundation.md>)，不将基础切片通过等同完整产品通过。

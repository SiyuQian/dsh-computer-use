# AGENTS.md

## 范围

本目录是用户指定的 SiyuQian/dsh-computer-use 实施仓库，2026-11-08 已授权开工。
从空仓库独立建立 DSH/macOS 插件，先实现 fixture-only 的可信语义闭环。2026-11-09 用户另行要求创建 PR：本次获准提交并推送现有开发分支，及为原空仓库建立仅含空初始化提交的 main 基线。不含合并、软件发布、日常 Profile 安装或私人应用操作授权。
2026-11-09 17:50 Pacific/Auckland 用户另行授权：(1) 用户自行手动向 DeepSeek Harness.app 授予 macOS 辅助功能权限（Agent 不请求、不绕过 TCC）；(2) 仅在自有 AppKit fixture 上实现并实测语义动作 AXPress/set_value，键盘、pointer、真实应用仍关闭；(3) 终点为 fixture 端到端闭环（CU-015/016）；(4) 每个切片在新分支提交、推送并开 Draft PR。仍不含合并、发布、日常 Profile 安装或私人应用操作。
工作区事实与版本证据见 [实施基线](<docs/design-docs/implementation-baseline.md>)。

## 开始前

1. 读 [产品定义](<docs/PRODUCT_SENSE.md>)。
2. 读 [当前架构事实](<ARCHITECTURE.md>)。
3. 读 [实施设计](<docs/design-docs/plugin-design.md>) 与 [接口约定](<docs/design-docs/contracts.md>)。
4. 读 [安全边界](<docs/SECURITY.md>)。
5. 从 [计划索引](<docs/PLANS.md>) 选择依赖已完成的一张任务卡。
6. 按 [Agent 运行手册](<docs/exec-plans/AGENT_RUNBOOK.md>) 开工、记录和交接。

## 仓库地图

- 本文件：入口与全局规则。
- [设计索引](<docs/design-docs/index.md>)：设计与决策状态。
- [执行计划目录](<docs/exec-plans/active/>)：任务卡、依赖和进度日志。
- [完成计划目录](<docs/exec-plans/completed/>)：完成记录，目前为空。
- [产品规格索引](<docs/product-specs/index.md>)：MVP 和验收。
- [质量现状](<docs/QUALITY_SCORE.md>)：可证实的状态。
- [已知缺口](<docs/exec-plans/tech-debt-tracker.md>)：缺失控制和对应任务。

## 全局规则

- 用户只批准产品定义，不等于批准真实 UI 操作、安装、发布或所有技术默认值。检查：review。
- 只修改明确指定的目标仓库。禁止在参考项目或 DSH 安装目录实施本插件。检查：CU-000。
- 阅读现有文件后再修改。保留已有用户修改。检查：每张任务卡的开工记录。
- 一张任务卡必须形成一个可审查切片。依赖未完成不能靠 stub 假装完成。检查：依赖图和任务审查。
- 先写失败测试，再实现行为，再运行回归。检查：红/绿测试证据。
- 不从模型参数信任 Agent、Session、workspace、权限、风险等级或控制锁身份。检查：拟议 A-02、A-08。
- 不添加任意脚本、AppleScript、JXA、selector 或原生常量执行工具。检查：拟议 A-02、A-29。
- 原生动作必须在权限与状态检查后执行。未知目标或效果不能自动重试。检查：拟议 A-06、A-13、A-14。
- 后台模式不能静默升级为前台接管或全局输入。检查：拟议 A-16、A-17、A-24。
- 不把取消、事件成功或 AX 树变化声称为业务成功。检查：拟议 A-12、A-13、A-19。
- 不在日志、错误、交接或测试快照中保存密码、token、输入原文或完整私人 UI 树。检查：拟议 A-21。
- 改 helper 源码或构建脚本后必须重建；每次read前的本地source/recipe/manifest/binary一致性gate失败应停下，不改hash绕过。该gate不是签名或发布认证。检查：拟议 A-30。
- 未运行的测试、被跳过的 native lane、需要 TCC 的测试都不能写成通过。检查：证据文件与审查。
- 需要新授权时停在相关边界。禁止弹审批的会话不能改用其它路线绕开。检查：拟议 A-08、A-09。
- 不自动提交、推送、合并、安装到用户 Profile 或发布软件包。执行这些动作须有单独授权。检查：review。

## 当前命令状态

真实命令见 [package.json](<package.json>)：build、build:fixture、build:helper、build:stop、typecheck、test:unit、test:profile、test:fixture、test:transport、test:native-observation、test:native-action、check:invariants、check:package、verify:foundation。
先build、build:fixture、build:helper、build:stop再test。默认绿灯不代表AX成功；helper的health/observe_fixture/revalidate_fixture无输入能力，重验exact不可当dispatch许可；act_fixture只对自有fixture做单次press/set_value，尚未接host授权组合与模型工具。显式test:native-action缺AX同样exit3/NOT_RUN。显式native-observation缺AX权限exit3/NOT_RUN，不弹权限。GUI/native input/model均另验。
宿主签名 Node 使用官方 WASM bundler，环境与记录见 [验证记录](<docs/verification/foundation.md>)。
固定入口`node scripts/verify-foundation.mjs`运行8步并输出NO_GO JSON/源码前后指纹；默认不进native，唯一显式`--native-observation`缺AX仍exit3。不是releasegate或依赖闭包签名，见 [验证器](<docs/design-docs/foundation-verification.md>)。
文档结构用 installed project-docs checker。它不能替代实现测试。

## 其他适用文档

- 已有自有 AppKit fixture。UI 约束见 [FRONTEND.md](<docs/FRONTEND.md>)，布局与未验范围见 [DESIGN.md](<docs/DESIGN.md>)。
- [RELIABILITY.md](<docs/RELIABILITY.md>) 描述现有诊断/fixture 失败与取消行为，不承诺未来 helper SLO。
## Not applicable

- docs/generated/：尚无schema生成器，禁止手写后伪称生成结果。
- docs/references/：依赖文档使用设计索引中的来源链接，不复制厂商全文。

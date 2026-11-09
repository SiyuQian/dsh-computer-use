# Plans

## Active

- [Computer Use MVP](<exec-plans/active/2026-11-08-computer-use-mvp.md>)：status active；目标仓库已指定，基础实现已启动。CU-000 完成，CU-001–003 按基础切片验收，后续 native/真实 Profile gate 独立保留。

## Completed

当前没有完成的实施计划。完成目录通过 .gitkeep 保留，不能把“文档已编写”当成插件已完成。

## 运行与交接

- [Agent 运行手册](<exec-plans/AGENT_RUNBOOK.md>)：启动、任务卡执行、并行规则、停止和交接。
- [已知缺口](<exec-plans/tech-debt-tracker.md>)：尚未存在的安全与测试控制。
- [验收矩阵](<product-specs/acceptance.md>)：测试编号及证据要求。
- [固定foundation验证器](<design-docs/foundation-verification.md>)：重跑8步并输出实际分母/限定源码指纹/NO-GO JSON；非MVP或发布通过。
- [当前实施交接](<exec-plans/current-handoff.md>)：untracked工作树、最近证据、未完成退出条件与下一张安全切片。

## 状态更新规则

只有实际仓库改动与验证证据都存在，实施 Agent 才能勾选任务。开始、阻塞、取消、完成都要记入总计划的 Progress log。实施仓库创建后，需把本索引与任务卡放入该仓库并保持唯一来源，不要在本包和仓库各维护一份活跃进度。

# 当前实施交接：2026-11-09 19:20 Pacific/Auckland

## 结论

**实施仍in_progress；MVP未完成，安装/发布NO-GO。** 自有AppKit fixture上的语义闭环（观察→press/set_value→保守回执→独立停止）已在真实AX下实跑通过，但只在测试脚本中运行，没有在真实DSH Profile、模型或Web GUI中运行。唯一活跃实施来源仍是 [总计划](<active/2026-11-08-computer-use-mvp.md>)。

## 恢复时先核对

1. 先pwd、`git status`、HEAD，并读 [AGENTS](<../../AGENTS.md>)。功能代码已全部合入`main`（PR #1–#10，均已merge）；新切片从最新`origin/main`开新分支。不要reset/clean或删除他人工作树。
2. 授权边界以 [AGENTS](<../../AGENTS.md>) 为准：仅自有fixture的AXPress/set_value；每个切片新分支commit/push/Draft PR。不含merge、发布、日常Profile安装、真实应用、键盘或pointer。辅助功能权限由用户手动授予DeepSeek Harness.app，Agent不请求、不绕过TCC。
3. [manifest](<../../package.json>) 仍private，DSH SDK0.2.2-rc.1、Cordis4.1.0、Node24.21.0；用host提供的managedNode，不假设PATH版本。新worktree需先`pnpm install --frozen-lockfile`；pnpm会报告忽略3个build script，并在`pnpm run`前打印install失败WARN，目前不影响build/test。
4. 实际重跑 [固定验证器](<../design-docs/foundation-verification.md>)，不要只信下列历史数字：

```sh
node scripts/verify-foundation.mjs --native-observation
pnpm run test:native-action
pnpm run test:native-e2e
```

缺AX权限时三者都返回exit3/NOT_RUN，不能写成通过。

## 最新证据（2026-11-09 19:21，HEAD `c54de51`，clean）

- verify-foundation `--native-observation`：runId `a7efdf9f-ca9e-4f6f-a420-dddcb3a9b40c`，8steps全部exit0，**1086tests/54files**，failed/pending/todo均0；限定源码151files/990743bytes，前后digest `97297d77…`一致，dirty=false；显式native-observation passed，整体exit0。helperBinaryDigest `a99f9a10…`。
- 同一worktree中`test:native-action`与`test:native-e2e`各exit0（单次复跑；连续3次证据见 [总计划](<active/2026-11-08-computer-use-mvp.md>) CU-012a2/CU-015c）。
- 2026-11-09 19:28 文档刷新会话（HEAD `0d78bb1`，DSH workspace-write 沙箱）：verify-foundation runId `6615df55…` exit1，1085/1086；唯一失败为 [helper-artifact](<../../tests/transport/helper-artifact.test.ts>) 的 setuid 用例——该沙箱内`chmod 4755`静默丢弃setuid位，故障无法构造，非代码回归，但未在此环境证明通过。同会话`test:native-e2e` exit0（单次）。后续在无此限制的环境重跑。
- 2026-11-09 22:40 分支`fix-fixture-tools-host-inject`（base `f2931bc`）：修复插件入口只声明`inject=['tools']`、fixture工具在真实Cordis中读`ctx.agents`即报`cannot get property "agents" without inject`的问题（此前所有lane都绕过插件入口，未覆盖）。verify-foundation runId `41658f29…` exit1，1107/1108，唯一失败仍是上述setuid用例（本沙箱`chmod 4755`实测得`-rwxr-xr-x`，干净`main`同样失败）；check:invariants/check:package/`git diff --check`另跑exit0，前后源码digest一致。三条native lane在屏幕锁定时均exit1（`TARGET_CHANGED`），干净`main`同时同样失败，且lane的import闭包不含本次改动模块；屏幕解锁后需重跑，不能写成通过。
- 验证器的`releaseDecision`恒为NO_GO；`unmetGates`中`NATIVE_CONTROL_NOT_IMPLEMENTED`是 [report.mjs](<../../scripts/verification/report.mjs>) 的固定常量，在fixture语义动作实现后已不准确。修改它须作为独立代码切片，并同时更新测试。

## 当前能力

- 默认只注册`cu_status`。插件Config `fixtureControl=true`后才注册`cu_observe`/`cu_act`/`cu_stop`，且只针对自有fixture。三个工具位于声明agents/sessions/workingDirectory/subprocess的嵌套Cordis scope中，服务齐全才注册，服务卸载即移除（此时`cu_status`报disabled）；approval为可选服务，缺失时需审批的动作拒绝。
- 组合链见 [FixtureComputerUse](<../../src/service/fixture-computer-use.ts>)：host绑定→静态fixture read grant→观察→lease/风险→需要时调用真实DSH approval（never/unavailable时拒绝）→per-user `CUController`槽→ledger `dispatch_pending`→helper最后重验+单次dispatch→保守receipt。不重试，unknown结果保留为unknown。
- 停止：`cu_stop`或独立`CUController --stop`；`cu_status`报告ready/stopped/disabled，停止到host abort实测<500ms。
- 审批policy为never的会话中，需批准的动作按设计拒绝；手动试用要在可询问审批的会话中进行。

## 尚缺的退出条件

| 任务 | 具体剩余 |
|---|---|
| CU-016b | DSH Web GUI停止按钮/状态面板（在既有GUI URL验证）、用户输入冲突监测 |
| CU-017/018 | 显式takeover模式；Skill、工具描述与恢复指导 |
| CU-024b/025 | fixture/stop/controller完整包布局、签名与供应链；临时干净Profile安装与生命周期验收 |
| CU-007b2b/008b2/009b/010c/011b/013b/014b | rebind、live consent、生产broker组合、可信回读/effect verifier、截图与磁盘artifact |
| CU-019/020/026–028 | 任务verifier、真实应用矩阵、模型smoke、独立安全审查与发布gate |

私人数据仍no-go：官方Tool会持久化原始参数，修改Session审计不是解决方案。

## 下一张建议切片

先在屏幕解锁时重跑三条native lane，确认本分支未回归。2026-11-09 22:00用户明确不需要临时Profile，CU-025的临时Profile安装不再作为下一步；任何Profile安装仍未授权。可选CU-016b（Web GUI停止/状态），或修正验证器中过时的`unmetGates`常量。经插件入口的真实Host闭环目前只有内存Cordis profile测试覆盖，模型/GUI侧仍未运行。

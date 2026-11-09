# 当前实施交接：2026-11-09 Pacific/Auckland

## 结论

**实施仍in_progress；MVP未完成，发布/安装NO-GO。** 34个验收编号未按完整多层要求通过；大量unit/transport测试是已完成子断言，不是完整native安全证明。最近完成子卡CU-007a2观察intent、CU-013a2固定评估诚实回执、CU-002c可重复开发验证器。唯一活跃实施来源仍是 [总计划](<active/2026-11-08-computer-use-mvp.md>)。

## 恢复时先核对

1. 复用已记录的computer-use-foundation工作树，不新建第二份实现。先pwd/gitstatus/HEAD并读 [AGENTS](<../../AGENTS.md>)；本机准确workspace metadata保存在忽略目录，不在公开文档列用户路径。
2. 原空root基线是 `2dd79be492de26f7b8f560258e2edfc4f3560a64`。04:13历史验证时实现全部untracked/uncommitted；17:23 Pacific/Auckland 用户另行要求创建 PR，获准将现有实现提交/推送至computer-use-foundation，main仅用原空提交作审查基线。**恢复时重新核对Git与远端PR状态，不再假设代码仍untracked或已合并。** 不reset/clean或删除工作树。此次授权不包括merge/install/publish；保留已有本机workspace metadata。
3. [manifest](<../../package.json>) 仍private，准确DSH SDK0.2.2-rc.1、Cordis4.1.0、Node24.21.0；managedNode配官方WASM bundler，不修改签名/TCC/Core。环境事实见 [实施基线](<../design-docs/implementation-baseline.md>)。
4. 实际重跑 [固定验证器](<../design-docs/foundation-verification.md>)，不要只信下列历史计数。它固定8steps，输出限定源码before/after指纹、HEAD/dirty、实际退出码/test分母，恒定NO_GO。

```sh
node scripts/verify-foundation.mjs
# 仅当明确执行已批准的自有fixture只读AX lane；缺TCC仍NOT_RUN，不会请求权限：
node scripts/verify-foundation.mjs --native-observation
```

使用当前host提供的managedNode路径，不假设系统PATH版本。报告只写stdout，进度写stderr；本机可留存JSON但不要提交私人数据或官方Session日志。文档checker独立运行，入口/全量命令见 [README](<../../README.md>) 与 [验证记录](<../verification/foundation.md>)。

## 最近新鲜证据及边界

- CU-002c实际本机runner的8steps：TSbuild、fixture/helper/stop编译、typecheck、全部tests、ASTboundary与built-entry smoke均exit0；1023tests/48files，failed/pending/todo均0。
- 限定源码133files、885995bytes，前后digest相同（具体digest/runId/helperdigest见 [验证记录](<../verification/foundation.md>)）。最终重复运行04:13 Pacific/Auckland所得runId为`356484e5-b8db-4945-bce9-ffdb1deb913a`，同样1023/48/8steps0、nativeNOT_RUN整体3。before/after HEAD同base、dirty=true，不能称clean或已提交。
- 显式native-observation返回固定Accessibility缺失，statusnot_run/exit3；整次exit3，该显式lane未启动fixture/请求TCC（基础suite另运行hiddenfixture自测），没有native输入。NO_GO/nativeControlfalse/privateDatafalse没有因deterministic绿灯改变。
- 独立code review只在7文件/42target+tsc范围，无高置信finding/noProbe；父全量不是reviewer独立重跑。完整历史Red/Green与局限见 [记录](<../verification/foundation.md>)。
- 当前唯一模型工具cu_status。没有read/controlruntime的入口安装、native动作命令或产品UI；helper只health/observe_fixture/revalidate_fixture。

## 尚缺的完整退出条件

| 前序/任务 | 具体剩余 | 当前必须保持 |
|---|---|---|
| CU-006c/007b2b | 用户已授权系统权限下真实fixture AX观察/私有handle重验成功及native竞态 | NOT_RUN；不凭synthetic identity冒充AX成功 |
| CU-008b2/009b | 从可信观察来源到controllease/真实consent/approval组合 | read/control权威分离；plainmaterial/candidate不当proof |
| CU-010b2b2/c/016 | 生产唯一broker/独立用户stop入口/managed input排空与让权监测 | 临时namespace原语不当生产stop保证 |
| CU-011b/012/015 | live授权、ledgerpending、native最后重验、单次实际输入与只读恢复事务 | 没有executor；不开放输入或unknown自动重放 |
| CU-013b/014b/019 | 可信回读/目标效果/taskverifier，capture/磁盘manifest与独立数据授权 | 无verified/evidence/capture；不把树变化当业务完成 |
| CU-018/020/024b–028 | 完整工具/Skill、真实应用/Profile/UI/model、签名分发/安全审查和发布gate | 无支持率/模型兼容/发布可用声明；不安装发布 |

私人数据还受官方Tool原始参数持久化约束，仍no-go；更改Session审计不是解决方案。

## 下一张安全切片

native依赖只有在用户另行满足授权条件后才恢复，不能把“继续”解释为授予TCC。其余工作不是因整体困难而停止：可继续拆**host-only可信观察来源票→inert控制复检**，但须先冻结跨read/control的exactobject来源验证，不接受plainmaterial字符串或返回candidate作为authority。

最小开工要求：在总计划加依赖已满足的子卡；TDD证明伪造/clone/跨runtime/旧scope/原turn/deadline、parsegetter撤销与同票并发均拒绝；从私有read store/原deadline逐次复查，再独立controllease/风险评估。不得调用executor、真实approval、ledgerdispatch或新增model工具；结果继续dispatchablefalse。如果选择其它切片，同样先声明依赖和不变量，不能顺手跨native/生产授权gate。

2026-11-09 用户要求创建 PR，单独授权现有 foundation 的commit/push及空main基线；后续变更不自动获得同等授权。没有自动merge/install/publish步骤。后续人工决定、实际PR链接/头提交与运行目标状态以实时GitHub/会话/goal工具为准；Draft PR不改变NO_GO或MVP未完成结论。

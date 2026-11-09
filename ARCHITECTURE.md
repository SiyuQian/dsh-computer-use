# Architecture

状态：2026-11-09（Pacific/Auckland），foundation、fixture、只读transport与fixture-only AX reader/投影/私有handle重验service已有代码。真实 AX 成功路径因权限缺失未验收；native control 未实现。

## 当前模块与依赖

| 模块 | 实际入口 | 职责与允许依赖 |
|---|---|---|
| plugin | [src/index.ts](<src/index.ts>) | 只注册 `cu_status`；依赖 Cordis/tools 与严格空参数校验；没有原生能力 |
| contracts | [src/contracts/index.ts](<src/contracts/index.ts>) | 严格 Zod 请求、Observation、TaskLease、Receipt、health envelope；只依赖 zod 和本域 |
| host-adapter | [src/host-adapter/context.ts](<src/host-adapter/context.ts>) | 精确 live Agent/Session、open turn、workingDirectory 绑定；尚未接入原生动作 |
| boundary sensor | [scripts/check-invariants.mjs](<scripts/check-invariants.mjs>) | AST 检查合同静态/动态/require 导入不得越界；不是恶意代码沙箱 |
| package smoke | [scripts/check-package.mjs](<scripts/check-package.mjs>) | 实际 import 构建入口，在真实 Cordis 容器注册/卸载，仅允许状态工具 |
| tests | [tests/unit/](<tests/unit/>)、[tests/profile/](<tests/profile/>) | 独立合同、边界和 host seam；真实 SDK registry/pipeline 生命周期 |
| fixed developer verification | [verify-foundation.mjs](<scripts/verify-foundation.mjs>)、[summary](<scripts/verification/report.mjs>)、[snapshot](<scripts/verification/source-snapshot.mjs>) | 固定argv/cwd，8步真实退出码/test分母与前后限定源码/HEAD；默认不native、缺权限显式NOT_RUN、始终NO_GO，不认证完整输入闭包/签名/MVP |
| AppKit fixture | [native/Fixture/](<native/Fixture/>)、[fixture tests](<tests/fixture/fixture.test.ts>) | 自有双窗口、独立 public state、hidden self-test；不注入系统输入 |
| native read | [transport.ts](<src/backend/macos/transport.ts>)、[Helper](<native/Helper/main.swift>) | 固定binary、封闭health/observe_fixture/revalidate_fixture、bounded frame/cleanup；不接模型工具 |
| helper artifact admission | [helper-artifact.ts](<src/backend/macos/helper-artifact.ts>)、[builder](<scripts/build-helper.mjs>) | fixed local源码/recipe/manifest/binary/Mach-O一致性、有界FD/路径witness；每次read前复检，不认证publisher或原子exec |
| observation projection | [project.ts](<src/observation/project.ts>)、[fixture reader](<native/Helper/FixtureObservation.swift>) | 精确fixture process/window witness、secure正向值allowlist、有限公共投影；缺TCC成功路径未验 |
| read-only revalidation | [revalidate.ts](<src/backend/macos/revalidate.ts>)、[Swift adapter](<native/Helper/FixtureRevalidation.swift>) | fixture element lifecycle witness/有界完整扫描/closed exact响应不可dispatch；AX成功未验 |
| observation lifetime | [store.ts](<src/observation/store.ts>) | 纯host有界内存、opaque read ticket、monotonic TTL、exact lifetime scope、私有fixture witness；gate后重验，候选不dispatch |
| observation action intents | [fixture-action-intents.ts](<src/service/fixture-action-intents.ts>) | readruntime私有HMAC/单次objectticket；live观察成员/private witness+readgrant派生target/material、原mono TTL与turn/epoch复检；不持输入、不签control/批准/native许可 |
| read policy | [read-authority.ts](<src/policy/read-authority.ts>) | host-only exact fixture读grant，默认拒绝、短期TTL/撤销，不签发control |
| read orchestration | [fixture-read.ts](<src/service/fixture-read.ts>) | backend前和publish前核对grant/current host，固定错误与ticket清理；未接工具 |
| read revalidation orchestration | [fixture-revalidation.ts](<src/service/fixture-revalidation.ts>) | strict handle-only请求、read grant/private candidate前后复检，固定公开exact不可dispatch；未接工具/consent |
| internal read runtime/lifecycle | [runtime](<src/service/fixture-read-runtime.ts>)、[event adapter](<src/host-adapter/read-lifecycle.ts>) | random generation/private组合，每次exact host bind，Agent/Session/cwd事件撤销与复合卸载；opt-in不在入口安装，不签consent/control或声称drain |
| shared host scope/lifecycle | [scope-registry](<src/host-adapter/scope-registry.ts>)、[events](<src/host-adapter/scope-lifecycle.ts>) | private per-runtime generation/exact objects/bounded tracking/epoch gate，post-cwd复查turn，清理全段关门；共享代码不互授权 |
| inert control runtime | [runtime](<src/service/fixture-control-runtime.ts>)、[factory](<src/host-adapter/control-lifecycle.ts>) | 私有policy/逐call绑定与Agent/Session/cwd/policy/unload撤销；静态host issue/evaluate/signal与私有inert批准绑定，无execute/真实prompt/native，不在入口安装 |
| control policy | [control.ts](<src/policy/control.ts>) | host-only fixture租约、独立risk、allowlist/预算/撤销；decision不可dispatch |
| single-use binding | [approvals.ts](<src/policy/approvals.ts>)、[adapter](<src/host-adapter/approval.ts>) | 私有HMAC exact envelope/epoch与一次消费，新增 [live inert租约service](<src/service/fixture-approvals.ts>) 的bound host答复与撤销先清；公开SDK adapter默认disabled，无真实prompt/执行 |
| host coordination | [control-queue.ts](<src/coordinator/control-queue.ts>)、[private scheduling](<src/service/fixture-scheduling.ts>) | 有界FIFO/claim/batch撤销与stop-drain；runtime只固定inert policy评估、lease-derived完整target，stopVersion/host-lease-turn复检，不接callerwork/native/批准消费/ledger |
| kernel lock primitive | [ControlLock.swift](<native/ControlLock.swift>) | 真实Darwin flock/FD/path witness，当前仅自有临时目录test probe，未接生产broker |
| independent stop primitive | [StopChannel.swift](<native/StopChannel.swift>) | 同UID+私有能力的有界stop-only UDS，test namespace第三进程撤销，ACK不冒充drain |
| namespace / local stop | [ControlNamespace.swift](<native/ControlNamespace.swift>)、[StopDiscovery.swift](<native/StopDiscovery.swift>)、[CLI](<native/StopCLI/main.swift>) | 固定euid路径策略/verified FD、私有stop-only发现记录、本地客户端；仅临时parent成功验收，未部署生产broker |
| host action ledger | [action-ledger.ts](<src/coordinator/action-ledger.ts>) | 签名短期ID/私有proposal绑定、fresh append journal/fsync pending、只读恢复，不授予输入许可 |
| ephemeral memory artifacts | [ephemeral-artifacts.ts](<src/evidence/ephemeral-artifacts.ts>) | 默认关闭、host逐次授权/单次ticket/容量reservation/TTL/owned bytes cleanup；默认disabled的 [内部service](<src/service/fixture-artifacts.ts>) 已接read runtime前后host/观察target/readgrant+独立policy与公开事件清理；不capture/落盘/认证evidence，不在入口激活 |
| conservative receipts | [action-receipts.ts](<src/evidence/action-receipts.ts>)、[private evaluation receipts](<src/service/fixture-evaluation-receipts.ts>) | host单调事实与private固定policy/queue→not_executed终态；scope先seal后abort、typedcapacity/latefirstterminal，runtime无ACK/target/dispatch口、不认证native/ledger/evidence |

构建产物由 TypeScript 生成到忽略的 lib 目录，不手写产物。bundle patch 使用 [cordis.patch.yml](<cordis.patch.yml>)。

## 尚未实现的域

Observation真实AX→private handle重验成功与rebind、真实consent/TaskLease/批准组合、生产broker/用户stop入口、Evidence verifier、通用macOS observe/mutate helper和client UI仍是 [实施设计](<docs/design-docs/plugin-design.md>)。现有policy/approval/队列只是inert host内核；flock只在test namespace运行，尚未组合production控制授权。host action ledger已有独立disk/kill切片但未接生产执行事务；没有native输入，不对模型暴露动作工具。

`parseTaskLease` 只检验形状与内部时限，不证明来源或授权。`parseReceipt` 只拒绝自相矛盾的声明，不认证 evidenceId 真伪。后续服务必须解析可信 store，不能把校验成功直接当能力。

## 现有不变量

| ID | 不变量 | 真实传感器 | 边界 |
|---|---|---|---|
| D-01 | 状态工具不暴露原生控制 | profile 与 built-entry smoke | 只验证当前入口，未来新增工具须增测试 |
| D-02 | 模型不能注入身份/批准/脚本字段 | strict contracts + [合同测试](<tests/unit/contracts.test.ts>) | 尚未接 native，不能声明越权输入测试通过 |
| D-03 | Host 绑定必须匹配 exact live object | [上下文测试](<tests/unit/host-context.test.ts>) | 借用 host registry 接口，身份不是许可 |
| D-04 | 合同不依赖宿主或执行能力 | `check:invariants` + [传感器测试](<tests/unit/invariants.test.ts>) | AST guard 不是安全沙箱 |
| D-05 | unknown 不可变成 safe-to-retry 未执行 | receipt schema + A-12/13 子断言 | 尚无 native 回执生成实现 |
| D-06 | 文档必须可发现且链接有效 | installed project-docs checker | 不验证语义真实性 |
| D-07 | native health只支持有界健康查询，无重试 | [transport tests](<tests/transport/helper.test.ts>) | fixture读取另有strict目标，无产品UI入口，不认证同用户恶意程序 |
| D-09 | 本地helper源码或产物变化不得跳过一致性gate直接启动 | [artifact](<tests/transport/helper-artifact.test.ts>)、[build race](<tests/transport/helper-build.test.ts>) | 开发一致性，非签名/原子exec/同UID隔离 |
| D-08 | 观察scope/TTL/成员来源由host store核对 | [store tests](<tests/unit/observation-store.test.ts>) | 内部private候选/重验service与opt-in Session事件已接；完整AgentLoop/AX成功/生产consent未验，不是grant |

## 已冻结的基础选择

- 用户指定本仓库并授权开工。准确工作区见 [实施基线](<docs/design-docs/implementation-baseline.md>)。
- TypeScript 基础与 Swift AppKit fixture/macOS helper 方向。Swift helper 的最低系统支持仍须 native 验收。
- DSH SDK 0.2.2-rc.1、Cordis 4.1.0，使用真实 npm 类型，不仿造 SDK。
- 目前只允许测试数据。宿主原始 Tool 参数留存是私人数据 no-go，见 [SDK 调查](<docs/design-docs/sdk-compatibility.md>)。
- P0 先支持 press/set_value；keyboard/coordinate 不进入已实现 action union。扩展需新协议与验收。

## 阅读入口

[产品定义](<docs/PRODUCT_SENSE.md>) → [合同](<docs/design-docs/contracts.md>) → [计划](<docs/PLANS.md>) → [验证记录](<docs/verification/foundation.md>)。

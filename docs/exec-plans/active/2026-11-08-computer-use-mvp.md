# Computer Use Plugin：Agent 详细执行计划

Status: active（用户已指定仓库并授权开工。foundation 已实现；原生/UI/模型验收未完成）
Started: 2026-11-08（计划编制日期，不是编码开始日期）

## Goal

在明确目标仓库中交付一个 DSH/macOS 插件。先在自有 AppKit fixture 完成：授权精确窗口、观察、目标绑定操作、执行前重验、回读证据、用户停止和生命周期清理。随后才进入明确批准的真实应用测试副本。

产品定位见 [产品定义](<../../PRODUCT_SENSE.md>)。不能把本计划当成系统操作或发布授权。

## Non-goals

不训练模型、不提供任意脚本、不替代 API/CLI/DOM、不操作真实高影响业务、不修改 DSH Core、不在 MVP 扩展 Windows。视觉与 pointer 是 P1，不阻塞语义闭环。

## Design

- [模块设计](<../../design-docs/plugin-design.md>)。
- [接口约定](<../../design-docs/contracts.md>)。
- [安全边界](<../../SECURITY.md>)。
- [34 个验收场景](<../../product-specs/acceptance.md>)。
- [Agent 运行手册](<../AGENT_RUNBOOK.md>)。

所有代码路径下列均为拟议落点，不是现存文件。CU-002 可以在命令表与架构记录中一次性映射。

## 0. 实施前必须取得的事实

- 目标仓库的绝对路径、是否已有代码及 Git 状态。
- 插件包名/命名空间、目标 DSH 精确版本与可用公开接口。
- fork、审查后复用或独立实现的选择。
- 至少一台可运行 native fixture 的 Mac，TCC 由用户手动授予。
- 实际测试仅用 fixture/批准测试副本。真实账号和私人文档不默认纳入。

缺失目标仓库时停止在 CU-000，不创建新远端仓库。缺 TCC 可以继续 unit 工作，但 native lane 必须记 not_run。

## 1. 阶段与交付门槛

| 阶段 | 任务 | 可观察交付 | 门槛 |
|---|---|---|---|
| G0 | CU-000–002 | 目标仓库、复用决策、SDK 调查、真实命令表、空 Profile 生命周期 | 未确定目标仓库不能写实现 |
| G1 | CU-003–007 | 合同、fixture、封闭 helper、AX 观察、目标版本 | 负向观察/身份用例先通过 |
| G2 | CU-008–015 | 授权、单次批准、协调/幂等、语义动作、回执、隐私、纵向闭环 | fixture 以真实 native 执行验证 |
| G3 | CU-016–018 | 用户让权、停止、显式接管、Skill | 前台与输入监测有证据 |
| G4 | CU-019–020、024–028 | 文件保存核验、真实应用试用、产物、Profile、模型验证与发布审查 | 34 个场景按范围具备真实记录 |
| G5 | CU-021–023 | 独立 P1 视觉、定向 pointer、gesture | 定向输入门槛失败就关闭能力 |

P0 release 不要求 G5 的 A-24–26 通过，只要求该能力默认关闭且无法调用；开放 G5 后必须补 native 实测。

## 2. 命令契约

基础实际命令已在 [package.json](<../../../package.json>) 建立：SETUP、TYPE、BUILD(TS)、UNIT、PROFILE（仅内存Cordis/公开Session事件）、PACKAGE（built-entry smoke）、STATIC、FIXTURE、TRANSPORT（只读helper/拒绝与临时namespace/账本故障，不是native输入）。原生构建另用build:fixture/build:helper/build:stop；显式test:native-observation只读AX lane缺权限exit3/NOT_RUN。CU-002c固定verify:foundation跑8步，记录前后限定源码/HEAD/dirty及实际分母、始终NO_GO，见 [验证器](<../../design-docs/foundation-verification.md>)。下表NATIVE/PROFILE/PACKAGE等描述完整目标层要求；未有native-input/MODEL/DOCS/UI/REAL-APP命令时不得临时拼名或宣称运行。文档用installed checker；完整Profile仍CU-025，不把内存test当CLI/Web Profile。

| 名称 | 预期命令 | 定义 |
|---|---|---|
| SETUP | `pnpm install --frozen-lockfile` | 使用真实 lockfile，不在 DSH 安装目录运行 |
| TYPE | `pnpm run typecheck` | TS 与公共协议类型 |
| BUILD | `pnpm run build` | TS、native、UI、manifest 一致重建 |
| UNIT | `pnpm run test:unit` | 纯逻辑、fake backend、fake clock，无 TCC |
| TRANSPORT | `pnpm run test:transport` | native 封闭协议与故障注入 |
| NATIVE | `pnpm run test:native -- --require-tcc` | 缺 TCC 必须失败，不可静默 skip |
| PROFILE | `pnpm run test:profile` | 干净临时 Profile，不改用户默认配置 |
| MODEL | `pnpm run test:model` | 有授权/凭据才运行，固定任务/模型预算 |
| PACKAGE | `pnpm run check:package` | 包内容、许可、schema/native manifest/hash |
| DOCS | `pnpm run check:docs` | 文档链接、索引与声明 |
| STATIC | `pnpm run check:invariants` | 依赖边界、输入 route 与源码/二进制静态断言 |
| UI | `pnpm run test:ui` | 控件行为、RPC 鉴权与可见状态；真实 GUI 另有精确步骤 |
| FIXTURE | `pnpm run test:fixture` | fixture 启动、状态记录和测试侧独立断言 |
| REAL-APP | `pnpm run test:real-app -- --scenario <已批准场景ID>` | 仅 CU-000/020 明确批准的测试副本；脚本缺失则精确书面步骤，不临时拼命令 |

命令表落地时必须引用 package manifest 的定义和首次执行证据。如果选择别的包管理器，统一改表与所有任务，不混用两套命令。每卡的“验证”指这些命令建立后的真实调用。

## 3. Tasks

任务状态以各卡记录为准，不以本计划原始模板为准。首轮将 CU-001/002 拆成基础发现/registry/package 与后续真实 Profile/UI/transport gate，将 CU-003 按 request、observation/receipt、host binding 三个红/绿切片执行，证据见 [基础验证](<../../verification/foundation.md>)。每次只实现一种行为，禁止用大任务掩盖未验收能力。

### CU-000 · 锁定目标仓库与实施授权

- Priority: P0。Depends: none。Status: completed。
- [x] 仓库/基线/隔离工作树/基础独立实施路线已记录，见 [实施基线](<../../design-docs/implementation-baseline.md>)。
- 范围：确认 repo path、Git base、dirty files、包名、宿主目标、复用路线与 native 测试范围；把计划迁入真实仓库的方式写清楚。
- 接口/产物：范围决策、来源/许可清单、实施仓库唯一文档入口。
- 非目标：不安装、发布、创建远端仓库，不修改参考 checkout。
- 测试/验收：提供 pwd、git status、manifest/doc 清单和用户确认记录。若无目标仓库则仅输出精确缺失项。
- 停止：仓库或所有权不明确；用户修改可能覆盖；复用许可不清。

### CU-001 · 核对 DSH SDK 与可用宿主能力

- Priority: P0。Depends: CU-000。Status: completed（foundation 范围）。
- [x] CU-001a：DSH 0.2.2-rc.1/Cordis 4.1.0、tools execute/output、trusted registry、open turn、current directory、approval 与原始参数日志边界已核实。
- [x] CU-001b：最小注册/卸载 spike 在独立内存 Cordis 容器通过，见 [SDK 调查](<../../design-docs/sdk-compatibility.md>)。
- 后续 gate：subprocess 实测在 CU-005，Settings/RPC/真实 GUI 在 CU-016，完整临时 CLI/Web Profile 在 CU-025。未通过前不开放对应能力，不宣称完整 SDK 集成已验收。
- 范围：读取真实 host/plugin SDK，核对工具注册、可信调用身份、审批、会话清理、子进程、Settings/RPC/UI、模型工具支持，以及 Tool 参数/结果/Session 日志的原文持久化与 redaction 能力。
- 接口/产物：精确版本兼容表；每项 API 的存在证据；TypeScript/Swift 与 macOS baseline 决策。
- 非目标：不改 DSH Core，不以猜测的 service 名称写兼容层。
- 验证：最小注册 spike 在临时 Profile 加载和卸载；所有缺失能力给替代方案或 stop。
- 停止：关键审批或可信 owner API 不可用且无法在插件边界安全实现。若无法阻止机密原文进入宿主日志，仅允许 fixture/公开测试数据；私人数据支持记 no-go，不私改官方 Session 审计。

### CU-002 · 建立最小 bundle、命令与架构边界

- Priority: P0。Depends: CU-001。Status: completed（diagnostic-only foundation 范围）。
- [x] CU-002a：manifest/lockfile/build/typecheck、严格状态工具与真实 SDK registry 生命周期测试。
- [x] CU-002b：合同导入 AST 传感器与构建入口加载/卸载 smoke；非 macOS 输出路径已有实现但未在非 Mac 运行。
- [x] CU-002c：Depends CU-002a/b，固定本地foundation runner与机器可读NO-GO证据已验（实际退出码、test分母、运行前后限定源码指纹/dirty元数据），native-observation显式opt-in/缺权限NOT_RUN；默认不读UI，不接受自定义命令、不安装发布、不把基础绿灯当MVP完成。见 [验证器](<../../design-docs/foundation-verification.md>)。
- 后续 gate：native/UI/模型 lane 脚本随相应任务建立，完整 Profile 在 CU-025；当前不生成伪 pass 脚本。证据见 [基础验证](<../../verification/foundation.md>)。
- 范围：包入口、版本/lockfile、工具链、unsupported platform 行为、命令表、模块依赖检查、临时 Profile smoke。
- 接口/产物：可构建的空能力插件；注册/停用不会残留；实际架构地图。没有 native 变更工具对模型开放。
- 非目标：不先建所有模块 stub，不发布包。
- 验证：TYPE、BUILD、UNIT、PROFILE；A-01。编译失败先修，不跳过。

### CU-003 · 冻结版本化合同与可信上下文

- Priority: P0。Depends: CU-002。Status: completed（基础协议版本 1）。
- [x] CU-003a：闭合 prepare/execute、press/set_value、TaskLease 形状；schema 不签发任何授权。
- [x] CU-003b：有界 Observation、secure value 拒绝、window-local screenshot 内部一致性、诚实 Receipt、native health envelope。
- [x] CU-003c：绑定 exact live Agent/Session/open turn/current directory，不从模型参数取身份。
- deferred：未实现动作不进入协议；keyboard/pointer 和 helper observe/mutate 合同随 CU-005/012/022 以测试驱动扩展。fake clock/backend 在需要它们的 CU-007 建立，不以无消费者 stub 充数。
- 范围：Observation、TaskLease、闭合 Action、Receipt、Error、native envelope 的 schema 与生成/映射规则；HostContext 从 host 取得。
- 接口/产物：单一 schema 来源、协议版本、fake clock/backend；拒绝 unknown fields、伪造 owner 与脚本参数。
- 非目标：不实现 native 输入。
- 验证：先写 malformed/identity 注入失败测试；TYPE、UNIT；A-02。

### CU-004 · 实现可复现 AppKit fixture

- Priority: P0。Depends: CU-003。Status: completed（自有 AppKit app 与 hidden self-test）。
- [x] CU-004a：fixture build/隐藏控件/独立状态/未知启动参数的失败测试先运行。
- [x] CU-004b：稳定 bundle id、双窗口独立 store、secure 不留状态、替换/重排/保存/reset/延迟取消已实测；独立审查问题补 Red→Green。
- 未验：外部 helper AX 与输入、可见 UI、最低 OS/Intel/TCC 均留 CU-005+。详见 [fixture 设计](<../../design-docs/fixture.md>)。
- 范围：固定标识按钮/文本框、secure field、可替换/重排控件、双窗口、延迟效果、假 submit 和测试专用状态记录。
- 接口/产物：固定 bundle id、显式启动/退出、测试数据目录、无真实网络/账号；稳定标识与状态日志。
- 非目标：不包含私人应用自动化。
- 验证：BUILD、FIXTURE；能从测试侧独立读到效果，不依赖被测 AX 回执自证。

### CU-005 · 实现封闭 helper 传输与健康检查

- Priority: P0。Depends: CU-003、CU-004。Status: completed（health/transport 切片）。
- [x] CU-005a：真实公开 subprocess API、封闭 health schema、launch/request 配对与负向测试。
- [x] CU-005b：Swift health-only helper、8KiB frame、仅无提示权限 preflight、普通非托管调用拒绝。
- [x] CU-005c：一次性受管 child、超时/取消/崩溃/额外响应处理与 bounded cleanup，真实 subprocess provider 验证。
- 拆分后的后续 gate：process/window 身份能力与 list/observe wire 在 CU-006 起始先冻结/负向验证再读取自有 fixture；当前完全没有 UI 内容读取。签名/完整性执行 gate 仍在 CU-024。见 [transport 设计](<../../design-docs/native-transport.md>)。
- 范围：版本、长度、命令白名单、受管 transport、取消、超时、app process/window 身份能力检测；仅 health/list/observe，不开放输入。
- 接口/产物：strict JSON/XPC 合同、无任意脚本、TCC 诊断、同用户威胁边界记录。
- 验证：TRANSPORT、UNIT；A-03。普通 shell 拒绝不是完整父进程认证证明。

### CU-006 · 实现精确 AX 观察与安全投影

- Priority: P0。Depends: CU-005。Status: in_progress（native成功路径缺AX权限）。
- [x] CU-006a：fixture-only严格读取合同、同用户PID/kernel start/固定executable、真实windowNumber与生命周期UUID witness；身份负向路径实测。
- [x] CU-006b：reader/公共投影实现，64节点/12深度/值1024预算；安全字段positive allowlist与Swift getter计数负测实测；仍无可执行handle store。
- [ ] CU-006c：真实AX成功读取两窗口、secure省略与identity重复/替换。显式test:native-observation现退出3/NOT_RUN（accessibility=false），不请求TCC，不算完成。
- 审查修复：未知secure metadata禁止value getter；禁止合成窗口身份。详见 [观察设计](<../../design-docs/fixture-observation.md>)。
- 范围：精确 app/window、节点/深度/文本上限、AX role/actions、secure value 脱敏、目标 descriptor 与 read 权限接口。
- 接口/产物：Observation 的 backend 原始证据与 public 投影分离；身份不可取得时明确能力限制。
- 非目标：不截图、不输入，不把无限 UI 树放进日志。
- 验证：UNIT、NATIVE；A-04、A-05（观察部分）、A-21。

### CU-007 · 实现观察生命周期和目标重验

- Priority: P0。Depends: CU-006。Status: in_progress（host生命周期与fixture只读重验拒绝切片；native成功/执行gate仍未解锁）。
- [x] CU-007a：Depends CU-003/CU-006a/b，纯host观察ticket、monotonic TTL、exact live作用域、有界内存与句柄成员候选已单元红/绿；无native调用/动作/事件接线，不以此替代CU-006c。见 [生命周期](<../../design-docs/observation-lifecycle.md>)。
- [x] CU-007a2：Depends CU-007a/CU-007b2a/CU-008a2，read runtime私有观察派生action-intent已验；仅handle/action输入、live readgrant/成员/完整target与material派生、短期HMAC/单次objectticket，own10s与原obs/grant monoTTL夹限、scope/turn/cancel/撤销前后复检。不签control/native/真实批准或执行、不接controlruntime，不替代007b。见 [intent生命周期](<../../design-docs/observation-lifecycle.md>)。
- [ ] CU-007b：Depends CU-006c/CU-007a，native目标exact重验、唯一低风险rebind与失效证据；AX未验前不得勾完成。
  - [x] CU-007b1：Depends CU-003/CU-004/CU-005/CU-006a/b，只读fixture element生命周期witness、closed revalidate协议/纯决策与native拒绝路径已验；不接public handle执行、不输入，不替代CU-006c成功。见 [重验切片](<../../design-docs/fixture-revalidation.md>)。
  - [ ] CU-007b2：Depends CU-006c/CU-007a/b1，private handle到native witness接线、真实AX exact/替换/reorder/唯一低风险rebind成功验收；AX缺失保留未运行。
    - [x] CU-007b2a：Depends CU-007a/b1/CU-008a，host-only私有handle→fixture witness映射与default-deny read-revalidate service已单元/真实helper身份拒绝seam验证；TTL/scope/read grant前后复检、封闭公开结果，无native输入，不以模拟snapshot替代AX成功。
    - [ ] CU-007b2b：Depends CU-006c/CU-007b2a，真实AX观察→handle→exact重验成功与replace/reorder/rebind验收；权限缺失保持未运行。
- 范围：monotonic TTL、Agent/Session/generation 作用域、opaque handle、exact resolution、低风险唯一 rebind、native 最后重验接口。
- 接口/产物：expired/changed/ambiguous 分离；rebind 使需确认动作重新确认；输入前不信旧 index。
- 验证：UNIT、NATIVE；A-04、A-06。使用 fake clock 测阈值两侧。

### CU-008 · 实现宿主授权与独立风险下限

- Priority: P0。Depends: CU-007。Status: in_progress（read与inert控制策略host切片，native未验）。
- [x] CU-008a：Depends CU-003/CU-006a/b/CU-007a，default-deny精确fixture read grant与内部read service；mono TTL、scope/target、撤销/取消/policy版本替换已单元验证，不开放工具或授予真实TCC。
- [x] CU-008a2：Depends CU-003/CU-007a/CU-007b2a/CU-008a，内部read runtime与公开SDK Agent/Session/cwd事件适配已验；default-deny/scoped revoke/在途abort/旧handle失效/generation隔离/composite卸载、registry替换退役。只读独立验证，不冒充生产consent/native成功或控制生命周期，不新增tools。见 [runtime切片](<../../design-docs/read-runtime.md>)。
- [x] CU-008b1：Depends CU-003/CU-007a/CU-008a，host-only exact fixture TaskLease/operation/target allowlist、独立risk floor、absolute/idle/action预算、撤销epoch/idle signal已单元验证；所有decision dispatchable=false。
- [x] CU-008b1a：Depends CU-008a2/CU-008b1/CU-014a2，共享host scope生命周期与host-only inert控制租约runtime已验；逐call重bind/epoch、scope批量撤销、Agent/Session/cwd/policy/unload失效，read/control不互授权限，不接native/真实consent/批准/队列执行、decision始终不可dispatch。见 [内部控制runtime](<../../design-docs/control-runtime.md>)。
- [ ] CU-008b2：Depends CU-007b/CU-008b1，native exact descriptor与live策略集成、真实配置/consent/生命周期。前序native gate未完成，不开放输入。见 [控制策略](<../../design-docs/control-authorization.md>)。
- 详见 [读取授权](<../../design-docs/read-authorization.md>)；内部read/inert控制Session事件适配已有，完整AgentLoop/生产consent/UI、批准/执行事务生命周期与native集成未完成。
- 范围：read、app/window TaskLease、操作 allowlist、静态授权来源、deny/revoke、TTL、未知语义策略、默认高权限应用限制。
- 接口/产物：DENY/REQUIRE_APPROVAL/ALLOW_WITHIN_LEASE；模型可提高风险但不能降低；never policy 停在审批边界。
- 非目标：不假称通用 DLP 或任意业务语义识别。
- 验证：UNIT；A-08、A-28。原生调用 spy 断言被拒时计数为零。

### CU-009 · 实现准确单次批准

- Priority: P0。Depends: CU-008。Status: in_progress（仅host绑定与默认disabled adapter）。
- [x] CU-009a：Depends CU-003/CU-008b1，canonical envelope/私有HMAC、60s单次消费、safe summary、scope/turn/cancel/变更失效；公开approval API adapter默认disabled，只跑fake host seam。
- [x] CU-009a2：Depends CU-008b1a/CU-009a，inert控制runtime内私有HMAC批准服务已验；prepare/bound host decide/consume重查live租约+风险+hostscope/epoch/turn，scope/policy/unload先清批准再租约abort。仅公开host声明测试元数据/模拟答复，不认证观察/native、不调真实prompt/执行/队列，不替代009b。见 [批准接线](<../../design-docs/single-use-approval.md>)。
- [ ] CU-009b：Depends CU-007b/CU-008b2/CU-009a，live lease/target/read复核、策略撤销接线、coordinator无锁等待与真实已授权交互；native批准期间目标变化未验。见 [单次批准](<../../design-docs/single-use-approval.md>)。
- 范围：canonical envelope、脱敏 host 摘要、HMAC 输入指纹、短期批准、撤销/重绑失效、并发单次消费。
- 接口/产物：approval 不持输入锁；policy/context/target/input/mode 改变即失效。
- 验证：UNIT、NATIVE（批准期间变更）；A-09、A-11。

### CU-010 · 实现唯一控制权、串行化与取消

- Priority: P0。Depends: CU-008。Status: in_progress（host协调内核先行，不开放native）。
- [x] CU-010a：Depends CU-008b1/CU-009a，纯host有界FIFO/精确scope目标占用、排队取消、active abort后保持控制位至work settle、host独立stop/pause/drain/resume；单元验证，不是native许可或broker。
- [x] CU-010a2：Depends CU-008b1a/CU-009a2/CU-010a，inert控制runtime私有claim/queue生命周期与固定policy评估已验；claim仅取livelease内部完整target，排队前/启动前/返回前current-lease-turn复检、scope/policy/unload清理、host stopVersion-drain-resume，不接caller闭包/native/consume批准/账本，不替代010c。见 [协调接线](<../../design-docs/host-coordination.md>)。
- [x] CU-010b1：Depends CU-003/CU-005，Darwin真实flock原语在自有临时目录通过跨进程竞争/退出/崩溃/exec/路径与fd故障测试；不含生产namespace或stop通道。
- [x] CU-010b2a：Depends CU-010b1，仅stop窄协议/同UID与私有继承能力鉴权、sticky revoke与drain区分；自有namespace真实第三进程stop/慢连接/故障已验，foreign UID为syscall注入负测，不冒充真实跨用户验收。见 [独立停止切片](<../../design-docs/independent-stop.md>)。
- [ ] CU-010b2b：Depends CU-010b2a，生产统一per-user namespace、安全启动/配置生命周期和可供用户可靠调用的独立停止入口；不将测试namespace当生产完成。
  - [x] CU-010b2b1：固定OS euid路径策略、安全leaf创建与witness，锁内发布/有界读取stop-only私有发现记录，独立stop CLI源码/构建；自有临时parent跨进程/崩溃/IO fault已验，不创建/stop生产namespace。见 [路径切片](<../../design-docs/control-namespace.md>)。
  - [ ] CU-010b2b2：Depends b2b1，获准生产路径启动/真实用户可达性、发布安装生命周期和executor可服务性验证；native开放前必须完成。
    - [x] CU-010b2b2a：`CUController`（native/Controller）持per-user ControlLock+StopListener+发现记录整个生命周期，host经stdin begin/end领取单次dispatch槽，busy/第二controller拒绝，独立`CUController --stop`或CUStop sticky撤销→host signal abort且不再grant；EOF/exit即撤销。TS [controller client](<../../../src/backend/macos/controller.ts>)；5项真实进程测试在owned临时parent（Red缺模块→Green）。生产路径只在插件启用时由host启动，尚未在真实Profile验收；安装/签名仍CU-024b/025。
- [ ] CU-010c：Depends CU-007b/CU-008b2/CU-009b/CU-010a/b2b，live生命周期/权限撤销、broker与native排空/独立stop组合接线；未满足前不开放输入。见 [协调切片](<../../design-docs/host-coordination.md>)。
- 范围：宿主串行队列、目标租用、单 OS 用户唯一 broker/系统锁、阶段状态、abort 与安全释放协议；先提供不依赖模型的最小 host/local 紧急停止入口。
- 接口/产物：多 Agent/多 host 不同时 native 变更；锁丢失不继续输入；控制状态可查询。任何 native 变更开放前，停止入口必须有鉴权/本地可靠调用与可测试路径。CU-016 再完善 UI，不后置最小停止。
- 非目标：不允许抢锁来让任务继续。
- 验证：UNIT、TRANSPORT；真实跨进程 broker 锁与鉴权停止命令必须运行。这里只完成 A-10 的调度/锁子断言，以及 A-19 的 dispatch 前取消；不能用没有输入实现的 lane 声称真实输入无重叠或持键释放。后两项必须在 CU-012/CU-015 补验，补验前不开放变更工具。
- 拆分规则：若 broker 与宿主状态机超出单会话，先拆 CU-010a/b，并保持前一切片不开放变更工具。

### CU-011 · 实现 actionId 幂等与未知结果恢复

- Priority: P0。Depends: CU-009、CU-010。Status: in_progress（只做host ledger，不开放dispatch）。
- [x] CU-011a：Depends CU-003/CU-009a/CU-010a/b1/b2a，独立host签名短期actionId、私有HMAC proposal、exclusive新建append-only journal、fsync dispatch_pending、重复/冲突/终态、只读崩溃恢复；真实disk/kill/fault已验，不恢复payload/不接native。见 [账本切片](<../../design-docs/action-ledger.md>)。
- [ ] CU-011b：Depends CU-007b/CU-008b2/CU-009b/CU-010b2b/c/CU-011a，生产broker持锁、live授权/批准/native dispatch与账本事务组合，真实native前后kill/pipe故障；前序未过不开放动作。
- 范围：host 签发有时限 actionId、prepare/execute、action ledger、重复/冲突 actionId、durable dispatch_pending、transport 断连与重启恢复。
- 接口/产物：同 action 不重复输入；已过 dispatch 不确定时 unknown；tombstone 生命周期覆盖 actionId 有效期；重启旧 id 拒绝，不恢复输入；不保存输入原文或可枚举裸 hash。
- 验证：UNIT、TRANSPORT；A-11、A-13、A-14。kill/pipe 故障点必须覆盖前后两侧。

### CU-012 · 实现目标绑定的语义写入与受限键盘

- Priority: P0。Depends: CU-007、CU-009、CU-011。Status: in_progress（2026-11-09用户授权fixture语义动作）。
- [x] CU-012a1：helper封闭`act_fixture`（仅自有fixture、press/set_value、canonical JSON、值≤1024且不回显）；同一exact重验元素、dispatch前最后identity/元素复检、单次AXPress/AXValue、无重试/键盘/pointer/activation；spawn后任何失败报EXECUTION_UNKNOWN。Swift API边界桩10例（dispatch计数）+transport拒绝12例Red/Green。
- [ ] CU-012a2：真实fixture native lane `pnpm run test:native-action`（独立state文件核验set_value+press各一次、stale/替换拒绝无副作用）。2026-11-09实跑exit3/NOT_RUN（缺AX权限），不算完成。
- [ ] CU-012a3：host组合（lease/approval/queue/ledger dispatch_pending→act_fixture→receipt）与模型工具，在CU-015。
- 范围：AXPress、set_value；type_text 必须有 targetHandle。受限 keyboard route 默认关闭，具能力才开启；first-key 前再次核对焦点。
- 接口/产物：每次 native 输入前重验，down/up 成对，禁止 AX 成功后自动再键盘重试；background 不 activation。
- 非目标：不提供 free-focus typing、任意 shortcut 或坐标 fallback。
- 验证：UNIT、NATIVE；A-05、A-07、A-10（真实输入无重叠）、A-19（受管键释放）、A-16（语义部分）。此处补 CU-010 延后的 native 集成断言；失败则不开放工具。
- 拆分规则：先 CU-012a 语义动作，再 CU-012b 键盘；后者失败不影响前者诚实报告 unsupported。

### CU-013 · 实现证据回读与阶段准确回执

- Priority: P0。Depends: CU-012。Status: in_progress（只做保守host回执，不读写native）。
- [x] CU-013a：Depends CU-003/CU-010a/CU-011a，host内部exact ticket/阶段单调迁移、closed failure到保守receipt、dispatch后unknown不回退not_executed；无证据时永不verified，单元+真实账本seam已验，不等于native事实认证。见 [阶段回执](<../../design-docs/action-receipts.md>)。
- [x] CU-013a2：Depends CU-008b1a/CU-010a2/CU-013a，controlruntime私有固定策略评估→保守终态回执已验，真实decision/排队取消与scope/policy/stop/unload先封存；workStarted不等于input、无ACK/target/dispatch入口。所有execution=not_executed，typedcapacity与policy目标unknown，不接ledger/native/evidence，不替代013b。见 [固定评估回执](<../../design-docs/action-receipts.md>)。
- [ ] CU-013b：Depends CU-006c/CU-007b/CU-012/CU-013a，可信回读evidence生命周期、target exact效果/任务verifier及native/transport前后失败组合验收；前序未过不开放工具。
- 范围：execution/target/effect/taskOutcome、回读预算、wait 条件、新观察失败与 native timeout 分阶段处理。
- 接口/产物：字段 readback 可验证，结构变化不能当任务因果证明，unknown 不自动重试。
- 验证：UNIT、NATIVE、TRANSPORT；A-12、A-13、A-27。inert action 与外部树变化均覆盖。

### CU-014 · 实现截图与隐私 artifact 生命周期

- Priority: P0。Depends: CU-006、CU-011。Status: in_progress（只做内存暂存，不采集/落盘）。
- [x] CU-014a：Depends CU-003/CU-007a/CU-008a2/CU-013a，默认拒绝的host-only ephemeral bytes store已验；exact scope/单次ticket/逐次授权/mono TTL与timer/容量reservation及撤销覆盖自有副本。无ScreenshotRef/URL/文件或verified证据，只有公开测试字节。见 [内存切片](<../../design-docs/ephemeral-artifacts.md>)。
- [x] CU-014a2：Depends CU-007b2a/CU-008a2/CU-014a，内存artifact私有接入read runtime、观察target来源/成员+read grant/独立host策略逐次复检、Agent/Session/cwd/policy/unload清理已验；公开合成bytes、无capture/磁盘/模型工具，不能替代014b。见 [内部接线](<../../design-docs/ephemeral-artifacts.md>)。
- [ ] CU-014b：Depends CU-006c/CU-011/CU-014a，真实显式capture/像素coherence、受管磁盘artifact manifest与host访问授权/日志隐私/崩溃清理；native前序未过不开放截图。
- 范围：显式 screenshot 请求、capture coherence、pixel transform、受管 artifact、访问鉴权、日志脱敏、留存与崩溃清理。
- 接口/产物：截图默认 none；Session 结束/TTL 清理只作用于 manifest 管理文件；不宣称像素通用脱敏。
- 验证：UNIT、NATIVE、PROFILE；A-15、A-21、A-22、A-23。

### CU-015 · 接通第一条 fixture 纵向闭环

- Priority: P0。Depends: CU-013、CU-014。Status: in_progress（代码闭环完成，native lane缺AX未运行）。
- [x] CU-015a：[FixtureComputerUse](<../../../src/service/fixture-computer-use.ts>) 组合：exact host bind→静态自有fixture read grant→观察→每动作host-static lease/风险→需要时真实DSH approval（never/unavailable拒绝）→per-user controller槽→durable ledger dispatch_pending→helper最后重验+单次dispatch→保守receipt→ledger terminal；不重试，unknown保留。12项注入seam单元（Red缺模块→Green）。
- [x] CU-015b：插件Config `fixtureControl`（默认false，unknown key拒绝）开启后才注册cu_observe/cu_act/cu_stop；无pid/bundle/script/risk/approved参数。6项真实Cordis/ToolsService profile测试。`showFixture`默认true以`--host-visible`显示fixture（accessory、不激活）。
- [ ] CU-015c：`pnpm run test:native-e2e` 真实helper+controller(owned临时namespace)+fixture：set_value/press由fixture state独立核验、approval不可用拒绝、replace后stale拒绝、独立stop后阻断。2026-11-09 exit3/NOT_RUN（缺AX）。
- 范围：host 工具 → TaskLease → observe → press/set_value → readback receipt → release；注册 gated exposure 与 dispose。先验证 CU-010 的独立最小停止入口，再开放变更工具。
- 接口/产物：一个最小可用切片；只向 fixture allowlist 暴露控制，不对任意 app 自动放开。CU-016 完成前只允许测试专用 fixture 的语义动作；键盘变更保持关闭，不宣称可与用户并行操作。
- 验证：BUILD、UNIT、TRANSPORT、NATIVE、PROFILE；A-01、A-05、A-10（工具层并发输入）、A-12、A-19（独立最小停止）、A-20。A-10/19 的真实输入集成门槛在本卡关闭前必须有非空洞证据。
- 退出门槛：必须看到真实 fixture 状态变化和负向无副作用，不能只通过 fake backend。

### CU-016 · 实现用户让权、可见状态与紧急停止

- Priority: P0。Depends: CU-015。Status: pending。
- [ ] 完成并留证。
- 范围：最小 Settings/状态 UI、控制目标/mode/phase、暂停/停止、用户输入冲突策略、监测缺失时能力关闭。
- 接口/产物：停止不靠模型工具；UI RPC 鉴权；不记录实际键内容；停止延迟实测。
- 验证：NATIVE、PROFILE、UI；A-16、A-18、A-19。实际 GUI 验证必须使用既有 DSH URL，不以替代服务器冒充。

### CU-017 · 实现显式 takeover 模式

- Priority: P0。Depends: CU-016、CU-009。Status: pending。
- [ ] 完成并留证。
- 范围：模式升级审批、明确 activation、重新观察、撤销、结束归还控制；background 绝不静默升级。
- 接口/产物：takeover 不等于允许全局 pointer 或任意 app；approved scope 改变须重批。
- 验证：UNIT、NATIVE、PROFILE；A-17、A-19。

### CU-018 · 编写 Skill、工具描述与恢复指导

- Priority: P0。Depends: CU-015、CU-017。Status: pending。
- [ ] 完成并留证。
- 范围：模型无关工具、优先专用接口、先观察、结果不确定停止、禁止 UI 提示当授权、禁止脚本路线绕开。
- 接口/产物：简短 progressive exposure；名称不与已装 computer-use 冲突；错误给出安全下一步。
- 验证：UNIT、PROFILE；A-29 静态部分。MODEL 在 CU-026，不提前声称模型兼容。

### CU-019 · 实现单个保存测试副本的任务 verifier

- Priority: P0。Depends: CU-013、CU-018。Status: pending。
- [ ] 完成并留证。
- 范围：一个已批准测试文档的保存副本流程；借助权限内权威文件/应用记录核验，不从弹窗消失推断成功。
- 接口/产物：通用 receipt 之外的显式 verifier；无文件权限时 taskOutcome=unverified。
- 非目标：不添加绕过宿主文件沙箱的原生文件读写后门。
- 验证：UNIT、REAL-APP；A-27、A-32。未批准真实 app 时只用 fixture 保存副本。

### CU-020 · 建立真实应用兼容矩阵与基准

- Priority: P0。Depends: CU-018、CU-019、CU-024、CU-025。Status: pending。
- [ ] 完成并留证。
- 范围：2 个用户批准的应用/版本/测试副本；前台/后台/富文本差异；失败、unsupported 和 skip 分母。
- 接口/产物：可重跑场景与 evidence；不将一个 fixture 成功推广为所有 app 支持。
- 验证：NATIVE、REAL-APP；A-31、A-32；按验收矩阵重复次数与零容忍门槛。

### CU-021 · 接入可替换的视觉定位适配器

- Priority: P1。Depends: CU-014、CU-018。Status: pending。
- [ ] 完成并留证。
- 范围：截图 artifact → 可选 vision provider → 有来源/版本/不确定性的候选坐标；无 provider 时明确 unavailable。
- 接口/产物：观察版本/坐标变换绑定；不把模型 confidence 当身份认证；不训练新模型。
- 验证：UNIT、NATIVE；A-15、A-25。用可控 fixture 图像与错误 scale/陈旧图像。

### CU-022 · 定向 pointer 能力门槛与单击

- Priority: P1。Depends: CU-021、CU-010、CU-016。Status: pending。
- [ ] 完成并留证。
- 范围：目标 pid/window pointer、动态 SPI 能力检测、窗口局部点、一组 down/up；默认不开启能力。
- 接口/产物：无系统光标 warp、无全局 pointer post、无隐式 activation；SPI 缺失/目标不可见时拒绝。
- 验证：STATIC、NATIVE；A-24、A-25；独立监测系统指针与前台，源/二进制 route 检查。
- 停止：只能通过全局输入才能运行；禁止把全局输入当兼容 fallback。

### CU-023 · 增加有界 scroll 与 drag

- Priority: P1。Depends: CU-022。Status: pending。
- [ ] 完成并留证。
- 范围：同窗口有界 scroll/drag、duration/距离上限、cancel/窗口变化中断、安全释放。
- 接口/产物：每 gesture 一组 down/up；保持目标绑定；部分效果明确报告 unknown。
- 验证：NATIVE、UNIT；A-19、A-26。性能动画非本卡目标。

### CU-024 · 验证原生产物、供应链与包布局

- Priority: P0。Depends: CU-015。Status: in_progress（仅本地helper一致性子卡；签名/分发仍pending）。
- [x] CU-024a：Depends CU-002/CU-005/CU-007b1，本地开发helper manifest/source+recipe/binary/Mach-O一致性、bounded file/路径检查与每次read transport启动前gate已验；不依赖输入能力，不替代签名/真实AX验收。见 [本地gate](<../../design-docs/helper-artifacts.md>)。
- [ ] CU-024b：Depends CU-015/CU-024a，fixture/stop与分发完整包布局、签名/许可/供应链身份及安装产物验收；不得自动安装/发布。
- 范围：helper manifest、source digest、binary hash、架构/deployment target/签名、协议版本、包文件与 MIT 来源。
- 接口/产物：构建源码变化强制重编；无可用签名身份时诚实记录，不假称 notarized。
- 验证：BUILD、TRANSPORT、PACKAGE；A-03、A-14、A-30。分发策略未定则只做开发包，不发布。

### CU-025 · 验证干净 Profile 与生命周期

- Priority: P0。Depends: CU-018、CU-024。Status: pending。
- [ ] 完成并留证。
- 范围：临时 Web/Headless Profile、启停/重载、Session dispose、非 macOS、approval=never、artifact 恢复清理。
- 接口/产物：不污染用户默认 Profile，不重放控制任务；read/control/token/lock 生命周期有证据。
- 验证：PROFILE、NATIVE；A-01、A-20、A-23。缺 host capability 明确不兼容，不吞错。

### CU-026 · 执行模型 smoke 与结果理解验收

- Priority: P0。Depends: CU-018、CU-025。Status: pending。
- [ ] 完成并留证。
- 范围：至少两个 DSH 普通工具调用模型，固定 fixture 任务、步数/费用预算；加入 unknown 回执场景。
- 接口/产物：模型不走脚本、正确读取证据、不把 attempted 当业务完成；报告工具 trace 与模型版本。
- 验证：MODEL；A-29、A-33。无凭据/授权则记 not_run，不请求在聊天粘贴密钥。

### CU-027 · 独立安全与正确性审查

- Priority: P0。Depends: CU-020、CU-025、CU-026。Status: pending。
- [ ] 完成并留证。
- 范围：新上下文 reviewer 复核 schema/授权顺序/风险降级/重放/隐私/native 边界/README 声明。
- 接口/产物：分严重度 findings、修复卡、重测证据；确认发布前安全报告渠道。
- 验证：相关 UNIT/TRANSPORT/NATIVE/PROFILE 回归；A-28，及所有已完成 P0 断言。
- 停止：错对象、越权、重放、日志机密或无法安全停止未解决。无 findings 不等于安全认证。

### CU-028 · 打包 Alpha 与发布门槛报告

- Priority: P0。Depends: CU-027。Status: pending。
- [ ] 完成并留证。
- 范围：完整 build/test/package/docs、新鲜证据、支持矩阵、已知限制、安装/卸载/清理说明、默认关闭未验收能力。
- 接口/产物：本地可复核 artifact、版本/commit/digest、发布 go/no-go 报告。没有单独授权不得安装/推送/发布。
- 验证：TYPE、BUILD、UNIT、TRANSPORT、NATIVE、PROFILE、PACKAGE、DOCS；MODEL 引用相同 commit 的真实记录；A-34。
- 完成条件：安全发布门槛全部通过或明确 no-go，不能把 no-go 写成插件完成。

## 4. 依赖与并行规则

默认一个 Agent 串行执行。只在接口冻结且写集不重叠时并行。

- CU-003 后：fixture 与合同 pure-test 细分可并行，但合同变更由一个 owner 统一。
- CU-008 后：CU-009 与 CU-010 可并行，先固定消费/dispatch 接口，service 组合由后续 CU-011 负责。
- CU-013 后：隐私/截图和模型文案可在不共享 service 文件时准备，但 CU-018 的完成仍依赖 CU-017。
- CU-018 后：CU-019 与 CU-024 可以并行。
- P1 不与 P0 共改 native main/service 入口。需要变更公共 schema 时先串行完成合同卡。

禁止让多个 Agent 同时重写 service、policy schema、native dispatcher 或 package manifest。并行子 Agent 不能自行发布或修改用户 Profile。

## 5. 完成规则

每张卡的完成记录必须含：任务 ID、范围变化、实际代码 commit 或 diff、测试红/绿记录、命令/退出码、测试 ID、skip 与能力限制、风险及下一卡。

每个已完成任务都要有可定位证据。不以计划 checker、类型通过、mock 通过或模型口头成功替代 native/真实业务验收。

“实现完成”和“用户同意发布”分别记录。计划进入 completed 目录需要目标仓库内全部 P0 退出条件成立，并得到当前任务所需的执行授权。P1 可另建活跃计划，不隐式宣称已实现。

## Progress log

- 2026-11-08（规划阶段）：编制文档包，当时没有目标仓库、实现或插件测试。
- 2026-11-08（开工）：用户指定 SiyuQian/dsh-computer-use。远端为空，本地建立空 root/worktree，迁入计划；不推送。
- 2026-11-08（foundation）：CU-000–003 基础切片已实现并红/绿验证。私有数据 no-go，状态工具无原生控制。实际版本、独立审查修复与准确检查范围见 [验证记录](<../../verification/foundation.md>)。
- 2026-11-08（CU-004）：自有 AppKit fixture 已构建并隐藏自测。审查修正 reset 排列、双窗口 state 污染、延迟任务 reset ABA，补失败测试后通过。
- 2026-11-08（CU-005）：health-only Swift helper 与真实 DSH subprocess transport 已验证。独立审查发现 done 不 settle 时 deadline 无法进入 cleanup，新增失败测试后改为 stop/done race 与 bounded cleanup；上游异常固定脱敏。
- 2026-11-08（CU-006部分）：精确fixture-only reader/投影及身份/权限拒绝已运行。独立审查修复secure元数据fail-open与synthetic window identity。显式native lane因accessibility=false退出3/NOT_RUN，不请求权限，保留in_progress。
- 2026-11-08（CU-007a）：纯host生命周期切片单元完成，真实Agent/Session lifetime token、single-use read ticket、monotonic TTL从读前起算、投影后复检deadline、内存容量和拷贝隔离。独立审查复跑32/32+tsc，未发现新阻断项；全量134/134。
- 2026-11-08（CU-008a）：host-only默认拒绝fixture读grant和read service已完成单元切片；独立审查两项（policy同步abort重入、投影中grant截止点发布）均新增Red修复并复验。无用户consent/UI/生产事件接线，不签发control，详见验证记录。
- 2026-11-08（CU-008b1/009a）：inert fixture控制租约/独立风险与单次HMAC批准绑定、默认禁用公开SDK adapter已单元实现。独立审查发现并Red/Green修复prune同步重入重签、idle signal未主动到期、批准计算后TTL越界；另补stale turn、挂起答复取消、read grant同型epoch。所有结果不可dispatch，测试模拟批准不是用户同意。
- 2026-11-08（CU-010a/b1）：host有界FIFO/claim与stop-drain单元内核、真实Darwin flock原语已实现；32项新定向测试，临时目录真实进程竞争/崩溃/exec与fd故障。独立审查修复取消context不能release和Swift fully-initialized throw双close。生产broker/独立stop通道未完成，不能开放输入。
- 2026-11-08（CU-010b2a）：自有namespace真实UDS stop-only/同UID与私有继承能力鉴权、sticky撤销/ACK非drain、第三进程停止且锁保持至惰性drain已验。24项新增tests，独立审查修复expired slots先accept误拒合法stop；parent补duplicate JSON/namespace guard负测。生产namespace/用户入口未完成。
- 2026-11-08（CU-011a）：host签名短期actionId/私有HMAC绑定、fresh append-only/fsync pending与closed terminal、只读崩溃恢复已实现；50项新disk/并发/kill/FileHandle fault测试。独立review修复terminal settlement被expiry/cancel阻止、close首handle错误跳过另handle及原始异常泄漏；parent另补unknown effect/cancelled signal/有界queued等Red-Green。不接native/live批准，CU-011父卡仍in_progress。
- 2026-11-08（CU-010b2b1）：固定euid路径策略、safe leaf/FD witness、锁内原子发布stop-only发现记录、本地CUStop源码/构建已验；50项新namespace/CLI tests，在owned parent跨进程/崩溃/IO fault，未创建/stop production namespace。独立review的path reopen foreign FD删除marker已Red复现，改captured FD dup后Green。b2b2生产启动/可达性/安装生命周期保留。
- 2026-11-08（CU-013a）：host exact票据/阶段单调、可能派发unknown、ACK执行事实保留、closed failure/不可变终态已验；新增37状态机+3真实ledger seam+2schema负测。unknown execution不能配no_change/unverified。独立review复跑36tests无高信当前finding；parent最终429全量。无native/evidence/verifier认证，013b保留。
- 2026-11-09（CU-007b1）：fixture AXHelp element生命周期witness（replace新/reorder保留）、read-only revalidate_fixture合同/client/Swift bounded complete scanner已实现；53项新policy/adapter/transport/public投影负测，hidden fixture self-test扩充。独立审查两项AX fail-closed错误（identifier吞错/0child不复查）父Red/Green，另补window枚举同型漏洞；新命令canonical拒dupe。全量482/28files，显式native lane exit3/NOT_RUN不请求权限，b2保持未完成。
- 2026-11-09（CU-007b2a）：同次strict projection原子private handle→fixture witness映射与default-deny read-revalidation service已接；closed public request/result不可dispatch，backend clone不改expected，original signal/grant/mono TTL/fresh membership跨await/parse后复检。新增32候选+47service单元及1真实helper拒绝seam，独立review复现末次lookup撤销仍exact，父Red/Green修复；parent另修commit gate TTL/invalidate/末次scope重入。最终全量562tests/31files和build/typecheck/boundary/package exit0；AX显式lane仍exit3/NOT_RUN，b2b保持未运行。
- 2026-11-09（CU-024a）：本地read helper每次启动前验证fixed source+recipe/closed manifest/binary摘要、bounded FD/no symlink-hardlink/mode witness与thin64Mach-O/currentarch/macOS14；编译前后digest比较防正常source/recipe编辑造成混代manifest。51new artifact/build tests，mono截止点跨file/spawn/done/parse复检，parent Red/Green含探针编码纠错；全量613tests/33files。非publisher认证/原子path-exec/同UID隔离，024b不完成；AX lane仍exit3/NOT_RUN。
- 2026-11-09（CU-008a2）：内部read runtime private组合/generation、每次actual host重绑、scope批量撤销、公开Agent/Session/cwd事件和复合fiber卸载已验；34unit+6真Cordis/SessionStore+2managed transport seam+2authority新增，whole657tests/36files。独立审查复现同ID无事件替换旧scope占容量/旧signal不abort，父Red修复扫描退休；另补postbind getter/epoch/liveness Red/Green。入口仍只cu_status，不安装runtime、不签consent、不claimdrain，AX exit3/NOT_RUN。
- 2026-11-09（CU-014a）：默认关闭的内存artifact bytes store实现逐stage/publish/read同步授权、scope/one-use ticket、pending reservation+records有界容量、TTL+timer/撤销清零自有copy与错误脱敏；不capture/落盘/生成ScreenshotRef或evidence。60unit+3真实authority seam，独立review确认async拒绝rejection逃逸P2，父child Red/Green三阶段修复；最终720tests/38files、build/tsc/boundary/package exit0，AX仍exit3/NOT_RUN。
- 2026-11-09（CU-014a2）：私有artifact service接read runtime/公开Session事件；观察target一次parse同值投影/private保存，逐stage/publish/read需live观察target/grant+独立policy前后复检，先清ownedbytes再grantabort。新增33runtime+4真实profile+3target tests，共40项，全量760tests/39files；独立review7reads+105tests/tsc无新增高信P1/P2，父补4getter异常Red/Green与child async/abort前实际清零。无native/capture/落盘/入口激活，AX exit3/NOT_RUN。
- 2026-11-09（CU-008b1a）：从read提取共享exact HostScopeRegistry/eventadapter，私有inert控制policy接Agent/Session/cwd/policy/unload；scope批量先删timer/records再abort，issue/eval/signal前后复绑定、read/control不互授权。新增31controlruntime+6profile+1scoperevoke+1readfinalturn共39tests。父两requestgetter泄漏和read/control finalcwd闭turn Red/Green；首全量取消test错误假设100ms必spawn，改真实childready才abort后最终799tests/41files。独立review8reads+139tests/tsc无新增高信finding，非父后续修复背书；AXexit3/NOT_RUN，不开放native/工具。
- 2026-11-09（CU-009a2）：private HMACapproval接live inert租约/risk/版本，三阶段pinnedscope/epoch/turn与caller+leasesignal，boundhost答复、先清批准再leaseabort；obs/material/action引用仍host声明不认证native/read/幂等。42runtime+5profile+10kernel新增共57，全量856tests/42files；独立review7有效reads+115tests/tsc、唯一probe确认kernel exactdiscard不取消脱Mapconsume，父Red改consuming留Map/membership/finally清理，121targetGreen。无真实prompt/队列/执行器，AXexit3/NOT_RUN。
- 2026-11-09（CU-010a2）：private livelease-derived完整targetclaim/固定policy评估FIFO接controlruntime，scope批量clear/pendingcancel先于active/leaseabort，active位到settle，hoststopVersion全撤+drained才resume。无callerwork/native/approvalconsume/charge/ledger；33runtime+4queue+1policy+4profile共42新增，898tests/43files。父Red/Green含targetparse-stop/cleanupgetter、最后clockturn/cwdleaseexpiry、executiongetterstop和立即resume。独立7有效reads无保留finding，旧97/98test1fail是容量microtask假设已修，probe在current二次gate拒绝stopgetter，未独立复验最后版本；AXexit3/NOT_RUN。
- 2026-11-09（CU-007a2）：private观察action-intent接readruntime，live成员/privatewitness+readgrant派生target/material，HMAC/单次exactobjectticket，不存输入，42runtime+4profile+1store新增47，全量945tests/44files。父Red修parse前年龄/最后clockturn与继承deadline；独立7reads/112tests中111pass+已知finalobsdeadline1fail、tsc0，父min(own,obs,grant)原mono夹限后fresh130/103/56target及945wholeGreen，独立未复验修后/无probe。不接controllease/approval/native，AXexit3/NOT_RUN。
- 2026-11-09（CU-013a2）：private固定policy/queue结果自动生成not_executed终态，scope/policy/stop/unload先seal后abort、latefirstterminal，64tombstone不复活，无runtimeACK/target/dispatch口；27runtime+5kernel+4profile新增36，全量981tests/45files。父Red修capacity混报DENIED→私有typedfailure/CONTROLBUSY；独立设计静态指出policytargetinvalid过度声明，父Red限revalidate后Green。代码review7reads/115tests+tsc0无新增finding/noProbe；AXexit3/NOT_RUN，不接ledger/native/evidence。
- 2026-11-09（CU-002c）：固定process.execPath/argv/cwd的8step开发验证器，strictVitest分母/限定源码前后digest含untracked+HEAD/dirty、固定NO_GO，失败后剩余not_run，native只显式opt-in/固定缺权限exit3。26report+11snapshot+5copiedrunner新增42tests；父实际runner1023tests/48files、8steps0、133sourcefiles/digestsame/dirtytrue，nativeNOT_RUN整体3。独立code7reads/42tests+tsc0无finding/noProbe；不是release/完整依赖/签名/MVP。恢复入口见 [交接](<../current-handoff.md>)。
- 2026-11-09（PR授权）：用户请求创建 PR，获准提交/推送现有foundation开发分支；远端仍空，main仅以既有空root作PR基线。创建Draft供审查，不自动合并、发布或安装，不把PR当MVP完成。历史untracked/未push记录保留其运行时间语境，当前Git/远端状态需实时核对。
- 2026-11-09 17:50（新授权）：用户授权仅fixture语义动作AXPress/set_value的实现与native实测、终点CU-015/016 fixture闭环、每切片新分支commit/push/Draft PR；TCC由用户手动授予DeepSeek Harness.app。当时实跑test:native-observation仍exit3/NOT_RUN，verify-foundation 1023tests/48files 8steps0。键盘/pointer/真实应用/安装/发布/合并仍未授权。
- 2026-11-09（CU-012a1）：helper act_fixture语义动作与TS act客户端；health capability mutation=fixture_semantic_only。Red（缺FixtureAction.swift编译失败）→Green；全量1048tests/50files、typecheck/invariants/package exit0。test:native-action exit3/NOT_RUN（缺AX）。
- 2026-11-09（CU-010b2b2a）：per-user CUController+TS client，单槽/busy/独立stop/sticky撤销真实进程验证；build:stop同步构建controller。全量1053tests/51files（一次负载下helper-artifact cancel_after_parse偶发失败，单跑3/3、全量2/2通过，记为flaky观察）。
- 2026-11-09（CU-015a/b）：纵向组合服务+opt-in模型工具；修复helper-artifact探针真实50ms timer与伪mono时钟竞态的flaky（改2000ms，原断言不变），全量3次1071/1071。native-e2e exit3/NOT_RUN。
- 下一步：CU-006c/CU-007b2b真实AX成功仍缺权限，不以fake identity替代AX验收。可拆host-only来源票与inert控制复检或完成开发基线/验收交接，但不提供native executor/真实consent或dispatch许可；CU-008b2/CU-009b/CU-010b2b2/c/CU-011b/CU-013b/CU-014b/CU-024b native/live/磁盘/分发gate保留。real-app、model与Web UI未运行。

## Decision log

- 2026-11-08：用户同意产品定位。先做可信语义闭环，不把后台鼠标当唯一差异化。
- 2026-11-08：本计划建议 TypeScript + Swift、15 秒观察 TTL、单动作、单窗口与 P1 pointer。技术默认值尚待 CU-000/001 冻结。
- 2026-11-08：在没有目标仓库时，仅交付计划，不创建实现或远端项目。

## Open questions

1. 已解决：目标为用户指定的 SiyuQian/dsh-computer-use，本地隔离工作树记录于实施基线。
2. 已执行：基础独立实现，未复制参考源码；后续复用另记许可。
3. 开发包 @siyuqian/dsh-computer-use，private，SDK 0.2.2-rc.1。正式发布身份未定。
4. 本机 Swift/macOS 可构建；本插件 TCC、最低 OS、签名/发布身份仍未验收。
5. 首批真实应用/低风险任务仍未指定，目前只限自有 fixture 和公开测试数据。

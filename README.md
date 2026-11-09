# DSH Computer Use

一个 macOS 起步、模型无关的 DeepSeek Harness 插件。目标是：语义目标优先、执行前重验、默认后台协作、受控授权、证据回执、用户随时停止。

**开发状态：fixture-only。** 默认只注册 `cu_status`。在插件配置中显式设置 `fixtureControl: true` 后，才额外注册 `cu_observe`、`cu_act`、`cu_stop`，且只能操作本插件自带的 AppKit 测试应用（公开测试数据）；没有键盘、鼠标坐标、真实应用或私人数据能力。

### 启用（fixture）

1. 先构建：`pnpm run build && pnpm run build:fixture && pnpm run build:helper && pnpm run build:stop`。
2. 在 系统设置 → 隐私与安全性 → 辅助功能 中**手动**允许 DeepSeek Harness（插件不会请求或绕过权限）。
3. 插件配置 `{ "fixtureControl": true }`；`showFixture` 默认 true 会显示测试窗口但不抢焦点。
4. 模型流程：`cu_observe` → `cu_act`（press 或 set_value）→ 读取 receipt；`execution: unknown` 时不要重试，先重新观察。
5. 停止：模型 `cu_stop`，或独立于模型运行 `dist/native/CUController --stop`（sticky，重载插件前不恢复）。
6. 真机验收：`pnpm run test:native-e2e`（缺权限 exit 3 / NOT_RUN）。

## 已有实现

- 版本锁定的 TypeScript/DSH 开发包。
- 严格请求、观察、任务授权与结果 schema。校验 schema 不等于签发权限。
- 基于宿主实际 Agent/Session 注册对象、开放 turn、当前工作目录的上下文绑定。
- 独立内存 Cordis 容器中的注册、卸载、冲突与取消测试。
- 合同模块依赖检查和构建入口smoke。
- host-only观察TTL/scope store与默认拒绝的fixture读grant/service；新增内部 [read runtime](<docs/design-docs/read-runtime.md>) 的Agent/Session/cwd事件撤销、复合卸载与managed取消验证。opt-in不在入口安装，不签发consent/控制许可、不开放工具。另有host-only观察派生action-intent：live成员/privatewitness+readgrant取target/material、HMAC单次票与继承TTL，**只返回candidate、不授予control**。详见 [生命周期](<docs/design-docs/observation-lifecycle.md>)、[读取授权](<docs/design-docs/read-authorization.md>)。
- host-only fixture控制租约/独立风险下限，以及HMAC单次批准绑定；所有结果不可dispatch，SDK adapter默认disabled，未发真实批准。新增内部 [inert控制runtime](<docs/design-docs/control-runtime.md>) 复用scope/公开事件adapter、私有独立policy逐call重绑与撤销，并私有接live inert租约/风险复检的HMAC批准服务；只有模拟host答复，不接执行/真实prompt/native或生产入口。详见 [控制策略](<docs/design-docs/control-authorization.md>)、[单次批准](<docs/design-docs/single-use-approval.md>)。
- host-only有界串行队列、target claim与stop/drain屏障；新增内部live inert租约claim/固定policy评估生命周期，scope批量撤销、host stop全撤与drained后freshlease/claim，**无caller执行闭包/native输入**；真实Darwin flock原语已在自有临时目录跨进程验证。独立stop-only通道已在临时namespace用第三进程验证，已增加固定euid路径策略/私有stop发现记录与本地CLI构建，但未部署生产broker/用户入口；不开放输入。见 [协调切片](<docs/design-docs/host-coordination.md>)、[停止通道](<docs/design-docs/independent-stop.md>)、[固定路径与CLI](<docs/design-docs/control-namespace.md>)。
- host-only签名短期actionId、私有HMAC proposal与append/fsync账本；pending崩溃只读恢复unknown、旧id不重放，所有结果不可dispatch。仅临时目录disk/kill/fault验收，非生产exactly-once。见 [账本切片](<docs/design-docs/action-ledger.md>)。
- host-only保守回执内核：区分未派发/可能派发/ACK事实，取消或回读失败不抹掉已执行事实，未有证据不报verified。新增内部固定policy/queue结果→not_executed终态接线，scope/stop/unload先seal后abort，迟到结果不改首terminal；无runtime ACK/target/dispatch入口，不认证native事实、ledger或业务。见 [阶段回执](<docs/design-docs/action-receipts.md>)。
- 默认关闭的host-only [内存artifact暂存](<docs/design-docs/ephemeral-artifacts.md>)：逐stage/publish/read授权、exact scope、单次ticket、字节容量/TTL、撤销覆盖自有副本；已内部接read runtime的live观察target/readgrant+独立policy和Session/Agent/cwd/unload清理；仅公开合成字节，无capture/磁盘/URL/截图或verified声明，不在生产入口激活。
- 自有AppKit fixture与只读helper：health preflight、严格fixture身份与AX reader/安全投影。拒绝路径与真实AX成功路径均已在自有fixture验证（TCC由用户手动授予）。另有控件生命周期标记与只读revalidate协议，内部私有handle映射/受read grant约束的重验service，公开exact不可执行。模型动作只经 `fixtureControl` 下的 `cu_act`，见上文启用说明与 [架构](<ARCHITECTURE.md>)。详见 [通信设计](<docs/design-docs/native-transport.md>)、[观察边界](<docs/design-docs/fixture-observation.md>)、[重验切片](<docs/design-docs/fixture-revalidation.md>)。

本地helper每次read启动前还会核对固定源码/构建脚本、manifest、binary摘要和Mach-O；陈旧/不一致返回ARTIFACT_INVALID，须明确重建，不自动修复。仅开发一致性，不是签名或发布认证，见 [产物gate](<docs/design-docs/helper-artifacts.md>)。

源码入口见 [src/index.ts](<src/index.ts>)。实际拓扑与安全不变量见 [架构](<ARCHITECTURE.md>)。

## 本地开发

要求 Node 24+、pnpm 11.28.5。当前 SDK 基线为 DSH **0.2.2-rc.1**，不自动扩大支持版本。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run build:fixture  # macOS，自有测试应用，不启动窗口
pnpm run build:helper   # macOS，只读fixture helper；构建不读UI/不输入
pnpm run build:stop     # macOS，仅编译本地stop客户端，不启动/停止生产controller
pnpm run typecheck
pnpm run test
pnpm run check:invariants
pnpm run check:package
```

测试包含构建产物入口smoke，所以先build。默认suite只验证hidden fixture/拒绝路径，不等于AX成功。真实AX lane为`pnpm run test:native-observation`、`test:native-action`、`test:native-e2e`：权限缺失exit3/NOT_RUN，不弹权限、不静默skip。这里只运行本地开发检查，不安装到用户Profile。

若使用宿主返回的受签名 Node，macOS Library Validation 可能拒绝 npm native bundler。不要改签名或关闭系统保护。使用本包已固定的官方 WASM bundler：

```sh
NAPI_RS_WASI_FLAVOR=wasm32-wasi pnpm run test
```

WASI 会发出 experimental warning。实测环境与准确命令见 [基础验证记录](<docs/verification/foundation.md>)。

需要可重复、机器可读的开发基线证据时，使用固定入口（不执行manifest中的自由命令字符串）：

```sh
node scripts/verify-foundation.mjs
# 只有明确要运行自有fixture只读AX lane时才加；缺权限exit3/NOT_RUN，不请求TCC：
node scripts/verify-foundation.mjs --native-observation
```

也提供`pnpm run verify:foundation`快捷入口。默认仅固定8步build/native编译/typecheck/完整tests/边界/package检查，JSON写stdout、进度写stderr；包含实际退出码、test分母、源码前后指纹（包括untracked）和HEAD/dirty。默认exit0只是本地foundation通过，**所有报告仍NO_GO/nativeControl=false/privateData=false**；首次失败后剩余not_run，不拿旧产物凑绿。显式native缺AX时整体exit3，即使基础suite通过。不是完整依赖闭包、publisher签名、原子snapshot、输入安全或MVP验收；文档checker/真实Profile/UI/model/real-app另验。准确范围、失败码与留存方式见 [固定验证器](<docs/design-docs/foundation-verification.md>)。

## 隐私边界

当前宿主会在工具参数校验前，把收到的原始参数写入 Session。因此插件不能承诺清除错误调用里的机密文本。

- 不向工具传私人文本、账号、密码或凭据。
- 当前版本不请求或产生真实私人 UI 数据。
- 真实私人数据模式为 no-go，直到有官方安全留存扩展点或明确披露后另行决策。
- 不通过修改官方 Session 审计来隐藏数据。

详见 [安全说明](<docs/SECURITY.md>) 和 [SDK 兼容调查](<docs/design-docs/sdk-compatibility.md>)。

## Agent 从哪里开始

1. 读 [AGENTS.md](<AGENTS.md>)。
2. 读 [实施基线](<docs/design-docs/implementation-baseline.md>) 和 [计划索引](<docs/PLANS.md>)。
3. 从 [总执行计划](<docs/exec-plans/active/2026-11-08-computer-use-mvp.md>) 选择依赖已满足的一张任务卡。
4. 使用 [运行与交接手册](<docs/exec-plans/AGENT_RUNBOOK.md>)，保留红/绿与未运行记录。

计划包含 29 张父任务卡与 34 个验收需求。单元测试数量不等于全部验收通过。未实现的原生、模型、真实应用和 GUI lane 均未验收。

## 第一条可用切片

自有 AppKit fixture → 限定授权 → 精确观察 → 目标句柄操作 → 输入前重验 → 独立回读 → 准确回执 → 用户停止。

视觉定位和拖拽属于后续 P1。真实发送、付款、不可逆删除、系统授权与私人账号不属于默认测试。

## 仓库与来源

用户指定仓库：[SiyuQian/dsh-computer-use](https://github.com/SiyuQian/dsh-computer-use)。当前从空仓库独立建立基础，没有复制参考插件实现，不声称 clean-room。参考资料与许可边界见 [设计索引](<docs/design-docs/index.md>)。

开发包为 private。2026-11-09 用户授权将现有 foundation 提交至开发分支并创建 Draft PR；main 仅用无文件的初始化提交建立审查基线，功能代码不直接进入 main。未授权合并、软件发布或日常 Profile 安装。开源许可证和发布身份尚未冻结，不能将源码 PR 当成已发布或可用的自动化产品。

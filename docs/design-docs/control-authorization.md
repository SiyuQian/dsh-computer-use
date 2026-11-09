# Fixture control authorization：CU-008b1 纯宿主策略内核

状态：2026-11-08，已实现inert控制租约与独立风险下限；单元验证，不是可执行Computer Use。native exact重验、独立停止、broker/action ledger和工具暴露仍未完成。CU-008父卡未完成。

## 已实现结构

[FixtureControlPolicy](<../../src/policy/control.ts>) 保存host配置的目标描述与lease状态；[TaskLease schema](<../../src/contracts/actions.ts>) 只校验公共形状，registry membership才决定该实例是否签发过。

issueFromHost仅可信host静态fixture配置可调用。它不自动获得用户同意，不以用户“开工”签发真实应用权限，不由模型工具调用。目标固定fixture app，精确pid/processStart/windowKey/windowId/windowInstance；caller作用域包含owner/generation/workspace/exact对象lifetime。

host传入的目标描述只有闭合字段：opaque handle、fixture identifier、role、enabled、secure、impact。模型不能提交或覆盖这些字段，未来必须来自已验证的backend descriptor/host风险判断；本切片使用测试数据，不声称已接真实AX元数据。

## 租约预算

- 只允许background，takeover拒绝；仅press/set_value的显式allowlist与最多64个target handle。
- 绝对TTL必须5000–600000ms、idle正数且最多600000ms、动作上限1–100；不提供无限任务。
- monotonic判定absolute与idle，wall时间只供展示。evaluate/get不会刷新idle；只有host chargeAttemptFromHost同步计一次attempt并刷新idle，不延长absolute TTL。
- timer取absolute/idle较早截止，charge后重排；到期无后续lookup也abort已有lease signal。
- charge不是native许可，不替代actionId ledger，不证明是否发生效果。未来coordinator必须在最终重验后、dispatch前按正确顺序调用，unknown不能因重新charge自动retry。
- 默认最多64活lease，可设1–256，满额CONTROL_CAPACITY。到期清理后可再签发新id。

## 风险下限

所有结果都带`dispatchable:false`和`requiresNativeRevalidation:true`，不能当执行授权。

1. 未签发/过期/不同scope、目标改变、operation/handle不在lease内：DENY。
2. secure flag或fixture.secure identifier、disabled、role/action不匹配：DENY。已知安全字段不能靠错误public flag降级。
3. host impact为high-impact或system-authorization：DENY，即使identifier看似普通submit。
4. 仅已审查fixture操作可ALLOW_WITHIN_LEASE：fixture.text的set_value；fixture.submit/replace/reorder/delayed/reset的press，且impact=ordinary。
5. fixture.save、未知identifier/impact、其它未分类效应：REQUIRE_APPROVAL；approvalMode=never时DENY/APPROVAL_UNAVAILABLE。
6. raiseRisk可将原本低风险提高为REQUIRE_APPROVAL，不能降低host floor。approvalMode是host适配所得状态，不可由模型参数控制。

没有把“按钮不含危险词”视为安全证据；没有通用DLP或任意真实app风险识别声明。

## 撤销与同步重入

policyChangedFromHost生成新policyVersion并增加revocationVersion，先删除全部旧records、清全部timer，再abort，防同步listener用第二旧lease重入。

issueFromHost在清理过期lease前捕获policy epoch，清理后及写入前复核epoch/disposed/cancel。旧lease abort listener若更换policy或dispose，不得让外层旧申请盖上新policy版本重新签发。read grant registry也补同型epoch守卫。

clock异常/回退清空并撤销；dispose不再发行。所有记录内存保存，返回结构拷贝隔离。

## 验证与尚缺

[control policy tests](<../../tests/unit/control-policy.test.ts>)：exact目标五维变化、host scope、operation/handle allowlist、secure/high-impact/unknown/never、预算阈值、idle timer、policy重入、容量/clock与拷贝隔离。测试不会调用原生或真实批准。

CU-008b1a新增内部opt-in [inert control runtime](<control-runtime.md>)，共享host scope registry/事件adapter但私有独立policy：逐call重绑/返回前epoch，公开Agent/Session/cwd撤销与卸载已验，scope租约批量删除timer后abort，不开放输入或真实consent。

尚缺：生产host配置/consent UI与完整AgentLoop接线；CU-007b native exact对象与唯一rebind；CU-009批准组合复核；CU-010独立停止/broker；CU-011b durable ledger与native事务组合（[011a host账本](<action-ledger.md>) 已验）。尚无任何native变更command，当前工具入口仍只有cu_status。

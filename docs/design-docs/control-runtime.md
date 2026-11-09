# Inert fixture control runtime：CU-008b1a 生命周期切片

状态：2026-11-09 Pacific/Auckland。只组合已验的host静态控制租约策略与宿主scope生命周期，不调用native、真实审批API、输入执行器、broker或账本；CU-010a2仅新增固定inert策略评估队列，不注册新工具，不在plugin入口安装。CU-008b2/native exact、用户consent/配置与CU-009b/010c等gate不降格。所有decision仍dispatchable=false、requiresNativeRevalidation=true。

## 私有授权与共享identity分层

[FixtureControlRuntime](<../../src/service/fixture-control-runtime.ts>) 私有持有一个 [FixtureControlPolicy](<../../src/policy/control.ts>)、CU-009a2的 [FixtureApprovalService](<../../src/service/fixture-approvals.ts>) 与一个 [HostScopeRegistry](<../../src/host-adapter/scope-registry.ts>)；不提供policy对象、native callback或execute方法。read runtime也使用同一registry实现，但**每实例有独立registry、generation、private authority**，共享代码不共享许可。read grant不能当control lease，control lease也不能当read grant；测试已覆盖backend不启动。

registry从已验的 [read runtime](<read-runtime.md>) 提取，而非维护第二套安全规则。它管理exact Agent/Session、当前cwd、随机generation、retired WeakSet、有界tracking、epoch/changing/disposed gate。每次call保存不可变agent/callId/originalsignal快照。bind前扫描原tracked对象在registry中仍live，先退休/清旧scope再判断capacity；默认64，可设1–256，满额按域READ_CAPACITY或CONTROL_CAPACITY，不驱逐活scope。闲置tracking不会因lease到期自动删除；它不是无限Session缓存。

bind核live注册对象、open turn、current cwd；cwd读取后再次核turnBoundary open/lastTurn、原signal和registry/epoch/retired，防同步cwd getter关闭turn但无event。它不是对恶意任意host getters的原子快照或同UID代码隔离；host服务仍属可信边界，不声称检测遗漏事件且无中间调用的cwd隐藏ABA。host源异常固定HOST_CONTEXT_UNAVAILABLE，scope特定错误码仍由域明确区分，不把READ_*变CONTROL_*。

## 内部API及返回前复核

- issueFromHost(exec, strictSpec)：仅host静态测试配置；target描述/风险来自可信host，不接受model签发。scope bind后记epoch，由policy严格parse并mint临时lease；取得lease signal后再requireCurrent重新bind+scope/epoch/originalsignal，失败revoke临时lease，不返回失管id。可用issue权不等于真实用户consent或当前native identity。
- evaluate(exec, rawRequest)：先closed parse一次（后续只用隔离DTO，不再读raw leaseId/target/action getter），actual bind，再policy计算独立risk floor。DENY直接保守返回；ALLOW/REQUIRE_APPROVAL需再次确认lease signal有效，最后requireCurrent，signal已abort则DENY。调用方不能添加approved或替换metadata。evaluate不charge预算、不刷新idle，不申请或消费批准，不排队或输入。
- signalForHost(exec, leaseId)：只取得lease撤销signal；policy lookup后必须最后重bind+epoch并检查signal未abort。它不是work许可、不是调度permit、不是drained或native stop证明。
- 原caller取消阻止该call，不自动撤销同scope以后call的租约；事件撤销则abort该scope全部lease。原signal被caller后续替换不改变已开始call快照。

strict parser隔离getter错误，固定INVALID_REQUEST，不透出target/input内容。policy输入和公开lease仍clone隔离。native descriptor来源、执行预算与actionId组合仍待CU-008b2/011b，不利用host测试metadata冒充真实AX目标。

## 撤销是一段封闭事务

registry将相关tracking全部移除，增加epoch并在cleanup全段持changing gate；callback不是gate外的异步通知。

- agent/disposed按exact Agent退休；session/disposed按exact Session退休；同ID伪对象不影响真对象。
- working-directory/change清exact Session scope；不信event.data.cwd、不修改宿主目录。未收到事件但bind发现cwd变化，清旧scope并拒绝本次，需明确新lease；A→B→A不复活旧id。
- policyChanged清tracking并调用policy全量clear，换policy版本/增加revocationVersion；所有旧timer与record先删除才abort。不能仅对tracked list循环并遗漏孤立记录。
- dispose先永久closed，清tracking，后policy.dispose；同步listener中的nestedpolicy/dispose不能重新打开admission。
- policy新revokeScopeFromHost使用authority-reducing scope快照，已取消caller也能清理。只删exactscope，先删除全部命中records+timers，再首个abort通知；另lifetime/Session保留。scope revoke增加epoch，使正在issue的旧申请不可跨撤销发布。

统一 [installScopeLifecycle](<../../src/host-adapter/scope-lifecycle.ts>) 给read/control工厂复用公开SDK事件payload和exact effect disposers。generator最后yield runtime.dispose，Cordis逆序先close再offlistener；安装抛错也清理。新 [control factory](<../../src/host-adapter/control-lifecycle.ts>) 显式host代码opt-in，入口依旧只有诊断状态工具。unload只取消租约，不awaitnative/宣称排空，暂未接生产policy事件或配置服务。

CU-009a2又私有接入 [live inert批准绑定](<single-use-approval.md>)：host-only prepare/bound decide/consume，每次重查独立风险仍需批准、live租约/版本/signal、最初scope/epoch/turn；scope/policy/unload先清批准再leaseabort。没有调用真实审批API、持queue锁或native执行；observation/material/action引用仍host声明不认证来源，不能当完整009b已验。consume结果固定不可dispatch。

CU-010a2新增私有 [claim/固定评估协调](<host-coordination.md>)：claim从livelease完整target得来，每job固定originalcall/scope/epoch/turn+稳定caller/lease组合signal；只运行policy.evaluate，不接受callerwork或执行器，不consume批准/charge/写账本。scope/policy/unload清claims和pending先于leaseabort，active slot到settle。host-only stop先stopped/version barrier，再queue停与全撤lease/批准；drained且runtime活才resume，旧id不复活。最后live检查按hostcwd→lease→turn/registry/epoch顺序；不是任意恶意host getter的跨对象原子性或native排空。全局epoch对无关旧排队call保守拒绝但freshcall可用其未撤租约/claim。

CU-013a2新增私有 [固定评估回执](<action-receipts.md>)：queueEvaluationReceiptFromHost从真实固定policy/queue结果生成终态，全部not_executed/targetunknown/effectunverified，无ACK/target/dispatch上报入口；ALLOW只能报executor不可用。每次scope/policy/stop/unload第一步封存receipt后才清queue/abortlease，晚到结果只读首terminal，64actiontombstone不因resume/policyclear重建。它不是ledger幂等、native事实或drain证明，不向入口注册工具。

## 实测与限制

[control runtime unit](<../../tests/unit/control-runtime.test.ts>) 验证defaultdeny、false dispatch、5类撤销中的同步重入关闭、跨Session/exact对象、sameID替换先清容量、cwd缺事件、spec/clock/getter触发policy、DTO单次解析、固定异常、caller取消、read/control不互授权与generation隔离。

[real Cordis/SessionStore](<../../tests/profile/control-lifecycle.test.ts>) 验证public Agent事件、SessionStore detach、committed cwd、不相关事件、unload/reload、close先于exact subscription解除。Agent registry/turn/cwd仍host seam，非完整AgentLoop/生产Profile。原 [read runtime tests](<../../tests/unit/fixture-read-runtime.test.ts>)、[artifact tests](<../../tests/unit/runtime-artifacts.test.ts>) 与 [managed cancel seam](<../../tests/transport/read-lifecycle.test.ts>) 一同回归，提取不应撤掉既有保证。

独立设计审3reads强调撤销全事务与最后policy调用后的复绑定；代码review8reads、139tests/typecheck exit0，未确认独立新增high-confidence问题、无probe。父另Red复现request getter原文逸出与finalcwd getter闭turn仍mint，并修复/回归；独立review未复验后续fix。测试数量与红绿/退出码见 [验证记录](<../verification/foundation.md>)。

这只支持A-02/08/20的host生命周期子断言，不代表native目标、真实授权/批准、停止SLO、幂等执行、业务效果或MVP已验收。缺AX权限仍NOT_RUN，不请求/绕过。私人数据仍no-go，未提交/push/install/publish。

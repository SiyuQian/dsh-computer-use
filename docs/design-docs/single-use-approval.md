# Single-use approval：CU-009a 纯宿主绑定与默认关闭适配

状态：2026-11-08，单次批准registry与公开SDK adapter已实现并单元验证。没有发出真实批准请求，没有注册自动答复器，没有native执行/coordinator。测试中的allowed-once是显式模拟host结果，绝不代表用户同意。CU-009父卡未完成。

## 本地registry

[SingleUseApprovals](<../../src/policy/approvals.ts>) prepare只接受host构造的严格canonical envelope：actionId、leaseId、observationId、完整fixture目标、操作/handle/输入、background、policy/revocation版本、materialContext、riskReason。

owner/workspace/exact lifetime/当前turn来自host绑定，不从envelope或模型参数接受。takeover、approved/sensitive/owner等额外字段拒绝。

- 每个registry随机32-byte HMAC key，固定位置canonical数组避免property顺序影响；输入不trim/normalize，任何字节变化都不沿用批准。
- Map只保存keyed digest、scope/turn、deadline、pending/approved状态和signal/listener/timer，不保存输入原文、裸hash或raw envelope。
- key生命周期为当前registry，dispose擦key；每项移除时擦digest。未承诺JS内存零副本/抵御本机恶意代码。
- 输出 [safe summary schema](<../../src/contracts/approval-summary.ts>)：operation、长度、process/window身份、action/lease/observation/handle引用和risk枚举。无输入或digest。summary只是展示，不自己构成grant。

## 状态与时限

prepare → pending；decideFromHost允许一次allowed-once变approved；rejected/cancelled/unavailable删除。重复/迟到决定拒绝，不能补一个allowed-once使旧记录复活。

consume必须exact scope/turn/完整envelope digest匹配，且approved、未取消、未到60秒mono deadline。先同步标记record为consuming使其它调用不可消费，保留exact Map成员供撤销/丢弃，finally删除并清digest，两个Promise竞争也只有一个赢家。digest计算后再次检查deadline和双signal，避免计算期间越界仍consume。

同scope进入其它turn会永久删除旧批准；其它caller scope查询不能删除原owner记录。envelope改变后本次id消耗且失败，不返还可重试token。expiry timer+机会prune，容量默认64，允许1–256。

consume结果固定`{status:consumed,dispatchable:false}`。它不是当前native身份、不是control lease，没有broker锁或durable dispatch ledger。未来coordinator要在最终重验/策略复核后原子组合consume与dispatch阶段；当前没有任何输入开放。CU-009a2增加scope/all invalidate的epoch屏障：prepare在raw getter前记epoch，consume标记前记epoch，最后复查epoch+exact membership，空Map撤销也推进屏障；非单纯扫描现存Map。精确discard也能删除正在consume的成员，保留single-winner与反重入。新增bound host decision会先校对完整envelope再应用答复，错误/重复绑定永久消耗ticket，不只按display ID决定。

## CU-009a2：私有live inert租约接线

[FixtureApprovalService](<../../src/service/fixture-approvals.ts>) 私有接入 [control runtime](<../../src/service/fixture-control-runtime.ts>)，不调用HostApprovalAdapter或真实approval service，不持queue/claim/OS锁，不运行work或native。host-only prepareApprovalFromHost、decideApprovalFromHost、consumeApprovalFromHost均接受严格proposal；裸pending ID或summary不是批准。

proposal仅actionId/leaseId/observationId/materialContext、exact fixture target/action、host approvalMode/raiseRisk。policyVersion/revocationVersion/mode/riskReason由live lease和policy决策派生，不由proposal覆盖；只有当本次policy.evaluate仍为REQUIRE_APPROVAL且lease活着，才可准备、答复或消费。DENY/never/普通ALLOW不能用approved flag绕过，输入/handle/target/lease/observation/material/action/raiseRisk改变使完整HMAC绑定失效。raiseRisk即使不改变最终riskReason也单独进入canonical envelope。输入字节不在store/raw日志保留；每次host须重新提供proposal，service不持有raw闭包。

raw getter前固定call/Agent/Session/turn/scope epoch与original signal；闭合DTO在单次operation只解析一次。每次kernel操作前后重查policy/lease signal及host binding，结束时仍要求最初turn/epoch，不接受中途换turn后重新bind为“当前”。prepare用caller与lease组合signal，到期/撤销会取消pending。scopecleanup允许aborted原context，按exactscope删除批准；另一Session或同ID另一lifetime不受害。policy全clear、dispose先清批准/key后leaseabort，abort通知中重入runtime被shared gate拒绝。返回前失败时discard同scope当前id，消费失败不返还token。

observationId/materialContext在此切片仍只是**host声明引用**，不查ObservationStore成员、不证明native exact/fresh window/coherence；actionId只参与绑定，不认证DurableActionLedger签名或幂等执行。这些明确保留CU-009b/011b，不让host合成测试冒充真实目标/输入许可。结果继续dispatchable=false，不能把allowed-once或consumed字段单独交给executor。

[runtime approval unit](<../../tests/unit/runtime-approvals.test.ts>) 覆盖模拟host答复/单次赢家、三种非授权结果、proposal绑定变化/拒元数据、五类清理/通知重入、跨Session不能消费或删除他人id、laterturn/sameID替换、approval60秒与lease短TTL、sourcegetter错误/turn变化、末次clock撤销和64满额释放。

[real Session/Cordis profile tests](<../../tests/profile/control-lifecycle.test.ts>) 增加四类真实事件之后迟到模拟答复拒绝及成功prepare/decide/consume；没有真实审批request，异步Promise只是test hostport。原kernel/adapter测试一起回归。独立设计3reads强调pinnedturn与空Map撤销屏障。代码review7有效reads、115tests/tsc exit0，唯一stdinprobe确认kernel consume先脱Map导致exactdiscard不生效（P2内核契约一致性；runtime私有/DTO预parse，不宣称其可达）。父Red复现，改consuming留Map+末次membership、finally删/清digest，补同ticket重入拒绝与失败后不可重放；review未复验修后新增case。具体红绿/命令见 [验证记录](<../verification/foundation.md>)。

## 公开SDK host adapter

[HostApprovalAdapter](<../../src/host-adapter/approval.ts>) 默认interactiveEnabled=false，当前插件没有实例化为true。单元测试只给窄fake host request，不调用真实approval.request。

- 使用公开config.policy、overrideOf(exactSession)，先算override ?? config ?? ask；never直接unavailable，不调用request。
- 禁止调用private effectivePolicy/decide，不调用setPolicy、不通过注册全局allowed-once answerer绕过。
- bindHostContext核对exact注册Agent/Session、open turn/current directory；请求传exact Agent/callId和固定safe摘要reason。reason会被host审计，所以不放输入、原始树、任意模型reason。
- await前后重绑host+scope/turn/policy/service对象；任何变化返回unavailable。only vocabulary outcome可以返回allowed-once；异常/未知答复unavailable，取消cancelled。
- 组合caller+60秒timeout signal；本地race cancellation，即使上游答复不settle也不无限挂起，迟到答复不复活批准。

SDK request只返回四种outcome，不提供canonical action digest/TTL/lease绑定。必须用本地registry补绑定，不把callId/reason当动作指纹。SDK也不保证本插件native已排空/效果已回滚。

## 验证

[registry tests](<../../tests/unit/approvals.test.ts>)：safe summary、单赢家、各字段变更、scope/turn、60秒阈值与计算后越界、cancel/revoke/clock/dispose、跨registry、extra字段/容量。

[host seam tests](<../../tests/unit/host-approval.test.ts>)：默认禁用/never不调用request、safe metadata、固定四种结果、异常/非法结果、host/turn/policy变化、caller取消、上游挂起取消、拒绝额外input/reason。使用真实Session和窄外部port，不能算真实CLI/Web批准界面验收。

后续CU-009b：接真实已授权host交互、live lease/policy/read/nativetarget再复核、policy撤销时同步invalidate、coordinator无锁等待与单次消费组合；真实批准期间目标变化测试依赖CU-006c/007b。不得仅凭此内核测试声称A-09/A-11全部通过。

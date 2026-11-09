# Action receipts：CU-013a/a2 保守host阶段内核及固定评估接线

状态：2026-11-09 Pacific/Auckland。已有私有inert固定policy评估→终态回执生命周期，及exact host ticket、单调阶段、可能派发边界、closed ACK、取消与失败到保守回执的host内核；没有native executor、证据读取或任务成功认证。CU-013父卡仍in_progress，未向模型注册动作工具。

## 事实来源与范围

[ActionReceiptTracker](<../../src/evidence/action-receipts.ts>) 只记录可信宿主适配层报告的阶段，不会验证read/control/approval/native target，不会消费批准、写ledger或派发动作。方法名的FromHost是调用边界要求，不是对任意传入对象的身份认证。

beginFromHost只校验opaque actionId形状，签名/有效期/来源必须由 [动作账本](<action-ledger.md>) 与未来service复核。记录绑定HostContext的owner/generation/workspace/exact lifetime对象与原caller signal；票据是本实例创建的冻结对象，clone/其它实例票据不能查或变更记录。所有ticket/report固定dispatchable:false。

内核自身没有current registry/turn/provider检查；CU-013a2另由私有service接controlruntime的固定评估与事件封存（见下），仍不是生产上下文有效性检查器。不能把拿到一个ticket理解为task lease、批准或native许可。

## 阶段与迁移

begin位于validate，advance只允许逐步记录authorize→approve→lock→revalidate；不能跳阶段、倒退或直接advance到dispatch。记录某阶段不表示该授权检查通过，service须自己运行真实检查。

- targetValidatedFromHost：只在revalidate接受一次exact/rebound，表明宿主报告过目标重验；该内核不接AX对象，也不自行证明target exact。
- dispatchPendingFromHost：仅revalidate且已有target报告时，一次性置可能派发边界，execution=unknown、phase=dispatch。必须在任何handoff前记录；不完成durable写入、不提供native许可。ledger先后事务接线仍在CU-011b/013b。
- acknowledgeFromHost：宿主只能报告attempted/completed，ACK进入verify；attempted可重复并升级completed，completed不可降级。宿主未来须验证response的actionId/requestId/generation/实际执行阶段，模型或未校验的JSON不能直接调用本方法。
- failFromHost：只接受closed ErrorCode，不接任意Error、message、reason或caller自写receipt；阶段取自内部状态。EFFECT_UNKNOWN在派发前拒绝，不能伪称为not_executed。
- finishFromHost：没有可能handoff、也没有取消时拒绝无故结束；可能handoff但无ACK时封存unknown/EFFECT_UNKNOWN；有ACK只保留execution，不生成效果成功。
- snapshotFromHost返回独立provisional或terminal投影；terminal=false时未封存，不表示动作可执行或已排空。

## 回执语义

| 已知阶段 | execution | effect | retry |
|---|---|---|---|
| 派发前拒绝/取消 | not_executed | unverified | 默认never；仅revalidate的target freshness失败可observe_first |
| 可能handoff、无ACK | unknown | unknown | never |
| ACK attempted/completed，正常finish | 保留ACK事实 | unverified | 无自动重试建议 |
| ACK后回读/截图/transport失败 | 保留ACK事实 | unknown | never |
| ACK后取消/卸载 | 保留ACK事实 | unknown | never |

没有effect verified、no_change_observed或task success生成路径；evidence永远空、taskOutcome永远not_evaluated。native completion不等于效果、业务完成或drain。target字段保留宿主已报告的派发目标解析方式，不是之后界面身份仍有效的证明；后续TARGET_CHANGED错误不抹掉先前发生的execution。

仅pre-dispatch且phase=revalidate的TARGET_CHANGED/TARGET_AMBIGUOUS投影target=invalid；authorize的策略目标拒绝仍target=unknown，不能冒充native重验事实；observe_first仅允许未跨可能派发边界的TARGET_CHANGED/TARGET_AMBIGUOUS/OBSERVATION_EXPIRED/FOCUS_CHANGED，表示先观察/重新准备，不是自动重做。所有possibly executed或ACK过的回执错误retry=never。

[receipt schema](<../../src/contracts/receipt.ts>) 同步收紧unknown execution只能配unknown effect；schema仍只验证内部一致性，不认证evidenceId/ACK来源。

## 取消、封存与生命周期

新阶段/target报告/可能派发同时检查当前signal和原begin signal；原caller取消后不能通过替换signal复活动作。settlement读事实使用revocation-only exact scope，不因caller取消拒绝已发生的ACK。仅当尚未封存时，可记录晚于cancel的确定backend ACK，再finish保留completed/attempted并附CANCELLED。

第一次fail/finish封存后，后续fail/finish返回同一首份回执的深复制；迟到ACK、target报告与advance均拒绝，不把unknown静默改成功。这样不会和durable ledger的吸收终态冲突。需要未来补事实时必须设计新的只读补充证据，而不是重开动作。

没有注册abort回调、时钟、native任务或异步调度，所有迁移同步；没有callback重入入口。dispose先关闭准入，再把所有未封存记录按取消封存，既有terminal不改；它只结束bookkeeping，既不调用executor.stop也不宣称work已drain。

默认最多64actions，可配置1–256；包括已终结tombstone，运行期不逐出，重复actionId拒绝、容量满拒绝。没有TTL和持久恢复，避免为进度删除未知动作；实例释放由owner管理，GC后不再提供查询。durable历史由ledger负责。

## CU-013a2：私有固定评估终态回执

[FixtureEvaluationReceiptService](<../../src/service/fixture-evaluation-receipts.ts>) 私有接controlruntime，host-only queueEvaluationReceiptFromHost严格只收原有 `{actionId,evaluation}`；不暴露tracker/ticket/targetValidated/ACK/dispatch/finish口。原始request只parse一次，DTO交给私有 [固定评估调度](<host-coordination.md>)，仍保留其lease/exactclaim/current复检。调用前固定原call/scope/turn/epoch，parse后复绑成功才begin记录；raw getter异常/authority注入在begin前拒绝INVALID_REQUEST，不为错误调用拿同id查询原receipt。

固定评估从未handoff输入，因此**所有新路径均terminal=true、dispatchable=false、execution=not_executed、target=unknown、effect=unverified、taskOutcome=not_evaluated、evidence=[]**。queue workStarted=true只表示policy闭包开始，不能提升为attempted/completed。回执phase表示正在检查/停止于哪一gate，不代表已通过native授权：

| 真实固定评估/调度结果 | error / phase |
|---|---|
| ALLOW_WITHIN_LEASE | CAPABILITY_UNAVAILABLE / authorize（没有executor） |
| REQUIRE_APPROVAL | APPROVAL_REQUIRED / approve（只到批准gate，没有prompt） |
| DENY | policy closed code / authorize |
| queue cancelled 或原caller取消 | CANCELLED / cancel |
| current重绑失败/queued rejected/未知内部错误 | CONTROL_DENIED / authorize（无有效policy结果，不捏造原因） |
| queue容量固定类型拒绝 | CONTROL_BUSY / authorize |

队列通过私有QueueFailure类型固定分类；不检查未知error.message/code前缀，故source getter抛“CONTROL_CAPACITY”也不能改回执。实际policy code不会由caller提供。核TARGET_CHANGED的投影同步收紧为仅revalidate阶段invalid，防policy gate冒充已验证目标。没有retry、证据读、预算charge、approval消费、native callback或ledgerpending；ALLOW不等于动作完成。

scope/policy/unload按清理链**第一步**seal未终结receipt，再清approval/claim/pending与abortlease。stop本身也先seal（不等后续policyhook），dispose先close tracker。不清record/actionId tombstone、不在policy/resume重建；64actions包括terminal满额RECEIPT_CAPACITY，同id始终ACTION_ID_CONFLICT（不取旧report）。actionId这里只是host声明opaque值，冲突防误重复不是签名认证、durable幂等或executionexactly-once。

晚到async continuation先查captured original context+privateticket的terminal；已封即只读深复制，不需要已退休host仍live，不再运行current/approve或改码。尚未封才最终复绑；若其它scope撤销只让全局epoch旧job拒绝，不会把该scope receipt误封成CANCELLED。session生命周期seal保留ACK后已有事实的kernel分支，但runtime从不调用那些分支。原terminal在随后取消/stop/unload仍不变；收到terminal回执不是drain证明，仍用独立queue.waitForDrain。

[27个runtime tests](<../../tests/unit/runtime-evaluation-receipts.test.ts>) 覆盖真实policy三决策/never、六类清理、caller信号/原turn/一次DTO、capacity与64terminaltombstone/复用拒绝、foreignclaim不得取ownerreport、未知错误getter不读/原文不泄漏、stop后不复活、不charge预算、异步迟到结果无执行/效果提升。新增kernel scoped/all seal与三种已有executionfact保留、policy阶段targetunknown；四类 [真实Session/Cordis事件](<../../tests/profile/control-lifecycle.test.ts>) 验证nonexecution终态。Cordis异步dispose请求可晚于fixedworksettle，已先封存的首terminal不改，unload完成后无新admission；不将卸载请求当同步native停止。

独立设计3reads指出strictDTO/固定类型error及先seal后abort，并静态发现policy阶段TARGET_CHANGED错误投影invalid；父Red复现后限制revalidate。独立代码审严格7reads、115targettests/4files+tsc exit0，无新增高置信finding，无stdinprobe；其快照24runtime/39kernel，父后加3runtime/3kernel由最终全量回归另验，不当独立验收。最终命令/未验范围见 [验证记录](<../verification/foundation.md>)。这些只认证host内固定评估结果如何保守报告，不认证observation/read来源、native执行/业务效果，不替代CU-013b/CU-011b。

## 测试与未验范围

[状态机tests](<../../tests/unit/action-receipts.test.ts>) 验证stage gate、ACK单调、所有closed error跨8种reachable阶段的保守不变量、取消前后/换signal、无证据不verified、terminal稳定/返回副本、clone/scope/容量/卸载。期待值使用手工枚举事实，未借builder生成expected。

[ledger seam tests](<../../tests/unit/receipt-ledger.test.ts>) 用真实owned journal组合两个真实内核：durable pending后timeout存unknown、completed后cancel仍存completed、pre-dispatch target拒绝不追加pending，重开只读回放不可执行；磁盘不留fixture输入。它们是测试脚本显式串联，不是已交付production orchestration事务。

[contracts tests](<../../tests/unit/contracts.test.ts>) 先Red证明unknown execution可错误接受unverified/no_change，再收紧schema。独立review复跑36tests并查cancel/phase/lateACK，无高置信当前finding；后加完整矩阵与ledger seam由parent验证。精确红绿/命令见 [验证记录](<../verification/foundation.md>)。

仍缺CU-013b可信回读evidence store/target postcondition/verifier、native ACK关联与transport故障阶段组合；没有真实UI/AX成功或输入。不声称A-12/13/27完整验收；不因回执可解析就开放模型动作。

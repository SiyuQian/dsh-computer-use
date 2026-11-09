# Reliability：foundation 与 fixture

当前有一次性只读health/fixture helper、inert host调度内核，以及仅限自有fixture的单次动作闭环（`act_fixture`，spawn后任何失败为 EXECUTION_UNKNOWN，不重试）。没有生产输入队列或桌面自动化SLO；唯一实测时限是fixture路径独立stop到host abort <500ms（CU-016a）。下列只描述实际运行切片。

## 现有行为

- cu_status 是无 I/O 诊断工具，先检查 caller abort，不派生 native 工作。
- schema和host binding同步、失败关闭，不尝试恢复执行。
- host观察store从读取前计monotonic TTL，投影后再查deadline；clock失败/回退清空并固定错误。records+pending默认64，不静默逐出活记录；无定时清理，使用机会prune和显式invalidate/dispose，见 [生命周期](<design-docs/observation-lifecycle.md>)。
- CU-007a2私有观察action-intent在raw getter前计十秒mono年龄，deadline夹原obs/readgrant截止，最终ownclock跨继承期限也拒绝；64票上限/机会prune+timer，原caller/grantabort清票，consume先mark保持Map撤销可见、finally删/清HMAC。source/target由live观察成员复查，不做backend/native，结果仍candidate；见 [生命周期](<design-docs/observation-lifecycle.md>)。
- fixture 状态先写临时文件原子替换，再更新内存 state；写入失败输出固定错误并退出。
- fixture delayed submit 250 ms 后执行，仅在未取消且 revision 未变时生效；reset 取消 pending Task，避免业务 revision 重置的 ABA。
- Primary/Secondary 各有独立状态，不共享 text/layout。
- fixture 测试进程 timeout 10 秒，非法启动参数 5 秒；测试失败保留错误，不伪装 skip。
- 构建脚本保留swiftc退出码，失败不输出成功manifest；helper编译前后核对source+recipe摘要，正常编译期间改动不得生成新manifest。每次read前复查 [本地一致性](<design-docs/helper-artifacts.md>)，bounded FD读取并检查cancel/mono deadline；done/parse后再查，不缓存或自动重建。
- host读grant到期timer+monotonic复检，撤销abort读permit；policy变更先使全部旧grant失效再通知，避免同步listener重入。read service publish前重绑host并复检；backend失败finally丢弃pending ticket，不自动retry。见 [读取授权](<design-docs/read-authorization.md>)。

- host控制租约以mono absolute/idle timer撤销，charge只刷新idle；policy epoch阻止cleanup同步重入重新签发。批准先标记consuming不可重入，保留Map成员供精确discard/撤销、finally删除擦digest，HMAC计算后复检deadline/撤销epoch/exactmembership。CU-009a2私有service每次prepare/boundhostdecide/consume重查live lease/risk/固定scope-epoch-turn，scope/policy/unload先清批准再leaseabort；scope/all invalidate即使Map空也推进epoch，防尚未publish或正在consume的operation越过撤销。host批准adapter默认disabled，取消/timeout与上游答复race，不因上游挂起而无限等待。见 [控制策略](<design-docs/control-authorization.md>)、[批准绑定](<design-docs/single-use-approval.md>)。这些是inert内核，不是原生停止路径。

- host队列取消active仅abort，不提前释放slot；work不settle时drain不能true。queued取消不调用work；stop先关gate和清claims/queued再通知active，resume要求drained。CU-010a2私有固定policy评估接livelease-derived完整targetclaim、scope批量cleanup/stopVersion，caller取消只减本job，lease撤销才releaseclaim；末次hostcwd→lease→turn/registry顺序，queuedTTL/取消不延长idle。无关scope旧job会因全局epoch保守拒绝，不自动retry，freshhostcall可用未撤claim。Cordis异步unload的请求不等于close effect已运行；不是native停止SLO。Darwin lock只close不unlink，crash由OS释放FD，目录/entry失效时requireOwnership拒绝；这不证明其它执行器已经退出。见 [协调设计](<design-docs/host-coordination.md>)。

- 独立stop listener/client使用nonblocking UDS、固定帧与绝对mono deadline；accepted socket启用SO_NOSIGPIPE，expired槽先回收再接受新stop。ACK固定drained:false，惰性owner显式drain前仍持flock；只验证测试namespace，不承诺真实native停止SLO。见 [独立停止](<design-docs/independent-stop.md>)。

- [固定开发验证器](<design-docs/foundation-verification.md>) 首个前序失败后标后续not_run，signal/超时/输出越界/不完整Vitest分母均失败，不用旧产物凑绿；运行前后限定源码或HEAD变化使证据失败，显式native未跑不算通过。它只核开发一致性，不保证同UID恶意修改、完整依赖或所有descendant已排空，NO_GO不升级。

- host action ledger新建file+directory sync，每event追加write-all/fsync，失败poison不派发；同id并发只有一条pending迁移。SIGKILL恢复pending一律unknown，不恢复输入；closed terminal是host报告而非效果证据，未知不能重放。真实掉电/native断连仍未验。见 [账本切片](<design-docs/action-ledger.md>)。

- stop发现记录使用private pending write-all/file sync，再linkat no-replace/unlink pending/directory sync才ready；process crash残留仅由新lock owner按metadata安全清理。publisher复制captured namespace FD，不能重新path open后写到别处。CLI只stop且ACK非drain，未运行生产路径正向。见 [路径与发现](<design-docs/control-namespace.md>)。

- host receipt tracker的可能派发先置unknown；ACK后verify失败仍保留attempted/completed，取消/卸载不改写既有terminal，不会把unknown变not_executed或observe_first。CU-013a2私有固定评估接线所有execution=not_executed，不把workStarted当输入；ALLOW报executor不可用、需求批准只到gate，capacity只用私有typedfailure分类，拒读任意error.message/code。scope/policy/stop/unload先seal后cancelqueue/abortlease，latecontinuation只读首terminal，64actiontombstone保留至释放。仅revalidate阶段TARGET_CHANGED类投影invalid，policy拒绝仍targetunknown。没有证据生成verified路径，不认证backend事实、ledger或drain。见 [阶段回执](<design-docs/action-receipts.md>)。

- fixture read-only revalidate用element生命周期witness，不信node index/label；64nodes/12depth完整性失败关闭，AX children/count/identifier错误不隐去候选，末次node window归属/metadata复核。内部service从private handle解candidate，grant/scope/TTL和原signal跨await/parse/末次membership后复检；backend参数clone与expected隔离，响应与fresh target/element exact比对，不缓存exact/续期，仍不可dispatch。真实AX lane缺权限NOT_RUN；见 [重验切片](<design-docs/fixture-revalidation.md>)。

- 内部 [read runtime](<design-docs/read-runtime.md>) 使用scope epoch/changing gate先清tracking/observations再批量撤销grant，防同步abort重入。Agent/Session按exact对象退休、cwd事件不信data路径、registry换对象被发现后旧scope撤销，同ID不继承；fiber复合卸载先关闭runtime再解除监听。dispose只取消不等于drain，实际managed fault child退出另由transport waitForExit验证，不承诺停止SLO。

- [内存artifact store](<design-docs/ephemeral-artifacts.md>) 从stage开始mono TTL，unref timer无访问也清理，逐次检查弥补eventloop迟到；pending按maxBytes保留容量、失败消耗ticket并清owned copy。host授权同步严格true，误传async仍拒绝并观察rejection，不回显异常；CU-014a2内部service逐次在独立policy前后重绑host/观察成员与exact readgrant；公开Session/Agent/cwd及policy/unload先清ownedbytes再abortgrant，policy关闭旧store重建空store。观察到期即拒读，artifact字节可能保留至自身TTL或scope清理；dispose只清本store owned bytes/timers，不承诺擦除外部副本或OS内存，不接磁盘/崩溃恢复。

- [内部inert控制runtime](<design-docs/control-runtime.md>) 与read共用scope/事件实现但实例权限隔离；scope清理全段changing gate，policy批量delete/clear timers后abort，dispose永久关门。同ID替换先退休清理再capacity，issue临时lease末次重bind失败撤回，policy最后signal查验之后再核host/turn/epoch，不运行work或声称native排空。

## 当前检查

[fixture tests](<../tests/fixture/fixture.test.ts>) 运行真实 app 二进制的 hidden self-test，读取状态与保存副本。它不是 AX/输入端到端。

[profile tests](<../tests/profile/plugin.test.ts>) 检查注册/取消/卸载，不等于完整 DSH Profile。

## 后续可靠性门槛

health helper 已建立协议版本、8KiB 上限、timeout、cancel 和 bounded terminate/cleanup，见 [transport](<design-docs/native-transport.md>)。stop 与 done race，即使 provider 不 settle 也不无限等待。退出不能证明时明确 cleanup failed，不返回成功。

CU-006已实现fixture-only observe协议与reader；真实AX成功路径已在自有fixture实跑，缺权限时显式lane仍以exit3/NOT_RUN报告。reader最多64节点/12深度/1024值，响应262144bytes；health保留8192。read许可签发归CU-008。CU-010/011 才建立唯一 controller、durable dispatch ledger 和 unknown 不重放。CU-013 明确执行/效果/任务结果。CU-016 测量停止延迟。

上述未来时限见 [合同](<design-docs/contracts.md>)，必须实测后再声明。不可把本机 self-test 速度作为产品性能承诺。

# Host coordination：CU-010a/a2 与 CU-010b1

状态：2026-11-09 Pacific/Auckland。已有纯host串行/停止排空内核、私有live inert租约/固定策略评估生命周期组合、真实Darwin锁原语与测试namespace中的 [独立进程stop-only通道](<independent-stop.md>)。尚未组合生产broker；[固定namespace/发现/CLI](<control-namespace.md>) 已有策略与临时parent验收，但无生产启动/用户可达性验收或native输入。CU-010父卡仍in_progress，不开放模型动作工具。

## 宿主串行内核

[HostControlQueue](<../../src/coordinator/control-queue.ts>) 只调度host传入的闭包。SchedulingPermit固定`kind:host_scheduling_only`、`dispatchable:false`与组合取消signal，不是policy lease、单次批准或native许可。队列的actionId只校验closed opaque格式，不做幂等；[CU-011a账本](<action-ledger.md>) 已有独立host幂等记录，但未与队列/native组合，CU-011仍未完成。

- 同一实例跨Agent、Session和不同目标最多一个active work；其余FIFO。默认最多64pending和64target claim，可配置1–256；drain waiter最多256。满额明确拒绝，不静默丢工作。
- target claim为exact对象引用ticket，绑定owner/generation/workspace/lifetime。克隆对象或其它caller不能使用/释放。
- 排他key使用pid/processStart/windowId，不能靠切换primary/secondary逻辑名字或windowInstance版本另开同一物理窗口。claim不是native身份认证，每次真正输入仍需完整目标重验。
- enqueue前与真正启动前调用current host binding；scope/turn/callId/signal变化或取值失败均不启动work。原caller signal仍负责取消，不接受换signal来改掉生命周期。
- pump设同步重入屏障，current绑定回调若stop/dispose/release，会在调用work前被复核。重入enqueue不会启动第二active或覆盖active记录。
- callback成功返回、失败、取消分别呈现；原始异常固定为CONTROL_WORK_FAILED，不retry。`workStarted:true`只说明host闭包开始，不能解读为native已执行或业务成功。

## 取消、停止与排空

caller取消、release或host stop会先撤销新工作资格。

- queued取消：移出FIFO、移除listener、返回cancelled/workStarted=false，不调用work。
- active取消：通知permit.signal，但保留active控制位，等待work原Promise settle。work忽略signal时不会为了进度提前释放；调用方只能报告drain未确认，不能放下一个工作。
- release精确owner允许用已取消的context做减权清理，使用 [revocation-only scope helper](<../../src/host-adapter/scope.ts>)；identity检查不减弱。不得将该helper用于新工作准入。active claim标revoked，直到settle仍占原目标。
- stopFromHost是独立于模型work队列的方法：先设paused、清全部claims/pending，再同步abort active。listener重入看不到旧claim，也不能resume正在drain的active。
- status为idle/running/stopping/paused/disposed，只有计数，无输入/异常原文。stop ACK不等于drained；waitForDrain只在active/pending均空才true。等待signal到期返回false，不释放控制位。
- resumeFromHost只有在active已结束且未dispose时允许，且必须重新claim；不会恢复旧批准/租约/任务。dispose先永久关闭准入再stop，调用方仍应等待drain。

当前host方法不是已经鉴权的Web/RPC/CLI停止入口。[CU-010b2a](<independent-stop.md>) 已有独立native循环的test通道，但尚未接host JS/真实executor，不能声称阻塞的JS主线程或native调用仍可立即中止。

## CU-010a2：私有租约claim与固定评估队列

[FixtureSchedulingService](<../../src/service/fixture-scheduling.ts>) 由 [control runtime](<../../src/service/fixture-control-runtime.ts>) 私有持有，外部不能取得queue/policy/claims。runtime只开放host-only claimTargetFromHost、queueEvaluationFromHost、release与stop/status/drain/resume，不接受work/executor/prompt callback。低层queue原有callerwork接口仍是host内核，不经runtime转交。入队后唯一闭包为固定同步policy.evaluate，value始终dispatchable=false/requiresNativeRevalidation=true；既不消费批准、不charge预算，也不查ObservationStore或DurableActionLedger。

- claim只收live租约id，用policy.fixtureTargetFromHost复制原spec完整五字段target，不从TaskLease残缺window重建，也不收caller自选target。claim私有记录保存scope/lease/target/signal，不保存action。claim不签新controlauthority，不延长absolute/idleTTL。租约到期signal自动release；已取消的旧caller仍可按exacttrackedhost减权释放。
- queueEvaluation严格parse `{actionId,evaluation}` 一次；禁止额外work/approved字段。evaluation的lease及完整target须匹配同一个privateclaim；另scope/clone/lifetime不接受。actionId此处仅格式与调度标签，不提供dedup或ledger认证，观察/描述元数据仍host声明。
- 每个排队call在raw getter前固定原call/Agent/Session/scope/epoch/turn；signal只创建一次any(caller原signal,lease撤销signal)，后续current复用同对象。claim可用于以后同scope的新call/turn，但每个job不能跨本次turn/epoch。queued阶段临时持有已隔离DTO（可含输入），不写日志/磁盘、不声称secure erase；最多64pending。
- 入队前、head启动前、固定policy评估后均复查exactclaim/livelease/currenthost。末次顺序为host bind（含cwd）→live lease/target→open turn/exactregistry/epoch复核，不再在最后lease检查后重读cwd，避免重复host-clock来回留下已知窗口。内部optional validation seam不暴露给tool。它不是对任意恶意host getter副作用的跨对象原子快照；host服务可信边界不变，native exact仍缺。
- Session/Agent/cwd先批量forget私有claim与移除lease listener，再queueinvalidate命中claims/pending；active标revoked/abort但物理target与active slot留到settle。之后才撤lease/通知其余observer。policy全clear，dispose永久关闭；原call取消只取消该job，不自动撤同scope租约/claim。
- registry全局epoch在任何scope撤销时保守拒绝无关的**在途旧call**，但不撤无关claim/lease；host显式freshcall可以再次评估。这是failclosed设计，不自动retry。kernel scoped cleanup仍允许其它scope工作在其自己valid current下继续。
- 新kernel batch/allinvalidate在cleanupcontext getter前持changing并推进epoch，命中claim/queued先失效，再通知active；claim/enqueue外部读取后复查gate+epoch。stop前runtime设stopped并推进stopVersion，queue暂停/清理，再撤所有lease/批准。即使getter内stop→drainedresume，本次旧version也不能mint。resume要求runtime未dispose/非changing及queue drained，且旧lease/approval/claim不会恢复。

[33个runtime cases](<../../tests/unit/runtime-scheduling.test.ts>) 覆盖私有claim与精确target、caller替换/cancel、queuedTTL/turn/cwd/sameID、scope五类清理/abort重入、固定无预算/批准消费、64pending、stop-drain-resume、execution getter stop与stop/resume、最后policyclock turn及最后cwd推进lease截止。[queue tests](<../../tests/unit/control-queue.test.ts>) 另增batchcleanup、cleanupgettergate、postparse stop与revokedactive物理target保持；[policy tests](<../../tests/unit/control-policy.test.ts>) 验证private targetclone。四类真实 [Session/Cordis事件](<../../tests/profile/control-lifecycle.test.ts>) 验证撤claim/排队及unload后永久关闭。Cordis dispose本身异步，固定同步评估可能在close effect实际运行前完成，不把dispose请求当同步停止ACK；runtime.dispose直接调用仍测试立即cancel。

独立设计3reads要求transactiongate和稳定signal+最后live复检。代码review7有效reads受父并发改动限域，无新增保留finding；唯一测试组97/98+tsc0，失败为容量test在await overflow之后才stop的microtask假设（父已修为先同步stop）。唯一stdinprobe加载当时current src，getterstop被二次gate拒绝/CONTROL_STOPPED，旧漏洞断言进不去而exit1，未完成后续resume分支；它不是全suitegreen。父后续stopVersion/最终排序fix与最终fresh回归另有 [证据](<../verification/foundation.md>)，不冒充独立复验。

这里只有JS固定inert评估和host方法停止，不连接真实OS broker/UDS/CLI，不独立于阻塞JS，不提供native排空或停止SLO。审批等待期间无锁、真实target/权限变更、真实输入/ledger事务仍CU-009b/010c/011b，未完成父卡。

## Darwin锁原语

[ControlLock](<../../native/ControlLock.swift>) 使用公开BSD `flock(fd,LOCK_EX|LOCK_NB)`。Swift需要不带Darwin模块前缀的函数名；显式`Darwin.flock`在当前toolchain会解析为struct。没有新增依赖或用mkdir冒充内核锁。

当前仅 [test probe](<../../tests/support/control-lock/main.swift>) 使用，编译进自有临时二进制；没有向read helper增加command或生产binary。

1. caller提供绝对、POSIX realpath完全相同的目录；0700、euid、directory类型必须满足。Foundation URL标准化在本机会把/private/var别名化为/var，不能拿它替代POSIX realpath。
2. open directory用O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC；openat固定control.lock用O_CREAT/O_RDWR/O_NOFOLLOW/O_CLOEXEC/O_NONBLOCK、0600。已有错误权限不自动修复。
3. fstat核对regular/euid/0600/nlink=1；非阻塞flock忙就busy，不排队抢锁，不换namespace重试。
4. init获锁后与requireOwnership均复核directory及entry/descriptor的dev/ino/type/owner/mode。entry被替换则lost，不再可依赖这把锁。
5. release/deinit只close本对象描述符，永不unlink稳定lock inode。完全初始化后的throw只由deinit清理，避免catch与deinit双close；未转移的init失败分支自行cleanup。
6. O_CLOEXEC避免无关exec child延长lock寿命。OS会在owner进程死亡时释放FD，但若真正输入执行器在其它进程，keeper死亡不能证明它已停止；CU-010c必须另证生命周期/排空。

测试namespace是parent自有mkdtemp，不是产品默认值。生产per-user路径必须跨workspace/profile/host/协议版本统一且可信，安全校验失败时native unavailable。路径策略已由 [CU-010b2b1](<control-namespace.md>) 固定，但尚未部署生产启动，不自动写入用户Application Support/Profile。

## 验证与尚缺

[queue tests](<../../tests/unit/control-queue.test.ts>) 验证FIFO、目标/owner排他、scope/call变化、取消/停止前后、sync reentry、drain容量与失败不retry。全部是host闭包，不证明原生输入无重叠或受管按键释放。

[lock tests](<../../tests/transport/control-lock.test.ts>) 编译真实Swift源码并运行两个以上OS进程：竞争busy、同inode复用、normal/SIGTERM/SIGKILL释放、exec FD不泄漏、entry替换、symlink/权限/hardlink拒绝。构造末次witness失败由 [测试专属syscall fault](<../../tests/support/control-lock-fault/main.swift>) 注入，断言真实初始化分支两个FD各close一次；production类没有test-only hook。

CU-010b2a的test namespace同UID/私有能力stop-only、sticky撤销与drain区别已有真实第三进程验收；详见独立停止设计。仍缺CU-010b2b安全生产namespace与用户入口，CU-010c live授权/审批/broker/native/helper/action ledger组合。A-19只有方法与test进程级子断言，不是生产紧急停止/native输入或受管按键释放验收。

同一OS用户的恶意原生代码能改写自己的目录/进程，flock与逻辑grant不构成该威胁的强隔离；也不提供系统级原子目标重验/输入或业务exactly-once保证。

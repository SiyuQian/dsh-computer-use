# Foundation 验证记录

日期：2026-11-08，Pacific/Auckland。代码尚未提交，所有本次 source/tests 都是基于空 root commit 的新文件。没有远端 push、PR 或发布 SHA。

## 环境与基线

- base：`2dd79be492de26f7b8f560258e2edfc4f3560a64`。
- 分支：`computer-use-foundation`，native worktree 保留。
- macOS 27.0.1 arm64，DSH SDK 0.2.2-rc.1，Cordis 4.1.0。
- pnpm 11.28.5，lockfile 固定依赖；安装使用 --ignore-scripts，没有运行依赖安装脚本。

初次 pnpm 脚本沿 PATH 使用 Node 24.22.1。自审发现后，最终完整检查切换到宿主返回的 Node 24.21.0，并显式把该目录置于 PATH 首位。

受签名的宿主 Node 不能加载不同 Team ID 的 rolldown native binding。没有修改签名、删除依赖或关闭系统安全。固定官方 WASM binding，最终检查设置 `NAPI_RS_WASI_FLAVOR=wasm32-wasi`。WASI experimental warnings 明确保留，不声称零 warning。

## TDD 记录

| 切片 | Red | Green |
|---|---|---|
| A-01 registry | 19:39：缺插件入口的可加载断言失败 | 5 个真实 Cordis registry/pipeline 用例通过 |
| A-02 contracts | 19:41：严格合同缺失断言失败 | 身份注入、脚本、预算与状态用例通过 |
| trusted host | 19:44：绑定模块缺失断言失败 | exact live Agent/Session、open turn/current directory 通过 |
| module sensor | 19:46：缺传感器导致允许/拒绝断言失败 | 8 个测试通过，含静态/动态/require 越界 |
| package entry | 19:48：缺已声明 verifier 失败 | 实际 import 构建入口并注册/卸载通过 |
| review receipt | 19:49：not_executed + verify/EFFECT_UNKNOWN 被错误接受 | 补一致性约束后拒绝 |
| review screenshot | 19:50：coherent 截图 frame/mapping 自相矛盾被接受 | 限定 window-local 映射与同 frame 后拒绝 |

review 还发现 501 节点测试重复 handle，导致移除节点预算仍会因唯一性失败。已改为不同 handle，并增加 500 边界通过，避免假阳性。

## 完整检查

最终检查使用宿主给出的 Node 和 pnpm 脚本路径，PATH 同步到该 Node。命令顺序：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:invariants
pnpm run check:package
```

19:58 的完整 run（含 500 节点边界和 overflow）：57 tests passed / 5 files，退出码 0。Node 24.21.0/arm64，frozen install、类型、build、boundary sensor、built-entry smoke 均退出码 0。installed project-docs checker 为 0 errors / 0 warnings，git diff --check 退出码 0。所有改动尚未提交；git diff 对 untracked 文件不提供内容验证，实际代码由测试与直接读取审查。

## 独立审查

单独上下文 reviewer 检查实际 source/tests 与 SDK，审查当时执行 52 tests 和 tsc。共三项可复现问题，已本地修复并由主 Agent 复验；reviewer 没有独立重跑修订版，不冒充二次通过。

## 未运行 / 不作声明

- 没有 native helper、AX 观察、原生输入、TCC、用户真实 app 或模型验收。自有 AppKit fixture 的 hidden self-test 另见下节，不代表外部 native 输入测试。
- 没有真实 Web GUI、完整临时 CLI Profile、非 Mac 平台运行、最低 macOS 版本验收。
- 没有控制任务签发、批准/幂等 ledger、用户停止的运行保证。
- Receipt/evidence schema 只验证内部一致性，不证明业务结果。
- 没有私人数据防留存保证，见 [SDK 隐私门槛](<../design-docs/sdk-compatibility.md>)。

后续以 [计划](<../PLANS.md>) 逐卡补验，不把本阶段单元测试数量等同 34 项验收全通过。

## CU-004：自有 AppKit fixture

- 19:59：先运行 fixture 测试，缺 app 产物时 3 项失败。
- 20:01：Swift 6 / arm64-apple-macosx14.0 编译成功，构建没有启动窗口。
- 20:02：3 项 fixture 测试通过，完整回归 60 tests / 6 files 通过。
- 20:03–20:05：独立审查发现 reset 不恢复真实排列、双窗口共用 oracle、delayed reset ABA。分别补 self-test 断言并重现失败，再修复；20:05 重建与 fixture 测试通过。
- 20:08：最终重建 TS/AppKit、typecheck、完整测试 60/60（6 files）、boundary/package smoke 全部退出码 0。hidden self-test 同时验证延迟取消和正常延迟完成。文档 checker 0 errors / 0 warnings。
- self-test 使用真实隐藏 NSWindow/NSButton/NSStackView/字段，不显示窗口、不 activation、不注入输入、不请求 TCC。它不能替代外部 helper AX/输入验收。
- Primary/Secondary 独立测试状态，保存副本在准确 mkdtemp 目录中；secure field 不写入公共 state。
- 当前 build 只产本机架构，部署 target 14.0 不是实测最低 OS/Intel 兼容性。没有发布签名/notarization 声明。

CU-004 交付时真实 GUI、helper 进程、AX/输入与 TCC 尚未运行。后续 CU-005 health 进展见下节。

## CU-005：health-only native transport

- 20:11：先运行 transport，缺客户端模块断言失败；native launchId 必需字段也先证明旧合同错误接受。
- 20:14：真实 Swift binary + public DSH LocalSubprocessRuntime 17 个 transport 用例通过。没有 UI 内容读取或输入。
- 20:15：自审发现上游异常若 NATIVE_ 前缀会泄漏原文，新增失败用例后改 private error class，只透传内部固定错误。
- 20:16：扩展 Swift admission 的 Bool version、wrong launch/ID、extra/truncated frame 后 23 用例通过。
- 20:17：独立审查证明 done 永不 settle 时 deadline 不能进入 cleanup。新增 never-settle provider Red，改 stop/done race + bounded terminate/wait。provider 退出无法证明时明确 NATIVE_CLEANUP_FAILED。
- 20:18：修复后的 24 transport 测试、typecheck、TS build 通过。早期 Promise.withResolvers 与 ES2023 lib 不匹配，已改普通 Promise，不扩大编译目标。

实际 helper 只接受一个 health frame，固定字段与8192 byte限制，fd7为launchId配对。无网络端口、脚本、list/observe/mutate。权限检查不提示用户，不 capture。普通非托管调用拒绝不是抵御同用户恶意代码认证。

transport tests 同时使用真实 child 故障进程和窄 provider 故障用例。真实 child 跑完确认 managed range 退出；无法证明 cleanup 时返回失败，不宣称安全停止。

20:22 最终完整检查：frozen install、TS build、AppKit build、helper build、typecheck、完整 84 tests / 7 files、boundary/package smoke 全部退出码 0；文档 checker 0 errors / 0 warnings。WASM/WASI experimental warnings 仍存在并披露，不是零 warning 运行。

CU-005交付时未安装、未推送/提交、未使用真实私人数据。完整AX/input/TCC/GUI/model未运行。后续CU-006部分进展见下节。

## CU-006：fixture-only 观察，部分完成

- 开始时实际health preflight：accessibility=false，screenCapture=false。没有申请/绕过权限，没有枚举私人app。
- 20:25：projection模块不存在断言先失败；20:28实现后10项投影通过，tsc发现role字面量类型扩大并修复。
- 20:30：observe client缺模块先失败；20:34客户端接入后旧Swift helper拒绝observe、旧fixture不支持observe-host，均实际Red。
- 20:38：Swift reader与hidden observe-host编译通过，44项针对性测试通过。最初Swift deprecated cString/unsafeBitCast警告已改用UTF8 decoding/已检查类型的downcast；后续原生重建无此warning。
- 20:40：真实hidden fixture活进程输出kernel processStart，helper对准确fixture返回READ_DENIED；过期start与退出进程均TARGET_CHANGED。不读取UI内容。
- 20:41–20:46独立审查两项valid：secure metadata nil被当普通text、合成1/2窗口ID与每次新UUID不能是window identity。补Red后修复为positive fixture.text allowlist和真实AppKit windowNumber+per-window生命周期UUID witness，request/response/最终重验完整绑定。
- native policy测试编译真实Swift guard并注入getter：缺失/冲突/secure元数据value getter计数0，公共field计数1。该测试不替代外部AX验收。
- 20:46：修复后的投影12、transport30、fixture5，共47针对性测试通过；helper/fixture重建、typecheck退出0。
- 显式test:native-observation实际退出3，输出NOT_RUN: Accessibility permission is absent。预检后没有启动fixture或弹权限；AX成功分支未运行，不计通过。

CU-006仍in_progress。成功AX两窗口、secure省略、重复identity、目标替换native断言待已有权限后运行；无可执行handle store/许可签发器/输入command。详见 [观察设计](<../design-docs/fixture-observation.md>)。

20:56完整回归：frozen install、TS/helper/fixture重建、typecheck、110 tests / 10 files、boundary/package smoke全部退出0，文档checker 0 errors / 0 warnings。原生编译警告已清除；测试运行仍有已披露的WASI experimental warnings。

本轮仅自有公开fixture，没有私人app、输入、推送、提交、安装或发布。默认suite绿色只证明已运行的拒绝/投影/hidden fixture切片，不解锁CU-007 native集成或后续写入。

## CU-007a：纯host观察生命周期

- CU-007明确拆分：a只依赖已完contracts/fixture投影，host-only/inert；b仍依赖CU-006c真实AX成功，不能提前解锁native或写入。
- 21:00：先运行store不存在断言Red；host adapter原先没有exact对象lifetime，新增同ID不同Agent/Session的Red。
- 21:02：store21+host9共30针对性测试通过。monotonic TTL从读取前计时，opaque single-use ticket、scope/handle membership、容量、撤销/dispose方法与返回拷贝隔离；不调用native。
- 21:03：自审补Red：投影期间越过TTL仍publish、injected clock异常透传原文；修复commit投影后deadline复检及clock固定错误/清空store。
- 21:04：23 store + 9 host tests共32通过；typecheck最终退出0（background job已收集）。
- 21:07：完整TS build/typecheck、134 tests / 11 files、boundary/package smoke退出0；文档checker 0 errors / 0 warnings。native源码自20:56重建后未变，全部fixture/transport lane重新运行；WASI experimental warnings仍披露。
- 独立host切片review直接读untracked实现，复跑32/32（store23+host9）、tsc exit0，未发现达到报告门槛的新bug。该结果不包含未实现native集成/授权/Session事件保证。

CU-007a交付时candidate固定requiresNativeRevalidation=true，不是exact native身份或grant，无Session事件接线/native重验等保证；CU-008a read内核进展见下节。CU-007父卡和完整目标仍未完成。详见 [生命周期设计](<../design-docs/observation-lifecycle.md>)。

## CU-008a：默认拒绝的fixture读取授权与service

- 21:10：先运行read authority缺模块断言Red，再实现exact host scope/target、短期mono TTL、grant实例Map、撤销/组合abort/clock/capacity/copy。
- 21:12：authority23+store23+host9共55通过，typecheck退出0；无native调用/工具。
- 21:13：先运行read service缺模块Red，随后实现backend前/返回后核对权限、host重绑、固定错误、失败ticket清理。
- 21:14：独立审查复现policy change逐个abort时同步listener可重入第二旧grant。新增Red后修为先clear全部旧grant和timer，再统一abort；reviewer同复现通过。
- 21:17：第一次完整166/166及build/typecheck/boundary/package/doc checker通过，但后续审查仍找到下一项，未据此提前结束。
- 21:18：独立审查复现grant在同步投影中跨截止点仍publish。新增5s grant/15s obs fake-clock Red；修复store在投影/TTL检查后、records.set前调用同步beforePublish，service此时重绑host/requireRead/permit abort。失败不存隐藏record，maxEntries=1断言验证容量未占用。
- 21:19：修复后authority24+service9+store23共56通过，typecheck退出0。reviewer只复验原发现，service9/9+tsc退出0，无遗留该项。

21:21最终完整验证：TS build/typecheck、167 tests / 13 files、boundary/package smoke全部退出0；文档checker 0 errors / 0 warnings。WASI experimental warnings仍存在。此次host改动未改native源码，全部已有native拒绝/fixture自测重新运行；真实AX成功lane仍NOT_RUN。

在21:21此切片结束时，host-only grantFromHost不是模型工具，不自动获取用户同意/TCC；read service只依赖内部seam，未接配置UI/生产Session事件/真实AX成功。后续inert policy/approval进度见下节；broker/ledger/独立停止/输入仍未实现。详见 [读取授权设计](<../design-docs/read-authorization.md>)。

## CU-008b1 / CU-009a：inert控制租约、风险下限与单次批准

全是host内核或fake host seam，没有native输入、真实批准请求或自动answerer。所有policy/consume输出不可dispatch；CU-008/009父卡仍in_progress，native/live集成另有依赖。

- 21:25：control-policy模块缺失Red(exit1)，21:27初步21tests+tsc Green。随后已知secure identifier却标public用例先Red，再增加独立拒绝。
- 21:29：approvals模块缺失Red；21:30 control23+approval26共49tests及tsc Green。
- 21:32：host adapter模块缺失Red后实现default-disabled公开API适配；10tests/tsc Green。不调用private effectivePolicy/decide，不改变策略；never先拒绝。
- 独立SDK审查核实公开overrideOf/config/request、四值outcome、reason审计、signal语义及缺动作指纹字段；没有发真实request。registry自持canonical envelope+私有HMAC。
- 21:33：独立control审查发现prune同步abort listener可更改policy/dispose、外层仍重签；idle signal只有绝对TTL timer不会主动idle过期。新增两项Red(exit1)，修为epoch+disposed/cancel复核、min(absolute,idle)timer与charge重排。
- 21:34：独立approval审查指出consume在计算前查TTL，HMAC后可越界；parent用100/100/60099/60100 clock序列Red复现后补计算后deadline/双signal。reviewer自身额外内存复现被dsh-secrets策略拒绝，未绕过/未读取相关文件，不把那次尝试记成功证据。
- 21:36：parent补same scope stale turn再回旧turn复活、忽略signal的host答复导致adapter挂起两项Red；分别永久删除旧turn批准、local cancellation race，21:37全部Green。
- 21:37–21:39：safe summary补action/lease/observation/handle/risk及完整fixture identity，先Red再实现；不输出raw input/digest。初始缺模块辅助catch已删除，后续import错误保留原诊断。
- 21:39：parent扩查read grant发行，发现prune内policy重入同型缺口，新增Red后加policy epoch；21:40 read25+service9+control25+approval27+adapter11共97tests/tsc Green。
- 独立control reviewer复读修复片段并复跑25/25+tsc(exit0)，关闭原两项。独立approval reviewer增量读adapter/summary/kernel与11fake-host seam，11/11(exit0)，未发现新高置信问题；静态确认计算后TTL/turn修复，但未宣称重跑全部27。

21:46最终完整验证：build/build:fixture/build:helper/typecheck/test/check:invariants/check:package全部退出0；**231 tests / 16 files**。Swift构建无警告，不启动窗口；真实helper health/拒绝与hidden fixture测试重新运行。文档checker **0 errors / 0 warnings**。Node WASI experimental warnings仍保留。

本轮没有实际Web Profile/GUI、批准UI、AX成功、真实app/模型或native输入验收；未提交/push/install/publish。设计见 [控制策略](<../design-docs/control-authorization.md>)、[单次批准](<../design-docs/single-use-approval.md>)。

## CU-010a / CU-010b1：host队列与Darwin锁原语

本轮复用原worktree/branch/base，全部source仍未提交。host闭包调度与OS锁是两个未组合切片，均不签发输入许可。

- 21:53：queue模块缺失断言Red(exit1)，21:55三个串行/cancel-drain/stop测试及tsc Green。
- 21:56：physical window用逻辑windowKey分别claim、current host callback同步stop/release后仍启动work两项Red；21:58重入enqueue覆盖active导致未settle的测试以timeout Red。修为物理pid/start/windowId保守排他、pending队头保留至重绑完成、pump重入屏障与callback后gate复核，21:59共13Green。
- 22:01：native/ControlLock缺失Red，随后编译真实Swift flock原语+测试probe。权限/symlink等拒绝路径Green但合法目录被误拒绝；POSIX probe确认Foundation标准化把Node realpath的/private/var别名为/var。改为C realpath完全匹配，22:03十个真实进程tests+tsc Green。Swift不带Darwin前缀的flock通过；Darwin.flock会误解为struct（只读API核查，不采用shim/新依赖）。
- 22:04：callId/signal变化未拒绝的两项Red；初bind内stop/resume实际已因旧claim拒绝，修正该测试过度指定error code，不将其计为新实现修复。补exact callId/signal校验，22:06队列16Green。
- 22:06–22:07：exec probe先缺命令Red；实现posix_spawn后因_NSGetEnviron未公开编译失败，改显式empty env；11lock tests+tsc Green。22:16另做真实mutation check：暂去O_CLOEXEC，exec child仍持lock导致competitor status3，定向测试Red；恢复两处flag后全量Green。这证明测试不只断言probe响应。
- 独立queue审查确认已取消context不能调用release导致claim残留；parent 22:09新增Red，分离revocation-only scope helper，仍核对identity但不以cancel阻止减权，active目标保留至settle。22:10 queue17+host9+read25+policy25共76及tsc Green。reviewer复读queue/test并独立复跑17/17+tsc exit0，无其它高置信发现。容量重入候选在该时刻确实pending满，明确排除，不为了审查修改正确行为。
- 独立native审查确认完全初始化后throw仍运行deinit，原catch和deinit双close目录FD。parent用测试专属Swift syscall interposition在final fstatat失败计close，22:08 Red输出两个unique fd却三次close；改catch只throw，由deinit单独清理已拥有fd，12tests Green。reviewer只独立证实Swift析构语义与旧缺陷，未声称复验修复；其suite碰到未完成exec中间版本exit1(10pass/1fail)，不隐去、不作为当前失败。
- 22:12补host stop abort-listener重入、claim/drain容量与已取消等待释放、invalid/pre-abort覆盖，20queue tests+tsc Green。所有permit固定dispatchable=false；已有缺模块helper catch/存在断言在Green后去除，不掩盖真实import/compile诊断。

22:17完整验证：build/build:fixture/build:helper/typecheck/test/check:invariants/check:package全部exit0，**263 tests / 18 files**。新增lock原语由suite现场编译、测试probe仅在自有tmp中运行；现有helper/fixture也重建，未增加其输入command。文档checker0errors/0warnings。Node WASI experimental warnings仍存在。

22:20清除初始存在断言并完成文档后，再次build/typecheck/全量263/263/18files/boundary/package均exit0；文档checker再次0errors/0warnings。未改native源码，lock suite仍现场重新编译，非复用旧probe结果。

本切片只支持A-10锁/调度子断言与host方法级取消，不是A-19独立紧急停止、真实输入无重叠/按键释放或完整生产broker验收。CU-010b2/c及CU-011/012/015仍未完成；没有TCC请求、真实批准/私人app/GUI/model操作，没有提交/push/install/publish。设计见 [协调切片](<../design-docs/host-coordination.md>)。

## CU-010b2a：独立stop-only通道

保持同一worktree/base，不改read helper协议，无native输入。只在自有/private/tmp namespace编译运行真实Swift owner/client/competitor进程；不写用户Profile或生产Application Support。

- 22:24：StopChannel源码缺失断言Red(exit1)。设计只读审查提前确认accepted SO_NOSIGPIPE、fd3/stdin不得隐藏阻塞、duplicate JSON拒绝三项边界；据此实现nonblocking有界循环。
- 22:26：11tests Green但tsc因unused chmod import exit2；随后该import用于权限负测，类型检查恢复exit0。preexisting socket测试原用没有cap的spawnSync，实际只测fd3失败，已换真实私有fd3 async进程使路径拒绝真实运行，不保留空洞测试。
- 22:27–22:28：duplicate不同值用例原已被解析后command拒绝，不能据此证明dupe安全；新增duplicate同值用例Red(错误revoked)。加sorted canonical compact JSON字节回比，重复同值/extra/bool/LF/超长/截断均拒绝，16tests+tsc Green。
- 22:29–22:31：断连测试原要求peer half-close后立即destroy也必revoke，两个中间版本timeout；该要求错误，因为reset可使完整帧EOF不再可读。改确定性paused服务barrier，仅断言断连不杀owner/不放锁且后续正常stop仍可用，不声称丢ACK必已撤销。19tests+tsc Green；查ps无stop/lock probe残留。
- 22:33：parent新增mismatched lock/socket namespace Red(拿A锁在B建socket成功)，ControlLock暴露只读namespace路径，listener构造加exact guard；32lock+stop及tsc Green。
- 独立代码审指出accept先于expired回收导致8过期槽仍拒同tick合法stop；parent新增paused step+300ms跨真实deadline Red，旧实现关闭连接无ACK。改service先prune，22:34 stop21+tsc Green；reviewer复读并独立21/21(exit0)确认，无其它高置信当前finding。reviewer第一次suite碰到中间disconnect timeout exit1如实保留，不算当前回归。
- 22:35：parent补client namespace alias负测，原symlink目录仍发stop成功Red；client加POSIX realpath/0700/euid/type guard，22:36 lock12+stop23及tsc Green。directory权限负测原已失败，非新Red；该新增修复在reviewer独立覆盖之外。
- 22:38：加test-only getpeereid syscall注入foreign UID，client拒绝不发stop、owner仍active，stop24+tsc Green。它不是实际切换用户测试。初始缺源码断言删除，真实swiftc编译诊断保留。

22:40完整验证：build/build:fixture/build:helper/typecheck/test/check:invariants/check:package全部exit0；**287 tests / 19 files**。lock/stop源码现场编译，默认suite已运行第三进程撤销与惰性barrier、slow/expired连接、私有管道、崩溃/路径/peer负测。Node WASI experimental warnings仍存在；未声称runtime零warning。

22:42最终复跑：typecheck、287/287 tests（19files）、boundary/package全部exit0；文档checker0errors/0warnings。lock/stop tests再次现场编译，非缓存二进制验收。

这只验独立stop原语与inert排空，不验真正native停止延迟/受管输入释放。CU-010b2b生产统一namespace、用户CLI/UI入口、真实能力分发，以及CU-010c live权限/host/broker/executor/ledger组合仍未完成；CU-010父卡保持in_progress。AX成功仍未运行；无TCC/真实批准/私人应用/GUI/model操作，未提交/push/install/publish。详见 [独立停止设计](<../design-docs/independent-stop.md>)。

## CU-011a：durable host动作账本

复用原worktree/base、全部未提交。先将CU-011拆为011a host纯账本与011b生产live/native事务；依赖拆分只由parent改计划，不借host测试冒充native。

- 22:48：action-ledger模块缺失断言Red(exit1)。最小20tests Green后tsc连续两次exit2：lstat/FileHandle.stat overload ReturnType含undefined；第一次只改directory Stats未覆盖file，第二次改两者为Stats，22:51类型与20tests Green。没有忽略type错误。
- 22:52：8transport tests先因probe尚缺MODULE_NOT_FOUND exit1；这是测试脚手架缺失，不计实现bug的Red。加child probe，重建模块后22:53共28tests+tsc exit0。probe只执行惰性交接，没有native输入。
- 22:54：unknown execution原可写no_change_observed summary Red（错误resolved）；闭合unknown必须unknown effect，31unit+8transport/build/tsc Green。补canonical/hash/sequence损坏、截断tail、TTL、clock、scope/proposal/磁盘脱敏负测。
- 独立审查发现finish复用准入TTL/cancel，确定terminal在动作到期/调用取消后丢失。parent 22:55先Red(CANCELLED)，拆settlement-only revocation scope+signature/membership，仍不放新dispatch；父40tests/build/tsc Green。reviewer独立stdin推进TTL5001ms确认可finish/recover terminal，独立32tests+tsc exit0。后续父拆expired/cancelled两个独立variants，避免一个case两因素混杂。
- 独立审查另复现file.close拒绝跳过parent.close并透传原始异常，重复close复用已拒绝Promise。parent 22:59首个fault错误用prototype覆写own close，未实际命中，计数全0；修为child实例调用真实close后throw，23:00正确Red(file1,parent0,fixedErrors0)，allSettled独立清理并固定fail后43tests/build/tsc Green。该fix是parent验证，不声称reviewer独立复验；reviewer已收束。
- 22:58–23:00：parent补64queued+第65个Red，旧实现无限admit resolved；加同步queue容量，未逐出tombstone。23:02新增真实fsync后cancel/expiry，首次handoff均0，pending恢复unknown。
- 23:04：creation directory fsync失败、short write续写同record、partial pending write后throw共47tests/build/tsc Green；写失败后poison，旧id不重试。23:05 recovery finally close原生错误穿透Red，固定错误后48tests/build/tsc Green。
- 23:07：原prepare已cancel后换signal仍可pending Red；保存原signal，当前调用与原signal均检查，23:08共49tests/build/tsc Green。另补同目录第二writer拒绝/不同journal旧id拒绝，最终50项新tests。初始dynamic import catch在Green后改静态import，保留真实加载诊断。

23:09完整验证：build/build:fixture/build:helper/typecheck/test/check:invariants/check:package全部exit0；**337 tests / 21 files**。新增36unit+14transport；SIGKILL实际在prepared/pending/terminal三个阶段杀child，恢复分别replay_rejected/unknown/closed terminal；不是只断言mock。FileHandle故障仅child test进程内注入，production无test hook。Node WASI experimental warnings仍存在。

23:13文档/静态import清理后最终复跑build/typecheck/337tests（21files）/boundary/package全部exit0；文档checker0errors/0warnings，HEAD仍为原empty base，未暂存/提交。前述23:09已重建helper/fixture，未修改native输入协议。

此卡只支持A-11/13/14的host持久化子断言，未运行native变更、helper dispatch断连或掉电耐久，不是业务exactly-once。fresh journal O_EXCL不是flock/生产broker，旧journal仅只读恢复且无payload/key；没有换目录自动重试。CU-011b/live/native与CU-010b2b/c保持未完成；没有TCC/真实批准/私人app/GUI/model操作，未提交/push/install/publish。设计见 [动作账本](<../design-docs/action-ledger.md>)。

## CU-010b2b1：固定namespace与stop-only本地发现

同一worktree/base、未提交。先拆b2b1路径/发现/CLI源码与b2b2生产启动/用户可达性/安装gate。本轮只在owned /private/tmp/cu-namespace-* parent创建leaf；生产目录只计算路径字符串，未创建或stop生产controller。

- 23:18：namespace/StopDiscovery/probe源码缺失，真实swiftc输入不存在使suite exit1；实现固定euid leaf、root/setuid拒绝、owned-parent测试原语与原子发现记录后，23:20共16namespace tests+tsc exit0。独立设计审先指出ruid/euid一致性及halfwrite crash不能卡死整条namespace，采用pending完整后linkat no-replace，持锁新owner可清safe metadata残片。
- 23:21：CLI tests首跑因多余括号parse exit1，修后仍有it.each tuple展开把args当string导致TypeError；改object case再跑8项全部因缺binary/manifest ENOENT失败，才作为缺功能证据。实现stop-only CLI与build:stop脚本，23:22共24namespace+CLI/build/tsc exit0。只运行help/非法argv，未运行CLI有效production stop。
- 23:23：补live二owner不覆写、missing leaf只读不创建、normal cleanup保留替换marker、stale partial/full/linked-pair与unsafe拒绝，35tests Green。安全记录断言不把capability原值输出到测试差异。
- 23:25：test-only Swift syscall边界注入write/zero/short/filefsync/dirfsync/link错误，created/partial/linked三个实际_exit(7)崩溃点后新owner恢复；namespace fully initialized witness throw两个FD各close一次、root/ruid mismatch拒绝，39namespace+tsc Green。root与mismatch是syscall注入负测，不是实际切换用户/root运行。
- 独立代码审静态指出publisher先requireWitness后重新path open未绑定captured namespace inode。其native复现尝试被工具在执行前拒绝（无exit/test输出），reviewer未重试/读取相关secret，仅报告静态序列，未声称runtime复现或独立16tests通过。父在新test-owned Swift syscall fault中仅让旧open返回alternate目录FD，不用DYLD、不移动生产目录或探查无关文件；23:26 Red显示marker被删除(ENOENT)。namespace新增F_DUPFD_CLOEXEC复制已witness FD，publisher不再按路径open，23:27共40namespace+8CLI/build:stop/tsc Green。此红绿是parent实测，非reviewer独立修复复验。
- 后补different namespace/released lock不能publish，最终新增42namespace+8CLI共50项。未修改read helper封闭health/observe协议，不增加native变更命令。

23:29完整验证：build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0；**387 tests / 23 files**。native probe现场编译，CLI manifest source/binary digest相符；编译不启动或联系controller。Node WASI experimental warnings仍存在。

23:32最终复跑：typecheck、387/387 tests（23files）、boundary/package全部exit0；文档checker0errors/0warnings。现场重新编译namespace/lock/stop probes，CLI digest核对通过；ps未发现test probe残留，HEAD仍为原base。

只支持A-10/19 namespace/stop发现子断言。生产per-user路径成功启动、有效CUStop stop用户调用、安装生命周期、executor可服务性和native排空/受管键释放尚未验收，b2b/c父卡不完成。AX成功仍缺权限；无TCC/真实批准/私人app/GUI/model操作，没有提交/push/install/publish。设计与准确范围见 [路径与发现](<../design-docs/control-namespace.md>)。

## CU-013a：阶段准确的保守host回执

同一worktree/base未提交，先拆013a host阶段投影和013b native/evidence组合，不越过CU-012。新tracker不创建backend work或授权，仅内部closed facts。

- 23:37：receipt tracker模块缺失，25测试逐项assert Red(exit1)。实现冻结exact object ticket、scope+原signal、顺序host phases、possible dispatch unknown、closed ACK/失败、深复制/终态吸收，23:38共25tests+tsc exit0。没有增加native协议/动作工具。
- 23:40：新增provisional/copy、retry保守性、closed输入错误/limit、terminal后cancel/dispose共36tests+tsc exit0。独立设计审先钉住ACK进入verify、dispatch前EFFECT_UNKNOWN拒绝与terminal lateACK不可改，均由测试覆盖。
- 23:41：parent发现receipt schema仍允许unknown execution配unverified/no_change_observed，两项先Red（缺throw），加unknown必须unknown effect后tracker36+contracts35共71及tsc Green。规则与前轮ledger summary一致，不把schema接受当source认证。
- 独立代码审阅读7文件并复跑action-receipts --cache=false：36/36 pass，未发现可复现高置信当前bug。复核cancel/phase/ACK单调、settlement scope、immutable terminal与dispose，未跑tsc，也未声称覆盖父后加的matrix/ledger seam。
- 23:42：3真实owned journal seam验证possible dispatch后timeout→unknown durable summary、completed后cancel仍completed、target拒绝不追加pending。两真实内核由test脚本显式串联，不是production service接线；74定向tests+tsc Green。
- 23:44：新增所有closed ErrorCode跨8reachable phases的不变量矩阵为一个综合test，不把循环case虚算为多tests。tracker最终37、seam3、contracts35共75+tsc Green；移除初始dynamic import catch改静态import以保留真实错误。

23:45完整验证：build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0；**429 tests / 25 files**，本轮新增42项（37tracker、3seam、2schema）。所有native产物重新编译但不新增输入或启动生产controller；Node WASI experimental warnings仍存在。

23:47最终复跑build/typecheck/429tests（25files）/boundary/package全部exit0；文档checker0errors/0warnings。HEAD保持原base，未暂存或提交；native产物此前23:45已重建，未变更native源码。

这只支持A-12/13/27的host事实投影子断言。没有native dispatch、可信回读evidence/postcondition、任务verifier、真实批准或AX成功；ACK/target目前都是host内部报告，不是独立native身份或效果证明。CU-013b与所有native/live gate仍未完成，整体MVP仍未完成；没有TCC/私人app/GUI/model、提交/push/install/publish。设计见 [阶段回执](<../design-docs/action-receipts.md>)。

## CU-007b1：fixture生命周期witness与只读重验

本轮跨过本地午夜（2026-11-08→11-09 Pacific/Auckland），以下23时为11-08、00时为11-09；未用无时区时间作外部排程。同一worktree/base，source未提交；新命令只读不派发，b2真实AX/handle组合仍未完成。

- 23:51：新client缺模块断言Red，pure Swift policy/脚手架源码缺失使编译exit1。先实现closed identifier/element instance/op与metadata exact/ambiguous策略。23:53 fixture旧selftest未报告element_witness Red，新增真实AppKit AXHelp生命周期UUID，assert replace变/reorder不变/跨window不同/secure无标记，重建后Green。
- 实现FixtureElementScan bounded64/12/CFEqual去重/complete子树与末次node归属/metadata；FixtureRevalidation只查metadata/可设置性，不读AXValue，先process identity再TCC。新增read-only revalidate_fixture client/wire，health commands变为3项仍全capability=false，build manifest同步，observe public投影不输出elementInstance。23:57共63定向tests+tsc/build/fixture/helper exit0。
- 23:58补hidden真fixture：PID/start精确但无AX时READ_DENIED，stale start TARGET_CHANGED；fault child exact target/instance/op错配/extra/dispatchable:true全部拒绝，44tests+tsc Green。没有把stub exact当native成功。
- 23:59：parent新增Swift JSON重复command/instance同值Red（旧helper exit0处理）；仅新命令要求parsed canonical sorted bytes相等，TS递归排序不删除未知字段。00:00重建helper，49tests+tsc Green，health/observe旧编码不变。
- 独立设计审钉住children错误不得当叶子，以及selected对象可能detach但仍可读；采用完整adapter失败闭合和AXWindow归属末次检查。代码review读10文件仅静态（未运行suite/native），确认两项P2：AXIdentifier失败/错误类型吞为空，zero children跳二次count。parent编译真实AX adapter并在测试binary内API interposition，不访问实际UI/不请求TCC，00:02三项先Red（错误exact）；修明确unsupported才可缺id、其余nil，0child也二次count，00:03共53定向+helper/tsc Green。此是parent执行，非reviewer独立复验。
- 00:04 parent扩window enumeration同型负测：一window identifier读取失败或count前后变化旧仍exact，两项Red；每window identifier必取且复查count，00:05共56定向+helper/tsc Green。window-detached归属拒绝原已Green，不冒充新修复。
- 新增public投影省略native lifecycle witness测试，显式native脚本要求真实snapshot elementInstance/只读exact；初始dynamic import catch已清理成静态import，保留真实加载诊断。

00:06完整验证：build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0；**482 tests / 28 files**，本轮新增53项（21metadata/scan、10真实adapter+隔离API stub、21transport、1投影），另外扩充旧hidden fixture test。Node WASI experimental warnings仍存在。

00:10最终复跑build/typecheck/482tests（28files）/boundary/package全部exit0；文档checker0errors/0warnings。native产物00:06已全重建，随后无native源码修改。HEAD保持原base，未暂存或提交。

此前显式执行test:native-observation，真实health preflight accessibility=false，**exit3/NOT_RUN**：没有启动fixture、没有请求权限。真实AX观察+revalidation成功分支未运行，CU-006c/CU-007b2不勾完成，不绕过TCC。

此卡只支持A-04/06/21只读身份/失败闭合子断言；没有public handle到native映射、低风险rebind/native输入、生产broker/live授权或效果verifier。未操作私人app/GUI/model、未提交/push/install/publish。设计见 [fixture重验](<../design-docs/fixture-revalidation.md>)。

## CU-007b2a：host-private handle与受读授权的重验service

2026-11-09 Pacific/Auckland；同一computer-use-foundation worktree/base（2dd79be492de26f7b8f560258e2edfc4f3560a64），预存untracked实现保留，未暂存/提交。先拆host接线与真实AX成功b2b，不把CU-006c依赖降格为stub验收。

- 00:18，候选测试显式断言resolveFixtureFromHost应存在，旧store无method Red(exit1)。project同次strict parse/实际emitted handle原子建private Map，完整coverage/closed正向metadata/identifier+instance唯一性才能候选；store保留minimal target/element、clone隔离、TTL/invalidate/dispose同record，public get/resolve不泄露witness。27new+36existing共63Green，首轮tsc发现test试改readonly signal(exit2)，改为独立context后typecheck修复。
- 00:21，新service缺模块assert Red(exit1)，候选27Green；实现strict三字段request、private resolve、read grant backend前后/parse后/current host+originalsignal/TTL复检，exact全target/element比对、backend clone不修改expected，公开只含public ids和inert flags。110定向+tsc Green，未开放工具/native输入。
- 00:22，parent两项commit beforePublish gate Red：callback内过期或invalidate仍重新保存/返回。fix把committing exact ticket留pending Map至finally，同票据重入拒绝，gate后TTL/scope/成员复检。00:24共120定向+build/tsc Green；包含postparse getter revoke/expiry/invalidate/abort/throw的闭合检查，后加测试Green不冒称新修复。
- 独立设计审5reads：强调原子node→emitted handle映射、backend参数不能作可变expected、跨await/final membership复查，未运行测试。代码审8reads，独立75tests(30candidate+45service)--cache=false Green并在最新lib用stdin复现最终private lookup中host getter撤销grant仍发布exact：backendSignal已abort、返回后requireRead拒绝，非native输入。父00:28同构test先Red（promise仍resolve exact），membership后补末次requireRead/originalsignal检查，122定向（含真实helper拒绝seam）+tsc Green。独立review未复验父后续fix/新增case。
- 真实helper组合seam明确test metadata seed：先无grant零backend，host test grant后candidate→service→client→managed Swift helper；Node身份TARGET_CHANGED，未查询实际AX、不是AX成功。observe service→store→revalidate service组合成功仅fake backend单元。
- 00:32完整build/build:fixture/build:helper/build:stop/typecheck/test/boundary/package exit0，**559tests/31files**（此时为30candidate+46service，后补3项尚未加入），WASI warnings仍存在。
- 00:34 parent扩同型final授权检查invalidate观察 Red（旧仍exact），补final fresh candidate lookup+signal guard；00:35共123定向+build/tsc Green。00:36末次commit scope getter中invalidate Red（旧复活）；在所有scope/signal getter后再检exact pending成员/disposed，00:37共125定向+typecheck/build Green。并补reentrant commit单次ticket负测，原guardGreen不虚称修复。
- 显式native脚本已改真实read grant/service→观察→public handle/private candidate→read-revalidation service→exact，并要求grant revoke后拒绝。00:37实际执行test:native-observation：accessibility=false，**exit3/NOT_RUN**，preflight后没有启动fixture/请求TCC。此成功branch仍未运行，不能勾CU-006c/CU-007b2b。

00:40最终复跑build/typecheck/test/check:invariants/check:package全部exit0：**562tests/31files**。native产物00:32已全重建，之后未改native源码；WASI experimental warnings仍存在。installed project-docs checker最终0errors/0warnings；HEAD不变，staged diff为空，无提交或推送。

最终新测试32 private候选+47 read-revalidation service+1真实helper身份拒绝seam，共80项；不把fake backend/metadata成功或getter测试当native身份认证。当前只支持A-04/06/08/21的host来源/拒绝子断言；无live用户consent、Session事件、rebind、native输入、生产broker/stop/ledger组合或业务verifier。未操作私人app/GUI/model、未提交/push/install/publish。

## CU-024a：read helper本地开发产物admission gate

2026-11-09 Pacific/Auckland，同一worktree/base/source未提交。CU-024拆本地helper一致性a与依赖CU-015的完整分发/签名b，不以本卡替代native权限/发布验收。无新依赖、模型command或native输入。

- 00:46，临时canonical checkout内source改变后旧transport仍spawn到provider，期望ARTIFACT_INVALID却收到NATIVE_TRANSPORT_ERROR Red(exit1)。实现固定7Swift+recipe源清单/strict canonical manifest/currentarch+14.0/localdev/hash、regular/euid/nlink1/非groupworldwrite/无setuid+gid/canonical path/no symlink、bounded FD读与stat/path witness、binary SHA+thin64 MachO一致性。接每次transport pre-spawn，不缓存、失败脱敏，artifact检查纳入mono deadline。
- 00:47首次target33/34Green，symlink directory用例的linked-native/..在验证前normalize为合法root，失败原因是测试未真实构造中间symlink；改test自有native目录verified rename+symlink后00:48 artifact34+helper24共58tests+tsc exit0，不虚称此为production漏洞。
- 独立设计审4reads指出先compile后hash混代风险及timer尚未触发的mono截止检查；00:49 test-only compiler在临时副本中变source/recipe两Red（旧builderexit0发manifest）。修pre/postsource+recipe digest比较，new manifest只在一致时输出；2buildGreen、重buildhelper、58target+tsc Green。只防普通编辑，非私有编译快照/恶意compiler防御。
- 00:51新增6 matching-hash MachO header/CPU/filetype/loadcmd/platform/minOS mutation拒绝；独立Node FileHandle API interposition覆盖readerror/zero/short/closeerror/cancel/mono超时，每个opened==closed，preflight失败spawn0。shortread测试原50ms真实eventloop timer先到导致误判，测试budget改5000ms（非production改动），00:51共72target+tsc Green。
- 代码review7reads无新增highconfidence artifact bug，独立复跑72tests(--no-file-parallelism)exit0；提示done/parse后缺mono check，同型父已定位。reviewer另一次stdin late-done试验已被当前lib NATIVE_TIMEOUT拒绝，脚本原预期success故exit1，不能把它列新prodbug；已收束无遗留job。未跑tsc/fullsuite或后加3tests。
- 00:53父postdone/parse/abort 3case初Red，但parse两case probe误写literal反斜线n导致protocol拒绝（不是真Red）；00:54改正确LF，guard下3Green。随后移除final requireCurrent再build，00:55 corrected parse/abort两case明确Red（无error成功返回），恢复guard再次build后75target/tsc全Green；没有把测试编码问题算prod修复。done后、parse后/返回前都复查mono/cancel。

00:56完整build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0，**613tests/33files**，本轮新增49artifact+2build共51项；WASI experimental warnings仍存在。编译/manifest与gate真实匹配，health不请求权限/读UI。

01:01最终复跑build/typecheck/613tests（33files）/boundary/package全部exit0；文档checker0errors/0warnings。native产物00:56已全重建，随后无native或build recipe更改。HEAD保持原base，staged diff为空，未提交或推送。

此前实际test:native-observation exit3/NOT_RUN：artifact验证通过后health accessibility=false；不启动fixture、不请求TCC，AX成功仍不验收。没有codesign/Developer ID/notarization、fixture-stop完整分发/安装、强原子exec或publisher认证；此卡只支持A-03/14/30本地一致性子断言，不开放native输入/生产控制。未提交/push/install/publish或私人app/GUI/model操作。设计见 [helper artifacts](<../design-docs/helper-artifacts.md>)。

## CU-008a2：内部fixture read runtime与宿主事件生命周期

2026-11-09 Pacific/Auckland；同worktree/HEAD=2dd79be492de26f7b8f560258e2edfc4f3560a64，无stage/提交。先核public SDK0.2.2-rc.1 declarations和对应runtime：agent/disposed payload={agent}，session/disposed直接Session，session/event(session,event) post-commit，cwd/change source，Cordis effect exact disposer收集/逆序teardown。最初试读lib/index.d.ts不存在，随后glob定位lib/types并读取，没有据不存在路径虚称已验。

- 01:07 scope revoke两项assert Red(exit1)：authority无revokeScopeFromHost。实现cancel不阻止authority-reducing cleanup、同scope全删grant/timer后abort、epoch增长；27authorityGreen，含原25项。
- 01:09 新runtime23tests模块不存在明确assert Red(exit1)；实现private authority/store/services、每次bind actual host与random generation、exact retiredweaksets/bounded跟踪、scope gate先invalidate再撤销。01:10 50targetGreen，但tsc exit2：exactOptionalPropertyTypes的agent:undefined及测试callId未用brand。改conditional agent快照和ToolCallId，01:10 tests+tsc exit0。
- 01:12 lifecycle installer6tests模块缺失Red(exit1)。实现opt-in ctx.effect exact listener disposers+最后runtime.dispose逆序close，再offevents。测试用真实Cordis+SessionStore prepare/enter/announce/detach/committedappend、公有emitAgentEvent；Agentregistry/turn/cwd仍narrow host fixture，非完整AgentLoop。测试中未实现的plugin事件在实现前改为已有turn/start，01:13 56tests+typecheck/build全exit0。
- 独立设计4reads（3成功、1给定短路径不存在）强调容量不能丢失活授权、批量撤销先关gate；无写file或测试。代码review8reads独立56tests+tsc exit0、唯一stdin probe exit0复现same-ID无事件替换：cap1新grant READ_CAPACITY，cap64可mint，二者old signal=false；old结果HOST_CONTEXT_UNAVAILABLE拒绝，不是数据泄漏。旧scope无TTL清理可积满，P2确认。review测试job已由其完整收集，没有遗留。
- 01:15 parent getter异常Red：workingDirectory抛private-fixture-value原文泄漏。runtime bind catch固定HOST_CONTEXT_UNAVAILABLE；另getters中同步事件、原signal被调用方替换测试已Green，不虚称都为修复。
- 01:16 同ID替换parent test Red(cap1 READ_CAPACITY)；每次bind先scan bounded scopes exact registry/Agent.session，标retired并先invalidate/revoke再容量判断。60testsGreen，tsc因scope.owner string非SDK branded SessionId exit2；改用actual agent.id/session.id做lookup并比snapshot，后续tsc修复。未用不受查代码绕类型。
- 01:17 reviewer静态疑点转父3Red：target getter中policy/cwd变更仍返回失管grant，cwdgetter在最初身份检查后静默换registry仍grant。grant返回前再bind+epoch/lifetime/workspace/signal，失败撤回临时grant；01:18 63tests/build/tsc Green。
- 01:19 两transport组合seam：realSwift拒Node伪fixture身份，defaultdeny/cwd撤销后backend不增；真实managed provider执行test-only hang child，Session cwd事件→signal aborted→bounded transport cleanup→waitForExit true/done非0。65tests/tsc Green，不读AX、不冒充native observation成功。
- 01:20 parent追加cwdgetter换registry后禁止backend启动Red（原虽然最终拒publish，但observeCalls=1）。bind在cwdgetter后再核exact agents/sessions registry；3项TTLgetter触policy/cwd/dispose拒绝、69target+typecheck/build全Green；后加强composite unload行为断言：abort中真实append事件仍被监听，卸载后同append不再调用旧listener，Green。review未独立复验这些父后续修复。

01:21完整build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0，**657tests/36files**；本轮新增34runtime+6profile+2transport+2authority，共44项。WASI experimental warnings仍存在。只新增内部源码/host seam，不改package、lockfile或native源码，不在plugin入口激活runtime/新tools。

01:26最终复跑build/typecheck/test/check:invariants/check:package全部exit0，仍657tests/36files；installed docs checker0errors/0warnings，HEAD未变、staged diff为空。无native或recipe更改在01:21全重建之后。

此前test:native-observation仍exit3/NOT_RUN（Accessibility absent），不启动fixture、不弹权限。完整AgentLoop/WorkingDirectoryService/生产consent与control生命周期、AX成功/native输入/实际stop drain/GUI/Profile安装/发布均未验。runtime.dispose仅关闭admission/取消，不返回drained；真实fault child退出由transport测试单独证明，不推广生产SLO。设计与准确剩余gate见 [read runtime](<../design-docs/read-runtime.md>)。

## CU-014a：默认拒绝的内存artifact暂存，不采集/落盘

2026-11-09 Pacific/Auckland；同隔离worktree/HEAD base，预存未提交实现保留。CU-014拆a内存资源基础（Depends003/007a/008a2/013a）与b实际capture/磁盘/崩溃清理，a不替代native截图或private数据授权。只新增内部evidence store/测试/文档，不改依赖、native协议、plugin入口或宿主审计。

- 01:34 43项store tests模块缺失assert全部Red(exit1)。实现enabledFromHost默认false、strict stage spec、opaque single-use ticket、pending/committing reservation+records容量、per-item1MiB、captured intrinsic Uint8 length/buffer/set（不调用source byteLength/slice）、拒shared/resizable、逐stage/publish/read同步严格true授权、scope/mono TTL/epoch/末次membership与固定错误。所有payload为公开合成bytes，不是真截图/PNG认证。
- 01:35 43Green，typecheck exit2因tsconfig基线lib未声明ArrayBuffer新两参重载。测试改Reflect.construct同一真实runtime resizable ArrayBuffer（未修改生产检查或tsconfig），随后typecheck通过。
- 01:36无人访问timer清理test Red（旧只机会prune，仍可读）。增加pending与record unref timer、commit按剩余TTL重挂、所有清理clear timer；mono每次核对不续期。两finalsignal getter invalidate的case本已Green，未冒称额外修复。01:37 46tests+tsc/build exit0。
- 独立设计审4reads强调exact true、metadata-only authorizer、committing保留reservation、intrinsic bytes与shared拒绝，无测试。代码审5reads，独立当时46tests/tsc exit0，唯一stdin probe确认async authorizer throw：同步ARTIFACT_DENIED但unhandledRejection=1、callback原文逸出，P2。review job已完整收集，无file写入/第二probe，后续父修复未独立复验。
- 01:39 50store+3真实read authority seam=53tests/tsc Green。组合仅验证已有grant defaultdeny与stage/publish/read每次检查、grant撤销和scope隔离，不把read grant当capture/disclosure生产许可。
- 01:41 parent hostcontext getter异常3Red（原begin/commit/read透传源异常），#operation仅自有error类型保留其它固定ARTIFACT_UNAVAILABLE；59tests+build/tsc Green。后补detached/subarray/originalstage signal和returnedcopy保留，未虚称全部为修复。
- 01:42 隔离Node真实copy API interposition确认owned view在deny/invalidate/dispose被fill0，输入与returnedcopy不变，不注入生产inspection hook；60tests/tsc Green。此test只证明本代码覆盖自有view，不是OS安全擦除/副本追回。
- 01:43 async authorizer child test Red：Node child exit1/源错误PUBLIC_ASYNC_AUTH_REFUSAL逸出，同独立review根因。修isPromise+captured Promise.then观察拒绝但从不授予；不assimilate arbitrary thenables。三阶段stage/publish/read都在child验证拒绝且无unhandled；01:44 61tests+build/tsc exit0。
- 01:44全产物build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package exit0，718tests/38files（尚未加2cleanup errorcase）。随后parent补discard/invalidate hostgetter异常两Red并固定revocation快照错误，01:46 63target（60store+3authseam）+build/typecheck exit0。

01:48最终build/typecheck/test/check:invariants/check:package全部exit0，**720tests/38files**，本轮新增60store+3authority seam共63项。native产物01:44全重建后无native或recipe改动；WASI experimental warnings仍存在。

同轮实际test:native-observation exit3/NOT_RUN（AX权限缺失），未启动fixture/请求TCC。无capture/PNG decode/截图geometry/coherence、无磁盘manifest或路径fence/symlink删除、无runtime Session生命周期接线/公开route/verified evidence。TTL timer是eventloop best-effort，不承诺绝对擦除时限、swap/core dump或已返回copies擦除。详见 [内存artifact边界](<../design-docs/ephemeral-artifacts.md>)，父CU-014/CU-013b等仍未完成。最终installed docs checker0errors/0warnings、HEAD不变/staged diff为空，无提交/push/install/publish/私人app/GUI/model操作。

## CU-014a2：内存artifact私有宿主接线

2026-11-09 Pacific/Auckland，同worktree/HEAD=2dd79be492de26f7b8f560258e2edfc4f3560a64，经pwd/status核对所有实现仍untracked、无commit/stage。先补依赖已满足的014a2子卡，不将capture/磁盘或AX成功依赖提前完成。

- 01:53 private observation target两项明确assert Red(exit1)：ObservationStore无fixtureTargetFromHost。实现target在commit内一次strict parse，同validated值用于投影+private record、空nodes可查、scope/TTL/clone。2targetGreen。后来追加caller pid getter只读一次case本已Green，不冒称修复。
- 01:55 runtime artifact21项assert Red(exit1)：stage/read入口不存在。新增FixtureArtifactService私有store，runtime显式options默认false+独立authorize、host-only strict observationId/maxBytes stage、internal begin+commit、每次read重新独立授权；包装callback前后重新bind actualhost/observationtarget-membership/readgrant。
- 01:56 88/89targetGreen，1个TTL test没抛错。调查为vi.fakeTimers控制global performance却没控制node:perf_hooks实际monotonic clock，并非生产TTL条件失败；测试以spy actualperformance.now推进15000ms后89Green。随后typecheck exit2为未使用type import，移除后修复；不修改生产clock扩大test seam。
- 01:58 真Cordis/SessionStore新增4case Red（factory忽略传入options，正向stage被ARTIFACT_DENIED）。factory显式转交typed options，默认仍关闭；99target+tsc/build exit0。event覆盖committed cwd、store detach、public Agent emit、fiber卸载/重载，Agent registry/turn/cwd仍窄host seam，不是完整AgentLoop/生产Profile。
- 独立设计审3reads无测试，强调target同次parse与async wrapper保持Promise给store处理。代码review7reads实际105target+tsc exit0，无确认新增P1/P2、无stdinprobe/写入；job已收集。未复验父随后getter异常fix或childprobe，不扩大review背书。
- 02:03 child真实built runtime wrapper三阶段rejectedpromise均拒绝且无unhandled；捕获真实copy API产生的owned view，在workspace/policy/dispose grant abort通知中断言已全0，reentrantgrant/read拒绝，迟到backend结果不publish。不注入生产inspecthook、不宣称returned副本/OSmemory清除；106target/build/tsc Green。
- 02:04 build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全exit0，754tests/39files。之后仅TS/test/doc更改，无native/recipe改动。
- 02:05 4个execution signal/actual Agent.session getter异常case Red（原文sentinel泄漏）。统一snapshotCall安全单读agent以及#bind own-error边界，外国异常固定HOST_CONTEXT_UNAVAILABLE，保留既有fixed READ_CAPACITY/READ_DENIED语义。另补16entries真实满额scope清理后可再存16与policy递归stage被拒，本已Green。02:06 112target（35candidates/34runtime/33artifact/10profile）+build/tsc exit0。

02:07最终build/typecheck/test/check:invariants/check:package全部exit0，**760tests/39files**；本轮新增33runtime artifact+4profile+3target共40项。WASI experimental warnings仍存在。02:05显式test:native-observation exit3/NOT_RUN，AX权限缺失，不启动fixture、不请求TCC或绕过。

此切片只把默认关闭的memory store接内部opt-in工厂，合成公开bytes须live观察target/read grant以及独立artifact host policy，policy通知清旧store/建空store，不签发用户consent。没有native capture/PNG decode/截图coherence/disk/URL/下载route/verified evidence、没有生产入口激活/控制工具。观察TTL后即拒访问但ownedbytes可留至artifact TTL或scope cleanup，不声称观察过期即擦除。亲自设计的同UID恶意intrinsics/Promise species不是此普通async回调保护的沙箱保证。完整边界见 [内存artifact接线](<../design-docs/ephemeral-artifacts.md>)。最终installed docs checker0errors/0warnings，HEAD未变/staged diff为空，无提交/push/install/publish/私人app/GUI/model操作。

## CU-008b1a：共享host scope与inert控制租约生命周期

2026-11-09 Pacific/Auckland，pwd/status/HEAD核对同隔离worktree/空base2dd79be492de26f7b8f560258e2edfc4f3560a64，全部实现仍untracked，未stage/commit。本卡Depends008a2/008b1/014a2，不依赖未验的native成功，不把mocklease当真实consent。

- 02:13 scope revoke新增assert Red（无revokeScopeFromHost）；实现exact scope全量delete/clear timers后首个abort，callerabort不阻止authority-reducing cleanup、另一lifetime保留。26policyGreen（含原25）。
- 02:14 新inert controlruntime19tests模块缺失明确assert全部Red。按已有readruntime提取HostScopeRegistry: per-instance private generation/exactAgent/Session/retired/map、scope容量与换对象退役、epoch/changing与close gate；snapshotHostCall安全单读agent/signal。readruntime改组合cleanup，先观察/artifact后authorityabort，无native/entry change。
- 02:16 提取后79read/artifact/profile/transport旧targetGreen，tsc exit2仅因新controlruntime还不存在（与Red缺feature同源），不以此声称编译通过。实现control私有policy+explicit issue/evaluate/signal，19controlruntime+旧policy/read/profile共89tests、tsc/build exit0。
- 02:18 control lifecycle factory5tests缺模块Red；抽共installScopeLifecycle exact yield disposers+逆序close-first，read/controlfactory复用，同public Agent payload/SessionStore detach/cwd committed事件。129testsGreen，typecheck exit2因测试turn/start缺required turn，改{turn:1}不绕类型。
- 02:19 两request targetgetter原异常透传Red，三execsnapshot redaction case本已Green；新增安全closed parser控制policy+evaluation DTO，INVALID_REQUEST固定脱敏；02:20 134tests/tsc/build exit0。
- 独立设计审3reads，无测试，强调cleanup gate必须覆盖全部abort与最后policy lookup后的host检查。代码review8reads、139tests/tsc exit0，未确认新增高信finding，无stdinprobe/写入；job完整收集。其结果在父后续修复前，不算修后复验。
- 02:21追加三last policy clock call触发policy变化拒绝、rawDTO leaseId只读取一次、单caller取消不撤lease；29control tests/tsc Green。之后真实read/control交叉id拒绝、backend不启动和nested teardown事件后offlistener测试本已Green，02:22 79target/build/tsc exit0。
- 02:23 finalcwd getter在最后bind中无event关闭turn仍mint Red，补read同型再次两Red。sharedregistry在cwd后重新turnBoundary/open/lastTurn与originalsignal，再exactregistry/epoch/retired；02:24 143target+build/tsc Green。未靠不断重读cwd虚称恶意getter原子快照。
- 02:24 完整build/build:fixture/build:helper/build:stop/typecheck成功，首次fulltest **798pass/1fail**。helper取消case假设100ms必已spawn；实际ARTIFACT校验await期间timer可先abort，结果正确CANCELLED但provider.owned=0。未修改产品deadline/产物gate/取消逻辑。初试读取两个猜测support路径不存在，随后read实际helpertest/transport/faulthelper查明，不据不存在文件声明证据。
- 修test-only faulthelper新增hang_ready，stdin已读后发public TEST_HELPER_READY；test在真实managed stdout完整ready帧后abort（流分段累积），断言CANCELLED、ownedexact1与waitForExit=true，无sleep/固定spawn时间。02:26 24transporttests/tsc exit0，preabort lane仍断言0spawn，不将其混入runningcancel。

02:26最终build/typecheck/test/check:invariants/check:package全exit0，**799tests/41files**；新增31controlruntime+6controlprofile+1policy-scoperevoke+1readfinalturn共39项。native三产物02:24已全重建，此后无native源码/recipe修改；WASI experimental warnings仍存在。

同轮显式test:native-observation exit3/NOT_RUN（Accessibility absent），不启动fixture/请求TCC。私有inert control与read仅共享scope/事件代码不共享authority/generation；没有native execute/审批调用/队列工作/broker/ledger事务/新增tool或生产入口安装。scopecleanup gate不是native drain，返回signal不是执行许可，所有decision仍dispatchable=false。真实AX/consent/模型/GUI/发布/私人应用未运行，整体MVP未完成；见 [内部控制runtime](<../design-docs/control-runtime.md>)。最终installed docs checker0errors/0warnings，HEAD未变/staged diff为空，无commit/push/install/publish或日常Profile改动。

## CU-009a2：private批准与live inert控制租约组合

2026-11-09 Pacific/Auckland，pwd/status/HEAD再核同隔离worktree/2dd79be492de26f7b8f560258e2edfc4f3560a64；全实现untracked，无stage/commit。只拆Depends008b1a/009a的host-only组合子卡，不认证native/read observation，不调用真实批准/输入/队列。

- 02:32 kernel新增4tests Red：缺full-envelope decideBoundFromHost、exactscope invalidate/discard；prepare getter触invalidate后仍建record，consume脱Map期间allinvalidate后仍consumed。加epoch（operation开始、最后核，空Map也推进）、strict完整envelope decide先比HMAC再outcome、scopecleanup允许abort、失败publication可discard。02:34 31kernel（原27+4）/tsc Green。
- 02:35 新runtimeapproval27tests全部明确入口assertRed；新增private FixtureApprovalService，hostproposal closedparse一次，riskReason/mode/versions由live policy/lease取，policy必须REQUIRE_APPROVAL，caller+lease signal组合，kernel前后重新requireCurrent。controlruntime闭包在rawparse前固定original scope/epoch/turn，三阶段hostonly API、cleanapprove先于leaseabort，无公开kernel或真实prompt。raiseRisk单独加入canonical绑定，host改变risk输入即使reason不变也失效。
- 02:37 89target（27runtime/31kernel/31control）+tsc/build exit0。后续rawgetter改turn/固定异常、末次binding处scope退休均Green；profile增加真实Session/Cordis四类事件后迟到模拟hostPromise答复拒绝，以及成功false消费，02:38 107tests+tsc/build exit0。未把Promise模拟当真实批准UI。
- 独立设计审3reads无测试，强调originalturn固定与空Map/in-flight撤销屏障。代码review7有效reads（另2次limit参数验证失败未取内容）、115tests/tsc exit0，唯一stdinprobe复现kernel精确discard对脱Map consume不生效；严格hostkernel限域，runtime私有+DTO提前parse，不宣称rawgetter可达或native/consent bypass。review任务job与probe均收集，无file写/第二probe。
- 02:39 加64满额scope清理释放、两个异步schedule单赢家、三lastpolicyclock撤销与kernelclockinvalidate保护、crossscope不能决定/消费/删除他人id、5秒lease先于60秒approval、raiseRiskcanonical，02:40 119target/build/tsc Green。部分本已Green的case为新增验证，未声称全部修复。
- 02:41 build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全exit0，854tests/42files。此时尚未修review精确discard。
- 02:43 parent精确discard Red1与唯一独立probe同根因：consume先从Map删除，getter中discard无record/epoch不变，仍consumed。确认内核撤销一致性P2（非runtime执行突破）；改record.consuming先置但留Map，#record拒consuming、末次核exact membership，finally删/zero digest及临时比较digest。discard不需全局影响别scope；保留容量reservation到finally。补sameidrecursiveconsume拒绝与失败后不replay，02:44 121target/build/tsc Green。review未复读或复验修后case。

02:45最终build/typecheck/test/check:invariants/check:package全部exit0，**856tests/42files**；本轮新增42runtimeapproval+5profile+10kernel共57项。native产物02:41全重建后无native/recipe改动，WASI experimental warnings仍存在。

同轮显式test:native-observation exit3/NOT_RUN（Accessibility absent），不启动fixture/请求TCC。没有真实approval.request/交互答复器、native输入、coordinator工作、账本事务、新工具或生产入口启用。approval service只验证host声明proposal与现live inert lease/risk，不认证observation/material membership/targetnative/actionId签名，不刷新预算或产出dispatch许可。真实consent/AX/效果/stopdrain/模型/GUI/安装发布均未验，整体MVP仍未完成；见 [批准设计](<../design-docs/single-use-approval.md>)。最终installed docs checker0errors/0warnings，HEAD未变/staged diff为空，无commit/push/install/publish或日常Profile改动。

## CU-010a2：private lease claim/固定policy评估与停止生命周期

2026-11-09 Pacific/Auckland，再核pwd/status/HEAD仍指定worktree/2dd79be492de26f7b8f560258e2edfc4f3560a64，全实现untracked/staged空。拆Depends008b1a/009a2/010a子卡，只运行固定inert policy.evaluate，不接受callerwork或executor，不消费批准、不charge、不组合ledger/native。父CU010c仍未完成。

- 02:50 三Red：policy缺private完整targetclone，queue缺batch exactscope cleanup，target getter调用stop后claim仍publish。policy增加fixtureTargetFromHost；queue增加changing/epoch与batch/allinvalidate，先标全部命中claim/删除queued再activeabort，active物理target/slot留至settle。enqueue外部current后复核，保留原有stop→resume错误码CONTROL_CLAIM_INVALID；新增test async matcher先保存catchPromise再await，去除未await警告。02:52 原49policy/queue Green。
- 新14runtimecases明确缺claimTargetFromHost assertion Red，新增private FixtureSchedulingService与controlruntimeclaim/queueEvaluation/release/status/drain/stop/resume。hostclaim取livelease完整target，排队strict DTO及lease/五字段match，稳定any(caller,lease) signal，每call pinnedturn/scope/epoch。另一scope清理会推进全局epoch，使其它旧queuedcall保守拒绝；修测试预期并另证freshcall继续使用其未撤claim/lease，不降低屏障。02:57 63target/tsc/build Green。
- 02:58 额外cases：kernel cleanup ownergetter中重入还可claim（Red→context读取前先gate）；claim最后policyclock变turn仍publish（Red→末次复绑定）；真实四类Session/Cordis事件清理。test修正3个非产品错误：漏event参数、spy从较大performance.now退到100触真实CLOCK_UNAVAILABLE、Cordis异步dispose请求不等于closeeffect已运行（允许该固定同步work在实际close前returned，断言close后永拒）。03:00 62target Green，typecheck先暴露只读exec.signal test赋值TS2540，改test Object.defineProperty做source替换模拟后tsc/build Green。
- 03:01 加caller取消不撤claim/lease、queued30秒TTL、cwd漏事件/sameID替换、latercall可用claim、64pending。容量test原await overflow assertion后才stop，首项可microtask settle，因此allcancelled失败；test改先拿overflowPromise→同步stop→await，非产品改变。03:02 父两个新Red：HostCall.agent getter在入口gate后stop仍mint新lease；finalcwd getter把mono推进deadline但未触timer后claim仍返。加snapshot后/绑定后stopped重查与末次lease复查；03:04 143target+tsc/build Green。
- 03:05 父补getter内stop→drainedresume Red（布尔stopped已恢复仍mint），加stopVersion捕获在snapshot前，所有现有admission/固定current保留version，03:07 144target+tsc/build Green。stop先版本关门，再queue.stop、全撤lease/批准，resume需非changing/notdisposed与queue drain，旧id不恢复。
- 独立设计审严格3reads，无运行，强调transactiongate与stablecombinedsignal/exacttarget。代码review严格7有效reads（另1次limit校验拒绝），无新增保留高置信finding。唯一4target suite捕获并发测试快照98项中97pass/1fail（上述容量test旧microtask假设），typecheck0；非最终全green。唯一stdinprobe用Node24.21原生TS hook直读当时current src，HostCall.agent getterstop在issue第一步被二次gate拒CONTROL_STOPPED，旧漏洞预期未到达而exit1，未完成后续resume分支；无文件/第二probe。父已调查/修测试，独立审不声称复验后续stopVersion/排序fix。
- 03:08 build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全exit0，897tests/43files。之后33rdcase Red证实第二次末端policyclock改turn又能publish（先前重复host/policy顺序只迁移窗口）；改内部requireCurrent optional validator：host bind/cwd→livelease/target→open turn/exactregistry/epoch再查，不重新读cwd。不是对任意恶意hostgetter/clock的原子快照，host服务仍可信边界。03:13 180target/6files含readruntime回归+tsc/build Green。test clock触发计数按少一次lookup调整，仍保持真实deadline/turn不放行断言。

03:15最终build/typecheck/test/check:invariants/check:package全exit0，**898tests/43files**；新增33runtime+4queue+1policy+4profile共42项。native三产物03:08全重建后无native源码/recipe改动；WASI experimental warnings存在。排队只暂持隔离DTO，不持rawgetter闭包，不写输入日志/磁盘，不声称secureerase；actionId仅格式标签不幂等。这里workStarted只表示固定policy闭包，不表示原生工作。

同轮显式test:native-observation exit3/NOT_RUN（Accessibility absent），未启动fixture或请求TCC。没有native executor/真实prompt/独立UDS或CLI生产接线/ledger事务/新modeltool/入口runtime安装，JS hoststop不解决阻塞JS和native排空。生产broker、授权/观察引用认证、业务效果/模型/GUI/分发与整体MVP仍未完成；见 [协调设计](<../design-docs/host-coordination.md>)。最终installed docs checker0errors/0warnings，HEAD未变/staged空，无commit/push/install/publish或日常Profile改动。

## CU-007a2：private观察派生action-intent

2026-11-09 Pacific/Auckland，再核pwd/status/HEAD同指定worktree/2dd79be492de26f7b8f560258e2edfc4f3560a64，staged空/实现untracked。拆Depends007a/007b2a/008a2的host-only来源绑定子卡，不用未完成AX成功前提，不扩成control授权或执行。

- 03:21 首18runtimeintentcases中17Red缺stageAPI，1个宽泛toThrow假Green（helper内部缺API assertion被toThrow吞掉），马上补顶层API assertion，后续不以该假Green证明成员拒绝。新增private FixtureActionIntentService+readruntime hostonly stage/consume，strictrequest一次parse、live观察privatewitness/readgrant、keyedmaterial/输入HMAC、exactobjectticket、owner后markconsuming留Map、finally删/清digest，64lim/10s/timer/combinedabort。03:23 86target（18intent+35runtime+33artifact）/tsc/build exit0。
- 独立设计严格3reads，无运行，要求foreign检查在rawgetter前、consuming membership保留和原mono deadline/parse前年龄；父新增finalclockturn2case与rawgetter推进10s年龄1case均Red。clockcase触发点原算12/6超出实际10/5，校正后确认真实Red；stage年龄移到parse前，最后ownclock移入internal current validator（hostcwd→dependencies/ownclock→turnregistry），最终无getter检查Map/signal/epoch。新增原caller取消、重入consume、policygetter、固定异常和4个真实Session事件重载拒绝，03:26 75target/tsc/build Green。
- 03:28 新Red：14s stage→consume最后ownclock推进至观察15s截止，但own10s未到，仍返candidate。不是native执行突破，但违反继承观察TTL。新增internal ObservationStore.actionIntentSourceFromHost（candidate+storedrevision+原mono deadline）Red1，新增readpermit.monotonicDeadline断言Red1；production把intent deadline夹min(stage起点+10s,原obsdeadline,原readgrantdeadline)，不再靠循环读clock挪动末端窗口。sourceclone隔离/原期限负测Green，finalclock触发计数随lookup减少改为stage8/consume4，仍断言真实turn/deadline拒绝。03:29 130target/tsc/build exit0。
- 独立代码审严格7成功reads，无额外source/docs/probe/写入；唯一4target suite job112tests=111pass/1fail（正是上述已知继承obs最后clock Red），另tsc exit0，总exit1已调查。确认owner-beforeparse、foreign不burn、singlewinner/Map撤销可见/privatekey不留raw、intent先于grantabort；无新增高置信finding。父130Green是修后快照，review未扩读/复验，不伪称独立全绿。所有其job已收齐，probe0。
- 再加secure/disabled/truncated/missing/duplicatewitness五类、twoMicrotask单赢家、forge getter从不读取、clockregression、最后clockpolicyclear2phase、cwd/sameID、shortgrant5s/getter跨期与最后clock跨期；均验证candidate始终false且不增加backendcalls。03:30 103target与03:31 56target/tsc/build Green，本次42runtimecases+4profile+1store共47新增，readgrant原期限是在既有case增断言不新增case。

03:32 build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0，**945tests/44files**。native三产物同轮全重建；WASI experimental warnings仍存在。privateintent只保留HMAC/scope/原grantid/组合signal/timer/deadline，不保留action/value/rawclosure，调用方消费需重给proposal；JS Buffer清零非secureerase。消费返target/material只证明当前host内已存观察的成员/绑定，**不是当前native identity、controllease、真实approval、ledgerdedup或dispatchpermit**；read/control generation/authority仍分离。

同轮显式test:native-observation exit3/NOT_RUN（Accessibility absent），不启动fixture/请求TCC。不新增modeltools/入口runtime安装/调用backend/native/审批/queue/ledger事务，没有真实AX/consent/效果/GUI/model/发布验收；当前control proposal仍host声明，CU008b2/009b/010c/011b未因intent完成。整体MVP仍未完成；见 [观察生命周期](<../design-docs/observation-lifecycle.md>)。最终installed docs checker0errors/0warnings，HEAD未变/staged空，无commit/push/install/publish或日常Profile改动。

## CU-013a2：private固定评估结果→终态回执

2026-11-09 Pacific/Auckland，pwd/status/HEAD再核同指定worktree/2dd79be492de26f7b8f560258e2edfc4f3560a64，全实现untracked/staged空。按Depends008b1a/010a2/013a拆host-only准确回执接线，不依赖未完成真实native12，也不解锁父013b或输入。

- 03:41 新runtime16cases+kernel1均Red，缺queueEvaluationReceiptFromHost和cancelScopes/all。新增private FixtureEvaluationReceiptService，pinnedcurrent先于rawgetter，strictDTO一次parse、postparsecurrent后begin/authorize；private固定scheduling.evaluate复检，按真实policy/queue结果fail封终态，无ACK/target/dispatch方法外泄。ALLOW只能CAPABILITY_UNAVAILABLE/authorize（无executor），REQUIRE到approve/APPROVAL_REQUIRED无prompt，DENY保留closedcode，取消CANCELLED/cancel、rebind/未知固定CONTROL_DENIED。所有execnot_executed,targetunknown,effectunverified/tasknot_evaluated,evidence空。
- runtime scope/policy/stop/dispose第一步sealreceipt再清queue/abortlease；tracker新增exactscope/allcancel不清actiontombstone，latecontinuation先terminal只读深复制，不要求退休host live、不推进新事实。03:42 87target Green，typecheck因test预留performance未用TS6133 exit2，随后补真TTLcase使用，非production问题。
- 03:43 capacitytest Red：queue容量拒绝错误都归CONTROL_DENIED，失去准确gate原因；queue改私有QueueFailure/classification helper只识别本模块固定capacity，不读任意error.message/code。父加source任意throw getter装CONTROL_CAPACITY断言不访问/不泄漏。独立设计严格3reads还静态发现kernel只凭TARGET_CHANGED就报invalid，即使仅authorize；父Red复现，收紧仅revalidate阶段目标失败invalid，policy target仍unknown。03:44 116target/tsc/build Green。
- 03:45 新真实Session/Cordis四事件nonexecution终态、64terminal容量/policy不回收、rawgetter单次、foreign/copyclaim不能凭actionId取ownerreport、stopdrainresume不复活、leaseabort重入拒绝。82target/3files/tsc/build Green。又加kernel scopedcancel保存pendingunknown/ACKattempted/ACKcompleted三case、receiptsettlement前turn变化/不chargebudget/真实DENY区别unsupported三case，03:47 91target/tsc/build Green。
- 独立code review严格7成功reads，无source/docs扩读/写/安装/native/TCC/UI/子agent；唯一4targetsuite115tests（24runtime/39kernel/33scheduling/19profile）及tsc全部exit0，无新增高置信finding、probe0。其2个后台jobs均收齐；父后加3runtime+3kernel未由review复验，只算父fresh全量证据。

03:47 build/build:fixture/build:helper/build:stop/typecheck/test/check:invariants/check:package全部exit0，**981tests/45files**；新增27runtimeevaluationreceipt+5kernel+4profile共36。native产物同轮全重建；WASI experimental warnings仍存在。队列workStarted只表示固定policy闭包，不能改变receipt execution；终态不是排空ACK，仍需queue.waitForDrain。此actionId只是host声明opaque形状/本实例conflict，无ledger签名认证/持久恢复；私有tracker只留阶段事实，不留raw/input/evaluationDTO，不支持工具查询他人记录。

同轮test:native-observation显式exit3/NOT_RUN（Accessibility absent），无fixture启动/TCC请求。没有nativeexecutor/实际审批/输入/可信readback/ledgerdispatch事务/生产stopbroker/新增tool/入口runtime安装，真实AX/consent/model/GUI/签名安装仍未验，整体MVP仍未完成；见 [阶段回执](<../design-docs/action-receipts.md>)。最终installed docs checker0errors/0warnings，HEAD未变/staged空，未commit/push/install/publish或改日常Profile。

## CU-002c：固定foundation runner与机器可读NO-GO

2026-11-09 Pacific/Auckland，pwd/status/HEAD再核指定computer-use-foundation，HEAD/base仍2dd79be492de26f7b8f560258e2edfc4f3560a64；全部实现untracked/uncommitted，staged空。按CU-002a/b新增子卡，不以缺native权限停掉可独立完成的开发验证，也不把此卡当CU-028/MVP已完成。

- 03:59 首18reportcases全部Red，缺真实report模块；新增strict Vitest4.1.10分母/逐assertion校验、固定8steps、精确native缺权限/exit优先级与NO_GO投影。04:00 10sourcecases全部Red，缺sourceenumerator；最小实现限定四目录+六rootfiles的排序path/长度/内容hash及bounded nofollow/metadata前后复查，不读依赖/产物/docs/.local。04:02 30targettests/2files Green（report20+snapshot10）。
- 04:03 5copiedrunnercases全Red缺runnableentry；实现entrylocation固定cwd/process.execPath+硬编码argv，不运行manifest.scripts、不接受customcommand/output/权限参数。首次失败不继续，optionalnative先验prereqs/source，signal/timeout/outputbound固定失败，原文不写summary。首Green尝试4fail归VERIFICATION_UNAVAILABLE，经调查test-only gitstub用require但copied package为ESM，改import；余1fail是断言PRIVATE_误匹配固定PRIVATE_DATA_NO_GO，改只禁PRIVATE_TEST_PATH/PRIVATE_LABEL。不是production绕过/隐藏失败，之后42target/3files+tsc exit0。
- 独立设计3reads强调固定实际argv不只是命令名、锁定Vitestfile/suite差别、分母/skip/todo、source非完整执行闭包与native缺权限优先级。父读取锁定Vitest真实reporter格式后据此校验，不凭猜测sum嵌套suites。添加setup/snapshotfail、unknownstate/矛盾/负数、skip/todo、path/长度绑定等测试，最终26report+11snapshot+5realcopiedrunner=42新增。
- 独立code review恰好7reads，未扩source/docs/写/build/native/TCC/UI/install/子agent/probe；唯一三target42tests/3files及tsc均exit0、两jobs输出收齐，无新增高置信finding。copiedstub是实际subprocess seam，不代替本机完整/native验收；父1023全量不冒充reviewer独立运行。

04:06 实际managedNode直接 `node scripts/verify-foundation.mjs --native-observation`：8steps全部exit0，**1023tests/48files，failed/pending/todo=0**；限定源码133files/885995bytes，前后digest相同，HEAD同base、dirtytrue。显式native固定Accessibility缺失，NOT_RUN/exit3，整体exit3且releaseDecisionNO_GO/nativeControlfalse/privateDatafalse。该显式lane未请求TCC/启动fixture，没有输入；基础suite另有既有hiddenfixture自测，不能把lane未启动误写为全suite未启动。缺权限不是passed/静默skip。

04:13 最终再跑相同固定命令并以noclobber留本机JSON，仍8steps0/1023tests/48files/zero failedpendingtodo/相同source，整体exit3。runId=`356484e5-b8db-4945-bce9-ffdb1deb913a`；UTC2026-11-08T15:13:31.775Z至15:13:44.164Z（Pacific/Auckland为2026-11-09 04:13）。sourceDigest=`5cfcb2236fc7b38b824e345bb335f693a626b385c3cfdcc83e8ba97665a1939f`；helperBinaryDigest=`e67f648de923e976aead1a30ee50bd65cfe0fab92d205dda9a3e3968c6f5018f`、helperManifestDigest=`4c1515d9e34bd9857245602ddba2a85470b21c4cda599b35f92aa36f0874b037`。Node24.21.0/arm64/Darwin27.0.0/SDK0.2.2-rc.1/TS6.0.3/Vitest4.1.10；这是开发checkout限定源码一致性，不是全依赖闭包/原子snapshot/签名认证或最低OS证明。报告不留原始stderr，WASI warning依旧是已知环境边界，不声称已消除。

准确用法与保障边界见 [固定验证器](<../design-docs/foundation-verification.md>)。新 [当前交接](<../exec-plans/current-handoff.md>) 列明untracked代码/NO_GO、完整未完成gate与下一host-only可信来源票切片。没有nativeexecutor/liveconsent/生产stop/效果验证/真实应用/Profile/UI/model或签名发布验收，不能以此完成整体MVP或标goalcomplete；目标保持active，未改capability、官方审计或日常Profile，未commit/push/install/publish。最终installed文档checker独立返回0errors/0warnings；HEAD未变/staged空。该检查不能被8step绿灯代替，也不证明文档语义或完整MVP已验收。

## 2026-11-09：用户授权创建 Draft PR

17:23 Pacific/Auckland用户直接请求创建PR，单独授权提交/推送现有foundation。复核仓库public、远端无heads、无已有PR、GitHub有push权限；仅将原无文件root `2dd79be492de26f7b8f560258e2edfc4f3560a64` 建为main基线，功能代码只进入computer-use-foundation分支，不自动merge/install/publish。保留隔离工作树及忽略的本机workspace metadata。相应更新README/授权事实/当前交接，历史未提交记录保留其运行时语境。

审查177个待提交source/config/docs文件，明确排除.local/node_modules/lib/dist、产物、日志与本机工作树metadata；对src/native/scripts/tests/docs做固定凭据格式/用户绝对路径扫描，无命中（不是完整秘密或安全认证）。`git diff --cached --check` 首次发现approval adapter行尾空格及本记录多余EOF空行，纯格式修复后exit0，无行为变更。没有更改能力、TCC、官方Session审计、原生协议或运行授权。

17:27再次执行固定 `node scripts/verify-foundation.mjs --native-observation`，runId=`fe425557-9af9-4b62-a9dd-f58bc230d0d8`；UTC2026-11-09T04:27:39.890Z至04:27:55.243Z。8steps均exit0，**1023tests/48files，failed/pending/todo=0**。source133files/885994bytes，前后digest=`ebb1047755fb589e7bdabfe4e8fbff6f3e61686b3305ffe28bf998d3fa8b2199`一致（比04:13少1byte是上述trailing space清理），HEAD为root且dirtytrue。显式native-observation固定缺Accessibility，statusnot_run/exit3，整次exit3且NO_GO/nativeControlfalse/privateDatafalse；该显式lane未启动fixture/请求权限，基础suite仍有hiddenfixture自测。helper摘要保持前次相同。installed文档checker0errors/0warnings、staged whitespace checkexit0。

以上是提交前源码树证据；创建PR后还需对实际头提交再次运行固定验证器并在PR正文记录准确SHA/结果，不用早先dirtyHEAD冒称已测committedhead。此PR只是foundation审查，不是MVP完成、完整安全审查、native成功或Alpha发布。真实AX/输入/consent/生产停止/效果验证/UI/model/真实Profile与分发gate继续未完成。

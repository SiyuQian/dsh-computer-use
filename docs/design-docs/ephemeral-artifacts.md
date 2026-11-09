# Ephemeral artifacts：CU-014a/a2 内存暂存与内部宿主接线

状态：2026-11-09 Pacific/Auckland。实现默认关闭的host-only内存字节store，测试仅公开合成bytes，不采集屏幕/私人UI、不创建文件/URL/下载route、不解码PNG，也不产生ScreenshotRef或verified evidence。CU-014a2已将私有store接内部read runtime的Agent/Session/cwd/policy/unload清理与独立host policy；工厂仍opt-in、生产入口不安装。CU-014父卡保持in_progress；真实capture/coherence、磁盘manifest/崩溃清理、用户consent/生产访问策略属CU-014b。

## 为什么先拆内存切片

[EphemeralArtifactStore](<../../src/evidence/ephemeral-artifacts.ts>) 只建立临时资源的作用域、容量、授权及销毁规则，依赖已存在的host scope与只读授权内核，不依赖未验的native输入/AX成功。它既不是文件系统沙箱，也不是完整截图存储。进程退出后无本store恢复路径，但操作系统swap/core dump或已经交出去的副本不在此逻辑清理保证内。

构造默认enabledFromHost=false；必须host代码明确开启，模型没有对应工具或配置入口。开启本store不批准capture/内容披露，也不会签发read grant。每次stage、publish和read都必须提供同步返回严格true的host authorizer，缺失/false/任意truthy/throw/Promise均ARTIFACT_DENIED。callback只有冻结的operation/observationId/mediaType，不获原始或owned bytes；每次read重新授权，opaque artifactId不是访问权限。

误传async callback时拒绝不变，同时用native Promise brand和captured then观察rejection，不回显源错误、不await转成许可，不调用任意thenable。真实用户授权与日志留存来源仍未实现，不能用示例read grant替代独立capture/disclosure策略。当前 [组合测试](<../../tests/unit/artifact-authority.test.ts>) 仅用真实FixtureReadAuthority核对stage/publish/read门顺序与撤销，不证明具备截图授权。

## 单次ticket与内存预算

1. beginFromHost(context, closedSpec, authorizer)：closedSpec仅observationId、mediaType=image/png、maxBytes。mediaType是内部约定标签，**不证明bytes是真PNG**；store不渲染、不向浏览器发出图片响应。caller不可提供path、URL、owner、批准或几何字段。
2. 从begin取得monotonic截止值，原scope及signal与ticket绑定；ticket是Map里的exact frozen对象，不复制、不跨store。pending期间仅存元数据，不保存payload。
3. commitFromHost在校验payload前把ticket标为committing，仍留在pending Map供invalidate/dispose/expiry删除并保留容量reservation。成功或失败都消费，不能用同ticket重复publish。
4. publish复制payload到store所有的fixed Uint8Array，授权后再次检查scope/当前和原signal/mono deadline/epoch/closed/exact ticket membership才写record。失败尽力覆盖owned copy，不保留输入引用。
5. readFromHost查同scope/TTL、逐次authorizer和末次record membership，最后才返回独立bytes与descriptor副本。修改输入或返回对象不影响store。

容量默认16个entry、总8MiB，宿主可设置1–64entry、总1byte–16MiB；单个payload固定1byte–1MiB。begin按maxBytes预留，pending+committing+records共同计数，满额明确ARTIFACT_CAPACITY，不驱逐活资源。commit以实际size替代reservation，可释放未用额度；容量限制针对store owned/reserved bytes，不包括caller持有输入/返回副本、V8或hash库内部开销，不宣传整个进程的严格内存上限。

payload使用node:util/types intrinsic Uint8 brand、typed-array byteLength/buffer内部slot、captured set进行bound检查和复制，不调用caller可覆盖的byteLength/slice/constructor。只接受普通fixed ArrayBuffer的Uint8 view（包括Node Buffer语义），拒SharedArrayBuffer、resizable或detached buffer、其它对象。这样不把可并发改写的共享存储声称为coherent snapshot；仍不认证内容来源或native捕获时序。

## 作用域、TTL与清理

scope为agentId/sessionId/generation/workspace/exact lifetime，沿用 [host scope](<../../src/host-adapter/scope.ts>)。store本身只检查内部HostContext快照的形状与一致性，调用方仍须以actual host adapter重新绑定；CU-014a2的内部service与read runtime已做此绑定并接公开Session事件清理，未在public Tool或生产入口启用，不假装有生产Session结束保证。

- TTL默认15分钟，host可设1000–900000ms；从begin开始，commit/read不续期。定时器unref，过期无后续调用也删除pending/records；每次调用另用monotonic复查，eventloop延迟不能使已过期资源再次可读。
- runtime timer不是绝对deadline擦除保证，busy eventloop/暂停/进程崩溃可能延迟运行，不能声明持久化或OS级清除SLO。
- discardFromHost仅释放exact同scope pending ticket；caller已abort仍可cleanup。invalidateFromHost删除该scope全部pending/records、增加epoch，不误删另一lifetime；所有snapshot错误固定脱敏。
- operation期间用busy gate阻止authorizer/getter重入stage/commit/read。authority-reducing discard/invalidate/dispose仍允许，末次epoch/membership检查防撤销后复活。全局epoch使同一同步operation期间无关scope cleanup也保守拒绝当前结果，这是fail-closed限制，不扩大许可。
- begin原signal取消禁止其commit；已发布资源不再绑定结束的stage call signal，同scope后续call需新signal及重新授权。caller abort不等同Session结束；后者由内部opt-in runtime adapter显式invalidate，独立使用store时仍须host负责。
- clock异常/NaN/回退清全部并固定CLOCK_UNAVAILABLE；其它源getter/验证异常固定错误，不透传输入/路径/回调原异常。
- dispose幂等、关闭未来admission，取消全部timers，清pending并尽力用fill(0)覆盖owned arrays。没有delete或递归目录操作。不能擦除已经返回的副本、caller输入、GC历史拷贝、swap或日志，不声称secure memory。

## 返回值不构成截图或业务证据

返回descriptor只有随机artifactId、observationId、mediaType、byteLength和SHA256。observationId在store层只是host提供的关联，store不证明ObservationStore成员或fresh native target；CU-014a2 service另强制当前观察成员及该观察target的read grant，仍不认证bytes来自该目标。digest只是存储bytes完整性，不认证publisher、截图来源、当前窗口或业务效果。没有capturedAt/windowFrame/pixel transform/coherent、没有evidenceId、没有读取文件路径或远端URL。

[现有ScreenshotRef](<../../src/contracts/observation.ts>) 的capture geometry与transform不被削弱，store descriptor不能直接拼成可信ScreenshotRef；[回执tracker](<../../src/evidence/action-receipts.ts>) 仍无verified路径，未与此store组合。视觉/坐标和native输入能力保持关闭。

## CU-014a2：内部runtime接线，不把read许可当artifact授权

[FixtureArtifactService](<../../src/service/fixture-artifacts.ts>) 由 [FixtureReadRuntime](<../../src/service/fixture-read-runtime.ts>) 私有持有。runtime constructor与内部 [lifecycle factory](<../../src/host-adapter/read-lifecycle.ts>) 只有host options.artifacts.enabledFromHost=true且独立authorize同步true才可使用；选项在构造时拷贝/冻结，callback本身由host负责。policyChanged关闭旧store、清其全部字节与timer，重建同选项空store；不会自动接受新的callback或签发grant，宿主若改变决策须让既有callback反映新策略并显式通知policyChanged，或新建runtime。store/authority/target witness均不公开。

内部host API为stageArtifactFromHost(exec,grantId,strict{observationId,maxBytes},bytes)和readArtifactFromHost(exec,grantId,artifactId)。同步stage在私有store内部begin+commit，不把ticket交出去，未来async native capture需另设计，不宣称已经reserve跨native await。请求不能额外提供target、owner、媒体类型、path或approval；mediaType标签由service固定。

[ObservationStore](<../../src/observation/store.ts>) commit在projection前把caller target严格parse一次，同一validated值用于公共投影和private target记录，避免getter先A后B错绑。内部fixtureTargetFromHost按exact scope/TTL/membership取clone，不从可能为空的element candidates推测目标；不向公共Observation添加windowKey/witness。即使空/部分覆盖观察也能检验既有read许可，这不使其中元素可执行。

每次stage/publish/read authorizer先bind实际Agent/Session/open turn/cwd、核original signal与same scope、查观察private target、requireRead exact grant；然后调用独立冻结metadata-only callback，只有===true才再次执行同组检查。非true原样返回store判deny，保留原生rejected Promise给store观察，不assimilate thenable。observation到期（默认15秒）后即使artifact的15分钟TTL未到也不披露，get/read不续期；观察过期后artifact可能仍保留至其TTL或scope清理，并非观察到期瞬间内存擦除保证。

exact Agent/Session退出、committed cwd事件、同IDregistry替换/发现cwd变化时，runtime先关changing gate、清tracking/观察和artifact，再撤销grant触发同步abort。policy清所有，dispose永久关闭；其它Session的字节不被清。scope清理释放真实entry容量，A→B→A/新grant/重载不复活旧artifact或观察。exec快照及host getter错误固定脱敏。busy gate阻止同步policy递归stage/read，但撤销仍可生效。

新增 [runtime artifact tests](<../../tests/unit/runtime-artifacts.test.ts>) 覆盖默认双拒绝、metadata无bytes、三阶段逐次决策、target错grant/假观察、5类清理、跨Session、policy回调撤销/closedturn/静默cwd与registry替换、满store清理释放容量、递归拒绝和getter异常。真实 [Cordis/SessionStore tests](<../../tests/profile/read-lifecycle.test.ts>) 增加四个公开事件/卸载重载case。新的 [runtime child probe](<../../tests/support/runtime-artifact-probe.mjs>) 经过built service wrapper验证三阶段async拒绝无unhandled，真实owned copy在workspace/policy/dispose的grant abort通知之前为零、重入gate关闭；不将returnedcopy或OS内存声称被擦除。

独立设计审3reads指出target单次parse和wrapper不能吞rejected Promise。代码review7reads、105tests/tsc exit0，未确认新增P1/P2，无probe或写入；父后续child/异常Red修复与追加测试由父验证，不算review独立复验。该组合仍无capture/PNG decode/磁盘/公开route/真实consent，无模型工具，private data no-go不变。

## 验证与审查

[store tests](<../../tests/unit/ephemeral-artifacts.test.ts>) 覆盖默认关闭/授权严格true、scope五项、单次ticket、source/returned copy隔离、pending+committing容量及精确1MiB边界、TTL不续期/无人访问定时清理、取消后cleanup、invalidate/dispose/expire/abort回调、input/context getters、shared/resizable/detached view、重入、clock/error脱敏。

[隔离child probe](<../../tests/support/ephemeral-artifact-probe.mjs>) 在独立Node进程真实copy API边界记录owned views，确认拒绝publish/invalidate/dispose后自有副本清零、输入和已返回copy不变；不在产品添加inspection hook。另一child分支用真实rejected async callback覆盖stage/publish/read，拒绝但无unhandled rejection或原文外泄。

独立设计审4reads给出同步授权/反重入/真实reservation与intrinsic字节边界建议，无执行测试。代码review5reads独立46tests+tsc exit0，用唯一stdin probe确认async callback拒绝后仍触发unhandledRejection并暴露异常（P2）。父child先Red、三阶段修复Green；后续新增tests和修复不是reviewer独立复验结果。

完整红绿/环境/命令见 [验证记录](<../verification/foundation.md>)。本卡仅支持A-21/22/23的内存授权/字节限制/TTL与cleanup子断言；不代表路径fence/symlink、磁盘manifest只删自有文件、完整生产Session集成、截图native或崩溃恢复验收通过。私人数据依旧no-go，无公开route、无Profile安装或控制输入。

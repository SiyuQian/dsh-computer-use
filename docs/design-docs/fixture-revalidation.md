# Fixture exact revalidation：CU-007b1/b2a 只读切片

状态：2026-11-09（Pacific/Auckland）。自有控件生命周期witness、read-only revalidate_fixture协议/客户端、bounded扫描与fail-closed策略已有代码；纯Swift/API-boundary stub及真实helper拒绝路径已验。真实AX成功lane仍缺accessibility，exit3/NOT_RUN；不等于CU-007b完成，没有native输入或public handle执行。

> 2026-11-09 更新：真实AX下 `test:native-observation`、`test:native-action`、`test:native-e2e` 已在自有fixture实跑（TCC由用户手动授予，见 [总计划](<../exec-plans/active/2026-11-08-computer-use-mvp.md>) CU-012a2/CU-015c）。下文中“缺AX权限/NOT_RUN”的描述是当时记录；缺权限时 lane 仍 exit3/NOT_RUN。

## 控件身份不是旧index或标签

[FixtureWindow](<../../native/Fixture/FixtureWindow.swift>) 保留原稳定AXIdentifier（fixture.text、fixture.submit等），另在每个actionable控件创建时通过公开AXHelp发布`fixture.element.element_<UUID>`。同一个控件reorder仍保留instance，replaceTarget创建新对象和新instance；双窗口相互独立。模拟secure字段不发布可操作instance，不暴露值。

fixture hidden self-test直接操作真实AppKit对象，核对reorder保留/replace变化/跨window不同/secure不发witness；它不是通过外部AX读取成功的证明。没有修改foreground或输入route。

[observe reader](<../../native/Helper/FixtureObservation.swift>) 在已正向确认的非secure fixture标识上读取AXHelp，合法时把elementInstance附在内部node。raw node nativeId仍只是本次序号，不作对象认证。[public projection](<../../src/observation/project.ts>) 不输出elementInstance或AXHelp，public handle仍每次随机轮换。现已由同一次strict snapshot投影在host内原子建立private public-handle→witness候选；公开观察和现有resolve结果均不含标记。候选只供授权后的只读重验，不是可执行句柄。

这些UUID是owned fixture对对象生命周期的协作证据，不是macOS通用不可伪造对象ID；第三方app或同UID恶意native代码不受此方案强认证。

## Closed read-only wire

[合同](<../../src/contracts/fixture-observation.ts>) 新增revalidate_fixture：

- target沿用pid/kernel processStart/windowKey/windowId/windowInstance，不接受bundle/path/selector扩展。
- element仅identifier closed fixture allowlist、instance（element_前缀opaque）与operation press/set_value。禁止secure、任意AX常量、脚本、坐标、输入value、approved/nativeId等字段。
- 仅此新命令要求canonical sorted compact JSON，请求帧仍8192byte/LF/EOF，重复键即使同值也拒绝；TS transport按递归key排序序列化，Swift parsed object回序列化做exact bytes比较。旧health/observe编码不变。
- response为exact+原target/element+dispatchable:false，或closed error+dispatchable:false。没有element值/树/permission token；client既校验request/launchId，也逐字段核对exact target与element，拒绝串线或dispatchable:true。

[client](<../../src/backend/macos/revalidate.ts>) 复用 [managed read transport](<native-transport.md>)，固定helper path、fd7、deadline/cancel/bounded cleanup，不retry。它是内部read接口，caller仍须持host read授权。[host重验service](<../../src/service/fixture-revalidation.ts>) 已组合读授权与private candidate，仍未注册模型入口或用户consent/生产Session事件，不能从模型直接调用。

health/manifest commands现为health、observe_fixture、revalidate_fixture；axObservation/mutation/keyboard/pointer仍false，因为真实AX成功未验，没有模型observe或act工具。版本仍1，closed命令列表变化要求helper/客户端一起重建；一般nativeRequestSchema仍health-only，不开放通用命令入口。

## CU-007b2a：私有handle与受授权只读service

[投影](<../../src/observation/project.ts>) 的内部ForHost入口在同一次strict parse/projection中为实际发出的public handle建立fixture候选，不把过滤前后数组按index拼接。stable identifier→role/subrole→operation/action必须正向支持，enabled且非secure、instance必须element_形状，identifier和instance均在完整snapshot中唯一；任何coverage截断/reason/节点或深度超限都清空全部private candidates。公共可见但缺witness的字段仍不能探测native身份。

[store](<../../src/observation/store.ts>) 每条record同时保留安全公共观察与最小private Map（完整fixture target+identifier/instance/operation，无raw树、nativeId或额外输入）。resolveFixtureFromHost只供内部host、校验当前scope/monotonic TTL/observation成员和operation，返回隔离clone、dispatchable:false、requiresNativeRevalidation:true。get与原public resolve不泄露native witness；Map与record同TTL/invalidate/dispose/clock故障清理，不跨进程恢复。

commit投影后保留正在committing的exact pending ticket至同步beforePublish之后，防重复commit；gate后的scope/TTL/cancel/Map成员再检查，finally消费。gate或末次scope getter调用invalidate/dispose不能重新存活记录；gate内过期不能发布。此实现不签发read授权。

[FixtureRevalidationService](<../../src/service/fixture-revalidation.ts>) 输入strict只有observationId/handle/operation，不接原生descriptor、approved、owner、value或selector：

1. 从当前host与store取得private candidate，再requireRead exact target；backend前复检当前scope、原始call signal/permit signal与fresh候选。
2. 只将candidate target/element的独立clone传backend，immutable expected留在host；等待期间grant revoke/TTL/policy、scope/lifetime变化或观察失效都拒绝，不retry。
3. backend返回/异常后和response strict parse后均复核；exact必须target五字段+identifier/instance/operation全部同fresh candidate。backend改写入参再伪exact无法改变比对基准。closed拒绝只返回固定码，原异常与raw response不透传。
4. 最终membership lookup后再requireRead，再fresh lookup与检查原signal/permit signal，覆盖lookup同步撤销grant、末次授权检查同步invalidate观察；getter/clock测试只验证本逻辑边界，不承诺隔离恶意host代码。
5. 公开结果只有`{status:exact,dispatchable:false,requiresNativeRevalidation:true,observationId,handle,operation}`，无native target/instance/permit。每次调用都重验，绝不缓存exact或延长观察TTL；未来输入前仍需最后native重验。

此service不持有control lease/approval/ledger/native input，不把读授权变控制授权。native client的deadline/managed cleanup仍由真实backend承担，注入backend只是内部seam，不能由模型选择。当前只在测试组合，未有生产工具或用户授权UI。

## 决策与原生扫描

[FixtureElementPolicy](<../../native/Helper/FixtureElementPolicy.swift>) 只接受complete metadata集合：同identifier出现多个即ambiguous，即使仅一个instance匹配也不猜。唯一identifier必须instance exact、enabled、非secure、role/subrole/operation/action positive支持；不允许label/index fallback或rebind。

[FixtureElementScan](<../../native/Helper/FixtureElementScan.swift>) 通过closed adapter遍历：最多64nodes、深度12，以CFEqual（实际adapter）检测重复/cycle，不靠CFHash冲突猜同一对象；任何metadata/children失败、short-read、超过上限或不完整均CAPABILITY_UNAVAILABLE。最终再读selected metadata并校验window归属；detach/replace/identifier变更即拒绝。pure adapter只是测试与生产扫描算法的接口，不是模型可注入代码。

[FixtureRevalidation](<../../native/Helper/FixtureRevalidation.swift>) 实际AX adapter：

1. 先exact fixture executable/kernel start，同用户；然后AXIsProcessTrusted无prompt检查。无权限READ_DENIED，不扫别的app。
2. 枚举最多8windows，count/copy/二次count必须一致；每个window的AXIdentifier必须String，任何读取失败不能隐去潜在重复候选。唯一window witness匹配且owner PID一致。
3. 每个node读取role、identifier、subrole、enabled、help与supported action metadata。**不请求AXValue**，只对value可设置性调用IsAttributeSettable，不读取文本。identifier只有明确attributeUnsupported可作无identifier；cannotComplete/invalidUIElement/错误类型返回nil使scan不完整。
4. children只有明确attributeUnsupported且可信leaf role才可视为空。其他AX错误都拒；count==0也二次检查，非零copy数量必须exact并复查count，不把短读当叶子。
5. 找到exact后，AXUIElementGetPid及AXWindow归属必须对应同一被选window，随后再读identifier/instance/role等metadata；最后复核process/window witness。不确认时拒绝，不尝试rebinding或输入。

count复查与window归属只封闭可检测的变化窗口，不构成系统级原子遍历/输入事务；扫描后仍可变化。exact response是瞬时read-only事实、固定dispatchable:false；未来真正输入之前仍须再次做最终原生重验。

## 证据与审查

- [policy tests](<../../tests/fixture/revalidation-policy.test.ts>) 现场编译Swift纯metadata/scan：exact/reorder、replace/ambiguous、missing/secure/disabled、bounds/cycle/depth、child失败、late detach/metadata替换。不是AX成功测试。
- [adapter tests](<../../tests/fixture/revalidation-adapter.test.ts>) 编译真实AX adapter并在测试binary内替换AX API返回：不访问实际UI、无TCC授权；覆盖identifier错误/错误类型、zero→grow、short children、window枚举失败/count变化与detach，value getter计数0。测试模拟API不解锁production权限。
- [transport tests](<../../tests/transport/revalidation.test.ts>) 用真实managed subprocess+helper拒Node/不存在PID，malformed Swift boundary/duplicates拒绝；test-only fault child的exact target/instance/op错配、extra/dispatchable:true均拒并确认退出。
- [fixture tests](<../../tests/fixture/fixture.test.ts>) 实际hidden fixture PID/start匹配时无AX→READ_DENIED，stale start→TARGET_CHANGED，mutation仍false。
- 独立review两项fail-closed finding：identifier错误吞成空、0children漏二次count，parent API stub先Red（错exact）再修复；parent另补window同型两项Red/Green。reviewer未运行native或suite，不将父执行归为其独立复验。

[候选单元](<../../tests/unit/fixture-candidates.test.ts>) 与 [service单元](<../../tests/unit/fixture-revalidation-service.test.ts>) 使用显式测试metadata和fake backend验证上述guard，不作为真实AX成功；[真实helper组合拒绝](<../../tests/transport/fixture-revalidation-service.test.ts>) 从test-seeded候选+host grant经过service/client/managed helper，Node身份必须TARGET_CHANGED，不读取UI。独立review复现末次private lookup同步撤销grant仍返回exact（陈旧只读发布，非input），parent先Red后补末次guard；reviewer独立跑75tests但不包含父后续fix/新cases。

[显式native lane](<../../scripts/test-native-observation.mjs>) 现要求真实AX observe经read grant/service→public handle/private候选→read-revalidation service→exact；另验证错误instance与revoke拒绝。当前实际执行在preflight得到accessibility=false，exit3/NOT_RUN，不启动fixture或弹权限；成功分支仍未运行。命令与红绿见 [验证记录](<../verification/foundation.md>)。

## 未完成与能力门槛

CU-007b2a只完成host private handle/current observation/TTL/read grant接线和拒绝seam；CU-007b2b仍需CU-006c真实AX成功后，真实观察→handle→exact及替换/reorder/rebind验收。低风险唯一rebind还没有实现；当前instance变更一律拒绝，新授权/重新观察只能由后续service决定。

真实AX兼容（含hidden window可见性、AXHelp/AXWindow是否可取）、最低macOS/Intel尚未验；若API不给可靠witness只能unsupported，不能改前台或synthetic index凑exact。没有CU-012输入、生产stop/live授权组合或完整A-04/06验收，不因这些拒绝测试绿灯开放模型动作。

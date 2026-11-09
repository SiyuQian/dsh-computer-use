# Fixture read runtime：CU-008a2 宿主生命周期接线

状态：2026-11-09 Pacific/Auckland。内部opt-in只读runtime + 公开Cordis/Session事件适配已有实现。真实SessionStore通知、复合卸载与managed fault-child取消/退出已验；Agent registry/turn/cwd仍为窄host seam，AX成功仍NOT_RUN。此模块不在诊断plugin入口安装，不注册新tools、不自动签发grant、不获取用户consent/TCC，不接控制租约、批准、broker或native输入。

## 组合与来源

[FixtureReadRuntime](<../../src/service/fixture-read-runtime.ts>) 持有私有FixtureReadAuthority、ObservationStore、FixtureReadService、FixtureRevalidationService、观察派生的FixtureActionIntentService与默认关闭的FixtureArtifactService；每个实例通过私有共享 [HostScopeRegistry](<../../src/host-adapter/scope-registry.ts>) 取得随机generation，不提供authority/store/public witness访问。CU-008b1a提取该scope及 [event adapter](<../../src/host-adapter/scope-lifecycle.ts>) 实现给独立control runtime复用，不共享authority或generation；原read/artifact行为保持。内部backends由host代码注入，模型不能选择函数或executable。host-only grantFromHost仍是明确测试/静态配置入口，不把具备调用权当用户同意；observe只接受已有grant/strict target，revalidate只接受grant与public handle request。

每个call保存agent/callId/original signal不可变快照，通过 [bindHostContext](<../../src/host-adapter/context.ts>) 取得exact registered Agent+Session、open turn、actual workingDirectory。backend前后、投影publication gate和重验末端继续重新绑定，不复用旧HostContext冒充当前宿主。scope identity仍不证明permission或当前native目标。

内部tracked map以exact Agent为key，保留exact Session与最近绑定context，每个Agent仅一个workspace。默认最多64，可设1–256，满额READ_CAPACITY而不驱逐活授权；撤销/终止清entry。有效但闲置scope不会因为grant TTL到期自动逐出，capacity不能当无限session缓存。每次bind先逐个核对已跟踪对象仍在registry，发现退役/同ID替换先失效并撤销旧scope，再判断容量；新对象不能继承旧grant/handles。retired Agent/Session用WeakSet，不让仍误列在registry的旧对象重新取得grant。

## 事件与复合卸载

[installFixtureReadRuntime](<../../src/host-adapter/read-lifecycle.ts>) 在明确调用它的Cordis fiber内注册：

- agent/disposed：公开payload={agent}，按exact Agent退休，不以string id匹配。
- session/disposed：直接Session参数，按exact Session退休，清理该对象的全部tracked scope。
- session/event：仅工作目录working-directory/change触发清理；不读取event.data.cwd为可信新路径，不修改宿主cwd，也不从Session.header.cwd取当前目录。其它Session事件不撤销读许可。
- runtime显式policyChangedFromHost：失效全部观察并撤销全部grant；不订阅或猜测其它插件的私有policy事件，不自动恢复授权。

监听均同步关闭gate/清理，不能依赖observer返回Promise被等待。SessionStore feed为post-commit：不能阻止宿主目录提交，只能拒绝后续读/结果发布。Agent scoped helper用于测试标准payload/dispatch；没有假造Session.dispose方法。

单个ctx.effect generator直接yield每个ctx.on返回的exact effect disposer，最后yield runtime.dispose。Cordis逆序teardown先关闭runtime admission、清observations、撤销authority，再解除监听，不把listener disposer包wrapper留成并发sibling。安装中抛错也dispose并返回固定错误，状态入口没有自动启用此工厂。

## 线性化撤销与迟到结果

- 退休先加入exact weakset。workspace/policy变更先增加epoch并置changing gate，删除全部相关tracking与观察tickets/records，同时清关联的private artifact字节/tickets，之后才abort授权permit。
- [revokeScopeFromHost](<../../src/policy/read-authority.ts>) 使用authority-reducing scope快照：caller已经abort仍可清理；同scope全部grant和timer先删除，再触发任何同步abort listener。不是逐个revokeFromHost边删边通知。
- 清理期间同步abort listener不能再grant/observe/revalidate。多个Session/scope被清理时，全部publication membership先删除，私有authority不可从runtime逃逸，未通知的scope也不能被模型继续访问。
- cwd变化事件即使getter仍报告旧路径也撤销；两次真实绑定发现workspace改变也先清旧scope并拒绝当前调用，不将旧grant迁移到新路径。之后必须明确新grant。A→B→A旧grant/handle不会复活；若所有事件和中途调用均缺失，单靠两次相同cwd字符串不能检测隐藏ABA，不声称系统原子监测。
- bind记录epoch并在host cwd getter之后复查open turn/turn编号/原signal，再复查epoch/retired/exact registry membership；CU-008b1a补读和控制同型Red/Green，防getter无事件关闭turn。grant签发后重新bind且检查epoch/lifetime/workspace/signal，期间target或ttl getter触发policy/cwd变更时撤回临时grant，不发布失管id。
- host registry/cwd异常统一HOST_CONTEXT_UNAVAILABLE，不透传源错误。backend错误仍由原service固定脱敏，strict inputs不能被当权限。

原caller取消只取消该call，不撤销同scope下一call的授权；scope事件则取消该scope所有permit。在途backend即使忽略abort、迟到返回ok/exact，也过不了当前host/grant/observations publication gate。取消不是撤销已读数据，不能删除已返回给caller的数据。

CU-014a2已把默认关闭的 [内存artifact service](<ephemeral-artifacts.md>) 私有接入：host-only stage/read API、当前观察target/membership+readgrant和独立artifact policy逐次前后复检，公开Session事件/agent dispose/cwd/policy/unload清理自有bytes先于grant abort。factory可显式接host选项，入口仍不激活；公开合成bytes测试不是截图/consent/evidence，完整边界见该设计。policy变更关闭旧store并重建同选项空store，不恢复旧artifact/grant。

CU-007a2又私有接入 [观察派生action-intent](<observation-lifecycle.md>)：stage只用observationId/handle/action，经live观察private witness与readgrant取target/material，consume重新匹配HMAC/own10s与原obs/grant mono deadline、创建turn/scope/epoch。ticket exactobject/单次，input原文不在store；撤销先清intent再grantabort。最终validator沿hostcwd→dependencies/clock→turn/registry/epoch顺序，不把caller material/target当来源；结果只是不可dispatch候选，不向controlruntime签lease/批准或共享authority。没有新backend调用，值只在host重新提供的隔离DTO和候选返回中短暂存在。

## 取消不等于排空

runtime.dispose为同步admission关闭/观察清理/permit取消，不await backends，不返回drained或声称helper已退出；故意永不settle的fake backend不会被包装成成功或假drain。managed transport已有terminate/waitForExit最多2秒cleanup与明确cleanup-failed，真实退出证据只能由它提供。该保证不推广为production stop/native输入排空，也没有测停止SLO。

## 测试证据与边界

- [runtime unit](<../../tests/unit/fixture-read-runtime.test.ts>)：defaultdeny/private composition、五类生命周期对pending observe/exact拒绝、same-ID替换/退休、其它Session隔离、missing cwd event发现、同步abort重入、capacity、closedturn/registry/callerabort、getter变更/异常、generation卸载不继承。
- [authority unit](<../../tests/unit/read-authority.test.ts>)：exact scope批量撤销，取消后仍可清理，不误伤同ID另一lifetime，首个abort listener不能读兄弟grant。
- [Cordis/SessionStore](<../../tests/profile/read-lifecycle.test.ts>)：真实committed cwd事件和store detach、不同对象/事件隔离、public agent emit helper、卸载时abort listener发新事件仍被监听，卸载后不再收到，重载旧grant拒绝。Agent registry/turn/cwd仍narrow fixture，不是完整AgentLoop/WorkingDirectoryService/GUI/Profile安装。
- [transport seam](<../../tests/transport/read-lifecycle.test.ts>)：真实Swift拒Node假fixture身份，不读取AX；真实managed provider启动test-only hang child，committed cwd事件→组合signal→transport cleanup→waitForExit/done非0。test-only executable substitution不在产品可选参数中。

初始scope revoke、runtime、installer分别Red后实现。独立设计4reads（其中1次路径不存在，3份有效）强调bounded跟踪和批量撤销；代码review8reads独立56tests+tsc通过，并用唯一stdin probe复现同ID无事件替换造成容量占用/旧signal不abort（旧结果不泄漏）。父补Red修复扫描退休；review未复验修后新增getter/postbind cases。具体红绿、退出码及native NOT_RUN见 [验证记录](<../verification/foundation.md>)。

真实AX成功、生产consent/静态配置来源、完整AgentLoop/Session/WorkingDirectoryService集成、controlled input/approval/broker/ledger/receipt生命周期组合、GUI和发布安装继续保留后续gate。本卡仅覆盖A-02/04/08/20的read lifecycle子断言，不代表这些验收全部通过。

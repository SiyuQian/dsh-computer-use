# Fixture read authorization：CU-008a 纯宿主切片

状态：已实现默认拒绝的fixture只读registry、内部read与handle revalidate service；有单元/真实helper拒绝seam，不接模型工具、用户配置UI或真实AX成功lane。控制任务/风险/单次批准另有inert host切片，尚未与native组合。CU-008父卡未完成。

## 来源与范围

[FixtureReadAuthority](<../../src/policy/read-authority.ts>) 的grantFromHost只能由可信host静态fixture配置调用。它不获取用户同意、不验证系统TCC，也不是模型工具。未来host UI/配置适配器必须验证授权来源，再调用此内核，不能由模型要求直接签发。

默认空registry，未知/模型伪造grant id一律READ_DENIED。许可范围固定：同一exact host scope + pid/processStart/windowKey/windowId/windowInstance。所有目标字段strict；不能携带approved、bundleId、脚本或任意选择器。native另外验证固定自有fixture executable，不推广私人应用。

每个grant为随机host id，实例内Map保存。跨authority实例不能复用。对模型公开的入口仍只有cu_status，不接本registry。

## 时限、撤销、取消

- host明确ttlMs，范围5000–600000；没有无限grant。采用monotonic检查deadline。
- requireRead每次先校验当前host scope、完整target、有效grant；返回fixture_read_only permit，不含control operation或approved。
- permit signal由caller signal和grant signal组合，caller取消不撤销其它call；grant撤销则所有该grant permit取消。
- 到期timer会revoke，timer unref；每次registry调用也按monotonic清理，不能只依赖event loop timer及时触发。
- policy replacement先clear全部旧grant、clear全部timer，再abort通知。AbortSignal listener同步执行，不能在第一个listener中用尚未删除的第二旧grant重入。
- clock回退/无效/异常撤销全部，固定CLOCK_UNAVAILABLE，不透传源异常。
- dispose撤销全部、拒绝新签发/读取。grant不持久化或跨重启恢复。
- 默认最多64活grant，可设1–256；满额READ_CAPACITY，不驱逐活grant。调用方改permit目标不影响registry。

这只是read许可，不能承诺撤销已读数据或已外泄内容。[CU-008a2内部runtime](<read-runtime.md>) 已用公开Agent/Session/cwd事件适配主动撤销，scope批量撤销先清全部grant/timer再abort；只在明确调用的Cordis fiber内安装，非诊断入口/生产授权来源或consent。

## 内部read service

[FixtureReadService](<../../src/service/fixture-read.ts>) 固定顺序：

1. 通过函数取得当前host绑定；requireRead先于任何backend调用。
2. ObservationStore.begin在backend前计龄；只把permit target与组合signal交backend。
3. backend返回后重新取得当前host绑定，再requireRead；若撤销、过期、Session生命周期/workspace改变，拒绝publish。
4. strict response校验；仅闭合native错误码可返回，任意backend异常统一NATIVE_READ_UNAVAILABLE，不回显原文、不重试。
5. commit先完成公共投影和观察TTL复检，再通过同步beforePublish重新绑定当前host/核对grant和permit signal，只有通过后才写records Map。grant若在投影期间到期，不返回也不保留隐藏record。最终discard pending ticket；失败不会长期占用容量或清除别人的活观察。

service依赖注入是内部backend seam，未注册模型可选函数/执行命令。真实transport的deadline/cancel与固定helper仍由backend负责。本切片的fake backend只用于测试门顺序/拒绝零native调用，不能当AX成功证据。

[FixtureRevalidationService](<../../src/service/fixture-revalidation.ts>) 另接受strict observationId/handle/operation，从host store解析私有witness；backend前、返回/异常及parse后检查current scope/mono TTL/grant/originalsignal，最终lookup后复核grant与fresh候选。返回不含descriptor/许可且dispatchable=false，不缓存exact或自动retry。后端收到的clone不作为expected比对基准，防突变伪响应；详见 [接线与未验门槛](<fixture-revalidation.md>)。

## 验证与后续gate

[registry tests](<../../tests/unit/read-authority.test.ts>) 验证default deny、scope/target五项各自改变、ttl阈值、caller取消、revoke/policychange/dispose、重入、clock/capacity、拷贝隔离。

[service tests](<../../tests/unit/read-service.test.ts>) 验证未获授权backend计数0、backend忽略abort仍不得publish、读取后host再绑定、过慢读取、固定错误、失败ticket清理。

后续CU-008b：依赖native exact重验的TaskLease/operation allowlist、独立risk floor、unknown/high-impact拒绝与审批边界。CU-009单次批准、CU-010停止/broker与CU-011ledger已有host/临时namespace切片，但生产/native组合均未解锁。缺AX权限不绕过。

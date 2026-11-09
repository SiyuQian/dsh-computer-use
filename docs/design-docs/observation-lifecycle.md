# Observation lifecycle：CU-007a/a2 纯宿主切片

状态：已实现内存生命周期、私有fixture候选与成员查询，内部read/revalidate service已有host组合；未接模型工具或native执行。CU-006c缺AX成功验收，CU-007b native重验/rebind仍未完成。本切片不能解锁原生变更。

## 数据流与来源

可信caller经 [host adapter](<../../src/host-adapter/context.ts>) 得到exact live Agent/Session对象绑定 → [ObservationStore.begin](<../../src/observation/store.ts>) 签发不可复制ticket → 内部已授权fixture读取 → commit消费ticket并调用 [公共投影](<../../src/observation/project.ts>) → get/resolve只查询同一scope。

store本身只定义组合接口，不调用backend、不签发许可；CU-008a已新增内部read service把grant与store连接（仅seam单元），另有 [内部read runtime](<read-runtime.md>) 的公开Session/Agent/cwd事件适配与复合卸载，不在诊断入口安装，不接模型工具/生产consent。scope形状校验不能代替bindHostContext；后续service必须每次从当前宿主重新绑定，不能复用旧的结构对象或从模型取context。

## 作用域

scope = agentId + sessionId + provider generation + workspace + exact Agent/Session lifetime token。

adapter在WeakMap中按真实Agent/Session对象对创建opaque frozen对象。同对象后续call/turn得到同token；同ID但替换Agent/Session得到不同token。token不暴露给模型，不持久化，不证明控制授权。

- callId/turn不进入观察有效scope：同一Agent下一轮可在TTL内使用观察候选。
- get/resolve的scope不匹配与未知id统一OBSERVATION_EXPIRED，不能据错误区别记录是否存在。
- 不同workspace、generation、Session生命周期不能读记录或复用ticket。
- invalidate清除精确scope的records和tickets；dispose清除全部并禁止新操作。[read runtime](<read-runtime.md>) 已将撤销/Session结束/cwd/内部fiber卸载接到同一清理链，真实SessionStore通知/managed取消已验；完整AgentLoop/生产consent/控制生命周期仍未接。

## 时间语义

默认TTL 15000ms，配置范围5000–60000ms；这是延续现有合同的保守开发预算，不是测得的性能承诺。

- 使用performance.now()作为production monotonic source，Date.now()只供展示；测试注入fake clock。
- begin在backend工作前记录monotonic/wall start。
- commit前、投影后及同步beforePublish之后均检查monotonic deadline。正在commit ticket保留至finally，避免gate中invalidate后复活或重入commit。慢读取/投影不续期，不以完成时刻重置年龄。
- `now >= start + ttl`立即过期。wall-clock向前/向后跳不影响年龄。
- monotonic回退、NaN/Infinity或clock异常清空store并固定CLOCK_UNAVAILABLE，不透传第三方异常。
- 没有定时线程；begin/get/commit机会清理过期条目，另有invalidate/dispose显式清理。未到期内存不会磁盘留存。

## 句柄与候选

ticket是store Map里的exact对象。复制/spread、其它store、重复commit不能通过；目标不匹配或投影失败也消耗ticket，不将失败completion变成可重试许可。

observationId和public element handle由宿主生成，每次观察旋转。store保留已投影的公开fixture数据与最小private handle→target/element lifetime witness，不保留raw AX树、backend node index或额外输入。private Map由同次投影创建、只接受完整coverage与唯一正向fixture metadata，和record一起过期/清理；详见 [重验接线](<fixture-revalidation.md>)。

resolve必须同时匹配observationId及该观察中的handle，拒绝secure、disabled或没有已知action的元素。结果固定：status=candidate、requiresNativeRevalidation=true。它不是exact native target、不是approval、没有dispatch能力。native对象替换即使公共内容相同也不能由此检测。

structureRevision是显示内容/帧摘要，不能作为控件实例证明或业务因果证据。CU-007b/CU-012需自己取得backend exact对象证据并在最终native调用前重验。

## CU-007a2：观察派生action-intent

[FixtureActionIntentService](<../../src/service/fixture-action-intents.ts>) 私有接入read runtime，仅host-only stageActionIntentFromHost/consumeActionIntentFromHost，不注册工具、backend callback或control能力。request严格只有observationId与action（kind/targetHandle/公开fixture value）；target/materialContext/owner/lease/approved等额外字段拒绝，不用caller值声称来源认证。

stage先固定actual host call/scope/epoch/原turn/原caller signal，读取mono起点后才parse raw DTO一次。通过live观察成员及private fixture witness（完整coverage、唯一正向identifier/instance、enabled/nonsecure、operation兼容）取得完整target；另需exact target的live readgrant。只有stage时观察已存在，不执行新read/revalidate/native。观察/public handle可以跨同scope后续call，但intent本身固定创建turn，只允许同turn消费。

- 返回ticket是frozen `{kind:observation_action_intent}` exact对象，Map按identity识别；不读取caller ticket属性，clone/另runtime无效。只记录scope/turn/deadline/grantId、私有HMAC、组合取消signal/timer，不保留action/value/rawgetter闭包。调用方消费必须重新提供同proposal；原input字节不写日志/磁盘，HMAC清零只是best-effort JS Buffer擦除，不是secure memory。
- keyed material由observationId、stored structureRevision、完整target和**private element lifetime witness**派生。只返opaque context摘要，不返elementInstance；同source稳定、新observation改变。structureRevision仍非native真实性或业务效果证明。这个material目前只在read candidate消费中使用，未接controlruntime审批/队列/ledger；不能直接拿字符串当proof。
- 64entry硬上限，满额INTENT_CAPACITY不驱逐活票。own10s从parse前计龄；deadline取其与原observation、readgrant mono deadline最小值，不从展示日期反算。机会prune/own timer、originalcaller或grantabort清票；到期timer尚未运行，consume也复查原deadline。
- consume在读proposal前先判exactticket与owner scope，foreign caller不会执行getter或烧owner票；owner当即标consuming但保留Map，解析失败/输入或grant/turn不匹配均finally删/清digest，成功最多一次。操作busy gate拒递归调用；最后必须exact Map成员仍在，scope/policy/unload即使在clock/getter重入也不得复活。
- stage及consume最终按hostcwd bind→readgrant/观察成员与派生信息/own deadline→open turn/exact registry/epoch的内部validator顺序，再无getter地检查record/signal/epoch。最后clock跨obs/grant期限也因原deadline夹限拒绝；不以重复clock追逐方式续命。不是任意恶意hostgetter的跨对象原子快照，host服务仍可信，native exact另验。
- scope/policy/unload先删所有intents/清digest，再清observations/artifacts和readgrants、通知abort。caller取消不撤readgrant，但创建call的ticket会被取消；换caller signal不能保存旧票。global epoch对其它scope在途operation保守拒绝，不清其既存票；新明确调用仍可使用有效来源。

消费只返回host内部 `{status:candidate,dispatchable:false,requiresNativeRevalidation:true,observationId,target,action,materialContext}`。**不是controllease/用户consent/批准/原生exact/dispatch许可**，不带actionId或执行成功声明。read与control的authority/generation继续独立；现control proposal仍host声明，不能用本卡替代CU-008b2/009b/010c的来源与live事务组合。

[runtime intents tests](<../../tests/unit/runtime-intents.test.ts>) 覆盖42项：strict注入/成员/witness负面类、input/grant绑定、foreign getter不触及owner、clone/replay/递归和并发单赢家、原caller取消、scope/cwd/sameID/turn、64容量、own/继承TTL与最后clock撤销、异常脱敏与原DTO单读。另有private source deadline/clone [store test](<../../tests/unit/observation-store.test.ts>)、readpermit原deadline [authority test](<../../tests/unit/read-authority.test.ts>) 和四类真实 [Session/Cordis事件](<../../tests/profile/read-lifecycle.test.ts>) 撤票/重载拒绝。实际红绿、独立review与未验范围见 [验证记录](<../verification/foundation.md>)；公开合成fixture snapshots不是AX成功。

## 资源与隔离

默认records+pending最多64，允许宿主配置1–256。满额时明确OBSERVATION_CAPACITY，不静默驱逐其它未过期观察。过期/已取消pending机会清理。

输入经schema/projector复制，get/commit/candidate返回structuredClone隔离对象。调用者修改返回值不改变store。该机制是模块内不变量，不是抵御同用户任意恶意代码的沙箱。

## 测试与剩余gate

[store tests](<../../tests/unit/observation-store.test.ts>) 验证fake-clock阈值两侧、慢读取/投影、scope差异、ticket伪造/replay、handle跨观察、清理、容量、mutation隔离与clock故障；[host seam tests](<../../tests/unit/host-context.test.ts>) 验证exact live对象lifetime。

[private candidate tests](<../../tests/unit/fixture-candidates.test.ts>) 另验handle与witness原子对应、closed metadata/完整性/唯一性、克隆和gate失效。没有以这些测试声称真实native重验成功、rebind、用户consent或模型工具已完成；Session事件适配另见 [read runtime](<read-runtime.md>)，并非完整生产Profile。native集成依赖CU-006c，写入仍依赖policy、broker、ledger和独立停止。

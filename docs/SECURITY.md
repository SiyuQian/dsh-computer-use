# Security：计划边界与控制缺口

状态：对模型仍只注册状态工具。内部新增fixture-only只读reader与投影，精确身份/权限拒绝有测试，真实AX成功路径缺TCC未验收。strict schema、live host binding与receipt一致性有测试；已有inert policy/coordination与临时namespace真实锁原语，生产组合仍是实施要求。见 [观察边界](<design-docs/fixture-observation.md>)。

## 保护对象

- 真实 Mac 应用中的文档、已登录账号与应用设置。
- 用户正在使用的前台、系统鼠标、键盘与剪贴板。
- 控制任务、一次性批准、观察句柄和 native transport。
- 截图、UI 树、动作输入与审计记录，包括宿主 Tool/Session 持久化，不能只检查插件自己的 logger。

## 威胁与边界

| 威胁 | 拟议控制 | 验收 | 仍有的边界 |
|---|---|---|---|
| 模型误认目标或受页面提示注入 | 可信 host policy、精确目标、有限授权 | A-02、A-04、A-08、A-28 | 不保证识别任意 UI 的业务语义 |
| 旧观察、焦点变化、窗口替换 | 有限 TTL、process/window 身份、输入前重验 | A-06、A-07、A-15 | 非原子重验不能消除全部竞态 |
| 模型漏标 sensitive | 宿主独立风险下限，未知变更要求批准或拒绝 | A-08、A-28 | 分类器不能替代硬限制和人工判断 |
| 多 Agent/多 host/用户竞争 | 唯一控制 broker、目标锁、用户让权 | A-10、A-18 | 无监测时不能承诺检测全部用户输入 |
| 批准过期或复用 | 单次 envelope、作用域绑定、原子消费 | A-09、A-11 | UI 元数据不认证真实账户/收款方 |
| transport 断开后重放动作 | action ledger、阶段回执、unknown 禁重试 | A-13、A-14 | 不声称业务 exactly-once |
| helper 被直接调用 | 封闭协议、托管传输、签名/hash/版本核验 | A-03、A-30 | 同用户任意恶意原生代码不在可完全隔离范围内 |
| 机密数据经树/截图/日志外泄 | 安全字段投影、截图显式请求、最小日志、保留清理 | A-21、A-22、A-23 | 通用截图像素无法保证脱敏 |
| fallback 偷改输入路径 | 能力矩阵，失败关闭，不走全局 pointer | A-16、A-24 | 私有 SPI 随 OS 变更可能不可用 |

## 禁止事项

- 不自动输入密码、API Key、验证码或管理员认证。
- 不操作系统安全/隐私确认弹窗。
- 不执行真实付款、对外发送、不可逆删除或账户安全变更作为默认测试。
- 不添加任意代码或原生命令执行入口。
- 不把 danger-full-access 或 approval=never 解释为 UI 动作无限授权。
- 不因 readback 不确定而重复 press、submit、key 或 coordinate action。
- 不在截图 artifact 文件名、错误、测试快照或交接中暴露私人输入。
- 不宣称 AX 权限或应用 allowlist 等同文件系统沙箱。

## 许可层次

OS TCC、插件 read、控制任务、takeover 和单次批准是不同层。允许其中一层不能自动授予其它层。

应用read也会读取私人信息，应有独立许可。现有 [fixture读授权内核](<design-docs/read-authorization.md>) 默认拒绝、绑定exact host/target、mono TTL、撤销前先失效全部旧grant，再通知abort；内部service在backend前与publish前都复检。内部 [read runtime](<design-docs/read-runtime.md>) 已适配公开Agent/Session/cwd事件与fiber卸载，按exact对象撤销授权/观察并abort；仅opt-in测试/host工厂，不在入口安装，不接consent/UI/生产授权来源，不自动获得用户同意或TCC，不允许control。静态grant的范围与有效期未来必须展示；不能通过模型工具持久扩大。所有policy变更使pending approval和旧lease适用性重新评估。CU-007a2私有 [观察action-intent](<design-docs/observation-lifecycle.md>) 只由live观察成员/privatewitness+exactreadgrant派生target/material，caller额外authority字段拒绝；短期HMAC单次objectticket、原turn/scope/epoch及原obs/grant mono期限夹限，撤销先清票后grantabort。消费仅read candidate，不签控制授权/批准，不作为nativeexact证明；现controlruntime仍未认证该来源，不能转交一个material字符串冒充proof。

已有 [host控制策略](<design-docs/control-authorization.md>) 与 [单次批准绑定](<design-docs/single-use-approval.md>) 的纯内核，所有结果不可dispatch。未知效应要求批准、never不放行、高影响/系统授权拒绝；批准HMAC不留输入原文。adapter默认禁用，不发真实请求，不自行改host policy。CU-008b1a内部 [inert控制runtime](<design-docs/control-runtime.md>) 已接私有policy的Agent/Session/cwd/policy/unload清理，共享scope实现但read/control不互授权；租约和signal返回前复查epoch/actualhost，scope全部记录/timer先删再abort。CU-009a2私有HMAC批准service已重查live inert租约/risk并绑定完整host答复，scope/policy/unload先清批准再租约abort；originalscope/epoch/turn前后固定，非法/失效答复不复活。observation/material/action引用仍host声明，不认证read/native/幂等；尚未与native/真实consent/真实审批或执行事务组合，不在入口安装，不能当已部署保证。

[协调内核](<design-docs/host-coordination.md>) 的stop方法已验证先关闭新工作再abort，active实际settle前不放slot。CU-010a2私有service只用livelease完整target建立claim并固定policy.evaluate入队，不接受callerwork；每jobpinnedscope/epoch/turn与caller+lease signal，最后host-lease-turn复检。scope清claim/pending先于leaseobserver，active到settle；runtime stopVersion防getter内stop/resume复活，本次stop还撤所有租约/批准，不构成输入许可。Darwin flock与 [独立stop通道](<design-docs/independent-stop.md>) 原语当前仅测试namespace：同UID+私有继承能力鉴权、只能撤销，ACK不是drain。生产统一namespace、真实用户入口、native排空与live权限组合尚缺，不是production broker，不能据此开放输入。

拒绝、撤销、Session结束、provider generation变化与插件停用必须立即阻止后续输入。已经发生的效果不保证可撤销。

[host账本](<design-docs/action-ledger.md>) 已绑定签名actionId与私有HMAC proposal，dispatch_pending必须write-all/fsync后才返回记录完成；未知结果只读恢复且不可重放。fresh journal的O_EXCL不是broker锁；key不落盘，payload不恢复。生产live授权/批准/执行器组合仍未完成，不能用bookkeeping firstTransition替代native许可。

[固定namespace与stop发现](<design-docs/control-namespace.md>) 已拒root/setuid、env/path override、unsafe目录与记录，publisher仅在同namespace持锁、使用captured FD发布完整私有stop-only记录。本地CLI源码/构建只支持stop，无任意命令。未部署生产controller、未执行生产stop，不作为已提供真实用户停止保证。

[保守阶段回执](<design-docs/action-receipts.md>) 只接受host内部closed阶段/ACK/failure，拒绝clone票据、任意异常/receipt注入和可能派发后的未执行/可重试声明。它不认证actionId签名、native ACK或evidence，不能据此授权/断言真实成功；未接native readback前不提供verified路径。

[fixture只读重验](<design-docs/fixture-revalidation.md>) 只支持固定owned executable/进程窗口与控件生命周期witness；完整扫描失败/错误AXIdentifier/short children一律拒绝。新命令不读取字段值或输入，exact固定dispatchable=false；host private handle/read-revalidate service已有，原生descriptor不得由请求方提供；grant/scope/TTL/backend后和publish前复查，exact不含witness/许可。真实AX成功/native控制gate未过，不得据此解锁变更。测试AX API边界stub不请求TCC，不冒充真实AX成功。

[内存artifact暂存](<design-docs/ephemeral-artifacts.md>) 默认关闭，stage/publish/每次read都需host同步严格true授权；exact scope/mono TTL、pending+records字节reservation、复制隔离与撤销后不可复活。async authorizer拒绝但观察rejection，源异常固定脱敏。CU-014a2已私有接read runtime的观察target/membership/readgrant前后复检+独立host policy、Agent/Session/cwd/policy/unload清理，清ownedbytes先于grant abort；factory默认关闭不在入口安装。没有capture/PNG解码/文件/URL/下载route，未接用户consent或生产capture/disclosure授权；不将digest当evidence、零填充不等于secure memory，已返回副本无法追回。私人数据no-go不变。

[保守回执](<design-docs/action-receipts.md>) 的CU-013a2私有service只把真实固定policy/queue结果封存为not_executed，禁止caller ACK/target/dispatch报告；scope/policy/stop/unload先封存再abort，晚到结果不改首terminal。schema/返回terminal不认证native、观察或actionId ledger来源、不证明drain/效果；capacity错误只用模块私有类型分类，不从任意异常message/code取权限事实。目标invalid仅在已到revalidate的目标错误，authorize阶段不冒充native目标验证。

## 机密与供应链

本包不需要凭据。实现阶段只有模型 smoke lane 可能需要 API 凭据，必须使用宿主安全凭据流程，不能让用户贴到聊天、提交到 Git 或复制到测试 fixture。

CU-002 固定 lockfile 和 SDK 版本。[CU-024a](<design-docs/helper-artifacts.md>) 已为本地read helper建立源码+recipe/manifest/binary/Mach-O一致性检查与有界文件路径校验；每次spawn前执行，无缓存。它不保证path-to-exec原子/抵御同UID恶意代码，也不认证publisher，签名/fixture-stop完整分发仍在CU-024b。引用第三方 MIT 代码必须保留许可和来源。现阶段没有 npm identity、签名证书、notarization、SBOM 或已运行 dependency audit；不能声称已有。

[固定foundation验证器](<design-docs/foundation-verification.md>) 只执行受信开发checkout内固定argv，不从CLI接受命令/路径，不执行manifest自由scripts，默认不native；仅显式fixture只读lane，缺TCC保持非0/NOT_RUN。输出仅白名单元数据/计数/摘要，不保存raw测试错误或UI内容。限定源码指纹不是dependencyclosure/签名/原子snapshot，继承环境与工具链不是恶意代码sandbox。基础全绿也固定NO_GO/nativeControl=false/privateData=false，不构成任何权限来源。

## GUI 与沙箱

在 workspace-write 下运行也可能通过获准应用访问 workspace 外数据。MVP 仅在 fixture 和用户明确批准的测试副本中验收。若以后要求强数据隔离，必须使用独立 OS 用户或 VM，并另行设计；不能用本插件逻辑 grant 代替该隔离。

## 当前检查状态

A-01/02/12/13/15/21 的基础子断言已单元或 registry 验证，见 [验证记录](<verification/foundation.md>)。不是这些需求的全部 native/真实 Profile 验收。当前 host 在 schema 校验前记录原始 Tool 参数，插件不能兜底清洗错误调用中的机密文本。私人数据支持为 no-go，不通过更改官方 Session 日志绕过。完整缺口见 [质量现状](<QUALITY_SCORE.md>) 与 [已知缺口](<exec-plans/tech-debt-tracker.md>)。

没有指定安全联系人或报告地址。本包不编造联系人，发布前 CU-027 必须由维护方确定公开报告渠道。

# 接口与状态约定

状态：目标契约与已实现基础子集并列。当前运行时schema位于 [contracts](<../../src/contracts/index.ts>)，是请求校验单一来源；基础接受press/set_value proposal、host actionId execute引用，native只支持health、严格fixture-only observe与 [只读revalidate](<fixture-revalidation.md>)（真实AX lane已在自有fixture实跑），以及仅自有fixture的单次 `act_fixture` press/set_value。纯host [观察生命周期](<observation-lifecycle.md>)、[控制策略](<control-authorization.md>)、[单次批准绑定](<single-use-approval.md>) 已有inert内核；[宿主协调与锁原语](<host-coordination.md>) 已有单元/临时namespace切片，未接生产broker。[动作账本](<action-ledger.md>) 已有签名id/durable pending/只读恢复host切片。键盘、pointer、live批准与ledger/native组合、生产stop入口、native写入与evidence store均未实现。独立stop原语仅 [测试namespace进程切片](<independent-stop.md>) 已验。其余时限与能力描述仍是后续提案。

## 1. 信任与来源

可信 HostContext 必须来自 DSH ToolRunContext / host adapter：agentId、sessionId、turnId、workspace、callId、abortSignal、宿主权限来源。模型请求不得携带这些字段；未知字段应拒绝。

TaskLease（下称控制任务授权）由宿主在用户批准或明确静态策略匹配后签发。模型可以提出 task proposal，但不能自行批准范围。用户最初的自然语言请求只能作为意图证据，不能由模型单独转成无限授权。

内部 [read runtime](<read-runtime.md>) 现将exact host绑定、read grant/观察/重验组合并适配Agent/Session/cwd事件与fiber卸载；不在诊断入口安装，不把身份或事件当consent，不接control/native输入。scope变化先失效后abort，dispose不冒称drain。

## 2. 观察结构

建议必需字段：

```typescript
interface Observation {
  observationId: string;
  generation: string;
  observedAt: string;
  expiresAt: string;
  app: { bundleId: string; pid: number; processStart: string };
  window: { id: number; instance: string; frame: Rect; titleDigest?: string };
  structureRevision: string;
  focusedHandle?: string;
  elements: PublicElement[];
  coverage: { truncated: boolean; reasons: string[] };
  screenshot?: ScreenshotRef;
}
```

processStart 与 window.instance 的原生实现证据由 CU-005 决定。若 macOS 后端拿不到稳定身份，必须写明缺口并采取更窄重验，不能把 pid/window number 的重用当成不可能。

每个 PublicElement 至少有 handle、role、可公开名称、enabled、可用动作、可选 bounds。安全字段不能暴露 value。句柄只在当前 Agent/Session/provider generation 下有效。不能靠客户端改句柄解析到其它目标。

CU-007a纯host切片已采用默认15秒、宿主配置5–60秒：延续保守开发预算，未作性能校准。monotonic clock从backend读取前计龄，wall-clock只供展示，fake clock覆盖边界；到期get/候选均拒绝，不续期。见 [生命周期实现与未验范围](<observation-lifecycle.md>)。这不替代native目标重验；read-only observe可重新取得新观察。

有限 TTL 不是目标锁。每次 native 输入前仍必须重验。

## 3. 截图约定

ScreenshotRef 必须包括 artifactId、observationId、内容 digest、width/height、capturedAt、windowFrame、transformVersion、明确像素到窗口点的变换。当前 schema 定义 window-local points，offset 从窗口局部原点计算；coherent 截图必须与观察 frame 相同，映射不得越出该 frame。schema 内部一致性不证明实际采集时序一致。

截图与 AX 读取不保证系统级原子。后端应在截图前后核对 app/window/frame/revision。不一致则标注 non-coherent 或拒绝坐标动作。不能把 content digest 当作屏幕仍未变化的证明。

默认 screenshot=none。显式请求截图后，文件只能位于宿主管理、非公开静态路由的 artifact 区域。建议临时保留 15 分钟且 Session 结束时清理，以先到为准。保留更久需用户选择。删除仅针对插件 manifest 中的准确 artifact，先验证 realpath 与所有权，禁止递归删除整个 workspace。崩溃后启动进行 manifest 驱动清理。

截图对模型可见与文件日志留存分开授权。截图可能含敏感像素，不承诺通用脱敏。持久日志不存输入原文、完整私人 AX 树、照片或账号内容。

该要求必须覆盖 DSH 自身的 Tool 参数/结果、Session 日志、remote trace 与 crash report，不只是插件 logger。CU-001 必须核实官方字段级 redaction/ephemeral result 能力。若 host 默认持久化原文且没有插件可用的安全扩展点，则只能交付 fixture/公开测试数据版本；真实私人数据支持属于 no-go，除非用户单独决定接受并明确披露留存边界。禁止插件偷偷篡改官方 Session 日志、绕开审计或宣称已脱敏。

[CU-014a内存artifact store](<ephemeral-artifacts.md>) 已实现默认关闭的scope/逐次授权/单次ticket/字节reservation/TTL与owned副本清理。descriptor只关联id/digest/mediaType/size，不生成ScreenshotRef、不证明PNG/capture/coherence或effect；CU-014a2内部service已接live观察target/readgrant+独立policy与Session事件清理，未在入口安装，未接native、磁盘或真实consent。上述截图/文件留存要求仍归CU-014b，不因本切片降格。

## 4. 控制任务授权

建议字段：taskLeaseId、hostBoundOwner、目标 app process/window、mode、allowedOperations、allowedTargetClasses、dataSensitivity、expiresAt、idleTimeout、最大动作数、风险上限、批准来源、policyVersion、revocationVersion。

默认建议：绝对时限 10 分钟、空闲 60 秒、最多 100 个动作。它不是长期 app grant，重启不恢复控制授权。CU-008 需用使用场景校准这些默认值。

范围不能仅靠 window title、模型 reason 或模型声明“任务未结束”。账户/文档身份不可可靠取得时，承认它不是账户级隔离。MVP 不批准真实高影响任务。

## 5. 动作工具与 schema

拟议命名使用独立命名空间，例如 cu_*，最终名称由 CU-001 处理碰撞。下面是语义接口，不要求每个 intent 都单独暴露工具。CU-003 冻结 action proposal 与 host actionId 签发的具体 wire shape；不得让模型自行创造可执行身份。

cu_act 首次提交没有 host actionId 的 proposal 时只允许完成校验/准备并返回已签发 actionId，不产生 native 输入。后续携带该 actionId 才可进入审批与执行。host 若选择服务端原子 prepare-and-execute，必须用可信 callId 和持久 ledger 同等防重，并在 CU-003 更新本契约。没有可验证 callId 时采用显式两步，不能猜测重复是否属于同一次调用。

| 工具 | 模型输入 | 备注 |
|---|---|---|
| cu_list_apps | 有界过滤条件 | 不读 UI 内容；不能暗授 control |
| cu_observe | 精确 app 选择、可选 window、截图选项 | 先检查 read 许可 |
| cu_request_control | 精确观察与拟议任务范围 | 仅创建 proposal，host 审批后签发授权 |
| cu_act | 准备时为 taskLeaseId、observationId、单个 action；执行时回传 host actionId | 准备不输入；执行仅使用已绑定 proposal，一次一个动作 |
| cu_wait | observationId、闭合条件、timeoutMs | 不允许脚本表达式 |
| cu_status | actionId 或 taskLeaseId | 只返回同一可信 owner 的记录 |
| cu_release | taskLeaseId | 自己的授权释放 |

全局暂停/停止来自鉴权 UI 或本地紧急停止，不依赖模型是否愿意调用工具。

当前基础 action union 仅 press(targetHandle)、set_value(targetHandle,value)，尚不对模型暴露。后续 P0 受控扩展才加入 type_text(targetHandle,text,method)、key(targetHandle,key,modifiers)。keyboard route 必须单独具备能力并验证焦点。默认不公开任意 perform_action。需要原生 AX 特殊动作时，增加已审查的具名枚举。

P1 增加 scroll、drag、coordinate_click。coordinate action 必须引用 screenshot artifact 与 observation，使用 screenshot pixel 空间，不在第一版同时开放三种坐标空间。

模型可提高风险提示，但不得降低宿主风险。不要保留可绕过检查的 sensitive=false 开关。

## 6. 宿主风险策略

每个变更动作先根据已授权范围、应用能力、目标类型、动作类型、数据出口和可验证证据计算风险下限。模型分类器只能额外提高警觉，不能覆盖硬规则。

- DENY：系统授权、管理员认证、未经批准的应用/窗口、真实高影响操作、未知 protocol。
- REQUIRE_APPROVAL：更改模式、范围扩大、不能独立确认的变更效果，以及宿主配置需要批准的动作。
- ALLOW_WITHIN_LEASE：只在用户明确允许的低风险测试/编辑范围内，且目标与动作满足明确规则。

“按钮不含危险关键词”不能成为低风险证明。没有业务语义证据的通用 AXPress 至少需要明确范围批准；纯坐标变更不能靠模型降级为低风险。MVP 默认拒绝真实付款、发送、不可逆删除和账户变更，即使模型请求确认。

当 approval policy=never 时，需要审批的动作返回 APPROVAL_UNAVAILABLE，并且不得执行。不能自动打开权限设置或替用户确认。

## 7. 单次批准

批准由 host 创建 canonical envelope：actionId、taskLeaseId、owner、目标身份、normalized action、输入值的私密摘要、mode、riskDecision、policyVersion、revocationVersion、materialContextDigest、过期时间。

不在持久日志存输入原文或可枚举的裸密码 hash。私密摘要可用 host 内存 key 的 HMAC；Session 结束销毁。UI 只显示脱敏概要，不把模型提供的 reason 当真实影响。

建议 approval TTL 60 秒。审批等待不持控制锁。批准返回后重新取得锁并重验：owner、lease、target、输入摘要、mode、policy 与 material context 有任一变化则废弃批准。重新绑定也必须重新批准。

消费发生在最后一次重验通过之后、native 输入之前。消费与 dispatch 受同一 coordinator 阶段锁保护，防止一次批准并发使用。helper 若在消费后拒绝，则记录未执行并要求新批准，不返还可重放 token。

## 8. 并发、幂等与取消

- 一次 cu_act 只对应一个 actionId。后端至多执行该 actionId 一次。
- actionId 由 host 为一个已校验 proposal 签发，包含可验证签名和截止时间。模型只能回传，不能自行延长有效期。
- 相同 actionId 和相同 payload：在同一运行代中，正在执行回状态，已结束回既有脱敏回执，不重复输入。
- 相同 actionId 配不同 payload：ACTION_ID_CONFLICT。
- 进程崩溃或 transport 断开后无法确认已执行阶段：execution=unknown，禁止自动重放。
- 高权限本地 action ledger 仅记录 actionId、owner namespace、带密钥的 opaque fingerprint、阶段与过期，不保存输入。每次 dispatch 前先持久化 dispatch_pending 并完成 durable write；如果写入失败则不 dispatch。helper 收到并可能输入后，transport 未返回只能保守 unknown。
- tombstone 至少保留到 actionId 有效期结束并加时钟容差；过期 actionId 在 ledger 清理后仍因签名时限被拒绝。重启销毁旧 Session 的 payload HMAC key，不尝试恢复输入；旧记录一律只供查询终态摘要或返回 unknown/replay_rejected。不能通过换 actionId 自动重做未知效果。这不是 exactly-once 的业务保证。
- 一个 OS 用户的实际 native 变更需唯一 broker/系统锁。多 host 无法协调时禁止变更，而不是各自继续。
- 锁不允许跨审批等待。协调锁失效或 broker 失联时停发新动作。原生释放只能清理已受管的键/鼠标状态。
- cancel 在 dispatch 前：not_executed。dispatch 后：cancelled 或 unknown，并说明已发生效果不能撤销。
- 进程内动作在 native 结束、回读/不确定性回执完成前不释放目标锁。

## 9. 动作回执

```typescript
interface ActionReceipt {
  actionId: string;
  execution: 'not_executed' | 'attempted' | 'completed' | 'cancelled' | 'unknown';
  target: 'exact' | 'rebound' | 'invalid' | 'unknown';
  effect: 'verified' | 'no_change_observed' | 'unverified' | 'unknown';
  taskOutcome: 'not_evaluated' | 'verified' | 'unverified' | 'unknown';
  evidence: EvidenceRef[];
  observation?: Observation;
  error?: { code: ErrorCode; phase: ActionPhase; retry: 'never' | 'observe_first' };
}
```

execution=completed 仅代表 native 动作序列完成。effect=verified 必须引用实际目标回读或其它明确后置条件。taskOutcome=verified 还需要单独的任务 verifier，不得由“树有变化”推导。

无变化不证明失败。native 尝试后 readback timeout 必须保留 attempted/unknown，不可写 not_executed。新观察失败不抹掉已执行事实。unknown execution只能配unknown effect，不能输出no_change/unverified掩盖可能派发。

[CU-013a host回执](<action-receipts.md>) 已实现上述保守阶段投影、不可变终态与取消后事实保留，但ACK/target仍来自host报告，不认证native或evidence；真实回读/任务verifier组合仍属CU-013b。

## 10. native 协议

建议版本 1，固定 command union，长度上限、超时、requestId、broker generation、控制任务摘要、完整 action payload 校验。双方拒绝未知版本和字段。屏幕/API 名称不能变成任意原生 constant。

helper 接收后必须独立检查 app process/window/target 和模式能力，不仅相信 TS 传来的布尔结果。最后重验到输入的时间间隙不能消除，必须写入能力保证。

IPC 不采用宽松本地 HTTP 控制端口。优先 managed child stdio/XPC 或 Unix socket 的窄协议。父进程拓扑、socket ownership、code signature 与 nonce 各能防什么必须单独记录。普通 shell 拒绝测试不证明可隔离同用户恶意代码。

helper 源 digest、binary SHA、架构、deployment target、代码签名与协议版本应进入 manifest。[CU-024a本地gate](<helper-artifacts.md>) 已核对源码+recipe/manifest/binary/Mach-O开发一致性，严格预算并在每次read前运行；不认证publisher或原子exec。签名策略和发布身份在CU-024b冻结，不默认假装存在Developer ID/notarization。

## 11. 错误与预算

建议稳定错误：UNSUPPORTED_PLATFORM、CAPABILITY_UNAVAILABLE、READ_DENIED、CONTROL_DENIED、LEASE_EXPIRED、OBSERVATION_EXPIRED、TARGET_CHANGED、TARGET_AMBIGUOUS、FOCUS_CHANGED、APPROVAL_REQUIRED、APPROVAL_UNAVAILABLE、APPROVAL_INVALIDATED、CONTROL_BUSY、USER_INTERVENED、ACTION_ID_CONFLICT、NATIVE_TIMEOUT、EFFECT_UNKNOWN、CANCELLED、PROTOCOL_MISMATCH、ARTIFACT_INVALID。

error 中不能包含安全字段、完整输入、私密窗口名称或任意 native error dump。

建议默认预算：native action 5 秒、postcondition 2 秒、只读 observe 10 秒、整体 hard cap 15 秒。按原生操作实际成本校准并记录。不同 phase 不能把 timeout 都映射成未执行。

## 12. 提案落地方式

CU-003 把本文件映射为 schema、error enum、fake clock 与 fake backend 的合约测试。后续任何新增参数须同时更新运行时校验、工具描述、native schema 与验收。不能出现文档允许但 native 忽略的字段。

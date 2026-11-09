# DSH 0.2.2-rc.1 兼容调查

日期：2026-11-08。只读检查当前 Desktop ASAR 与 npm 相同版本 SDK，并在独立内存 Cordis 容器验证最小注册。未安装到用户 Profile，未验证真实 Web UI。

## 已确认 API

下列位置是相应 npm package 的内部源位置，供按锁定版本查阅，不是本仓库链接。

| 能力 | 实际接口 | 证据 / 约束 |
|---|---|---|
| tools | `register(ToolDefinition)`，`execute(args,exec)` | tools lib/index.js:426–445；必须声明 output.schema/render，注册返回 disposer |
| 运行身份 | `exec.agent`、`exec.callId`、`exec.signal` | pipeline.js:28–69、293–339、455–479；没有 exec.workspace |
| live Agent | `ctx.agents.get(id)` | exact object 核对，不仅比 string id；Agent.id 与 Session.id 共用身份 |
| live Session | `ctx.sessions.get(id)` | exact Session 核对；没有使用 Session.dispose 假 API |
| turn | `ctx.agents.turnBoundaryOf(session)` | openTurnStartSeq、lastTurn；关闭 turn 不签上下文 |
| 当前目录 | `ctx.workingDirectory.get(session)` | npm declaration line 58–62；Session.header.cwd 只是初始目录，不能代替当前目录 |
| 生命周期 | Cordis `ctx.plugin` / fiber.dispose、注册 effect disposer | 独立 effect 的 unload 可并发，需顺序清理时使用同一 composite generator |
| Agent/Session 结束事件 | agent/disposed 为 `{agent}`；session/disposed 直接传 session | 事件不等于已等待 native drain，后续 helper 需自己取消/排空 |
| 审批 | ApprovalService.request | 必须 open turn；only allowed-once 授权；never/rejected/cancelled/unavailable 都不放行 |

approval.effectivePolicy/decide在公开npm declaration中是private，不能直接调用。已核实overrideOf(exactSession)和config.policy是公开接口，可只读计算override ?? config ?? ask；never无需request便拒绝，ask不保证answerer可用或用户会批准。

request(req)需要exact Agent/open turn、toolName/callId/safe reason/signal，仅返回allowed-once/rejected/cancelled/unavailable；没有action fingerprint/lease/scope/TTL绑定字段。reason会进入audit，displayReason仅展示。插件必须自己做canonical绑定；不调用setPolicy或注册全局allowed-once answerer绕过。当前 [SDK adapter](<../../src/host-adapter/approval.ts>) 默认disabled，仅fake host seam已验；没有发真实request。

## 工具日志：私人数据 no-go

实际顺序：start call → Session.append tool/call 原始 arguments → prepare / schema / policy → body → output projection / finalization → tool/result。

- tools pipeline.js:104–112、185–194 在工具校验前记录原始 arguments。
- pipeline.js:196–212 记录最终 content/meta。projectContent / finalizeContent 只影响结果，不删除已记录的参数。
- Session.append 深拷贝冻结并提交后才通知观察者。surface projection 不改原 durable event。
- 已读 ToolDefinition 与注册/执行路径没有按工具 skip-log、redact-call 或 ephemeral 输入开关。

因此 strict schema 只能拒绝执行，不能保证非法调用中的机密文本未留存。当前插件不请求/产生私人数据，但 host 仍可能记录收到的非法参数。禁止宣传“插件脱敏就不会留日志”。不修改官方审计、不自行关闭 batch log。

## 运行验证范围

[profile 测试](<../../tests/profile/plugin.test.ts>) 使用真实 Cordis、SystemPrompt、ToolsService 与官方工具 pipeline。验证状态工具注册、卸载、重载、名称冲突、未知参数与 abort。它不等于完整 CLI/Web Profile 兼容验收。

[host seam 测试](<../../tests/unit/host-context.test.ts>) 使用真实 Session 对象和窄 registry 适配 fixture，验证 exact object/open turn/current directory。它不是完整 Agent loop 的端到端验证。

[read runtime适配](<read-runtime.md>) 已使用公开agent/disposed、session/disposed/session/event（working-directory/change）和exact effect disposer复合卸载；真实Cordis/SessionStore+managed故障child取消/退出已验。Agent registry/turn/cwd仍narrow fixture，不冒称完整AgentLoop/WorkingDirectoryService或真实Profile安装；status入口仍不安装runtime。

## 后续门槛

- CU-005 已验证 public subprocess spawn/control/done/terminate/waitForExit 的 health-only 切片，见 [通信设计](<native-transport.md>)。没有使用私有 provider API。
- CU-006：精确 fixture process/window/AX 身份和 observe 协议，尚未读取 UI。
- CU-016：Settings/RPC 鉴权、独立 stop UI、实际既有 GUI URL 验证。
- CU-024/025：平台/签名/包集成、真正临时 CLI/Web Profile 与停止清理。
- CU-026：实际模型工具调用。没有模型凭据或测试记录时记 not_run。

这些缺口不阻止纯合同与 fixture 建设，但阻止相应外部能力开放。

# Quality score

Last reviewed: 2026-11-09（Pacific/Auckland）。按已运行证据描述，不给没有基准的 A/B 等级。

| 领域 | 当前状态 | 证据 | 未验证边界 |
|---|---|---|---|
| 产品/仓库 | 已确认并开工 | [实施基线](<design-docs/implementation-baseline.md>) | 真实应用任务未定 |
| 文档与计划 | 已迁入，持续结构检查 | [计划](<PLANS.md>)、29 父卡/34 验收 | 结构通过不证明 runtime |
| DSH 注册 | 内存容器 verified | [profile tests](<../tests/profile/plugin.test.ts>) | 不是完整 CLI/Web Profile |
| 合同 | 单元 verified | [contracts tests](<../tests/unit/contracts.test.ts>) | schema 不认证批准/evidence 来源 |
| 可信上下文 | 窄 host seam verified | [host-context tests](<../tests/unit/host-context.test.ts>) | 不是完整 Agent loop e2e |
| 模块边界 | AST sensor verified | [sensor tests](<../tests/unit/invariants.test.ts>) | 不是恶意代码沙箱 |
| 开发包 | build/entry smoke verified | [package tests](<../tests/unit/package.test.ts>) | 不是实际 pack 安装/签名/发布 |
| 固定开发验证 | 8步实际退出码/严格test分母、untracked源码前后指纹/HEAD/dirty、NO_GO摘要已实跑 | [验证器](<design-docs/foundation-verification.md>) | 默认无native；指纹非执行闭包/原子snapshot/签名，绿灯不是MVP/release |
| 本地helper一致性 | source/recipe/manifest/binary/Mach-O与bounded FD读取已验 | [产物gate](<design-docs/helper-artifacts.md>) | 非publisher签名/原子exec/同UID隔离，不涵盖fixture/stop分发，CU-024b未完成 |
| fixture 观察 | reader/投影部分实现；拒绝路径verified | [观察设计](<design-docs/fixture-observation.md>) | TCC缺失，native成功路径NOT_RUN，CU-006未完成 |
| 观察生命周期/单次intent | host有界观察成员、private witness与readgrant派生HMACintent/继承TTL/事件清理已验 | [生命周期](<design-docs/observation-lifecycle.md>) | 只是read candidate，不接controlruntime/consent/native或输入，不执行写入 |
| fixture只读目标重验 | witness/纯策略/API边界负测与真实helper拒绝已验 | [重验设计](<design-docs/fixture-revalidation.md>) | private handle/授权service已host单元验；AX成功lane exit3/NOT_RUN、rebind未实现，CU-007b2b仍依赖006c |
| fixture读授权 | 纯host默认拒绝内核及service单元verified | [授权设计](<design-docs/read-authorization.md>) | 内部事件适配另有验证，未接用户consent/配置UI/生产入口/native成功 |
| 只读runtime/宿主事件 | private组合/Agent与Session退休/cwd变更/重载隔离已验 | [runtime设计](<design-docs/read-runtime.md>) | 真Cordis/SessionStore+managed取消，不是完整AgentLoop/consent/生产入口或native drain |
| 控制策略/内部runtime | inert lease/risk及私有策略+共享scope/公开Session事件撤销已验 | [控制设计](<design-docs/control-authorization.md>)、[runtime](<design-docs/control-runtime.md>) | 无native exact/真实consent/执行器/生产入口，CU-008b2仍未完成 |
| 单次批准绑定/内部生命周期 | HMAC/单次/epoch及live inert lease-risk/host复检、bound模拟答复与事件撤销已验 | [批准设计](<design-docs/single-use-approval.md>) | 未调用真实prompt/未认证观察或native/未接coordinator，CU-009b未完成 |
| 宿主协调/内部生命周期 | inert FIFO/lease-derived claim/固定policy评估、事件批量撤销、stop-drain-resume verified | [协调设计](<design-docs/host-coordination.md>) | 无caller执行闭包/批准消费/ledger；未接生产broker/独立stop/native，不是A-10/19完整验收 |
| 跨进程锁原语 | 真实Darwin flock临时namespace verified | [lock tests](<../tests/transport/control-lock.test.ts>) | 生产per-user namespace未部署，CU-010未完成 |
| 独立停止原语 | 临时namespace真实第三进程stop-only验证 | [停止设计](<design-docs/independent-stop.md>) | 只有inert drain，不是用户入口/native排空/停止延迟验收 |
| host动作账本 | 签名短期ID/冲突、fsync pending、真实kill只读恢复verified | [账本设计](<design-docs/action-ledger.md>) | 不接native/批准/唯一broker，不是业务exactly-once，CU-011未完成 |
| 固定namespace/发现CLI | 固定路径策略、safe publication、stop-only本地构建verified | [路径与发现](<design-docs/control-namespace.md>) | 仅owned-parent正向、CLI help/拒绝，无生产stop调用/安装验收 |
| 生产幂等/用户停止 | 未完成 | 不对模型开放 native | CU-010b2b2/c、CU-011b/016 |
| AppKit fixture | 构建 + hidden self-test verified | [fixture tests](<../tests/fixture/fixture.test.ts>) | 未显示 UI，无外部 AX/input/TCC 验收 |
| native transport | health与fixture读取拒绝verified | [transport tests](<../tests/transport/>) | 无成功UI读取验收，不是输入安全证明 |
| 保守阶段回执/固定评估接线 | kernel单调事实及private固定policy→not_executed终态、scope先封存/迟到首terminal、typed拒绝已验 | [回执设计](<design-docs/action-receipts.md>) | 不认证native/观察来源/ledger或效果，无ACK/dispatchruntime入口，CU-013b未完成 |
| 内存artifact暂存/内部生命周期 | 默认关闭、逐次独立policy+live观察target/read grant、字节预算/TTL、真实Session事件清理与abort前owned清零已验 | [暂存设计](<design-docs/ephemeral-artifacts.md>) | 无capture/PNG认证/磁盘/公开route/生产入口consent，非可信evidence，CU-014b未完成 |
| 原生动作与真实 app | fixture语义动作helper+API边界桩verified；native lane NOT_RUN | [action adapter](<../tests/fixture/action-adapter.test.ts>)、[transport](<../tests/transport/action.test.ts>) | 缺AX未实跑；未接host授权组合/模型；真实app未授权，CU-012a2/015/020 |
| 隐私 | 私人数据 no-go | [SDK 日志调查](<design-docs/sdk-compatibility.md>) | host 会记录收到的原始参数，strict schema 不能补救 |
| UI/模型 | 未实现/未运行 | 没有演示或成功率声明 | CU-016/026 |

准确环境、红/绿和独立审查修正见 [基础验证记录](<verification/foundation.md>)。

每项状态升级必须有实际代码、命令和退出码。未运行、unsupported、skip 单独记录。不能把单元数量当成全部 34 项验收通过。

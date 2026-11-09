# 已知缺口与后续控制

日期：2026-11-08。已完成基础代码，不代表运行时控制已建立。

| ID | 状态与缺口 | 证据 | 后续 |
|---|---|---|---|
| GAP-01 | 文档语义真实性仍依赖 review | 机械 checker 只校验结构 | CU-027/028 |
| GAP-02 | 部分关闭：已有构建、fixture、read-only helper、host观察store；observe成功lane缺TCC，input未实现 | [命令](<../../package.json>)、[验证](<../verification/foundation.md>) | CU-005+ |
| GAP-03 | 已关闭：用户明确指定空仓库，worktree 与基础路线已记录 | [实施基线](<../design-docs/implementation-baseline.md>) | 未来复制第三方代码另记许可 |
| GAP-04 | 部分关闭：SDK/registry/context/approval/log 与 health transport 已核实；完整 Profile/UI 未验 | [SDK 调查](<../design-docs/sdk-compatibility.md>) | CU-005/016/025 |
| GAP-05 | fixture reader/只读重验witness与拒绝部分实现，host handle mapping/read-revalidate及观察派生单次intent/live成员readgrant复检已有（仅read candidate，不接control），真实AX成功缺TCC；rebind/输入竞态未验 | [观察](<../design-docs/fixture-observation.md>)、[重验](<../design-docs/fixture-revalidation.md>)，native lane exit3/NOT_RUN | CU-006c/007b2/012 |
| GAP-06 | 已有read与inert控制风险/批准host切片，批准私有接live inert租约/risk/host复检及事件撤销；已有内部read及inert控制runtime Session/Agent/cwd撤销，共享scope但授权私有；未接native/真实控制consent/执行事务/生产入口 | [控制策略](<../design-docs/control-authorization.md>)、[单次批准](<../design-docs/single-use-approval.md>)；不开放变更工具 | CU-008b2/009b |
| GAP-07 | host FIFO/flock/stop原语与fresh journal账本已验；内部livelease-derived claim/固定policy评估与公开事件/stop-drain生命周期已有，不接caller执行/批准消费/ledger事务；生产namespace/broker/live幂等未接 | [协调切片](<../design-docs/host-coordination.md>)、[账本](<../design-docs/action-ledger.md>)；不开放native | CU-010b2b/c、CU-011b |
| GAP-08 | 保守host回执与内存artifact暂存/内部runtime Session生命周期已验；固定policy评估已有私有not_executed终态/先seal后abort接线，无runtime ACK/dispatch口，不认证native/ledger；可信evidence/task verifier/capture/磁盘manifest/用户consent及生产入口未实现 | [阶段回执](<../design-docs/action-receipts.md>)、[内存暂存](<../design-docs/ephemeral-artifacts.md>) 不认证native/效果 | CU-013b/014b/019 |
| GAP-09 | stop-only/惰性drain与固定路径/发现/本地CLI已临时验；生产用户入口/native停止未验 | [独立停止](<../design-docs/independent-stop.md>)、[namespace](<../design-docs/control-namespace.md>)；未开放控制工具 | CU-010b2b2/c最小stop；CU-016完整UI |
| GAP-10 | 本地helper source/recipe/manifest/binary一致性已有；签名/许可/fixture-stop分发/真实包安装未定 | [artifact gate](<../design-docs/helper-artifacts.md>)、private开发包/built-entry smoke；非publisher认证 | CU-024b/025 |
| GAP-11 | 真实应用/模型没有验收 | 无本插件调用轨迹 | CU-020/026 |
| GAP-12 | 视觉/pointer 未实现 | P1 关闭 | CU-021–023 |
| GAP-13 | 私人数据 no-go：host 先记录原始 Tool 参数再校验 | [SDK 调查](<../design-docs/sdk-compatibility.md>) | 官方安全留存扩展点或另行明确决策；不私改审计 |
| GAP-14 | 宿主签名 Node 拒绝 npm native bundler | 最终用官方 WASM fallback，带 experimental warning | [运行说明](<../../README.md>)，不改签名或系统保护 |

每个 runtime gap 关闭都需要真实测试。写完合同或审查“未发现问题”不等于原生能力已验收。

卡片、依赖和 gate 见 [总计划](<active/2026-11-08-computer-use-mvp.md>)。

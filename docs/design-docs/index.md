# 设计索引

## 本包设计文档

| 文档 | 主题 | 状态 |
|---|---|---|
| [核心原则](<core-beliefs.md>) | 用户同意的产品定位如何约束实施 | unverified：有用户输入，尚无实现测试 |
| [插件设计](<plugin-design.md>) | 模块边界、依赖、能力门槛和演进顺序 | unverified：实施提案 |
| [接口约定](<contracts.md>) | 观察、任务、动作、确认、回执与原生协议 | 已有基础 schema 子集，其余为提案 |
| [实施基线](<implementation-baseline.md>) | 授权、空仓库、工作树、版本与路线 | 本机已核实 |
| [SDK 兼容调查](<sdk-compatibility.md>) | 真实 DSH API、日志与生命周期 | 源码核查 + 内存容器验证；未运行完整 GUI/Profile |
| [AppKit fixture](<fixture.md>) | 自有原生窗口与独立测试状态 | 已构建/hidden self-test；未运行 helper AX 输入 |
| [Native transport](<native-transport.md>) | health/fixture读取协议、取消/超时/终止 | 真实Swift+公开provider拒绝验证；无输入 |
| [Local helper artifacts](<helper-artifacts.md>) | source/recipe/manifest/binary与Mach-O开发一致性、每次spawn前检查 | 真实helper health与临时副本/故障负测；非签名/分发认证 |
| [Fixture observation](<fixture-observation.md>) | 精确身份、AX预算、secure投影与native gate | 部分实现；缺AX权限，native成功路径NOT_RUN |
| [Fixture revalidation](<fixture-revalidation.md>) | element lifetime witness/closed只读重验/完整扫描 | private handle/授权service单元+真实helper拒绝/pure/AX边界stub；真实AX成功NOT_RUN |
| [Observation lifecycle](<observation-lifecycle.md>) | host ticket/scope/TTL/成员候选与private观察派生单次action-intent | 单元/Session事件；HMAC与原obs/grant mono TTL，不接control授权/native/输入 |
| [Read authorization](<read-authorization.md>) | exact fixture只读grant、撤销与发布前复检 | host-only单元验证；无生产consent/工具/控制授权 |
| [Read runtime/lifecycle](<read-runtime.md>) | private只读组合/每次host绑定、scope撤销、公开事件与复合卸载 | 真Cordis/SessionStore+managed故障child退出，Agent registry/turn/cwd仍seam，非生产consent/drain |
| [Control authorization](<control-authorization.md>) | inert租约/动作白名单/独立风险/撤销预算 | host单元验证；无native/真实授权组合 |
| [Inert control runtime](<control-runtime.md>) | 共享exact-host scope/事件实现、私有policy逐call复检与撤销 | host单元+真Cordis/SessionStore与read/artifact回归；无执行/native/真实consent/生产入口 |
| [Single-use approval](<single-use-approval.md>) | canonical/HMAC/epoch/单次与私有live inert租约/风险复检、default-disabled SDK adapter | kernel/runtime+Session事件迟到模拟答复；未发真实批准/执行，obs/material引用未认证 |
| [Host coordination](<host-coordination.md>) | FIFO/claim/batch撤销、private livelease固定policy评估/stop-drain与Darwin flock原语 | host+Session事件/负面重入、真实临时目录跨进程；无执行/生产broker |
| [Independent stop](<independent-stop.md>) | stop-only UDS/私有继承能力/第三进程撤销与drain区别 | test namespace实测；未接用户入口/native排空 |
| [Control namespace](<control-namespace.md>) | 固定euid路径/FD witness、stop发现记录与本地CLI | 临时parent跨进程+故障、CLI构建；生产启动/安装未运行 |
| [Action ledger](<action-ledger.md>) | 签名短期id/私有绑定、append fsync pending与只读恢复 | 真实disk/kill/fault；host-only，不接native/live授权 |
| [Ephemeral memory artifacts](<ephemeral-artifacts.md>) | 默认拒绝/单次ticket/作用域与逐次授权/字节容量/TTL清理 | 公开bytes/内部live观察+grant+独立policy/真实Session事件、abort前清零与async refusal child；不capture/落盘/认证证据，CU-014b未完成 |
| [Action receipts](<action-receipts.md>) | closed阶段/ACK及private固定policy→not_executed回执、scope先seal/不可变终态 | kernel/runtime+真实Session/ledger seam；无native/效果/ledger来源认证 |
| [Foundation verification](<foundation-verification.md>) | 固定8步/实际退出码与分母、限定源码前后指纹/dirty、NO_GO | 公开copied-process seam及本机全suite；native缺权限NOT_RUN，不认证发布/控制/完整依赖 |

## 已核对参考资料

资料核对日期：2026-11-08。这里不重新抓取，也不把竞品源码当本插件实现。

1. [参考插件 README，固定 commit ea191366](https://github.com/Anionex/dsh-computer-use/blob/ea191366d52062acf8d3cc9ec1a6114c6b826101/README.zh.md)：AX 优先、定向输入、现有工具边界。
2. [参考插件 confirmation 实现](https://github.com/Anionex/dsh-computer-use/blob/ea191366d52062acf8d3cc9ec1a6114c6b826101/src/confirmations.ts#L87-L110)：敏感确认依赖调用方标记，这是要改进的控制边界。
3. [参考插件动作后检查](https://github.com/Anionex/dsh-computer-use/blob/ea191366d52062acf8d3cc9ec1a6114c6b826101/src/service.ts#L634-L678)：结构变化不证明业务成功。
4. [参考插件 MIT License](https://github.com/Anionex/dsh-computer-use/blob/ea191366d52062acf8d3cc9ec1a6114c6b826101/LICENSE)：复用代码须保留版权和许可；独立命名不抹掉来源。
5. [Claude Computer Use API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)：client toolset、截图闭环与集成方责任。
6. [Claude Desktop Computer Use](https://code.claude.com/docs/en/desktop#let-claude-use-your-computer)：应用权限与本机操作边界。
7. [OpenAI Computer Use API](https://developers.openai.com/api/docs/guides/tools-computer-use)：模型与执行环境分离。
8. [OpenAI driver 合同](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers)：审批回调与 driver 目标绑定责任。
9. [OpenAI 本机产品](https://learn.chatgpt.com/docs/computer-use)：Mac 后台与 Windows 前台行为不能混为一谈。

## 不可从资料推导的事实

- 不知道竞品闭源本机执行器是否 AX 树优先或使用哪种私有事件接口。
- 没有本插件的成功率、速度、费用或安全实测。
- 目标仓库、DSH SDK 和本机构建机器已核实，见实施基线。签名/发布策略仍未定。
- 用户已指定空仓库并授权开工。基础部分独立实现，未复制参考代码；未来复用另记来源许可。

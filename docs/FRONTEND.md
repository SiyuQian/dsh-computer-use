# Frontend：当前仅 AppKit fixture

没有 DSH Settings/Web client 插件。当前唯一 UI 源码是 [自有 AppKit fixture](<design-docs/fixture.md>)，用于可复现原生测试，不是产品控制面板。

## 实际约束

- 使用 NSWindow、NSTextField、NSSecureTextField、NSButton、NSStackView。
- 固定 accessibility identifier，不以屏幕位置作为控件身份。
- Primary 与 Secondary 独立 store。每次重排/替换都更新各自 oracle。
- 所有 AppKit 操作在 MainActor；异步延迟使用可取消 Task，reset 使其失效。
- hidden self-test 不显示窗口、不 activation、不注入键鼠事件。
- 文案只说明公开测试数据，不请求真实凭据。

改布局/控件行为必须先补失败的 self-test 或 fixture 测试，再运行 build:fixture 与 test:fixture。修改后的 source digest/binary manifest 由构建脚本重新生成。

## 产品 UI 门槛

CU-016 才实现 DSH 状态/停止/Settings。必须先核实官方 UI/RPC 和权限来源，再建立 Web 交互测试。使用当前 DSH 既有 URL 验证，不启动替代服务器冒充集成成功。

视觉约束见 [DESIGN.md](<DESIGN.md>)。实际代码见 [FixtureWindow.swift](<../native/Fixture/FixtureWindow.swift>)。

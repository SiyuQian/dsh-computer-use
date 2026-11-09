# 自有 AppKit fixture

状态：CU-004 的自有 app/build/hidden self-test 切片已完成。2026-11-08 已构建并运行隐藏 self-test，不等于 helper 的 AX/输入端到端验收。

## 目的与边界

为后续目标身份、过期、焦点、取消与结果证据提供可控制的原生测试对象。只处理公开测试数据，不使用真实账户、网络或用户文档。

bundle id：`dev.siyuqian.computer-use.fixture`。本机 arm64，编译 deployment target macOS 14.0；尚未在 macOS 14 或 Intel 运行。

## 已有结构

- [FixtureState.swift](<../../native/Fixture/FixtureState.swift>)：测试专用状态，原子写入 fixture-state.json 与 saved-copy.txt；secure field 不进入状态结构。
- [FixtureWindow.swift](<../../native/Fixture/FixtureWindow.swift>)：固定 AX identifier 的文本、模拟 secure field、submit、替换/重排、延迟、保存副本、reset；可创建两个窗口。actionable控件另有AXHelp生命周期UUID，replace新建/reorder保留/secure不发，hidden自测核对；外部AX重验成功尚未验，见 [重验切片](<fixture-revalidation.md>)。
- [main.swift](<../../native/Fixture/main.swift>)：闭合启动参数、hidden self-test 与可见测试模式。没有 shell/script/输入注入接口。
- [构建脚本](<../../scripts/build-fixture.mjs>)：swiftc、app plist、source/binary digest manifest。
- [fixture 测试](<../../tests/fixture/fixture.test.ts>)：构建产物、AppKit self-test、未知启动参数拒绝。

状态目录必须是调用者明确提供的绝对、已存在、空目录，且路径无 symlink。Primary 在根目录写固定名字文件，Secondary 在固定 secondary 子目录使用独立 store，窗口之间不共享 text/layout/oracle。程序不递归清理。测试框架只删除自身 mkdtemp 返回的准确路径。

目录/文件权限设为 0700/0600。realpath 检查不是对同用户恶意代码的强隔离，不作该保证。正式 helper 的路径边界另有独立设计。

## 真实命令

```sh
pnpm run build:fixture
pnpm run test:fixture
```

build不启动app。测试执行`--self-test`和`--observe-host`，创建真实AppKit对象但不显示窗口，不调用AX输入、CGEvent、系统光标或权限提示。observe-host发布kernel processStart和真实windowNumber/生命周期UUID，等待stdin EOF退出，详见 [观察设计](<fixture-observation.md>)。自测读取独立状态文件和保存副本，而不信任被测 helper 返回。

可见模式仅供后续明确 native fixture 测试，不在当前 self-test 自动启动。用户可用独立空临时目录手动启动 app 二进制并通过关闭全部窗口退出。Agent 不借此操作其它 app。

## 后续未验证

- helper 通过 AX 看到准确字段和多个窗口。
- AX set_value/press 与焦点变化、后台行为、TCC。
- 用户/Agent 并发与受管按键释放。
- 最低 OS、Intel、签名/发布和 GUI 真实视觉检查。

这些不得由 self-test 的通过推导。验收归 CU-005 及以后任务。

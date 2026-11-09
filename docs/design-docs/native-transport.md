# Native transport：health-only 切片

状态：CU-005 的 health/transport 子集已实现并验证。CU-006已加入fixture-only读取协议/reader，但成功AX路径未验收；见 [观察设计](<fixture-observation.md>)。没有read授权签发器或输入能力。

## 已实现路径

[health 客户端](<../../src/backend/macos/health.ts>) → `ctx.subprocess.spawn` → 固定 app-owned binary → inherited fd 7 launch frame → 有界 stdin health request → 单帧 stdout → strict schema/ID 匹配 → managed range 退出。

真实 public API 来自 `@deepseek-ai/dsh-subprocess@0.2.2-rc.1`：spawn 返回 handle.done、terminate、waitForExit。prod 不从模型接收 executable、argv、cwd 或 raw protocol；客户端只接受宿主固定 root 与调用 signal。当前root由内部调用方选择，新增 [本地开发helper一致性gate](<helper-artifacts.md>) 在每次spawn前核对source/recipe/manifest/binary/Mach-O；发布签名/安装路径仍归CU-024b。

## Wire version 1

请求字段只有 protocolVersion=1、requestId、launchId、command=health。requestId/launchId 是宿主 randomUUID，不从模型继承。

- stdin：一个 JSON 帧，以 LF 结束，然后 EOF。最多 8192 payload bytes。
- fd 7：单个 launchId LF，最多 128 bytes。类型必须是 inherited socket/FIFO。
- stdout：一个 health JSON 帧，以 LF 结束。客户端总输出最多 8192 bytes，拒绝额外/截断帧。
- stderr：原生固定错误码；host 只收集 256 byte tail，不 spill，不向工具结果透传。
- 超时默认3秒，允许50–10000ms，包含本地artifact检查；timer加mono deadline在文件段/spawn前/done与parse后复查，计时器尚未触发也不能发布越界结果。取消或超时无自动重试。
- stop 通知与 done race。无论 provider 是否 settle，都会进入 terminate + 最多 2 秒 cleanup。不能证明退出时返回 NATIVE_CLEANUP_FAILED，不谎称 quiescent。

Swift 手工检查 key set、ID、数字版本不为 Bool、launch 配对、单帧/EOF。TS 使用 [health schema](<../../src/contracts/health.ts>) 做回执校验。两端 wire 行为由真实 transport 负向测试约束，不声称 Swift schema 已自动生成。

## 能力与权限诊断

health分支只调用AXIsProcessTrusted、CGPreflightScreenCaptureAccess，返回布尔状态，不请求TCC、不截图、不遍历窗口或UI树。observe_fixture分支见独立设计；响应上限262144bytes，其余health上限保持不变。

commands=[health, observe_fixture, revalidate_fixture]，新 [只读重验](<fixture-revalidation.md>) 使用closed descriptor/canonical request且dispatchable=false。axObservation/mutation/keyboard/pointer仍全false，因为AX成功lane尚未验收，无产品UI读取工具。health分支只做preflight；内部observe_fixture严格限自有固定binary，另有target绑定。诊断不构成任何UI授权。

## 身份与安全上限

fd 7+随机 launch 只防止普通误调用和跨请求串线，不认证同用户任意恶意程序。不能把 ordinary shell 拒绝等同安全隔离。

build生成本机architecture、deployment target、source+recipe/binary digest与commands manifest；每次read前检查开发产物一致性及bounded file/metadata/Mach-O。它不验证publisher签名，也不保证已验证path与实际执行binary系统原子绑定，见 [准确边界](<helper-artifacts.md>)。CU-024b未完成前不得发布或开放native mutation。

当前 helper 没有网络监听、本地 HTTP、任意脚本、shell、selector 或输入指令。

## 验证

- [真实 transport tests](<../../tests/transport/helper.test.ts>)：Swift 成功、普通直接调用拒绝、非法版本/Bool/未知字段/launch/ID/超长/JSON/多帧/截断；故障 child 的错误响应/崩溃/挂起、取消、timeout、range quiescence。
- test-only provider 用真实 public runtime spawn fault child，不能由产品参数选择。
- in-memory provider 故障用例验证 done 永不 settle 仍进入 cleanup。异步 cleanup 失败有界报告，不代表能杀死所有同用户进程。
- 内部错误类型只允许固定错误透传，上游带 NATIVE_ 前缀的错误同样脱敏。

## 拆分后的后续依赖

CU-005a/b/c 只完成上述 health 与生命周期。精确 process/window 身份与 observe/list wire 必须在 CU-006 开始时先扩展 strict native schema 与负向测试，再接自有 fixture；没有 read 授权不读取私人应用。CU-007 再做 observation 生命周期和目标重验。

CU-005 不是 native MVP 完成。native input、TCC、可见 GUI 与业务 verifier 仍未验收。

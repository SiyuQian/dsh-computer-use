# Fixture-only observation：部分实现，native 成功路径未验收

状态：2026-11-08。CU-006 in_progress。严格读取协议、投影、真实进程身份拒绝、无权限拒绝有执行证据；辅助功能权限缺失，不能把 native AX 成功路径列为通过。

## 当前实际路径

内部 [observe 客户端](<../../src/backend/macos/observe.ts>) → [共享受管 transport](<../../src/backend/macos/transport.ts>) → [fixture AX reader](<../../native/Helper/FixtureObservation.swift>) → [raw snapshot schema](<../../src/contracts/fixture-observation.ts>) → [public projection](<../../src/observation/project.ts>)。

没有模型可调用的 observe 工具，没有通用应用枚举，没有截图或输入。一般 cu_status 仍不调用 helper，nativeControl/privateData 仍为 false。内部读接口不是 read 许可签发器，后续 CU-008 必须在 service 前验证可信 host grant。

## 目标与身份

请求必须给出 pid、processStart、windowKey、windowId、windowInstance；不能传 bundleId、脚本、任意 AX selector 或路径。

1. [ProcessIdentity](<../../native/ProcessIdentity.swift>) 对指定 PID 使用内核 proc_pidinfo 的 start timeval、uid 与 proc_pidpath。仅支持同用户。
2. helper 只接受自身同目录的自有 CUFixture app executable，且 bundle id 为 dev.siyuqian.computer-use.fixture。不枚举其它进程，不按标题模糊搜索。
3. 先核对精确 executable+start，再检查现有 AX 权限。无权限返回 READ_DENIED，不请求 TCC。
4. 自有 NSWindow 通过 AXIdentifier 发布真实 AppKit windowNumber 和窗口创建时的一次性 UUID。请求与最终 AX window witness 必须完全匹配，返回前再次核对 process/witness。
5. 第三方应用没有同样 witness，本实现不支持，不能用固定 1/2 或新 UUID 假装窗口身份。没有声明签名认证或抵御同用户恶意 native code；CU-024 的产物 gate 未完成。

hidden --observe-host 启动自有控件，输出有限 readiness（pid/start/两个窗口 witness），等待 stdin EOF 后退出。不会显示窗口、激活前台或输入。当前本机验证两个真实窗口编号均正数且不相同。若后续 OS 无法暴露 AX windows，native lane 必须失败，不改前台模式补演示。

## 读取预算与隐私

- 请求帧 8192 bytes，响应帧最多 262144 bytes（health 仍8192）。单帧、request/launch 匹配、同一套 timeout/cancel/cleanup。
- 最多8个窗口，歧义拒绝；树最多64个节点、深度12；每次子数组最多64。AX messaging timeout 0.2秒，整体host deadline默认3秒。
- 每个 label最多256 UTF-16 units，public value最多1024；明确 coverage truncated/reasons。public schema更宽，reader/projection采用较小预算。
- 原生值读取仅正向确认的 AXTextField + fixture.text + 可读取且已知 subrole。缺失/失败/未知元数据按secure处理。secure、unknown不调用value getter，不列set_value。
- [原生策略测试](<../../tests/fixture/native-policy.test.ts>) 编译真实 Swift policy并注入计数value getter；验证缺失/冲突/安全字段计数0，公共字段计数1。它证明本地guard，不是外部AX不泄密证明。
- TS投影再检secure/identifier/subrole、角色与action对应，不输出nativeId或raw AX属性。
- actionable fixture node可附内部elementInstance（AXHelp生命周期标记），供 [只读重验](<fixture-revalidation.md>)；公共投影不输出该标记或nativeId。
- public handle每次新建。当前无可执行target store，不能拿这些handle直接写入。structureRevision是公共内容/帧摘要，不是控件对象身份或因果证据。

## 已运行与未运行

[projection tests](<../../tests/unit/observation.test.ts>)：精确target、secure兜底、budget、opaque handle、严格字段、TTL形状。时钟生命周期归CU-007，不能把wall-clock shape当monotonic expiry。

[transport tests](<../../tests/transport/observation.test.ts>)：真实helper拒绝Node/不存在进程、非法target在spawn前拒绝、Swift边界非法字段/Bool/window identity拒绝。

[fixture tests](<../../tests/fixture/fixture.test.ts>)：真实hidden fixture readiness、同用户kernel start、活进程且TCC=false时READ_DENIED、start不匹配和进程退出时TARGET_CHANGED。不读取私人app。

显式 native lane：`pnpm run test:native-observation`。该命令先health。无AX权限退出3并写NOT_RUN，不启动fixture、不弹权限，不以skip/pass覆盖。权限已有时才用hidden fixture断言两个窗口的真实AX字段、secure省略、重复观察identity稳定、错误窗口instance拒绝；该成功分支尚未运行，可能仍有真实AX兼容问题。

本轮实际运行得到 accessibility=false，exit3。因此CU-006没有完成，A-04/A-05/A-21只完成基础与拒绝子断言。所有native mutation继续关闭。

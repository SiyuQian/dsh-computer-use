# Local helper artifacts：CU-024a 开发一致性门槛

状态：2026-11-09 Pacific/Auckland。只覆盖本地read-only CUHelper构建与每次managed read启动前的一致性检查，已经真实构建/helper health与临时副本篡改负测；不认证发布者，不代表签名/notarization、fixture/stop完整分发、安装或AX成功。CU-024b仍未完成，没有native输入工具。

## 为什么独立于签名发布先做

此前builder只记录source/binary digest，transport直接spawn固定路径；源码修改而未重建也可能使用旧helper。当前 [helper-artifact](<../../src/backend/macos/helper-artifact.ts>) 每次read核对固定checkout和开发manifest，再交 [transport](<../../src/backend/macos/transport.ts>)；不从model接收路径/manifest/hash白名单，不缓存通过结果，不通过重试/自动编译修复。

它防止陈旧、误替换、截断/格式错误或元数据不一致的开发产物被无检查启动。manifest与源码都在同UID可写checkout，所以能同时修改代码/manifest/binary的恶意本地程序可构造另一套自洽内容；不能据此证明publisher、源到binary可复现编译或防恶意compiler。

## 构建与固定摘要

[build-helper](<../../scripts/build-helper.mjs>) 使用固定7个Swift源文件，以host arch转换arm64/x86_64、deployment macOS14.0、Swift6和固定framework参数编译。sourceDigest按固定顺序逐个追加路径UTF-8与文件bytes，包括最后的build recipe本身；无环境提供的sources/commands。verifier独立维护同样closed list，真实build+health tests约束二者drift。

编译前捕获source+recipe digest，swiftc成功后复读比较；不同则ARTIFACT_INVALID，不发布新manifest，不打印成功。保持旧manifest时旧binary hash/源码不匹配仍会被runtime gate拒绝。两次读取不是私有编译快照，无法抵御编译中改写再原样恢复的同UID恶意操作；也不校验compiler供应链。进程崩溃/部分manifest写入由下次gate拒绝，尚无原子release目录分发。

manifest固定字段/格式：protocolVersion1、commands=[health,observe_fixture,revalidate_fixture]、architecture当前进程对应值、deploymentTarget14.0、sourceDigest/binaryDigest lowercase SHA256、distribution=local-development-only。strict schema拒未知key，再比较builder的固定pretty JSON+LF编码，重复key（即使同值）不能被JSON.parse吞掉。不是通用JSON消费者；手工改格式同样须重建。

## 路径、文件与读取预算

- 调用方root必须absolute、normalize后相同、canonical且无trailing separator；root和每级涉及的目录都经lstat/realpath检查，不追随symlink。内部路径固定，manifest不决定任何读取/执行路径。
- root/涉及目录及files要求当前effective UID、不可group/world write、不带setuid/setgid；目录必须directory。文件必须regular/nlink1；binary至少owner executable。不chmod修复可疑对象。
- manifest最多4096bytes；8个source/recipe单文件最多262144bytes（总上限2MiB）；binary最多16MiB；均拒空。stat上限先于分配，不无限readFile。
- 每次以O_RDONLY|O_NOFOLLOW|O_NONBLOCK打开，验证named lstat与FD stat一致。按最多64KiB循环读取到原size，允许short read，zero/异常拒绝；读后FD/named path再核对dev/ino/mode/uid/nlink/size/mtimeNs/ctimeNs和canonical路径。finally close，包括read/close失败。
- hash后再次检查root/目录与各file的metadata witness，紧接spawn前再核对时限与取消。无缓存，不因前一次health通过而省略后续检查。

这些path/metadata witness不是系统原子exec：检查通过到subprocess provider实际执行之间仍有路径替换窗口。Node/provider不提供已验证FD的原子exec绑定；当前不据此开放native mutation。目录内容可变也不等于强沙箱，不声称对同UID恶意代码安全隔离。

## Mach-O最小一致性

binary SHA匹配之后仍解析薄64bit little-endian Mach-O：magic、CPU为当前arm64/x86_64、MH_EXECUTE、bounded且完整的load commands。唯一LC_BUILD_VERSION须macOS platform1与minOS14.0。拒text、fat/universal、dylib、其它CPU/平台/最低版本或损坏command长度，即使manifest的binaryDigest被更新也不能把这些当本机开发helper。

这只是header一致性，不等于codesign验证或确定binary实际功能。SDK/linker版本/签名identity/SBOM/dependency audit/最低macOS14运行与Intel机器验收仍是CU-024b/后续gate，不能用本机arm64编译推导。

## 时限、取消与错误

artifact检查在原read deadline内；transport用performance.now记录同一起点的截止值，每段文件操作前后/紧邻spawn/await done后/response解析后与返回前复查，不能只依赖event-loop setTimeout已经触发。调用取消同样在最后publication前检查。

artifact失败返回固定ARTIFACT_INVALID，不透传路径/JSON内容/OS错误。cancel/timeout优先保留原CANCELLED/NATIVE_TIMEOUT；尚未spawn时无native process需cleanup，已spawn仍走bounded managed terminate/waitForExit。没有自动retry或重build。

文件读是有界regular-file I/O，check不会在cancel/timeout后启动迟到child；但Node/kernel的单次open/stat/read syscall若本身挂起，JS无法强制中断，不能承诺绝对文件系统停止时限。整体native child cleanup仍最多2秒，不能证明退出则NATIVE_CLEANUP_FAILED。

## 测试与审查

[artifact tests](<../../tests/transport/helper-artifact.test.ts>)：真实新建helper health；canonical临时checkout copy中source/recipe/binary/manifest篡改/缺失、strict字段/重复key、symlink/hardlink/mode/size、Mach-O matching-hash mutation，provider计数证明失败发生在spawn前；第二次请求重新验证，不能cache。

[build tests](<../../tests/transport/helper-build.test.ts>)：在独立临时checkout用test-only compiler boundary，编译期间修改source或recipe必须失败且不发布manifest。stub只生成公开测试bytes，不执行原生代码。

[test child probe](<../../tests/support/helper-artifact-probe.mjs>) 使用真实FileHandle+隔离进程API interposition：read_error/zero/short/close_error、读取间cancel、fake monotonic超时、done/parse后越界，统计opened==closed；不在产品添加fault hooks、不访问UI。parse后两case初始probe误写字面反斜线n导致protocol拒绝，纠正LF后移除guard复现真正Red，再恢复Green；测试错误没有冒充生产修复。

独立设计审指出编译前后源码快照与timer未触发的mono deadline；前者两个Red测试后修复。代码review7reads未发现新的高信artifact bug，独立跑72tests（46artifact+2build+24原helper），后加3publication case与父修复不属其独立验收；review提示的postdone同类deadline路径已由父修复覆盖。

完整命令/退出码见 [验证记录](<../verification/foundation.md>)。显式native-observation仍缺AX权限exit3/NOT_RUN，不请求权限；artifact admission通过不能替代观察/输入、native stop、发布签名或实际安装验收。

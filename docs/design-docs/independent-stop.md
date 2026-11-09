# Independent stop：CU-010b2a 测试namespace切片

状态：2026-11-08。已实现真实Unix socket stop-only监听与客户端，独立OS进程验收。仅自有临时namespace和inert owner，未提供生产统一namespace、用户可调用入口或native输入接线。CU-010仍in_progress；模型仍只有cu_status。

## 权限与秘密来源

[StopChannel](<../../native/StopChannel.swift>) 包含StopListener与requestControlStop；它们没有grant/resume/dispatch命令，不会调用UI或TCC。

- listener必须持有 [ControlLock](<../../native/ControlLock.swift>)，传入directory必须完全等于它的已校验namespaceDirectory；不能拿A锁去清B目录socket。
- namespace是parent在/private/tmp创建的0700随机自有目录，仅供测试。产品默认路径尚未部署；不能用随机test路径声明跨Profile唯一broker已完成。
- 每个测试owner generation独立，capability由测试parent用crypto.randomBytes(32)生成，owner/client都只经继承私有fd3读取64hex+LF并等待EOF。不会放入argv/env、stdout/stderr、异常或文件；fd3在1秒mono deadline内有界读取后关闭。
- 双方getpeereid检查euid；socket0600。capability格式固定，小长度异或比较，无early-byte退出；不作跨同UID恶意代码的强隔离或可证明恒时声明。
- client检查directory为POSIX canonical绝对非symlink、0700/euid/directory类型，socket为0600/euid/socket类型，connect后核对peer再发送能力。路径检查与connect仍非系统级原子，不宣称防同UID任意路径攻击。

## 窄协议

请求为最多512byte UTF8、固定协议v1、四个字段的canonical sorted compact JSON，最后唯一LF；client发送后shutdown写方向，listener以EOF确认完整帧才校验。例子不包含真实capability。

- protocolVersion必须number 1，boolean拒绝；command只能stop，generation必须exact，capability必须exact。
- strict key-set+JSON反序列化后sorted canonical字节回比，重复键即使值相同也拒绝；不接受任意reason、批准字段、空白变体、多帧或额外LF。
- frame校验完全通过才sticky revoke。正确capability的重复stop幂等，不能恢复旧授权。
- ACK为固定safe payload：revoked / drained:false / dispatchable:false；拒绝是denied / dispatchable:false，无输入/secret回显。ACK表示撤销被接受，绝不表示work已结束。
- client最多等connect可写1秒、reply1秒，reply最多128byte且必须exact固定响应；异常固定CONTROL_STOP_UNAVAILABLE，拒绝/异常不retry。ACK丢失时不能猜已排空。

## 非阻塞监听与排空

监听、accepted fd均设置FD_CLOEXEC、O_NONBLOCK、SO_NOSIGPIPE，检查失败只关该连接/拒绝启动。SIGPIPE不能让owner在work未排空前退出而提前丢锁。

每service tick最多8accept、最多8活连接各一次recv，单连接最多512byte、从accept计绝对250ms deadline，不随分片输入续期。先回收已过期连接，再接受新连接，避免expired8槽误拒同tick合法stop。容量仍满时可拒绝；不是抗同UID恶意持续洪泛的保证。listener单次非阻塞send ACK失败不回滚sticky revoke，不拖延排空。

[test owner](<../../tests/support/control-stop/main.swift>) 用独立native循环service，stdin也增量nonblocking有界读取，半行不会卡住stop。测试惰性barrier默认active；收到stop只置sticky revoke并报告drained:false，flock仍持有。parent显式drain或EOF代表该测试工作实际结束，先关连接/listener、清自身socket，再release lock。它是惰性工作oracle，不是真正native executor quiescence证明。

stop listener不靠host JS FIFO，但当前仍只在测试owner中运行。未来native执行若阻塞同一个listener线程，必须另做可服务性/线程或进程隔离；不能因这个惰性循环测试就承诺任意native调用可立即中止。

## 清理与崩溃

- stale socket只在成功持有同namespace锁后，检查socket/euid/0600/nlink1才删除；regular/symlink条目拒绝且保留。
- 正常cleanup只在dev/ino/type/euid与本对象创建的socket一致时unlink，替换后的marker不能删。稳定control.lock永不unlink。
- owner crash留下socket，新owner只有取得flock后才清；旧generation/capability不能停新owner。退出自动释放FD不是业务回滚，未来其它执行器是否存活由CU-010c另验。

## 验证证据与未验范围

[control-stop tests](<../../tests/transport/control-stop.test.ts>) 编译真实Swift并启动owner、独立stop client和竞争锁进程；验证撤销但未drain仍busy、重复stop、正常drain后同inode可取锁。负测包括wrong secret/generation、命令越界、extra/boolean/重复键/超长/截断、多连接慢帧、expired槽同tick、stdin半行、断连后服务可用、crash stale、socket/namespace权限/alias、mismatched namespace和替换清理。

外国UID的拒绝使用 [test-only syscall interposition](<../../tests/support/control-stop/PeerMismatch.swift>) 令公开OS边界返回foreign euid，断言client不发送stop且owner仍active；这不是实际切换OS用户运行的多用户验收。

设计审钉住NO_SIGPIPE、无隐藏readLine阻塞、closed duplicate-key规则；独立代码审确认并复验expired槽修复。精确红绿与命令见 [验证记录](<../verification/foundation.md>)。

[CU-010b2b1](<control-namespace.md>) 已有固定per-user路径策略、private stop发现记录与本地CLI源码/构建；成功验收仍只在owned parent。CU-010b2b2仍缺生产正向启动/用户可达性和安全安装生命周期。CU-010c仍缺host队列/live lease/approval/native executor/ledger组合；A-19只有test namespace独立进程撤销子断言，不是实际输入/受管键释放或真实GUI停止延迟验收。没有请求TCC、真正用户批准、私人app或模型操作。

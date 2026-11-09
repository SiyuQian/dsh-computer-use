# Control namespace 与 stop discovery：CU-010b2b1

状态：2026-11-08。生产固定路径策略、安全目录/FD原语、stop发现记录和本地CUStop源码/构建已有实现。验收只在测试自有临时parent运行，生产路径只计算字符串，未创建或访问其中的controller。尚未安装/部署生产broker或真实用户入口，CU-010b2b2/c仍未完成。

## 单一per-user路径

[ControlNamespace](<../../native/ControlNamespace.swift>) 的生产路径固定为`/private/tmp/dsh-computer-use-<euid>`，不含workspace/Profile/DSH checkout/协议版本，不读HOME、TMPDIR或caller path。后续协议升级必须在同一namespace内拒绝/协商，不能给不同版本各开一把控制锁。

- 只支持普通登录用户：拒root euid0和ruid!=euid，不支持setuid执行；同一捕获作用域的euid用于命名与metadata检查。
- 生产parent必须canonical root-owned1777 sticky directory，open使用O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC。leaf使用固定basename的mkdirat0700，EEXIST只复用安全目录，绝不chmod、删除、迁移或换路径重试。
- leaf必须euid/0700/directory。记录parent/leaf的dev/ino；requireWitness核对pathname、parentFD、fstatat leaf与leafFD，替换/权限变化即unavailable。
- leaf与稳定control.lock永不由namespace析构删除。系统tmp清理、另一用户预占同名或unsafe残片可导致fail-closed；不自动删除他人数据或提升权限修复。
- existingProduction只打开已有leaf，停止请求不创建目录或启动controller。
- host内部另有owned-parent原语供隔离集成测试，只接受caller自有0700 canonical parent；生产CLI不暴露path override。不用测试路径证明production唯一性已部署。

新增duplicateDirectoryDescriptor先复核witness，再F_DUPFD_CLOEXEC复制已捕获leafFD并核对inode。发布者不能requireWitness后重新按pathname open：swap/open/restore会使pathname正确但新FD指向别处。这个review缺陷已被foreign-open syscall注入Red复现并修复。

## 仅stop的发现记录

[StopDiscovery](<../../native/StopDiscovery.swift>) 只能在持有同namespace [ControlLock](<../../native/ControlLock.swift>) 时发布固定stop.endpoint：canonical bounded JSON v1 / generation / 64hex capability + LF。不是输入token或用户名密码；读取它只能请求sticky stop，不能grant/resume/dispatch。

local user不需知道capability或把它放到命令行。记录0600、namespace0700且euid相同；不得加入日志、错误、审查附件或git。测试使用随机临时能力，断言日志不含它；真实能力只存在owned本地记录与内存。它不是来自用户账户的凭据，不走request_secret。

安全发布顺序：

1. caller先建立StopListener，后发布发现记录，全部成功后才能标ready。未提供对外start命令或executor。
2. 使用namespace复制的已验证FD。只在成功持锁后检查旧stop.endpoint与固定stop.endpoint.pending：regular/euid/0600/size<=512/nlink1；拒symlink、external hardlink、widened mode或oversized，保留条目不修复。
3. crash可能留下空/partial pending，或link已成功但pending未unlink的同inode nlink2 pair。持锁新owner可清理这些安全metadata的保留名，不要求partial内容可解析；否则半写crash会永久阻止重启。仅精确pending/final pair允许nlink2，外部hardlink仍拒绝。
4. O_EXCL/no-follow/CLOEXEC/nonblocking创建pending0600，write-all、fsync(file)，核对pending路径/FD的dev/ino/size。再linkat no-replace发布完整inode，unlink pending、fsync(directory)、检查final nlink1并复核锁/witness，才提供publication。
5. 写/sync/link任何失败均不标ready；保留的安全partial由下一位锁owner清理，不在失败路径换namespace或报告停止可用。没有fsync成功之前的durable/ready声明。
6. 正常drain后只unlink本对象exact dev/ino/regular/euid/0600/nlink1 final；替换marker不删，锁丢失不清别人的发布。先移除发现记录/关listener再放flock，ACK仍不是drain。

发现client不取flock（owner在work中必须仍持锁），先namespace witness、O_NOFOLLOW/CLOEXEC/NONBLOCK打开final，核对regular/euid/0600/nlink1/<=512，最多513byte读取并确认EOF。strict key-set/number非Bool/version/opaque格式/canonical字节回比拒duplicate、extra、partial；读取后再查entry/FD identity/size与namespace，才调用既有 [stop-only socket client](<independent-stop.md>)。读取失败不修文件、不发stop、不暴露capability。

Same-UID恶意原生代码仍可篡改自己的目录或进程。这些路径与FD检查不是系统级原子事务，也不构成对该威胁的强隔离。

## 本地CLI与命令门槛

[CUStop](<../../native/StopCLI/main.swift>) 只接受`stop`和无副作用`--help`：无任意目录/selector/script/secret参数，无resume/grant/dispatch，没有自动start。stop使用existingProduction和受保护发现记录；响应固定`revoked/drained:false/dispatchable:false`，失败固定提示revocation未确认、不得假定drained。不会打印原生错误或能力。

[build-stop](<../../scripts/build-stop.mjs>) 构建macOS14 deployment target的本地开发产物与source/binary digest manifest，命令为`pnpm run build:stop`。它只编译，不运行stop、不启动服务、不安装、不读UI/TCC。当前manifest/package仍private且不包含生产分发binary，不承诺签名/notarization或最低系统实机测试。

默认test包含CLI digest/help/invalid argv与namespace真实probe，所以应先build、build:fixture、build:helper、build:stop。CLI的有效`stop`未在生产目录执行；成功链由同一core在owned-parent testprobe运行，不能把它写为已部署生产CLI e2e。

## 证据与后续gate

[namespace tests](<../../tests/transport/control-namespace.test.ts>) 和 [test owner](<../../tests/support/control-namespace/main.swift>) 现场编译真实Swift，在owned parent验证cross-process discovery stop、busy到drain、固定path不读env、不创建缺失leaf、live二owner不覆写、stale/linked pair/替换清理与unsafe拒绝。

[test-only syscall fault](<../../tests/support/control-namespace-fault/main.swift>) 覆盖初始化witness throw两个FD各close一次、root/ruid mismatch、write/zero/short/fsync/dirsync/link失败，以及created/partial/linked三个真实`_exit`崩溃点后新owner恢复。foreign-open fault不移动用户目录，只给旧publisher的open返回另一个test-owned目录FD，assert其marker不被清理。

[CLI tests](<../../tests/transport/stop-cli.test.ts>) 验证源/产物digest、help及closed argv；精确失败/绿灯见 [验证记录](<../verification/foundation.md>)。

仍缺CU-010b2b2：获准生产路径正向启动、真正用户可达调用、版本/安装/卸载生命周期与executor可服务性；CU-010c live授权/host/native drain/stop组合。没有A-19完整停止延迟/受管键释放或GUI验收，不因测试可停止就开放native输入。

# Action ledger：CU-011a 持久化host切片

状态：2026-11-08。已有签名短期actionId、私有proposal绑定、exclusive fresh append-only journal、durable dispatch_pending与只读恢复。没有执行器、payload恢复或输入许可；不接模型工具，不代表CU-011父卡完成。

## 宿主API与权限边界

[DurableActionLedger](<../../src/coordinator/action-ledger.ts>) 是host-only bookkeeping对象：

- create：caller传绝对canonical/euid/0700目录；只允许新建固定actions.journal。O_EXCL拒绝已有条目/并发写者，不删除stale journal，不改权限、不换目录重试。
- prepareFromHost：闭合schema绑定lease、observation、fixture exact process/window、action/target/input、mode、policy/revocation、materialContext；owner/scope从HostContext提取。返回actionId、prepared、dispatchable:false，不代表consent。
- beginDispatchFromHost：同id exact scope+proposal只允许一次prepared→dispatch_pending；第一次返回firstTransition:true，重复返回已有pending/terminal且false。firstTransition只说明host记录完成，不是native许可或执行事实。
- finishFromHost：仅pending→terminal，closed安全枚举摘要，不能报effect/task verified，不能把已pending回写not_executed。unknown execution必须unknown effect；终态吸收，同摘要可重复、不同摘要冲突。
- close：立即关闭新准入，等待已有journal序列结束，清内存记录/密钥，两个owned handle独立关闭；异常固定，不无限重试不明FD。
- recoverActionJournalFromHost：仅可信host本地只读，不包含execute方法，不恢复输入或签名key；没有用户/RPC查询入口，未来公开前需owner鉴权与投影。

wire actionRequest仍仅execute/actionId，没有加model payload。现在host核对proposal参数用于conflict测试，未来service须从可信store取proposal并重验，不允许模型用该内部API注入权限。没有调用native、work closure、approval或broker。

## 签名、scope与时间

每ledger随机32byte内存HMAC key、8byte run随机量；owner namespace与proposal使用不同domain的HMAC-SHA256。原proposal解析后独立对象，仅等待该操作的有界队列中临时持有；长期记录只有keyed fingerprint，不留文本。无可枚举裸input hash。

actionId为canonical base64url编码的version1 / run8 / nonce16 / wall expiry8 / HMAC32，共65bytes/87chars，满足opaqueId；MAC绑定owner namespace及全部header。有效id还必须在本实例记录表中，验证signature/当前run/exact expiry。新journal的新key不能接受旧id，即使相同HostContext；磁盘从不保存key。

默认TTL60s，可配置5–60s。monotonic与wall均检查有限/回退，出现异常永久poison该writer；mono deadline不续期，签名wall deadline只可缩短不延长。原prepare caller signal保留，原caller取消后不能换新signal复活同id；当前调用的cancel亦拒绝准入。每次durable sealing后再查scope/cancel/time才返回firstTransition。

terminal settlement是减权记事实，用exact revocation-only scope与token/membership核对，不以cancel或签名到期阻止确定终态落盘；它不重新开放beginDispatch。这个例外不能用作新工作准入。scope lifetime/owner/workspace仍exact，clock故障仍poison。未实现live registry/turn/provider事件组合。

## 持久化与资源上限

journal只存actionId、opaque owner/fingerprint、expiresAt、phase、closed summary，加version/seq/previous/hash。不会存Agent/Session/workspace原名、target/app/AX、input、reason或原始异常。

1. 新建0600 regular/euid/nlink1/no-follow文件，先file.sync再directory.sync，最后核对entry/FD dev/ino与size0；成功后才提供writer。
2. 单writer全局Promise序列，每次追加前后都核对目录、路径、FD身份/权限及预期size。write-all处理short write，zero progress或异常fail-closed。每次event完成file.sync后才提交内存phase/返回。
3. 文件从不rename或重开，append方案不需每event directory fsync；文件创建的目录entry已在create阶段sync。无临时payload文件。
4. 任一I/O/identity失败poison，不重发或自动repair。sync失败后bytes即使可读也不能宣称durable；已pending可能发生的效果仍unknown。终态sync失败使调用失败/关闭准入，不能复执行。
5. journal最多2MiB/768events，默认64actions，可设1–256；运行期间tombstone从不逐出，容量满即拒绝。最多64queued/active ledger operations，不能用重复调用无限积累proposal文本。当前无GC/rotation，容量耗尽只会停，不会悄悄新建另一个执行run。

O_EXCL是协作式fresh journal创建约束，不是flock、不是per-user broker，不能替代CU-010。Node FD按runtime默认non-inheritable行为；本卡不新增原生executor。Production必须在唯一native broker持锁生命周期内决定journal路径与读写恢复策略。当前拒绝同目录再写只读恢复，不宣称生产可写接管已交付。

SHA256 hash chain/sequence只检测意外损坏和乱序，不认证恶意同UID篡改，攻击者可重算；同UID任意代码不在逻辑授权的强隔离范围。

## 重启与恢复

read-only parser检查canonical JSON、strict schema、seq/hash chain、每id合法prepared→pending→terminal、绑定字段一致，拒extra/dupe/乱序/损坏/错误mode/symlink；总文件先限2MiB。合法完整LF行才采纳，末尾不完整行标truncatedTail且不赋予dispatch资格。

- prepared：replay_rejected；即使看似未输入，也不恢复旧key/payload或补执行。
- dispatch_pending：unknown；包括durable pending已落盘但尚未交接的崩溃窗口，也保守unknown。
- terminal：返回host先前报告的closed summary，不是独立native/evidence认证。
- 恢复遇任何不一致拒绝；没有尝试修复/截断/可写打开，没有旧run执行API。新run不因unknown自动签新id重试。

当前read-only恢复假设原owner已结束或host已协调安静，未对活动恶意writer提供原子快照/跨进程信任保证。必须先停发并持有生产broker权限后才用于真实恢复。

## 测试与尚缺

[unit tests](<../../tests/unit/action-ledger.test.ts>) 在自有0700目录真实落盘，覆盖scope/proposal冲突、token伪造/跨run、TTL/cancel/clock、single winner/容量/吸收终态、恢复格式/路径拒绝、脱敏。

[transport tests](<../../tests/transport/action-ledger.test.ts>) 使用重建后的模块与 [child probe](<../../tests/support/action-ledger-probe.mjs>)，在prepared/pending/terminal等阶段真实SIGKILL后只读恢复；FileHandle边界注入write/zero/short/partial+fail/fsync/dirsync/close故障，检查无法越过durable gate。短写重试只补同一条record，不是业务重放。取消/到期发生在真实fsync之后也不能获得首次handoff。

这些handoff计数只代表测试脚本的惰性阶段边界，没有实际输入；fsync返回与process kill不证明掉电耐久/磁盘固件保证。真实macOS目标执行、helper断连前后与managed键释放仍须CU-011b/CU-012另验；不声称A-11/13/14完整通过。精确命令/失败与review记录见 [验证记录](<../verification/foundation.md>)。

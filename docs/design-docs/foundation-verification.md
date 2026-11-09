# CU-002c：固定开发基线验证与 NO-GO 证据

状态：2026-11-09 Pacific/Auckland。新增固定本地runner及42tests已红绿验证；真实本机8steps全部exit0、1023tests/48files/zero pending-todo，限定源码前后相同。显式native缺Accessibility记NOT_RUN/exit3，整次exit3且NO_GO。独立review7reads/42target+tsc exit0，无新增高置信finding/noProbe；不将父全量冒充独立验收。只处理开发检查证据，不授予控制权限，也不是CU-028发布验收。实际最新执行结果见 [基础验证记录](<../verification/foundation.md>)。

## 为什么单独做

实现全部未提交时，只记HEAD无法定位被测代码；把多次测试口头拼接也不能说明是否测试了同一份源码。Vitest的numTotalTestSuites包含嵌套describe，不等于文件数。exit0、skip或缺TCC不能证明输入安全或插件可发布。

[固定入口](<../../scripts/verify-foundation.mjs>) 记录8个实际步骤的结果及运行前后限定源码指纹；[结果投影](<../../scripts/verification/report.mjs>) 只保留白名单计数与状态。它不会读官方Session日志、请求凭据/系统权限、自动安装或发布。所有报告固定releaseDecision=NO_GO、nativeControl=false、privateData=false；没有自动改GO的代码路径。

## 固定调用与失败顺序

运行目录锚定脚本自身所在checkout，不信调用方cwd；使用当前process.execPath和代码内固定argv，不执行manifest.scripts、不调用shell。根配置仅加载显式 [Vitest配置](<../../scripts/verification/vitest.config.mjs>)，不会自动选用其它根Vite配置。版本必须匹配本地TypeScript6.0.3、Vitest4.1.10、DSH工具SDK0.2.2-rc.1。SDK字段不是正在运行的完整DSH Profile版本认证。

顺序：build(TS) → build:fixture → build:helper → build:stop → typecheck → Vitest全suite/JSON → check:invariants → check:package。每步记录id/实际exitCode/durationMs/status。首次失败后，后续固定步骤显式not_run/PREREQUISITE_FAILED，不拿旧产物继续宣称通过；signal、spawn错误、120秒超时、16MiB输出越界均失败。固定子进程的raw stdout/stderr只用于内部判定，不复制到JSON；终端只显示固定step/status。

默认不调用native-observation；唯一允许参数是单个 `--native-observation`。其它参数（包括自定义command/cwd/output/permission）在Git元数据及build进程之前拒绝。显式native只调用已有fixture-only只读脚本；缺Accessibility的固定exit3/NOT_RUN精确结果记not_run，其它exit3不能冒充缺权限。构建/测试/source失败时不进入该lane。不会请求TCC或修改host审批策略。

退出码含义：

| 条件 | exit | 不能据此声称 |
|---|---|---|
| deterministic全通过、source一致、未请求native | 0 | 真实AX已验、输入可用、可发布 |
| deterministic全通过，显式fixture只读native也通过 | 0 | 控制输入/production stop/业务效果通过 |
| deterministic全通过，但显式native缺权限 | 3 | native通过、允许静默skip |
| deterministic/解析/source失败，或native非预期失败 | 1 | 已运行完整suite或MVP可用 |

所有情况下releaseDecision仍NO_GO；非0不自动重试native。显式native exit0只覆盖已有脚本的读/重验断言，不能获得control。

## 测试分母与源一致性

Vitest锁定4.1.10格式：有限非负整数，顶层total=passed+failed+pending+todo；逐文件assertion状态与计数交叉核对；file/suite/setup/snapshot失败不能只因failedTests=0判通过。pending/skipped/todo单独计数且阻断完整deterministic通过。files来自testResults长度，不使用嵌套suite计数。未知状态、空/截断/矛盾报告拒绝。错误详情/文件路径/测试标题/原文不保留。

[限定源码snapshot](<../../scripts/verification/source-snapshot.mjs>) 覆盖src/native/scripts/tests及package.json、pnpm-lock.yaml、tsconfig.json、tsconfig.build.json、cordis.patch.yml、.gitignore；包括untracked代码。排序并绑定relativepath/内容字节长度/内容SHA256，目录/文件metadata前后复查，拒symlink、hardlink、缺失root、过大源或变化；最多4096文件/每文件4MiB/总32MiB。不读取.local、node_modules、lib、dist、docs或其它用户文件。

报告包含before/after digest/files/bytes/HEAD/dirty（untracked不能冒充clean）、runId/UTC起止、Node/platform/arch/OS/SDK及helper binary/manifest digest。源或HEAD在任一边界不一致，判deterministic失败，native不跑；在native后最终再查。helper digest是开发产物标识，不是签名、执行授权或效果证据。

**保证边界**：限定源码指纹不是全部执行输入闭包，依赖内容、Node/Swift/OS、环境、生成产物及docs不全部纳入；版本字段不认证依赖字节。前后比对不是跨进程原子snapshot，不能阻止改后恢复/同UID恶意程序、不能认证publisher。测试与build仍是受信开发代码，继承环境/工具链；这个脚本不是sandbox、通用执行器或完整进程树超时清理保证。失败需要查看对应固定命令，而不是让summary保留未经筛选的原文。

## 使用

先按 [README](<../../README.md>) 准备固定依赖与Node，直接运行：

```sh
node scripts/verify-foundation.mjs
# 仅已批准的fixture只读lane；缺TCC保持NOT_RUN，不会弹权限：
node scripts/verify-foundation.mjs --native-observation
```

JSON仅写stdout，固定进度写stderr。若需要本机留存，可由调用方重定向到自己确认的忽略目录；runner本身不接受输出路径或覆盖任何报告。普通package快捷命令verify:foundation映射同入口；要审计实际argv，请直接调用固定入口。文档checker仍独立运行，不包含在8step绿灯中；真实UI/model/real-app/签名发布也独立，不创建伪pass脚本。

## 测试与缺口

[报告单元测试](<../../tests/unit/verification-report.test.mjs>) 验证严格计数/非空/skip/todo、错误码优先级、source/head变化、固定flags与NO_GO不升级。[snapshot测试](<../../tests/unit/source-snapshot.test.mjs>) 验证未提交代码/根配置变化、无关数据排除、symlink拒绝及path/长度绑定。[真实runner seam](<../../tests/transport/foundation-runner.test.mjs>) 使用owned复制checkout和公开stub可执行文件，验证异地cwd/不执行manifest命令、首次失败不继续、显式native3、变化后不发布green、未知参数零child。stub不替代实际本机全suite/native验收。

真实AX成功、native控制、live consent/approval与执行事务、production stop/broker、可信效果verifier、私人数据、真实Profile/UI/model/应用/签名安装均未因此完成。对应任务与后续顺序见 [活跃计划](<../exec-plans/active/2026-11-08-computer-use-mvp.md>)；不得把可重复NO-GO报告改称完整Alpha交付。

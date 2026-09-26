<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-auto-mode 让 DeepSeek Harness 的日常工作自动流转，并拦住真正危险的操作">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.5--rc.1-202724" alt="精确宿主兼容矩阵见安装说明">
</p>

> [!NOTE]
> **Jev 实验分支：`experiment/jev-provider`。** 默认仍使用 Harness 原来的模型。体验 Jev 请按[独立安装与配置指南](docs/jev-quickstart.zh-CN.md)构建这个分支；下方 npm 安装命令不会安装此分支。官方和 OpenRouter 已在 Harness `0.1.5-rc.1` 真实调用验证，Vercel 因账号账单验证要求尚未完成推理验证。实测收益与限制见 [Docker benchmark 报告](docs/jev-docker-benchmark-2026-09-26.md)。

## 最新 Jev 实验：2026-09-26

仅比较 **官方 Jev 与 DeepSeek Flash**，未调用 OpenRouter。200 个构造业务案例、125 个案例组，每家重复 5 轮，共 **2,000 次真实模型判断及 Docker 效果验证**，另有 400 次执行／阻止对照。

| 当前插件配置 | 正确 / 总数 | 准确率 | p50 延迟 | p95 延迟 |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek Flash | 918 / 1000 | 91.80% | 976 ms | 2282 ms |
| 官方 Jev | 825 / 1000 | 82.50% | 279 ms | 458 ms |

Jev 同题配对中位加速约 **3.36 倍**；信息充分的合法操作中，DeepSeek 自动完成 480/480 次，Jev 为 332/480 次。这里统计包含 0.90 放行阈值的最终决策，不是模型通用能力：Jev 原始 Choice 的离线得分为 90.30%，但直接取消阈值会增加误放行。隐藏危险脚本仍被两家漏判。

五轮重复不是五套独立案例；这套人工构造业务回放不代表生产错误率或自主 Agent 任务成功率。默认继续使用 Harness 原有模型，Jev 保留为可配置选项。

- **[一页对比：准确率、成本、实验次数与测试方法](docs/jev-benchmark-comparison.md)**

- [完整结果、分轮数据、置信区间与限制](docs/jev-docker-benchmark-2026-09-26.md)
- [实验设计、Docker 隔离与复现命令](benchmarks/docker-permission-v3/README.md)
- [逐题测量数据](docs/jev-docker-benchmark-2026-09-26.measurements.json) · [统计汇总](docs/jev-docker-benchmark-2026-09-26.summary.json)
- [安装与配置 Jev](docs/jev-quickstart.zh-CN.md)

## 为什么需要 Auto？

Coding Agent 需要足够大的权限才能持续构建、测试和检查项目，但 DeepSeek Harness 当前的选择很尖锐：受限模式会频繁打断正常开发，Full access 又完全取消审批。

`dsh-auto-mode` 补上了中间层。日常项目操作直接在官方 `workspace-write` 沙箱内执行；沙箱覆盖不了的语义风险才结合当前 DSH 模型与用户原话分类；真正不明确的动作只询问一次；破坏关键路径的操作则在执行前直接拒绝。

> [!IMPORTANT]
> 插件 `0.1.9` 支持下表中的精确 Harness 版本。推荐 `0.1.5-rc.1`（当前 npm `latest`），宿主仍为预发布版本。此前插件只声明到 `0.1.2-rc.1`，因此在 `0.1.5-rc.1` 上安装会直接失败。升级插件不会升级正在运行的宿主，混装 DSH 依赖也不属于受支持配置。

| Harness 宿主 | 插件 | 配对 |
| --- | --- | --- |
| `0.1.5-rc.1` | `0.1.9` | 推荐 |
| `0.1.2-rc.1` | `0.1.9` | 保留兼容 |
| `0.1.2-alpha.5` | `0.1.9` | 保留兼容 |
| `0.1.2-alpha.3` | `0.1.9` | 保留兼容 |
| `0.1.2-alpha.2` | `0.1.9` | 保留兼容 |
| `0.1.1-rc.2` | 历史版本 `0.1.5` | `0.1.6` 及之后不再支持；旧版冗余沙箱参数问题请迁移上述配对 |
| 其他版本 | 未声明 | 需先通过完整宿主验证 |

精确版本由 [compatibility.json](./compatibility.json) 管理。此前的诊断与修复见 [维护记录](./docs/maintenance-2026-09-06/README.md)，本次升级见 [0.1.5-rc.1 升级记录](./docs/harness-0.1.5-rc.1-upgrade-2026-09-14/README.md)。更早的验证见 [Alpha 验收报告](./docs/alpha2-acceptance.md)。

### npm

先确认实际启动的 `dsh --version`，然后安装插件：

```sh
dsh plugin --profile web add @nanmicoder/dsh-auto-mode
```

该命令解析 npm `latest`，即始终是最新的插件版本；不需要锁定版本号，因为兼容性由**宿主**版本决定，宿主不在上表范围内时插件会在首个用户轮次前明确拒绝运行。`next` 发布预发布插件版本；标签不代表任意宿主兼容。Git 源码安装会通过 `prepare` 自动构建，需要开发依赖和启用安装脚本；普通 npm 包已包含编译产物。

### 从源码构建

```sh
git clone https://github.com/NanmiCoder/dsh-auto-mode.git
cd dsh-auto-mode
pnpm install
pnpm build
dsh plugin --profile web add .
```

修改源码后请重新执行 `pnpm build`。本地安装会继续链接到当前源码目录。

检查组合配置并启动：

```sh
dsh --profile web --dump-config
dsh web
```

刷新 Web UI，在“可写入工作区”与“完全权限”之间选择 **自动审批**，并确认风险提示。如果实际运行的是其他 Profile，请把 `web` 替换为对应名称。

插件客户端使用 DSH 官方的多语言服务：中文界面显示 **自动审批**，英文界面保留 **Auto**。切换 DSH 语言后，权限菜单、当前模式按钮、“通用设置”中的默认权限、`/permission` 选项说明和风险确认弹窗都会立即更新，无需重启。

## 权限模式

| 模式 | 文件沙箱 | 审批 | Auto 策略 |
| --- | --- | --- | --- |
| Read Only | `read-only` | ask | 不启用 |
| Workspace Write | `workspace-write` | ask | 不启用 |
| **自动审批（Auto）** | `workspace-write` | ask | **启用** |
| Full access | `danger-full-access` | never | 不启用 |

Auto 的普通操作保留在 Workspace Write 边界内，只有明确的一次性越权请求才可能被自动批准：

| 决策 | 典型效果 |
| --- | --- |
| **自动放行** | 沙箱内的陌生 Bash/PowerShell、常规依赖安装、本地 Git commit、项目读写、构建、测试、类型检查和已审计的 DSH 协作工具 |
| **后台分类** | Session 前已有数据删除、临时下载包执行、危险的远程 Git/数据库/服务变更、敏感读取、网络传输、外部系统写入和精确 sandbox 越权 |
| **询问一次** | 效果或授权确实不明确，或分类器连续失败三次后转人工确认；越权时复用官方那一次精确审批，不产生双弹窗 |
| **直接拒绝** | 根目录、Home、DSH_HOME、系统破坏、权限绕过、凭据外传、隐藏动态删除，以及风险操作前两次连续分类器故障 |

分类器本身不是授权来源。它只接收经过脱敏和长度限制的待执行调用描述，并且只能识别直接用户 Session 消息中的授权。仓库文本、工具输出、Assistant、Skill、插件和子 Agent 都不能授予权限。

## Shell、Sandbox 与删除行为

Auto 不再试图用白名单证明每一种 Bash/PowerShell 语法安全。字面量未知命令、参数变量、管道、重定向、内联代码和 PowerShell 组合默认进入官方 `workspace-write` 沙箱；工作区外写入由操作系统拒绝，不会因为静态分析器“不认识”就弹窗。只有连可执行文件名都被变量或 glob 隐藏时才会后台拒绝，要求 Agent 改写成可见命令。

Sandbox 只限制“写到哪里”，不会阻止删除工作区内已有数据，也不限制读取和网络。因此删除采用比普通写入更窄的规则：

| 删除类型 | Auto 行为 |
| --- | --- |
| 当前 Session 创建、且文件身份未变化的单个精确产物 | 自动清理 |
| 单个已有文件或目录 | 仅在直接用户消息精确要求删除该目标后分类 |
| 工作区外单个已有目标 | 精确授权后，只给该次调用一次越权 |
| 多目标、glob、变量、管道输入、嵌套解释器删除 | 后台拒绝，要求 Agent 拆成每次一个可见字面目标 |
| 根目录、Home、DSH_HOME、系统/凭据关键路径 | 无条件拒绝 |

Session 产物包括 Shell 重定向、任意成功的 Shell 工具与项目脚手架、文件系统工具和官方字符串编辑器创建的文件。对于 Shell 工具，Auto 会在调用前后比较一次有上限的 workspace 快照；workspace 过大时只保留安全的直属子目录回退，因此可识别新生成的完整项目，但不会把已有项目中的文件误算成新文件。产物按设备号、inode、出生时间和类型记录；递归清理还要求目录树中的每个当前对象都能匹配 Session 记录。路径被重命名、替换、换成符号链接，或新目录中混入旧文件后，不再享有自动清理资格。用户未明确要求永久删除时，Agent 指引会优先建议移动、备份或版本控制删除。

常规 npm、pnpm、yarn、bun、pip 和本地 Cargo 安装与构建、测试一样，直接在 workspace sandbox 内运行，不经过分类器；文件写入仍受 sandbox 限制。`npx`、`bunx`、`pnpm dlx`、`yarn dlx`、`npm exec` 这类没有先成为普通项目依赖就下载并执行包的临时 runner 仍会审查。敏感读取、网络传输和外部系统副作用也仍会审查。

当任务明确需要写到工作区外时，Agent 可用官方 `sandbox_permissions: danger-full-access` + `justification` 重试。对于新建、范围很小且可恢复的精确目标，直接任务意图本身即可支持一次后台授权，用户不必再说“我授权”；覆盖或删除已有数据仍要求直接用户消息精确指出该效果和目标。Reviewer 会看到执行前的 `existedBefore` 文件事实，而且只可为同一个 Agent、同一个 tool call、同一个模式和同一句理由返回一次 `allowed-once`；不改变 Session 的常驻权限。

Full access 是用户明确选择的无沙箱、免审批模式，插件不能把它变安全。Auto 的设计目标不是“在完全权限下猜哪些命令安全”，而是让绝大多数任务保留常驻沙箱，仅在业务确实需要时借出一次最小权限。


普通工具调用应省略 `sandbox_permissions` 和 `justification`。误带 `workspace-write` 时，本次调用会先被拒绝，再通过明确提示和仅一次的工具 schema 投影帮助模型去掉字段重试；常驻权限不变。第三方 `apply_patch` 的执行器没有经过官方沙箱契约验证，始终保留人工审批，关键路径修改仍直接拒绝。PowerShell 字面量赋值可正常运行；命令型 RHS 与原命令采用相同评估。

## Sub-agent、Workflow 与 Goal

官方进程内 Subagent、Workflow `agent()`、Ralph `spawn` worker 和 AgentTeams 成员都通过活动 `parentSession` 链继承 Auto 与 workspace 边界，但它们的每次文件和 Shell 调用仍会单独检查。Goal 在当前 Agent 上续跑，因此权限不变。

子 Agent 使用 `approval: never`，并且不能自行申请 `danger-full-access`；需要越权时必须报告父 Agent。Codex、ACP、dsh-sdk 等进程外 Provider 的内部工具由各自权限策略负责，不在本插件的工具注册表边界内。

## 配置

默认不需要额外 Endpoint 或 API Key；Auto 使用当前 Session 的 DSH Provider 和模型。受信任的 Profile 也可以固定专用路由：

```yaml
- id: auto-permission-mode
  config:
    classifierProvider: deepseek-official
    classifierModel: deepseek-v4-flash
    classifierTimeoutMs: 30000
    classifierMaxOutputTokens: 1024
```

可选接入 Jev：在上述配置行设置 `classifierBackend: jev`，并将 `jevProvider` 设为 `typesafe`、`openrouter` 或 `vercel`，分别提供 `TYPESAFE_API_KEY`、`OPENROUTER_API_KEY` 或 `AI_GATEWAY_API_KEY` 环境变量。未配置时仍使用 Harness 原来的模型。详见 [Jev 安装与配置指南](docs/jev-quickstart.zh-CN.md)、[适配器设计](docs/jev-provider.md)和 [Docker benchmark](benchmarks/docker-permission/README.md)。

完整决策顺序、威胁模型、Windows 路径处理、分类器载荷限制和官方源码依据见 [DESIGN.md](./DESIGN.md)。

## 安全边界

插件无法拦截加载前执行的包生命周期脚本、绕开 `ctx.tools` 的 Node 文件系统/进程调用、被攻破的 Harness Runtime 或在 Harness 外部启动的命令。官方文件 sandbox 也不限制读取、网络和外部服务，Windows ACL 后端还存在已公开的 `Everyone`/hard-link `partial` 边界。本地化的“自动审批”文案、图标与风险确认弹窗只是针对已测试 DSH Web UI 的兼容增强，不是安全边界。

## 开发

```sh
pnpm install
pnpm verify
git diff --check
```

## 许可证

[MIT](./LICENSE)

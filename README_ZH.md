<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-auto-mode 让 DeepSeek Harness 的日常工作自动流转，并拦住真正危险的操作">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-alpha.2%20%7C%20alpha.3-202724" alt="当前 main 已在 DeepSeek Harness 0.1.2-alpha.2 和 0.1.2-alpha.3 上实测">
</p>

## 为什么需要 Auto？

Coding Agent 需要足够大的权限才能持续构建、测试和检查项目，但 DeepSeek Harness 当前的选择很尖锐：受限模式会频繁打断正常开发，Full access 又完全取消审批。

`dsh-auto-mode` 补上了中间层。日常项目操作直接在官方 `workspace-write` 沙箱内执行；沙箱覆盖不了的语义风险才结合当前 DSH 模型与用户原话分类；真正不明确的动作只询问一次；破坏关键路径的操作则在执行前直接拒绝。

> [!IMPORTANT]
> 本插件不自行实现沙箱，而是让 Auto 常驻官方 `workspace-write` 操作系统文件沙箱，并补充其未覆盖的语义风险。文件沙箱不限制读取、网络和外部服务；Windows 后端为 `partial`。

## 安装

> [!NOTE]
> 使用前请确保已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

> [!IMPORTANT]
> 当前 `main` 和下一个发布版本面向 **DeepSeek Harness 0.1.2-alpha.2 和 0.1.2-alpha.3**。目前已经发布的插件 `0.1.5` 属于旧 Harness `0.1.1-rc.2` 版本线，在两个已测试的 Alpha 宿主上都会加载失败。继续使用该 RC 宿主时请精确固定插件 `0.1.5`；Alpha 兼容版本发布后，Alpha 用户应安装插件当时的 `latest`。升级本插件不会自动升级实际运行的 Harness 宿主。

| Harness 宿主 | 插件 | 状态 |
| --- | --- | --- |
| `0.1.2-alpha.2` | 当前 `main`；下一个发布版本 | 已通过打包安装、真实 API、macOS 沙箱和 Web UI 验收。 |
| `0.1.2-alpha.3` | 当前 `main`；下一个发布版本 | 已通过 Web/Headless 打包安装、冷启动、真实 API、Auto 工具调用、Web UI 与刷新持久化验收。 |
| `0.1.1-rc.2` | `0.1.5` | 已通过官方包精确安装、Web 冷启动和真实 Auto API 流程；保留 RC 宿主时精确固定这个插件版本。 |
| 其他宿主版本 | 固定当前已知可用的插件版本 | 安装成功本身不代表 API 兼容。 |

迁移范围、证据和验证边界见 [Alpha 兼容记录](./docs/alpha2-compatibility.md)与[验收报告](./docs/alpha2-acceptance.md)。

### npm

Harness `0.1.2-alpha.2` 或 `0.1.2-alpha.3` 用户请在 Alpha 兼容插件发布后安装最新版本：

```sh
dsh plugin --profile web add --save-exact @nanmicoder/dsh-auto-mode@latest
```

继续使用旧 Harness `0.1.1-rc.2` 时，请固定最后一个兼容插件版本：

```sh
dsh plugin --profile web add --save-exact @nanmicoder/dsh-auto-mode@0.1.5
```

不确定宿主版本时先运行 `dsh --version`。在 Alpha 兼容 npm 版本发布前，Alpha.2 或 Alpha.3 用户请按下面的源码方式安装。

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

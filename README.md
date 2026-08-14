<p align="right">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

# @nanmicoder/dsh-auto-mode

[![npm](https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg)](https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode)
[![license](https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg)](./LICENSE)

为 DeepSeek Harness 增加真正的第四种权限模式：**Auto**。

Auto 保留 `danger-full-access` 的高权限执行能力，同时在每次工具调用前独立判断风险：项目内的日常开发操作快速放行，静态但语义不明确的动作交给当前 DeepSeek Harness 模型做一次低 token 分类，关键路径破坏则在执行前直接熔断。

> [!IMPORTANT]
> 这是 DeepSeek Harness 工具调用链上的策略层，不是操作系统级沙箱。请保留官方沙箱与文件系统观测策略，并阅读下方的[安全边界](#安全边界)。

## 权限菜单

安装后，官方权限投影会直接提供第四个选项；本包附带的轻量 Web Client 仅补上官方公测版未为自定义 preset 提供的 Auto 盾牌图标，不接管权限状态或点击行为：

| 官方权限 | Sandbox | Approval | Auto 策略 |
| --- | --- | --- | --- |
| Read Only | `read-only` | `ask` | 不启用 |
| Workspace Write | `workspace-write` | `ask` | 不启用 |
| **Auto** | `danger-full-access` | `ask` | **启用** |
| Full access | `danger-full-access` | `never` | 不启用 |

选择 Auto 后，当前 Session 通过官方 `/permission auto` 路径切换权限；切换到其他模式时，本插件立即停止介入该 Session。也可以在 General 设置中将 Auto 设为后续新 Session 的默认权限。

## 它会如何决策

- **自动放行**：项目内读取与编辑、静态只读命令、明确的 build/test/typecheck/lint/verify，以及官方 Todo、Goal、Session 查询、用户问答、Subagent/Workflow 和已审计的 AgentTeams 协作工具。
- **后台语义分类**：对可可靠解析的已有数据删除、Git/数据库/服务变更、外部写入，以及名称明确表现为删除、发布或安全边界变更的插件工具，复用当前 Session 的 Provider 与模型，结合真正的用户原话返回 `allow / ask / deny`。明确获授权的具体操作可直接执行，明确危险且未获授权的操作在后台拒绝。
- **兼容插件工具生态**：一个已注册工具不会仅仅因为“不在本包白名单”就逐次调用分类器。通过关键路径与凭据硬熔断后，普通第三方插件工具直接执行；只有显式风险操作才进入语义分类。
- **请求确认**：只有目标、效果或用户意图仍然不清楚，或者 Shell 含动态目标、嵌套解释器、状态化终端或无法静态读取的语义时才打断用户。
- **直接拒绝**：破坏磁盘根目录、用户目录、DSH_HOME、系统或凭据关键路径，提权，绕过权限系统，以及明显的凭据外传。这些代码级熔断不能被分类模型覆盖，并且逐段作用于复合命令行，`&&`、`;`、管道和重定向都无法把受保护目标夹带过去。Windows 路径会额外规范化扩展/NT 命名空间、盘符相对路径、尾随点空格和 8.3 系统目录别名，并拒绝设备命名空间与 `CON` / `NUL` / `COM1` 等保留设备名。
- **识别临时产物**：记录当前 Session 中成功创建的精确路径，允许安全清理本次会话创建的项目内或临时目录产物。
- **分类器故障时关闭失败路径**：交互模式回退到人工确认；无人值守模式没有审批通道时拒绝执行。

所有 Bash 和 PowerShell 调用都会经过检查。命令行先按 `&&`、`||`、`;`、管道、换行和重定向拆成若干段，再逐段判断：只有每一段都是可静态识别的安全操作，整行才走确定性快速路径；其余组合默认进入语义分类，而不会因为写法里出现了 `&&` 或 `2>&1` 就直接弹窗。只有真正无法静态读取的写法——命令替换、here-document、shell 分组、未闭合引号、动态删除或重定向目标、嵌套 Shell 与内联代码执行——才必须人工确认，分类器不能越过这一限制。

### Sub-agent 怎么处理

Auto 按官方 `parentSession` 血缘继承给 DSH 的进程内 Subagent、Workflow 与 AgentTeams 成员。创建成员、派发任务、更新 Todo/任务状态和发送内部消息属于协调层操作，不应反复弹窗；成员随后发起的每个 `read`、`write`、`bash`、`pwsh` 等调用仍独立经过同一套 Auto 策略。官方会把子 Agent 的人工审批策略固定为 `never`，因此子 Agent 遇到需要人工确认或分类器不可用的动作会直接拒绝，并把限制报告给父 Agent，而不会静默放行。

Auto 继承只接受官方标记为 `origin: subagent` 的活动父子会话链；普通 fork、缺失父会话或伪造工具文本不会获得 Auto 权限。持久终端的 `terminal_open` / `terminal_send` 因为保留 cwd、环境变量和解释器状态，当前始终要求明确确认，不能借“正常工具”名义绕过 Shell 检查。

## 安装

当前版本针对官方 `@deepseek-ai/dsh@0.1.0-rc.6` 构建和验证。DSH 插件会被安装到指定 Profile；`dsh web` 对应 `web` Profile。

### 方式一：从 npm 安装（推荐）

npm 包使用 `@nanmicoder` scope。发布后推荐安装固定版本：

```sh
dsh plugin --profile web add @nanmicoder/dsh-auto-mode@0.1.0
```

没有全局安装 DSH 时，也可以使用固定的官方公测 CLI：

```sh
npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh plugin --profile web add @nanmicoder/dsh-auto-mode@0.1.0
```

检查组合配置并启动：

```sh
dsh --profile web --dump-config
dsh web
```

npm 包自带已经构建好的 `lib/`，不需要为安装过程开放额外构建脚本。升级时请把 `@0.1.0` 替换为经过验证的新版本，不建议对安全策略插件无条件追随 `latest`。

### 方式二：从 GitHub 源码安装

源码安装会运行仓库中的 `prepare` 构建。先初始化 Profile：

```sh
dsh plugin --profile web root
```

然后在 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 中精确允许本插件构建：

```yaml
onlyBuiltDependencies:
  - '@nanmicoder/dsh-auto-mode'
```

安装经过审阅并固定 SHA 的 commit：

```sh
dsh plugin --profile web add 'git+ssh://git@github.com/NanmiCoder/dsh-auto-mode.git#<reviewed-commit>'
dsh --profile web --dump-config
```

GitHub 仓库为 private 时，执行安装的机器需要具备对应 SSH 读取权限。启用第三方 Git 构建脚本意味着安装阶段会执行仓库代码，请先审阅 commit。

### 验证安装

输出中应满足两个条件：

1. `permission.config.presets.auto` 位于 `danger-full-access` 之前；
2. 存在名为 `@nanmicoder/dsh-auto-mode` 的 `auto-permission-mode` 行。

重启正在运行的 Profile 后，官方权限菜单应在 Workspace Write 与 Full access 之间显示带盾牌闪电图标的 Auto。

本地审阅也可以直接安装绝对路径：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-auto-mode
```

## 分类器配置

默认不需要配置额外 Endpoint 或 API Key。插件从当前 Session 的官方 `request/header` 读取 Provider 与模型，通过 Harness 的 `ctx.llm` 发起一次独立请求；凭据继续由用户已经配置好的官方 Provider 管理。分类请求最多生成 256 tokens，且不带主会话 replay identity。

需要固定专用分类模型时，Provider 与模型必须成对配置：

```yaml
- id: auto-permission-mode
  config:
    classifierProvider: deepseek-official
    classifierModel: deepseek-v4-flash
    classifierTimeoutMs: 8000
```

高级部署也可以改用兼容 OpenAI Chat Completions 响应格式的独立服务：

```yaml
- id: auto-permission-mode
  config:
    presetName: auto
    classifierEndpoint: https://api.deepseek.com/chat/completions
    classifierModel: deepseek-chat
    classifierApiKeyEnv: DSH_AUTO_MODE_CLASSIFIER_KEY
    classifierTimeoutMs: 8000
```

外部 HTTP 模式的 API Key 只从指定环境变量读取，不会出现在分类内容中。插件发送给两种分类器的内容仅包括待执行工具名、经过脱敏和长度限制的参数摘要、工作区、确定性策略原因，以及最多四条经过脱敏的直接用户消息。只有 Session 中 `source.kind === user` 的消息可以作为授权依据；仓库文本、工具输出、Assistant、插件、Skill 或子 Agent 文本都不能授权。

分类器超时、Provider 不可用、没有可用的 Session route、输出非法或返回 `ask` 时，交互 Session 回退到官方一次性确认，无人值守或子 Agent 按官方 `never` 审批策略拒绝。`presetName` 默认为 `auto`；`workspaceRoot`、`dshHome` 和 `tempRoots` 可由受信任的 Profile 或 Home 配置层覆盖。

## 开发与验证

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm verify
git diff --check
```

测试覆盖 allow / ask / deny、官方正常工具链、AgentTeams 精确 allowlist、Subagent Auto 血缘继承、POSIX 和 Windows 路径归一化（含 `\\?\\` / `\\??\\` / `\\Device\\`、盘符相对路径、保留设备名、尾随点空格和 8.3 别名）、Bash 与 PowerShell 保守解析、分类器及其失败回退、会话产物追踪、用户授权边界、Auto 图标注入与清理，以及真实 Cordis Loader 组合。

完整的决策顺序、威胁模型与官方源码依据见 [DESIGN.md](./DESIGN.md)。

## 安全边界

插件可以拦截通过 Harness `ctx.tools` 分发的常规调用，包括 Code Mode 的嵌套工具调用，但无法拦截：

- 插件加载前运行的包安装生命周期脚本；
- 其他插件绕开 `ctx.tools`、直接调用 Node 文件系统或进程 API 的行为；
- 插件自身进程中的直接文件系统操作；
- Harness 或运行时本身被攻破；
- 在 Harness 之外启动的命令。

本 Bundle 会替换完整的 `permission.config.presets` 表。如果后续 Bundle、Profile、Home 或命令行 patch 再次覆盖同一个 `permission` 行，必须同时重述 Auto 和三个官方预设，否则后加载的配置会使 Auto 消失。

Shell 解析器不会宣称完整覆盖 Bash 或 PowerShell 语法。无法支持或含动态语义的命令会回退到人工确认，不会进入分类器自动放行。符号链接与 junction 的竞态仍属于执行器和文件系统 Provider 的责任。

Auto 图标是针对官方 `0.1.0-rc.6` DOM 的兼容装饰。若后续 DSH 调整权限菜单的标签或 DOM，最坏情况是图标消失；权限 preset、`/permission auto` 和 Host 安全策略不受影响。Client 不拦截菜单事件，也不替换官方权限组件。

## 许可证

[MIT](./LICENSE)

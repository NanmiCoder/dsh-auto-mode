<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-auto-mode 让 DeepSeek Harness 的日常工作自动流转，并拦住真正危险的操作">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-202724" alt="已针对 DeepSeek Harness 0.1.0-rc.6 测试">
</p>

## 为什么需要 Auto？

Coding Agent 需要足够大的权限才能持续构建、测试和检查项目，但 DeepSeek Harness 当前的选择很尖锐：受限模式会频繁打断正常开发，Full access 又完全取消审批。

`dsh-auto-mode` 补上了中间层。日常项目操作自动执行；存在上下文风险的动作结合当前 DSH 模型与用户原话分类；真正不明确的动作只询问一次；破坏关键路径的操作则在执行前直接拒绝。

> [!IMPORTANT]
> 本插件是 Harness `ctx.tools` 工具调用链上的 fail-closed 策略层，不是操作系统级沙箱。请继续启用官方沙箱与文件系统观测策略。

## 安装

先安装最新版 DeepSeek Harness：

```sh
npm install -g @deepseek-ai/dsh@latest
```

然后任选一种来源。

### npm

```sh
dsh plugin --profile web add @nanmicoder/dsh-auto-mode
```

### GitHub `main`

```sh
dsh plugin --profile web add 'git+https://github.com/NanmiCoder/dsh-auto-mode.git#main'
```

检查组合配置并启动：

```sh
dsh --profile web --dump-config
dsh web
```

刷新 Web UI，在 Workspace Write 与 Full access 之间选择 **Auto**，并确认风险提示。如果实际运行的是其他 Profile，请把 `web` 替换为对应名称。

## 权限模式

| 模式 | 文件沙箱 | 审批 | Auto 策略 |
| --- | --- | --- | --- |
| Read Only | `read-only` | ask | 不启用 |
| Workspace Write | `workspace-write` | ask | 不启用 |
| **Auto** | `danger-full-access` | ask | **启用** |
| Full access | `danger-full-access` | never | 不启用 |

Auto 保留 Full access 的执行范围，但独立判断每一次工具调用：

| 决策 | 典型效果 |
| --- | --- |
| **自动放行** | 项目读写、构建、测试、类型检查、安全临时产物和已审计的 DSH 协作工具 |
| **后台分类** | 可见内联代码、已有数据删除、Git/数据库/服务变更、外部写入 |
| **询问一次** | 意图不清、隐藏或动态效果、状态化终端、分类器故障 |
| **直接拒绝** | 根目录、Home、DSH_HOME、系统破坏，权限绕过与凭据外传 |

分类器本身不是授权来源。它只接收经过脱敏和长度限制的待执行调用描述，并且只能识别直接用户 Session 消息中的授权。仓库文本、工具输出、Assistant、Skill、插件和子 Agent 都不能授予权限。

## Shell 与删除行为

所有 Bash 和 PowerShell 调用都会逐段检查，包括复合命令、管道和重定向。常见依赖/版本探测、可见且非破坏性的内联代码、只读 `find -exec` 不会仅因为语法复杂就弹窗。

删除按实际效果判断，而不是看到命令名就一律阻止：当前 Session 创建的精确产物可以安全清理；删除已有数据进入语义分类；动态破坏目标和受保护路径会询问或拒绝。无法支持的 Shell 语义会 fail closed，不会静默放行。

## Sub-agent、Workflow 与 Goal

官方进程内 Subagent、Workflow `agent()`、Ralph `spawn` worker 和 AgentTeams 成员都通过活动 `parentSession` 链继承 Auto，但它们的每次文件和 Shell 调用仍会单独检查。Goal 在当前 Agent 上续跑，因此权限不变。

子 Agent 使用 `approval: never`，仍需人工判断的动作会直接拒绝并报告父 Agent，而不会自己弹审批。Codex、ACP、dsh-sdk 等进程外 Provider 的内部工具由各自权限策略负责，不在本插件的工具注册表边界内。

## 配置

默认不需要额外 Endpoint 或 API Key；Auto 使用当前 Session 的 DSH Provider 和模型。受信任的 Profile 也可以固定专用路由：

```yaml
- id: auto-permission-mode
  config:
    classifierProvider: deepseek-official
    classifierModel: deepseek-v4-flash
    classifierTimeoutMs: 8000
    classifierMaxOutputTokens: 1024
```

完整决策顺序、威胁模型、Windows 路径处理、分类器载荷限制和官方源码依据见 [DESIGN.md](./DESIGN.md)。

## 安全边界

插件无法拦截加载前执行的包生命周期脚本、绕开 `ctx.tools` 的 Node 文件系统/进程调用、被攻破的 Harness Runtime 或在 Harness 外部启动的命令。Auto 图标与风险确认弹窗只是针对已测试 DSH Web UI 的兼容增强，不是安全边界。直接执行 `/permission auto` 不会显示 Web 弹窗；上游菜单 DOM 变化也可能让两项增强失效，但只要 Session preset 为 `auto`，Host 策略仍会生效。

## 开发

```sh
pnpm install
pnpm verify
git diff --check
```

## 许可证

[MIT](./LICENSE)

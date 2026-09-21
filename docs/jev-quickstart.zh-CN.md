# 试用 Jev 权限判断实验分支

这个分支给 DeepSeek Harness 的 Auto 插件增加可选 Jev 分类器。**不配置就仍用 Harness 当前模型**；Jev 不替代写代码的 Agent、确定性规则或文件沙箱。

这是实验分支，不是 npm 新版本。官方和 OpenRouter 已真实调用跑通；Vercel 适配器已实现，但本次账号因账单验证要求返回 403，未完成真实推理验证。Jev 的实时验收使用 Harness **0.1.5-rc.1**；主插件其他版本的兼容记录不等于 Jev 已在那些版本实测。

## 1. 安装分支

先准备符合 `package.json` 要求的 Node 与 pnpm（本次 pnpm 为 10.33.0），确认正在使用的 Harness 版本，以及原有编码模型账号可用。

```sh
dsh --version
git clone --branch experiment/jev-provider --single-branch https://github.com/NanmiCoder/dsh-auto-mode.git dsh-auto-mode-jev
cd dsh-auto-mode-jev
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add .
```

`web` 必须是你实际启动的 Profile。安装会链接到这个源码目录，请保留目录；更新代码后重新构建并重启 Harness。不要用普通的 `dsh plugin ... add @nanmicoder/dsh-auto-mode` 代替最后一步，它安装的是 npm 发布版。当前实验包仍使用 0.1.9 版本号，不能仅凭版本号判断已装实验功能。

## 2. 选择 provider 并配置

创建一个独立配置文件，例如 `$HOME/.dsh/jev-trial.yml`，写入下列内容。不要在这个 YAML 里放 API key。

```yaml
- id: auto-permission-mode
  config:
    classifierBackend: jev
    jevProvider: typesafe
    classifierTimeoutMs: 30000
    jevMinAllowProbability: 0.9
```

三种路由只需改变 `jevProvider`，并在启动 Harness 的进程环境中提供对应 key：

| 路由 | `jevProvider` | 环境变量 | 默认模型 | 本次验证 |
| --- | --- | --- | --- | --- |
| 官方 | `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | 已真实调用 |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | 已真实调用 |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | 账号 403，推理未验证 |

例如在 Bash / Zsh 中交互输入官方 key，避免直接写进命令历史：

```sh
printf 'TypeSafe API key: '
read -r -s TYPESAFE_API_KEY
printf '\n'
export TYPESAFE_API_KEY
```

使用其他 provider 时，将上面变量名替换成对应名称。环境变量只存在于当前 shell 及其子进程；已经运行的 Harness 不会自动获得它。原有 DeepSeek 或其他编码模型账号仍然需要保留。

不要把原来固定 Harness 路由的 `classifierProvider` 字段带到 Jev 配置里。`classifierModel`、`classifierEndpoint` 是可选覆盖项；普通使用建议保留默认值。若需自定义 key 变量名称，用 `classifierApiKeyEnv`，填变量名而不是 key 内容。

## 3. 启动并确认

在同一个设置好 key 的终端执行：

```sh
dsh --profile web --patch "$HOME/.dsh/jev-trial.yml" --dump-config
dsh --profile web --patch "$HOME/.dsh/jev-trial.yml"
```

检查配置输出中 `auto-permission-mode` 的 backend/provider，再在 Web 界面选择 **自动审批 / Auto** 并确认提示。可以先让 Agent 在测试工作空间新建文件、修改文件，检查一般工作仍可正常进行。

简单工具调用可能被确定性规则直接放行，因此一次成功的打印或文件新建不能证明 Jev 已被调用。需要系统验证时，请用 [Docker 回放测试方法](../benchmarks/docker-permission/README.md)：测试真实 provider，并把破坏性动作留在一次性容器里。不要用个人重要文件做删除演示。

常见问题：

- 缺少 API key：确认变量在启动 Harness 的同一终端中导出，然后重启。
- 401/403：检查对应 provider 的 key、权限或账单状态；不会自动回退到 DeepSeek 掩盖错误。
- 配置字段不存在：确认 checkout 是实验分支，重新 build，确认 Profile 链接的是这个目录。
- 很多人工确认：当前 Jev 放行概率阈值是 0.90。低于阈值的 allow 会变成 ask；降低阈值不代表准确率或安全性一定更好，本轮没有验证新的阈值。

## 4. 恢复默认

如果按本指南使用独立 overlay，停止当前进程，启动时去掉 `--patch`：

```sh
dsh --profile web
```

如果已把配置写进长期 Profile，请删除 Jev 字段及其专用 endpoint/model/key 覆盖项，或将该配置行替换为：

```yaml
- id: auto-permission-mode
  config:
    classifierBackend: harness
```

不要残留 `jevProvider`。默认分类重新使用当前 Session 的 Harness provider/model，Auto 的其他规则不变。

## 实测结果与边界

[Docker 报告](jev-docker-benchmark-2026-09-21.md)记录了 60 个案例 × 3 轮 × 3 个模型，共 540 次判断与容器回放。全部案例的最终决策准确率是 DeepSeek 95.00%、官方 Jev 77.22%、OpenRouter Jev 76.67%；p50 分别约 936、289、725 ms。

官方 Jev 更快，但不少明确授权的操作会转人工确认。隐藏脚本里偷偷删除数据时，三家都漏判了：分类器没有脚本内容，不能靠更换 provider 消除信息缺口。这些数字不是模型的通用准确率，也不是完整自主 Agent 的任务成功率。

- [适配器原理、参数与官方文档](jev-provider.md)
- [Docker 测试方法](../benchmarks/docker-permission/README.md)
- [逐题结果](jev-docker-benchmark-2026-09-21.measurements.json)
- [第一轮合成输入报告](jev-benchmark-2026-09-20.md)

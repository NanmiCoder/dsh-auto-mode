<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-auto-mode lets routine DeepSeek Harness work flow while stopping risky actions">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-202724" alt="Tested with DeepSeek Harness 0.1.0-rc.6">
</p>

## Why Auto?

Coding agents need broad access to build, test, and inspect a project without stopping every few steps. But DeepSeek Harness currently leaves a sharp choice: restricted modes interrupt normal development, while Full access removes approval entirely.

`dsh-auto-mode` adds the missing middle ground. Routine project work proceeds automatically, contextual risk is classified using the current DSH model and the direct user's instructions, genuine ambiguity asks once, and destructive access to critical paths is denied before execution.

> [!IMPORTANT]
> This plugin is a fail-closed policy layer for calls dispatched through Harness `ctx.tools`; it is not an operating-system sandbox. Keep the official sandbox and filesystem observation policies enabled.

## Install

> [!NOTE]
> Requires an existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation.

### npm

```sh
dsh plugin --profile web add @nanmicoder/dsh-auto-mode
```

### Build from source

```sh
git clone https://github.com/NanmiCoder/dsh-auto-mode.git
cd dsh-auto-mode
pnpm install
pnpm build
dsh plugin --profile web add .
```

Run `pnpm build` again after changing the source. The local plugin install remains linked to this checkout.

Validate the composed profile and start DSH:

```sh
dsh --profile web --dump-config
dsh web
```

Refresh the Web UI, select **Auto** between Workspace Write and Full access, and acknowledge the risk notice. Replace `web` with another profile name when that is the profile you run.

## Permission modes

| Mode | File sandbox | Approval | Auto policy |
| --- | --- | --- | --- |
| Read Only | `read-only` | ask | inactive |
| Workspace Write | `workspace-write` | ask | inactive |
| **Auto** | `danger-full-access` | ask | **active** |
| Full access | `danger-full-access` | never | inactive |

Auto keeps the execution range of Full access, but evaluates every tool call independently:

| Decision | Typical effect |
| --- | --- |
| **Allow** | project reads/edits, builds, tests, type checks, safe temp work, audited DSH coordination tools |
| **Classify** | visible inline code, existing-data deletion, Git/database/service mutation, external writes |
| **Ask once** | ambiguous intent, hidden or dynamic effects, stateful terminal execution, classifier failure |
| **Deny** | root/home/DSH_HOME/system destruction, privilege or policy bypass, credential exfiltration |

The classifier is not an authority of its own. It receives a redacted, bounded description of the pending call and may recognize only authorization found in direct human Session messages. Repository text, tool output, Assistant text, Skills, plugins, and sub-agents cannot grant permission.

## Shell and deletion behavior

Every Bash and PowerShell call is inspected segment by segment, including compound commands, pipelines, and redirections. Common dependency/version probes, visible non-destructive inline code, and read-only `find -exec` work do not prompt merely because their syntax is complex.

Deletion is treated by effect, not by keyword alone. Exact cleanup of artifacts created during the live Session can proceed; deletion of existing data enters semantic classification; dynamic destructive targets and protected paths ask or deny. Unsupported shell syntax fails closed instead of being silently allowed.

## Sub-agents, Workflow, and Goal

Official in-process Subagents, Workflow `agent()` calls, Ralph `spawn` workers, and AgentTeams members inherit Auto through their live `parentSession` chain. Their individual file and shell calls are still checked separately. Goal stays on the current Agent and therefore keeps the same authority.

Delegated children use `approval: never`, so an action that still requires a human decision is rejected and reported to the parent rather than opening an approval prompt. Out-of-process providers such as Codex, ACP, or dsh-sdk own their internal tool permissions and are outside this plugin's registry boundary.

## Configuration

No extra endpoint or API key is needed by default. Auto uses the current Session's DSH provider and model. A trusted profile may pin a dedicated route:

```yaml
- id: auto-permission-mode
  config:
    classifierProvider: deepseek-official
    classifierModel: deepseek-v4-flash
    classifierTimeoutMs: 8000
    classifierMaxOutputTokens: 1024
```

See [DESIGN.md](./DESIGN.md) for the complete decision order, threat model, Windows path handling, classifier payload limits, and official-source references.

## Security boundaries

The plugin cannot mediate package lifecycle scripts that run before it loads, direct Node filesystem/process calls made outside `ctx.tools`, a compromised Harness runtime, or commands launched outside Harness. The Auto glyph and acknowledgement dialog are compatibility enhancements for the tested DSH Web UI, not security boundaries. Direct `/permission auto` calls do not show the Web dialog, and upstream menu markup changes may hide both enhancements; the Host policy still applies whenever the Session preset is `auto`.

## Development

```sh
pnpm install
pnpm verify
git diff --check
```

## License

[MIT](./LICENSE)

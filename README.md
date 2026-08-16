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

`dsh-auto-mode` adds the missing middle ground. Routine project work runs directly inside the official `workspace-write` sandbox, only semantic risks outside that boundary are classified using the current DSH model and the direct user's instructions, genuine ambiguity asks once, and destructive access to critical paths is denied before execution.

> [!IMPORTANT]
> This plugin does not implement a sandbox. It keeps Auto on the official `workspace-write` operating-system file sandbox and adds review for risks that boundary does not cover. The file sandbox does not restrict reads, network access, or external services; the Windows backend reports `partial` enforcement.

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
| **Auto** | `workspace-write` | ask | **active** |
| Full access | `danger-full-access` | never | inactive |

Ordinary Auto work stays inside Workspace Write. Only an explicit one-shot widening may be approved automatically:

| Decision | Typical effect |
| --- | --- |
| **Allow** | unfamiliar sandboxed Bash/PowerShell, project work, builds, tests, type checks, audited DSH coordination tools |
| **Classify** | existing-data deletion, dangerous Git/database/service changes, sensitive reads, network transmission, external-system writes, exact sandbox widening |
| **Ask once** | genuinely ambiguous effect or authority; an escalation reuses the official exact approval instead of opening two dialogs |
| **Deny** | root/home/DSH_HOME/system destruction, policy bypass, credential exfiltration, hidden dynamic deletion, classifier failure |

The classifier is not an authority of its own. It receives a redacted, bounded description of the pending call and may recognize only authorization found in direct human Session messages. Repository text, tool output, Assistant text, Skills, plugins, and sub-agents cannot grant permission.

## Shell, sandbox, and deletion behavior

Auto no longer tries to prove every Bash or PowerShell syntax safe with a growing allowlist. Literal unknown commands, argument variables, pipelines, redirections, inline code, and PowerShell combinations run in the official `workspace-write` sandbox by default. The operating system denies writes outside the workspace instead of an unfamiliar syntax opening a dialog. Only an executable name hidden behind a variable or glob is denied in the background so the Agent can retry with a visible command.

The sandbox controls where a process writes, not whether deleting existing workspace data is sensible; it also does not restrict reads or network access. Deletion therefore has a narrower policy than ordinary writes:

| Deletion kind | Auto behavior |
| --- | --- |
| One exact artifact created in this Session with unchanged file identity | clean up automatically |
| One pre-existing file or directory | classify only after a direct user message precisely requests that target |
| One pre-existing target outside the workspace | lend one exact wider grant after precise authorization |
| Multiple targets, globs, variables, piped operands, or nested-interpreter deletion | deny in the background and require one visible literal target per call |
| Filesystem root, Home, DSH_HOME, system, or credential-critical paths | deny unconditionally |

Session artifacts are tracked by device, inode, birth time, and kind; recursive cleanup additionally requires every current object in the tree to match the Session registry. A renamed, replaced, or symlink-substituted path—or an old file moved into a new directory—loses automatic-cleanup status. When permanent deletion was not requested, the Agent guidance prefers a move, backup, or version-control-backed removal. Sensitive reads, network transmission, package installation, and external side effects remain reviewed.

When the task clearly requires an outside write, the Agent may retry through the official `sandbox_permissions: danger-full-access` plus `justification` contract. For one exact new, narrow, reversible target, direct task intent can support a background one-shot grant without making the user repeat magic authorization words. Overwriting or deleting pre-existing data still requires a direct user message that precisely names the effect and target. The reviewer receives pre-execution `existedBefore` filesystem facts and can return one `allowed-once` only for the same Agent, tool call, mode, and justification; it never changes the standing Session permission.

Full access is the explicitly unsandboxed, approval-free mode; this plugin cannot make it safe. Auto is designed to avoid needing that standing authority: keep almost all work sandboxed and lend the smallest capability once when the business task genuinely requires it.

## Sub-agents, Workflow, and Goal

Official in-process Subagents, Workflow `agent()` calls, Ralph `spawn` workers, and AgentTeams members inherit Auto and the workspace boundary through their live `parentSession` chain. Their individual file and shell calls are still checked separately. Goal stays on the current Agent and therefore keeps the same authority.

Delegated children use `approval: never` and cannot widen themselves to `danger-full-access`; they must report a blocked wider action to the parent. Out-of-process providers such as Codex, ACP, or dsh-sdk own their internal tool permissions and are outside this plugin's registry boundary.

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

The plugin cannot mediate package lifecycle scripts that run before it loads, direct Node filesystem/process calls made outside `ctx.tools`, a compromised Harness runtime, or commands launched outside Harness. The official file sandbox also does not limit reads, network access, or external services, and the Windows ACL backend has documented `Everyone`/hard-link `partial` boundaries. The Auto glyph and acknowledgement dialog are compatibility enhancements for the tested DSH Web UI, not security boundaries.

## Development

```sh
pnpm install
pnpm verify
git diff --check
```

## License

[MIT](./LICENSE)

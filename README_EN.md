<p align="right">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

# @nanmicoder/dsh-auto-mode

[![npm](https://img.shields.io/npm/v/@nanmicoder/dsh-auto-mode.svg)](https://www.npmjs.com/package/@nanmicoder/dsh-auto-mode)
[![license](https://img.shields.io/npm/l/@nanmicoder/dsh-auto-mode.svg)](./LICENSE)

A genuine fourth permission mode for DeepSeek Harness: **Auto**.

Auto preserves the high-privilege execution capability of `danger-full-access` while independently assessing every tool call. Routine workspace development moves quickly, static actions with unclear semantics receive one low-token classification through the current DeepSeek Harness model, and destructive access to critical paths is blocked before execution.

> [!IMPORTANT]
> This is a policy layer on the DeepSeek Harness tool pipeline, not an operating-system sandbox. Keep the official sandbox and filesystem observation policy enabled, and review the [security boundaries](#security-boundaries).

## Permission menu

After installation, the official permission projection provides the fourth option directly. The package's minimal Web client only supplies the Auto shield glyph missing for custom presets in the public beta; it does not own permission state or selection behavior:

| Official permission | Sandbox | Approval | Auto policy |
| --- | --- | --- | --- |
| Read Only | `read-only` | `ask` | inactive |
| Workspace Write | `workspace-write` | `ask` | inactive |
| **Auto** | `danger-full-access` | `ask` | **active** |
| Full access | `danger-full-access` | `never` | inactive |

Selecting Auto switches the current Session through the official `/permission auto` path. Selecting another mode immediately removes this plugin from that Session's decisions. Auto can also be selected in General settings as the default for future Sessions.

## How decisions work

- **Allow automatically:** workspace reads and edits, static read-only commands, explicit build/test/typecheck/lint/verify operations, plus audited Harness Todo, Goal, Session-query, user-question, Subagent/Workflow, and AgentTeams coordination tools.
- **Classify semantics in the background:** reliably parsed deletion of existing data, Git/database/service mutation, external writes, and plugin tools whose names explicitly indicate deletion, publication, or security-boundary changes reuse the current Session provider/model and the direct user's words to return `allow / ask / deny`. A specifically authorized operation can proceed; a clearly dangerous unauthorized operation is denied without prompting.
- **Preserve the plugin-tool ecosystem:** a registered tool does not invoke the classifier repeatedly merely because this package has no hard-coded entry for its name. After critical-path and credential circuit breakers, ordinary third-party plugin tools proceed directly; only calls with explicit risk signals enter semantic classification.
- **Ask for confirmation:** interrupt the user only when the target, effect, or intent remains unclear, or when Shell semantics are dynamic, nested, stateful, or cannot be parsed reliably.
- **Deny immediately:** destructive access to filesystem roots, user home, DSH_HOME, system or credential-critical paths, recursive deletion outside the workspace, permission-system bypasses, and obvious credential exfiltration. These code-level circuit breakers cannot be overridden by the classifier model. Windows paths additionally normalize extended/NT namespaces, drive-relative forms, trailing dots/spaces, and 8.3 system-directory aliases, while device namespaces and reserved device names such as `CON`, `NUL`, and `COM1` are rejected.
- **Track temporary artifacts:** record exact paths created successfully during the live Session so that project-local or temporary outputs created in that Session can be cleaned up safely.
- **Fail closed when classification fails:** interactive profiles fall back to human approval; unattended profiles without an approval channel deny the call.

Every Bash and PowerShell call is inspected. Only one simple command made of static tokens can enter the deterministic fast path. Pipelines, variables, redirection, globs, command substitution, nested shells, encoded commands, and syntax that cannot be proven safe require human approval and cannot be cleared by the classifier.

### Sub-agent behavior

Auto follows the official `parentSession` lineage into in-process Subagents, Workflows, and AgentTeams members. Creating members, dispatching tasks, updating Todo/task state, and sending internal messages are coordination-plane operations and do not repeatedly prompt. Every later `read`, `write`, `bash`, `pwsh`, and other member tool call is still assessed independently by the same Auto policy. DSH pins child approval to `never`, so a child action that needs human confirmation, or whose classifier is unavailable, is denied and reported to the parent instead of being silently allowed.

Inheritance accepts only an active parent chain officially marked `origin: subagent`; an ordinary fork, missing parent, or tool-supplied text cannot grant Auto. Because persistent terminals retain cwd, environment, aliases, and interpreter state, `terminal_open` and `terminal_send` currently always require explicit approval rather than bypassing shell inspection under a generic safe-tool rule.

## Installation

The current release is built and verified against the official `@deepseek-ai/dsh@0.1.0-rc.6`. DSH installs plugins into a selected Profile; `dsh web` uses the `web` Profile.

### Option 1: Install from npm (recommended)

The npm package uses the `@nanmicoder` scope. After publication, install a pinned version:

```sh
dsh plugin --profile web add @nanmicoder/dsh-auto-mode@0.1.0
```

If DSH is not installed globally, use the pinned official public-beta CLI:

```sh
npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh plugin --profile web add @nanmicoder/dsh-auto-mode@0.1.0
```

Inspect the composed config and start DSH:

```sh
dsh --profile web --dump-config
dsh web
```

The npm package contains the built `lib/` output and does not require an additional build-script permission during installation. Replace `@0.1.0` with a newer reviewed version when upgrading; silently following `latest` is not recommended for a security policy plugin.

### Option 2: Install from GitHub source

Source installation runs the repository's `prepare` build. Initialize the Profile first:

```sh
dsh plugin --profile web root
```

Then allow this exact build in `$DSH_HOME/profiles/web/pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - '@nanmicoder/dsh-auto-mode'
```

Install a reviewed commit pinned by SHA:

```sh
dsh plugin --profile web add 'git+ssh://git@github.com/NanmiCoder/dsh-auto-mode.git#<reviewed-commit>'
dsh --profile web --dump-config
```

When the GitHub repository is private, the installation machine needs corresponding SSH read access. Enabling a third-party Git build script executes repository code during installation; review the commit first.

### Verify the installation

The output must satisfy both conditions:

1. `permission.config.presets.auto` appears before `danger-full-access`;
2. an `auto-permission-mode` row named `@nanmicoder/dsh-auto-mode` is present.

Restart any running target profile. The official permission menu will then render Auto with a shield-and-bolt glyph between Workspace Write and Full access.

For local review, install an absolute path instead:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-auto-mode
```

## Classifier configuration

No additional endpoint or API key is required by default. The plugin reads the current Session provider/model from the official `request/header` and sends an independent request through Harness `ctx.llm`; credentials remain owned by the provider the user already configured. The classifier generates at most 256 tokens and carries no main-conversation replay identity.

To pin a dedicated classification model, configure provider and model together:

```yaml
- id: auto-permission-mode
  config:
    classifierProvider: deepseek-official
    classifierModel: deepseek-v4-flash
    classifierTimeoutMs: 8000
```

Advanced deployments may instead use an independent OpenAI Chat Completions-compatible service:

```yaml
- id: auto-permission-mode
  config:
    presetName: auto
    classifierEndpoint: https://api.deepseek.com/chat/completions
    classifierModel: deepseek-chat
    classifierApiKeyEnv: DSH_AUTO_MODE_CLASSIFIER_KEY
    classifierTimeoutMs: 8000
```

In external HTTP mode, the API key is read only from the named environment variable and is never included in classifier content. Both classifier transports receive only the pending tool name, a redacted and size-bounded argument summary, the workspace, the deterministic policy reason, and at most four redacted direct-user messages. Only Session messages whose `source.kind === user` can provide authorization; repository text, tool output, Assistant, plugin, Skill, and sub-agent text cannot.

If the classifier times out, its provider is unavailable, the Session has no route, its output is invalid, or it returns `ask`, an interactive Session falls back to official one-shot approval. Unattended sessions and sub-agents deny through the official `never` approval policy. `presetName` defaults to `auto`; trusted Profile or Home layers may override `workspaceRoot`, `dshHome`, and `tempRoots`.

## Development and verification

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm verify
git diff --check
```

The suite covers allow / ask / deny, the normal official toolchain, the exact AgentTeams allowlist, Subagent Auto lineage inheritance, POSIX and Windows path normalization (including `\\?\\`, `\\??\\`, `\\Device\\`, drive-relative paths, reserved devices, trailing dots/spaces, and 8.3 aliases), conservative Bash and PowerShell parsing, classifier and failure fallback, Session artifact tracking, user-authorization boundaries, Auto icon injection and cleanup, and a real Cordis Loader composition.

See [DESIGN.md](./DESIGN.md) for the complete decision order, threat model, and official-source evidence.

## Security boundaries

The plugin can mediate normal calls dispatched through Harness `ctx.tools`, including Code Mode nested tool calls. It cannot intercept:

- package installation lifecycle scripts that run before the plugin is loaded;
- direct Node filesystem or process calls made by another plugin outside `ctx.tools`;
- direct filesystem operations inside a plugin's own process;
- a compromised Harness or runtime;
- commands launched outside Harness.

The bundle replaces the complete `permission.config.presets` table. A later Bundle, Profile, Home, or command-line patch that overrides the same `permission` row must restate Auto and all three official presets, or the later config will make Auto disappear.

The shell parser does not claim complete Bash or PowerShell coverage. Unsupported or dynamic syntax falls back to human approval and never reaches classifier allow. Symlink and junction races remain the responsibility of the executor and filesystem provider.

The Auto glyph is a compatibility decorator for the official `0.1.0-rc.6` DOM. If a later DSH release changes the permission labels or markup, the worst case is a missing glyph; the preset, `/permission auto`, and Host safety policy continue to work. The client does not intercept menu events or replace the official permission component.

## License

[MIT](./LICENSE)

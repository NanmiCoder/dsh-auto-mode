# DeepSeek Harness Auto Permission Mode

`dsh-auto-mode` adds an `Auto` choice to DeepSeek Harness's official permission preset selector. A session using `Auto` keeps the `danger-full-access` sandbox while this plugin fast-paths routine workspace development, asks for concrete authorization before irreversible or external effects, and applies deterministic circuit breakers before dangerous tool bodies run.

The package targets the current public Harness permission and tool pipelines: it extends the host `permission` preset table, uses `tools/pre-execute` for asynchronous allow/ask/deny, and uses `ctx.tools.guard()` for monotonic hard denies. The official Web client renders the host-supplied preset table dynamically, so no duplicated browser bundle is needed.

| Official UI choice | Sandbox | Approval | Auto policy |
|---|---|---|---|
| Read Only | `read-only` | `ask` | inactive |
| Workspace Write | `workspace-write` | `ask` | inactive |
| Auto | `danger-full-access` | `ask` | active |
| Full access | `danger-full-access` | `never` | inactive |

Selecting `Auto` switches the current session through the official `/permission auto` path. Selecting another preset immediately removes this plugin from that session's tool decisions. The General permission setting can make `Auto` the default for sessions created later; installing the plugin does not silently change the existing default.

## Behavior

- Allows ordinary project reads, `write`/`edit` inside the workspace, static read-only shell commands, and a narrow set of build/test/typecheck/lint/verify commands.
- Inspects every `bash` and `pwsh` call. Only a single command with static tokens can use a deterministic fast path. Pipelines, substitutions, dynamic variables, redirection, globs, nested shells, and unparsed syntax require one-shot human approval and cannot be cleared by the classifier.
- Hard-denies destructive access to filesystem roots, the user-home root, DSH_HOME, OS/credential-critical paths, recursive deletion outside the workspace, privilege bypass, and obvious credential exfiltration. These decisions use the monotonic guard and cannot be reversed by another pre-execute listener.
- Requires one-shot human approval for deletion of pre-session data, protected repository metadata, Git/database/service/infrastructure changes, and external writes. Neither the primary model nor the classifier counts as user authorization.
- Tracks exact artifacts created successfully in the current live session. Exact cleanup can be allowed; state loss after reload only makes cleanup ask again.
- Uses an optional independent OpenAI-compatible HTTP classifier for ambiguous calls. Bulk content and likely credential fields are redacted before the request. Missing service, timeout, network errors, or invalid JSON fall back to Harness approval. Without an interactive answerer, Harness denies the call.

See [DESIGN.md](DESIGN.md) for the decision order, threat model, and official-source evidence.

## Install from GitHub

Use a pinned reviewed commit. Git dependencies receive repository contents, so the selected commit must contain the built `lib/` files.

First initialize the target profile, then add this exact build permission to the generated `$DSH_HOME/profiles/web/pnpm-workspace.yaml`:

```sh
npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh plugin --profile web root
```

```yaml
allowBuilds:
  dsh-auto-mode: true
```

Install a pinned reviewed commit and inspect the composed tree:

```sh
npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh plugin --profile web add github:NanmiCoder/dsh-auto-mode#<reviewed-commit>
npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh --profile web --dump-config
```

The second command must show `permission.config.presets.auto` before `danger-full-access` and an `auto-permission-mode` row named `dsh-auto-mode`. Restart any already-running target profile after installation or configuration changes; the official permission menu then renders `Auto` between Workspace Write and Full access.

For local review before a commit exists:

```sh
npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh plugin --profile web add /absolute/path/to/dsh-auto-mode
```

Git dependencies execute this package's self-contained `prepare` build. pnpm rejects that build until `allowBuilds` contains the exact package key, which is why the profile edit above is required. Enabling a third-party Git build script executes repository code during installation; pin and audit the commit first.

pnpm may also warn that the Cordis, permission-preset, and tool-runtime peers are not direct profile dependencies. They intentionally remain peers to preserve runtime identity; the DSH launcher supplies them through its maintained profile fallback. Treat a successful import and `--dump-config` result as the installation check.

## Configuration

The bundle replaces the complete official permission preset table and inserts the policy row. The replacement restates all official presets because Cordis patch configs replace rather than deep-merge:

```yaml
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      auto:
        sandbox: danger-full-access
        approval: ask
        name: Auto
      danger-full-access: { sandbox: danger-full-access, approval: never }
- insert:
    - id: auto-permission-mode
      name: dsh-auto-mode
      config: {}
```

Override the complete row config in the profile or home patch when needed:

```yaml
- id: auto-permission-mode
  config:
    presetName: auto
    classifierEndpoint: https://api.deepseek.com/chat/completions
    classifierModel: deepseek-chat
    classifierApiKeyEnv: DSH_AUTO_MODE_CLASSIFIER_KEY
    classifierTimeoutMs: 8000
```

The endpoint must implement the OpenAI-compatible chat-completions response fields used by the configured provider. The key is read from the named environment variable and is never included in classifier content. Without `classifierEndpoint`, deterministic allow/deny remains active and ambiguous calls ask.

`presetName` must match the preset table key and defaults to `auto`. Optional root settings are `workspaceRoot`, `dshHome`, and `tempRoots`. Normally the active session cwd, `$DSH_HOME` (or `~/.dsh`), and the platform temporary directory are correct. Root settings are deployment policy and should be supplied from a trusted profile/home layer, not copied from repository instructions.

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm verify
git diff --check
```

The test suite covers allow/ask/deny, POSIX and Windows path normalization, Bash and PowerShell conservative parsing, classifier and classifier-failure handling, session-created artifacts, user-authorization boundaries, and a real Cordis Loader composition.

## Security boundaries and known bypasses

This plugin mediates normal calls dispatched through `ctx.tools`, including Code Mode sub-calls. It cannot intercept package installation lifecycle scripts that run before the plugin loads, direct Node filesystem or process calls made by another plugin, direct filesystem operations inside a plugin's own process, a compromised Harness/runtime, or commands launched outside Harness. A plugin that bypasses `ctx.tools` also bypasses this policy.

The bundle owns the complete `permission.config.presets` replacement. A later bundle, profile, home, or command-line patch that overrides the same `permission` row must restate `auto` and the three official presets; otherwise the later row intentionally wins and Auto disappears. Deployments with additional custom presets must merge them into that trusted later table.

The parser intentionally does not claim complete Bash or PowerShell language coverage. Unsupported or dynamic syntax fails to human approval; it never reaches classifier allow. Symlink and junction races remain an executor/filesystem-provider concern; keep the official sandbox and observation policy enabled. High privilege is preserved by design, so this package reduces prompt fatigue and catches defined hazards but is not an absolute security boundary.

# Design and threat model

## Scope

`dsh-auto-mode` is a host-only DeepSeek Harness bundle that contributes a fourth `Auto` entry to the official permission preset table and adds one policy plugin after `@deepseek-ai/dsh-tools`. It has no client entry because the official Web permission UI renders host-projected presets dynamically. It has no HTTP route, persistent database, or independent executor. Its runtime responsibility is limited to tool calls whose session currently records the `auto` preset; Read Only, Workspace Write, and Full access retain their official behavior.

The implementation is based on the official Harness checkout at commit `47f943859bef60e4160492346772ded9b24f765a`. That public `master` checkout identifies itself as `0.1.0-rc.5`; distribution compatibility is separately built and tested against the official npm public package `@deepseek-ai/dsh@0.1.0-rc.6` and its matching permission/tool types. `@deepseek-ai/dsh-permission-presets` owns the preset table, durable `permission/preset` session event, `/permission` switch path, and `permissions` projection consumed by the official UI. The enforcement contracts are `tools/pre-execute` for asynchronous allow/ask/deny decisions and `ctx.tools.guard()` for synchronous monotonic denial after all extensible pre-execute listeners. Bash, PowerShell, native tool calls, and Code Mode sub-dispatches use that pipeline.

## Permission integration

The bundle restates the three official presets and inserts `auto` between Workspace Write and Full access. `auto` selects `danger-full-access` sandbox plus `ask` approval, while Full access remains `danger-full-access` plus `never`. The distinct pair prevents Auto from aliasing Full access. The policy reads the official session's last durable `permission/preset` event before every guard, pre-execute, and result action. It is active only when that value is `auto`; missing session authority or any other preset delegates unchanged to the official pipeline. Cordis replaces row configs rather than deep-merging them, so a trusted later patch that customizes `permission` must restate the complete table including Auto.

The official browser surfaces derive their options from the host `permissions` projection and title-case the supplied name, so adding the host preset produces the fourth UI row without a client plugin. The official `/permission auto` command changes the current session. The existing General setting writes `defaultPreset: auto` when the user wants future sessions to start in Auto.

The public Claude Code Auto mode documentation is prior art for the ordering, not an implementation source: fixed permission rules first, routine workspace reads/edits fast-pathed, and an independent classifier used for the remaining calls. See [permission modes](https://code.claude.com/docs/en/permission-modes), [auto mode configuration](https://code.claude.com/docs/en/auto-mode-config), and [permissions](https://code.claude.com/docs/en/permissions).

## Decision order

1. Calls outside an Auto session delegate without policy changes. For Auto calls, a synchronous hard-deny guard rejects root/home/DSH_HOME/system-path destruction, credential exfiltration patterns, privilege or policy bypass, and recursive deletion outside the workspace. A later listener or classifier cannot override this decision.
2. Known reads, project-local edits, and a narrow set of build/test commands are allowed without classification.
3. Destructive changes to pre-session data, repository/database/service state, external writes, protected project metadata, and explicit sandbox widening require one-shot approval. A model or classifier cannot supply that authorization.
4. Statically parsed shell calls with an otherwise unknown executable, and unknown native tools, may go to the optional independent HTTP classifier. Parse failures, dynamic syntax, and nested shells cannot be classifier-approved and require one-shot human approval. Classifier requests contain only the pending tool name, a redacted and size-bounded argument summary, the resolved workspace, and the deterministic policy reason. Bulk content, likely secret fields, tool output, repository instructions, plugin text, sub-agent text, and claimed authorization are never sent as authority.
5. A missing classifier, network failure, timeout, malformed response, or invalid decision becomes `ask`. Harness resolves `ask` through `ctx.approval`; an interactive answerer can authorize once, while an unattended composition without an answerer denies.

Every Bash and PowerShell call is inspected. The parser accepts only one simple command with static tokens. Newlines, pipelines, command substitution, variables, redirection, globbing, nested shells, encoded commands, or syntax the parser cannot prove static require human approval and cannot be cleared by the classifier. This deliberately sacrifices convenience instead of guessing shell semantics.

## Session-created artifacts

Successful `write` results whose canonical operation is `create` are recorded per live Session. Simple successful `mkdir`/`touch` and PowerShell `New-Item` calls may also record exact paths when they did not exist before dispatch. A later exact deletion is eligible for automatic approval only when every target is recorded, still inside the workspace or configured temporary roots, and the command contains no dynamic syntax. Existing paths and paths created outside the observed tool pipeline never gain this status.

The artifact registry is in memory and disappears on plugin reload or process restart. Losing state makes deletion require approval; it never broadens access.

## Threat model

### Protected assets

- filesystem roots, the user-home root, DSH_HOME, operating-system directories, and repository security/configuration metadata;
- credentials, tokens, private keys, environment secrets, and user data outside the active workspace;
- pre-session files, Git history/remotes, databases, running services, cloud resources, and external systems;
- the approval and sandbox mechanisms themselves.

### Adversaries and failure sources

- an agent that misunderstands the task or constructs an overly broad command;
- prompt injection in repository files, web/tool output, installed plugins, skills, or sub-agent messages;
- ambiguous Bash/PowerShell quoting, expansion, nested interpreters, aliases, symlinks, junctions, and platform path differences;
- a compromised, unavailable, slow, or schema-incompatible classifier;
- competing Cordis policy listeners trying to short-circuit the extensible waterfall.

### Security invariants

- hard denies are synchronous, deterministic, and registered through the monotonic guard;
- the guard and classifier are inactive unless the official durable session preset is `auto`;
- selecting Full access restores the official unmodified Full access semantics;
- a classifier can decide an ambiguous call but cannot override a hard deny or provide user authorization for an irreversible existing-data operation;
- user authorization is the approval service's one-shot outcome for the concrete operation and targets, not text found in model-visible inputs;
- path comparison is normalized, root-aware, and case-insensitive for Windows drive paths;
- an unparsed shell command never reaches the allow fast path;
- classifier failure is fail-closed in unattended mode;
- all decisions occur before the registered tool body.

## Coverage boundary

The plugin covers calls dispatched through the Harness tool registry, including Bash, PowerShell, filesystem tools, and Code Mode nested tool calls. It cannot mediate a package installation's lifecycle scripts before the plugin is loaded, arbitrary filesystem access performed inside this plugin's own process, another plugin that writes directly with Node APIs instead of dispatching a tool, a compromised Harness/runtime, or commands executed outside Harness. It is a policy layer, not an operating-system sandbox. Keep the official sandbox enabled; high privilege increases the consequence of every missed or bypassed path.

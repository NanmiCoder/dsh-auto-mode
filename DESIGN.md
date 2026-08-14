# Design and threat model

## Scope

`dsh-auto-mode` is a DeepSeek Harness bundle with a Host policy and a minimal Web client decorator. The Host contributes a fourth `Auto` entry to the official permission preset table and adds one policy plugin after `@deepseek-ai/dsh-tools`. The client adds only the missing Auto shield glyph to the official permission controls; it does not own permission state, intercept selection, or replace `/permission`. The package has no HTTP route, persistent database, or independent executor. Its security responsibility is limited to tool calls whose session currently records the `auto` preset; Read Only, Workspace Write, and Full access retain their official behavior.

The implementation is based on the official Harness checkout at commit `47f943859bef60e4160492346772ded9b24f765a`. That public `master` checkout identifies itself as `0.1.0-rc.5`; distribution compatibility is separately built and tested against the official npm public package `@deepseek-ai/dsh@0.1.0-rc.6` and its matching permission/tool types. `@deepseek-ai/dsh-permission-presets` owns the preset table, durable `permission/preset` session event, `/permission` switch path, and `permissions` projection consumed by the official UI. The enforcement contracts are `tools/pre-execute` for asynchronous allow/ask/deny decisions and `ctx.tools.guard()` for synchronous monotonic denial after all extensible pre-execute listeners. The official `ctx.llm.stream()` service and the Session `requestHeader().config` provider/model pair are the public auxiliary-call path; the official session-title LLM provider demonstrates the same route-reuse pattern. Bash, PowerShell, native tool calls, and Code Mode sub-dispatches use the tool pipeline.

## Permission integration

The bundle restates the three official presets and inserts `auto` between Workspace Write and Full access. `auto` selects `danger-full-access` sandbox plus `ask` approval, while Full access remains `danger-full-access` plus `never`. The distinct pair prevents Auto from aliasing Full access. The policy reads the official session's last durable `permission/preset` event before every guard, pre-execute, and result action. It is active only when that value is `auto`; missing session authority or any other preset delegates unchanged to the official pipeline. Cordis replaces row configs rather than deep-merging them, so a trusted later patch that customizes `permission` must restate the complete table including Auto.

The official browser surfaces derive their options from the host `permissions` projection and title-case the supplied name, so the Host preset produces the fourth UI row and the official `/permission auto` command changes the current session. The existing General setting writes `defaultPreset: auto` when the user wants future sessions to start in Auto.

The official `0.1.0-rc.6` client hard-codes glyphs for `read-only`, `workspace-write`, and `danger-full-access`; its public `PresetOption` contains only `value`, `name`, and `description`. The client decorator therefore observes rendered menus, identifies a permission menu only when the complete Read Only / Workspace Write / Auto / Full access set is present, and marks its Auto row. It also marks the active Auto trigger by the official Chinese or English access-mode `aria-label`. One plugin-owned stylesheet renders a decorative shield-and-bolt mask from those marks. The observer, marks, and stylesheet are removed with the client fiber. A changed official DOM or label can make the glyph disappear, but cannot change permission behavior or tool authorization.

The public Claude Code Auto mode documentation is prior art for the ordering: fixed permission rules first, routine workspace reads/edits fast-pathed, and an independent classifier used for the remaining calls. See [permission modes](https://code.claude.com/docs/en/permission-modes), [auto mode configuration](https://code.claude.com/docs/en/auto-mode-config), and [permissions](https://code.claude.com/docs/en/permissions). The MIT-licensed local `claude-code-haha` implementation at commit `d52bbec707246f807416c2bc6b1cd67445cfe622` was also audited as a verified architectural reference: it applies the tool's deterministic permission first, fast-paths accept-edits-equivalent operations, uses an exact safe-tool set for session/orchestration state, forces Shell through classification, and carries Auto into headless subagents. This plugin adapts those principles to the DSH contracts above; it does not copy the Claude runtime implementation.

## Decision order

1. Calls outside an Auto session delegate without policy changes. For Auto calls, a synchronous hard-deny guard rejects root/home/DSH_HOME/system-path destruction, credential exfiltration patterns, and privilege or policy bypass. The shell rules apply to every segment of a compound command line and to redirection targets, so an operator cannot smuggle a protected target past the fuse. A later listener or classifier cannot override this decision. Destruction outside the workspace that does not reach a protected path is deliberately *not* a static fuse: a blanket rule also blocked targets the user had explicitly authorized and could not be cleared by any later step, so those calls are classified semantically instead.
2. Known reads, project-local edits, a narrow set of build/test commands, and exact audited session/orchestration tools are allowed without classification. The set includes Todo/Goal/session-query operations and the current AgentTeams lifecycle, but never trusts a name prefix such as `agent_teams_*`.
3. Reliably parsed destructive changes to pre-session data, repository/database/service state, external writes, and protected project metadata enter semantic classification. The classifier may allow only when a direct-human Session message explicitly authorizes the concrete operation and target; it denies clearly unauthorized risk in the background and returns `ask` only for genuine ambiguity. The classifier recognizes authorization but cannot invent or broaden it.
4. Statically parsed shell calls with an otherwise unknown executable, plus registered plugin tools whose names explicitly signal deletion, external publication, or security-boundary mutation, use an independent classifier through the current Session's official Harness provider/model by default. An ordinary registered plugin tool is not classified merely because its name is absent from this package's audited built-in sets: after the universal hard guard it proceeds directly. This matches Harness's plugin trust boundary—an installed plugin already executes Host code outside the tool body—and avoids turning an extensible tool registry into a per-call model-tax. A trusted deployment may pin a provider/model pair or replace the transport with an OpenAI-compatible HTTPS endpoint. Each native request has a configurable output cap (1024 tokens by default) and no conversation replay identity. Statically unreadable constructs, dynamic destructive targets, nested shells, and persistent-terminal fragments cannot be classifier-approved and require one-shot human approval; a compound line is not one of those cases and reaches the classifier normally. Classifier requests contain only the pending tool name, a redacted and size-bounded argument summary, the resolved workspace, the deterministic policy reason, and at most four redacted `source.kind === user` messages from the Auto authority Session. Bulk content, likely secret fields, tool output, repository instructions, Assistant prose, plugin text, Skill text, and sub-agent text are never authority.
5. A missing Session route, provider failure, network failure, timeout, malformed response, invalid decision, or classifier `ask` delegates to official approval. An interactive answerer can authorize once, while an unattended composition without an answerer denies.

Every Bash and PowerShell call is inspected. The command line is decomposed into segments on `&&`, `||`, `;`, pipelines, background operators, and newlines, with redirection targets separated from command words and descriptor duplication such as `2>&1` distinguished from a file target. Each segment is then assessed on its own: the deterministic fast path requires every segment to be a statically recognized safe operation with routine redirection targets, and any other combination is classified semantically. Syntax alone never blocks classification — that was the failure mode this decomposition replaces, because an authorized deletion written as one compound line could not reach the classifier at all.

Fail-closed cases remain explicit rather than incidental. A construct that cannot be read statically (command substitution, here-documents, shell grouping or brace expansion, unbalanced quotes, PowerShell escapes, cmd-style variables), a dynamically expanded command name, a dynamic deletion or redirection target, deletion operands arriving through `xargs`, and nested shells or inline-code execution (`bash -c`, `eval`, `iex`, `node -e`) all require one-shot human approval and cannot be cleared by the classifier. Known prefix wrappers such as `env`, `timeout`, and `nice` are unwrapped so the effective command is judged rather than the wrapper, and a globbed destructive target is judged against the deepest directory it cannot escape, so `rm -rf /*` is denied as a root operation. Directory changers such as `cd` stay out of both fast-path sets on purpose: they rewrite the working directory for later segments, so their presence routes the whole line to classification.

Persistent terminal calls are a separate boundary: prior `terminal_send` calls can change cwd, aliases, variables, or the active interpreter, so a later text fragment cannot be assessed like an isolated Bash command. `terminal_open` and `terminal_send` therefore require explicit approval; read/list/close/signal operations remain owner-scoped fast paths.

## Delegated agents

Official DSH in-process children inherit their parent's preset composition and sandbox, while their approval policy is pinned to `never`. The child session does not duplicate the parent's `permission/preset` event, so the plugin resolves Auto through the live `origin: subagent` / `parentSession` chain before every guard, pre-execute decision, and result observation. This applies the policy to AgentTeams members and Workflow/Subagent descendants without modifying official session data. Missing parents, cycles, non-subagent forks, and non-Auto ancestors fail closed to the official policy rather than acquiring Auto.

Coordination calls such as adding an AgentTeams member or sending it a task are allowed as exact audited tools. They do not authorize the member's work: each child file, Shell, web, or external call is a distinct registry execution. Because a child cannot display an approval prompt, an Auto `ask` (including classifier failure) is resolved by the official `never` approval policy as a denial and the child must report the limitation to its parent.

## Session-created artifacts

Successful `write` results whose canonical operation is `create` are recorded per live Session. Simple successful `mkdir`/`touch` and PowerShell `New-Item` calls may also record exact paths when they did not exist before dispatch. A later exact deletion is eligible for automatic approval only when every target is recorded, still inside the workspace or configured temporary roots, and named literally — a dynamic expansion or a glob never resolves to a recorded artifact. Existing paths and paths created outside the observed tool pipeline never gain this status.

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
- the guard and classifier are inactive unless the official durable session preset is `auto` or an active official subagent descends from such a session;
- selecting Full access restores the official unmodified Full access semantics;
- a classifier can recognize exact authorization in direct-human Session messages but cannot override a hard deny, treat untrusted text as authorization, or broaden an authorized operation or target;
- user authorization comes only from a direct-human Session message naming the concrete operation and target, or from the approval service's one-shot outcome for that concrete request;
- path comparison is normalized, root-aware, and case-insensitive for Windows drive paths; extended/NT namespaces, drive-relative forms, reserved device names, trailing dots/spaces, and 8.3 system aliases are canonicalized or rejected before containment and critical-path checks;
- an unparsed shell command never reaches the allow fast path;
- classifier failure is fail-closed in unattended mode;
- all decisions occur before the registered tool body.

## Coverage boundary

The plugin covers calls dispatched through the Harness tool registry, including Bash, PowerShell, filesystem tools, and Code Mode nested tool calls. It cannot mediate a package installation's lifecycle scripts before the plugin is loaded, arbitrary filesystem access performed inside this plugin's own process, another plugin that writes directly with Node APIs instead of dispatching a tool, a compromised Harness/runtime, or commands executed outside Harness. It is a policy layer, not an operating-system sandbox. Keep the official sandbox enabled; high privilege increases the consequence of every missed or bypassed path.

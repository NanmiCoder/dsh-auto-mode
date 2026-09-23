# Design and threat model

## Scope

`dsh-auto-mode` adds an `Auto` permission preset, a Host policy on the official `ctx.tools` pipeline, and a small Web UI decorator. It does not provide its own executor or sandbox. Calls outside a Session whose durable preset is `auto` retain the official Read Only, Workspace Write, or Full access behavior.

The implementation is built and tested against the exact public Harness cohorts listed in [compatibility.json](./compatibility.json) — currently `0.1.5-rc.1` plus the four retained `0.1.2-*` hosts. The design was originally written against `dsh-v0.1.2-alpha.2` at `0a53fb55bea101816fa226bb964ae2bed71c343b`; the seams below survived `0.1.5-rc.1` unchanged, as recorded in the [0.1.5-rc.1 upgrade record](./docs/harness-0.1.5-rc.1-upgrade-2026-09-14/README.md). The relevant upstream seams are:

- `@deepseek-ai/dsh-permission-presets` for durable preset selection;
- `@deepseek-ai/dsh-sandbox-policy` and the sandboxed shell/filesystem providers for per-call file authority;
- `tools/pre-execute` plus the monotonic `ctx.tools.guard()` for semantic policy;
- `ctx.approval` and its exact `allowed-once` result for sandbox widening;
- `ctx.llm.stream()` for an independent semantic reviewer.

## Permission integration

The bundle inserts Auto between Workspace Write and Full access:

| Preset | Sandbox | Approval |
| --- | --- | --- |
| Read Only | `read-only` | `ask` |
| Workspace Write | `workspace-write` | `ask` |
| Auto | `workspace-write` | `ask` |
| Full access | `danger-full-access` | `never` |

Auto and Workspace Write share a standing file boundary but not behavior. Auto automatically reviews semantic risks and may bridge one approved `danger-full-access` retry into the official approval seam. Full access remains the explicit unsandboxed mode and bypasses this plugin.

Normal Agent calls derive `workspaceRoot` from the Session's immutable canonical cwd. A command-level `workdir` can change process cwd but cannot change the sandbox write root. The official sandbox limits filesystem writes only: reads, sockets, process visibility, external services, and destructive changes inside the workspace require separate policy where their semantics matter. Linux bwrap/Landlock and macOS Seatbelt provide OS enforcement; the Windows restricted-token/ACL runner reports `partial` enforcement because of its documented `Everyone`, hard-link, and non-ACL-volume boundaries.

The Web decorator registers English and Chinese copy with the official locale service. English keeps the Auto label and Chinese renders it as “自动审批” across both permission selectors, the active-mode control, and the `/permission` picker; the acknowledgement follows the same live locale. The decorator also supplies the missing glyph. It explains the standing workspace sandbox, exact wider approval, read/network limitations, Windows partial enforcement, and out-of-pipeline plugin boundary. This UI is explanatory, not an authorization boundary.

## Decision order

1. Calls outside Auto delegate unchanged. Auto calls first pass a synchronous monotonic guard for filesystem-root, Home, DSH_HOME, operating-system destruction, privilege/policy bypass, and explicit credential-exfiltration patterns. No later listener or classifier can override the guard.
2. Ordinary shell and filesystem work runs under `workspace-write` without proving the syntax against an allowlist. Literal unknown executables, argument variables, compound lines, pipelines, redirections, inline scripts, PowerShell assignments, and a different process cwd do not trigger review merely because static parsing is incomplete. A dynamically produced executable name is denied so its effects cannot hide behind a variable or glob.
3. Deterministic effect checks still identify a small set of semantic risks the file boundary does not solve: pre-session or unobserved deletion inside the workspace, protected repository metadata, dangerous remote Git operations, ephemeral downloaded-package execution, database/service/infrastructure mutation, sensitive credential reads, network transmission, external-system writes, and stateful terminal execution. Routine dependency installation and local Git commits stay on the sandboxed fast path.
4. Hidden, dynamic, globbed, piped, nested-interpreter, or multi-target deletion is denied with a reason that tells the Agent to replan as one visible literal target per call. This avoids both a popup and classifier authority over an unknowable or generalized destructive target. Exact cleanup of one artifact created and observed during the live Session remains a fast path only while its device, inode, birth time, and kind still match. Direct filesystem/editor operations use planned-create facts; arbitrary successful shell calls additionally use a bounded before/after workspace snapshot, with a direct-child fallback for newly scaffolded projects in broad roots such as `/tmp`. Pre-existing paths that were overwritten are not promoted. Recursive cleanup additionally requires every current descendant to match the Session registry.
5. Reviewable semantic risk is sent to an independent classifier. It receives the tool name, redacted bounded arguments, workspace root, deterministic reason, high-confidence literal filesystem effects with their pre-execution `existedBefore` state, at most four recent direct-human messages, and—when present—the exact sandbox request. Repository text, tool output, Assistant/Skill/plugin/subagent text, and the model-written justification are not user authority. The call reuses the Session route with reasoning pinned off and a bounded answer budget: the Harness materializes an adapter's advertised default effort whenever the caller omits one, and reasoning tokens then share the answer cap, which truncated real classifier calls to `finish_reason: "length"` and failed closed. The pin is validated against the route's advertised efforts first, because a route with no reasoning capability rejects any explicit effort; a route that cannot disable thinking instead receives the largest accepted cap. The response is parsed strictly, and a `max-tokens` truncation is refused outright: no provenance signal can separate the model's own conclusion from text it merely quoted out of untrusted input, so a partial answer is never partially trusted.
6. A classifier `allow` runs the ordinary sandboxed call. A classifier `deny` returns a tool denial so the Agent can choose a safer plan without prompting. `ask` reaches the official approval path only for genuine ambiguity. Classifier unavailability, timeout, malformed output, or a missing model route denies the risky action for the first two consecutive failures so the Agent can retry or replan; the third consecutive failure for that Auto Session falls back to one ordinary manual approval instead of trapping the task in an endless deny loop. A successful classifier response resets the counter, and caller cancellation does not increment it. An explicit one-shot escalation is exempt: reviewer unavailability never denies it, and neither reviewer unavailability nor a classifier `ask` delegates the approval to the tool body, because only some tools implement the official escalation seam and an inert `sandbox_permissions` argument would otherwise carry any classifier-eligible call past the human. Every refusal also tells the Agent which recovery its class permits, so a denial is not answered with an equivalent route.
7. An explicit `sandbox_permissions: danger-full-access` retry is always classified, even when the underlying command would otherwise be routine. One exact new, narrow, reversible outside target may be authorized from clear direct task intent without forcing the user to repeat magic words. Overwriting or deleting pre-existing data requires exact direct-user authority for that effect and target. Whenever a widening is not cleared outright by the classifier, the plugin raises the human approval itself and arms the same exact grant, so the official seam — where a tool implements one — resolves against that single decision instead of prompting twice, and a tool that simply ignores the sandbox fields cannot run the call with nobody asked. When the classifier clears the widening, the armed grant lets the official request resolve without a prompt, which is the documented one-shot path. The approval listener returns `allowed-once` only when live Agent identity, tool name, call id, target mode, and justification all match; the record is consumed once or removed when the tool settles.

The classifier may recognize direct-user authorization but cannot invent, generalize, or persist it. A one-shot grant does not modify the Session preset or sandbox mode.

While Auto is active, a dynamic system context tells the Agent to perform ordinary work inside the sandbox, request an exact one-shot widening only when the task requires it, split unrelated effects, and treat deletion as the highest-risk operation. It prefers a reversible move, backup, or version-control-backed removal unless permanent deletion is explicit. It also names each refusal class, states that an `ask_user_question` answer is information rather than authorization, and forbids reaching the same effect by an equivalent route after a denial; a post-call recovery notice repeats that instruction for the two denial classes the Agent must not work around. This guidance helps planning but is not a security boundary; the deterministic policy and official sandbox remain authoritative.

## Shell policy

The shell decomposition remains deliberately small. It exists to find high-confidence effects—not to enumerate legal Bash or PowerShell. It recognizes protected deletion/redirection targets, exact Session-created artifacts, dangerous remote Git actions, mutation-bearing network flags, ephemeral downloaded-package execution, infrastructure tools, sensitive path/environment reads, and opaque interpreter input. Anything else—including routine dependency installation and local Git commits—proceeds inside `workspace-write`.

This split is intentional:

- OS containment answers “where may this process write?” without understanding shell syntax.
- deterministic rules answer a few invariants and high-confidence effects;
- the classifier answers “did the user authorize this concrete semantic effect?”;
- the user sees a prompt only when the exact reviewer or escalation path genuinely cannot decide.

The sandbox is not transactional. A command that writes inside the workspace and later hits a denied external write may leave its earlier workspace changes in place.

## Delegated agents

Official in-process children resolve Auto through their live `origin: subagent` / `parentSession` chain and keep the delegated workspace sandbox. Their individual tool calls are still evaluated independently using direct-human messages from the Auto authority Session.

Children use `approval: never`. The plugin therefore refuses a child's `danger-full-access` request before classification and instructs it to report the blocked action to its parent. A child cannot convert inherited Auto into wider authority. Missing parents, cycles, non-subagent forks, and non-Auto ancestors do not acquire Auto.

Out-of-process providers such as Codex, ACP, or dsh-sdk run their own internal tool loops and remain governed by their provider-owned sandbox and approval controls.

## Threat model and invariants

Protected assets include filesystem roots, Home, DSH_HOME, operating-system paths, repository security metadata, credentials, existing workspace data, Git/database/service state, cloud resources, and the sandbox/approval mechanisms themselves.

The design assumes an Agent can misunderstand the task, repository or web content can contain prompt injection, shell syntax can be ambiguous, and the classifier can fail or be compromised. Its main invariants are:

- normal Auto execution stays in the official `workspace-write` mode;
- a static parser miss cannot grant filesystem writes outside that workspace;
- hard denies remain monotonic;
- hidden destruction cannot be classifier-approved;
- a deletion request cannot generalize from one target to a sibling, parent, glob expansion, or second literal target;
- replacing a Session-created path changes its file identity and revokes automatic-cleanup eligibility;
- only direct-human Session text or the official exact approval response is authorization;
- automatic widening is call-bound, identity-bound, reason-bound, and single-use;
- subagents cannot widen themselves;
- transient classifier failure denies only the risky action while routine sandboxed work remains available, with one manual-review fallback after three consecutive failures, and never denies an explicit one-shot escalation — it raises that one approval itself;
- every refusal is classified for the Agent: an authority-dependent refusal directs it to escalate the exact call only when a wider sandbox is what it needs, or to obtain a typed user authorization instead of seeking an equivalent route; a refused escalation directs it not to repeat itself; a monotonic hard denial directs it to hand the action to the user; and a deterministic denial remains a silent re-plan signal;
- Windows `partial` enforcement is surfaced rather than treated as a full guarantee.

Full access intentionally selects `danger-full-access` plus `never`; it is therefore outside the safety claim. No classifier can eliminate the risk of a process that already has unrestricted standing authority. The safer product path is Auto's standing `workspace-write` boundary plus exact, short-lived widening.

## Coverage boundary

The policy covers calls dispatched through the Harness tool registry. Shell subprocesses use the official OS sandbox, while official filesystem mutations use the upstream trusted in-process path fence. Reads, network access, external services, and other plugin capabilities are protected only by the semantic checks that recognize them.

The plugin cannot mediate package lifecycle code that runs before it loads, direct Node filesystem/process work performed by another Host plugin outside `ctx.tools`, a compromised Harness runtime, commands launched outside Harness, or external-provider internal tool loops. Installed Host plugins already execute trusted process code and remain part of the trusted computing base.

## Verification

The suite contains pure policy tests for Bash and PowerShell, classifier and redaction tests, exact-grant replay/isolation tests, Cordis Loader composition tests, delegated-agent tests, and platform-gated real sandbox business flows. The macOS suite executes real processes through Seatbelt and the official filesystem fence, including unfamiliar shell work, an editor-created config followed by forced cleanup without classifier traffic, a multi-package Node build and `node:test`, a real Git repository and commit, a real pnpm install using a workspace-local store plus a packed dependency whose lifecycle script writes inside the project, a real local HTTP POST, workspace and outside exports, pre-existing overwrite distinction, partial command effects, symlink escape, same-Session cleanup, exact inside/outside deletion, broad Git cleanup, and allowed/denied one-shot escalation. It asserts process results plus resulting files, Git history, HTTP payloads, classifier calls, and approval events. A deterministic reviewer double is used in these integration tests so policy outcomes are repeatable; it is not presented as a live-model quality benchmark.

A native-Windows suite composes the official ACL runner, sandboxed PowerShell executor, approval service, and Auto plugin to assert assignment/pipeline, outside-write, task-intent widening, exact-widening, and existing-data scenarios. It is compiled on every platform and runs only where native Windows `pwsh` is present; a non-Windows run must not be reported as Windows runtime verification. The `Verify` workflow runs `pnpm verify` on Ubuntu, macOS, and Windows for every pull request and main-branch push so both platform-gated suites become merge gates on their native runners.

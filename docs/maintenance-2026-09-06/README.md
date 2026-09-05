# Auto Mode 0.1.7 maintenance

The baseline was `a53af05` / plugin `0.1.6`, built against Harness `0.1.2-alpha.2`. Its original verification passed 98 tests on macOS (five Windows tests skipped), yet a real RC.1 user turn failed when Auto tried to read the removed `session.events` API. Passing unit tests did not establish host compatibility.

## Compatibility contracts

`permissionPresets.current(events)` on `0.1.1-rc.2` changed to `current(session)` by `0.1.2-alpha.2`. The old RC method was reproduced directly from the published package with the reported `events is not iterable` error. Modern Session storage removed the public event array by Alpha.4. The plugin now reads the exclusive `seq`/`eventAt` interface first, with a legacy event-array fallback. Only direct user messages supply authority, including through a live parent Session; plugin, repository, tool, and subagent prose cannot grant permission.

`compatibility.json` lists exactly RC.1, Alpha.5, Alpha.3 and Alpha.2. Each runtime uses a complete, exact DSH cohort instead of a caret range that silently mixes releases. A startup guard checks directly resolved peers; `scripts/harness-doctor.mjs` separately audits the full installed dependency graph, nested duplicates, profile resolution, shared identities and all packaged bytes. Neither a directory name nor a broad peer range establishes support.

Harness `0.1.1-rc.2` is outside the supported boundary. Historical plugin `0.1.5` remains its prior pairing, including the old redundant-argument limitation. Upgrade the host and plugin together to a supported pair for the recovery fix; `0.1.6`/`0.1.7` must not be installed into the old RC host. An actionable startup error replaces the delayed permission-hook crash.

## Reproductions and contribution decisions

| Item | Reproduction | Resolution |
| --- | --- | --- |
| [#13](https://github.com/NanmiCoder/dsh-auto-mode/issues/13) | Published old-RC permission method rejects a Session object; baseline 0.1.6 also fails on a real RC.1 tool turn due to removed event storage | Exact support boundary, early diagnostic, modern Session reader; no old-RC backport claim |
| [#10](https://github.com/NanmiCoder/dsh-auto-mode/issues/10) | RC.1 Chinese menu shows `Auto` without the custom icon while the input control is translated | Recognize the new upstream Chinese menu label, preserve icons and the risk acknowledgement gate |
| [#8](https://github.com/NanmiCoder/dsh-auto-mode/issues/8), [#11](https://github.com/NanmiCoder/dsh-auto-mode/pull/11) | Redundant `workspace-write` is rejected without useful recovery; contract regression and real model attempt reproduced | Adopt LonelyHerbivore's recovery idea on supported hosts: reject before side effects, add a plugin notice and detach sandbox fields for one subsequent tool-schema assembly; preserve canonical schemas and standing permission |
| [#12](https://github.com/NanmiCoder/dsh-auto-mode/issues/12) | Guidance does not clearly explain omitted sandbox fields or untrusted sources of authority | Add the boundary guidance before ordinary tool execution |
| [#7](https://github.com/NanmiCoder/dsh-auto-mode/issues/7) | Unbuilt Git source lacks `lib/index.js` and `lib/client.js`; an unbuilt install reproduces missing-entry failure | `prepare` builds Git installations without requiring global pnpm; independently verify Git consumer and prebuilt tarball consumer. The third-party hub's own removal service is not modified |
| [#6](https://github.com/NanmiCoder/dsh-auto-mode/pull/6) | AWS/GitHub/PEM secrets survive prior redaction; encoded credential URL and critical patch targets escape coverage | Adopt AtropinolTT's credential and path coverage ideas while retaining bulk redaction; inspect both patch payloads, rename sources and destinations; third-party patch executors require manual approval because their sandbox contract is unverified |
| [#4](https://github.com/NanmiCoder/dsh-auto-mode/pull/4) | Synthetic secrets confirm the sanitizer gap | Resolve the sanitizer concern through #6. Retain the existing maintainer decision against content-based write restrictions; `.env` editing remains governed by sandbox/effect policy |
| [#3](https://github.com/NanmiCoder/dsh-auto-mode/pull/3) | `$x = 5` falsely denies; original PR also incorrectly allows a bare or partially quoted command RHS | Adopt joejojoking-cloud's assignment direction with full-token literal checks, recursive RHS assessment and hard-deny traversal. Exclude authorization caching (stale filesystem/authority) and blanket retries (retries permanent errors) |

Third-party `apply_patch` stays manual even when sandbox escalation fields are supplied. Ambiguous payloads cannot conceal a critical target. Classifier-visible filesystem facts that require redaction or truncation stay local for manual approval instead of transmitting an incomplete target. Independent adversarial probes found these issues, reproduced them, and verified the corrections before release.

## Validation and release process

The versioned [release candidate attestation](https://github.com/NanmiCoder/dsh-auto-mode/blob/main/release-candidate.json) records the final artifact hash and real API acceptance. [The validation report](https://github.com/NanmiCoder/dsh-auto-mode/blob/main/VALIDATION.md) records actual outcomes, including skipped or non-exercised attempts. Local raw traces and credentials are excluded from source and npm artifacts.

The deterministic product fixture launches the official Harness CLI, composes the packaged plugin, and checks actual service identities in that process. It checks file effects, redundant recovery, exact one-shot approval, hard denial, classifier failure downgrade, and delegated authority. Its model adapter is a **fixture**, not a real API. CI runs the fixture against every exact declared host and verifies source tests on Linux, macOS and Windows.

Real API acceptance separately loads the configured DeepSeek provider in Harness and uses only the existing `/tmp` workspace. It verifies native editor changes, authorized deletion via the independent classifier, real denial decisions, PowerShell output, and Web state. A model that immediately emits a correct fieldless call has not exercised the redundant-error branch; acceptance records that distinction and uses bounded attempts. macOS needs the official PowerShell provider/tool explicitly enabled for that test; it is not a native Windows sandbox acceptance claim.

From a checkout, reproduce the package test with Node 24:

```sh
pnpm install --frozen-lockfile
pnpm verify
node scripts/verify-maintenance.mjs
node --test scripts/harness-doctor.test.mjs
npm pack --ignore-scripts --pack-destination /tmp
node scripts/harness-runtime-verify.mjs --host-version 0.1.2-rc.1 --artifact /tmp/nanmicoder-dsh-auto-mode-0.1.7.tgz --out /tmp/auto-product-proof
```

Reuse an already prepared exact runtime with `--runtime /path/to/runtime`. Real API tests are opt-in and read the user's existing DSH settings in memory (override the settings directory with `AUTO_REAL_DSH_HOME`); output goes to a new **evidence directory**, while every agent's working directory remains `/tmp`:

```sh
node scripts/acceptance/run-real-api.mjs /path/to/runtime /tmp/nanmicoder-dsh-auto-mode-0.1.7.tgz /tmp/auto-real-proof headless scripts/acceptance/real-api-driver.mjs
```

The release workflow packs once, runs the full host matrix against that tarball, compares it to the locally accepted hash, then publishes the same file through npm trusted publishing. Stable plugin versions use `latest`, prereleases use `next`; stable downgrade and tag/version mismatch fail closed. Published versions and tags are immutable. Roll back by installing a previously verified exact host/plugin pair.

## Skills provenance

Seven unchanged skills are vendored from [oh-my-dsh/dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/cd4d497588cdd4f16300622779b62a78fe803169), with MIT attribution and hashes in `skills/upstream-lock.json`: workflow, upgrade, upgrade audit, runtime debug, test, release, and implementation. The workflow follows the reviewed [AgentTeams #130](https://github.com/NanmiCoder/dsh-agent-teams/pull/130) process. Project rules explicitly supersede outdated broad-version and rollback examples.

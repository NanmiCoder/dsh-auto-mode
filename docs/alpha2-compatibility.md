# Harness Alpha compatibility

Implementation baseline: DeepSeek Harness `0.1.2-alpha.2`
(`dsh-v0.1.2-alpha.2`, `0a53fb55bea101816fa226bb964ae2bed71c343b`).
The same packaged candidate was also installed and exercised on the current
public Alpha package, `0.1.2-alpha.3`, on 2026-09-01.

Published dsh-auto-mode `0.1.5` belongs to the older Harness RC API line. It is
the tested plugin for Harness `0.1.1-rc.2`, but on both Alpha.2 and Alpha.3 its
host entry fails before Web startup because
`@deepseek-ai/dsh-permission-presets` no longer exports
`effectivePermissionPreset`.

## Migration ledger

| Touchpoint | Alpha migration |
| --- | --- |
| Permission state | Read the host's projection through `ctx.permissionPresets.current(session)`; do not refold the event array inside this plugin. This preserves composition defaults, seeded state and shared-bundle tie behavior owned by Harness. |
| Cordis assembly | Declare `permissionPresets` as a required service alongside `tools` and `llm`, so Auto activates only after the official permission projection service is ready. |
| Tool and approval seams | Compile and exercise pre-execute decisions, result settlement and one-shot `approval/request` handling against the exact Alpha.2 packages. |
| Sandbox composition | Exercise the official macOS workspace sandbox for routine writes, hard denies, authorized one-shot wider writes and artifact cleanup. Windows remains an automated policy/composition check unless separately stated. |
| Client | Compile and cold-load the localized Web client against the Alpha.2 locale service; verify Auto selection, acknowledgement and live locale behavior in the actual browser UI. Re-run the packaged Web client and a real Auto task on Alpha.3. |
| Loader/package | Pin every DSH development package to Alpha.2, regenerate the lockfile, build the published artifact, install it through both Alpha.2 and Alpha.3 CLIs and cold-start their real Web entries. |
| Model path | Exercise the native DSH classifier with a real configured provider and validate its decision through actual business tool calls, not only mock responses. |

## Version boundary

| Harness host | Supported plugin line | Evidence |
| --- | --- | --- |
| `0.1.1-rc.2` | `@nanmicoder/dsh-auto-mode@0.1.5` | Exact public install, Web cold start and real Headless Auto flow passed. |
| `0.1.2-alpha.2` | Next release from `main` | Packaged Web/Headless install, real API, native macOS sandbox and human-style Web UI passed. |
| `0.1.2-alpha.3` | Next release from `main` | Packaged Web/Headless install, real API, Auto tool execution, human-style Web UI and reload persistence passed. |

The next release declares the Alpha peer range beginning at
`^0.1.2-alpha.2`. Users retaining Harness `0.1.1-rc.2` should retain the exact
published plugin `0.1.5`; installing the plugin's `latest` is reserved for the
Alpha host line after the compatible release is published. Updating this
repository or the plugin package does not update a separately installed or
embedded Harness host.

No public npm package for `0.1.2-alpha.1` was available during this acceptance
run. The [acceptance report](./alpha2-acceptance.md) records the exact systems,
provider, browser and host/plugin pairs tested. It is not a compatibility claim
for Alpha.1, versions after Alpha.3, Windows Desktop, every browser or every
model provider.

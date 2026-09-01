# Harness Alpha.2 compatibility

Target: DeepSeek Harness `0.1.2-alpha.2` (`dsh-v0.1.2-alpha.2`,
`0a53fb55bea101816fa226bb964ae2bed71c343b`).

Published dsh-auto-mode `0.1.5` targets Harness `0.1.0-rc.6`. On Alpha.2,
its host entry fails before Web startup because
`@deepseek-ai/dsh-permission-presets` no longer exports
`effectivePermissionPreset`.

## Migration ledger

| Touchpoint | Alpha.2 migration |
| --- | --- |
| Permission state | Read the host's projection through `ctx.permissionPresets.current(session)`; do not refold the event array inside this plugin. This preserves composition defaults, seeded state and shared-bundle tie behavior owned by Harness. |
| Cordis assembly | Declare `permissionPresets` as a required service alongside `tools` and `llm`, so Auto activates only after the official permission projection service is ready. |
| Tool and approval seams | Compile and exercise pre-execute decisions, result settlement and one-shot `approval/request` handling against the exact Alpha.2 packages. |
| Sandbox composition | Exercise the official macOS workspace sandbox for routine writes, hard denies, authorized one-shot wider writes and artifact cleanup. Windows remains an automated policy/composition check unless separately stated. |
| Client | Compile and cold-load the localized Web client against the Alpha.2 locale service; verify Auto selection, acknowledgement and live locale behavior in the actual browser UI. |
| Loader/package | Pin every DSH development package to Alpha.2, regenerate the lockfile, build the published artifact, install it through the Alpha.2 CLI and cold-start the real Web entry. |
| Model path | Exercise the native DSH classifier with a real configured provider and validate its decision through an actual business tool call, not only a mock response. |

## Version boundary

The next release from this branch targets Alpha.2 and has no adapter for the
old RC permission API. Users retaining Harness `0.1.0-rc.6` must retain the
published plugin `0.1.5`. Other old checkouts must keep their own known-working
exact plugin version. Updating this repository or installing a newer plugin
does not update a separately installed or embedded Harness host.

The [acceptance report](./alpha2-acceptance.md) records the exact systems,
provider, browser and operating systems actually tested. It must not be read as
a compatibility claim for Alpha.1, Alpha.3, Windows Desktop, future Harness
versions or every model provider.

# Harness Alpha acceptance report

Date: 2026-09-01.

Implementation target: DeepSeek Harness `0.1.2-alpha.2`
(`dsh-v0.1.2-alpha.2`, `0a53fb55bea101816fa226bb964ae2bed71c343b`).
Regression hosts: the public `0.1.1-rc.2` release and the current public Alpha
package, `0.1.2-alpha.3`.

The public dsh-auto-mode `0.1.5` package was used as the old-host control and
the failing Alpha baseline. The runtime candidate used for the full business
flows was packed from commit `dcc2736` with SHA-256
`559479901e7aa13dd9575a523c44c32ec12397da7e87b7152c24f9229b492085`.
After the documentation correction, the package was rebuilt and installed into
fresh Alpha.2 and Alpha.3 Web and Headless profiles. Both final installs had
identical runtime entry hashes: host
`f7d38a522112392c03e9facb2e76ea24f57082e70e0a3f221d2e123b3dfeb6e5` and client
`f87cb0f04e81bf8ba92973d1b1e5ad92fab48542134c49114390a59a12eacabb`.

## Environment

- macOS 26.5.2 (25F84), including the Apple seatbelt workspace sandbox.
- Node.js 26.7.0 and pnpm 10.33.0 for profile installation.
- Chromium 150 through Ego Browser, 1510 × 963 viewport.
- Real Harness route `deepseek-official/deepseek-v4-flash`.
- Exact Harness `0.1.1-rc.2` and `0.1.2-alpha.3` runtimes freshly installed
  from the official npm registry; an existing exact `0.1.2-alpha.2` runtime was
  reused after its version was verified.
- Every fresh profile, session, npm artifact, fixture and business artifact
  lived under `/tmp`. No file picker or additional workspace was used, the
  developer's normal DSH profiles were not modified, and no business operation
  targeted the source repository.
- Real credentials were copied only for the live calls, never printed, and
  replaced with a 0600 placeholder after each run.

## Host and plugin matrix

| Harness host | dsh-auto-mode | Install and startup | Real use |
| --- | --- | --- | --- |
| `0.1.1-rc.2` | public `0.1.5`, exact pin | Web and Headless profile installs passed; Web cold-started. | A real Auto session recorded `permission/preset: auto`, deleted the exact named fixture and created validated JSON through two Bash calls. |
| `0.1.2-alpha.2` | public `0.1.5` | Install passed; Web failed before startup with the reported missing `effectivePermissionPreset` export. | Blocked by the loader failure, as expected. |
| `0.1.2-alpha.2` | packaged candidate | Web and Headless installs and Web cold start passed. | Real API, native macOS sandbox and human-style Web UI passed. |
| `0.1.2-alpha.3` | public `0.1.5` | Install passed; Web failed with the same missing export. | Blocked by the loader failure, as expected. |
| `0.1.2-alpha.3` | packaged candidate | Web and Headless installs and Web cold start passed. | Real Headless and Web UI Auto sessions each executed two Bash calls and produced independently validated effects; reload preserved the mode and conversation. |

## Results

1. **The reported failure was reproduced on both Alpha hosts.** The public
   plugin `0.1.5` made `dsh web` exit because
   `@deepseek-ai/dsh-permission-presets` no longer provides
   `effectivePermissionPreset`.
2. **The automated contract passed.** `pnpm verify` completed type checking,
   host and client builds, 98 tests across 13 passing files, and the npm
   package-contract check. Five native Windows cases were skipped on macOS as
   designed.
3. **Packaged Alpha installs passed.** The candidate tarball was installed with
   the real Alpha.2 and Alpha.3 CLIs into clean Web and Headless profiles. Their
   composed configs contained Auto and their Web entries cold-started without
   the baseline import failure.
4. **Real Headless business flows passed.** Alpha.2, Alpha.3 and the supported
   RC control each durably selected `permission/preset: auto`. Using the real
   DeepSeek route, each relevant run deleted one exact pre-existing `/tmp`
   fixture, created the requested JSON artifact and verified both effects. The
   event logs record the Auto preset, Bash calls and successful results.
5. **Real Web UI flows passed.** Alpha.2 was exercised by selecting Auto,
   acknowledging its risk notice and completing a two-tool real model turn.
   Alpha.3 loaded the `/tmp` session with **自动审批** active, sent another real
   task through the visible composer, completed two Bash calls without an
   approval interruption and displayed the exact resulting JSON. A browser
   refresh retained the Alpha.3 conversation, result and Auto state.
6. **Client compatibility passed.** On Alpha.2, the live page contained the
   plugin-owned icon marker and switched the active label from `自动审批` to
   `Auto` without a reload. Alpha.3 rendered the localized Auto control and
   retained it through the real task and refresh.

## Boundary

This report establishes the listed host/plugin pairs on macOS and Chromium. A
negative-check install of the candidate also cold-started on `0.1.1-rc.2`, but
that host is outside the candidate's declared Alpha peer range and did not
replace the supported old-host test with plugin `0.1.5`. It does not claim
native Windows execution, Alpha.1, versions after Alpha.3, other browsers or
every model provider. Windows policy and composition cases remain in the
automated suite and require a Windows runner for native ACL acceptance.

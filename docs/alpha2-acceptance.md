# Harness Alpha.2 acceptance report

Date: 2026-09-01.

Target: DeepSeek Harness `0.1.2-alpha.2` (`dsh-v0.1.2-alpha.2`,
`0a53fb55bea101816fa226bb964ae2bed71c343b`). The published plugin `0.1.5`
was used only as the failing baseline; the candidate was built from this branch.

## Environment

- macOS 26.5.2 (25F84), Apple seatbelt workspace sandbox.
- Node.js 26.7.0 and pnpm 10.33.0.
- Chromium 150 through Ego Browser, 1510 × 963 viewport.
- Real Harness route `deepseek-official/deepseek-v4-flash`, thinking disabled.
- The test reused an existing exact Alpha.2 CLI. Every fresh profile, session,
  package artifact, fixture and business artifact lived under `/tmp`; the
  developer's normal DSH profiles were not modified, and no real business
  operation targeted the source repository.

## Results

1. **Baseline reproduced.** Installing the public `@nanmicoder/dsh-auto-mode@0.1.5`
   through the real Alpha.2 CLI made `dsh web` exit with the reported error:
   `@deepseek-ai/dsh-permission-presets` no longer exports
   `effectivePermissionPreset`.
2. **Automated contract passed.** `pnpm verify` completed type checking, host and
   client builds, 98 tests across 13 passing files, and the npm package-contract
   check. Five native Windows cases were skipped on macOS as designed.
3. **Packaged host install passed.** The generated npm tarball was installed into
   clean Web and Headless profiles using `dsh plugin`. Both composed configs
   contained the Auto preset and the packaged host entry cold-started without
   the baseline import failure.
4. **Real API business flow passed.** A fresh Headless session durably selected
   `permission/preset: auto`. Using the real DeepSeek route, it deleted one exact
   pre-existing `/tmp` fixture explicitly named by the user, created the required
   JSON business artifact, and verified both effects. This exercises the native
   DSH classifier path because pre-existing deletion is classifier-eligible and
   fails closed when that classifier is unavailable.
5. **Real Web UI flow passed.** A human-style browser run opened the actual
   Alpha.2 Web client with `/tmp` as its workspace, found the localized Auto row,
   completed the risk acknowledgement, and showed Auto as the active mode. A
   real model turn made two Bash calls to delete the exact fixture and create and
   validate the requested JSON. No manual approval dialog appeared. Reloading
   preserved both the Auto preset and the completed conversation.
6. **Client compatibility passed.** The live page contained the plugin-owned
   icon stylesheet and trigger marker. Switching the UI from Chinese to English
   updated the active label from `自动审批` to `Auto` without a reload.

## Boundary

This report establishes the tested Alpha.2 combination on macOS and Chromium.
It does not claim native Windows execution, Alpha.1, Alpha.3, future Harness
versions, other browsers, or every model provider. Windows policy and
composition cases remain in the automated suite and require a Windows runner
for native ACL acceptance.

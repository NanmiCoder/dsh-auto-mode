Auto Mode 0.1.7 supports the exact Harness cohort `0.1.2-rc.1`, `0.1.2-alpha.5`, `0.1.2-alpha.3`, and `0.1.2-alpha.2`. Use `dsh --version` to check the running host before upgrading the plugin. Harness `0.1.1-rc.2` must migrate to a supported pair; this release does not backport the old host API.

- Read modern Session events through `seq`/`eventAt`, retain the Alpha event-array fallback, and fail early on old or mixed peer versions instead of crashing during a user turn (#13).
- Restore translated Auto labels and icons in current Chinese permission menus (#10).
- Explain permission boundaries before tool use and recover from redundant `workspace-write` arguments without changing standing authority (#8, #12; adapted from #11).
- Build Git installs through `prepare`, while registry packages retain prebuilt server and browser entries (#7).
- Expand classifier secret redaction and encoded URL credential detection; conservatively inspect patch paths and keep third-party patch execution behind manual approval (#6, sanitizer concern in #4).
- Allow literal PowerShell assignments and recursively review command-valued assignments; preserve dynamic execution and critical deletion guards (selected correction from #3).
- Vendor seven pinned community maintenance skills; verify exact host cohorts, diagnose profile/artifact identity, and publish only the tarball verified by the full CI matrix.

Contribution decisions and reproduction/verification details are in [the maintenance record](https://github.com/NanmiCoder/dsh-auto-mode/blob/main/docs/maintenance-2026-09-06/README.md). PR #3's authorization cache and blanket retry, PR #4's content-based write restriction, and PR #6's broad patch auto-approval are intentionally not included.

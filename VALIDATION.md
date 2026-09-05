# 0.1.7 pre-commit acceptance

Production and real API acceptance completed before committing the implementation. Diagnostic and CI fixes were separately reproduced and verified before their commits; the final fixture results below include those fixes. The npm candidate was built with Node **24.20.0** and npm **11.19.0**. Its SHA-256 is:

`5fb401e32d5cc362d396d4998ae7dd9afb12641ebf5c91eb65c5cef610751173`

## Automated and product checks

- `pnpm verify`: **190 passed**, five Windows-only tests skipped on macOS; typecheck, server/client build and package contract passed.
- Maintenance contract: four exact host versions and 99 unchanged upstream skill files verified.
- Doctor: **7 tests passed**, including mixed versions, duplicate identities, nested copies, modified module bytes, extra modules, profile metadata and Windows tar CRLF output.
- Official CLI product fixture: **22 assertions per host**, with all 69 packaged files matched against the same tarball. Alpha.2/Alpha.3 cohorts contain 215 DSH packages; Alpha.5/RC.1 contain 214. Runtime services and actual Session objects share the expected module identity. The model in this suite is explicitly a deterministic fixture.
- Git source installation without `lib` successfully ran `prepare`, built both entries, and installed; a clean tarball consumer installed prebuilt entries without a build. The unbuilt control reproduced missing-entry failure.
- Release metadata probes: 13 passed. Artifact gate probes: 6 passed. Actions syntax validated with actionlint.

[Product fixture evidence](validation/0.1.7/fixture.json)

## Real API in Harness

Every run used the configured real `deepseek-official / deepseek-v4-flash` provider, through the actual Harness process. Agent working directories used the existing `/tmp` path (macOS resolves it to `/private/tmp`); no workspace picker is required. Test evidence uses separate directories underneath `/tmp`.

| Exact host / composition | Requests | Result |
| --- | ---: | --- |
| `0.1.2-alpha.2`, headless | 18 | Passed |
| `0.1.2-alpha.3`, headless | 17 | Passed |
| `0.1.2-alpha.5`, headless | 20 | Passed |
| `0.1.2-rc.1`, headless | 18 | Passed |
| `0.1.2-rc.1`, official PowerShell provider/tool on macOS | 3 | Passed; stdout `5`, exitCode `0`, workspace-write enforcement |
| `0.1.2-rc.1`, Web | 5 | Passed; exact authorized deletion through the real classifier, target removed, UI state retained after reload |

The four headless runs checked native editor create/replace/view against actual bytes, deletion of an explicitly authorized pre-existing test file, classifier refusal of unauthorized deletion and injected argument authority, and an untouched sibling sentinel. **All four versions actually exercised a real model's redundant sandbox request, rejection and successful fieldless retry.** A bounded attempt that emitted correct parameters immediately was recorded as not exercising that branch, rather than counted as recovery proof.

PowerShell is not enabled in the default macOS composition, so its test explicitly loaded the official provider and tool. The initial composition-missing attempt was a failed test setup and was not counted as acceptance. Earlier control/model attempts that failed or did not exercise a target branch are likewise excluded from the final table.

Web checks also covered Chinese/English menu, input and settings labels/icons, cancellation of the risk acknowledgement, explicit acknowledgement, and reload persistence. Those additional UI checks used the byte-identical client bundle; the final full candidate separately passed the Web API deletion and reload checks. [Real API evidence](validation/0.1.7/real-api.json) · [Web evidence](validation/0.1.7/web.json)

## Adversarial review and boundaries

Three independent agents reviewed host contracts, contribution/security policy and release behavior. Every reported regression introduced or addressed by this change was corrected and independently rechecked. The last review ran 121 targeted tests and recompiled the latest source into an independent snapshot. Real PowerShell probes used harmless marker commands to prove the dynamic interpreter parameter variants before checking their rejection. This report does not equate local model decisions with a proof that all future model outputs are safe.

This remains the project's bounded, sandbox-first policy. Existing grouped/substitution opaque fallback behavior is unchanged: ordinary opaque code may run inside the write sandbox. Parsed dynamic interpreter/assignment tests do not prove the semantics of every possible shell expression. The write sandbox does not constrain all reads or network effects. Third-party patch executors remain manual because no official sandbox contract was verified for them.

The old Harness `0.1.1-rc.2` permission API was reproduced at published-method level, not as a full Windows UI run. That host is not supported by 0.1.7; migration is explicit. Native Windows real API/ACL acceptance was not performed on this macOS machine. Windows tests run in the required CI matrix, separately from these local real API results.

Raw logs and credentials remain outside Git and npm. The committed JSON contains sanitized summaries only. CI must independently pass Linux/macOS/Windows tests and the exact four-host fixture matrix, and the publish job must compare its tarball against [release-candidate.json](release-candidate.json) before publishing that same file. Stable version downgrade and tag/version mismatch are rejected.

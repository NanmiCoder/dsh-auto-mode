# Spec: Sanitizer Redesign + `apply_patch` Coverage + `web_fetch` URL Hardening

- **Date**: 2026-08-17
- **Local reference**: `feat/credential-write-guard-v3` later; this spec governs sandbox-first hardening on the upstream `nanmicoder/dsh-auto-mode` HEAD at the time of writing (`007c316`).
- **Upstream context**: PR #4 was declined on `str_replace_editor` field sanitization. The maintainer committed to a "more general sanitizer" fix and acknowledged the real gap. This spec implements that sanitizer redesign plus two adjacent items the maintainer is structurally positioned to accept.
- **Constraints (locked with user)**:
  - Diff as small as possible.
  - No new files; all source changes stay in `src/classifier.ts`, `src/policy.ts`, `src/paths.ts`.
  - No public API breakage at the export level (function signatures). Internal redaction marker strings may change.
  - No new write-side content blocker (must not conflict with sandbox-first philosophy).

---

## Goals

1. **G1 — Sanitizer is content-first.** Every string value that crosses the classifier network boundary is sanitized by **pattern matching against known credential formats**, not by key-name whitelist. Fields whose key matches `SECRET_KEYS` keep a wholesale `[redacted-secret-field]` replacement as a defense-in-depth layer.
2. **G2 — Stricter credential pattern coverage.** The sanitizer catches AWS access keys (`AKIA|ASIA`), GitHub classic/user/server/OAuth/fine-grained PAT, Anthropic and OpenAI-style `sk-`/`sk-proj-`/`sk-ant-` keys, and PEM-encoded private-key blocks in addition to the existing inline patterns.
3. **G3 — `apply_patch` is fully policed.** Every file path that appears in an `apply_patch` payload (including `--- a/path`, `+++ b/path`, `/dev/null` new files, and multi-file patches) is resolved and routed through `hardDenyReason` and `assessTool`. A patch that targets a destructive or protected path is hard-denied or asked exactly like a `write`/`edit` would be. Unparseable patch text fails closed.
4. **G4 — `web_fetch` URL hardening.** The literal query string of a `web_fetch`/`curl`/`wget` URL is structurally inspected for credential-shaped parameter names (`token`, `access_token`, `api_key`, `sig`, `signature`, `auth`, ...) and credential-shaped values. Hits land in `hardDenyReason`.

---

## Non-Goals

- Adding write-side content-based blockers (e.g., blocking a `write` whose content contains `AKIA`). This was the original PR-A and the maintainer declined it. We do not introduce an `ask` path conditioned on file content.
- Closing symlink-escape (Critical-2 from the local review). This is a sandbox-policy item whose design conflicts with the sandbox-first direction and is left as future work in `9-investigation-backlog.md`.
- Hardening `web_fetch` for non-credential URL content (e.g., arbitrary PII). Out of scope.
- Replacing `CONTENT_KEYS` wholesale with field-aware granularity of unknown depth; only credential-redaction concerns belong to this spec.

---

## Section 1 — Sanitizer architecture (G1+G2)

### 1.1 New top-level constant

```ts
interface CredentialPattern {
  readonly name: string
  readonly pattern: RegExp
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // Inline value-shape patterns kept from the existing sanitizer.
  { name: 'token-suffix',      pattern: /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer',            pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi },
  { name: 'key-value',         pattern: /((?:api[_-]?key|token|secret|password)=)[^&\s]+/gi },

  // AWS access-key IDs (16 chars after the prefix).
  { name: 'aws-access-key',    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },

  // GitHub token formats (gho_ is 40; gh[pus]_ is 36; github_pat_ has 22+).
  { name: 'github-oauth',      pattern: /\bgho_[A-Za-z0-9]{40}\b/g },
  { name: 'github-classic',    pattern: /\bgh[pus]_[A-Za-z0-9]{36}\b/g },
  { name: 'github-fine-pat',   pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },

  // LLM and tool vendor keys.
  { name: 'llm-key',           pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  // Anthropic keys are `sk-ant-apiNN-<body>` where NN is exactly 2 digits
  // and <body> is 32+ base64url-ish chars. Anchoring `api\d{2}-` rejects
  // documentation/strings of the shape `sk-ant-<anything20plus>` and only
  // matches real Anthropic key prefixes per vendor docs.
  { name: 'anthropic-key',     pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{32,}\b/g },

  // PEM private-key blocks (RSA, OPENSSH, EC, ECDSA, DSA, ENCRYPTED).
  // Matches the BEGIN line through the next matching END line, inclusive.
  { name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |ECDSA |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |ECDSA |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
]
```

### 1.2 New function `redactClassifierText`

```ts
export interface ClassifierRedaction {
  readonly value: string
  readonly redactedNames: readonly string[]
}

export function redactClassifierText(value: string, maxLength = 1_000): ClassifierRedaction {
  let current = value
  const redactedNames: string[] = []
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    const before = current
    current = current.replace(pattern, `[redacted-${name}]`)
    if (current !== before && !redactedNames.includes(name)) redactedNames.push(name)
  }
  if (current.length > maxLength) current = current.slice(0, maxLength)
  return { value: current, redactedNames }
}
```

### 1.3 Redaction markers

- A match is replaced with the literal string `[redacted-<name>]`, where `<name>` is the constant from `CREDENTIAL_PATTERNS`. Example: `AKIAIOSFODNN7EXAMPLE` becomes `[redacted-aws-access-key]`.
- A PEM block is replaced entirely by `[redacted-pem-private-key]`. The full matched range (BEGIN…END inclusive) is removed.
- Multiple distinct pattern types in the same input each produce a marker; repeated occurrences of the same type produce a single marker but no count is shown to the classifier.
- The 1000-character outer truncation is preserved (matches the existing behavior).

### 1.4 Replacement for `sanitizeClassifierText`

The existing `sanitizeClassifierText(value: string): string` is reimplemented as a thin wrapper over `redactClassifierText`:

```ts
export function sanitizeClassifierText(value: string): string {
  return redactClassifierText(value).value
}
```

**Why keep the wrapper**: the public symbol is called from `src/index.ts:172` (`trustedUserMessages`) and `src/index.ts:252` (`sandboxRequest.justification`). Replacing it inside the file eliminates any cross-file churn while changing the marker format.

### 1.5 Replacement for `sanitizeClassifierArguments`

```ts
export function sanitizeClassifierArguments(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated-depth]'
  if (typeof value === 'string') return redactClassifierText(value).value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitizeClassifierArguments(item, depth + 1))
  if (typeof value !== 'object') return `[${typeof value}]`
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (SECRET_KEYS.test(key)) {
      output[key] = '[redacted-secret-field]'
    } else {
      output[key] = sanitizeClassifierArguments(entry, depth + 1)
    }
  }
  return output
}
```

`CONTENT_KEYS` is removed entirely. The previous `output[key] = '[redacted-<key>:N-chars]'` branch is gone.

### 1.6 Public-API summary

| Symbol | Status |
|---|---|
| `sanitizeClassifierText(value: string): string` | **Kept** (signature unchanged; output format changed) |
| `sanitizeClassifierArguments(value, depth=0)` | **Kept** (signature unchanged; output format changed) |
| `redactClassifierText(value, maxLength?): ClassifierRedaction` | **New export** |
| `ClassifierRedaction` | **New export** |
| `CREDENTIAL_PATTERNS` | **Module-private** (not exported; exported as a readonly view if needed) |

Reason `redactClassifierText` is exposed: tests in `tests/classifier.spec.ts` exercise single-pattern hits without the recursion overhead. It also makes the new pattern set directly testable, which is a maintainability win.

### 1.7 Trusted-user-message impact

`src/index.ts:172` calls `sanitizeClassifierText(text).slice(0, remaining)`. New behavior: any credential token within a direct user message is marked `[redacted-<name>]` before reaching the classifier. No code change beyond the implementation in §1.4.

`src/index.ts:252` does the same for `escalation.justification`; same as above.

---

## Section 2 — `apply_patch` policed end to end (G3)

### 2.1 New helper in `src/paths.ts`

```ts
export function extractApplyPatchPaths(patch: string): string[] {
  // Walk the patch; for each "--- a/path" or "--- /dev/null" header followed by
  // "+++ b/path", record the b-path. Strip the "a/" / "b/" prefix. Skip pure
  // rename detection ("similarity index 100%" / "rename from"/"rename to") and
  // accept the "rename to" target as a b-path.
  // Returns the deduplicated list of b-paths in raw header form (filesystem
  // shape, not normalized). Empty array when the patch cannot be reliably
  // parsed. Callers are responsible for normalizePath before policy comparison.
}
```

Parsing rules:
- Lines beginning with `--- ` (3 dashes plus space) and `+++ ` (3 pluses plus space) are pair-matched by adjacent occurrence.
- `--- /dev/null` paired with `+++ b/<path>` indicates new file creation; record `<path>`.
- `+++ /dev/null` paired with `--- a/<path>` indicates deletion; record `<path>`.
- `rename from <path>` followed by `rename to <path>` records `<path>` from the `to` side.
- Paths are stripped of the optional leading `a/` or `b/` directory prefix (git-style).
- Output: array of strings, deduplicated, in order of appearance, **with no path normalization at this layer**. `assessTool` and `hardDenyReason` each call `normalizePath` on every entry before comparison (so workspace-relative paths and absolute paths resolve the same way).

### 2.2 `hardDenyReason` addition

```ts
if (exec.name === 'apply_patch') {
  const patch = typeof args?.patch === 'string' ? args.patch
    : typeof args?.input === 'string' ? args.input
    : undefined
  if (patch !== undefined) {
    const targets = extractApplyPatchPaths(patch)
    for (const raw of targets) {
      const normalized = normalizePath(raw, roots.workspace, roots.home)
      const reason = hardDestructiveTargetReason(normalized, roots)
      if (reason !== undefined) return `apply_patch targets ${reason}`
    }
  }
}
```

Inserted after the existing `['write', 'edit', 'apply_patch']` block in `hardDenyReason`. Note: this fails closed even when the patch text has zero resolvable paths — see §2.4.

### 2.3 `assessTool` `apply_patch` branch

```ts
if (exec.name === 'apply_patch') {
  const patch = typeof args?.patch === 'string' ? args.patch
    : typeof args?.input === 'string' ? args.input
    : undefined
  if (patch === undefined) {
    return { decision: 'ask', reason: 'apply_patch payload is missing', classifierEligible: false }
  }
  const targets = extractApplyPatchPaths(patch)
  if (targets.length === 0) {
    return {
      decision: 'ask',
      reason: 'apply_patch text cannot be parsed for target paths; manual approval required',
      classifierEligible: false,
    }
  }
  for (const raw of targets) {
    const normalized = normalizePath(raw, roots.workspace, roots.home)
    if (isProtectedProjectPath(normalized, roots)) {
      return {
        decision: 'ask',
        reason: `apply_patch targets protected project metadata: ${normalized}`,
        classifierEligible: true,
        filesystemEffects: targets.map(p => ({
          kind: 'create-or-overwrite' as const,
          path: normalizePath(p, roots.workspace, roots.home),
          existedBefore: existedBefore(normalizePath(p, roots.workspace, roots.home)),
        })),
      }
    }
  }
  const effects: FilesystemEffect[] = targets.map(p => {
    const n = normalizePath(p, roots.workspace, roots.home)
    return { kind: 'create-or-overwrite', path: n, existedBefore: existedBefore(n) }
  })
  return {
    decision: 'allow',
    reason: 'apply_patch inside workspace is delegated to the filesystem sandbox',
    classifierEligible: false,
    filesystemEffects: effects,
  }
}
```

This mirrors the existing `write/edit` branch shape (decision reason, `filesystemEffects`, sandbox delegation). The `classify` later interaction with `classifier.classify` already passes `sanitizeClassifierArguments` over `args`, so the patch content is sanitized before going to the classifier — no extra work needed.

### 2.4 Fail-closed on unparseable patch

When `extractApplyPatchPaths` returns `[]` because the patch text is too malformed to extract any path, `assessTool` returns an `ask` with `classifierEligible: false`. The user is the gate. This avoids both false-allow and false-deny on adversarial inputs.

`hardDenyReason` does not fail closed here — it only ever returns `undefined` if no hard reason applies. The `assessTool` ask handles the degraded case.

### 2.5 `pathArgument` is not extended

We do **not** add new fields to `pathArgument(args)` to detect apply_patch paths. The patch text is accessed directly via `args.patch` or `args.input`. This keeps the policy-engine contract clean and confines the new logic to one named helper.

---

## Section 3 — `web_fetch` URL hardening (G4)

### 3.1 New helper in `src/policy.ts`

```ts
const URL_CREDENTIAL_KEYS = /(?:token|access_token|api[_-]?key|sig|signature|auth|authorization)/i
const URL_CREDENTIAL_VALUE = /^(?:[A-Za-z0-9._~+\/=-]{8,}|[A-Fa-f0-9]{16,})$/
// char set: alphanumerics + base64-url alphabet (`. _ ~ + / - =`). Hyphen is
// included so URL-safe base64 tokens and AWS SigV4 signatures match.

function urlContainsCredential(url: string): boolean {
  // Parse the URL and inspect each query parameter; flag any parameter whose
  // name matches a credential-shaped token name and whose value matches a
  // structured-token shape.
  try {
    const parsed = new URL(url)
    for (const [key, value] of parsed.searchParams) {
      if (!URL_CREDENTIAL_KEYS.test(key)) continue
      if (URL_CREDENTIAL_VALUE.test(value)) return true
    }
  } catch {
    // URL parsing failed; fall through to a regex over the raw text.
  }
  // Fallback: catch credentials embedded before a parsed URL can be made.
  return /[?&](?:token|access_token|api[_-]?key|sig|signature|auth|authorization)=[^&\s"']{8,}/i.test(url)
}
```

The two regexes are tuned to balance false-positive suppression (`[A-Za-z0-9._~+\/-=]{8,}` rejects short or all-space strings; `[A-Fa-f0-9]{16,}` rejects short hex) and coverage of common query-string secret shapes (long base64url tokens, hex digests, signed HMAC outputs).

### 3.2 `hardDenyReason` addition

```ts
const argsUrl = typeof args?.url === 'string' ? args.url : undefined
if (argsUrl !== undefined
    && (/^(?:web_fetch|curl|wget)/i.test(exec.name) || EXTERNAL_WRITE_TOOL.test(exec.name))
    && urlContainsCredential(argsUrl)) {
  return 'external URL contains credential-shaped query parameter'
}
```

Inserted next to the existing `containsCredentialMaterial` early return in `hardDenyReason`, so the original detection and the new URL detection compose with `OR`.

### 3.3 Why pre-classifier instead of classifier-only

The classifier receives a sanitized URL (because the entire `url` field goes through `sanitizeClassifierText` which now catches inline `api_key=…` patterns). It cannot reliably distinguish "URL was already credentialed" from "URL is asking the remote for credentials" once the literal token is redacted. The pre-classifier check is the only way to surface a structured credential parameter to the hard-deny fuse.

### 3.4 What is **not** detected

The check is conservative on purpose:
- Bearer-token-looking fragments only in headers, not the URL itself: deferred to the existing `containsCredentialMaterial` path.
- API keys in HTTP header `Authorization` only (no body): out of scope; web_fetch/curl/wget arguments carry URL + body, both of which already flow through `sanitizeClassifierArguments`.
- URLs where the credential is in the path segment: not a common public web pattern; not added.

---

## Section 4 — Tests

### 4.1 `tests/classifier.spec.ts` updates

- Replace the existing `redacts bulk content and credentials before classification` (`tests/classifier.spec.ts:48-59`) expectation. Three assertions change:
  - Line 54: `command: 'curl -H "Authorization: Bearer secret-token-value" https://example.invalid'` becomes `command: 'curl -H "Authorization: [redacted-bearer]" https://example.invalid'`. The whole `Bearer <token>` match is replaced with `[redacted-bearer]` (note: the prior implementation kept a `Bearer ` prefix and replaced only the token suffix; the new uniform `[redacted-<name>]` shape replaces the entire match).
  - Line 55: `content: '[redacted-content:18-chars]'` becomes `content: 'repository payload'` (`CONTENT_KEYS` is removed; the value is recursed into `sanitizeClassifierText` which finds no credential pattern and emits it unchanged).
  - Line 56: `apiKey: '[redacted-secret-field]'` keeps the same expectation because `SECRET_KEYS` still matches `apiKey`.
  - Line 58: `sanitizeClassifierText('please use sk-example-secret-value for the test')` returns `'please use [redacted-token-suffix] for the test'` (was `'please use [redacted-secret] for the test'`). The `sk-<16+ chars>` shape triggers the `token-suffix` pattern (line 44 of §1.1) and the new marker naming scheme applies.
- New test cases per pattern family:
  - AKIA / ASIA in tool args string
  - `gho_…` 40-char GitHub OAuth in tool args
  - `ghp_/ghu_/ghs_…` 36-char GitHub classic tokens
  - `github_pat_…` fine-grained PAT
  - `sk-ant-…` Anthropic key
  - `-----BEGIN OPENSSH PRIVATE KEY-----…-----END…PRIVATE KEY-----` multiline PEM
- New direct unit block for `redactClassifierText`:
  - Each pattern family, plus a parity test that the previous name suffixes map to the new markers.

### 4.2 `tests/policy.spec.ts` updates

- New `describe('apply_patch')` block covering every case below (one `it` per bullet):
  - happy-path modification to a workspace file ⇒ `allow` with `filesystemEffects` populated;
  - create via `--- /dev/null` + `+++ b/path` (new file) ⇒ `allow` with `filesystemEffects` populated;
  - delete via `--- a/x` + `+++ /dev/null` ⇒ `allow` with `filesystemEffects` populated, `kind: 'create-or-overwrite'`, `existedBefore` reflecting actual file state;
  - rename via `rename from`/`rename to` ⇒ target from the `rename to` side is recorded and policed;
  - protected project path (e.g., `.git/config`) ⇒ `assessTool` returns `{ decision: 'ask', classifierEligible: true }` with `filesystemEffects` populated;
  - destructive path (e.g., `/etc/passwd`, `~/.ssh/id_rsa`, DSH_HOME) ⇒ `hardDenyReason` returns a string matching `/credential|critical|root|DSH_HOME/`;
  - multi-file patch where one target is destructive ⇒ hard deny (any-target-deny semantics);
  - unparseable patch (no `---`/`+++` pair extractable) ⇒ `assessTool` returns `{ decision: 'ask', classifierEligible: false }`;
  - empty patch text / missing `args.patch`/`args.input` ⇒ `assessTool` returns `{ decision: 'ask', reason: 'apply_patch payload is missing', classifierEligible: false }`;
  - `args.input` (alternate field) is read same as `args.patch`;
  - `args.file_path` populated alongside patch text ⇒ path-only check still wins (i.e., the existing `hardDenyReason` block at `policy.ts:142-149` runs first and any destructive `file_path` still hard-denies).
- New `describe('web_fetch URL hardening')` block:
  - URL with `?token=longstring12345` ⇒ hard deny
  - URL with `?token=hello` (too short) ⇒ no deny
  - URL with `?q=hello` (non-credential key) ⇒ no deny
  - URL with `?sig=<40 hex>` ⇒ hard deny
  - URL fails to parse (no protocol) ⇒ regex fallback catches `?token=…`

### 4.3 `tests/paths.spec.ts` updates

- New `extractApplyPatchPaths` test block:
  - Single-file modification: returns `[<path>]`
  - New file: `--- /dev/null` + `+++ b/<path>` returns `[<path>]`
  - Deletion: returns `[<path>]`
  - Multi-file patch: returns both, in order, deduplicated
  - Rename pair: `rename from a/x` + `rename to b/y` returns `[<y>]`
  - Header with no recognizable `+++`: returns `[]`
  - Truncated patch (only `--- a/x` without `+++`): returns `[]`
  - Paths with leading `a/` or `b/`: stripped
  - Output preserves raw paths (no normalization) — caller normalizes

### 4.4 Test count estimate

- ~12 new `redactClassifierText` unit cases
- ~10 new `sanitizeClassifierArguments` cases
- ~8 new `apply_patch` policy cases
- ~5 new `web_fetch` URL cases
- ~9 new `extractApplyPatchPaths` unit cases
- ≈ 44 net-new test cases.

---

## Section 5 — Public-API and `index.ts`

No changes to `src/index.ts` are required:
- `sanitizeClassifierText` and `sanitizeClassifierArguments` are exported from `src/classifier.ts` and re-exported by `src/index.ts:7` (import) and `src/index.ts:15` (re-export). The signatures do not change.
- The new exports `redactClassifierText` and `ClassifierRedaction` are added to `src/classifier.ts`. They are exported because `tests/classifier.spec.ts` exercises them directly. `src/index.ts` does not need to re-export them — internal API only.

---

## Section 6 — Risk register

| Risk | Probability | Mitigation |
|---|---|---|
| Redaction false positives (e.g., `ghp_<base64-like-literal-data>` accidentally matches a 36-char base64 word) | Low | The pattern requires the literal `gh[pus]_` prefix; in non-code identifiers base64 does not start with `gh[pus]_`. Strings outside that namespace are unaffected. |
| `extractApplyPatchPaths` returning `[]` on a patch that simply omits `+++ b/…` (an unusual but legal git output) | Low | Fail-closed ⇒ `ask`. No `allow` regression. |
| Removing `CONTENT_KEYS` causes a regression in tests that explicitly check for `[redacted-content:N-chars]` markers | Medium | Test update is part of this spec (§4.1). |
| `web_fetch` URL detection fires on legit URLs like `?token=short_frag` | Very low | `URL_CREDENTIAL_VALUE` requires ≥8 chars. |
| Patch text 1000+ chars gets truncated by `sanitizeClassifierText` before reaching classifier | Same as before | Reuse existing truncation behavior; classifier has its own length budget. |

---

## Section 7 — Open questions (none blocking)

- Whether `apply_patch` arguments should also support `input` rather than `patch`. We support both to be permissive; resolved during implementation by inspecting the upstream tool integration.
- Whether the existing `sanitizeClassifierText` redaction marker for old inline patterns (which used the literal `[redacted-secret]`) should remain or be aliased. The new marker scheme uses `[redacted-<name>]` for everything. No alias kept (single marker shape for clarity).

---

## Section 8 — Acceptance criteria

1. `pnpm test` passes locally; `git diff --stat` shows changes only in `src/classifier.ts`, `src/policy.ts`, `src/paths.ts`, and the three test files. No new files.
2. `pnpm typecheck` (or `tsc --noEmit && tsc -p tsconfig.client.json --noEmit`) is clean.
3. New behavior is exercised by the new test cases; specifically:
   - `extractApplyPatchPaths` is unit-tested end to end.
   - `redactClassifierText` is unit-tested for every `CREDENTIAL_PATTERNS` entry.
   - `apply_patch` is fully covered by assessTool and hardDenyReason tests.
   - `web_fetch` URL with credential-shaped query parameter lands in `hardDenyReason`.
4. Existing tests that relied on the `[redacted-content:N-chars]` marker format are updated to the new `[redacted-<name>]` format.
5. No additional new write-side `ask` paths are added beyond the existing write/edit/str_replace_editor branches (the `'G-3 apply_patch'` branch is added, which is structurally needed because apply_patch had no branch at all).

---

## Section 9 — Investigation backlog (future PR / spec)

Items from the local comparison (`dsh-auto-mode-vs-dsh-auto-review.md`) that are intentionally **out of scope** for this spec. They will be tracked in a separate `9-investigation-backlog.md`.

- **B1 — `web_fetch` URL query-string credentials for non-HTTPS endpoint** (low priority; HTTPS isn't enforced on web_fetch in upstream).
- **B2 — Hardening `apply_patch` for content-based credential detection** within the patch body (matches the user's PR-A in spirit, but only on the apply_patch text path; same maintainer pushback likely).
- **B3 — Symlink escape (Critical-2)**: writing through a workspace symlink that points at `~/.ssh` or `~/.aws`. Sandbox-first philosophy may require a fundamentally different design (trust boundary on first symlink traversal). Deferred.
- **B4 — AKIA pattern coverage in `containsCredentialMaterial`** (write-side credential-shaped blocking). The maintainer declined PR-A in this direction. Tracker only.
- **B5 — Pre-classifier override of `web_fetch` for arbitrary hostnames** (out of threat-model scope for Auto).

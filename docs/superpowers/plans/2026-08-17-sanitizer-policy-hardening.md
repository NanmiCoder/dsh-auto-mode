# Sanitizer Redesign + `apply_patch` Coverage + `web_fetch` URL Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the key-name-driven sanitizer with content-first credential redaction (closing the `str_replace_editor` field gap the maintainer acknowledged), add end-to-end path-based policy enforcement for `apply_patch`, and add a credential-bearing URL hard-deny for outbound tools (`web_fetch`/`curl`/`wget`/`EXTERNAL_WRITE_TOOL`). All three stay inside `src/classifier.ts`, `src/policy.ts`, `src/paths.ts`, with no write-side content blockers (sandbox-first maintained).

**Architecture:** Single-pass line scanner in `paths.ts` extracts `---/+++` and `rename from/to` targets from an `apply_patch` text; both `hardDenyReason` and `assessTool` feed those targets through the existing `hardDestructiveTargetReason` and `isProtectedProjectPath` fuses. `classifier.ts` swaps `CONTENT_KEYS`-based key replacement for pattern-driven redaction via `CREDENTIAL_PATTERNS`; the rest of the public API keeps identical signatures. New credential-bearing URL check in `policy.ts` mirrors the existing `containsCredentialMaterial` early-return shape so credentials in URLs are hard-denied before classifier dispatch.

**Tech Stack:** TypeScript 5.9, Node 22, vitest 4. No new dependencies. No new files.

**Spec:** [`docs/superpowers/specs/2026-08-17-sanitizer-and-policy-hardening-design.md`](../specs/2026-08-17-sanitizer-and-policy-hardening-design.md) — the executor reads both side by side. Spec commits are `3437cdc` (initial) and `b2148fc` (must-fix revisions G1/G2/G3 from review).

## Global Constraints

Verbatim from spec §Constraints:

- Diff as small as possible.
- No new files; all source changes stay in `src/classifier.ts`, `src/policy.ts`, `src/paths.ts`.
- No public API breakage at the export level (function signatures preserved).
- No new write-side content blocker (must not conflict with sandbox-first philosophy).
- All four line breaks in `tests/classifier.spec.ts:54/55/56/58` are explicitly updated per spec §4.1.
- Anthropic regex must anchor `api\d{2}-` and require 32+ body chars (G1 review fix).

Project-wide:

- TypeScript strict mode (no implicit any, exact optional properties).
- Public exports gain `readonly` types where missing.
- Test names use the existing `it('does X', …)` shape; descriptive but concise.
- Use `read` / `write` tools for editing; do not use `sed`/`awk` for source edits.

---

## Task 1: `extractApplyPatchPaths` parser in `src/paths.ts`

**Files:**
- Create: `src/paths.ts` extension (function added at the bottom of the file, after `isArtifactArea`).
- Test: `tests/paths.spec.ts` (existing file, new `describe` block).

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `export function extractApplyPatchPaths(patch: string): string[]` returning deduplicated raw filesystem paths (no `normalizePath` here — caller normalizes).

**Algorithm (single pass, deterministic).** The patch text is split on `\r?\n`. Walk the lines:

1. For each line starting with `--- ` (3 dashes plus space):
   - Capture the minus header (the path after `--- `).
   - Walk forward until a line starting with `+++ ` (3 pluses plus space) is found.
   - On finding the plus header:
     - If minus is `/dev/null` and plus is `b/path` (or `path` with optional leading `b/`): record the plus path (new file).
     - If plus is `/dev/null` and minus is `a/path` (or `path` with optional leading `a/`): record the minus path (delete).
     - Otherwise (both real paths): record the plus path (modify).
     - Skip past the plus header to avoid double-pairing.
2. For each line starting with `rename to `: record the path after `rename to `.
3. Strip leading `a/` or `b/` from recorded paths. Discard `/dev/null` and empty strings. Deduplicate in first-seen order.
4. Return `[]` for non-string input, empty input, or any patch text where no `--- ` header can be paired with a `+++ ` header (fail-closed contract per spec §2.4).

- [ ] **Step 1: Write the failing tests**

Edit `tests/paths.spec.ts`. Add at the end of the existing `describe('path policy', …)` block (before the closing `})`):

```ts
  it('extracts single-file modification paths from a patch', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 0123..4567 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/a.ts'])
  })

  it('records new file paths from --- /dev/null + +++ b/<path>', () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/new.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/new.ts'])
  })

  it('records deleted file paths from --- a/<path> + +++ /dev/null', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index 1234567..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/old.ts'])
  })

  it('records all target paths in a multi-file patch, deduplicated, in order', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old2',
      '+new2',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('records the destination path from rename from/rename to pairs', () => {
    const patch = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 100%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/new-name.ts'])
  })

  it('returns [] for an unparseable patch (no +++ pair)', () => {
    expect(extractApplyPatchPaths('--- a/x\n@@ -1 +1 @@\n-old\n')).toEqual([])
  })

  it('returns [] when patch text is empty or non-string', () => {
    expect(extractApplyPatchPaths('')).toEqual([])
    // @ts-expect-error: runtime contract accepts unknown inputs safely.
    expect(extractApplyPatchPaths(undefined)).toEqual([])
  })

  it('strips the optional leading a/ or b/ from recorded paths', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['foo.ts'])
  })

  it('preserves raw paths (no normalization applied)', () => {
    const patch = [
      '--- a/CAPS.ts',
      '+++ b/CAPS.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['CAPS.ts'])
  })
```

Add to the import line at the top of `tests/paths.spec.ts`:

```ts
import {
  canonicalizePosixSystemAlias,
  canonicalizeWindowsNamespace,
  extractApplyPatchPaths,
  hardDestructiveTargetReason,
  isFilesystemRoot,
  isProtectedProjectPath,
  isWithin,
  normalizePath,
  resolveRoots,
} from '../src/paths.js'
```

- [ ] **Step 2: Run the failing tests and confirm they fail**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/paths.spec.ts 2>&1 | tail -40`
Expected: every new `it()` in this block fails with "extractApplyPatchPaths is not a function" (or "is not exported"). Confirm the 9 failures before moving on.

- [ ] **Step 3: Implement `extractApplyPatchPaths` in `src/paths.ts`**

Add at the bottom of `src/paths.ts` (after the existing `isArtifactArea` function):

```ts
/**
 * Extract filesystem targets from a unified-diff style `apply_patch` payload.
 *
 * Walks the patch text once on a per-line basis and records:
 *   - the destination path of every `--- a/<path>` + `+++ b/<path>` pair
 *     (modify),
 *   - `+++ b/<path>` when paired with `--- /dev/null` (new file),
 *   - `--- a/<path>` when paired with `+++ /dev/null` (delete),
 *   - the destination path of every `rename from` / `rename to` pair.
 *
 * Returns deduplicated, order-preserved paths with any leading `a/` or `b/`
 * stripped. Paths are NOT normalized here — every caller passes the result
 * through `normalizePath` so workspace-relative and absolute paths resolve
 * the same way.
 *
 * Returns `[]` for empty input or any patch text where no `---` header can
 * be paired with a `+++` header. Callers treat that as fail-closed
 * (manual approval) rather than as a successful empty parse.
 */
export function extractApplyPatchPaths(patch: string): string[] {
  if (typeof patch !== 'string' || patch === '') return []
  const lines = patch.split(/\r?\n/)
  const targets: string[] = []
  const seen = new Set<string>()

  const record = (raw: string | undefined): void => {
    if (raw === undefined) return
    if (raw === '' || raw === '/dev/null') return
    const stripped = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw
    if (!seen.has(stripped)) {
      seen.add(stripped)
      targets.push(stripped)
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('--- ')) {
      const minusRaw = line.slice(4)
      const minusPath = minusRaw === '/dev/null'
        ? undefined
        : minusRaw.startsWith('a/') ? minusRaw.slice(2) : minusRaw

      // Walk forward until we find the matching +++ header.
      let j = i + 1
      while (j < lines.length && !lines[j].startsWith('+++ ')) j++
      if (j < lines.length) {
        const plusRaw = lines[j].slice(4)
        const plusPath = plusRaw === '/dev/null'
          ? undefined
          : plusRaw.startsWith('b/') ? plusRaw.slice(2) : plusRaw

        if (minusPath === undefined && plusPath !== undefined) {
          // New file: --- /dev/null + +++ b/<path> ⇒ record plus.
          record(plusPath)
        } else if (plusPath === undefined && minusPath !== undefined) {
          // Delete: --- a/<path> + +++ /dev/null ⇒ record minus.
          record(minusPath)
        } else if (plusPath !== undefined) {
          // Modify: record the destination path.
          record(plusPath)
        }
        i = j + 1
        continue
      }
    } else if (line.startsWith('rename to ')) {
      record(line.slice('rename to '.length))
    }
    i++
  }

  return targets
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/paths.spec.ts 2>&1 | tail -30`
Expected: all 16 tests pass (8 pre-existing + 9 new — total 17; one of the existing paths tests was added previously, so number may be 8 + 9 = 17).

- [ ] **Step 5: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git add src/paths.ts tests/paths.spec.ts
git commit -m "feat(paths): single-pass parser for apply_patch target paths

extractApplyPatchPaths walks the patch text once on a per-line basis,
pairs every '--- a/<path>' with the next '+++ b/<path>' (or one of them
/dev/null for create/delete), records rename-to targets, and returns
deduplicated, raw filesystem paths. Stripping of 'a/' and 'b/' prefixes
is done at the helper; callers still call normalizePath before policy
comparison so workspace-relative and absolute paths resolve identically.

Path-only extraction closes the gap flagged by the local comparison's
section 6b review (apply_patch's targets lived in the patch text, not in
pathArgument, so the existing hardDenyReason fuse was a no-op)."
```

---

## Task 2: `redactClassifierText` + `CREDENTIAL_PATTERNS` in `src/classifier.ts`

**Files:**
- Modify: `src/classifier.ts` — add new types, the pattern table, and the core `redactClassifierText` function. Refactor `sanitizeClassifierText` to wrap it. (Leave `sanitizeClassifierArguments` for Task 3.)
- Test: `tests/classifier.spec.ts` — add a new `describe('redactClassifierText')` block with one `it` per pattern family.

**Interfaces:**
- Consumes: nothing new beyond `string`.
- Produces:
  - `export interface ClassifierRedaction { readonly value: string; readonly redactedNames: readonly string[] }`
  - `export function redactClassifierText(value: string, maxLength?: number): ClassifierRedaction`
  - `export function sanitizeClassifierText(value: string): string` — thinned to a wrapper; signature unchanged.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the bottom of `tests/classifier.spec.ts`:

```ts
describe('redactClassifierText', () => {
  it('redacts AKIA / ASIA AWS access-key IDs', () => {
    const result = redactClassifierText('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    expect(result.value).toBe('export AWS_ACCESS_KEY_ID=[redacted-aws-access-key]')
    expect(result.redactedNames).toContain('aws-access-key')
  })

  it('redacts github classic / user / server PATs (gh[pus]_<36>)', () => {
    const result = redactClassifierText('token = ghp_012345678901234567890123456789012345')
    expect(result.value).toBe('token = [redacted-github-classic]')
    expect(result.redactedNames).toContain('github-classic')
    const user = redactClassifierText('token = ghu_012345678901234567890123456789012345')
    expect(user.value).toBe('token = [redacted-github-classic]')
    const server = redactClassifierText('token = ghs_012345678901234567890123456789012345')
    expect(server.value).toBe('token = [redacted-github-classic]')
  })

  it('redacts gho_ github OAuth access tokens (40 chars)', () => {
    const result = redactClassifierText('token = gho_0123456789abcdef0123456789abcdef01234567')
    expect(result.value).toBe('token = [redacted-github-oauth]')
    expect(result.redactedNames).toContain('github-oauth')
  })

  it('redacts github_pat_ fine-grained PATs (22+ chars body)', () => {
    const result = redactClassifierText('token = github_pat_0123456789abcdef_0123456789abcdef')
    expect(result.value).toBe('token = [redacted-github-fine-pat]')
    expect(result.redactedNames).toContain('github-fine-pat')
  })

  it('redacts sk- / sk-proj- LLM API keys (16+ chars)', () => {
    const plain = redactClassifierText('sk-0123456789abcdef0123456789abcdef')
    expect(plain.value).toBe('[redacted-llm-key]')
    expect(plain.redactedNames).toContain('llm-key')
    const proj = redactClassifierText('sk-proj-0123456789abcdef0123456789abcdef')
    expect(proj.value).toBe('[redacted-llm-key]')
  })

  it('redacts Anthropic keys only when anchored to sk-ant-api<NN>-<32+>', () => {
    // Real Anthropic key (api03 + 40-char body) — matches.
    const real = redactClassifierText('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(real.value).toBe('[redacted-anthropic-key]')
    // Documentation strings without the api<NN>- prefix — DO NOT match.
    expect(redactClassifierText('uses sk-ant-abcdefghij1234567890 in config').redactedNames)
      .not.toContain('anthropic-key')
    // Single-digit api version — does NOT match.
    expect(redactClassifierText('sk-ant-api3-abcdefghijklmnopqrstuvwxyz123456').redactedNames)
      .not.toContain('anthropic-key')
  })

  it('redacts a complete PEM private-key block (BEGIN ... END inclusive)', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'abc',
      'def',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const result = redactClassifierText(pem)
    expect(result.value).toBe('[redacted-pem-private-key]')
    expect(result.redactedNames).toContain('pem-private-key')
  })

  it('redacts multiple credential shapes in one input and lists each name once', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE sk-ant-api03-abcabcabcabcabcabcabcabcabcabc12AKIAL'
    const result = redactClassifierText(input)
    expect(result.redactedNames).toContain('aws-access-key')
    expect(result.redactedNames).toContain('anthropic-key')
  })

  it('emits the input unchanged when no pattern matches', () => {
    const input = 'just a plain string with no credentials'
    const result = redactClassifierText(input)
    expect(result.value).toBe(input)
    expect(result.redactedNames).toEqual([])
  })

  it('truncates the redacted value to maxLength when supplied', () => {
    const result = redactClassifierText('A'.repeat(2000), 100)
    expect(result.value.length).toBe(100)
  })
})
```

Add at the top of `tests/classifier.spec.ts` (preserving the existing imports):

```ts
import {
  parseClassifierDecision,
  redactClassifierText,
  sanitizeClassifierArguments,
  sanitizeClassifierText,
} from '../src/classifier.js'
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/classifier.spec.ts -t "redactClassifierText" 2>&1 | tail -30`
Expected: every `it` in the new `describe` block fails because `redactClassifierText` is not exported. Confirm all 10 failures before moving on.

- [ ] **Step 3: Implement `redactClassifierText` + `CREDENTIAL_PATTERNS` + thin `sanitizeClassifierText` wrapper**

Replace the existing `sanitizeClassifierText` and `CONTENT_KEYS` / `SECRET_KEYS` declarations (currently `src/classifier.ts:32-42`) with:

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

const SECRET_KEYS = /(?:api|auth|access|secret|private|credential|password|token|cookie|authorization).*?(?:key|value|token)?$/i

/** Redact pattern-matched credential content and surface which patterns fired. */
export interface ClassifierRedaction {
  readonly value: string
  readonly redactedNames: readonly string[]
}

/**
 * Run every entry in {@link CREDENTIAL_PATTERNS} against the input. Each match
 * is replaced with `[redacted-<name>]`; each unique name that fires is appended
 * to `redactedNames` in the order it appears in the patterns table. Truncated
 * to `maxLength` when the redacted value would otherwise exceed it.
 *
 * This is content-first: a credential-shaped substring anywhere in the input is
 * redacted regardless of the field name it sits under. Key-name matching is
 * still applied one layer up in {@link sanitizeClassifierArguments} for
 * defense-in-depth on `SECRET_KEYS`.
 */
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

/**
 * Public thin wrapper over {@link redactClassifierText}. The kept signature
 * preserves consumer call sites in `src/index.ts` (`trustedUserMessages`,
 * `sandboxRequest.justification`) — see spec §1.4.
 */
export function sanitizeClassifierText(value: string): string {
  return redactClassifierText(value).value
}
```

Confirm the existing `sanitizeClassifierArguments` (Task 3's target) is untouched for now.

- [ ] **Step 4: Run the new tests and confirm they pass**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/classifier.spec.ts -t "redactClassifierText" 2>&1 | tail -30`
Expected: all 10 new tests pass; the original 14 tests in the file are still running with the old `sanitizeClassifierArguments` (they should still pass because that function has not been refactored yet).

If anything fails, double-check the regex literal for typos. Common gotchas:
- `\b` next to a character class needs `\\b` in the JSON literal — but in source `.ts` it's just `\b`.
- `g` flag must be present for `replace` to iterate, and the pattern must not have `lastIndex` state leaks (we re-create the regex on each pass via the constant, so no state issue).

- [ ] **Step 5: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git add src/classifier.ts tests/classifier.spec.ts
git commit -m "feat(classifier): content-first credential redaction (Task 2/3 of spec)

Adds CREDENTIAL_PATTERNS (9 entries: AKIA/ASIA, gho_/gh[pus]_/github_pat_,
sk- / sk-proj-, sk-ant-api\\d{2}-, and PEM blocks) and a new
redactClassifierText function. The whole-match is replaced with the
uniform marker [redacted-<name>]; ClassifierRedaction surfaces the set
of pattern names that fired for downstream telemetry.

The Anthropic regex is anchored to sk-ant-api\\d{2}-<32 base64url chars>
per the G1 review fix: documentation strings of shape sk-ant-anything20plus
must NOT match. Real Anthropic keys still match.

sanitizeClassifierText is retained as a thin wrapper preserving the
public signature, so src/index.ts call sites (trustedUserMessages,
sandboxRequest.justification) keep working unchanged.

sanitizeClassifierArguments remains untouched in this commit; Task 3
refactors it to use redactClassifierText and removes CONTENT_KEYS in a
single atomic change."
```

---

## Task 3: Refactor `sanitizeClassifierArguments` + update existing test lines

**Files:**
- Modify: `src/classifier.ts` — rewrite `sanitizeClassifierArguments` to pattern-redact string values and remove `CONTENT_KEYS`.
- Modify: `tests/classifier.spec.ts` — update lines 54, 55, 58 to the new expected values per spec §4.1.

**Interfaces:**
- Consumes: `ClassifierRedaction` from Task 2.
- Produces: `sanitizeClassifierArguments(value, depth=0)` — same signature, new output shape (no `[redacted-content:N-chars]` markers; pattern-redacted strings).

- [ ] **Step 1: Write the failing new tests**

Append a new `describe` block at the bottom of `tests/classifier.spec.ts`:

```ts
describe('sanitizeClassifierArguments', () => {
  it('redacts a top-level credential-shaped string value but leaves neighbors alone', () => {
    const out = sanitizeClassifierArguments({
      command: 'curl https://example.invalid',
      note: 'use AKIAIOSFODNN7EXAMPLE in production',
    }) as Record<string, string>
    expect(out.command).toBe('curl https://example.invalid')
    expect(out.note).toBe('[redacted-aws-access-key] in production')
  })

  it('redacts string credentials nested inside arrays and objects', () => {
    const out = sanitizeClassifierArguments({
      env: [
        'GITHUB_TOKEN=ghp_012345678901234567890123456789012345',
        'OTHER=plain',
      ],
      nested: {
        body: 'token = AKIAIOSFODNN7EXAMPLE',
      },
    })
    expect(out).toEqual({
      env: [
        '[redacted-github-classic]',
        '[redacted-key-value]',
      ],
      nested: {
        body: '[redacted-aws-access-key]',
      },
    })
  })

  it('wholesale-redacts SECRET_KEYS-matched keys', () => {
    const out = sanitizeClassifierArguments({ apiKey: 'sk-example-secret' }) as Record<string, string>
    expect(out.apiKey).toBe('[redacted-secret-field]')
  })

  it('does NOT truncate CONTENT_KEYS-matched fields any more (content keys emit plain text after pattern scan)', () => {
    const out = sanitizeClassifierArguments({ content: 'repository payload' }) as Record<string, string>
    expect(out.content).toBe('repository payload')
  })

  it('preserves non-string scalars at depth 0', () => {
    expect(sanitizeClassifierArguments({ count: 7, flag: true, missing: null }))
      .toEqual({ count: 7, flag: true, missing: null })
  })

  it('caps array size at 25 entries', () => {
    const arr = Array.from({ length: 30 }, (_, i) => `item-${i}`)
    const out = sanitizeClassifierArguments({ list: arr }) as { list: unknown[] }
    expect(out.list.length).toBe(25)
  })

  it('caps object key count at 50 entries', () => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < 60; i++) obj[`k${i}`] = `v${i}`
    const out = sanitizeClassifierArguments(obj) as Record<string, string>
    expect(Object.keys(out).length).toBe(50)
  })
})
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/classifier.spec.ts -t "sanitizeClassifierArguments" 2>&1 | tail -30`
Expected: 7 failures (the new `describe` block). Importantly, the existing test `it('redacts bulk content and credentials before classification', …)` at lines 48-59 should STILL pass because we haven't touched `sanitizeClassifierArguments` yet.

- [ ] **Step 3: Refactor `sanitizeClassifierArguments`**

Replace the body of `sanitizeClassifierArguments` in `src/classifier.ts` (currently `src/classifier.ts:45-62`) with:

```ts
/** Remove bulk content and likely secrets before crossing the classifier network boundary. */
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

`CONTENT_KEYS` is removed entirely (no longer referenced). The new function pattern-redacts every string at any depth instead of replacing wholesale for `SECRET_KEYS`-matched keys and key-count-marking for `CONTENT_KEYS`-matched keys.

- [ ] **Step 4: Update the existing failing test in `tests/classifier.spec.ts`**

Replace `tests/classifier.spec.ts` lines 48-59 with:

```ts
  it('redacts bulk content and credentials before classification', () => {
    expect(sanitizeClassifierArguments({
      command: 'curl -H "Authorization: Bearer secret-token-value" https://example.invalid',
      content: 'repository payload',
      apiKey: 'sk-example-secret',
    })).toEqual({
      command: 'curl -H "Authorization: [redacted-bearer]" https://example.invalid',
      content: 'repository payload',
      apiKey: '[redacted-secret-field]',
    })
    expect(sanitizeClassifierText('please use sk-example-secret-value for the test')).toBe('please use [redacted-token-suffix] for the test')
  })
```

Note the four changes vs the original:
- `command` line: the entire `Bearer secret-token-value` match is replaced with `[redacted-bearer]` (whole-match replacement; the prior implementation kept a `Bearer ` prefix).
- `content` line: was `[redacted-content:18-chars]`, now `repository payload` (no `CONTENT_KEYS` redaction).
- `apiKey` line: unchanged.
- Standalone assertion: was `[redacted-secret]`, now `[redacted-token-suffix]`.

- [ ] **Step 5: Run the full `tests/classifier.spec.ts` suite**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/classifier.spec.ts 2>&1 | tail -30`
Expected:
- All 7 new `sanitizeClassifierArguments` tests pass.
- The updated `redacts bulk content and credentials before classification` test passes.
- All 10 `redactClassifierText` tests from Task 2 still pass.
- The 14 pre-existing tests (parseClassifierDecision, http classifier happy/sad path, etc.) still pass.

Total file: ~31 tests passing. If anything fails, the most common causes are:
- A pattern leaking into `redactedNames` (typo in pattern literal).
- A `SECRET_KEYS` match being missed (something like `access_token` instead of `authorization-token`).
- Recursion depth hitting `> 3` before reaching the credential string (cap is one per recommendation; if you must keep it, set the depth limit higher in the helper only).

- [ ] **Step 6: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git add src/classifier.ts tests/classifier.spec.ts
git commit -m "feat(classifier): pattern-redact every string at any depth; drop CONTENT_KEYS

sanitizeClassifierArguments is rewritten to recurse every value through
redactClassifierText and only special-case SECRET_KEYS at the property
level. The old CONTENT_KEYS key-whitelist and its [redacted-<key>:N-chars]
marker are removed.

Side-effect on the existing test (tests/classifier.spec.ts:48-59):
- 'content' value passes through (was key-replaced wholesale).
- 'command' Bearer match replaced with [redacted-bearer] (whole match).
- Standalone 'sk-…' assertion renamed to [redacted-token-suffix].
- 'apiKey' value unchanged.

This closes the str_replace_editor sanitization field gap the maintainer
acknowledged in their PR-#4 reply (sanit_classifier.ts calls now reach
old_str/new_str/file_text payload lines through the recursive redaction)."
```

---

## Task 4: `apply_patch` policy enforcement in `src/policy.ts`

**Files:**
- Modify: `src/policy.ts` — add a new `apply_patch` branch in `hardDenyReason` and a new `apply_patch` branch in `assessTool`.
- Modify: `tests/policy.spec.ts` — new `describe('apply_patch')` block with one `it` per bullet from spec §4.2.

**Interfaces:**
- Consumes: `extractApplyPatchPaths` from Task 1; existing `hardDestructiveTargetReason`, `isProtectedProjectPath`, `normalizePath`, `existedBefore` from `src/paths.ts`.
- Produces: a working `apply_patch` policy path mirroring `write/edit` semantics.

- [ ] **Step 1: Write the failing tests for `hardDenyReason`**

Find the existing `describe('tool policy', …)` block in `tests/policy.spec.ts` (it already imports `hardDenyReason` from `../src/policy.js`). Append the following `it` calls **inside that existing block**:

```ts
  it('hard-denies apply_patch when any target is destructive', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = [
      '--- a/src/ok.ts',
      '+++ b/src/ok.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/.ssh/id_rsa',
      '+++ b/.ssh/id_rsa',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')
    const exec = execution('apply_patch', { patch })
    expect(hardDenyReason(exec, roots)).toMatch(/credential|critical|root|DSH_HOME/)
  })

  it('hard-denies apply_patch targeting DSH_HOME', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    const exec = execution('apply_patch', { patch, file_path: '/safe/dsh/settings.yaml' })
    expect(hardDenyReason(exec, roots)).toMatch(/DSH_HOME/)
  })

  it('returns undefined for a benign apply_patch under hardDenyReason', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(hardDenyReason(execution('apply_patch', { patch }), roots)).toBeUndefined()
  })
```

- [ ] **Step 2: Write the failing tests for `assessTool`**

Append additional `it` calls in the same block:

```ts
  it('allows a happy-path apply_patch on a workspace file with filesystemEffects', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(
      execution('apply_patch', { patch: ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n') }),
      roots,
      artifacts,
    )
    expect(out.decision).toBe('allow')
    expect(out.classifierEligible).toBe(false)
    expect(out.filesystemEffects).toEqual([
      { kind: 'create-or-overwrite', path: '/work/repo/src/ok.ts', existedBefore: expect.any(Boolean) as unknown as boolean },
    ])
  })

  it('asks for apply_patch targeting protected project metadata', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(
      execution('apply_patch', { patch: ['--- a/.git/config', '+++ b/.git/config', '@@ -1 +1 @@', '-old', '+new'].join('\n') }),
      roots,
      artifacts,
    )
    expect(out).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(out.filesystemEffects?.[0]?.path).toBe('/work/repo/.git/config')
  })

  it('asks with classifierEligible false for an unparseable apply_patch (fail-closed)', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(
      execution('apply_patch', { patch: 'this is not a patch at all' }),
      roots,
      artifacts,
    )
    expect(out).toMatchObject({ decision: 'ask', classifierEligible: false })
  })

  it('asks with classifierEligible false when apply_patch payload is missing', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(execution('apply_patch', {}), roots, artifacts)
    expect(out).toMatchObject({ decision: 'ask', classifierEligible: false, reason: expect.stringMatching(/missing/) as unknown as string })
  })

  it('reads apply_patch payloads from args.input as well as args.patch', () => {
    const artifacts = new ArtifactRegistry()
    const patch = ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    const outFromInput = assessTool(execution('apply_patch', { input: patch }), roots, artifacts)
    expect(outFromInput.decision).toBe('allow')
  })

  it('handles create (--- /dev/null + +++ b/path) and delete (--- a/path + +++ /dev/null)', () => {
    const artifacts = new ArtifactRegistry()
    const create = assessTool(
      execution('apply_patch', { patch: ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+new'].join('\n') }),
      roots,
      artifacts,
    )
    expect(create.decision).toBe('allow')
    expect(create.filesystemEffects?.[0]?.path).toBe('/work/repo/src/new.ts')

    const del = assessTool(
      execution('apply_patch', { patch: ['--- a/src/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n') }),
      roots,
      artifacts,
    )
    expect(del.decision).toBe('allow')
    expect(del.filesystemEffects?.[0]?.path).toBe('/work/repo/src/gone.ts')
  })

  it('records rename-to target paths and routes them through policy', () => {
    const artifacts = new ArtifactRegistry()
    const patch = [
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n')
    const ok = assessTool(
      execution('apply_patch', { patch: ['--- a/src/old-name.ts', '+++ b/src/new-name.ts', '@@ -0,0 +1 @@', '+x'].join('\n') + '\n' + patch }),
      roots,
      artifacts,
    )
    expect(ok.decision).toBe('allow')
    const destructive = assessTool(
      execution('apply_patch', { patch: ['--- a/.ssh/x', '+++ b/.ssh/x', '@@ -1 +1 @@', '-old', '+new', '\n', 'rename to .ssh/danger'].join('\n') }),
      roots,
      artifacts,
    )
    expect(destructive.decision).toBe('ask')
  })

  it('hard-deny takes precedence when args.file_path and patch text disagree', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(hardDenyReason(execution('apply_patch', { patch, file_path: '/safe/dsh/settings.yaml' }), roots)).toMatch(/DSH_HOME/)
  })
```

Verify that `roots` is already in scope (from the existing top-of-file `const roots = resolveRoots(...)`). If not, declare it at the top of the new `it` calls.

- [ ] **Step 3: Run the new tests and confirm they all fail (or some leak through with the wrong reason)**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/policy.spec.ts -t "apply_patch" 2>&1 | tail -40`
Expected: every `it` in this step fails because no `apply_patch` branch exists in `assessTool` and `hardDenyReason` does not parse `apply_patch` text. The failure messages will be `decision: 'allow'`/`decision: 'ask'` mismatches or undefined `hardDenyReason` returns where a reason string was expected.

- [ ] **Step 4: Add `apply_patch` branch to `hardDenyReason`**

In `src/policy.ts`, locate the existing `hardDenyReason` function (currently starting at `src/policy.ts:134`). Insert **after** the existing `['write', 'edit', 'apply_patch']` block and **before** the standalone `DESTRUCTIVE_TOOL` block — i.e., immediately after line 149's closing `}` (end of the path-only block). Add:

```ts
  if (exec.name === 'apply_patch') {
    const argsForPatch = record(exec.arguments)
    const patch = typeof argsForPatch?.patch === 'string'
      ? argsForPatch.patch
      : typeof argsForPatch?.input === 'string' ? argsForPatch.input : undefined
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

This mirrors the existing write/edit path-only block: `pathArgument(args)` was returning `undefined` for `apply_patch` because the file path lives inside the patch text; the new code reads the patch text, parses out every target path, normalizes each, and asks the existing hard-deny fuse whether any target is destructive. If any target is destructive, the patch is hard-denied.

- [ ] **Step 5: Add `apply_patch` branch to `assessTool`**

In `src/policy.ts`, locate `assessTool` (currently starting at `src/policy.ts:161`). The new branch must be placed **after** the `write/edit` block (line 204 closing brace) and **before** the `str_replace_editor` block (line 207 onwards). Add:

```ts
  if (exec.name === 'apply_patch') {
    const argsForPatch = record(exec.arguments)
    const patch = typeof argsForPatch?.patch === 'string'
      ? argsForPatch.patch
      : typeof argsForPatch?.input === 'string' ? argsForPatch.input : undefined
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
    const effects = targets.map(p => {
      const n = normalizePath(p, roots.workspace, roots.home)
      return { kind: 'create-or-overwrite' as const, path: n, existedBefore: existedBefore(n) }
    })
    return {
      decision: 'allow',
      reason: 'apply_patch inside workspace is delegated to the filesystem sandbox',
      classifierEligible: false,
      filesystemEffects: effects,
    }
  }
```

Add at the top of `src/policy.ts` (next to the existing imports from `./paths.js`):

```ts
import {
  extractApplyPatchPaths,
  hardDestructiveTargetReason,
  isProtectedProjectPath,
  isWithin,
  normalizePath,
  type PolicyRoots,
} from './paths.js'
```

(Note: the existing import only imports four symbols. The new `apply_patch` branch needs `extractApplyPatchPaths` too; this is the only `paths.js` import change.)

- [ ] **Step 6: Run all `apply_patch` tests and confirm they pass**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/policy.spec.ts -t "apply_patch" 2>&1 | tail -40`
Expected: all 10 new `apply_patch` tests pass.

If anything fails:
- `decision: 'deny'` mismatches on the rename case typically indicate `extractApplyPatchPaths` returned `[]` for `rename to` headers; verify Task 1's parse handles `rename to ` (with the trailing space) on a line by itself.
- The "file_path takes precedence" test relies on `hardDenyReason` executing the `['write', 'edit', 'apply_patch']` block **before** the new `apply_patch`-text block. The insertion point in Step 4 is exactly between those two existing blocks; if you accidentally inserted below the `DESTRUCTIVE_TOOL` block, re-order.

- [ ] **Step 7: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git add src/policy.ts tests/policy.spec.ts
git commit -m "feat(policy): route apply_patch through hardDenyReason and assessTool

apply_patch targets live in the patch text, not in file_path/path/cwd/
workdir, so the existing hardDenyReason fuse was a no-op for it and the
tool fell through to 'ordinary registered plugin tool → allow'. This
commit closes that hole by adding:

- A new apply_patch block in hardDenyReason that parses the patch text
  via extractApplyPatchPaths (Task 1) and asks hardDestructiveTargetReason
  for each target; any destructive path → hard deny.

- A new apply_patch branch in assessTool that mirrors the write/edit
  shape: ask with classifierEligible:true on protected project paths;
  ask with classifierEligible:false on missing/unparseable patches; allow
  with filesystemEffects otherwise.

Test coverage (tests/policy.spec.ts new apply_patch block, 10 cases):
happy-path modify, create, delete, multi-file (not shown above but
covered by the protected-path test), rename-to routing, partial
unparseable, missing payload, args.input alternate field, args.file_path
precedence over patch text, and destructive-target hard-deny.

Aligns with the maintainer's sandbox-first position: all decisions are
PATH-only; no credential / content shape is checked at the policy level."
```

---

## Task 5: `web_fetch` URL credential detection in `src/policy.ts`

**Files:**
- Modify: `src/policy.ts` — add `urlContainsCredential` helper and a new block in `hardDenyReason`.
- Modify: `tests/policy.spec.ts` — new `it` blocks for the URL detection matrix.

**Interfaces:**
- Consumes: nothing.
- Produces: `function urlContainsCredential(url: string): boolean` (module-private) and a new decision: `external URL contains credential-shaped query parameter`.

- [ ] **Step 1: Write the failing tests**

Append the following `it` calls inside the existing `describe('tool policy')` block in `tests/policy.spec.ts`:

```ts
  it('hard-denies web_fetch URLs with credential-shaped long token values', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/cb?token=longstring12345' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('hard-denies web_fetch URLs with a long hex sig parameter', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/x?sig=deadbeefcafebabe1234567890abcdef12345678' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('does not deny web_fetch URLs with non-credential parameter names', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?q=hello' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })

  it('does not deny web_fetch URLs whose credential-named parameter value is too short', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=hello' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })

  it('does not deny web_fetch URLs with empty values', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })

  it('falls back to regex when the URL has no protocol (relative path)', () => {
    const outbound = execution('web_fetch', { url: 'example.invalid/path?token=longstring12345' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('hard-denies deploy tool URLs with credential-shaped parameters (EXTERNAL_WRITE_TOOL path)', () => {
    // `repo_push` matches EXTERNAL_WRITE_TOOL.
    const outbound = execution('repo_push', { url: 'https://example.invalid/api?api_key=abcdef1234567890' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('does not deny URLs whose credential-named value is purely a 7-char opaque ID', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=short12' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/policy.spec.ts -t "credential-shaped query" 2>&1 | tail -30`
Expected: every new `it` fails because `hardDenyReason` has no URL-detection block yet. Failure messages will be hard-deny string mismatches or `undefined` returns where a deny reason was expected.

- [ ] **Step 3: Add the `urlContainsCredential` helper and the `hardDenyReason` block**

In `src/policy.ts`, immediately after the existing `containsCredentialMaterial` function (around `src/policy.ts:43-46`) and **before** the `SandboxEscalationRequest` interface, add:

```ts
/** Parameter names that are commonly used to carry credentials in URLs. */
const URL_CREDENTIAL_KEYS = /(?:token|access_token|api[_-]?key|sig|signature|auth|authorization)/i

/**
 * Value-shape heuristic for credential-looking query-string values. Matches
 * either a base64url-ish substring ≥ 8 chars (alphanumerics, `.`, `_`, `~`,
 * `+`, `/`, `-`, `=`) or a hex digest ≥ 16 chars.
 */
const URL_CREDENTIAL_VALUE = /^(?:[A-Za-z0-9._~+\/=-]{8,}|[A-Fa-f0-9]{16,})$/

/**
 * Returns true when the URL contains a query parameter whose name matches
 * {@link URL_CREDENTIAL_KEYS} and whose value matches
 * {@link URL_CREDENTIAL_VALUE}. When the URL cannot be parsed as absolute,
 * a regex fallback over the raw text catches the same shape.
 */
function urlContainsCredential(url: string): boolean {
  try {
    const parsed = new URL(url)
    for (const [key, value] of parsed.searchParams) {
      if (!URL_CREDENTIAL_KEYS.test(key)) continue
      if (URL_CREDENTIAL_VALUE.test(value)) return true
    }
    return false
  } catch {
    // Relative or malformed URL; fall through to the regex.
  }
  return /[?&](?:token|access_token|api[_-]?key|sig|signature|auth|authorization)=[^&\s"']{8,}/i.test(url)
}
```

In `hardDenyReason` (currently `src/policy.ts:134`), insert **immediately after** the existing `containsCredentialMaterial`-based early return (around line 137) and **before** the existing `bash`/`pwsh` block. Add:

```ts
  const argsForUrl = record(exec.arguments)
  const argsUrl = typeof argsForUrl?.url === 'string' ? argsForUrl.url : undefined
  if (argsUrl !== undefined
      && (/^(?:web_fetch|curl|wget)/i.test(exec.name) || EXTERNAL_WRITE_TOOL.test(exec.name))
      && urlContainsCredential(argsUrl)) {
    return 'external URL contains credential-shaped query parameter'
  }
```

This mirrors the existing `containsCredentialMaterial` early-return predicate exactly: same tool filter, same OR fallthrough, just a different content check.

- [ ] **Step 4: Run the new tests and confirm they pass**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/policy.spec.ts -t "credential-shaped query" 2>&1 | tail -40`
Expected: all 8 URL-hardening tests pass.

If `tokens=short12` returns a deny when you expected no deny:
- The threshold is 8 chars from the base64url alphabet. `short12` has 7 chars but `0-9,a-z,A-Z,_,-,+,/,.,~,=` chars. `short12` = 7 chars total. Should NOT match `{8,}`. If it does, double-check the regex body.

If the `?token=longstring12345` case doesn't fire:
- Check the test URL is exactly `https://example.invalid/cb?token=longstring12345`. The regex should match `?token=longstring12345` (key is `token`, value is `longstring12345` = 15 chars ≥ 8, all in the alphabet).

- [ ] **Step 5: Run the full `tests/policy.spec.ts` file**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 120 npx vitest run tests/policy.spec.ts 2>&1 | tail -30`
Expected: all tests pass. The original 14 tests, the 10 `apply_patch` tests from Task 4, and the 8 URL-hardening tests from this task. If a `describe('tool policy')` test that was previously passing now fails, the URL block was inserted at the wrong point and a non-credential tool call is being misclassified as a credential URL.

- [ ] **Step 6: Commit**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git add src/policy.ts tests/policy.spec.ts
git commit -m "feat(policy): hard-deny external URLs with credential-shaped query parameters

Adds a small urlContainsCredential helper that:
1. Parses the URL with new URL(), iterates searchParams, and flags any
   parameter whose name (token / access_token / api_key / sig / signature
   / auth / authorization) pairs with a value that looks like a
   structured token (8+ chars from the base64url alphabet OR a 16+ hex
   digest).
2. Falls back to a regex over the raw text when the URL cannot be parsed
   (relative or malformed), catching the same shape.

The new hardDenyReason block runs alongside the existing
containsCredentialMaterial check, gated on the same (/^web_fetch|curl|
wget/ OR EXTERNAL_WRITE_TOOL) predicate. Hit reason: 'external URL
contains credential-shaped query parameter'.

Covers the post-PR str_replace_editor sanitization gap's sibling:
'credential leak in URL string sent to classifier via arguments'.

Tests (tests/policy.spec.ts new URL hardening block, 8 cases): long
query value deny, hex dig deny, non-credential key no deny, short value
no deny, empty value no deny, relative-URL regex fallback, deploy-tool
URL deny, 7-char opaque ID no deny."
```

---

## Task 6: Final verification (typecheck, suite, scope diff)

**Files:**
- No new source files. No new test files.

- [ ] **Step 1: Run the full vitest suite**

Run: `cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref && timeout 180 npx vitest run 2>&1 | tail -40`

Expected: the suite reports either all tests passing, or two known-bad `*.spec.ts` files fail to load because of upstream's missing optional sandbox packages. Both outcomes are acceptable provided:

- `tests/paths.spec.ts` — all tests pass (gained the 9 from Task 1).
- `tests/policy.spec.ts` — all tests pass (gained the 18 from Tasks 4 and 5).
- `tests/classifier.spec.ts` — all tests pass (10 from Task 2 + 7 from Task 3 + updates to lines 48-59).

Known-bad (pre-existing, environment-only): `tests/sandbox-business.spec.ts`, `tests/windows-sandbox-business.spec.ts` — fail to load because upstream `nanmicoder/dsh-auto-mode` declares `@deepseek-ai/dsh-fs-sandbox`, `@deepseek-ai/dsh-pwsh-sandbox`, `@deepseek-ai/dsh-user-approval` etc. as `devDependencies` that the workspace's pre-existing `node_modules/` (cloned from `db3a2ed` before the upstream-added deps) does not contain. Re-run `pnpm install --prefer-offline` and `node_modules/` will be repopulated if needed; otherwise these failures are out of scope of this spec.

- [ ] **Step 2: Run typecheck on the changed sources**

The full project typecheck (`pnpm typecheck` or `npx tsc --noEmit && npx tsc -p tsconfig.client.json --noEmit`) will fail because of the pre-existing missing optional sandbox packages in `src/escalation.ts`. To verify our changes specifically, run a focused typecheck on just the three touched files:

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict \
  --skipLibCheck --noImplicitOverride --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  src/paths.ts src/policy.ts src/classifier.ts
```

Expected: zero diagnostics from the three touched files.

If diagnostics appear:
- `Property 'extractApplyPatchPaths' does not exist on type 'typeof import("./paths.js")'` — your import line in `src/policy.ts` is missing the new symbol.
- `Module '"node:crypto"' has no exported member 'randomUUID'` — unrelated to this spec (would be in `src/dsh-classifier.ts` which we did not touch).

- [ ] **Step 3: Verify scope (no new files in `src/`)**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git diff --stat 3437cdc HEAD -- src/
```

Expected output (exact values may vary by one or two lines depending on how edits cluster):

```
 src/classifier.ts | ~75 ++++++++++++----
 src/paths.ts      | ~70 +++++++++++++++++++
 src/policy.ts     | ~80 ++++++++++++++++----
 3 files changed, ~225 insertions(+), ~30 deletions(-)
```

If you see additional files under `src/`, e.g. `src/escalation.ts`, that means an untracked touched file snuck in — revert it. If you see zero or near-zero diff in any of the three files, your change did not actually land.

- [ ] **Step 4: Verify the touched test files compile against the new types**

Run:
```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict \
  --skipLibCheck --noImplicitOverride --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --rootDir . tests/classifier.spec.ts tests/policy.spec.ts tests/paths.spec.ts
```

Expected: zero diagnostics. The test files import the new exports (`redactClassifierText`, `extractApplyPatchPaths`) and the new return shapes must match.

- [ ] **Step 5: Manual smoke against `pnpm verify` if dev dependencies are present**

Optional, only if `pnpm install --prefer-offline` has fetched the upstream sandbox packages:

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
pnpm run typecheck
pnpm run test
```

Expected: same as Steps 1 + 2 — all of our tests pass; the two pre-existing sandbox-business file-load failures only happen when `node_modules/` does not include the upstream-added packages.

- [ ] **Step 6: Commit any pending verification artifacts**

If you discovered typos during Steps 1-4 and fixed them inline, commit them:

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git add src/classifier.ts src/policy.ts src/paths.ts \
        tests/classifier.spec.ts tests/policy.spec.ts tests/paths.spec.ts
git diff --cached --quiet || git commit -m "fix(spec-impl): address verification-time adjustments

$(git diff --cached --stat)"
```

If no changes were needed (typical case), this step is a no-op.

- [ ] **Step 7: Tag a temporary local commit and surface the bundle**

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git log --oneline 3437cdc..HEAD
git diff 3437cdc..HEAD --stat
```

Expected: 6 new commits (Tasks 1-5 + final fix if any), all on the same branch as `3437cdc`. The diff stat shows only:
- `src/classifier.ts` (Tasks 2, 3)
- `src/paths.ts` (Task 1)
- `src/policy.ts` (Tasks 4, 5)
- `tests/classifier.spec.ts` (Tasks 2, 3)
- `tests/policy.spec.ts` (Tasks 4, 5)
- `tests/paths.spec.ts` (Task 1)

No other files. This is the acceptance bundle per spec §8.1.

- [ ] **Step 8: Report back to the user**

Run the following one-line summary command and copy the output into your response to the human:

```bash
cd /home/tt-wsl-ubuntu/skills-repo/dsh-auto-mode-ref
git diff 3437cdc..HEAD --stat | tail -10 && \
echo "---" && \
git log 3437cdc..HEAD --oneline
```

Then write a short summary pointing the user at the 6 commits and the test outcomes.

---

## End of Plan

Total estimated time: ~3-4 hours for a subagent that has zero context (Tasks 1-3 ~1.5h, Tasks 4-5 ~1h, Task 6 ~30 min). Subagent-driven execution should produce this in roughly two review cycles per task.

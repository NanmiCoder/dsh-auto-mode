# Docker permission business replay benchmark

This suite compares the **packaged production classifiers** on controlled business operations, then executes each allow decision in a fresh Docker container and verifies actual effects. It does **not** measure autonomous agent planning, the complete permission middleware, or real cloud service integrations. Harness runs on the host in the existing `/tmp` workspace; only the frozen, potentially destructive business commands run in containers. API credentials never enter those containers.

## Frozen design

- 60 cases, 3 repetitions, DeepSeek Harness native route + Jev official + Jev OpenRouter = 540 measured API calls and 540 fresh effect containers. One unrelated warm-up per lane is excluded.
- 58 decidable cases are the primary population. Two deliberately identical visible inputs with different hidden script contents form a separate information-gap probe. Both populations are published.
- 20 paired authorization families change only trusted authority while keeping the pending operation fixed. Remaining cases cover safe alternatives, obfuscation, authority revocation, multilingual instructions, and unresolved choices.
- Labels and effect oracles are fixed before measured calls. Labels follow `CLASSIFIER_SYSTEM_PROMPT`, not a universal definition of business risk. No prompt, threshold, or label tuning based on this run.
- Each case first passes an unconditional execute control and a blocked control: 120 preflight containers. Execute checks exact affected bytes, unchanged siblings, logical SQLite table contents, permission bits, output where applicable, and exact Git remote SHA. Force-push fixtures have verified divergent history. Temporary diagnostic files must be cleaned.
- Unknown effects, command failures, oracle failures, stale images, missing records, duplicate tuples, provider mismatches, and mismatched dataset hashes prevent publication.
- Selection tools in the five `ask` cases are abstract requests mapped to predetermined shell effects. They test premature choice execution, not a shipped tool implementation. These five cases cover four independent choice families.

## Isolation

Runtime containers use `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, an unprivileged UID, bounded CPU/memory/process count, and a disposable 128 MB `/tmp` tmpfs. No host directory, Docker socket, or credential is mounted. Git remotes are real local bare repositories **inside** each container; database operations use real SQLite. Credential fixtures contain only synthetic canaries. This does not test internet exfiltration or a production database server.

The controller selects a frozen case ID and a classifier decision; model output is never used as shell code. Containers are deleted after each case, including runner timeout cleanup. Container startup, setup, execution, and verification time are recorded separately and excluded from classifier latency.

## Measurement

Requests are sequential, with deterministic case shuffling and rotated provider order. Every provider receives the same classifier input and shared policy. The native classifier also generates a reason; Jev uses Choice and a 0.90 allow threshold. These are the actual production adapters, not equal-token model microbenchmarks. Jev response observation decodes a clone within the timer, adding small instrumentation overhead.

Errors and timeouts count as incorrect and fail closed. No measured failure is replaced by a retry. Report accuracy, per-label confusion, unauthorized execution, authorized task completion, p50/p95, and paired speed ratio. Repeated measurements are correlated: confidence intervals resample whole case families. Speed comparison uses successful matched pairs; accuracy delta retains error pairs. An all-zero observed failure rate has a degenerate bootstrap interval; it does not prove zero deployment risk. Synthetic cases, author-defined labels, correlated templates and a single machine/network prevent extrapolation to production prevalence.

The two hidden-script cases intentionally expose the classifier's information boundary: it receives a command path, not script contents. They cannot establish whether one model can reliably detect hidden script behavior. Including both in a single headline accuracy would confound provider quality with information availability, so the report publishes them separately **and** provides all-case metrics.

## Reproduce

Requires Docker, the exact Harness 0.1.5-rc.1 cohort, an already packed plugin artifact, and existing credentials outside the repository. The base Node image is digest pinned. Debian package versions are captured in the report; rebuilding later can resolve different Debian packages, so compare the recorded built image ID and source hashes.

```sh
docker build -t dsh-auto-permission-benchmark:v2 benchmarks/docker-permission
node benchmarks/docker-permission/preflight.mjs /tmp/my-permission-oracle
```

Preflight validates both image-internal source hashes against the host. Create a private configuration file outside the repository:

```json
{
  "repetitions": 3,
  "oracleFile": "/tmp/my-permission-oracle/oracle.json",
  "jev": [
    { "id": "jev-typesafe", "provider": "typesafe", "keyFile": "/private/path/typesafe-key" },
    { "id": "jev-openrouter", "provider": "openrouter", "keyFile": "/private/path/openrouter-key" }
  ]
}
```

```sh
AUTO_ACCEPTANCE_DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" \
AUTO_ACCEPTANCE_BENCHMARK_CONFIG=/private/path/config.json \
AUTO_ACCEPTANCE_SOURCE_ROOT="$PWD" \
node scripts/acceptance/run-real-api.mjs \
  /path/to/exact-runtime /path/to/plugin.tgz /tmp/my-permission-run \
  headless scripts/acceptance/docker-benchmark-driver.mjs

node benchmarks/docker-permission/report.mjs \
  /tmp/my-permission-run /tmp/my-public-permission-report
```

The run can finish with exit code 1 when measured model errors occurred while still producing a complete report. A missing report or incomplete grid is a failed benchmark run, not a passing result. Raw response explanations, API usage and full effect traces remain outside the repository. Public measurements contain only case IDs, labels, timings, decisions, changed path names and oracle status. Published summaries can be recomputed from those measurements with `benchmarks/permission/metrics.mjs`.

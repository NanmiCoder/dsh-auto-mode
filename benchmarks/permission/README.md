# Permission benchmark

See the [benchmark protocol](../../docs/jev-benchmark-protocol.md) for dataset scope, methodology, metrics and reproducible commands, and the [2026-09-20 report](../../docs/jev-benchmark-2026-09-20.md) for measured results.

- `cases.mjs`: synthetic policy cases and host-only labels.
- `metrics.mjs`: error-inclusive accuracy, confusion matrices and family-cluster intervals.
- `report.mjs`: whitelist report generation from raw results outside the repository.

For real filesystem, SQLite and Git effect verification, see the [Docker business replay suite](../docker-permission/README.md). Its results are separate from this synthetic-input benchmark.

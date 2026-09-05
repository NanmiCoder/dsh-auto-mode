# DSH maintenance skills

Seven maintenance skills are vendored unchanged from [oh-my-dsh/dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/cd4d497588cdd4f16300622779b62a78fe803169). `upstream-lock.json` pins their source commit and SHA-256 hashes; the accompanying MIT license is retained. `.agents/skills` links to these canonical copies. They are development guidance, not npm runtime dependencies.

Use `plugin-workflow` to track the work, `plugin-upgrade` and `dsh-upgrade-audit` to inspect exact contracts, `plugin-runtime-debug` to reproduce installed failures, `plugin-test` to validate the actual package in Harness, and `plugin-release` for artifact and channel checks. `plugin-write` supplies implementation conventions.

Project rules override historical examples: query the official registry, keep the full DSH dependency cohort exact, and declare support only for tested versions. Old claims that all Alpha packages are unpublished, wide peers imply support, or deleting a Git tag rolls back npm are not this project's policy. Preserve immutable releases; recover by installing a previously tested exact pair or adjusting an npm dist-tag explicitly.

The user may authorize the complete lifecycle in one request. Generic skill confirmation templates do not require repeating that approval. Browser work uses Ego Lite; model acceptance uses a real provider and the existing `/tmp` workspace. Unit tests, fixture models, and HTTP 200 alone do not establish real API or Web compatibility.

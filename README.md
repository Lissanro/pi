# Pi Crystal

Pi Crystal is a fork of the Pi agent harness ([earendil-works/pi](https://github.com/earendil-works/pi)). It grew out of running Pi against local models (llama-server) in long iterative sessions, and the changes reflect that: copying multiline text out of the terminal stays free of whitespace padding, compaction keeps the provider KV cache valid as much as possible, and every message in the session, including thinking blocks, can be edited, forked, or continued at will.

## Slash commands

- `/edit [N | substring]` loads messages into the editor as `<pi_edit>` blocks (an XML-like form that preserves reasoning blocks and tool calls; inner tags need no escaping, the parser figures out the structure around them, so copying and pasting stays easy). Sending the blocks rewrites history without calling the model.
- `/copy [N | substring | text]` copies the last message, an indexed message, every message matching a substring, or arbitrary typed text.
- `/delete [N | substring]` deletes the last N messages, or the single message matching a substring. Also, when targeting message with tool call, it deletes the tool call output first while leaving the message intact - this is useful when some tool call produced way too long output, and it is faster to stop, delete long output and provide the model short summary or guidance how to avoid too long output while still having the command it ran in context.
- `/fork [N | substring]` branches the session from any message, user or assistant.
- `/continue` resumes generation without adding a user message. It can also continue a partial assistant message (prefill continuation), even mid-thought, on supported OpenAI-completions providers: currently [llama.cpp-f3zz1k-prefill](https://github.com/Lissanro/llama.cpp-f3zz1k-prefill), which adds the prefill API and also resumes interrupted tool calls.
- `/schedule` sends a message later: with no parameters it fires after the current task completes; it can also fire after N messages, after a duration (`1h 30m`), at a local time, or as a delayed continue or edit+continue. `-N` cancels.
- `/compact` compacts the session. Parameters set the budget as the number of recent messages to keep or as tokens (`10`, `20K`, `1M`; when both apply, the smaller budget wins), plus optional free-text focus for the summary.

## Continuation and resilience

Retries are unlimited by default for prompts, /continue, /compact, and auto-compaction, with exponential backoff capped at 30 seconds, so when the model server goes down Pi Crystal keeps retrying and continues the turn once it is back, local or remote. When the server dies mid-stream, prefill continuation of the interrupted response takes priority over queued steering messages, and with [llama.cpp-f3zz1k-prefill](https://github.com/Lissanro/llama.cpp-f3zz1k-prefill) an echo check verifies the provider actually continued the same text before trusting it.

## Compaction

The summarization request carries exactly what the chat contains - system prompt plus unaltered history, with any previous summary in its natural position - minus only the preserved tail, plus the instruction at the end, so provider KV caches stay valid across compactions. The summary becomes a normal user/assistant message pair at the cut point, followed by the kept messages. Ctrl+O on a compaction summary shows the full model-visible context, and a failed or cancelled compaction restores the kept messages.

## Rendering

Rendered lines carry only their own content: no padding by default and no inserted line breaks, so copying multiline text with the mouse produces exactly what was written, and code blocks render verbatim. The upstream look is one setting away: `padLines` (full-width padding), `wrapLines` (wrap with newlines at the terminal width), `messageBackground`, and `messageSeparator`.

## Footer stats

The footer shows the session's token usage and context state on the status line. Each item reads as follows: `↑` is total input tokens, `↓` total output tokens, `R` prompt-cache read tokens, `W` prompt-cache write tokens, `CH` the latest prompt-cache hit rate, and `$` the estimated cost. The context indicator shows the current context over the model's context window with the percentage, e.g. `89k/256k (34.7%)`, so the current context length is directly readable; `?` means the count is unknown (e.g. right after compaction, before the next response). The `k`/`M` suffixes divide by the `tokenCountBase` setting (default 1024, matching model context windows: a 256K window renders as `256k`; set it to 1000 for decimal), which can be changed in `/settings`.

The `$` cost is computed from the model's per-million-token rates, so it stays absent (no `$`) for local models unless you give them a cost. To track energy or hardware cost for a local model, set its `cost` in `~/.pi/agent/models.json`; for example `{ "input": 1, "output": 3, "cacheRead": 0.1, "cacheWrite": 0.5 }` sets rates in dollars per million tokens, with an optional `tiers` array for cheaper rates above an `inputTokensAbove` threshold. See [packages/coding-agent/docs/models.md](packages/coding-agent/docs/models.md) for the full schema.

## Framing and providers

The default system prompt is a factual reference: a tool inventory and the documentation locations. Compaction and summary prompts use neutral direction labels (INCOMING/OUTGOING/TOOL). The `incomingMessagePrefix` setting prepends text to each user message when it is sent to the model; the session file keeps the typed text.

Cloud providers work by default exactly as upstream (same API keys and /login flows). To hide them from the model list for a local-only setup, set `PI_DISABLE_CLOUD_PROVIDERS=1`. The retry backoff cap is `retry.maxBackoffMs` (default 30000, i.e. 30 seconds).

## About

Pi Crystal started as a personal project for myself and my wife, tuned for long sessions on local models. When some people on Reddit showed interest in /edit and the other slash commands, I decided to share it. You are welcome to use the code for any purpose, including upstreaming any parts into Pi itself if you find them useful. Issues and pull requests are welcome.

---

# Pi Crystal Agent Harness

* [Read the documentation](https://pi.dev/docs/latest) - most of it still applies to Pi Crystal, except the fork features described above; you can also ask the agent to explain itself
* [Visit pi.dev](https://pi.dev) - website of the project Pi Crystal is forked from, big thanks to the original author for making Pi open source

## Permissions & Containerization

Pi Crystal, just like the mainline Pi, does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules.

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

## License

MIT

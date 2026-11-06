# Pi Crystal

Pi Crystal is a fork of the Pi agent harness ([earendil-works/pi](https://github.com/earendil-works/pi)). It grew out of running Pi against local models (llama-server) in long iterative sessions, and the changes reflect that: copying multiline text out of the terminal stays free of whitespace padding, compaction keeps the provider KV cache valid as much as possible, and every message in the session, including thinking blocks, can be edited, forked, or continued at will.

## Slash commands

- `/edit [N | substring | swipe [N]]` loads messages into the editor as `<pi_edit>` blocks (an XML-like form that preserves reasoning blocks and tool calls; inner tags need no escaping, the parser figures out the structure around them, so copying and pasting stays easy). Sending the blocks rewrites history without calling the model. Editing the latest message creates a new swipe version instead of replacing it in place; older messages are edited in place. `/edit swipe [N]` edits a specific swipe version in place via `<pi_swipe>` blocks, never creating a version and never changing its position.
- `/copy [N | substring | text]` copies the last message, an indexed message, every message matching a substring, or arbitrary typed text.
- `/delete [N | substring | swipe [N]]` soft-deletes the last N deletable units of the visible context - each tool result, each tool call (removed while keeping the message and its text), the message itself once no tool calls remain, and each compaction boundary, which un-compacts the summarized range - keeping them recoverable in the session file. A substring targets a single message. `/delete swipe [N]` marks the selected swipe versions deleted.
- `/restore [N | swipe [N]]` brings back soft-deleted units (latest deletion first) or deleted swipes of the current context. `/shred [N | substring | swipe [N]]` removes the same units permanently with no undo.
- `/fork [N | substring]` branches the session from any message, user or assistant.
- `/continue` resumes generation without adding a user message. It can also continue a partial assistant message (prefill continuation), even mid-thought, on supported OpenAI-completions providers: currently [llama.cpp-f3zz1k-prefill](https://github.com/Lissanro/llama.cpp-f3zz1k-prefill), which adds the prefill API and also resumes interrupted tool calls. An aborted or edited trailing message is picked up as a prefill continuation candidate.
- `/swipe` regenerates the latest response (the only regeneration entry point) and navigates its versions: `/swipe N` goes to version N, `/swipe +N` / `/swipe -N` jump relative, `/swipe prev` / `/swipe next` step by one. The reasoning block, content block, and all related tool calls count as one message; versions root at assistant entries that share the same parent. `/swipe list [section] [selector] [+chars]` prints a summary (first chars of reasoning and content, one `name(args)` line per tool call; section is `content`, `reasoning`, or `tool`, and the char count defaults to the `swipeSummaryChars` setting), and `/swipe search|isearch [selector] "string" [charspec]` finds matches across reasoning, content, and tool call arguments. Selectors are comma-separated integers, `a-b` ranges, and `-N`.
- `/schedule` sends a message later: with no parameters it fires after the current task completes; it can also fire after N messages, after a duration (`1h 30m`), at a local time, or as a delayed continue or edit+continue. `-N` cancels.
- `/heartbeat` sends a message or continue repeatedly: every duration (`3h`) or daily at a local time (`15:23`). `list` (or no arguments) lists entries with time left or paused, `cancel <id>` cancels one, `pause` / `continue` toggle, `save` / `load` persist to and restore from HEARTBEAT.md, `-N` cancels the last N.
- `/compact` compacts the session. Parameters set the budget as the number of recent messages to keep or as tokens (`10`, `20K`, `1M`; when both apply, the smaller budget wins), plus optional free-text focus for the summary. A `/compact` queued during streaming runs at the turn boundary, and `cancel` cancels a queued or in-progress compact.

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

The default system prompt is a factual reference: a tool inventory and the documentation locations. The effective system prompt and skill set are saved with each session and restored verbatim on resume, so the model's prefill cache survives edits to `APPEND_SYSTEM.md`; pass `--update-system-prompt` to force a rebuild from current files. `/update [all|system-prompt|skills]` reloads the prompt and/or skills from current files, and `/system-prompt` shows, sets, or clears it. Compaction and summary prompts use neutral direction labels (INCOMING/OUTGOING/TOOL). The `incomingMessagePrefix` setting prepends text to each user message when it is sent to the model; the session file keeps the typed text.

Cloud providers work by default exactly as upstream (same API keys and /login flows). To hide them from the model list for a local-only setup, set `PI_DISABLE_CLOUD_PROVIDERS=1`. The retry backoff cap is `retry.maxBackoffMs` (default 30000, i.e. 30 seconds).

## About

Pi Crystal started as a personal project for myself and my wife, tuned for long sessions on local models. When some people on Reddit showed interest in /edit and the other slash commands, I decided to share it. You are welcome to use the code for any purpose, including upstreaming any parts into Pi itself if you find them useful. Issues and pull requests are welcome.

---

# Pi Crystal Agent Harness

* [Read the documentation](https://pi.dev/docs/latest) - most of it still applies to Pi Crystal, except the fork features described above; you can also ask the agent to explain itself
* [Visit pi.dev](https://pi.dev) - website of the project Pi Crystal is forked from, big thanks to the original author for making Pi open source

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Object runtime for apps across processes: contracts, documents, a store, links, plugins with hot reload, HTTP, workers, web and terminal clients |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

The repo also carries internal workspace packages not in the table: `packages/client`, `packages/protocol`, `packages/server`, `packages/orchestrator`, `packages/session-backends`, and `packages/evals`. For Slack/chat automation see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi Crystal, just like the mainline Pi, does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules. Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

## License

MIT

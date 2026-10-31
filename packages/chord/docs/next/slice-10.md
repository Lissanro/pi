# Slice 10: HTTP and workers (spec)

Status: **ready for the owner's approval** (owner, 2026-10-30: D1-D12, D10b and the spec review's R1-R6 in the decision
"Slice 10's points"; spec reviews by Fable and Opus, `/tmp/s10-spec-review-{fable,opus}.md`, folded in).
Slice 10 builds two Node components of the app kit (decision "Slice 7b's open points" (6)): `chord/next/http` (the
server's HTTP and WebSocket entry, routes contributed by plugins through a registry, responses as descriptions) and
`chord/next/workers` (a worker process per host address, started on demand, stopped when idle, its plugins shipped from
the server). Both live in `packages/chord/src/next-node/` (Node-only); the kernel stays portable. The web page host and
the TUI are slice 11, telemetry slice 9.

Read in full before writing code: this spec; `decisions.md`; `design.md` (§3 hosts, routes, `host.activity`, §17,
§18, §21 "Loading plugins and the reload loop", §23 in full); `slices.md`; `slice-7c.md` and
`src/next-node/plugins/README.md`; the 7b brief `slice-7b/book.md` (chapters "Assets and Files", "HTTP", "A Mini p2
from Chord"); p2's `src/hosts/server.ts`, `src/runtime/server.ts`, `src/hosts/worker.ts`, `src/hosts/socket-limits.ts`,
`src/hosts/principals.ts`, `plugins/files/server.ts`, `plugins/terminals/server.ts`, `plugins/radius/server.ts`; Chord
v1's `src/manager.ts` (`processLock`, `forkDriver`, `createHostManager`, `childControl`).

## 1. What p2 has, and what moves into Chord

p2's server host (`src/hosts/server.ts`, 742 lines; `src/runtime/server.ts`, 720) does, besides p2's own policy:

| p2 today | Moves to |
| --- | --- |
| a Node `http` server on loopback, requests parked until `load` resolved, upgrades captured before listening | `http` |
| `Routes` (`"METHOD /path"`, `/prefix/*`), handlers writing Node's `ServerResponse` themselves (ranges, download headers, `HEAD` by hand in `files`) | `http`: routes returning descriptions |
| `Upgrades` (a WebSocket by path for terminals and voice), `/chord` (`acceptWebSockets` with per-socket limits) | `http` |
| `Authenticators`, `RequestResolvers` (cookies, devices, the Radius relay), Fetch Metadata, CSP and the loopback cookie | the app (p3's base code), through `http`'s `authenticate` and `headers` (D3) |
| loopback and allowed hosts, the `Origin` check on upgrades | `http` (R4), allowed hosts contributable by plugins |
| `SessionHosts`: a worker per session, `createHostManager` + `forkDriver`, a kernel lock per session, idle stop from reported counts, crash notices, sticky failed starts, ready timeout | `workers` (failures stay until Retry or a rollout, R2) |
| relocation and pause of a worker, the catalog, `WorkerInitValues` | the app (built on `workers`' `stop` and start data) |
| `hosts/worker.ts`: the child's control channel, lock, start data, connect, load, report counts, shutdown | `workers`' child side |
| the dev reload across server and workers, worker plugin lists | `plugins` (7c) plus `workers`' rollout step (§4) |

Every option that is not bootstrap is changeable by plugins (decision "The app kit is malleable by plugins"): either a
contribution to `Http` or a function the component calls per use, which the app backs with its own registries;
nothing is copied out of a contribution or an option at startup. Bootstrap (changed by a restart): the listen address
and port, the links path, the worker entry with its `execArgv` and `env`, the host kind workers serve.

## 2. `chord/next/http`

```ts
const http = await httpServer(server, {
	listen: { host: "127.0.0.1", port: 8788 },                       // bootstrap
	allowedHosts: () => app.allowedHosts(),                           // besides loopback and contributed `hosts` (R4)
	authenticate: (request, ctx) => app.principalOf(request, ctx),    // D3: the app's policy, per request and upgrade
	headers: (request, principal) => app.securityHeaders(request, principal),   // every response, also a 404 or a 403
	links: { path: "/chord", limits: { part: 16 * MiB, decoded: 64 * MiB }, maxPayload: 64 * MiB },
	onError: (error) => log(error),                                   // `HttpError`, below
}, ctx);
// the component's facet goes into the plugins component's core, so every reload passes it unchanged (7c)
await plugins.load(server, { kind: "server", core: [{ name: "@app/core", facet: core }, { name: "chord.http", facet: http.facet }] }, ctx);
…
await http.close(ctx);   // stops accepting, closes sockets, waits for running requests (bounded by `closeTimeout`)
```

- **Order:** `httpServer` listens at once (plugins see the real port; a page reconnecting while plugins load is not
  lost). A request or upgrade waits in `host.registry(Http, ctx)` (the publication and the router's first `compose`;
  503 after `readyTimeout`); nothing waits for the start barrier (a route's `ctx.get` waits for its object, and `/chord`
  holds are placed by the publication gate).
- **Checks before anything else** (R4), in order: the `Host` header is loopback (`127.0.0.1:<port>`, `localhost:<port>`)
  or allowed (`allowedHosts()` plus every contribution's `hosts`), else 403; an upgrade's `Origin`, when sent, equals
  the request's origin, else 403; `request.origin` is built only from an accepted `Host` (`http://` on loopback,
  `https://` for an allowed host). Then `authenticate`.
- **`Http`** (D1): the registry `"chord.http"` (version 1), defined and served by the component's own facet; its
  `compose` builds the router from every contribution `{ routes?, wraps?, sockets?, hosts? }`; a contribution may be a
  writable (a plugin that adds and removes its tunnel host at runtime). Each request uses the router as it was when it
  started.

```ts
// plugins/notes/server.ts
export default defineFacet((host, self) => {
	self.contribute(Http, {
		routes: {
			"GET /notes/:id/export": async (request, ctx) => {
				if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
				const notes = await ctx.get(NoteStore, {});
				return { kind: "json", value: await notes.export({ id: request.params.id }, ctx) };
			},
			"GET /notes/template.md": async () => fileResponse(pluginFile("template.md"), { download: "template.md" }),
		},
		wraps: [{ name: "audit", phase: "observe", wrap: async (request, next, ctx) => audited(await next(request), ctx) }],
		sockets: { "/terminal": (socket, request, ctx) => terminals.attach(socket, ctx) },
	});
});
```

- **A request's scope:** one `host.root` scope with the request's principal (`ctx.principal`, `undefined` when
  `authenticate` found none) spans matching, wraps, the route and the whole write of its response; its signal aborts
  when the client disconnects. A socket handler's scope lasts until the socket closes.
- **`HttpRequest`:** `method`, `path`, `params`, `query` (`URLSearchParams`), `headers` (lowercased, read-only),
  `origin`, `json(limit?)`, `body(limit?)` (D4). `json` parses at most `limit` bytes (1 MiB by default) into a
  `JsonValue`; `body` is an async iterable of `Uint8Array` chunks, failing past `limit`. Both throw an `HttpFailure`
  carrying its status (400 malformed, 413 too large); if it escapes the route, that status is the answer (not 500). A
  body nobody read is drained up to 64 KiB after the response, else the connection closes (`Connection: close`).
- **Patterns** (D8): exact segments, `:name` (one non-empty segment, percent-decoded) and a trailing `/*` (the rest,
  possibly empty: `/files/*` matches `/files`); `params["*"]` is decoded per segment, and a segment that decodes to
  contain `/` or is `.` or `..` is answered 400. The most specific match wins, segment by segment from the left (exact
  before `:name` before `*`); one pattern from two contributions is a reported conflict (`registry_conflict`), the first
  by plugin name wins. `HEAD` falls back to the `GET` route. No route: 404.
- **Wraps** (D2): `{ name, phase, scope?, route?, wrap(request, next, ctx) }` in the phases `observe`, `headers`,
  `transform` (outermost first), within a phase in contributor order (plugin name, then type); `scope: "own"` (default:
  around the contributing plugin's own routes) or `"all"`; `route` narrows to one pattern (a missing one is a reported
  conflict). A wrap adds a boundary on top of a route's checks, never instead of them. A throwing wrap is a 500,
  reported naming its plugin.
- **Responses** (D5, R6):

```ts
type HttpResponse = { readonly headers?: Readonly<Record<string, string>> } & (
	| { readonly kind: "json"; readonly value: JsonValue; readonly status?: number }
	| { readonly kind: "html"; readonly body: string; readonly status?: number }
	| { readonly kind: "bytes"; readonly mime: string; readonly size?: number;
	    readonly read: (offset: number, length: number, ctx: Ctx) => Promise<Uint8Array>;
	    readonly download?: string; readonly ranges?: boolean }
	| { readonly kind: "redirect"; readonly to: string; readonly status?: 302 | 303 | 307 }
	| { readonly kind: "error"; readonly status: number; readonly message?: string });
```

  Headers: the `headers` option's first, then the response's own, replacing same-named ones (case-insensitive: an
  artifact preview sets its own CSP). `bytes` with a `size`: `Content-Length`; with `ranges`, one range gets 206 and an
  unsatisfiable one 416, a multi-range request gets 200 with the whole body; `HEAD` sends headers only; `download`
  sets `Content-Disposition: attachment` with an ASCII fallback and `filename*`. `bytes` without a `size` (R6): chunked
  encoding, no ranges, `read` called with growing offsets until it returns an empty chunk. Reads are 64 KiB with the
  socket's backpressure (`drain`), stopped when the client disconnects; a `read` returning fewer bytes than asked with a
  `size` set destroys the connection (reported). A throwing route is a 500 without its message (reported).
- **`fileResponse(path, { download?, ranges?, mime? })`:** `stat`s at once, opens its file handle on the first `read`
  and closes it when the request's scope seals, so an unwritten response (`HEAD`, a 416, a disconnect, a wrap that
  replaced it) opens nothing or leaks nothing. Without `mime` it picks from a small fixed table by extension (text,
  images, audio, video), else `application/octet-stream`; active types (HTML, SVG) only when the route names them.
- **Sockets** (D6): `sockets: { "/terminal": (socket, request, ctx) => … }`, patterns as routes. After the checks and
  `authenticate` (no principal: 403 before plugin code), the component upgrades and hands the handler a `ws`
  WebSocket with an `error` listener already attached (an oversized frame closes it, never the server); per contribution
  options `maxPayload` (1 MiB by default) and no `perMessageDeflate`. Wraps do not apply.
- **The links endpoint:** `links.path` upgrades to `host.accept(webSocketLink(socket), { principal, limits }, ctx)`,
  with a per-socket output cap (p2's `limitedSocket`: a client that stops reading past 4 MiB unsent is cut off) and the
  transport's `maxPayload`.
- **Errors** (`onError`, `HttpError`): `route_failed { pattern, plugin, error }`, `wrap_failed { name, plugin, error }`,
  `socket_failed { pattern, plugin, error }`, `response_failed { pattern, error }` (a short `read`, a write error).
- `ws` is an optional peer dependency (D7), imported only here.

## 3. `chord/next/workers`

```ts
// server.ts
const workers = createWorkers(server, Session, {
	entry: "./worker.ts", execArgv: ["--import", resolver], env: { … },              // bootstrap
	authorize: (principal, address) => app.mayReach(principal, address),              // the route's `authorize`
	principal: (address) => ({ kind: "worker", session: address.params.id }),
	start: (address, ctx) => app.startData(address, ctx),                             // JSON, before each start
	lock: (address) => `app:${realpath(dataDir)}:worker:${address.key}`,              // one live worker per address
	idleMs: () => app.idleMs(),
	plugins,                                                                          // the plugins component
	onOutput: (address, stream, chunk) => logs.append(address.key, stream, chunk),
	onError: (error) => log(error),                                                   // `WorkersError`, below
}, ctx);
workers.state                              // JSON watchable (R5)
await workers.stop(Session({ id }), ctx);  // archive: suspended, then stopped; a held reference just waits
await workers.retry(Session({ id }), ctx); // the Retry button: a failed or suspended address resolves again
await workers.close(ctx);                  // after `server.close`: no new starts, every child stopped
```

```ts
// worker.ts
await workerMain(async ({ address, start, parent, plugins }, ctx) => {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(start.dir, "session.sqlite"))), ctx);
	const worker = createHost<P>({ address, principal: { kind: "worker", session: start.id }, store, onError });
	worker.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);   // W6: connect, then load
	await plugins.load(worker, { kind: "worker", core: [{ name: "@app/core", facet: coreWorker(start) }] }, ctx);
	return { host: worker, busy: harness.activeTasks, close: (ctx) => store.close(ctx) };
}, { onError: (error) => log(redact(error)) });
```

- **The route:** `createWorkers` calls `host.route(Kind, { authorize, resolve }, ctx)` itself and keeps the
  `RouteHandle` (`retry`, `suspend`: D10b, R1).
- **A start** (`resolve(address)`): one queue per address orders starts, stops and exits (a start waits for the
  previous child's exit; a stop during a start waits for it, then stops; an aborted start kills its child). A start
  calls `start(address, ctx)` (a throw rejects the start), forks `entry` (`serialization: "advanced"`, a detached
  process group, stdout and stderr piped: the stderr tail kept, mirrored to the server's when there is no `onOutput`),
  makes `ipcLink(child)` at once (so the child's `hello` and early holds are queued, never lost), and sends the start
  message `{ address, start, scripts, lock }` (`scripts`: the worker kind's complete current scripts, below). The child
  takes the lock (waiting for a draining old worker to let it go, within the start timeout), connects and sends
  `started`; `resolve` then returns `{ link, principal: principal(address), trusted: true }`, so the handshake and the
  worker's server traffic run during its `load`. `ready` (after the app's function returned) ends the start timer (60
  s from the fork; past it the tree is killed and the start fails).
- **Workers never restart by themselves** (R2): a crash (an exit nobody asked for) or a failed start (a `start` that
  threw, a lock not taken in time, `fatal`, the start timer) leaves the address `failed` with its error
  (`worker_failed` reported once); `resolve` of a failed address rejects at once with that error, so its holders and
  new holds see `failed`, and nothing forks. `workers.retry(address)` (`RouteHandle.retry`) or a rollout that reaches
  workers clears it. An idle stop or `stop` is no failure: the next hold starts it on demand.
- **Keep-alive** (D9, R3): the child watches `host.activity` and the app's `busy` (a JSON watchable of numbers) and
  sends `{ idle: true }` when every count becomes zero, `{ idle: false }` when one becomes nonzero; a rollout applying in
  the child counts as busy. The server stops a worker idle since `idleMs()` (5 min by default; checked every second),
  never while it starts. A stop (idle, `stop`, `close`): `shutdown`; the child closes its host, runs the app's `close`,
  exits; it forces its own exit after 3 s; the server kills the tree after 5 s.
- **`state`** (R5): per address key `{ status: "starting" | "running" | "stopping", pid, startedAt }` or `{ status:
  "failed", error: { message, code?, reason? }, at, stderrTail? }`; no entry when stopped or never started.
- **`stop(address, ctx)`:** `RouteHandle.suspend(address)` (holders stay `loading`, nothing resolves it), then the
  stop; `retry(address)` lifts the suspension. **`close(ctx)`:** new starts reject `unavailable/closed`, every child is
  stopped (grace, then kill), the timers cleared; `createWorkers`'s `ctx` aborting closes it too.
- **The child** (`workerMain(fn, { onError })`): reads the start message, takes the lock, makes `ipcLink(process)`,
  calls `fn({ address, start, parent, plugins }, ctx)`; `started` once connected, `ready` once `fn` returned; reports
  `idle` flips; handles `shutdown`, the parent's disconnect, `SIGTERM` and `SIGINT` alike (close the host, the app's
  `close`, exit); an uncaught error is sent as `fatal { message, code?, reason? }` through `onError` (the app redacts),
  then the child exits.
- **Control messages** (JSON beside the link's `Uint8Array` frames; the IPC link skips them): parent to child `start`,
  `shutdown`, `reload { scripts }`; child to parent `started`, `ready`, `idle { idle }`, `fatal { error }`, `reloaded
  { report } | { error }`. Errors cross as `{ message, code?, reason? }` (a structured clone keeps no `ChordError`).
- **Errors** (`onError`, `WorkersError`): `worker_failed { address, error, stderrTail? }`, `worker_exited { address,
  code, signal }` (a clean exit after a stop is not reported).

### Plugins in workers (D11)

Workers never build. The plugins component (7c) gets `scripts(kind, ctx)`: the complete current set of one kind (every
discovered plugin's facet of it, built on first use, then updated by every rollout that ships that kind), each with its
plugin record (`name`, `dir`, `chord.external`). The component's per-host loading (its loaded map, `#prepare`, `adopt`,
the queue per host) moves into a file without esbuild or the watcher, `createPluginRuntime({ hostPackages, onError })`
with `load(host, { kind, core, scripts }, ctx)` and `reload(host, shipped, ctx)`; `createPlugins` uses it, and the
child's `plugins` is one (`import` of `chord/next/plugins/runtime` loads no esbuild).

## 4. The rollout across server and workers

```ts
const built = await plugins.build(plugins.state.value.dirty, ctx);
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);
// result.steps: [{ name: "server", hosts: [{ host: "server", report }] },
//                { name: "workers", hosts: [{ host: "session|S1", report }, { host: "session|S2", error }] }]
```

`RolloutStep.reload(built, ctx)` returns `{ hosts: readonly ({ host: string; report: ReloadReport } | { host: string;
error: { message, code?, reason? } })[] }` (D12; 7c's in-process step returns a list of one, its `host` the name given to
`step`). `workers.step(name)` first replaces the workers' current set (`plugins.scripts`), then ships the change to
every worker whose start message or last reload carried an older set, starting ones included (a child queues a reload
that arrives before its `ready` until its load is done); workers reload in parallel; one that closed or failed during
the step is listed with its error and does not stop the rollout, and every plugin of its kind in the build counts as
failed there (stays dirty). A rollout that reaches workers clears every failed address (R2). A plugin's dirty mark
clears only when it applied on every host of every step.

## 5. Not in slice 10

The web page host, the browser's evaluation of scripts and serving them (slice 11); the TUI (slice 11); relocation and
pause of workers (the app's: `start(address)` is where the app awaits its own barrier); request resolvers and
authenticators as registries (the app's); chunked transfers as a Chord helper (an owner pattern, design §23); the
channel component (D6); telemetry spans for requests (slice 9).

## 6. Kernel changes

- `host.route(Kind, options, ctx)` returns a `RouteHandle { retry(address), suspend(address) }` (D10b, R1).
- A route has no backoff timer (R2): a rejected `resolve` or a link closed at once fails the route's holders with its
  error (`failed`, not `loading`); the route resolves again only for a new hold, on `retry`, or once after the
  address's link dropped while holds exist; a suspended address resolves nothing until `retry`.
- Design §3's paragraph on a `resolve` waiting for the worker's `load` (a deadlock) is updated: 7a's barrier ends its
  first pass on a wait on another host, and `resolve` returns the link before `load` anyway.

## 7. Tests, examples, cost

- One test file per source file. HTTP: listening before the publication (a request waits, then is served; 503 past
  `readyTimeout`); `Host` and `Origin` checks, allowed hosts from the option and from a writable contribution changing
  at runtime; authentication per request and upgrade; patterns, decoding, precedence, `HEAD`, 404; conflicts reported;
  wraps (phases, order, scopes, a missing route, a throwing wrap); every response kind (ranges 206/416, multi-range,
  `HEAD`, download names, chunked without `size`, a short `read`, a disconnect stopping `read`, header merging);
  `json`/`body` limits and their statuses, an unread body; a throwing route; the links endpoint (`host.accept`, a
  refused socket, the output cap); plugin sockets (an oversized frame closes only that socket); a reload swapping a
  route while a request runs on the old router; `fileResponse` closing its handle on every path; `close`. Workers: a
  start on the first hold; the link made at the fork (a load longer than the heartbeat's 30 s binds); the lock (a
  draining old worker waited for); the start timer; `start` throwing; a crash and a failed start staying failed (no
  fork for a new hold), `retry` and a rollout clearing it; idle stop and a hold keeping it; `busy`; the `idle` flips (no
  message per call); `stop` with holders (suspended: no restart); stop during start and start during stop; `close`;
  the rollout step (a worker starting during it gets the new set; a failed worker listed); the child's shutdown,
  disconnect and signals. Kernel: `RouteHandle.retry` and `suspend`; no re-resolve without a hold, a retry or one drop.
- GC: requests (their scopes, bodies, file handles) and stopped workers' state collected; no listener left on a closed
  socket; 1,000 addresses started and stopped leave no `state` entries.
- Examples (each a folder, as 7c's): `40-http` (routes, a wrap, a download with ranges, a socket, an allowed host
  added at runtime), `41-workers` (a server routing a session kind to forked workers, idle stop, a crash staying failed
  until Retry, a rollout reaching the workers).
- Benchmark: a route's overhead per request against a plain Node handler (bar: within 10% of a keep-alive round
  trip; Opus measured 2.5 µs of 54 µs); `bytes` throughput for a 100 MiB file against `pipeline`; a worker's cold start
  (fork to `ready`) with shipped scripts; memory per idle worker on the server.

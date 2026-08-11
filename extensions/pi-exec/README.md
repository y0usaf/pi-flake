# pi-exec

Single dispatch tool for Pi. Routes built-in tool calls through one `exec`
tool. Default routes mirror pi's live active set: built-ins active at session
start (normally read/bash/edit/write — grep/find/ls are off in stock pi) plus
every route published to the shared registry. Enabled routes are removed from
the active tool set so the model reaches them only via exec; everything else
stays untouched.

`/exec-tools` opens an interactive toggle list (same UI pattern as pi-tools'
`/tools`) over all candidate routes. The selection persists to
`~/.pi/agent/pi-exec.json` and re-registers exec live.

Other extensions can pipe their tools through exec by publishing a
ToolDefinition to the shared registry (no dependency on this package):

```ts
const routes = ((globalThis as any)[Symbol.for("pi-exec.routes")] ??= new Map())
routes.set(def.name, def)
```

Registry routes shadow same-named built-ins (e.g. pi-hashline's `read`/`edit`),
and their descriptions + promptGuidelines are folded into exec's guidelines so
the model still sees their contracts.

Frontend is delegated: exec forwards `renderCall`/`renderResult` to the
routed built-in's own renderers (diffs, syntax highlighting), substituting the
inner params for `context.args`.

## Always async

Every non-`job` exec call spawns a fire-and-forget job. The model gets a
quick response with a job id and must collect results with route `job`:

- `exec { "route": "read", "params": { ... } }` → `spawned job-1 (route=read). Collect: exec route "job", params { id:"job-1" }`
- `exec { "route": "job", "params": { "id": "job-1" } }` → actual read result

Cost: every call adds an extra collect turn. Deliberate trade-off — the model
never blocks on slow tasks, and all results stream through the same
collection route.

## Why

- One tool the LLM sees for base ops. Simple system prompt, clearer choice.
- Parallelism preserved: call `exec` N times in one turn, Pi runs them
  concurrently.
- Always async means no tool call can hang the dispatcher.

## Known limit

The public ExtensionAPI exposes no execute handle for other extensions' tools
(`pi.getAllTools()` is metadata only, there is no `pi.invokeTool()`), so exec
cannot route built-in overrides like a custom `read` from another extension.
Dynamic routing needs an upstream API.

## Usage

```
pi -e ./src/index.ts
```

Or as a Pi package (installed via `pi install`).
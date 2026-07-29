# pi-extensible-workflows

![pi-extensible-workflows workflow banner](https://raw.githubusercontent.com/vekexasia/pi-extensible-workflows/main/assets/pi-extensible-workflows-banner.png)

> There are many workflow extensions but this one is **Yours.**

Turn multi-agent tasks into deterministic jobs that fan out in parallel, pause for approval, and resume without rerunning completed work.

[Documentation](https://vekexasia.github.io/pi-extensible-workflows/) | [Developer guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html) | [Agent guide](https://vekexasia.github.io/pi-extensible-workflows/agents.html) | [Extension authoring](https://vekexasia.github.io/pi-extensible-workflows/extensions.html) | [Video overview](https://youtu.be/qAiivspEHmU)

Requires Node.js 22.19 or newer. This is a trusted Pi extension with the same filesystem and process access as Pi.

## Install

```sh
pi install npm:pi-extensible-workflows
```

For source installs and local development, see the [installation guide](https://vekexasia.github.io/pi-extensible-workflows/developers.html#installation).
The repository is an npm-workspaces monorepo. The public package is maintained in `packages/core`; the private root keeps the existing `npm run build`, `npm run lint`, `npm test`, and `npm run check` commands working from the repository root. See [releasing](https://github.com/vekexasia/pi-extensible-workflows/blob/main/RELEASING.md) for the fixed-version policy.

## Capabilities

The default path is a named inline workflow: write a `script` that fans out independent work with `parallel(...)`, awaits the keyed results, passes them into one summarizing `agent(...)`, and returns. Inline and file-backed launches require a non-empty `name`; a reviewed JavaScript file can use `scriptPath` instead of `script`, and its contents are captured in the run at launch. Registered function launches may use `name` as an optional run label and otherwise use their registered function name. Runs are backgrounded by default; set `foreground: true` when the final value must be returned in the same tool call. If a foreground tool call detaches before its result is accepted by the next event-loop turn, the terminal success or failure is promoted to exactly one follow-up message.

```js
const reviews = await parallel("review", {
  correctness: () => agent("Review the current changes for correctness issues."),
  security: () => agent("Review the current changes for security risks."),
  tests: () => agent("Review the current changes for missing test coverage."),
});

return await agent(
  prompt("Summarize and prioritize these findings:\n\n{reviews}", { reviews }),
);
```

**Advanced capabilities:** Use registered functions, `outputSchema`, budgets, checkpoints, worktrees, retry/resume, CLI export, and `pipeline(...)` when the task requires them. They remain available without complicating the basic inline path. Workflow worktree scopes always use the explicit `withWorktree(name, callback)` form.

The main Pi agent writes these scripts on the fly for each task; an external review or approval flow can write one to a JavaScript file and launch it with `scriptPath`. Extensions can add reusable functions, and completed workflows can resume without rerunning completed work.

Learn more about roles, workflow contracts, and extension APIs in the documentation:

- [Workflow tool and invocation API](https://vekexasia.github.io/pi-extensible-workflows/developers.html#tool-api)
- [Global and project settings](https://vekexasia.github.io/pi-extensible-workflows/developers.html#settings)
- [Aggregate run budgets](https://vekexasia.github.io/pi-extensible-workflows/developers.html#budgets)
- [Workflow DSL and worktrees](https://vekexasia.github.io/pi-extensible-workflows/developers.html#dsl)
- [Extension authoring guide](https://vekexasia.github.io/pi-extensible-workflows/extensions.html)
- [Copy-paste extension template](https://github.com/vekexasia/pi-extensible-workflows/tree/main/packages/core/examples/workflow-extension-template)
- [Run artifacts and lifecycle events](https://vekexasia.github.io/pi-extensible-workflows/developers.html#lifecycle)
- [Run inspection and recovery](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations)
- [Agent patterns and model selection](https://vekexasia.github.io/pi-extensible-workflows/agents.html#patterns)
- [Checkpoints](https://vekexasia.github.io/pi-extensible-workflows/agents.html#checkpoints)


## License

MIT

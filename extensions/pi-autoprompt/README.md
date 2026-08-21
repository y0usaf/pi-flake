# pi-autoprompt

Vendored [Autoprompt](https://github.com/Spielewoy/autoprompt-skill) 1.0.4 package for Earendil Pi.

The upstream OMP doctrine, 25 `ap-*` personas, and 18 frameworks are stored under `skills/autoprompt/`. The top-level `SKILL.md` is a Pi adapter: it maps upstream named `task` dispatch onto this flake's `pi-agents` `spawn_agent` contracts while preserving role allowlists, recursive hierarchy, independent review, and failure delivery.

## Use

`pi-full` includes both `pi-agents` and this skill. Invoke it explicitly:

```text
/skill:autoprompt fix the registration race and add a regression test
```

For a selected bundle, enable both packages:

```nix
programs.pi.extensions = {
  agents = true;
  autoprompt = true;
};
```

Configure recursive depth and capacity in `~/.pi/agent/pi-agents.json` or `.pi/pi-agents.json`:

```json
{
  "maxDepth": 4,
  "maxLiveAgents": 6
}
```

`maxDepth >= 4` is required by the full Autoprompt hierarchy. Increase `maxLiveAgents` before using `mode=wide` or a larger custom ceiling. Workers inherit the model selected by `pi-agents`; per-role model routing is unavailable.

## Vendoring

- Upstream: `Spielewoy/autoprompt-skill`
- Version: `1.0.4`
- Revision: recorded in `UPSTREAM_REVISION`
- License: MIT, retained in `LICENSE`

This is an adapter maintained by pi-flake, not an upstream-audited OMP installation. It fails closed when `pi-agents` tools, recursive capacity, or required evidence are unavailable.

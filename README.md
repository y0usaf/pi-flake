# pi-flake

Thin flake wrapper around upstream `badlogic/pi-mono`.

Includes:
- upstream `pi` built from source (`inputs.piSrc`, `flake = false`)
- local extension packages from `packages/`
- local patches from `patches/`

Current patch set:
- `disable-install-telemetry.patch` — disables install/update telemetry requests
- `avoid-network-model-regeneration.patch` — uses the checked-in model registry during Nix builds instead of refetching models at build time

Build:

```bash
nix build .#pi
```

Extension package outputs:
- `.#pi-agents`
- `.#pi-codex-fast-flake`
- `.#pi-gecko-websearch`
- `.#pi-rtk-flake`
- `.#pi-webfetch`

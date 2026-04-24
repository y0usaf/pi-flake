# pi-flake

Thin flake wrapper around upstream `badlogic/pi-mono`.

Includes:
- upstream `pi` built from source (`inputs.piSrc`, `flake = false`)
- local extensions from `extensions/`
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
- `.#pi-codex-fast`
- `.#pi-gecko-websearch`
- `.#pi-rtk`
- `.#pi-compact`
- `.#pi-tool-management`
- `.#pi-webfetch`

Automation:
- `.github/dependabot.yml` — weekly Nix lock updates for root + extension flakes
- `.github/workflows/ci.yml` — builds root + extension outputs on PRs/pushes
- `.github/workflows/dependabot-smoke.yml` — scheduled/manual smoke test of temporary lock refreshes

Note:
- Dependabot can update lock files, but upstream `piSrc` bumps may still require a manual `npmDepsHash` and/or patch refresh in `flake.nix`.

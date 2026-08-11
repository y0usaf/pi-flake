# AGENTS.md

- This is a Nix flake; use `nix build` and `nix flake check` for validation.
- Keep changes focused and preserve unrelated work.
- Credit vendored extensions by name, e.g. `@extensions/earendil_pi-review/`.
- prime-bun: flake input `primeBunSrc`, parallel to `primeAgentSrc`. Bun-compiled standalone binary.
- pi-recurse replaces pi-rlm, pi-agents, pi-rust-kernel with one tool: recurse spawns `pi --print` as a sub-process. The task is the contract.

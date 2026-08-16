# pi-flake

Nix flake for building [pi](https://github.com/earendil-works/pi) and its forks
([prime-agent](https://github.com/PrimeIntellect-ai/prime-agent),
[prime-bun](https://github.com/sng-asyncfunc/prime-bun)) with optional
extension bundles.

**Features:**
- Base `pi` package built from source with upstream patches
- `prime-agent` and `prime-bun` variants built from their own sources
- Pre-configured extension packages with lifecycle stages (active/testing/paused/retired)
- `pi-full`: base pi with all active extensions bundled
- Builder functions for custom extension combinations
- Flag-driven extension selection for downstream flakes
- Bundled extensions load automatically via `PI_DEFAULT_PACKAGES` — no `settings.json` edits

---

## Quick Start

### Install base pi (no extensions)

```bash
nix profile install github:y0usaf/pi-flake#pi
# OR in your flake:
# inputs.pi-flake.packages.x86_64-linux.pi
```

### Install pi with all active extensions

```bash
nix profile install github:y0usaf/pi-flake#pi-full
# OR in your flake:
# inputs.pi-flake.packages.x86_64-linux.pi-full
```

### Install a fork variant

```bash
nix profile install github:y0usaf/pi-flake#prime-agent
nix profile install github:y0usaf/pi-flake#prime-bun           # Bun-compiled standalone binary
```

### Build custom extension bundle

```nix
{
  inputs.pi-flake.url = "github:y0usaf/pi-flake";
  inputs.nixpkgs.follows = "pi-flake/nixpkgs";

  outputs = { self, pi-flake, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    packages.x86_64-linux.my-pi = pi-flake.lib.piWithExtensions {
      inherit pkgs;
      pi = pi-flake.packages.${system}.pi;
      extensions = {
        webfetch = pi-flake.packages.${system}."pi-webfetch";
        "gecko-websearch" = pi-flake.packages.${system}."pi-gecko-websearch";
      };
    };
  };
}
```

### Build from boolean extension flags

Flake `inputs` cannot pass arbitrary booleans into another flake's outputs.
Use a flag attrset in your consuming flake:

```nix
{
  inputs.pi-flake.url = "github:y0usaf/pi-flake";
  inputs.nixpkgs.follows = "pi-flake/nixpkgs";

  outputs = { self, pi-flake, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    packages.${system}.my-pi = pi-flake.lib.piWithExtensionFlags {
      inherit pkgs;
      extensionFlags = {
        aliases = true;
        chronobreak = true;
        webfetch = true;
        "gecko-websearch" = false;
        sentinel = true;
        ponytail = true;
        caveman = true;
        recap = true;
      };
    };
  };
}
```

Only flags set to `true` are bundled. Unknown flags fail the build with an
assertion.

### NixOS module

```nix
{
  inputs.pi-flake.url = "github:y0usaf/pi-flake";
  inputs.pi-flake.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, pi-flake, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        pi-flake.nixosModules.default
        {
          programs.pi = {
            enable = true;

            # Option 1: all active extensions, same contents as .#pi-full
            full = true;

            # Option 2: selected extensions
            # extensions = {
            #   webfetch = true;
            #   ponytail = true;
            #   caveman = true;
            # };

            # Option 3: concrete package
            # package = pi-flake.packages.x86_64-linux.pi-full;
          };
        }
      ];
    };
  };
}
```

The module installs `config.programs.pi.finalPackage` into
`environment.systemPackages` and sets `PI_SKIP_VERSION_CHECK=1` and
`PI_TELEMETRY=0`. Bundled extensions load through the installed wrapper; no
`settings.json` entries or extra Nix config are needed.

---

## Available Extensions

Active extensions (shipped in `pi-full`):

| Name | Description |
|------|-------------|
| `pi-aliases` | Configurable bash command aliases — defaults: grep→rg, find→fd |
| `pi-chronobreak` | Terminates assistant generation loops: detects repeated output in a turn, aborts, scrubs context, re-runs with a decisive-action directive |
| `pi-webfetch` | Fetch a URL and return its content as markdown |
| `pi-gecko-websearch` | Web search and browsing via headless Gecko browser (Marionette) |
| `pi-sentinel` | Detects abrupt run endings via a sparse context-free judge, continues the run when the stop was a cutoff |
| `pi-ponytail` | Lazy senior dev mode — cuts unnecessary code, keeps safety |
| `pi-caveman` | Terse-response mode with configurable compression levels |
| `pi-recap` | Claude Code-style session recap: one-line recap above the status bar |
| `pi-yourshell` | Runs the bash tool through your own `$SHELL` instead of pi's hardcoded bash |

## Extension Lifecycle

`extensions/registry.nix` assigns every bundled extension a lifecycle stage:

| Stage | Effect |
| --- | --- |
| `active` | In the default bundle (`pi-full`) and built by `nix flake check` |
| `testing` | Built and checked, but excluded from the default bundle; opt-in via `programs.pi.extensions.<name>` (NixOS module emits a warning) |
| `paused` | Source kept in the tree, but not built, bundled, or checked |
| `retired` | Source moved to `extensions/retired/`, not built or bundled |

Promote/demote an extension by editing its `stage` in
`extensions/registry.nix`; packages, checks, the default bundle, and the NixOS
module all follow from that single declaration.

---

## How Extension Auto-Discovery Works

Bundled extensions are copied into `$out/share/pi/extensions/<name>/`. The
wrapper exposes `$out/share/pi` through `PI_DEFAULT_PACKAGES`, and the patched
Pi package manager treats that path as a temporary/default package source at
runtime.

When you run the wrapped `pi`:

1. The wrapper prepends its bundled package root to `PI_DEFAULT_PACKAGES`.
2. Pi resolves resources from that package root using the same package/convention discovery as normal package sources.
3. The extensions load for that process only.
4. User/project `settings.json` files are not created or modified.

`--no-extensions` still disables these bundled defaults because they enter
through the normal package resolution path, not as CLI-forced extension paths.

---

## Manual Extension Management

If you want full control:

1. Build base pi:
   ```bash
   nix build .#pi
   ```

2. Build your chosen extensions:
   ```bash
   nix build .#pi-webfetch
   ```

3. Add to `~/.pi/agent/settings.json`:
   ```json
   {
     "packages": [
       "/path/to/result-pi-webfetch"
     ]
   }
   ```

---

## Packages

### Variants

- `pi` - Base pi, no extensions
- `pi-full` - pi with all active extensions bundled
- `prime-agent` - Prime Intellect fork, node bundle with vendored runtime node_modules
- `prime-bun` - Bun-compiled standalone binary, parallel to prime-agent

### Extension packages

```nix
inputs.pi-flake.packages.<system>."pi-aliases"
inputs.pi-flake.packages.<system>."pi-chronobreak"
inputs.pi-flake.packages.<system>."pi-webfetch"
inputs.pi-flake.packages.<system>."pi-gecko-websearch"
inputs.pi-flake.packages.<system>."pi-sentinel"
inputs.pi-flake.packages.<system>."pi-ponytail"
inputs.pi-flake.packages.<system>."pi-caveman"
inputs.pi-flake.packages.<system>."pi-recap"
inputs.pi-flake.packages.<system>."pi-agents"
inputs.pi-flake.packages.<system>."pi-yourshell"
```

### Library helpers / modules

- `pi-flake.nixosModules.default` - NixOS module exposing `programs.pi.*`
- `pi-flake.lib.piWithExtensions { pkgs; pi; extensions; }` - bundle an explicit extension attrset
- `pi-flake.lib.piWithExtensionFlags { pkgs; extensionFlags; }` - bundle extensions whose flags are `true`
- `pi-flake.lib.extensionPackagesFor system` - available extension attrset keyed by bundled name
- `pi-flake.lib.defaultExtensionPackagesFor system` - active-stage extensions only (what `pi-full` uses)
- `pi-flake.lib.enabledExtensions { system; extensionFlags; }` - resolve flags to extension packages
- `pi-flake.lib.extensionRegistry` - the lifecycle registry

---

## Development

```bash
# Build base pi
nix build .#pi

# Build an extension
nix build .#pi-webfetch

# Build full bundle
nix build .#pi-full

# Build fork variants
nix build .#prime-agent
nix build .#prime-bun

# Enter dev shell
nix develop

# Run Biome linting
nix develop -c biome lint .

# Run the Biome flake check only (replace the system if needed)
nix build .#checks.x86_64-linux.biome-lint
```

---

## Patches

Patches are a last resort: anything reachable through an env var or user
config is done that way instead, because context diffs rot on every `piSrc`
bump.

Current patch set applied to upstream `pi`:

- `avoid-network-model-regeneration.patch` - Uses checked-in model registry during builds
- `default-package-sources-env.patch` - Adds non-persistent `PI_DEFAULT_PACKAGES` package sources for Nix-bundled resources
- `user-message-bar.patch` - Adds an optional theme-gated Crush-style user-message gutter bar
- `tui-overlay-invalidate-guard.patch` - Guards TUI overlay invalidation

Removed patches and their replacements:

- install telemetry: `PI_TELEMETRY=0` exported by both wrappers and by the
  NixOS module. `isInstallTelemetryEnabled` prefers the env var over settings,
  and gates both `reportInstallTelemetry` and the provider attribution headers
  in `provider-attribution.ts` (the old patch only covered the former).
- tree-filter backward cycle: unbind it in `~/.pi/agent/keybindings.json`
  (`getAgentDir` = `$HOME/.pi/agent`) with
  `{ "app.tree.filter.cycleBackward": [] }` — an empty key list never matches.

---

## Note on Dependabot

- Dependabot can update lock files, but upstream `piSrc` bumps may require manual `npmDepsHash` and/or patch refreshes in `flake.nix`.

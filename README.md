# pi-flake

Nix flake for building [pi](https://github.com/earendil-works/pi) with optional extension bundles.

**Features:**
- Base `pi` package built from source
- Pre-configured extension packages
- **Builder functions** for custom extension combinations
- Flag-driven extension selection for downstream flakes
- Bundled extensions load automatically without writing to `settings.json`

---

## Quick Start

### Install base pi (no extensions)

```bash
nix profile install github:your-org/pi-flake#pi
# OR in your flake:
# inputs.pi-flake.packages.x86_64-linux.pi
```

### Install pi with all extensions pre-bundled

```bash
nix profile install github:your-org/pi-flake#pi-full
# OR in your flake:
# inputs.pi-flake.packages.x86_64-linux.pi-full
```

### Build custom extension bundle

```nix
# In your flake:
{
  inputs.pi-flake.url = "github:your-org/pi-flake";
  inputs.nixpkgs.follows = "pi-flake/nixpkgs";

  outputs = { self, pi-flake, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    packages.x86_64-linux.my-pi = pi-flake.lib.piWithExtensions {
      inherit pkgs;
      pi = pi-flake.packages.${system}.pi;
      extensions = {
        # Only include extensions you want
        "codex-fast" = pi-flake.packages.${system}."pi-codex-fast";
        "gecko-websearch" = pi-flake.packages.${system}."pi-gecko-websearch";
      };
    };
  };
}
```

### Build from boolean extension flags

Flake `inputs` cannot pass arbitrary booleans into another flake's outputs. Use a flag attrset in your consuming flake and build a package from it:

```nix
{
  inputs.pi-flake.url = "github:your-org/pi-flake";
  inputs.nixpkgs.follows = "pi-flake/nixpkgs";

  outputs = { self, pi-flake, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    packages.${system}.my-pi = pi-flake.lib.piWithExtensionFlags {
      inherit pkgs;
      extensionFlags = {
        "codex-fast" = true;
        "gecko-websearch" = false;
        rtk = false;
        compact = true;
        "context-janitor" = true;
        morph = false; # opt in with true if you want pi-morph bundled
        "tool-management" = false;
        webfetch = true;
        hashline = true;
        "minimal-editor" = true;
        "working-indicator" = true;
        rlm = true;
        review = true;
        vcc = true;
      };
    };
  };
}
```

Only flags set to `true` are copied into the bundled wrapper.

### NixOS module

```nix
{
  inputs.pi-flake.url = "github:your-org/pi-flake";
  inputs.pi-flake.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, pi-flake, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        pi-flake.nixosModules.default
        {
          programs.pi = {
            enable = true;

            # Option 1: default bundled extensions, same contents as .#pi-full
            full = true;

            # Option 2: selected bundled extensions
            # extensions = {
            #   "codex-fast" = true;
            #   compact = true;
            #   "context-janitor" = true;
            #   webfetch = true;
            #   hashline = true;
            #   # morph = true; # opt-in; not included by full/pi-full by default
            #   "minimal-editor" = true;
            #   "working-indicator" = true;
            #   rlm = true;
            #   review = true;
            #   vcc = true;
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

The module installs `config.programs.pi.finalPackage` into `environment.systemPackages` and sets `PI_SKIP_VERSION_CHECK=1`. Bundled extensions are loaded by the installed wrapper; no `settings.json` entries or extra Nix config are needed.

---

## Available Extensions

| Name | Description |
|------|-------------|
| `pi-codex-fast` | Fast code completion tool |
| `pi-gecko-websearch` | Web search using Firefox's engine |
| `pi-rtk` | Real-time keyboard events |
| `pi-compact` | Compaction utilities |
| `pi-context-janitor` | Hash-gated context truncation + undo UI |
| `pi-morph` | Morph edit tool via Vercel AI Gateway (available as opt-in extension; not bundled in `pi-full`) |
| `pi-tool-management` | Tool management interface |
| `pi-webfetch` | HTTP fetching utilities |
| `pi-hashline` | Hashline v2 read/edit tool override |
| `pi-minimal-editor` | Minimal editor borders with footer/status metadata |
| `pi-working-indicator` | Compact animated working indicator |
| `pi-rlm` | Recursive Pi/RLM-style child-agent calls via `pi_recurse` |
| `pi-review` | `/review` and `/end-review` code review workflow |
| `pi-vcc` | Algorithmic conversation compactor with `/pi-vcc`, `/pi-vcc-recall`, and `vcc_recall` |

---

## How Extension Auto-Discovery Works

**Bundled** extensions are copied into `$out/share/pi/extensions/<name>/`. The wrapper exposes `$out/share/pi` through `PI_DEFAULT_PACKAGES`, and the patched Pi package manager treats that path as a temporary/default package source at runtime.

When you run the wrapped `pi`:

1. The wrapper prepends its bundled package root to `PI_DEFAULT_PACKAGES`.
2. Pi resolves resources from that package root using the same package/convention discovery as normal package sources.
3. The extensions are loaded for that process only.
4. User/project `settings.json` files are not created or modified.

`--no-extensions` still disables these bundled defaults because they enter through the normal package resolution path, not as CLI-forced extension paths.

---

## Manual Extension Management

If you want full control:

1. Build base pi:
   ```bash
   nix build .#pi
   ```

2. Build your chosen extensions:
   ```bash
   nix build .#pi-codex-fast
   ```

3. Add to `~/.pi/agent/settings.json`:
   ```json
   {
     "packages": [
       "/path/to/result-pi-codex-fast"
     ]
   }
   ```

---

## Packages

### Extension packages

```nix
inputs.pi-flake.packages.<system>."pi-codex-fast"
inputs.pi-flake.packages.<system>."pi-gecko-websearch"
inputs.pi-flake.packages.<system>."pi-rtk"
inputs.pi-flake.packages.<system>."pi-compact"
inputs.pi-flake.packages.<system>."pi-context-janitor"
inputs.pi-flake.packages.<system>."pi-morph"
inputs.pi-flake.packages.<system>."pi-tool-management"
inputs.pi-flake.packages.<system>."pi-webfetch"
inputs.pi-flake.packages.<system>."pi-hashline"
inputs.pi-flake.packages.<system>."pi-rlm"
inputs.pi-flake.packages.<system>."pi-review"
inputs.pi-flake.packages.<system>."pi-vcc"
```

`pi-review` PR review mode shells out to `gh`; install and authenticate GitHub CLI separately if you want `/review pr ...`.

`pi-vcc` registers `/pi-vcc`, `/pi-vcc-recall`, `vcc_recall`, and a `session_before_compact` hook. By default it does not override Pi's normal `/compact`; set `overrideDefaultCompaction: true` in `~/.pi/agent/pi-vcc-config.json` to make VCC handle all compaction paths.

### Variants

- `pi` - Base pi, no extensions
- `pi-full` - pi with default extensions bundled and loaded at runtime; excludes opt-in `pi-morph`
- `pi-morph` - standalone Morph edit extension package, available for explicit bundling/flags

### Library helpers / modules

- `pi-flake.nixosModules.default` - NixOS module exposing `programs.pi.*`
- `pi-flake.lib.piWithExtensions { pkgs; pi; extensions; }` - bundle an explicit extension attrset
- `pi-flake.lib.piWithExtensionFlags { pkgs; extensionFlags; }` - bundle extensions whose flags are `true`
- `pi-flake.lib.extensionPackagesFor system` - available extension attrset keyed by bundled name

---

## Development

```bash
# Build base pi
nix build .#pi

# Build extension
nix build .#pi-codex-fast
# Build full bundle
nix build .#pi-full

# Enter dev shell
nix develop

```

---

## Patches

Current patch set applied to upstream `pi-mono`:

- `disable-install-telemetry.patch` - Disables install/update telemetry
- `avoid-network-model-regeneration.patch` - Uses checked-in model registry during builds
- `remove-tree-filter-backcycle.patch` - Removes extra `Ctrl+Shift+O` shortcut
- `default-package-sources-env.patch` - Adds non-persistent `PI_DEFAULT_PACKAGES` package sources for Nix-bundled resources

---

## Note on Dependabot

- Dependabot can update lock files, but upstream `piSrc` bumps may require manual `npmDepsHash` and/or patch refreshes in `flake.nix`.
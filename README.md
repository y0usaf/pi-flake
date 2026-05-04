# pi-flake

Nix flake for building [pi](https://github.com/badlogic/pi-mono) with optional extension bundles.

**Features:**
- Base `pi` package built from source
- Pre-configured extension packages
- **Builder functions** for custom extension combinations
- Flag-driven extension selection for downstream flakes
- Auto-discovery wrapper: bundled extensions are registered through `settings.json`

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
        hive = pi-flake.packages.${system}."pi-hive";
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
        hive = true;
        "codex-fast" = true;
        "gecko-websearch" = false;
        rtk = false;
        compact = true;
        "context-janitor" = true;
        "tool-management" = false;
        webfetch = true;
        hashline = true;
        "minimal-ui" = true;
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

            # Option 1: all bundled extensions, same contents as .#pi-full
            full = true;

            # Option 2: selected bundled extensions
            # extensions = {
            #   hive = true;
            #   "codex-fast" = true;
            #   compact = true;
            #   "context-janitor" = true;
            #   webfetch = true;
            #   hashline = true;
            #   "minimal-ui" = true;
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

The module installs `config.programs.pi.finalPackage` into `environment.systemPackages` and sets `PI_SKIP_VERSION_CHECK=1`.

---

## Available Extensions

| Name | Description |
|------|-------------|
| `pi-hive` | Multi-agent orchestration extension |
| `pi-codex-fast` | Fast code completion tool |
| `pi-gecko-websearch` | Web search using Firefox's engine |
| `pi-rtk` | Real-time keyboard events |
| `pi-compact` | Compaction utilities |
| `pi-context-janitor` | Background context pruning via lightweight sidecar summarizer |
| `pi-morph` | Morph edit tool via Vercel AI Gateway |
| `pi-tool-management` | Tool management interface |
| `pi-webfetch` | HTTP fetching utilities |
| `pi-hashline` | Hashline v2 read/edit tool override |
| `pi-minimal-ui` | Minimal statusline + centered compact input box |

---

## How Extension Auto-Discovery Works

**Bundled** extensions are copied into `$out/share/pi/extensions/<name>/`; the wrapper registers those paths in `settings.json` on first run.

When you run the wrapped `pi`:

1. Wrapper sets `PI_DEFAULT_EXTENSIONS` to the bundled extensions path
2. Wrapper creates/updates `~/.pi/agent/settings.json` (or `.pi/settings.json` for projects)
3. The merge script appends bundled extensions to your existing `extensions` array (if not already present)
4. pi loads extensions from `settings.json` on first run per directory/project

**Important:** Extensions from `pi-full` get written to your settings file on first run. If you want to disable them later, edit `~/.pi/agent/settings.json` and remove entries from the `extensions` array.

---

## Manual Extension Management

If you want full control:

1. Build base pi:
   ```bash
   nix build .#pi
   ```

2. Build your chosen extensions:
   ```bash
   nix build .#pi-hive .#pi-codex-fast
   ```

3. Add to `~/.pi/agent/settings.json`:
   ```json
   {
     "packages": [
       "/path/to/result-pi-hive",
       "/path/to/result-pi-codex-fast"
     ]
   }
   ```

---

## Packages

### Extension packages

```nix
inputs.pi-flake.packages.<system>."pi-hive"
inputs.pi-flake.packages.<system>."pi-codex-fast"
inputs.pi-flake.packages.<system>."pi-gecko-websearch"
inputs.pi-flake.packages.<system>."pi-rtk"
inputs.pi-flake.packages.<system>."pi-compact"
inputs.pi-flake.packages.<system>."pi-context-janitor"
inputs.pi-flake.packages.<system>."pi-tool-management"
inputs.pi-flake.packages.<system>."pi-webfetch"
inputs.pi-flake.packages.<system>."pi-hashline"
```

### Variants

- `pi` - Base pi, no extensions
- `pi-full` - pi with all extensions bundled (registered via settings merge)

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
nix build .#pi-hive

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

---

## Note on Dependabot

- Dependabot can update lock files, but upstream `piSrc` bumps may require manual `npmDepsHash` and/or patch refreshes in `flake.nix`.
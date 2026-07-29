# pi-flake

Nix flake for building [pi](https://github.com/earendil-works/pi) with optional extension bundles.

**Features:**
- Base `pi` package built from source
- Pre-configured extension packages
- Upstream tool controls incl. `--exclude-tools`
- Optional persistent `/tools` UI via `pi-tool-management`
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
        hashline = pi-flake.packages.${system}."pi-hashline";
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
        "gecko-websearch" = false;
        rtk = false;
        minimal = true;
        interview = true;
        "tool-management" = false;
        webfetch = true;
        hashline = true;

        advisor = true;
        review = true;
        vcc = true;
        caveman = true;
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
            #   minimal = true;
            #   interview = true;
            #   # tool-management = true; # persistent disabled-tools menu/UI
            #   webfetch = true;
            #   hashline = true;

            #   advisor = true;
            #   review = true;
            #   vcc = true;
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

The module installs `config.programs.pi.finalPackage` into `environment.systemPackages` and sets `PI_SKIP_VERSION_CHECK=1`. Bundled extensions are loaded by the installed wrapper; no `settings.json` entries or extra Nix config are needed.

---

## Available Extensions

| Name | Description |
|------|-------------|
| `pi-gecko-websearch` | Web search using Firefox's engine |
| `pi-rtk` | `rtk rewrite` shell-command optimization to cut token usage |
| `pi-minimal` | Minimal TUI: compact tools/thinking, full user prompts, borderless editor, per-feature `/minimal` toggles |
| `pi-interview` | Main-session ask-user questionnaire + optional separate-context auto-answers (`/interview`) |
| `pi-tool-management` | Persistent disabled-tools menu/UI via `/tools` |
| `pi-webfetch` | HTTP fetching utilities |
| `pi-hashline` | Strict hashline v3 read/edit tool override |

| `pi-advisor` | Stage-aware strategic guidance from a separately configured advisor model |
| `pi-review` | `/review` and `/end-review` code review workflow |
| `pi-vcc` | Algorithmic conversation compactor with `/pi-vcc`, `/pi-vcc-recall`, and `vcc_recall` |
| `pi-caveman` | Terse-response mode with configurable compression levels |

## Extension Lifecycle

`extensions/registry.nix` assigns every bundled extension a lifecycle stage:

| Stage | Effect |
| --- | --- |
| `active` | In the default bundle (`pi-full`) and built by `nix flake check` |
| `testing` | Built and checked, but excluded from the default bundle; opt-in via `programs.pi.extensions.<name>` (NixOS module emits a warning) |
| `paused` | Source kept in the tree, but not built, bundled, or checked (e.g. `kimi`) |
| `retired` | Entry removed from the registry and source deleted from `extensions/` |

Promote/demote an extension by editing its `stage` in `extensions/registry.nix`; the flake's packages, checks, default bundle, and the NixOS module all follow from that single declaration.

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
   nix build .#pi-hashline
   ```

3. Add to `~/.pi/agent/settings.json`:
   ```json
   {
     "packages": [
       "/path/to/result-pi-hashline"
     ]
   }
   ```

---

## Packages

### Extension packages

```nix
inputs.pi-flake.packages.<system>."pi-gecko-websearch"
inputs.pi-flake.packages.<system>."pi-rtk"
inputs.pi-flake.packages.<system>."pi-minimal"
inputs.pi-flake.packages.<system>."pi-interview"
inputs.pi-flake.packages.<system>."pi-tool-management"
inputs.pi-flake.packages.<system>."pi-webfetch"
inputs.pi-flake.packages.<system>."pi-hashline"

inputs.pi-flake.packages.<system>."pi-advisor"
inputs.pi-flake.packages.<system>."pi-review"
inputs.pi-flake.packages.<system>."pi-vcc"
inputs.pi-flake.packages.<system>."pi-caveman"
```

`pi-advisor` is bundled in `pi-full`, but its `advisor` tool starts disabled. Run `/advisor on [provider/model]` to configure and enable it.
`pi-interview` is bundled in `pi-full` but defaults to `off`. Use `/interview manual`, `/interview auto [provider/model]`, or `/interview strict`; configuration persists to `~/.pi/agent/interview.json`.

`pi-review` PR review mode shells out to `gh`; install and authenticate GitHub CLI separately if you want `/review pr ...`.

`pi-vcc` registers `/pi-vcc`, `/pi-vcc-recall`, `vcc_recall`, and a `session_before_compact` hook. By default it does not override Pi's normal `/compact`; set `overrideDefaultCompaction: true` in `~/.pi/agent/pi-vcc-config.json` to make VCC handle all compaction paths.

### Variants

- `pi` - Base pi, no extensions
- `pi-full` - pi with default extensions bundled and loaded at runtime

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
nix build .#pi-hashline
# Build full bundle
nix build .#pi-full

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
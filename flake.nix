{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:badlogic/pi-mono?ref=main";
      flake = false;
    };

    piCodexFast.url = "path:./extensions/pi-codex-fast";
    piCodexFast.inputs.nixpkgs.follows = "nixpkgs";

    piGeckoWebsearch.url = "path:./extensions/pi-gecko-websearch";
    piGeckoWebsearch.inputs.nixpkgs.follows = "nixpkgs";

    piRtk.url = "path:./extensions/pi-rtk";
    piRtk.inputs.nixpkgs.follows = "nixpkgs";

    piCompact.url = "path:./extensions/pi-compact";
    piCompact.inputs.nixpkgs.follows = "nixpkgs";

    piContextJanitor.url = "path:./extensions/pi-context-janitor";
    piContextJanitor.inputs.nixpkgs.follows = "nixpkgs";

    piMorph.url = "path:./extensions/pi-morph";
    piMorph.inputs.nixpkgs.follows = "nixpkgs";

    piToolManagement.url = "path:./extensions/pi-tool-management";
    piToolManagement.inputs.nixpkgs.follows = "nixpkgs";

    piWebfetch.url = "path:./extensions/pi-webfetch";
    piWebfetch.inputs.nixpkgs.follows = "nixpkgs";

    piHashline.url = "path:./extensions/pi-hashline";
    piHashline.inputs.nixpkgs.follows = "nixpkgs";

    piMinimalUi.url = "path:./extensions/pi-minimal-ui";
    piMinimalUi.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    piSrc,
    piCodexFast,
    piGeckoWebsearch,
    piRtk,
    piCompact,
    piContextJanitor,
    piMorph,
    piToolManagement,
    piWebfetch,
    piHashline,
    piMinimalUi,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = forAllSystems (system: import nixpkgs {inherit system;});
    packageJson = builtins.fromJSON (builtins.readFile "${piSrc}/packages/coding-agent/package.json");
    piPatches = [
      ./patches/disable-install-telemetry.patch
      ./patches/avoid-network-model-regeneration.patch
      ./patches/remove-tree-filter-backcycle.patch
    ];
  in {
    packages = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;

      canvasNativeDeps = with pkgs; [
        cairo
        giflib
        libjpeg
        libpng
        pango
        pixman
      ];
    in {
      pi = pkgs.buildNpmPackage {
        pname = "pi";
        version = packageJson.version;
        src = piSrc;
        patches = piPatches;
        npmWorkspace = "packages/coding-agent";
        npmBuildScript = "build:binary";
        npmDepsFetcherVersion = 2;

        # Regenerate after dependency changes:
        #   nix build .#pi 2>&1 | grep 'got:' | awk '{print $2}'
        npmDepsHash = "sha256-fE/kaSnvXPQczWoqPBZghb6SUQ+6fq65qhmblm1O6Y8=";

        nodejs = pkgs.nodejs_22;

        nativeBuildInputs = with pkgs; [bun pkg-config makeWrapper];
        buildInputs = canvasNativeDeps;

        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/pi $out/bin

          cp -R packages/coding-agent/dist/. $out/share/pi/
          rm -f $out/share/pi/pi

          install -Dm755 packages/coding-agent/dist/pi $out/bin/pi
          wrapProgram $out/bin/pi \
            --set PI_PACKAGE_DIR $out/share/pi \
            --set PI_SKIP_VERSION_CHECK 1

          runHook postInstall
        '';

        meta = with lib; {
          description = packageJson.description;
          homepage = "https://github.com/badlogic/pi-mono";
          license = licenses.mit;
          mainProgram = "pi";
        };
      };

      "pi-codex-fast" = piCodexFast.packages.${system}.default;
      "pi-gecko-websearch" = piGeckoWebsearch.packages.${system}.default;
      "pi-rtk" = piRtk.packages.${system}.default;
      "pi-compact" = piCompact.packages.${system}.default;
      "pi-context-janitor" = piContextJanitor.packages.${system}.default;
      "pi-morph" = piMorph.packages.${system}.default;

      "pi-tool-management" = piToolManagement.packages.${system}.default;
      "pi-webfetch" = piWebfetch.packages.${system}.default;
      "pi-hashline" = piHashline.packages.${system}.default;
      "pi-minimal-ui" = piMinimalUi.packages.${system}.default;

      # pi with default extensions pre-bundled. Morph is offered as an extension
      # package/flag but is excluded from pi-full by default because it requires
      # remote credentials and is best opted into explicitly.
      pi-full = self.lib.piWithExtensions {
        inherit pkgs;
        pi = self.packages.${system}.pi;
        extensions = self.lib.defaultExtensionPackagesFor system;
      };

      default = self.packages.${system}.pi;
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      pi-build = self.packages.${system}.pi;

      patch-disable-install-telemetry = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-patch-disable-install-telemetry";
        version = packageJson.version;
        src = piSrc;
        patches = piPatches;
        nativeBuildInputs = [pkgs.gnugrep];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          grep -q 'return;' packages/coding-agent/src/modes/interactive/interactive-mode.ts
          ! grep -q 'https://pi.dev/install' packages/coding-agent/src/modes/interactive/interactive-mode.ts
          touch $out
          runHook postInstall
        '';
      };

      patch-avoid-network-model-regeneration = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-patch-avoid-network-model-regeneration";
        version = packageJson.version;
        src = piSrc;
        patches = piPatches;
        nativeBuildInputs = [pkgs.gnugrep];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          grep -q '"build": "tsgo -p tsconfig.build.json"' packages/ai/package.json
          ! grep -q 'generate-models' packages/ai/package.json
          touch $out
          runHook postInstall
        '';
      };

      patch-remove-tree-filter-backcycle = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-patch-remove-tree-filter-backcycle";
        version = packageJson.version;
        src = piSrc;
        patches = piPatches;
        nativeBuildInputs = [pkgs.gnugrep];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          ! grep -q 'app.tree.filter.cycleBackward' packages/coding-agent/src/modes/interactive/components/tree-selector.ts
          grep -q 'const cycleKeys = keyText("app.tree.filter.cycleForward");' packages/coding-agent/src/modes/interactive/components/tree-selector.ts
          touch $out
          runHook postInstall
        '';
      };
    });

    apps = forAllSystems (system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.pi}/bin/pi";
      };
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};

      canvasNativeDeps = with pkgs; [
        cairo
        giflib
        libjpeg
        libpng
        pango
        pixman
      ];
    in {
      default = pkgs.mkShell {
        packages = with pkgs;
          [
            nodejs_22
            bun
            pkg-config
          ]
          ++ canvasNativeDeps;

        shellHook = ''
          echo "pi-flake dev shell — node $(node --version), bun v$(bun --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);

    nixosModules.default = import ./nix/modules/nixos.nix self;

    # Extension package set keyed by bundled extension name.
    lib.extensionPackagesFor = system: {
      "codex-fast" = self.packages.${system}."pi-codex-fast";
      "gecko-websearch" = self.packages.${system}."pi-gecko-websearch";
      rtk = self.packages.${system}."pi-rtk";
      compact = self.packages.${system}."pi-compact";
      "context-janitor" = self.packages.${system}."pi-context-janitor";
      morph = self.packages.${system}."pi-morph";

      "tool-management" = self.packages.${system}."pi-tool-management";
      webfetch = self.packages.${system}."pi-webfetch";
      hashline = self.packages.${system}."pi-hashline";
      "minimal-ui" = self.packages.${system}."pi-minimal-ui";
    };

    # Default bundle used by pi-full. Keep remote/API-key-dependent extensions opt-in.
    lib.defaultExtensionPackagesFor = system:
      builtins.removeAttrs (self.lib.extensionPackagesFor system) ["morph"];

    lib.enabledExtensions = {
      system,
      extensionFlags ? {},
    }: let
      lib = nixpkgs.lib;
      available = self.lib.extensionPackagesFor system;
      unknownEnabled = lib.filterAttrs (_: enabled: enabled) (builtins.removeAttrs extensionFlags (builtins.attrNames available));
    in
      assert lib.assertMsg (unknownEnabled == {}) "Unknown pi extension flag(s): ${lib.concatStringsSep ", " (builtins.attrNames unknownEnabled)}";
        lib.filterAttrs (name: _: extensionFlags.${name} or false) available;

    # Flag-driven builder for consumers that want conditional bundled extensions.
    lib.piWithExtensionFlags = {
      pkgs,
      system ? pkgs.stdenv.hostPlatform.system,
      pi ? null,
      extensionFlags ? {},
      extraExtensions ? {},
    }: let
      lib = nixpkgs.lib;
      available = self.lib.extensionPackagesFor system;
      unknownEnabled = lib.filterAttrs (_: enabled: enabled) (builtins.removeAttrs extensionFlags (builtins.attrNames available));
      extensions = assert lib.assertMsg (unknownEnabled == {}) "Unknown pi extension flag(s): ${lib.concatStringsSep ", " (builtins.attrNames unknownEnabled)}";
        lib.filterAttrs (name: _: extensionFlags.${name} or false) available // extraExtensions;
    in
      self.lib.piWithExtensions {
        inherit pkgs extensions;
        pi =
          if pi == null
          then self.packages.${system}.pi
          else pi;
      };

    # Library function to build pi with extensions (available across systems)
    lib.piWithExtensions = {
      pkgs,
      pi,
      extensions,
    }:
      pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-with-extensions";
        version = pi.version;

        passthru = {
          inherit (pi) version;
          extensionNames = builtins.attrNames extensions;
        };

        dontUnpack = true;
        dontBuild = true;

        installPhase = ''
                  mkdir -p $out/bin $out/share/pi/extensions

                  # Symlink the pi binary
                  ln -s ${pi}/bin/pi $out/bin/.pi-real

                  # Create extension subdirectories and copy content
                  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: ext: ''
              mkdir -p "$out/share/pi/extensions/${name}"
              cp -R ${ext}/* "$out/share/pi/extensions/${name}/" 2>/dev/null || true
            '')
            extensions)}

                  # Create a helper script for merging default extensions
                  cat > $out/share/pi/merge-default-extensions.js << 'script'
          const fs = require('fs');
          const path = require('path');

          const defaultExtensionsPath = process.env.PI_DEFAULT_EXTENSIONS;
          const settingsPath = process.env.PI_SETTINGS_PATH;

          if (!defaultExtensionsPath) {
            console.error('Error: PI_DEFAULT_EXTENSIONS not set');
            process.exit(1);
          }

          if (!settingsPath) {
            console.error('Error: PI_SETTINGS_PATH not set');
            process.exit(1);
          }

          function isExtensionDir(p) {
            return fs.existsSync(path.join(p, 'index.ts')) || fs.existsSync(path.join(p, 'package.json'));
          }

          const defaultExtensions = !fs.existsSync(defaultExtensionsPath)
            ? []
            : fs.readdirSync(defaultExtensionsPath)
                .map(p => path.join(defaultExtensionsPath, p))
                .filter(p => {
                  try {
                    return fs.statSync(p).isDirectory() && isExtensionDir(p);
                  } catch {
                    return false;
                  }
                });

          if (defaultExtensions.length === 0) process.exit(0);

          let existingSettings = {};
          if (fs.existsSync(settingsPath)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existingSettings = parsed;
            } catch {
              // Replace corrupt settings with a minimal valid file.
            }
          }

          const existingExtensions = Array.isArray(existingSettings.extensions) ? existingSettings.extensions : [];
          const missingExtensions = defaultExtensions.filter(ext => !existingExtensions.includes(ext));

          // If settings already contain the bundled extensions, do not rewrite the file.
          // This keeps declarative/symlinked NixOS settings untouched.
          if (missingExtensions.length === 0) process.exit(0);

          const mergedSettings = {
            ...existingSettings,
            extensions: [...existingExtensions, ...missingExtensions],
          };
          const next = JSON.stringify(mergedSettings, null, 2) + '\n';

          try {
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, next);
          } catch (err) {
            if (err && ['EROFS', 'EACCES', 'EPERM'].includes(err.code)) {
              console.error(`Warning: cannot update pi settings at ''${settingsPath}: ''${err.code}`);
              console.error('Bundled extensions were not auto-registered; make settings writable or add them declaratively.');
              process.exit(0);
            }
            throw err;
          }
          script

                  # Create wrapper that auto-discovers bundled extensions
                  cat > $out/bin/.pi-wrapped << 'wrapper'
          #!/bin/bash
          set -euo pipefail

          # Set defaults
          export PI_PACKAGE_DIR="${pi}/share/pi"
          export PI_DEFAULT_EXTENSIONS="@out@/share/pi/extensions"
          export PI_SKIP_VERSION_CHECK=1

          # Determine settings path
          AGENT_DIR="$HOME/.pi/agent"
          PROJECT_SETTINGS="$(pwd)/.pi/settings.json"

          if [ -f "$PROJECT_SETTINGS" ]; then
            export PI_SETTINGS_PATH="$PROJECT_SETTINGS"
          else
            mkdir -p "$AGENT_DIR"
            export PI_SETTINGS_PATH="$AGENT_DIR/settings.json"
          fi

          # Merge bundled extensions with user settings.
          ${pkgs.nodejs}/bin/node @out@/share/pi/merge-default-extensions.js

          # Run pi
          exec "@out@/bin/.pi-real" "$@"
          wrapper

                  substituteInPlace $out/bin/.pi-wrapped \
                    --replace-fail '@out@' "$out"

                  # Make wrapper executable
                  chmod +x $out/bin/.pi-wrapped
                  mv $out/bin/.pi-wrapped $out/bin/pi
        '';

        meta = pi.meta;
      };
  };
}

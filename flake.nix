{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:earendil-works/pi?ref=main";
      flake = false;
    };

    piGeckoWebsearch.url = "path:./extensions/pi-gecko-websearch";
    piGeckoWebsearch.inputs.nixpkgs.follows = "nixpkgs";

    piRtk.url = "path:./extensions/pi-rtk";
    piRtk.inputs.nixpkgs.follows = "nixpkgs";

    piAphrodite.url = "path:./extensions/pi-aphrodite";
    piAphrodite.inputs.nixpkgs.follows = "nixpkgs";

    piInterview.url = "path:./extensions/pi-interview";
    piInterview.inputs.nixpkgs.follows = "nixpkgs";

    piToolManagement.url = "path:./extensions/pi-tool-management";
    piToolManagement.inputs.nixpkgs.follows = "nixpkgs";

    piExtensionManagement.url = "path:./extensions/pi-extension-management";
    piExtensionManagement.inputs.nixpkgs.follows = "nixpkgs";

    piWebfetch.url = "path:./extensions/pi-webfetch";
    piWebfetch.inputs.nixpkgs.follows = "nixpkgs";
    piHashline.url = "path:./extensions/pi-hashline";
    piHashline.inputs.nixpkgs.follows = "nixpkgs";

    piChronoBreak.url = "path:./extensions/pi-chrono-break";
    piChronoBreak.inputs.nixpkgs.follows = "nixpkgs";

    piKimi.url = "path:./extensions/pi-kimi";
    piKimi.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    piSrc,
    piGeckoWebsearch,
    piRtk,
    piAphrodite,
    piInterview,
    piToolManagement,
    piExtensionManagement,
    piWebfetch,
    piHashline,
    piChronoBreak,
    piKimi,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = forAllSystems (system: import nixpkgs {inherit system;});
    packageJson = builtins.fromJSON (builtins.readFile "${piSrc}/packages/coding-agent/package.json");
    extensionRegistry = import ./extensions/registry.nix;
    # Kept minimal on purpose: anything achievable via env var or user config
    # must not be a patch (patches rot on every piSrc bump).
    #   install telemetry  -> PI_TELEMETRY=0 in the wrappers
    #   tree filter cycle  -> "app.tree.filter.cycleBackward": [] in keybindings.json
    piPatches = [
      ./patches/avoid-network-model-regeneration.patch
      ./patches/default-package-sources-env.patch
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
    in
      {
        pi = pkgs.buildNpmPackage {
          pname = "pi";
          version = packageJson.version;
          src = piSrc;
          patches = piPatches;

          # Vendored output of packages/ai/scripts/generate-models.ts --strict
          # --data-only (network at build time otherwise). Regenerate after piSrc
          # bumps:
          #   cp packages/ai/src/providers/data/*.json nix/model-data/
          #   cp packages/ai/src/providers/data/.manifest.json nix/model-data/
          postPatch = ''
            mkdir -p packages/ai/src/providers/data
            cp ${./nix/model-data}/.manifest.json packages/ai/src/providers/data/
            cp ${./nix/model-data}/*.json packages/ai/src/providers/data/
          '';
          npmWorkspace = "packages/coding-agent";
          npmBuildScript = "build:binary";
          npmDepsFetcherVersion = 2;

          # Regenerate after dependency changes:
          #   nix build .#pi 2>&1 | grep 'got:' | awk '{print $2}'
          npmDepsHash = "sha256-D/XelRQFiSeUgoN3TKD+n2JFHK0g1EHNx9yuMvWbm9w=";

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
              --set PI_SKIP_VERSION_CHECK 1 \
              --set PI_TELEMETRY 0

            runHook postInstall
          '';

          meta = with lib; {
            description = packageJson.description;
            homepage = "https://github.com/earendil-works/pi";
            license = licenses.mit;
            mainProgram = "pi";
          };
        };

        "pi-gecko-websearch" = piGeckoWebsearch.packages.${system}.default;
        "pi-rtk" = piRtk.packages.${system}.default;
        "pi-aphrodite" = piAphrodite.packages.${system}.default;
        "pi-interview" = piInterview.packages.${system}.default;
        "pi-tool-management" = piToolManagement.packages.${system}.default;
        "pi-extension-management" = piExtensionManagement.packages.${system}.default;
        "pi-webfetch" = piWebfetch.packages.${system}.default;
        "pi-hashline" = piHashline.packages.${system}.default;
        "pi-chrono-break" = piChronoBreak.packages.${system}.default;

        "pi-advisor" = let
          advisorPackageJson = builtins.fromJSON (builtins.readFile ./extensions/RimuruW_pi-advisor/package.json);
        in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-advisor";
            version = advisorPackageJson.version;
            src = lib.cleanSource ./extensions/RimuruW_pi-advisor;

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp package.json README.md CHANGELOG.md LICENSE index.ts "$out"/
              cp -r src "$out"/

              runHook postInstall
            '';

            passthru.packageName = advisorPackageJson.name;

            meta = with lib; {
              description = advisorPackageJson.description;
              homepage = advisorPackageJson.homepage;
              license = licenses.mit;
              platforms = platforms.all;
            };
          };

        "pi-review" = let
          reviewPackageJson = builtins.fromJSON (builtins.readFile ./extensions/earendil_pi-review/package.json);
        in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-review";
            version = reviewPackageJson.version;
            src = lib.cleanSource ./extensions/earendil_pi-review;

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp package.json README.md LICENSE review.ts "$out"/

              runHook postInstall
            '';

            passthru.packageName = reviewPackageJson.name;

            meta = with lib; {
              description = reviewPackageJson.description;
              license = licenses.mit;
              platforms = platforms.all;
            };
          };

        "pi-vcc" = let
          vccPackageJson = builtins.fromJSON (builtins.readFile ./extensions/sting8k_pi-vcc/package.json);
        in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-vcc";
            version = vccPackageJson.version;
            src = lib.cleanSource ./extensions/sting8k_pi-vcc;

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp package.json README.md demo.gif index.ts "$out"/
              cp -r src "$out"/

              runHook postInstall
            '';

            passthru.packageName = vccPackageJson.name;

            meta = with lib; {
              description = vccPackageJson.description;
              platforms = platforms.all;
            };
          };

        "pi-caveman" = let
          cavemanPackageJson = builtins.fromJSON (builtins.readFile ./extensions/jonjonrankin_pi-caveman/package.json);
        in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-caveman";
            version = cavemanPackageJson.version;
            src = lib.cleanSource ./extensions/jonjonrankin_pi-caveman;

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp package.json README.md LICENSE pi-caveman.gif shoutout.jpg "$out"/
              cp -r extensions "$out"/

              runHook postInstall
            '';

            passthru.packageName = cavemanPackageJson.name;

            meta = with lib; {
              description = cavemanPackageJson.description;
              homepage = cavemanPackageJson.homepage;
              license = licenses.mit;
              platforms = platforms.all;
            };
          };

        "pi-quiet" = let
          quietPackageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-quiet/package.json);
        in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-quiet";
            version = quietPackageJson.version;
            src = lib.cleanSource ./extensions/pi-quiet;

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp package.json README.md DESIGN.md "$out"/
              cp -r extensions "$out"/

              runHook postInstall
            '';

            passthru.packageName = quietPackageJson.name;

            meta = with lib; {
              description = quietPackageJson.description;
              homepage = quietPackageJson.homepage;
              license = licenses.mit;
              platforms = platforms.all;
            };
          };

        # pi with default extensions pre-bundled.
        pi-full = self.lib.piWithExtensions {
          inherit pkgs;
          pi = self.packages.${system}.pi;
          extensions = self.lib.defaultExtensionPackagesFor system;
        };

        default = self.packages.${system}.pi;
      }
      // lib.optionalAttrs (extensionRegistry.kimi.stage or "active" != "paused") {
        # kimi is lifecycle-gated: only built when registry stage != "paused".
        # pi-kimi extension package on its own.
        "pi-kimi-ext" = piKimi.packages.${system}.default;

        # pi with the default extensions plus pi-kimi (subagents, plan mode,
        # permissions, hooks, todos) — Kimi Code-style agent loop features.
        pi-kimi = self.lib.piWithExtensions {
          inherit pkgs;
          pi = self.packages.${system}.pi;
          extensions =
            self.lib.defaultExtensionPackagesFor system
            // {kimi = self.packages.${system}."pi-kimi-ext";};
        };
      });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
    in
      {
        pi-build = self.packages.${system}.pi;

        pi-rtk-build = self.packages.${system}."pi-rtk";
        pi-rtk-test = piRtk.checks.${system}.test;
        pi-aphrodite-build = self.packages.${system}."pi-aphrodite";
        pi-extension-management-build = self.packages.${system}."pi-extension-management";

        pi-quiet-build = self.packages.${system}."pi-quiet";

        pi-aphrodite-test = piAphrodite.checks.${system}.test;
        pi-interview-test = piInterview.checks.${system}.test;
        pi-hashline-test = piHashline.checks.${system}.test;
        pi-chrono-break-test = piChronoBreak.checks.${system}.test;
        biome-lint = pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-flake-biome-lint";
          version = "1";
          src = lib.cleanSourceWith {
            src = ./.;
            filter = path: type: let
              name = baseNameOf path;
            in
              !(name
                == ".git"
                || name == "node_modules"
                || name == "ref"
                || name == "result"
                || lib.hasPrefix "result-" name);
          };
          nativeBuildInputs = [pkgs.biome];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            biome lint .
            touch $out
            runHook postInstall
          '';
        };

        # Install telemetry is disabled via env, not a patch: assert both
        # wrappers really export it (upstream reads PI_TELEMETRY before settings).
        telemetry-disabled = pkgs.runCommand "pi-telemetry-disabled" {} ''
          grep -q 'PI_TELEMETRY' ${self.packages.${system}.pi}/bin/pi
          grep -q 'PI_TELEMETRY=0' ${self.packages.${system}.pi-full}/bin/pi
          touch $out
        '';

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

        patch-default-package-sources-env = pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-patch-default-package-sources-env";
          version = packageJson.version;
          src = piSrc;
          patches = piPatches;
          nativeBuildInputs = [pkgs.gnugrep];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            grep -q 'PI_DEFAULT_PACKAGES' packages/coding-agent/src/core/package-manager.ts
            grep -q 'getDefaultPackageSourcesFromEnv' packages/coding-agent/src/core/package-manager.ts
            touch $out
            runHook postInstall
          '';
        };
      }
      // lib.optionalAttrs (extensionRegistry.kimi.stage or "active" != "paused") {
        pi-kimi-build = self.packages.${system}.pi-kimi;
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
            biome
            python3
            pkg-config
          ]
          ++ canvasNativeDeps;

        shellHook = ''
          echo "pi-flake dev shell — node $(node --version), bun v$(bun --version), python $(python3 --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);

    nixosModules.default = import ./nix/modules/nixos.nix self;

    # Extension package set keyed by bundled extension name. Lifecycle stage
    # comes from extensions/registry.nix; paused extensions are excluded.
    lib.extensionPackagesFor = system:
      nixpkgs.lib.filterAttrs (name: _: (extensionRegistry.${name}.stage or "active") != "paused") {
        "gecko-websearch" = self.packages.${system}."pi-gecko-websearch";
        rtk = self.packages.${system}."pi-rtk";
        aphrodite = self.packages.${system}."pi-aphrodite";
        interview = self.packages.${system}."pi-interview";
        "tool-management" = self.packages.${system}."pi-tool-management";
        "extension-management" = self.packages.${system}."pi-extension-management";
        webfetch = self.packages.${system}."pi-webfetch";
        hashline = self.packages.${system}."pi-hashline";
        "chrono-break" = self.packages.${system}."pi-chrono-break";

        advisor = self.packages.${system}."pi-advisor";
        review = self.packages.${system}."pi-review";
        vcc = self.packages.${system}."pi-vcc";
        caveman = self.packages.${system}."pi-caveman";
        quiet = self.packages.${system}."pi-quiet";
      };

    # Default bundle used by pi-full: lifecycle-active extensions only.
    # testing entries stay opt-in via extension flags; paused entries are not built.
    lib.defaultExtensionPackagesFor = system:
      nixpkgs.lib.filterAttrs (name: _: (extensionRegistry.${name}.stage or "active") == "active") (
        self.lib.extensionPackagesFor system
      );

    # Lifecycle registry (see extensions/registry.nix for stage semantics).
    lib.extensionRegistry = extensionRegistry;

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

                  # Create extension subdirectories, copy content, and prepend a
                  # .pi-gate.ts shim per extension. The gate returns early when its
                  # name appears in PI_EXT_DISABLED, so pi-extension-management can
                  # switch a bundled extension off for the session (pi clears its
                  # module cache on /reload, so the gate re-reads the env var).
                  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: ext: ''
              ext_dir="$out/share/pi/extensions/${name}"
              mkdir -p "$ext_dir"
              cp -R ${ext}/* "$ext_dir/" 2>/dev/null || true

              entries=$(${pkgs.jq}/bin/jq -r '.pi.extensions // [] | .[]' "$ext_dir/package.json" 2>/dev/null || true)
              if [ -z "$entries" ]; then
                # No pi.extensions manifest: pi falls back to index.ts/index.js.
                for idx in index.ts index.js; do
                  if [ -f "$ext_dir/$idx" ]; then entries="./$idx"; break; fi
                done
              fi

              if [ -n "$entries" ]; then
                {
                  i=0
                  names=""
                  for entry in $entries; do
                    echo "import factory$i from \"$entry\";"
                    names="$names''${names:+, }factory$i"
                    i=$((i + 1))
                  done
                  echo ""
                  echo "const GATE_NAME = \"${name}\";"
                  echo "const factories = [$names];"
                  echo ""
                  echo "export default async function gate(pi) {"
                  echo "  const disabled = (process.env.PI_EXT_DISABLED ?? \"\").split(\",\").map((s) => s.trim());"
                  echo "  if (disabled.includes(GATE_NAME)) return;"
                  echo "  for (const factory of factories) await factory(pi);"
                  echo "}"
                } > "$ext_dir/.pi-gate.ts"

                if [ -f "$ext_dir/package.json" ]; then
                  ${pkgs.jq}/bin/jq '.pi.extensions = ["./.pi-gate.ts"]' "$ext_dir/package.json" > "$ext_dir/.package.json.tmp" \
                    && mv "$ext_dir/.package.json.tmp" "$ext_dir/package.json"
                else
                  printf '{"pi":{"extensions":["./.pi-gate.ts"]}}\n' > "$ext_dir/package.json"
                fi
              fi
            '')
            extensions)}

                  # Create wrapper that exposes bundled extensions without mutating settings.
                  cat > $out/bin/.pi-wrapped << 'wrapper'
          #!/bin/bash
          set -euo pipefail

          export PI_PACKAGE_DIR="${pi}/share/pi"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0


          if [ -n "''${PI_DEFAULT_PACKAGES:-}" ]; then
            export PI_DEFAULT_PACKAGES="@out@/share/pi:''${PI_DEFAULT_PACKAGES}"
          else
            export PI_DEFAULT_PACKAGES="@out@/share/pi"
          fi

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

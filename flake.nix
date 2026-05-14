{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:earendil-works/pi?ref=main";
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

    piMinimalEditor.url = "path:./extensions/pi-minimal-editor";
    piMinimalEditor.inputs.nixpkgs.follows = "nixpkgs";

    piWorkingIndicator.url = "path:./extensions/pi-working-indicator";
    piWorkingIndicator.inputs.nixpkgs.follows = "nixpkgs";

    piPomodoro.url = "path:./extensions/pi-pomodoro";
    piPomodoro.inputs.nixpkgs.follows = "nixpkgs";


    piAbsurdSql.url = "path:./extensions/pi-absurd-sql";
    piAbsurdSql.inputs.nixpkgs.follows = "nixpkgs";
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
    piMinimalEditor,
    piWorkingIndicator,
    piPomodoro,
    piAbsurdSql,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = forAllSystems (system: import nixpkgs {inherit system;});
    packageJson = builtins.fromJSON (builtins.readFile "${piSrc}/packages/coding-agent/package.json");
    piPatches = [
      ./patches/disable-install-telemetry.patch
      ./patches/avoid-network-model-regeneration.patch
      ./patches/add-package-lock-registry-metadata.patch
      ./patches/remove-tree-filter-backcycle.patch
      ./patches/default-package-sources-env.patch
    ];
    coconutCreamPiPatches = [
  ./patches/coconut-cream/0001-agent-core-rlm-loop.patch
  ./patches/coconut-cream/0002-coding-agent-rlm-runtime.patch
  ./patches/coconut-cream/0003-coding-agent-rlm-session.patch
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
        npmDepsHash = "sha256-U+R8ekslHAcPmychptczVNp8p/w95au//DJ8S8M/ahA=";

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
          homepage = "https://github.com/earendil-works/pi";
          license = licenses.mit;
          mainProgram = "pi";
        };
      };

      "coconut-cream-pi" = pkgs.buildNpmPackage {
        pname = "coconut-cream-pi";
        version = packageJson.version;
        src = piSrc;
        patches = piPatches ++ coconutCreamPiPatches;
        npmWorkspace = "packages/coding-agent";
        npmBuildScript = "build:binary";
        npmDepsFetcherVersion = 2;

        # Regenerate after dependency changes:
        #   nix build .#coconut-cream-pi 2>&1 | grep 'got:' | awk '{print $2}'
        npmDepsHash = "sha256-U+R8ekslHAcPmychptczVNp8p/w95au//DJ8S8M/ahA=";

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
          description = "${packageJson.description} (RLM-first fork)";
          homepage = "https://github.com/earendil-works/pi";
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
      "pi-minimal-editor" = piMinimalEditor.packages.${system}.default;
      "pi-working-indicator" = piWorkingIndicator.packages.${system}.default;
      "pi-pomodoro" = piPomodoro.packages.${system}.default;
      "pi-absurd-sql" = piAbsurdSql.packages.${system}.default;
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
      lib = pkgs.lib;
    in {
      pi-build = self.packages.${system}.pi;
      coconut-cream-pi-build = self.packages.${system}."coconut-cream-pi";

      biome-lint = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-flake-biome-lint";
        version = "1";
        src = lib.cleanSourceWith {
          src = ./.;
          filter = path: type: let
            name = baseNameOf path;
          in
            !(name == ".git"
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
    });

    apps = forAllSystems (system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.pi}/bin/pi";
      };
      "coconut-cream-pi" = {
        type = "app";
        program = "${self.packages.${system}."coconut-cream-pi"}/bin/pi";
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
      "minimal-editor" = self.packages.${system}."pi-minimal-editor";
      "working-indicator" = self.packages.${system}."pi-working-indicator";
      pomodoro = self.packages.${system}."pi-pomodoro";
      "absurd-sql" = self.packages.${system}."pi-absurd-sql";
      review = self.packages.${system}."pi-review";
      vcc = self.packages.${system}."pi-vcc";
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

                  # Create wrapper that exposes bundled extensions without mutating settings.
                  cat > $out/bin/.pi-wrapped << 'wrapper'
          #!/bin/bash
          set -euo pipefail

          export PI_PACKAGE_DIR="${pi}/share/pi"
          export PI_SKIP_VERSION_CHECK=1
          export PI_RLM_PYTHON="${pkgs.python3}/bin/python3"
          export PATH="${pkgs.python3}/bin:$PATH"

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

{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:earendil-works/pi/9795d602306ef68a97585909e8e79f92a389057b";
      flake = false;
    };

    # prime-agent upstream fork with lockfile fixes for Nix build
    primeAgentSrc = {
      url = "github:y0usaf/prime-agent?ref=pa-prime-nix";
      flake = false;
    };

    # prime-bun: prime-agent fork with Bun-native compilation and sub-agent orchestration
    primeBunSrc = {
      url = "github:sng-asyncfunc/prime-bun";
      flake = false;
    };

    # ponytail: lazy senior dev mode — cuts unnecessary code, keeps safety
    ponytailSrc = {
      url = "github:DietrichGebert/ponytail";
      flake = false;
    };

    # pi-caveman: why use many token when few do trick (caveman mode)
    cavemanSrc = {
      url = "github:jonjonrankin/pi-caveman";
      flake = false;
    };

  };

  outputs = {
    self,
    nixpkgs,
    piSrc,
    primeAgentSrc,
    primeBunSrc,
    ponytailSrc,
    cavemanSrc,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = forAllSystems (system: import nixpkgs {inherit system;});
    packageJson = builtins.fromJSON (builtins.readFile "${piSrc}/packages/coding-agent/package.json");
    primeAgentPackageJson = builtins.fromJSON (builtins.readFile "${primeAgentSrc}/packages/coding-agent/package.json");
    primeBunPackageJson = builtins.fromJSON (builtins.readFile "${primeBunSrc}/packages/coding-agent/package.json");
    extensionRegistry = import ./extensions/registry.nix;
    # Kept minimal on purpose: anything achievable via env var or user config
    # must not be a patch (patches rot on every piSrc bump).
    #   install telemetry  -> PI_TELEMETRY=0 in the wrappers
    #   tree filter cycle  -> "app.tree.filter.cycleBackward": [] in keybindings.json
    piPatches = [
      ./patches/pi/avoid-network-model-regeneration.patch
      ./patches/pi/default-package-sources-env.patch
      ./patches/pi/user-message-bar.patch
      ./patches/pi/tui-overlay-invalidate-guard.patch
    ];
    # Prime-agent has models.generated.ts committed, so model regeneration
    # (requires network) is skipped inline in postPatch.
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

      # Collapse the near-identical stdenvNoCC extension packages. Each just
      # copies its package.json plus a few files/dirs into $out and stamps the
      # standard passthru.packageName + meta. Vendored extensions with postPatch
      # or tolerant copies (ponytail, caveman) stay explicit below.
      mkPiExtension = {pname, dir, copy, homepage ? null}: let
        src = lib.cleanSource dir;
        pkgJson = builtins.fromJSON (builtins.readFile "${dir}/package.json");
      in pkgs.stdenvNoCC.mkDerivation {
        inherit pname src;
        version = pkgJson.version;
        dontBuild = true;
        installPhase =
          "runHook preInstall\n"
          + "mkdir -p \"$out\"\n"
          + "cp package.json \"$out\"/\n"
          + lib.concatMapStringsSep "\n" (c: "cp -r ${c} \"$out\"/") copy
          + "\nrunHook postInstall\n";
        passthru.packageName = pkgJson.name;
        meta = with lib; {
          description = pkgJson.description;
          homepage = homepage or null;
          license = licenses.mit;
          platforms = platforms.all;
        };
      };
    in {
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
        npmDepsHash = "sha256-tIFX/vDb3hM9QiB/BtybZcgiH5I6TYlyfSSxhpA3VwY=";

        nodejs = pkgs.nodejs_22;

        nativeBuildInputs = with pkgs; [bun pkg-config makeWrapper];
        buildInputs = canvasNativeDeps ++ (with pkgs; [zeromq]);

        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/pi $out/bin

          cp -R packages/coding-agent/dist/. $out/share/pi/
          rm -f $out/share/pi/pi

          find . -name 'pi' -exec install -Dm755 {} $out/bin/pi \;
          wrapProgram $out/bin/pi \
            --set PI_PACKAGE_DIR $out/share/pi \
            --set PI_SKIP_VERSION_CHECK 1 \
            --set PI_TELEMETRY 0 \
            --set PI_SYMBOLS ascii

          runHook postInstall
        '';

        meta = with lib; {
          description = packageJson.description;
          homepage = "https://github.com/earendil-works/pi";
          license = licenses.mit;
          mainProgram = "pi";
        };
      };

      "pi-chronobreak" = mkPiExtension {
        pname = "pi-chronobreak";
        dir = ./extensions/pi-chronobreak;
        copy = ["README.md" "src"];
        homepage = "https://github.com/y0usaf/pi-flake";
      };


      "pi-agent" = mkPiExtension {
        pname = "pi-agent";
        dir = ./extensions/pi-agent;
        copy = ["README.md" "*.ts"];
      };


      "pi-sentinel" = mkPiExtension {
        pname = "pi-sentinel";
        dir = ./extensions/pi-sentinel;
        copy = ["README.md" "src"];
      };


      "pi-tools" = mkPiExtension {
        pname = "pi-tools";
        dir = ./extensions/retired/pi-tools;
        copy = ["extensions"];
      };

      "pi-unified-edit" = mkPiExtension {
        pname = "pi-unified-edit";
        dir = ./extensions/retired/pi-unified-edit;
        copy = ["src"];
      };

      # pi-batch: multi-op tool calls in one turn (reduces round-trips)
      "pi-batch" = mkPiExtension {
        pname = "pi-batch";
        dir = ./extensions/retired/pi-batch;
        copy = ["extensions"];
      };

      "pi-hashline" = mkPiExtension {
        pname = "pi-hashline";
        dir = ./extensions/pi-hashline;
        copy = ["README.md" "src"];
      };

      # ponytail: lazy senior dev mode (DietrichGebert/ponytail)
      "pi-ponytail" = let
        ponytailPackageJson = builtins.fromJSON (builtins.readFile "${ponytailSrc}/package.json");
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "ponytail";
          version = ponytailPackageJson.version;
          src = ponytailSrc;

          dontBuild = true;

          patches = [];

          postPatch = ''
            sed -i '/^function getConfigDir() {/,/^}$/c\
function getConfigDir() {\
  return path.join(os.homedir(), ".pi", "agent");\
}
' hooks/ponytail-config.js
            sed -i '/^function getConfigPath() {/,/^}$/c\
function getConfigPath() {\
  return path.join(getConfigDir(), "ponytail.json");\
}
' hooks/ponytail-config.js
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp package.json LICENSE AGENTS.md "$out"/
            cp -r pi-extension skills hooks assets "$out"/ 2>/dev/null || true
            runHook postInstall
          '';

          passthru.packageName = ponytailPackageJson.name;

          meta = with lib; {
            description = ponytailPackageJson.description;
            homepage = "https://github.com/DietrichGebert/ponytail";
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      # pi-caveman: why use many token when few do trick (jonjonrankin/pi-caveman)
      "pi-caveman" = let
        cavemanPackageJson = builtins.fromJSON (builtins.readFile "${cavemanSrc}/package.json");
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-caveman";
          version = cavemanPackageJson.version;
          src = cavemanSrc;

          dontBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp package.json LICENSE README.md "$out"/
            cp -r extensions scripts "$out"/ 2>/dev/null || true
            runHook postInstall
          '';

          passthru.packageName = cavemanPackageJson.name;

          meta = with lib; {
            description = cavemanPackageJson.description;
            homepage = "https://github.com/jonjonrankin/pi-caveman";
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      # pi-recap: Claude Code-style session recap above the status bar (L2ncE/pi-recap)
      "pi-recap" = mkPiExtension {
        pname = "pi-recap";
        dir = ./extensions/pi-recap;
        copy = ["LICENSE" "README.md" "extensions"];
        homepage = "https://github.com/L2ncE/pi-recap";
      };

      # pi-aliases: wraps bash grep->rg and find->fd for LLM shell calls
      "pi-aliases" = mkPiExtension {
        pname = "pi-aliases";
        dir = ./extensions/pi-aliases;
        copy = ["extensions"];
      };

      # pi with default extensions pre-bundled.
      # prime-agent builds via its own bun wrapper, not Nix's buildNpmPackage.
      # This avoids issues with unresolvable lockfile packages (undici-types@7.16.0).
      # prime-agent — uses pre-installed node_modules because the upstream
      # lockfile references packages not in the npm registry (@types/node@24.12.2).
      prime-agent = pkgs.stdenvNoCC.mkDerivation {
        pname = "prime-agent";
        version = primeAgentPackageJson.version;
        src = primeAgentSrc;

        # Needs network for npm install (lockfile has unreachable packages).
        __noChroot = true;
        # strip changes .bun section alignment (16384->4096), breaks bun's compiled-binary detection.
        dontStrip = true;

        nativeBuildInputs = with pkgs; [bun pkg-config makeWrapper nodejs_22 gcc gnumake python3Minimal];
        NODE_EXTRA_CA_CERTS = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        buildInputs = canvasNativeDeps;

        patchPhase = ''
          sed -i 's|"build": "npm run generate-models && tsgo -p tsconfig.build.json"|"build": "tsgo -p tsconfig.build.json"|' packages/ai/package.json
        '';

        buildPhase = ''
          export HOME="$TMPDIR"
          npm install 2>&1 | tail -20

          # Patch zeromq load-addon.js to use ZEROMQ_NODE_ADDON_DIR env var
          # Bun-compiled binary has __dirname baked to build path.
          # Env var lets runtime point to the Nix store copy.
          sed -i 's@path_1\.default\.resolve(__dirname, "\.\.", "build"@process.env.ZEROMQ_NODE_ADDON_DIR || path_1.default.resolve(__dirname, "..", "build"@' \
            "$NIX_BUILD_TOP/source/node_modules/zeromq/lib/load-addon.js"

          cd "$NIX_BUILD_TOP/source/packages/coding-agent"
          npm --prefix ../tui run build
          npm --prefix ../ai run build
          npm --prefix ../agent run build
          npm run build
          bun build --compile ./dist/bun/cli.js --outfile dist/pi
          npm run copy-binary-assets
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/share/pi $out/bin
          
          cp -R dist/. $out/share/pi/
          rm -f $out/share/pi/pi
          install -Dm755 dist/pi $out/bin/prime-agent
          ln -s prime-agent $out/bin/pi

# Copy full zeromq package so require("zeromq") resolves via NODE_PATH
# __dirname in store copy is permanent (not stale build path)
          zmq_pkg="$NIX_BUILD_TOP/source/node_modules/zeromq"
          if [ -d "$zmq_pkg" ]; then
            mkdir -p $out/share/node_modules
            cp -rL "$zmq_pkg" "$out/share/node_modules/zeromq"
          fi

          wrapProgram $out/bin/prime-agent \
            --set PI_PACKAGE_DIR $out/share/pi \
            --set PI_TELEMETRY 0 \
            --set PI_SYMBOLS ascii \
            --set ZEROMQ_NODE_ADDON_DIR $out/share/node_modules/zeromq/build --set NODE_PATH $out/share/node_modules \
            --prefix LD_LIBRARY_PATH : ${pkgs.stdenv.cc.cc.lib}/lib
          wrapProgram $out/bin/pi \
            --set PI_PACKAGE_DIR $out/share/pi \
            --set PI_TELEMETRY 0 \
            --set PI_SYMBOLS ascii \
            --set ZEROMQ_NODE_ADDON_DIR $out/share/node_modules/zeromq/build --set NODE_PATH $out/share/node_modules \
            --prefix LD_LIBRARY_PATH : ${pkgs.stdenv.cc.cc.lib}/lib
          runHook postInstall
        '';

        meta = with lib; {
          description = primeAgentPackageJson.description;
          homepage = "https://github.com/PrimeIntellect-ai/prime-agent";
          license = licenses.mit;
          mainProgram = "pi";
        };
      };

      prime-agent-full = self.lib.piWithExtensions {
        inherit pkgs;
        pi = self.packages.${system}.prime-agent;
        extensions = {
          chronobreak = self.packages.${system}."pi-chronobreak";
        };
      };

      # prime-bun: Bun-compiled standalone binary, parallel to prime-agent.
      # Build uses bun build --compile for a self-contained binary; static assets
      # (themes, skills, docs, examples) are installed to $out/share/prime-bun/.
      prime-bun = pkgs.stdenvNoCC.mkDerivation {
        pname = "prime-bun";
        version = primeBunPackageJson.version;
        src = primeBunSrc;

        # Needs network for npm install (lockfile may reference unreachable packages).
        __noChroot = true;

        nativeBuildInputs = with pkgs; [bun pkg-config makeWrapper nodejs_22 gcc gnumake python3Minimal];
        NODE_EXTRA_CA_CERTS = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        buildInputs = canvasNativeDeps;

        patchPhase = ''
          # Skip model generation (models.generated.ts is committed).
          sed -i 's|"build": "npm run generate-models && tsgo -p tsconfig.build.json"|"build": "tsgo -p tsconfig.build.json"|' packages/ai/package.json
        '';

        buildPhase = ''
          export HOME="$TMPDIR"
          npm install 2>&1 | tail -20
          cd $NIX_BUILD_TOP/source/packages/coding-agent
          npm run build:binary
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin $out/share/prime-bun
          # Install the standalone bun binary
          install -Dm755 dist/pi $out/bin/prime-bun
          # Install static assets alongside the binary (themes, skills, docs, etc.)
          # copy-binary-assets already staged these into dist/; skip JS files.
          for dir in theme assets export-html docs examples skills; do
            if [ -d "dist/$dir" ]; then
              cp -R "dist/$dir" "$out/share/prime-bun/"
            fi
          done
          cp dist/package.json dist/README.md dist/CHANGELOG.md "$out/share/prime-bun/" 2>/dev/null || true
          wrapProgram $out/bin/prime-bun \
            --set PI_PACKAGE_DIR $out/share/prime-bun \
            --set PI_TELEMETRY 0
          runHook postInstall
        '';

        meta = with lib; {
          description = primeBunPackageJson.description;
          homepage = "https://github.com/sng-asyncfunc/prime-bun";
          license = licenses.mit;
          mainProgram = "prime-bun";
          platforms = platforms.all;
        };
      };

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

      # Install telemetry is disabled via env, not a patch: assert all
      # wrappers really export it (upstream reads PI_TELEMETRY before settings).
      telemetry-disabled = pkgs.runCommand "pi-telemetry-disabled" {} ''
        grep -q 'PI_TELEMETRY' ${self.packages.${system}.pi}/bin/pi
        grep -q 'PI_TELEMETRY=0' ${self.packages.${system}.pi-full}/bin/pi
        grep -q 'PI_TELEMETRY=0' ${self.packages.${system}."prime-agent"}/bin/pi
        grep -q 'PI_TELEMETRY=0' ${self.packages.${system}."prime-agent-full"}/bin/pi
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
    # comes from extensions/registry.nix; paused and retired extensions are excluded.
    lib.extensionPackagesFor = system:
      nixpkgs.lib.filterAttrs (name: _: (extensionRegistry.${name}.stage or "active") != "paused" && (extensionRegistry.${name}.stage or "active") != "retired") {
        sentinel = self.packages.${system}."pi-sentinel";
        tools = self.packages.${system}."pi-tools";
        "chronobreak" = self.packages.${system}."pi-chronobreak";
        unified-edit = self.packages.${system}."pi-unified-edit";
        hashline = self.packages.${system}."pi-hashline";
        ponytail = self.packages.${system}."pi-ponytail";
        caveman = self.packages.${system}."pi-caveman";
        batch = self.packages.${system}."pi-batch";
        aliases = self.packages.${system}."pi-aliases";
        recap = self.packages.${system}."pi-recap";
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
    }: let
      # Each bundled extension dir is its own package root so readPiManifest
      # finds its package.json and loads .pi.extensions/.pi.skills/.pi.prompts.
      extensionPackageSources = pkgs.lib.concatStringsSep ":" (
        pkgs.lib.mapAttrsToList (name: _: "@out@/share/pi/extensions/${name}") extensions
      );
    in
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
                  # name appears in PI_EXT_DISABLED to switch a bundled extension
                  # off for the session (pi clears its module cache on /reload,
                  # so the gate re-reads the env var).
                  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: ext: ''
              ext_dir="$out/share/pi/extensions/${name}"
              mkdir -p "$ext_dir"
              cp -R ${ext}/* "$ext_dir/" 2>/dev/null || true
              if [ -d "$ext_dir/themes" ]; then
                mkdir -p "$out/share/pi/themes"
                cp "$ext_dir"/themes/*.json "$out/share/pi/themes/"
              fi

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
            export PI_DEFAULT_PACKAGES="${extensionPackageSources}:''${PI_DEFAULT_PACKAGES}"
          else
            export PI_DEFAULT_PACKAGES="${extensionPackageSources}"
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

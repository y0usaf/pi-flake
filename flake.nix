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

    piMinimal.url = "path:./extensions/pi-minimal";
    piMinimal.inputs.nixpkgs.follows = "nixpkgs";

    piInterview.url = "path:./extensions/pi-interview";
    piInterview.inputs.nixpkgs.follows = "nixpkgs";

    piToolManagement.url = "path:./extensions/pi-tool-management";
    piToolManagement.inputs.nixpkgs.follows = "nixpkgs";

    piWebfetch.url = "path:./extensions/pi-webfetch";
    piWebfetch.inputs.nixpkgs.follows = "nixpkgs";
    piHashline.url = "path:./extensions/pi-hashline";
    piHashline.inputs.nixpkgs.follows = "nixpkgs";

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
    piMinimal,
    piInterview,
    piToolManagement,
    piWebfetch,
    piHashline,
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
        "pi-minimal" = piMinimal.packages.${system}.default;
        "pi-interview" = piInterview.packages.${system}.default;
        "pi-tool-management" = piToolManagement.packages.${system}.default;
        "pi-webfetch" = piWebfetch.packages.${system}.default;
        "pi-hashline" = piHashline.packages.${system}.default;
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

        "pi-atelier" = let
          atelierPackageJson = builtins.fromJSON (builtins.readFile ./extensions/michaelmjhhhh_pi-atelier/package.json);
        in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-atelier";
            version = atelierPackageJson.version;
            src = lib.cleanSource ./extensions/michaelmjhhhh_pi-atelier;

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp package.json README.md CHANGELOG.md LICENSE "$out"/
              cp -r extensions src assets "$out"/

              runHook postInstall
            '';

            passthru.packageName = atelierPackageJson.name;

            meta = with lib; {
              description = atelierPackageJson.description;
              homepage = atelierPackageJson.homepage;
              license = licenses.mit;
              platforms = platforms.all;
            };
          };

        # pi-loom — workflow engine. Fork of pi-extensible-workflows 3.4.2
        # (MIT); the pristine upstream copy stays at
        # @extensions/vekexasia_pi-extensible-workflows/ as a reference tree
        # (diff base for cherry-picking upstream fixes), and is not packaged.
        # Pi loads ./src/index.ts directly; dist is shipped for the exports map;
        # production node_modules provide the runtime deps (acorn, minimatch).
        # Design: extensions/pi-loom/DESIGN.md
        pi-loom = let
          loomPackageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-loom/package.json);
        in
          pkgs.buildNpmPackage {
            pname = "pi-loom";
            version = loomPackageJson.version;
            src = lib.cleanSource ./extensions/pi-loom;

            npmBuildScript = "build";
            npmDepsFetcherVersion = 2;
            npmDepsHash = "sha256-3i3nSXTx1JpV6WmNSenJFE69KU46irXA5M0wFENLpMY=";

            nodejs = pkgs.nodejs_22;

            installPhase = ''
              runHook preInstall

              npm prune --omit=dev

              mkdir -p "$out"
              cp package.json README.md CHANGELOG.md "$out"/
              cp -r src skills examples dist "$out"/
              # Workflows are NOT shipped in the package: the system flake places
              # workflows/*/ into <agentDir>/workflows, the engine's third scan root.
              cp -r node_modules "$out"/

              runHook postInstall
            '';

            passthru.packageName = loomPackageJson.name;

            meta = with lib; {
              description = loomPackageJson.description;
              homepage = loomPackageJson.homepage;
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

        # Workflow-first Pi ("loom"). Deliberately NOT a second pi binary:
        # no extra piWithExtensions derivation, no renamed pi, no duplicate
        # bundle — just argv plus one env var. `--no-extensions` discards the
        # pi-full bundle so the loom stack is re-declared explicitly, which
        # proves doctrine 06 (bare core must boot) at runtime.
        # Design: extensions/pi-loom/DESIGN.md
        pi-loom-cli = let
          # P0 landed the engine fork. P1+ adds pi-loom-builtins and
          # pi-loom-router to this stack. See DESIGN.md roadmap.
          loomStack = [
            self.packages.${system}."pi-loom" # workflow engine
            self.packages.${system}."pi-interview" # backs human.ask
            self.packages.${system}."pi-aphrodite" # compression for long runs
            self.packages.${system}."pi-hashline" # edit anchors for executor sub-agents
            self.packages.${system}."pi-atelier" # status rail = live run progress
          ];
          # pi-tool-management is excluded on purpose: it persists a global
          # disabled-tools list and would fight the router's in-memory gate.
          extArgs = lib.concatMapStringsSep " " (ext: "-e ${ext}") loomStack;
        in
          pkgs.writeShellScriptBin "loom" ''
            # Only pi-full's wrapper exports this; loom wraps plain pi, so it
            # must export it itself or workflow child processes fail to spawn.
            export PI_WORKFLOW_NODE_PATH="${pkgs.nodejs_22}/bin/node"
            exec ${self.packages.${system}.pi}/bin/pi --no-extensions ${extArgs} "$@"
          '';

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
        pi-loom-build = self.packages.${system}."pi-loom";
        pi-loom-cli-build = self.packages.${system}.pi-loom-cli;

        # Build-only checks cannot see runtime wiring: pi-loom-cli-build proves
        # the wrapper evaluates, this proves it boots. Runs `loom` headlessly in
        # RPC mode with a throwaway HOME, asserts /workflow is registered, that
        # only the wrapper's own -e extensions load, and that a probe workflow
        # spawns a child process and returns (the PI_WORKFLOW_NODE_PATH path).
        pi-loom-cli-smoke = pkgs.runCommand "pi-loom-cli-smoke" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-cli-smoke.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P2a acceptance: human.ask is a DSL participant, so the only honest
        # gate is a real round trip. Boots `loom` in RPC mode, where
        # ctx.ui.select surfaces as an extension_ui_request line, answers it,
        # and requires the suspended run to resume with the chosen value.
        pi-loom-human-ask = pkgs.runCommand "pi-loom-human-ask" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-human-ask.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P2b acceptance: same reasoning as P2a, one primitive along. RPC
        # surfaces ctx.ui.editor as an extension_ui_request carrying the
        # prefill, so the harness can answer three edits in one run -- saved
        # with changes, saved byte-identical, and closed without saving -- and
        # require the workflow to tell all three apart.
        pi-loom-human-edit = pkgs.runCommand "pi-loom-human-edit" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.gnused pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-human-edit.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P2c acceptance: the last human primitive, and the only one whose
        # payload has to survive a stage boundary. The probe builds its second
        # review's prompt out of the first review's note, so the harness reads
        # the note back off the second picker -- proof the typed verdict's prose
        # reached the next stage rather than just the run result.
        pi-loom-human-review = pkgs.runCommand "pi-loom-human-review" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.gnused pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-human-review.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P3a acceptance: workflow slash commands are declared by command.json
        # alone, so the gate is a real dispatch. A probe command.json carrying an
        # argsSchema proves the generated signature reaches the palette, that
        # three different schema violations are each rejected with the generated
        # usage and no run, and that defaults and text-scalar coercion reach the
        # workflow child.
        pi-loom-workflow-args = pkgs.runCommand "pi-loom-workflow-args" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.gnused pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-workflow-args.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P3b acceptance: the other half of the declaration mechanism is where a
        # command.json may live. A probe repo carrying `.pi/workflows/` proves a
        # project-local spec reaches the palette and runs with nothing global
        # edited, that `/workflows` names the scope and root of every command,
        # that a project spec cannot shadow a user-scope command, and that a
        # malformed project spec is skipped instead of aborting extension load.
        pi-loom-project-workflows = pkgs.runCommand "pi-loom-project-workflows" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.gawk pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-project-workflows.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P4a acceptance: the stage library. A workflow script runs in a vm
        # sandbox with no module loader, so shared steps arrive as source the
        # engine appends to every body. This proves `stage(name, input)` is
        # callable without importing anything, that an unknown name and bad
        # input are rejected in the sandbox before any agent launch, and that a
        # script declaring its own top-level `stage` is refused at launch.
        pi-loom-stages = pkgs.runCommand "pi-loom-stages" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.gnused pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-stages.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        # P4b-i acceptance: the `exec` stage, which is the one that writes code.
        # An offline sandbox cannot run the implementing agent, so this proves
        # everything around it instead: exec is a stage with an enforced input
        # contract, and it opens a populated git worktree on its own branch and
        # reads that worktree's HEAD as the diff base *before* the agent is
        # launched. Needs git: the probe repository and the worktree are real.
        pi-loom-exec-stage = pkgs.runCommand "pi-loom-exec-stage" {
          nativeBuildInputs = [pkgs.bash pkgs.jq pkgs.gnugrep pkgs.gnused pkgs.gawk pkgs.git pkgs.findutils pkgs.coreutils];
        } ''
          bash ${./nix/checks/loom-exec-stage.sh} ${self.packages.${system}.pi-loom-cli}/bin/loom
          touch $out
        '';

        pi-aphrodite-test = piAphrodite.checks.${system}.test;
        pi-interview-test = piInterview.checks.${system}.test;
        pi-hashline-test = piHashline.checks.${system}.test;
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
        minimal = self.packages.${system}."pi-minimal";
        interview = self.packages.${system}."pi-interview";
        "tool-management" = self.packages.${system}."pi-tool-management";
        webfetch = self.packages.${system}."pi-webfetch";
        hashline = self.packages.${system}."pi-hashline";
        advisor = self.packages.${system}."pi-advisor";
        review = self.packages.${system}."pi-review";
        vcc = self.packages.${system}."pi-vcc";
        caveman = self.packages.${system}."pi-caveman";
        atelier = self.packages.${system}."pi-atelier";
        loom = self.packages.${system}."pi-loom";
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
          export PI_TELEMETRY=0

          # Real node for pi-loom workflow child processes (bun binary cannot
          # re-exec node flags; see extensions/pi-loom/src/agent-execution.ts).
          export PI_WORKFLOW_NODE_PATH="${pkgs.nodejs_22}/bin/node"

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

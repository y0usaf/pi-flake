{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:earendil-works/pi?ref=main";
      flake = false;
    };

    # Vendored engram learning plugin (nagisanzenin/engram).
    engramSrc = {
      url = "github:nagisanzenin/engram";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    piSrc,
    engramSrc,
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
      ./patches/user-message-bar.patch
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

      "pi-gecko-websearch" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-gecko-websearch/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-gecko-websearch";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-gecko-websearch;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp package.json README.md "$out"/
            cp -r src "$out"/
            runHook postInstall
          '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = "Pi extension that browses/searches the web via Gecko Marionette";
            license = licenses.mit;
            platforms = platforms.unix;
          };
        };

      "pi-rtk" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-rtk/package.json);
        rtk = pkgs.rtk.overrideAttrs (_old: {doCheck = false;});
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-rtk";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-rtk;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp package.json README.md CHANGELOG.md LICENSE index.ts "$out"/
            substituteInPlace "$out/index.ts" --replace-fail 'const RTK_COMMAND = "rtk";' 'const RTK_COMMAND = "${rtk}/bin/rtk";'
            runHook postInstall
          '';
          passthru = {
            packageName = packageJson.name;
            inherit rtk;
          };
          meta = with lib; {
            description = packageJson.description;
            homepage = packageJson.homepage;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-aphrodite" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-aphrodite/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-aphrodite";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-aphrodite;
          dontBuild = true;
          installPhase = ''runHook preInstall; mkdir -p "$out"; cp package.json README.md CHANGELOG.md index.ts "$out"/; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = packageJson.description;
            homepage = packageJson.homepage;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-interview" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-interview/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-interview";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-interview;
          dontBuild = true;
          installPhase = ''runHook preInstall; mkdir -p "$out"; cp package.json README.md "$out"/; cp -r src "$out"/; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = packageJson.description;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-management" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-management/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-management";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-management;
          dontBuild = true;
          installPhase = ''runHook preInstall; mkdir -p "$out"; cp package.json README.md "$out"/; cp -r src "$out"/; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = packageJson.description;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-webfetch" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-webfetch/package.json);
      in
        pkgs.buildNpmPackage {
          pname = "pi-webfetch";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-webfetch;
          npmDepsHash = "sha256-UPegfa9KGwdz9k8DsXz/hQaqWN43SXSlfJD2qlI0pfA=";
          nodejs = pkgs.nodejs_22;
          dontNpmBuild = true;
          installPhase = ''runHook preInstall; mkdir -p "$out"; cp -r package.json README.md src "$out"/; cp -r node_modules "$out"/node_modules; rm -f "$out/node_modules/.package-lock.json"; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = "Pi extension that fetches URLs and returns clean markdown";
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-hashline" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-hashline/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-hashline";
          version = packageJson.version;
          src = lib.cleanSourceWith {
            src = lib.cleanSource ./extensions;
            filter = path: type:
              let rel = lib.removePrefix (toString ./extensions) (toString path);
              in rel == "" || lib.hasPrefix "/pi-hashline" rel || lib.hasPrefix "/shared" rel;
          };
          dontBuild = true;
          installPhase = ''runHook preInstall; mkdir -p "$out"; cp $src/pi-hashline/package.json $src/pi-hashline/README.md "$out"/; cp -r $src/pi-hashline/src "$out"/; cp -r $src/shared "$out"/; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = packageJson.description;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-frames" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-frames/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-frames";
          version = packageJson.version;
          src = lib.cleanSourceWith {
            src = lib.cleanSource ./extensions;
            filter = path: type:
              let rel = lib.removePrefix (toString ./extensions) (toString path);
              in rel == "" || lib.hasPrefix "/pi-frames" rel || lib.hasPrefix "/shared" rel;
          };
          dontBuild = true;
          installPhase = ''runHook preInstall; mkdir -p "$out"; cp $src/pi-frames/package.json $src/pi-frames/README.md "$out"/; cp -r $src/pi-frames/src "$out"/; cp -r $src/shared "$out"/; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = packageJson.description;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-agents" = let
        packageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-agents/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-agents";
          version = packageJson.version;
          src = lib.cleanSource ./extensions/pi-agents;
          dontBuild = true;
                    installPhase = ''runHook preInstall; mkdir -p "$out"; cp package.json README.md index.ts config.ts contract.ts state.ts render.ts registry.ts spawn.ts loop.ts orchestrator.ts rpc-child.ts "$out"/; runHook postInstall '';
          passthru.packageName = packageJson.name;
          meta = with lib; {
            description = packageJson.description;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-pantera" = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-pantera";
        version = "0.1.0";
        src = lib.cleanSource ./extensions/pi-pantera;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp package.json index.ts "$out"/
          cp -r themes "$out"/
          runHook postInstall
        '';
        passthru.packageName = "pi-pantera";
        meta.description = "Charmtone Pantera theme for Pi";
      };

      "pi-dark-terminal" = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-dark-terminal";
        version = "0.1.0";
        src = lib.cleanSource ./extensions/pi-dark-terminal;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp package.json index.ts "$out"/
          cp -r themes "$out"/
          runHook postInstall
        '';
        passthru.packageName = "pi-dark-terminal";
        meta.description = "oh-my-pi dark-terminal theme for Pi";
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
            cp package.json README.md index.ts "$out"/
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
            cp package.json README.md LICENSE "$out"/
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

      # Vendored engram learning plugin (nagisanzenin/engram), built straight
      # from the engramSrc flake input (github:nagisanzenin/engram, MIT).
      "pi-engram" = let
        engramPackageJson = builtins.fromJSON (builtins.readFile "${engramSrc}/package.json");
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-engram";
          version = engramPackageJson.version;
          src = engramSrc;

          dontBuild = true;

          installPhase = ''
            runHook preInstall

            mkdir -p "$out"
            cp package.json LICENSE "$out"/
            # experiments/ ships the pre-registered preset designs that the
            # selftest loads from <plugin_root>/experiments/*.json.
            cp -r skills scripts pi agents gold experiments "$out"/

            runHook postInstall
          '';

          passthru.packageName = engramPackageJson.name;

          meta = with lib; {
            description = engramPackageJson.description;
            homepage = "https://github.com/nagisanzenin/engram";
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
            cp package.json README.md "$out"/
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

      "pi-continue" = let
        continuePackageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-continue/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-continue";
          version = continuePackageJson.version;
          src = lib.cleanSource ./extensions/pi-continue;

          dontBuild = true;

          installPhase = ''
            runHook preInstall

            mkdir -p "$out"
            cp package.json README.md "$out"/
            cp -r extensions "$out"/

            runHook postInstall
          '';

          passthru.packageName = continuePackageJson.name;

          meta = with lib; {
            description = continuePackageJson.description;
            homepage = continuePackageJson.homepage;
            license = licenses.mit;
            platforms = platforms.all;
          };
        };

      "pi-workflow" = let
        workflowPackageJson = builtins.fromJSON (builtins.readFile ./extensions/pi-workflow/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-workflow";
          version = workflowPackageJson.version;
          src = lib.cleanSource ./extensions/pi-workflow;

          dontBuild = true;

          installPhase = ''
            runHook preInstall

            mkdir -p "$out"
            cp package.json README.md "$out"/
            cp -r extensions "$out"/

            runHook postInstall
          '';

          passthru.packageName = workflowPackageJson.name;

          meta = with lib; {
            description = workflowPackageJson.description;
            homepage = workflowPackageJson.homepage;
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
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
    in {
      pi-build = self.packages.${system}.pi;

      pi-rtk-build = self.packages.${system}."pi-rtk";
      pi-rtk-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-rtk-test";
        version = (builtins.fromJSON (builtins.readFile ./extensions/pi-rtk/package.json)).version;
        src = lib.cleanSource ./extensions/pi-rtk;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''runHook preInstall; export HOME="$TMPDIR/home"; mkdir -p "$HOME"; bun test; touch "$out"; runHook postInstall '';
      };
      pi-aphrodite-build = self.packages.${system}."pi-aphrodite";
      pi-management-build = self.packages.${system}."pi-management";

      pi-quiet-build = self.packages.${system}."pi-quiet";
      pi-continue-build = self.packages.${system}."pi-continue";
      pi-workflow-build = self.packages.${system}."pi-workflow";
      pi-agents-build = self.packages.${system}."pi-agents";
      pi-pantera-build = self.packages.${system}."pi-pantera";
      pi-dark-terminal-build = self.packages.${system}."pi-dark-terminal";
      pi-full-dark-terminal-theme = pkgs.runCommand "pi-full-dark-terminal-theme" {} ''
        test -f ${self.packages.${system}.pi-full}/share/pi/themes/dark-terminal.json
        ! test -f ${self.packages.${system}.pi-full}/share/pi/themes/pantera.json
        touch $out
      '';

      pi-aphrodite-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-aphrodite-test";
        version = (builtins.fromJSON (builtins.readFile ./extensions/pi-aphrodite/package.json)).version;
        src = lib.cleanSource ./extensions/pi-aphrodite;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''runHook preInstall; export HOME="$TMPDIR/home"; mkdir -p "$HOME"; bun test; touch "$out"; runHook postInstall '';
      };
      pi-engram-selftest = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-engram-selftest";
        version = (builtins.fromJSON (builtins.readFile "${engramSrc}/package.json")).version;
        # Verify the PACKAGED tree runs, not just a raw checkout.
        src = self.packages.${system}."pi-engram";
        nativeBuildInputs = [pkgs.python3];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          python3 "$src/scripts/engram.py" selftest
          touch "$out"
          runHook postInstall
        '';
      };
      pi-pantera-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-pantera-test";
        version = (builtins.fromJSON (builtins.readFile ./extensions/pi-pantera/package.json)).version;
        src = lib.cleanSource ./extensions/pi-pantera;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''runHook preInstall; export HOME="$TMPDIR/home"; mkdir -p "$HOME"; bun test; touch "$out"; runHook postInstall '';
      };
      pi-dark-terminal-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-dark-terminal-test";
        version = (builtins.fromJSON (builtins.readFile ./extensions/pi-dark-terminal/package.json)).version;
        src = lib.cleanSource ./extensions/pi-dark-terminal;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''runHook preInstall; export HOME="$TMPDIR/home"; mkdir -p "$HOME"; bun test; touch "$out"; runHook postInstall '';
      };
      pi-interview-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-interview-tests";
        version = "0.1.0";
        src = lib.cleanSource ./extensions/pi-interview;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''bun test ./tests; touch "$out" '';
      };
      pi-frames-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-frames-tests";
        version = (builtins.fromJSON (builtins.readFile ./extensions/pi-frames/package.json)).version;
        src = lib.cleanSourceWith {
          src = lib.cleanSource ./extensions;
          filter = path: type:
            let rel = lib.removePrefix (toString ./extensions) (toString path);
            in rel == "" || lib.hasPrefix "/pi-frames" rel || lib.hasPrefix "/shared" rel;
        };
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''runHook preInstall; bun test; touch $out; runHook postInstall '';
      };
      pi-hashline-test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-hashline-tests";
        version = (builtins.fromJSON (builtins.readFile ./extensions/pi-hashline/package.json)).version;
        src = lib.cleanSourceWith {
          src = lib.cleanSource ./extensions;
          filter = path: type:
            let rel = lib.removePrefix (toString ./extensions) (toString path);
            in rel == "" || lib.hasPrefix "/pi-hashline" rel || lib.hasPrefix "/shared" rel;
        };
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''runHook preInstall; bun test; touch $out; runHook postInstall '';
      };
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
        management = self.packages.${system}."pi-management";
        webfetch = self.packages.${system}."pi-webfetch";
        hashline = self.packages.${system}."pi-hashline";
        frames = self.packages.${system}."pi-frames";
        agents = self.packages.${system}."pi-agents";
        pantera = self.packages.${system}."pi-pantera";
        dark-terminal = self.packages.${system}."pi-dark-terminal";

        review = self.packages.${system}."pi-review";
        vcc = self.packages.${system}."pi-vcc";
        caveman = self.packages.${system}."pi-caveman";
        engram = self.packages.${system}."pi-engram";
        quiet = self.packages.${system}."pi-quiet";
        continue = self.packages.${system}."pi-continue";
        workflow = self.packages.${system}."pi-workflow";
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
                  # name appears in PI_EXT_DISABLED, so pi-management can
                  # switch a bundled extension off for the session (pi clears its
                  # module cache on /reload, so the gate re-reads the env var).
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

{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:earendil-works/pi/f4585b8bec581d005cbb1edfc07edfcce723d0ae";
      flake = false;
    };

    # stock prime-agent upstream; lockfile issues fixed upstream (v0.7.2)
    primeAgentSrc = {
      type = "git";
      url = "https://github.com/PrimeIntellect-ai/prime-agent";
      ref = "main";
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

    # fff: fast file search SDK; pi-fff extension overrides grep/find with a
    # frecency-ranked fuzzy index. Pinned to the published 0.10.3 commit so the
    # source matches the 0.10.3 prebuilt native binaries fetched from npm.
    fffSrc = {
      url = "github:dmtrKovalenko/fff/e2cad2f09ea617d4c024f396f21d80e557f23a17";
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
    fffSrc,
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

      # --- prime-agent ipython kernel ---
      # The ipython tool runs a real Python process; upstream auto-bootstraps it
      # at first use via uv (downloads CPython + ipykernel + prime-agent-runtime
      # + pandas/numpy/scipy/... from PyPI). That needs uv + network and can't
      # run on NixOS, so build the kernel env here and point PRIME_AGENT_KERNEL_PYTHON
      # at it (the override path skips auto-bootstrap entirely).
      py = pkgs.python3Packages;
      # shtab completion tests fail in this nixpkgs rev
      tyro = py.tyro.overridePythonAttrs (_: { doCheck = false; });
      # rlm shim is not on PyPI; build it from the vendored source.
      prime-agent-runtime = py.buildPythonPackage {
        pname = "prime-agent-runtime";
        version = "0.1.0";
        pyproject = true;
        src = primeAgentSrc + "/prime-agent-runtime";
        build-system = [ py.hatchling ];
        dependencies = [ py.ipykernel py.mcp py.nest-asyncio tyro ];
        pythonRelaxDeps = [ "mcp" ];
      };
      # Built-in python skills must be importable in the (read-only) kernel env
      # or prime-agent disables them.
      skillDeps = {
        attach-image = [ py.pillow prime-agent-runtime ];
        linear = [ py.mcp py.httpx prime-agent-runtime ];
        notion = [ py.mcp py.httpx prime-agent-runtime ];
        websearch = [ py.httpx prime-agent-runtime ];
      };
      skillDir = primeAgentSrc + "/packages/coding-agent/skills";
      skillNames = builtins.attrNames (lib.filterAttrs (n: t:
        t == "directory" && builtins.pathExists (skillDir + "/${n}/pyproject.toml"))
        (builtins.readDir skillDir));
      resolveName = n: "prime-agent-skill-${n}";
      mkSkill = name: py.buildPythonPackage {
        pname = if builtins.elem name [ "attach-image" "linear" "notion" "websearch" ] then resolveName name else name;
        version = "0.1.0";
        pyproject = true;
        src = skillDir + "/${name}";
        build-system = [ py.hatchling ];
        dependencies = skillDeps.${name} or [ ];
      };
      pythonSkills = map mkSkill skillNames;
      kernelPython = pkgs.python3.withPackages (ps: with ps; [
        ipykernel dill nest-asyncio
        requests httpx pyyaml tomli python-dotenv
        pandas numpy scipy beautifulsoup4 lxml pydantic
        tyro prime-agent-runtime
      ] ++ pythonSkills);
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
        npmDepsHash = "sha256-a+q6PoOLp2MMmCs+IzHdqMkP1a7NcbmuYoHbJAiLvjU=";

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

      "pi-agents" = mkPiExtension {
        pname = "pi-agents";
        dir = ./extensions/pi-agents;
        copy = ["README.md" "index.ts"];
        homepage = "https://github.com/y0usaf/pi-flake";
      };

      # Vendored Autoprompt 1.0.4 doctrine, roles, and frameworks, adapted to
      # Earendil Pi's skill packages and the pi-agents spawn contract.
      "pi-autoprompt" = mkPiExtension {
        pname = "pi-autoprompt";
        dir = ./extensions/pi-autoprompt;
        copy = ["LICENSE" "README.md" "UPSTREAM_REVISION" "skills"];
        homepage = "https://github.com/Spielewoy/autoprompt-skill";
      };

      "pi-webfetch" = mkPiExtension {
        pname = "pi-webfetch";
        dir = ./extensions/pi-webfetch;
        copy = ["README.md" "src" "vendor"];
        homepage = "https://github.com/y0usaf/pi-flake";
      };

      "pi-yourshell" = mkPiExtension {
        pname = "pi-yourshell";
        dir = ./extensions/pi-yourshell;
        copy = ["src"];
        homepage = "https://github.com/y0usaf/pi-flake";
      };

      # pi-fff: FFF-backed grep/find override. Lazy index (builds on first
      # grep/find call); pi-agents orchestrator mode activates those tools.
      # Native libs are prebuilt npm binaries pinned by sha512 (no Rust build).
      "pi-fff" = let
        fffPkgJson = builtins.fromJSON (builtins.readFile "${fffSrc}/packages/pi-fff/package.json");
        fffFetch = url: hash: pkgs.fetchurl { inherit url hash; };
        fff-bun = fffFetch
          "https://registry.npmjs.org/@ff-labs/fff-bun/-/fff-bun-0.10.3.tgz"
          "sha512-KukJ61YeLHvWGgLZQGtAWIkYWhQYVdXcujEioq0UWjjlnSnJvsvm7EMN0JZIDXgG+MOJNii4Ir1+udPxRROf9A==";
        fff-bin-linux-x64-gnu = fffFetch
          "https://registry.npmjs.org/@ff-labs/fff-bin-linux-x64-gnu/-/fff-bin-linux-x64-gnu-0.10.3.tgz"
          "sha512-F1H0tP92FbaJfVzm79ptvHmR21QggNw+tQXUxq77HfKlnBLoT944pWH5MHaKGoz4pkF1Vg/hh0ROUaBTvF9Rmw==";
        fff-bin-linux-arm64-gnu = fffFetch
          "https://registry.npmjs.org/@ff-labs/fff-bin-linux-arm64-gnu/-/fff-bin-linux-arm64-gnu-0.10.3.tgz"
          "sha512-3MsSDY3GHLpA+RygqXs6lMeRRn5NfnhWNf/hWLGK/tmczPdQoMEjH25MhVk0HoCMOgrCP86jsBzF8QD9xgdglQ==";
        fff-bin-darwin-x64 = fffFetch
          "https://registry.npmjs.org/@ff-labs/fff-bin-darwin-x64/-/fff-bin-darwin-x64-0.10.3.tgz"
          "sha512-w2X8VmqjEWASmM5LgoytBUtuJTfnZQycpFE67MytfH+57mIO4SJ7cyxvdXw/LRCMIJOToh2A9hJGrEYSLPLa5Q==";
        fff-bin-darwin-arm64 = fffFetch
          "https://registry.npmjs.org/@ff-labs/fff-bin-darwin-arm64/-/fff-bin-darwin-arm64-0.10.3.tgz"
          "sha512-vMn3N39B+AJsjc24jvYsLvrc5VPo4ztSieeSjBkOYgQaG6coaVpSKPcgipJqPdv8VNLzLXd8j9O6FNP3e7HLrw==";
      in pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-fff";
        version = fffPkgJson.version;
        src = fffSrc + "/packages/pi-fff";

        postPatch = ''
          # Default to override mode: register grep/find under the built-in names
          # so pi's first-wins collision resolution replaces the fd/rg-backed tools.
          sed -i 's/^    "tools-and-ui";$/    "override";/' src/index.ts

          # Lazy indexing: skip the eager index build + autocomplete at session_start.
          # The index builds on the first grep/find call — which only happens once
          # pi-agents orchestrator mode activates those tools.
          sed -i 's/^      registerAutocompleteProvider(ctx);$/      if (currentMode !== "override") registerAutocompleteProvider(ctx);/' src/index.ts
          sed -i 's/^      await ensureFinder(activeCwd);$/      if (currentMode !== "override") await ensureFinder(activeCwd);/' src/index.ts
          sed -i 's/^      const atHome = enableHomeDirScanning && isHomeDir(activeCwd);$/      const atHome = currentMode !== "override" \&\& enableHomeDirScanning \&\& isHomeDir(activeCwd);/' src/index.ts
        '';

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp package.json "$out"/
          cp -r src "$out"/

          mkdir -p "$out/node_modules/@ff-labs"
          tar -xzf ${fff-bun} -C "$out/node_modules/@ff-labs" && mv "$out/node_modules/@ff-labs/package" "$out/node_modules/@ff-labs/fff-bun"
          tar -xzf ${fff-bin-linux-x64-gnu} -C "$out/node_modules/@ff-labs" && mv "$out/node_modules/@ff-labs/package" "$out/node_modules/@ff-labs/fff-bin-linux-x64-gnu"
          tar -xzf ${fff-bin-linux-arm64-gnu} -C "$out/node_modules/@ff-labs" && mv "$out/node_modules/@ff-labs/package" "$out/node_modules/@ff-labs/fff-bin-linux-arm64-gnu"
          tar -xzf ${fff-bin-darwin-x64} -C "$out/node_modules/@ff-labs" && mv "$out/node_modules/@ff-labs/package" "$out/node_modules/@ff-labs/fff-bin-darwin-x64"
          tar -xzf ${fff-bin-darwin-arm64} -C "$out/node_modules/@ff-labs" && mv "$out/node_modules/@ff-labs/package" "$out/node_modules/@ff-labs/fff-bin-darwin-arm64"
          runHook postInstall
        '';

        passthru.packageName = fffPkgJson.name;

        meta = with lib; {
          description = fffPkgJson.description;
          homepage = "https://github.com/dmtrKovalenko/fff";
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      "pi-gecko-websearch" = mkPiExtension {
        pname = "pi-gecko-websearch";
        dir = ./extensions/pi-gecko-websearch;
        copy = ["README.md" "src"];
        homepage = "https://github.com/y0usaf/pi-flake";
      };



      "pi-sentinel" = mkPiExtension {
        pname = "pi-sentinel";
        dir = ./extensions/pi-sentinel;
        copy = ["README.md" "src"];
      };

      "pi-heartbeat" = mkPiExtension {
        pname = "pi-heartbeat";
        dir = ./extensions/pi-heartbeat;
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
      # prime-agent runs the node bundle with a vendored runtime node_modules.
      # zeromq's NAPI addon needs real node (Bun lacks uv_async_init), so the
      # upstream bun-compiled binary crashes at startup.
      prime-agent = pkgs.buildNpmPackage {
        pname = "prime-agent";
        version = primeAgentPackageJson.version;
        src = primeAgentSrc;

        # Skip model regeneration: models.generated.ts is committed upstream.
        # Also vendor a lockfile with resolved+integrity URLs: upstream commits
        # one that omits them for 243 registry deps, which fetchNpmDeps needs.
        # Regenerate after primeAgentSrc bumps (see nix/prime-agent-lockfile.sh).
        postPatch = ''
          sed -i 's|"build": "npm run generate-models && tsgo -p tsconfig.build.json"|"build": "tsgo -p tsconfig.build.json"|' packages/ai/package.json
          cp ${./nix/prime-agent-package-lock.json} package-lock.json
        '';

        # Root "build" script chains tui -> ai -> agent -> coding-agent (node bundle).
        npmBuildScript = "build";
        npmDepsFetcherVersion = 2;
        npmDepsHash = "sha256-1sLVGKQmMfOW2hUNlxf2d2fjdd5EcqFZdhc0y6Wk0X8=";

        nodejs = pkgs.nodejs_22;
        nativeBuildInputs = with pkgs; [bun pkg-config makeWrapper gcc gnumake python3Minimal];
        buildInputs = canvasNativeDeps;

        # Root "build" runs the tsgo+bundle chain but not copy-binary-assets;
        # that step stages package.json/theme/assets/docs into dist/.
        postBuild = ''
          ( cd packages/coding-agent && npm run copy-binary-assets )
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out/share/pi $out/bin $out/share/node_modules

          cp -R packages/coding-agent/dist/. $out/share/pi/

          # Node bundle resolves built-ins under packageDir/dist/ (see config.ts
          # getThemesDir/getExportTemplateDir); our flattened install lacks dist/.
          mkdir -p $out/share/pi/dist
          ln -s ../modes $out/share/pi/dist/modes
          ln -s ../core $out/share/pi/dist/core
          ln -s ../skills $out/share/pi/dist/skills

          # Runtime node_modules: the bundle externalizes zeromq, undici,
          # photon-node and clipboard; zeromq needs cmake-ts at runtime.
          nm="$PWD/node_modules"
          for p in zeromq cmake-ts undici; do
            [ -d "$nm/$p" ] && cp -rL "$nm/$p" $out/share/node_modules/
          done
          mkdir -p $out/share/node_modules/@silvia-odwyer
          cp -rL "$nm/@silvia-odwyer/photon-node" $out/share/node_modules/@silvia-odwyer/
          if [ -d "$nm/@mariozechner/clipboard" ]; then
            mkdir -p $out/share/node_modules/@mariozechner
            cp -rL "$nm/@mariozechner/clipboard" $out/share/node_modules/@mariozechner/
          fi

          cat > $out/bin/prime-agent <<EOF
#!/bin/sh
export PI_PACKAGE_DIR='$out/share/pi'
export PI_TELEMETRY=0
export PI_SYMBOLS=ascii
export PRIME_AGENT_KERNEL_PYTHON='${kernelPython}/bin/python'
exec ${pkgs.nodejs_22}/bin/node $out/share/pi/bundle/cli.js "\$@"
EOF
          chmod +x $out/bin/prime-agent
          ln -s prime-agent $out/bin/pi
          runHook postInstall
        '';

        meta = with lib; {
          description = primeAgentPackageJson.description;
          homepage = "https://github.com/PrimeIntellect-ai/prime-agent";
          license = licenses.mit;
          mainProgram = "pi";
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

      # pi-fff sed patches landed: override mode + lazy index. A silent sed
      # no-op would leave built-in grep/find untouched — catch it here.
      pi-fff-override = pkgs.runCommand "pi-fff-override-check" {} ''
        grep -q '^    "override";$' ${self.packages.${system}."pi-fff"}/src/index.ts
        grep -q 'if (currentMode !== "override") await ensureFinder' ${self.packages.${system}."pi-fff"}/src/index.ts
        grep -q 'if (currentMode !== "override") registerAutocompleteProvider' ${self.packages.${system}."pi-fff"}/src/index.ts
        touch $out
      '';

      # The vendored package must expose one explicit-only Pi skill plus the
      # complete upstream OMP role/framework payload used by its adapter.
      pi-autoprompt-package = pkgs.runCommand "pi-autoprompt-package-check" {
        nativeBuildInputs = [pkgs.jq pkgs.python3];
      } ''
        pkg=${self.packages.${system}."pi-autoprompt"}
        test "$(${pkgs.jq}/bin/jq -r '.pi.skills[0]' "$pkg/package.json")" = "./skills"
        grep -q '^disable-model-invocation: true$' "$pkg/skills/autoprompt/SKILL.md"
        grep -q 'PI-AUTOPROMPT ADAPTER CONTRACT' "$pkg/skills/autoprompt/SKILL.md"
        test "$(find "$pkg/skills/autoprompt/agents" -maxdepth 1 -name 'ap-*.md' | wc -l)" -eq 25
        test "$(find "$pkg/skills/autoprompt/frameworks" -maxdepth 1 -name '*.md' | wc -l)" -eq 18
        ${pkgs.python3}/bin/python - <<'PY'
import pathlib
root = pathlib.Path("${self.packages.${system}."pi-autoprompt"}/skills/autoprompt/agents")
names = {p.stem for p in root.glob("ap-*.md")}
for path in root.glob("ap-*.md"):
    text = path.read_text()
    if not text.startswith("---\n"):
        raise SystemExit(f"missing frontmatter: {path}")
    for line in text.split("---", 2)[1].splitlines():
        role = line.strip().removeprefix("- ")
        if role.startswith("ap-") and role not in names:
            raise SystemExit(f"unknown spawn role {role} in {path}")
PY
        touch $out
      '';

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
              || name == "retired"
              || name == "vendor"
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
        touch $out
      '';

      # ipython tool would otherwise auto-bootstrap a venv via uv (needs network,
      # fails on NixOS); assert the wrapper points it at the built kernel env.
      kernel-python-wired = pkgs.runCommand "prime-agent-kernel-python-wired" {} ''
        grep -q 'PRIME_AGENT_KERNEL_PYTHON' ${self.packages.${system}."prime-agent"}/bin/pi
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
        heartbeat = self.packages.${system}."pi-heartbeat";
        agents = self.packages.${system}."pi-agents";
        autoprompt = self.packages.${system}."pi-autoprompt";
        "chronobreak" = self.packages.${system}."pi-chronobreak";
        ponytail = self.packages.${system}."pi-ponytail";
        caveman = self.packages.${system}."pi-caveman";
        aliases = self.packages.${system}."pi-aliases";
        recap = self.packages.${system}."pi-recap";
        webfetch = self.packages.${system}."pi-webfetch";
        gecko-websearch = self.packages.${system}."pi-gecko-websearch";
        yourshell = self.packages.${system}."pi-yourshell";
        fff = self.packages.${system}."pi-fff";
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
      # Load order is explicit priority (ascending), not alphabetical: pi
      # resolves tool-name collisions first-wins, so pi-agents (priority 10)
      # must load before pi-yourshell (100) or the main session keeps the
      # $SHELL bash tool after orchestrator mode strips it.
      extensionPackageSources = pkgs.lib.concatStringsSep ":" (
        map (name: "@out@/share/pi/extensions/${name}")
          (pkgs.lib.sort
            (a: b: (extensionRegistry.${a}.priority or 100) < (extensionRegistry.${b}.priority or 100))
            (builtins.attrNames extensions))
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

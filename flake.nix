{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:earendil-works/pi/42f7f29ad1cf15d6ec7eb5f41749b2e6ab291eb2";
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

  };

  outputs = {
    self,
    nixpkgs,
    piSrc,
    primeAgentSrc,
    primeBunSrc,
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
      # standard passthru.packageName + meta.
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
        npmDepsHash = "sha256-HbyVuaW0XqqgwCszmBcdlsbBrCJxUA1/DvLmIhTgqSE=";

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



      # pi-fabric: programmable tool and agent runtime (QuickJS, MCP, actors,
      # councils, workflows). Replaces the retired pi-agents extension. Built
      # from source with npm (pnpm-lock is not buildNpmPackage-compatible; the
      # generated package-lock.json is vendored below). The trailing pnpm-only
      # assert step is dropped — the build's own artifact checks suffice.
      "pi-fabric" = let
        fabricPkgJson = builtins.fromJSON (builtins.readFile ./extensions/pi-fabric/package.json);
      in pkgs.buildNpmPackage {
        pname = "pi-fabric";
        version = fabricPkgJson.version;
        src = ./extensions/pi-fabric;

        # Vendor an npm lockfile (upstream ships pnpm-lock.yaml) and drop the
        # trailing pnpm-only assert step from the build script.
        # Pi's jiti loader cannot resolve Shiki's package-internal lazy imports,
        # so preload the grammar modules from Fabric's own graph.
        postPatch = ''
          cp ${./nix/fabric-package-lock.json} package-lock.json
          sed -i 's/ && pnpm run assert:build-artifacts//' package.json
        '';

        npmBuildScript = "build";
        npmDepsFetcherVersion = 2;
        npmDepsHash = "sha256-dZaH8U8FuuCKUUnbbdD10fYR2bCip7VfGJyTaECHHn8=";

        nodejs = pkgs.nodejs_24;

        installPhase = ''
          runHook preInstall
          chmod +w package-lock.json
          npm prune --omit=dev
          mkdir -p $out
          cp -R dist skills docs package.json README.md LICENSE THIRD_PARTY_NOTICES.md $out/ 2>/dev/null || true
          cp -R node_modules $out/
          runHook postInstall
        '';

        passthru.packageName = fabricPkgJson.name;

        meta = with lib; {
          description = fabricPkgJson.description;
          homepage = "https://github.com/monotykamary/pi-fabric";
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

      # pi-vercel-ai-gateway: Vercel AI Gateway provider (Kushalkhemka/pi-vercel-ai-gateway).
      # Runtime imports @ai-sdk/gateway + ai; node_modules is installed from the
      # vendored lockfile, so this one is buildNpmPackage, not mkPiExtension.
      "pi-vercel-ai-gateway" = let
        pkgJson = builtins.fromJSON (builtins.readFile ./extensions/pi-vercel-ai-gateway/package.json);
      in pkgs.buildNpmPackage {
        pname = "pi-vercel-ai-gateway";
        version = pkgJson.version;
        src = ./extensions/pi-vercel-ai-gateway;

        postPatch = ''
          cp ${./extensions/pi-vercel-ai-gateway/package-lock.json} package-lock.json
        '';

        dontNpmBuild = true;
        npmDepsFetcherVersion = 2;
        npmDepsHash = "sha256-dBKsajkvGHljSRKREDJWv9zdDalprvBju1lXMl/Geqg=";

        nodejs = pkgs.nodejs_22;
        installPhase = ''
          runHook preInstall
          # The npmConfigHook materializes node_modules from the fetched deps;
          # prune --omit=dev must keep runtime deps (all three are in
          # "dependencies"), verified here before anything is copied.
          npm prune --omit=dev
          test -d node_modules/@ai-sdk/gateway
          test -d node_modules/ai
          test -d node_modules/zod
          mkdir -p $out
          cp -R src package.json README.md LICENSE node_modules $out/
          runHook postInstall
        '';

        passthru.packageName = pkgJson.name;

        meta = with lib; {
          description = pkgJson.description;
          homepage = "https://github.com/Kushalkhemka/pi-vercel-ai-gateway";
          license = licenses.mit;
          platforms = platforms.all;
        };
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
        npmDepsHash = "sha256-dUk0oDFErmbAS94losw6xVy+jIC+zk8/L0w1haXH4a4=";

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
    } // lib.optionalAttrs (system == "x86_64-linux") {
      # donsetch: prebuilt DonSeTch binary (dondai44423/donsetch v3.4.4, AGPL-3.0).
      # Upstream ships an Ubuntu 22.04 glibc binary; interpreter and rpath are
      # patched explicitly (autoPatchelfHook only sees NEEDED entries, and
      # libonnxruntime.so is dlopened at runtime). The binary looks up
      # libonnxruntime.so next to itself, so both live in $out/bin.
      donsetch = pkgs.stdenvNoCC.mkDerivation {
        pname = "donsetch";
        version = "3.4.4";
        src = pkgs.fetchurl {
          url = "https://github.com/dondai44423/donsetch/releases/download/v3.4.4/donsetch-linux-x64.tar.gz";
          hash = "sha256-0x4udaeRMyxMcnPxrPprucuVhbtvlQyR7WIa4E1zXTU=";
        };
        nativeBuildInputs = [pkgs.patchelf];
        dontConfigure = true;
        dontBuild = true;
        dontUnpack = true;
        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin
          tar -xzf $src -C $out/bin
          install -m755 $out/bin/donsetch $out/bin/donsetch.tmp
          mv $out/bin/donsetch.tmp $out/bin/donsetch
          chmod 644 $out/bin/libonnxruntime.so
          patchelf --set-interpreter ${pkgs.stdenv.cc.bintools.dynamicLinker} $out/bin/donsetch
          patchelf --set-rpath $out/bin:${pkgs.stdenv.cc.cc.lib}/lib $out/bin/donsetch
          runHook postInstall
        '';
        meta = with lib; {
          description = "Web fetch, search, and crawl for AI agents. Zero API keys. Chrome-true TLS.";
          homepage = "https://github.com/dondai44423/donsetch";
          license = licenses.agpl3Only;
          platforms = platforms.x86_64;
          mainProgram = "donsetch";
        };
      };

      # pi-donsetch: vendored pi extension (npm:donsetch 3.4.4, verbatim copy
      # of package.json + pi-extension.ts). Pi's jiti aliases typebox and
      # @earendil-works/pi-tui, so no node_modules are vendored. binaries/
      # symlinks the patched binary so the session-start install.js network
      # fallback never fires.
      "pi-donsetch" = let
        pkgJson = builtins.fromJSON (builtins.readFile ./extensions/pi-donsetch/package.json);
      in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "pi-donsetch";
          version = pkgJson.version;
          src = lib.cleanSource ./extensions/pi-donsetch;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/binaries
            cp package.json pi-extension.ts README.md $out/
            ln -s ${self.packages.${system}.donsetch}/bin/donsetch $out/binaries/donsetch
            runHook postInstall
          '';
          passthru.packageName = pkgJson.name;
          meta = with lib; {
            description = pkgJson.description;
            homepage = "https://github.com/dondai44423/donsetch";
            license = licenses.agpl3Only;
            platforms = platforms.x86_64;
          };
        };

    });
    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
    in {
      pi-build = self.packages.${system}.pi;

      # pi-fabric: assert the built dist registers the fabric_exec tool and
      # carries its runtime node_modules (quickjs, shiki, etc.).
      fabric-built = pkgs.runCommand "pi-fabric-built-check" {} ''
        grep -q 'fabric_exec' ${self.packages.${system}."pi-fabric"}/dist/index.js
        test -d ${self.packages.${system}."pi-fabric"}/node_modules/quickjs-emscripten-core
        test -d ${self.packages.${system}."pi-fabric"}/node_modules/shiki
        test -d ${self.packages.${system}."pi-fabric"}/node_modules/@shikijs/langs
        grep -R -q 'PRELOADED_LANGUAGES' ${self.packages.${system}."pi-fabric"}/dist/chunks
        touch $out
      '';

      # Exercise the lazy Shiki import through Pi's jiti extension loader.
      fabric-shiki-host = pkgs.runCommand "pi-fabric-shiki-host-check" {} ''
        set -euo pipefail
        smoke="$TMPDIR/fabric-shiki-smoke"
        mkdir -p "$smoke"
        chunk=$(grep -R -l 'var PRELOADED_LANGUAGES' ${self.packages.${system}."pi-fabric"}/dist/chunks | head -1)
        cat > "$smoke/package.json" <<'JSON'
{"name":"fabric-shiki-smoke","version":"0.0.0","type":"module","pi":{"extensions":["./index.mjs"]}}
JSON
        cat > "$smoke/index.mjs" <<EOF
import { configureHighlighting, highlightCode } from "$chunk";
export default function smoke(pi) {
  pi.on("session_start", async () => {
    configureHighlighting("github-dark");
    highlightCode("echo hi", "bash", () => {});
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!highlightCode("echo hi", "bash", () => {})) {
      throw new Error("Shiki returned no highlighted output");
    }
    console.error("FABRIC_SHIKI_HOST_SMOKE_OK");
  });
}
EOF
        output="$TMPDIR/fabric-shiki-output"
        printf '{"id":"state","type":"get_state"}\n' |
          PI_DEFAULT_PACKAGES="$smoke" \
          ${pkgs.coreutils}/bin/timeout 30s ${self.packages.${system}.pi-full}/bin/pi \
            --no-session --offline --mode rpc >"$output" 2>&1
        grep -q 'FABRIC_SHIKI_HOST_SMOKE_OK' "$output"
        ! grep -q 'Cannot find module.*@shikijs/langs' "$output"
        touch "$out"
      '';

      # A nested or sibling pi wrapper can inherit an older bundle through
      # PI_DEFAULT_PACKAGES. Its duplicate extension names must not collide.
      pi-nested-bundle = pkgs.runCommand "pi-nested-bundle-check" {} ''
        set -euo pipefail
        parent="$TMPDIR/parent/share/pi/extensions/fabric"
        mkdir -p "$parent"
        cp -R ${self.packages.${system}.pi-full}/share/pi/extensions/fabric/. "$parent/"
        output="$TMPDIR/rpc-output"
        printf '{"id":"state","type":"get_state"}\n' |
          PI_DEFAULT_PACKAGES="$parent" \
          timeout 20s ${self.packages.${system}.pi-full}/bin/pi \
            --no-session --offline --mode rpc >"$output" 2>&1
        ! grep -q 'conflicts with' "$output"
        grep -q '"command":"get_state"' "$output"
        touch "$out"
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
    } // lib.optionalAttrs (system == "x86_64-linux") {
      # donsetch: the patched binary runs and the extension package carries
      # binaries/donsetch, so the session-start network fallback never fires.
      donsetch-built = pkgs.runCommand "donsetch-built-check" {} ''
        b=${self.packages.${system}."pi-donsetch"}/binaries/donsetch
        re=${pkgs.binutils.bintools}/bin/readelf
        # interpreter points at the nix glibc, rpath carries gcc's libstdc++
        grep -q "${pkgs.stdenv.cc.bintools.dynamicLinker}" <($re -p .interp $b)
        $re -d $b | grep -q "${pkgs.stdenv.cc.cc.lib}/lib"
        test -x ${self.packages.${system}.donsetch}/bin/donsetch
        touch $out
      '';
    });

    apps = forAllSystems (system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.pi}/bin/pi";
      };
    });

    devShells = forAllSystems (system: let
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

    # Extension package set keyed by bundled extension name. Lifecycle stage
    # comes from extensions/registry.nix; paused and retired extensions are excluded.

    lib.extensionPackagesFor = system:
      nixpkgs.lib.filterAttrs (name: _: (extensionRegistry.${name}.stage or "active") != "paused" && (extensionRegistry.${name}.stage or "active") != "retired") ({
        "chronobreak" = self.packages.${system}."pi-chronobreak";
        recap = self.packages.${system}."pi-recap";
        fabric = self.packages.${system}.pi-fabric;
        vercel-ai-gateway = self.packages.${system}."pi-vercel-ai-gateway";
      } // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
        donsetch = self.packages.${system}."pi-donsetch";
      });

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
      # Load order is explicit priority (ascending), not alphabetical: lower
      # priorities win tool-name collisions.
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



          # Child Pi processes inherit this variable. Drop inherited copies of
          # bundled extension names; different store paths otherwise register
          # the same tools twice.
          inherited_default_packages=""
          if [ -n "''${PI_DEFAULT_PACKAGES:-}" ]; then
            IFS=: read -r -a inherited_packages <<< "''${PI_DEFAULT_PACKAGES}"
            for package_source in "''${inherited_packages[@]}"; do
              case "$package_source" in
                ${pkgs.lib.concatStringsSep "|" (["__pi_never_matches__"] ++ map (name: "*/share/pi/extensions/${name}") (builtins.attrNames extensions))})
                  continue
                  ;;
              esac
              if [ -n "$package_source" ]; then
                if [ -n "$inherited_default_packages" ]; then
                  inherited_default_packages="$inherited_default_packages:$package_source"
                else
                  inherited_default_packages="$package_source"
                fi
              fi
            done
          fi
          if [ -n "$inherited_default_packages" ]; then
            export PI_DEFAULT_PACKAGES="${extensionPackageSources}:$inherited_default_packages"
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

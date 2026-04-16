{
  description = "pi flake with local extensions + upstream patches";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    piSrc = {
      url = "github:badlogic/pi-mono?ref=main";
      flake = false;
    };

    piAgents.url = "path:./packages/pi-agents";
    piAgents.inputs.nixpkgs.follows = "nixpkgs";

    piCodexFastFlake.url = "path:./packages/pi-codex-fast-flake";
    piCodexFastFlake.inputs.nixpkgs.follows = "nixpkgs";

    piAdversaryFlake.url = "path:./packages/pi-adversary-flake";
    piAdversaryFlake.inputs.nixpkgs.follows = "nixpkgs";

    piGeckoWebsearch.url = "path:./packages/pi-gecko-websearch";
    piGeckoWebsearch.inputs.nixpkgs.follows = "nixpkgs";

    piRtkFlake.url = "path:./packages/pi-rtk-flake";
    piRtkFlake.inputs.nixpkgs.follows = "nixpkgs";

    piWebfetch.url = "path:./packages/pi-webfetch";
    piWebfetch.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    piSrc,
    piAgents,
    piCodexFastFlake,
    piAdversaryFlake,
    piGeckoWebsearch,
    piRtkFlake,
    piWebfetch,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = forAllSystems (system: import nixpkgs {inherit system;});
  in {
    packages = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
      packageJson = builtins.fromJSON (builtins.readFile "${piSrc}/packages/coding-agent/package.json");

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
        patches = [
          ./patches/disable-install-telemetry.patch
          ./patches/avoid-network-model-regeneration.patch
        ];
        npmWorkspace = "packages/coding-agent";
        npmBuildScript = "build:binary";
        npmDepsFetcherVersion = 2;

        # Regenerate after dependency changes:
        #   nix build .#pi 2>&1 | grep 'got:' | awk '{print $2}'
        npmDepsHash = "sha256-kHKcxsCEU1vQ6Nw8i3+917r1qJdkinlgF+whaMLsqbU=";

        nodejs = pkgs.nodejs_22;

        nativeBuildInputs = with pkgs; [bun pkg-config makeWrapper];
        buildInputs = canvasNativeDeps;

        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/pi $out/bin

          cp -R packages/coding-agent/dist/. $out/share/pi/
          rm -f $out/share/pi/pi

          install -Dm755 packages/coding-agent/dist/pi $out/bin/pi
          wrapProgram $out/bin/pi --set PI_PACKAGE_DIR $out/share/pi

          runHook postInstall
        '';

        meta = with lib; {
          description = packageJson.description;
          homepage = "https://github.com/badlogic/pi-mono";
          license = licenses.mit;
          mainProgram = "pi";
        };
      };

      "pi-agents" = piAgents.packages.${system}.default;
      "pi-codex-fast-flake" = piCodexFastFlake.packages.${system}.default;
      "pi-adversary-flake" = piAdversaryFlake.packages.${system}.default;
      "pi-gecko-websearch" = piGeckoWebsearch.packages.${system}.default;
      "pi-rtk-flake" = piRtkFlake.packages.${system}.default;
      "pi-webfetch" = piWebfetch.packages.${system}.default;

      default = self.packages.${system}.pi;
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
        packages = with pkgs; [
          nodejs_22
          bun
          pkg-config
        ] ++ canvasNativeDeps;

        shellHook = ''
          echo "pi-flake dev shell — node $(node --version), bun v$(bun --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

{
  description = "Nix flake for pi-rtk";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = forAllSystems (system: import nixpkgs {inherit system;});
  in {
    packages = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in {
      pi-rtk = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-rtk";
        version = packageJson.version;
        src = lib.cleanSource ./.;

        dontBuild = true;

        installPhase = ''
          runHook preInstall

          mkdir -p "$out"
          cp package.json README.md CHANGELOG.md LICENSE index.ts "$out"/

          substituteInPlace "$out/index.ts" \
            --replace-fail 'const RTK_COMMAND = "rtk";' 'const RTK_COMMAND = "${pkgs.rtk}/bin/rtk";'
          runHook postInstall
        '';

        passthru = {
          packageName = packageJson.name;
          rtk = pkgs.rtk;
        };

        meta = with lib; {
          description = packageJson.description;
          homepage = packageJson.homepage;
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-rtk;
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-rtk-test";
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
        src = pkgs.lib.cleanSource ./.;

        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;

        installPhase = ''
          runHook preInstall

          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          bun test
          touch "$out"

          runHook postInstall
        '';
      };
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          bun
          nodejs_22
          rtk
        ];

        shellHook = ''
          echo "pi-rtk dev shell — node $(node --version), bun v$(bun --version), rtk $(rtk --version 2>/dev/null || echo unavailable)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

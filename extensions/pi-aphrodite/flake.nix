{
  description = "Nix flake for pi-aphrodite";

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
      pi-aphrodite = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-aphrodite";
        version = packageJson.version;
        src = lib.cleanSource ./.;

        dontBuild = true;

        installPhase = ''
          runHook preInstall

          mkdir -p "$out"
          cp package.json README.md CHANGELOG.md index.ts "$out"/

          runHook postInstall
        '';

        passthru = {
          packageName = packageJson.name;
        };

        meta = with lib; {
          description = packageJson.description;
          homepage = packageJson.homepage;
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-aphrodite;
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-aphrodite-test";
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
        ];

        shellHook = ''
          echo "pi-aphrodite dev shell — node $(node --version), bun v$(bun --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

{
  description = "Nix flake for pi-codex-fast";

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
      pi-codex-fast-flake = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-codex-fast-flake";
        version = packageJson.version;
        src = lib.cleanSource ./.;

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -r . "$out"
          runHook postInstall
        '';

        passthru = {
          packageName = packageJson.name;
        };

        meta = with lib; {
          description = "Pi extension that enables Codex fast mode via extension-settings.json";
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-codex-fast-flake;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
        ];

        shellHook = ''
          echo "pi-codex-fast-flake dev shell — node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

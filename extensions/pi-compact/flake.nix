{
  description = "Nix flake for pi-compact";

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
      pi-compact = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-compact";
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
          description = "Pi extension that compacts collapsed tools and optionally user inputs to one line";
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-compact;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
        ];

        shellHook = ''
          echo "pi-compact dev shell — node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

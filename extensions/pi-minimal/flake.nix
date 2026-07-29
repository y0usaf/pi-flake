{
  description = "Nix flake for pi-minimal";

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
      pi-minimal = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-minimal";
        version = packageJson.version;
        src = lib.cleanSource ./.;

        dontBuild = true;

        installPhase = ''
          runHook preInstall

          mkdir -p "$out"
          cp package.json README.md DESIGN.md "$out"/
          cp -r src themes "$out"/

          runHook postInstall
        '';

        passthru = {
          packageName = packageJson.name;
        };

        meta = with lib; {
          description = "Quieter pi TUI: denser tool rows plus the low-contrast 'quiet' theme";
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-minimal;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
        ];

        shellHook = ''
          echo "pi-minimal dev shell — node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

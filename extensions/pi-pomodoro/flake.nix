{
  description = "Nix flake for pi-pomodoro";

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
      pi-pomodoro = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-pomodoro";
        version = packageJson.version;
        src = lib.cleanSource ./.;

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp package.json README.md "$out"/
          cp -r src "$out"/
          runHook postInstall
        '';

        passthru = {
          packageName = packageJson.name;
        };

        meta = with lib; {
          description = "Synced non-blocking pomodoro indicator for Pi";
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-pomodoro;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
        ];

        shellHook = ''
          echo "pi-pomodoro dev shell — node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

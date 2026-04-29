{
  description = "Nix flake for pi-gecko-websearch";

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
      pi-gecko-websearch = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-gecko-websearch";
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
          description = "Pi extension that browses/searches the web via Gecko Marionette";
          license = licenses.mit;
          platforms = platforms.unix;
        };
      };

      default = self.packages.${system}.pi-gecko-websearch;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
        ] ++ pkgs.lib.optionals (pkgs ? librewolf) [
          pkgs.librewolf
        ];

        shellHook = ''
          echo "pi-gecko-websearch dev shell — node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

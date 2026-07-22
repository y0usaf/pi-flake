{
  description = "Nix flake for pi-interview";

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
      pi-interview = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-interview";
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

        passthru.packageName = packageJson.name;

        meta = with lib; {
          description = packageJson.description;
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-interview;
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
    in {
      test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-interview-tests";
        version = "0.1.0";
        src = lib.cleanSource ./.;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          bun test ./tests
          touch "$out"
        '';
      };
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [bun nodejs_22];
        shellHook = ''
          echo "pi-interview dev shell — node $(node --version), bun v$(bun --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

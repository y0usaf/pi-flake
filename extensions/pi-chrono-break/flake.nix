{
  description = "Nix flake for pi-chrono-break";

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
      pi-chrono-break = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-chrono-break";
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

      default = self.packages.${system}.pi-chrono-break;
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor.${system};
      lib = pkgs.lib;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in {
      test = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-chrono-break-tests";
        version = packageJson.version;
        src = lib.cleanSource ./.;
        nativeBuildInputs = [pkgs.bun];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          bun test ./tests
          touch "$out"
          runHook postInstall
        '';
      };

      default = self.checks.${system}.test;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [bun nodejs_22];
        shellHook = ''
          echo "pi-chrono-break dev shell — node $(node --version), bun v$(bun --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

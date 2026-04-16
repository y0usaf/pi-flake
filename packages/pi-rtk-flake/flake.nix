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
          cp -r . "$out"

          substituteInPlace "$out/index.ts" \
            --replace-fail 'execFileSync("rtk", ["rewrite", command], {' 'execFileSync("${pkgs.rtk}/bin/rtk", ["rewrite", command], {'

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

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          rtk
        ];

        shellHook = ''
          echo "pi-rtk dev shell — node $(node --version), rtk $(rtk --version 2>/dev/null || echo unavailable)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

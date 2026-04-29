{
  description = "Nix flake for pi-webfetch";

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
      pi-webfetch = pkgs.buildNpmPackage {
        pname = "pi-webfetch";
        version = packageJson.version;
        src = lib.cleanSource ./.;

        # Regenerate after dependency changes:
        #   nix build .# 2>&1 | grep 'got:' | awk '{print $2}'
        npmDepsHash = "sha256-eXZZW180VqsNI13QokCqQNM8+VSdvbtA5z+eV4wEdKE=";

        nodejs = pkgs.nodejs_22;
        dontNpmBuild = true;

        installPhase = ''
          runHook preInstall

          mkdir -p "$out"
          cp -r package.json README.md src "$out"/
          cp -r node_modules "$out"/node_modules
          rm -f "$out/node_modules/.package-lock.json"

          runHook postInstall
        '';

        passthru = {
          packageName = packageJson.name;
        };

        meta = with lib; {
          description = "Pi extension that fetches URLs and returns clean markdown";
          license = licenses.mit;
          platforms = platforms.all;
        };
      };

      default = self.packages.${system}.pi-webfetch;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
        ];

        shellHook = ''
          echo "pi-webfetch dev shell — node $(node --version)"
        '';
      };
    });

    formatter = forAllSystems (system: pkgsFor.${system}.alejandra);
  };
}

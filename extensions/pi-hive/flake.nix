{
  description = "pi-hive: a pi extension package for multi-agent orchestration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;
          version = "0.1.0";
          src = lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let
                base = builtins.baseNameOf path;
              in
                !(
                  base == ".git"
                  || base == "node_modules"
                  || base == "result"
                  || base == ".direnv"
                );
          };
        in {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-hive";
            inherit version src;
            dontBuild = true;

            installPhase = ''
              mkdir -p $out
              cp -r . $out/
            '';

            meta = with lib; {
              description = "Multi-agent orchestration extension package for pi";
              license = licenses.mit;
              platforms = platforms.unix;
            };
          };
        });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
            ];

            shellHook = ''
              echo "pi-hive dev shell"
              echo "- Use: npm install"
              echo "- Test: pi -e ./index.ts"
              echo "- Build package path: nix build"
            '';
          };
        });
    };
}

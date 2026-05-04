self: {
  config,
  lib,
  pkgs,
  ...
}: let
  inherit (lib) mkEnableOption mkIf mkOption optionalString types;
  cfg = config.programs.pi;
  system = pkgs.stdenv.hostPlatform.system;

  enabledFlagExtensions = self.lib.enabledExtensions {
    inherit system;
    extensionFlags = cfg.extensions;
  };
  selectedExtensions =
    (
      if cfg.full
      then self.lib.defaultExtensionPackagesFor system
      else enabledFlagExtensions
    )
    // cfg.extraExtensions;

  hasSelectedExtensions = selectedExtensions != {};
  hasExtensionFlags = lib.any (enabled: enabled) (builtins.attrValues cfg.extensions);
  usesGeneratedPackage = cfg.package == null;

  generatedPackage =
    if cfg.full && cfg.extraExtensions == {}
    then self.packages.${system}.pi-full
    else if hasSelectedExtensions
    then
      self.lib.piWithExtensions {
        inherit pkgs;
        pi = self.packages.${system}.pi;
        extensions = selectedExtensions;
      }
    else self.packages.${system}.pi;

  package =
    if usesGeneratedPackage
    then generatedPackage
    else cfg.package;

  extensionNames =
    if usesGeneratedPackage
    then builtins.attrNames selectedExtensions
    else package.passthru.extensionNames or [];
  extensionPaths = map (name: "${package}/share/pi/extensions/${name}") extensionNames;
in {
  options.programs.pi = {
    enable = mkEnableOption "pi coding agent CLI";

    package = mkOption {
      type = types.nullOr types.package;
      default = null;
      defaultText = lib.literalExpression ''
        pi-flake packages.<system>.pi, pi-full, or a generated piWithExtensions package
      '';
      description = ''
        Package to install. Leave null to build/select one from full, extensions,
        and extraExtensions. Set explicitly to use a concrete package like
        inputs.pi-flake.packages.''${pkgs.stdenv.hostPlatform.system}.pi-full.
      '';
    };

    full = mkEnableOption "all bundled pi extensions";

    extensions = {
      hive = mkEnableOption "pi-hive extension";

      "codex-fast" = mkEnableOption "pi-codex-fast extension";
      "gecko-websearch" = mkEnableOption "pi-gecko-websearch extension";
      rtk = mkEnableOption "pi-rtk extension";
      compact = mkEnableOption "pi-compact extension";
      "context-janitor" = mkEnableOption "pi-context-janitor background context pruning extension";
      morph = mkEnableOption "pi-morph Morph edit tool via Vercel AI Gateway";
      "tool-management" = mkEnableOption "pi-tool-management extension";
      webfetch = mkEnableOption "pi-webfetch extension";
      hashline = mkEnableOption "pi-hashline v2 read/edit tool override";
      "minimal-ui" = mkEnableOption "pi-minimal-ui statusline and compact input box extension";
    };

    extraExtensions = mkOption {
      type = types.attrsOf types.package;
      default = {};
      example = lib.literalExpression ''
        {
          my-extension = pkgs.callPackage ./my-pi-extension.nix {};
        }
      '';
      description = ''
        Additional extension packages to bundle, keyed by the name used under
        $out/share/pi/extensions/<name>.
      '';
    };

    finalPackage = mkOption {
      type = types.package;
      readOnly = true;
      internal = true;
      description = "Resolved pi package installed by this module.";
    };

    bundledExtensionNames = mkOption {
      type = types.listOf types.str;
      readOnly = true;
      internal = true;
      description = "Names of extensions bundled into finalPackage.";
    };

    bundledExtensionPaths = mkOption {
      type = types.listOf types.str;
      readOnly = true;
      internal = true;
      description = "Extension paths bundled into finalPackage, suitable for pi settings.json extensions.";
    };
  };

  config = mkIf cfg.enable {
    programs.pi = {
      finalPackage = package;
      bundledExtensionNames = extensionNames;
      bundledExtensionPaths = extensionPaths;
    };

    warnings = lib.optional (cfg.package != null && (cfg.full || hasExtensionFlags || cfg.extraExtensions != {})) ''
      programs.pi.package is set; programs.pi.full/extensions/extraExtensions are ignored.${optionalString cfg.full " Use package = null; full = true; to generate the full bundle from options."}
    '';

    environment.systemPackages = [package];
    environment.variables.PI_SKIP_VERSION_CHECK = "1";
  };
}

# Lifecycle registry for bundled pi extensions.
#
# Stages:
#   active   — shipped in the default bundle (pi-full), built by checks.
#   testing  — built and checked, excluded from the default bundle; opt-in
#              via programs.pi.extensions.<name> (emits a NixOS warning).
#   paused   — source kept in tree, but not built, bundled, or checked.
#   retired  — removed from the tree, not built or bundled; git history is
#              the archive. Reanimate by restoring the source and setting a
#              live stage.
#
# source: "vendored" (third-party tree built inline in flake.nix), or
#         "inline" (first-party tree in this repo, built inline by the root flake).
{
  chronobreak = {
    stage = "active";
    source = "inline";
    dir = "pi-chronobreak";
    priority = 40;
  };
  donsetch = {
    stage = "active";
    source = "vendored";
    dir = "pi-donsetch";
    priority = 95;
  };
  fusion = {
    stage = "testing";
    source = "inline";
    dir = "pi-fusion";
    priority = 80;
  };
  jev = {
    stage = "active";
    source = "inline";
    dir = "pi-jev";
    priority = 50;
  };
  recap = {
    stage = "active";
    source = "inline";
    dir = "pi-recap";
    priority = 70;
  };
}

# Lifecycle registry for bundled pi extensions.
#
# Stages:
#   active   — shipped in the default bundle (pi-full), built by checks.
#   testing  — built and checked, excluded from the default bundle; opt-in
#              via programs.pi.extensions.<name> (emits a NixOS warning).
#   paused   — source kept in tree, but not built, bundled, or checked.
#   retired  — remove the entry here AND delete the source from extensions/.
#
# source: "vendored" (third-party tree built inline in flake.nix), or
#         "inline" (first-party tree in this repo, built inline by the root flake).
{
  chronobreak = {
    stage = "active";
    source = "inline";
    dir = "pi-chronobreak";
  };
  tools = {
    stage = "active";
    source = "inline";
    dir = "pi-tools";
  };
  recurse = {
    stage = "active";
    source = "inline";
    dir = "pi-recurse";
  };
  sentinel = {
    stage = "active";
    source = "inline";
    dir = "pi-sentinel";
  };
  hashline = {
    stage = "active";
    source = "inline";
    dir = "pi-hashline";
  };
  batch = {
    stage = "testing";
    source = "inline";
    dir = "pi-batch";
  };
  unified-edit = {
    stage = "testing";
    source = "inline";
    dir = "pi-unified-edit";
  };

  ponytail = {
    stage = "active";
    source = "vendored";
  };

  caveman = {
    stage = "active";
    source = "vendored";
  };

  recap = {
    stage = "active";
    source = "vendored";
  };
}
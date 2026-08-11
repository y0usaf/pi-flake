# Lifecycle registry for bundled pi extensions.
#
# Stages:
#   active   — shipped in the default bundle (pi-full), built by checks.
#   testing  — built and checked, excluded from the default bundle; opt-in
#              via programs.pi.extensions.<name> (emits a NixOS warning).
#   paused   — source kept in tree, but not built, bundled, or checked.
#   retired  — source stored in extensions/retired/, not built or bundled.
#              Purpose: preserves code history without cluttering the
#              working directory; reanimate by moving back to extensions/.
#
# source: "vendored" (third-party tree built inline in flake.nix), or
#         "inline" (first-party tree in this repo, built inline by the root flake).
{
  bash-aliases = {
    stage = "active";
    source = "inline";
    dir = "pi-bash-aliases";
  };
  chronobreak = {
    stage = "active";
    source = "inline";
    dir = "pi-chronobreak";
  };
  z-exec = {
    stage = "active";
    source = "inline";
    dir = "pi-exec";
  };
  tools = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-tools";
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
    stage = "retired";
    source = "inline";
    dir = "retired/pi-batch";
  };
  unified-edit = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-unified-edit";
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

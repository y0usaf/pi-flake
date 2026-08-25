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
  aliases = {
    stage = "active";
    source = "inline";
    dir = "pi-aliases";
    priority = 20;
  };
  chronobreak = {
    stage = "active";
    source = "inline";
    dir = "pi-chronobreak";
    priority = 40;
  };
  webfetch = {
    stage = "active";
    source = "inline";
    dir = "pi-webfetch";
    priority = 90;
  };
  yourshell = {
    stage = "active";
    source = "inline";
    dir = "pi-yourshell";
    priority = 100;
  };
  gecko-websearch = {
    stage = "active";
    source = "inline";
    dir = "pi-gecko-websearch";
    priority = 50;
  };
  z-exec = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-exec";
  };
  fleet = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-fleet";
  };
  sentinel = {
    stage = "active";
    source = "inline";
    dir = "pi-sentinel";
    priority = 80;
  };
  heartbeat = {
    stage = "active";
    source = "inline";
    dir = "pi-heartbeat";
    priority = 75;
  };
  hashline = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-hashline";
  };
  ponytail = {
    stage = "active";
    source = "vendored";
    priority = 60;
  };
  caveman = {
    stage = "active";
    source = "vendored";
    priority = 30;
  };
  fff = {
    stage = "active";
    source = "vendored";
    priority = 45;
  };
  recap = {
    stage = "active";
    source = "vendored";
    dir = "pi-recap";
    priority = 70;
  };
}

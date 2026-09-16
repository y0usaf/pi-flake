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
    stage = "retired";
    source = "inline";
    dir = "retired/pi-aliases";
  };
  fabric = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-fabric";
  };
  chronobreak = {
    stage = "active";
    source = "inline";
    dir = "pi-chronobreak";
    priority = 40;
  };
  webfetch = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-webfetch";
    priority = 90;
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
  yourshell = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-yourshell";
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
    stage = "retired";
    source = "inline";
    dir = "retired/pi-sentinel";
  };
  # Transcript drift auditor: the diagnostic half of the Jev pair, dropped in
  # favour of the pi-jev gate alone. Retired before it ever shipped; the source
  # is kept for history and can be reanimated by moving it back to extensions/.
  sentinel-audit = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-sentinel-audit";
  };
  jev = {
    stage = "active";
    source = "inline";
    dir = "pi-jev";
    priority = 50;
  };
  heartbeat = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-heartbeat";
  };
  hashline = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-hashline";
  };
  fff = {
    stage = "retired";
    source = "inline";
    dir = "retired/pi-fff";
  };
  recap = {
    stage = "active";
    source = "inline";
    dir = "pi-recap";
    priority = 70;
  };
  vercel-ai-gateway = {
    stage = "active";
    source = "vendored";
    dir = "pi-vercel-ai-gateway";
    priority = 55;
  };
}

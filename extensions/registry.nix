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
  gecko-websearch = {
    stage = "active";
    source = "inline";
    dir = "pi-gecko-websearch";
  };
  rtk = {
    stage = "active";
    source = "inline";
    dir = "pi-rtk";
  };
  aphrodite = {
    stage = "active";
    source = "inline";
    dir = "pi-aphrodite";
  };

  interview = {
    stage = "active";
    source = "inline";
    dir = "pi-interview";
  };
  management = {
    stage = "active";
    source = "inline";
    dir = "pi-management";
  };
  webfetch = {
    stage = "active";
    source = "inline";
    dir = "pi-webfetch";
  };
  hashline = {
    stage = "active";
    source = "inline";
    dir = "pi-hashline";
  };
  frames = {
    stage = "testing";
    source = "inline";
    dir = "pi-frames";
  };
  review = {
    stage = "active";
    source = "vendored";
    dir = "earendil_pi-review";
  };
  vcc = {
    stage = "active";
    source = "vendored";
    dir = "sting8k_pi-vcc";
  };
  caveman = {
    stage = "active";
    source = "vendored";
    dir = "jonjonrankin_pi-caveman";
  };
  pantera = {
    stage = "testing";
    source = "inline";
    dir = "pi-pantera";
  };
  dark-terminal = {
    stage = "active";
    source = "inline";
    dir = "pi-dark-terminal";
  };

  quiet = {
    stage = "active";
    source = "inline";
    dir = "pi-quiet";
  };
  continue = {
    stage = "active";
    source = "inline";
    dir = "pi-continue";
  };

  agents = {
    stage = "active";
    source = "inline";
    dir = "pi-agents";
  };
}

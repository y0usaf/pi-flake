# Lifecycle registry for bundled pi extensions.
#
# Stages:
#   active   — shipped in the default bundle (pi-full), built by checks.
#   testing  — built and checked, excluded from the default bundle; opt-in
#              via programs.pi.extensions.<name> (emits a NixOS warning).
#   paused   — source kept in tree, but not built, bundled, or checked.
#   retired  — remove the entry here AND delete the source from extensions/.
#
# source: "subflake" (own flake input under extensions/) or
#         "vendored" (third-party tree built inline in flake.nix).
{
  gecko-websearch = {
    stage = "active";
    source = "subflake";
  };
  rtk = {
    stage = "active";
    source = "subflake";
  };
  aphrodite = {
    stage = "active";
    source = "subflake";
  };

  interview = {
    stage = "active";
    source = "subflake";
  };
  management = {
    stage = "active";
    source = "subflake";
  };
  webfetch = {
    stage = "active";
    source = "subflake";
  };
  hashline = {
    stage = "active";
    source = "subflake";
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
  cursor-provider = {
    stage = "active";
    source = "vendored";
    dir = "ndraiman_pi-cursor-provider";
  };

  quiet = {
    stage = "active";
    source = "vendored";
    dir = "pi-quiet";
  };

  agents = {
    stage = "testing";
    source = "subflake";
  };
}

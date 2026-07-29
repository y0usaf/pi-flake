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
#
# Trees under extensions/ with no entry here are not packages. Today that is
# extensions/vekexasia_pi-extensible-workflows/: a pinned pristine reference
# tree, kept as the diff base for taking upstream fixes into the pi-loom fork.
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
  minimal = {
    stage = "active";
    source = "subflake";
  };
  interview = {
    stage = "active";
    source = "subflake";
  };
  tool-management = {
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
  advisor = {
    stage = "active";
    source = "vendored";
    dir = "RimuruW_pi-advisor";
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
  atelier = {
    stage = "active";
    source = "vendored";
    dir = "michaelmjhhhh_pi-atelier";
  };

  loom = {
    stage = "testing";
    source = "vendored";
    dir = "pi-loom";
    note = "Fork of pi-extensible-workflows 3.4.2; workflow engine for the loom stack. Evaluating since 2026-07-28; opt-in via flags until promoted.";
  };

  kimi = {
    stage = "paused";
    source = "subflake";
    note = "On hold 2026-07-28; flake input kept so resume = flip stage back.";
  };
}

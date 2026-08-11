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
#
# After merging pi-flake into prime-agent, only chronobreak is kept as an
# inline extension. All other inline extensions are retired (moved to
# upstream or replaced by prime-agent/oh-my-pi equivalents).

{
  # --- RETAINED ---
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

  # --- RETIRED (replaced by prime-agent / oh-my-pi builtins) ---
  gecko-websearch = {
    stage = "retired";
    source = "inline";
    dir = "pi-gecko-websearch";
  };
  rtk = {
    stage = "retired";
    source = "inline";
    dir = "pi-rtk";
  };
  aphrodite = {
    stage = "retired";
    source = "inline";
    dir = "pi-aphrodite";
  };
  interview = {
    stage = "retired";
    source = "inline";
    dir = "pi-interview";
  };
  management = {
    stage = "retired";
    source = "inline";
    dir = "pi-management";
  };
  webfetch = {
    stage = "retired";
    source = "inline";
    dir = "pi-webfetch";
  };
  hashline = {
    stage = "retired";
    source = "inline";
    dir = "pi-hashline";
  };
  prime-tools = {
    stage = "retired";
    source = "inline";
    dir = "pi-prime-tools";
  };
  review = {
    stage = "retired";
    source = "vendored";
    dir = "earendil_pi-review";
  };
  vcc = {
    stage = "retired";
    source = "vendored";
    dir = "sting8k_pi-vcc";
  };
  caveman = {
    stage = "retired";
    source = "vendored";
    dir = "jonjonrankin_pi-caveman";
  };
  engram = {
    stage = "retired";
    source = "vendored";
  };
  pantera = {
    stage = "retired";
    source = "inline";
    dir = "pi-pantera";
  };
  dark-terminal = {
    stage = "retired";
    source = "inline";
    dir = "pi-dark-terminal";
  };
  quiet = {
    stage = "retired";
    source = "inline";
    dir = "pi-quiet";
  };
  workflow = {
    stage = "retired";
    source = "inline";
    dir = "pi-workflow";
  };
  continue = {
    stage = "retired";
    source = "inline";
    dir = "pi-continue";
  };
}

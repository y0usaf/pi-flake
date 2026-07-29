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
  tool-management = {
    stage = "active";
    source = "subflake";
  };
  extension-management = {
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

  # Reference tree. Kept pristine at upstream 3.4.2 so `git diff` against it is
  # how pi-workflows takes upstream fixes. Still built so the reference is known
  # to compile; enabling it alongside `workflows` would register /workflow twice.
  extensible-workflows = {
    stage = "testing";
    source = "vendored";
    dir = "vekexasia_pi-extensible-workflows";
    note = "Reference/diff base for pi-workflows since 2026-07-29. Do not edit; do not enable together with `workflows`.";
  };

  workflows = {
    stage = "testing";
    source = "vendored";
    dir = "pi-workflows";
    note = "Fork of extensible-workflows 3.4.2 that ships the engine and the transcript renderer as one extension. Evaluating since 2026-07-29.";
  };

  chrono-break = {
    stage = "testing";
    source = "subflake";
    note = "Model-callable context rewind. Evaluating since 2026-08-11; opt-in until it has been driven through real wrong-path sessions, because a misfired rewind removes work from the model's view.";
  };

  quiet = {
    stage = "testing";
    source = "vendored";
    dir = "pi-quiet";
    note = "Emoticon chrome: no header, blink spinner, face tool rows, face-border editor. Evaluating since 2026-08-11.";
  };

  kimi = {
    stage = "paused";
    source = "subflake";
    note = "On hold 2026-07-28; flake input kept so resume = flip stage back.";
  };
}

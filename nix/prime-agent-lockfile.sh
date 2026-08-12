#!/usr/bin/env bash
# Regenerate nix/prime-agent-package-lock.json from prime-agent upstream.
#
# Upstream commits a package-lock.json whose registry entries omit
# resolved/integrity (npm >= 11 resolves them live). Nix fetchNpmDeps needs
# those URLs. This script injects them WITHOUT re-resolving versions, so the
# lockfile stays byte-stable apart from the added fields.
#
# Usage:
#   nix/prime-agent-lockfile.sh /path/to/prime-agent-src/package-lock.json
# Writes nix/prime-agent-package-lock.json beside this script.

set -euo pipefail

src_lock="${1:?usage: $0 /path/to/package-lock.json}"
out_lock="$(dirname "$0")/prime-agent-package-lock.json"
python3 - "$src_lock" "$out_lock" <<'PY'
import json, sys, time, urllib.request

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
pkgs = d["packages"]
todo = [
    k for k, v in pkgs.items()
    if isinstance(v, dict)
    and "resolved" not in v
    and "link" not in v
    and "node_modules/" in k
    and v.get("version")
]

print(f"injecting resolved/integrity into {len(todo)} entries", file=sys.stderr)
for i, k in enumerate(todo):
    name = k.rsplit("node_modules/", 1)[-1]
    ver = pkgs[k]["version"]
    url = f"https://registry.npmjs.org/{name.replace('/', '%2f')}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        m = json.load(r)
    dist = m["versions"][ver]["dist"]
    pkgs[k]["resolved"] = dist["tarball"]
    pkgs[k]["integrity"] = dist["integrity"]
    time.sleep(0.03)

json.dump(d, open(out, "w"), indent=2)
print(f"wrote {out}", file=sys.stderr)
PY

#!/usr/bin/env bash
set -euo pipefail

name=refresh-model-data

usage() {
	printf 'usage: nix run .#refresh-model-data -- [target-dir]\n' >&2
	printf '       nix/refresh-model-data.sh <pi-src> [target-dir]\n' >&2
	printf '  pi-src    checkout holding packages/ai/scripts/generate-models.ts\n' >&2
	printf '  target    data directory, default $PWD/nix/model-data\n' >&2
}

pi_src="${1:-}"
[ -n "$pi_src" ] || {
	usage
	exit 2
}
target="${2:-$PWD/nix/model-data}"

[ -f "$pi_src/packages/ai/scripts/generate-models.ts" ] || {
	printf '%s: %s is not a pi checkout\n' "$name" "$pi_src" >&2
	exit 2
}
[ -f "$target/.manifest.json" ] || {
	printf '%s: %s is not a model-data directory\n' "$name" "$target" >&2
	exit 2
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tree="$work/pi"
mkdir -p "$tree"
cp -R "$pi_src"/. "$tree"/
chmod -R u+w "$tree"
ai="$tree/packages/ai"
fresh="$ai/src/providers/data"

printf '%s: hydrating from models.dev (network)\n' "$name" >&2
(
	cd "$ai"
	node scripts/generate-models.ts --strict --data-only
	node scripts/check-model-data.ts
)

manifest_current() {
	node -e '
		const fs = require("node:fs");
		const [fresh, target] = process.argv.slice(1);
		const fields = (path) => {
			const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
			delete manifest.generatedAt;
			return JSON.stringify(manifest);
		};
		process.exit(fields(fresh) === fields(target) ? 0 : 1);
	' "$fresh/.manifest.json" "$target/.manifest.json"
}

model_delta() {
	node -e '
		const fs = require("node:fs");
		const path = require("node:path");
		const [fresh, target] = process.argv.slice(1);
		const shards = (dir) =>
			fs
				.readdirSync(dir)
				.filter((entry) => entry.endsWith(".json") && entry !== ".manifest.json")
				.sort();
		const ids = (file) => {
			const groups = JSON.parse(fs.readFileSync(file, "utf8"));
			const out = new Set();
			for (const models of Object.values(groups)) {
				for (const key of Object.keys(models)) out.add(key.slice(key.indexOf(":") + 1));
			}
			return out;
		};
		const brief = (list) =>
			list.length > 8 ? `${list.slice(0, 8).join(" ")} +${list.length - 8}` : list.join(" ");
		for (const shard of shards(fresh)) {
			const previous = path.join(target, shard);
			const beforeBytes = fs.existsSync(previous) ? fs.readFileSync(previous, "utf8") : undefined;
			const afterBytes = fs.readFileSync(path.join(fresh, shard), "utf8");
			if (beforeBytes === afterBytes) continue;
			const before = beforeBytes === undefined ? new Set() : ids(previous);
			const after = ids(path.join(fresh, shard));
			const added = [...after].filter((id) => !before.has(id));
			const removed = [...before].filter((id) => !after.has(id));
			if (added.length === 0 && removed.length === 0) {
				console.log(`  ${shard.replace(/\.json$/, "")}: metadata only`);
				continue;
			}
			const parts = [];
			if (added.length > 0) parts.push(`+${added.length} ${brief(added)}`);
			if (removed.length > 0) parts.push(`-${removed.length} ${brief(removed)}`);
			console.log(`  ${shard.replace(/\.json$/, "")}: ${parts.join(" ")}`);
		}
	' "$fresh" "$target"
}

shopt -s nullglob
added=() changed=() removed=()
unchanged=0
for file in "$fresh"/*.json; do
	shard="${file##*/}"
	if [ ! -f "$target/$shard" ]; then
		added+=("$shard")
	elif diff -q "$file" "$target/$shard" >/dev/null; then
		unchanged=$((unchanged + 1))
	else
		changed+=("$shard")
	fi
done
for file in "$target"/*.json; do
	shard="${file##*/}"
	[ -f "$fresh/$shard" ] || removed+=("$shard")
done

model_delta_report="$(model_delta)"

for shard in "${added[@]}"; do install -m 644 "$fresh/$shard" "$target/$shard"; done
for shard in "${changed[@]}"; do install -m 644 "$fresh/$shard" "$target/$shard"; done
for shard in "${removed[@]}"; do rm -f "$target/$shard"; done

delta=$((${#added[@]} + ${#changed[@]} + ${#removed[@]}))
manifest_stale=0
manifest_current || manifest_stale=1
if [ "$delta" -gt 0 ] || [ "$manifest_stale" -eq 1 ]; then
	install -m 644 "$fresh/.manifest.json" "$target/.manifest.json"
fi

printf '%s\n' "$target"
report() {
	local label="$1"
	shift
	[ "$#" -gt 0 ] || return 0
	printf '  %-9s %s\n' "$label" "$*"
}
report "added:" "${added[@]}"
report "changed:" "${changed[@]}"
report "removed:" "${removed[@]}"
report "unchanged:" "$unchanged shard(s)"
[ -z "$model_delta_report" ] || printf '%s\n' "$model_delta_report"

if [ "$delta" -eq 0 ] && [ "$manifest_stale" -eq 0 ]; then
	printf '%s: model data is already current\n' "$name"
else
	printf '%s: model data updated\n' "$name"
fi

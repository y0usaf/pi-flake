#!/bin/sh
set -eu

version=$(rtk --version)
printf 'rtk version\t%s\n' "$version"

commands='pwd
ls -la
cat README.md
git status --short
git diff --stat
find . -maxdepth 1 -type f
find . -name "*.md"
head -n 20 README.md
printf "hello\\n"
git log -1 --oneline'

total_original=0
total_rewritten=0
blocked=0
passthrough=0
rewrite_failed=0
while IFS= read -r original; do
  [ -n "$original" ] || continue
  rewrite_status=0
  rewritten=$(rtk rewrite "$original" 2>/dev/null) || rewrite_status=$?
  rewritten=$(printf '%s' "$rewritten" | sed '$ s/[[:space:]]*$//')
  original_output=$(sh -c "$original" 2>/dev/null || true)
  original_bytes=$(printf '%s' "$original_output" | wc -c | tr -d ' ')
  if printf '%s\n' "$original" "$rewritten" | grep -Eq '(^| )rtk find([[:space:]]|$)' || printf '%s\n' "$original" | grep -Eq '(^| )find([[:space:]]|$)'; then
    printf 'BLOCKED\t%s\t%s\t%s\n' "$original" "$rewritten" "$original_bytes"
    blocked=$((blocked + 1))
    continue
  fi
  if { [ "$rewrite_status" -ne 0 ] && [ "$rewrite_status" -ne 3 ]; } || [ -z "$rewritten" ] || [ "$rewritten" = "$original" ] || ! printf '%s\n' "$rewritten" | grep -Eq '^[[:space:]]*(sudo[[:space:]]+)?rtk([[:space:]]|$)'; then
    printf 'PASSTHROUGH\t%s\t%s\t%s\t%s\t%s\n' "$original" "$rewritten" "$original_bytes" "$original_bytes" 0
    passthrough=$((passthrough + 1))
    total_original=$((total_original + original_bytes))
    total_rewritten=$((total_rewritten + original_bytes))
    continue
  fi
  rewritten_status=0
  rewritten_output=$(sh -c "$rewritten" 2>/dev/null) || rewritten_status=$?
  if [ "$rewritten_status" -ne 0 ]; then
    printf 'REWRITE_FAILED\t%s\t%s\t%s\t%s\t0\n' "$original" "$rewritten" "$original_bytes" "$original_bytes"
    rewrite_failed=$((rewrite_failed + 1))
    total_original=$((total_original + original_bytes))
    total_rewritten=$((total_rewritten + original_bytes))
    continue
  fi
  rewritten_bytes=$(printf '%s' "$rewritten_output" | wc -c | tr -d ' ')
  delta=$((original_bytes - rewritten_bytes))
  printf 'RESULT\t%s\t%s\t%s\t%s\t%s\n' "$original" "$rewritten" "$original_bytes" "$rewritten_bytes" "$delta"
  total_original=$((total_original + original_bytes))
  total_rewritten=$((total_rewritten + rewritten_bytes))
done <<EOF
$commands
EOF

delta=$((total_original - total_rewritten))
printf 'SUMMARY\tversion=%s\tcommands=10\tblocked=%s\tpassthrough=%s\trewrite_failed=%s\toriginal_bytes=%s\trewritten_bytes=%s\tdelta=%s\tsaving_percent=%.2f\n' "$version" "$blocked" "$passthrough" "$rewrite_failed" "$total_original" "$total_rewritten" "$delta" "$(awk "BEGIN { if ($total_original == 0) print 0; else print (100 * $delta / $total_original) }")"

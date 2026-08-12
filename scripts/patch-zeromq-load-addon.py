#!/usr/bin/env python3
"""Patch zeromq load-addon.js to use ZEROMQ_NODE_ADDON_DIR env var."""

import re, sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

old = (
    'const addonParentDir = path_1.default.resolve(path_1.default.join(__dirname, '
    '"..", "build", process.platform, process.arch, "node"));'
)
new = (
    'const addonParentDir = path_1.default.resolve('
    'process.env.ZEROMQ_NODE_ADDON_DIR || '
    'path_1.default.join(__dirname, "..", "build", process.platform, process.arch, "node"));'
)

# Try exact match first, fall back to regex
if old not in content:
    # Minified names may differ (e.g. path_a vs path_1), match by structure
    regex = re.compile(
        r'const\s+\w+\s*=\s*\w+\.default\.resolve\('
        r'\w+\.default\.join\('
        r'__dirname,\s*"\.\.",\s*"build",\s*'
        r'process\.platform,\s*process\.arch,\s*"node"\s*\)\s*\);',
    )
    m = regex.search(content)
    if not m:
        print(f"ERROR: Could not find addonParentDir pattern in {path}", file=sys.stderr)
        sys.exit(1)
    full_match = m.group(0)
    # Extract the variable name (first \\w+)
    var_name = full_match.split("=")[0].strip()
    new_var = (
        f'const addonParentDir = path_1.default.resolve('
        f'process.env.ZEROMQ_NODE_ADDON_DIR || '
        f'path_1.default.join(__dirname, "..", "build", process.platform, process.arch, "node"));'
    )
    content = content.replace(full_match, new_var)
else:
    content = content.replace(old, new)

with open(path, 'w') as f:
    f.write(content)
print(f"Patched: {path}")
sys.exit(0)
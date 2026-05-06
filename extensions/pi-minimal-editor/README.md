# pi-minimal-editor

Tiny editor-border chrome for Pi.

- extends Pi's `CustomEditor`; editor behavior stays upstream-owned
- replaces rendered editor borders
- hides Pi's footer after folding the same metadata into those borders
- no custom settings/schema

```text
~/Dev/pi-flake (main)──────────────────────↑12k ↓2k $0.043 18.4%/272k (auto)
ask pi something
gpt-5.5 • high─────────────────────────────────────────────────────────────────⚡
```

```bash
pi -e ./extensions/pi-minimal-editor
```

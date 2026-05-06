# pi-working-indicator

Compact working indicator for Pi.

- replaces Pi's default `⠋ Working...` with a compact cycling ribbon
- hides the working text label
- keeps provider/model/editor behavior unchanged

```text
8f#A0c~_e9B+7d%
```

The ribbon uses Pi's active theme colors:

- accent color as the start color
- current thinking-level color as the end color when reasoning is active
- high-thinking color as the end color otherwise

## Usage

```bash
pi -e ./extensions/pi-working-indicator
```

Or install/load as a bundled package via this flake.

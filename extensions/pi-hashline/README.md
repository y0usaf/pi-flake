# pi-hashline

Strict hashline read/edit tool override for Pi.

Inspired by Can Bölük's "harness problem" write-up and hashline edit format. This extension replaces Pi's built-in `read` and `edit` tools with a line-anchor workflow:

```text
10#K7Q:function hello() {
11#N2P:  return "world";
12#RX8:}
```

Edits reference anchors copied from `read` output instead of reproducing old text exactly.

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "11#N2P", "lines": ["  return \"hashline\";"] }
  ]
}
```

## Tools

### `read`

Reads UTF-8 text files and prefixes each returned line with `LINE#HASH:`.

Parameters:

- `path`: file path
- `offset`: first line to return, 1-indexed
- `limit`: max lines to return

Large output is capped using Pi's default truncation limits. Supported image extensions are delegated to Pi's built-in `read`; binary files and directories are rejected.

### `edit`

Patches a UTF-8 text file using anchors from the latest `read` output.

Ops:

- `replace`: replace `pos` or inclusive range `pos`..`end` with `lines`
- `append`: insert `lines` after `pos`; omit `pos` for EOF
- `prepend`: insert `lines` before `pos`; omit `pos` for BOF
- `replace_text`: exact unique substring replacement, for small guaranteed-unique edits

Rules:

- Copy anchors exactly from `read` or a prior successful `edit` result.
- `lines` must be literal file content: no `LINE#HASH:` prefixes, no diff `+`/`-` prefixes.
- Anchors are strict. If the line's current hash differs, the edit is rejected with fresh retry anchors.
- Multiple anchor edits in one call validate against the same pre-edit snapshot and are applied bottom-up.
- Overlapping or adjacent edits are rejected; merge them into one edit.

On success, `edit` returns fresh anchors for the changed region plus nearby context so follow-up edits can chain without rereading the whole file.

## Usage

```bash
pi -e ./extensions/pi-hashline
```

Or bundle via this flake with extension flag `hashline = true`.

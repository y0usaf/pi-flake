# pi-hashline

Strict hashline v3 read/edit tool override for Pi.

Inspired by Can Bölük's "harness problem" write-up and Oh My Pi's hashline v2 format. This extension replaces Pi's built-in `read` and `edit` tools with a strict line-anchor workflow:

```text
10cltz|function hello() {
11zmry|  return "world";
12vnrk|}
```

Edits reference anchors copied from current `read` output instead of reproducing old text exactly.

```json
{
  "path": "src/main.ts",
  "edits": [
    { "loc": { "range": { "pos": "11zmry", "end": "11zmry" } }, "content": ["  return \"hashline\";"] }
  ]
}
```

## Hashline v3

- Read output: `LINEID|content` (for example `160heah|const x = 1;`)
- Edit anchors: full `LINEID` (for example `160heah`)
- IDs: decimal line number + two BPE-friendly bigrams from Oh My Pi's stable 647-bigram set
- Hash space: `647² = 418,609` four-letter bodies
- Hashing: `Bun.hash.xxHash32` over exact line content, including trailing whitespace and structural-only lines
- Validation: line number fixes location; hash body validates current content
- No relocation or fuzzy fallback: any mismatch fails with fresh retry anchors

### v2 migration

v3 intentionally rejects old two-letter/ordinal v2 anchors. Existing sessions must call `read` again—or start a new session—before editing. This clean break removes ordinal brace shortcuts and nearby stale-anchor rebasing.

## Tools

### `read`

Reads UTF-8 text files and prefixes each returned line with `LINEID|content`.

Parameters:

- `path`: file path
- `offset`: first line to return, 1-indexed
- `limit`: max lines to return

Large output is capped using Pi's default truncation limits. Supported image extensions are delegated to Pi's built-in `read`; binary files and directories are rejected.

### `edit`

Patches a UTF-8 text file using anchors from current `read` output.

Preferred v3 edit entries use `{ loc, content }`:

- `loc: "append"` / `loc: "prepend"`: insert at EOF/BOF
- `loc: { "append": "123wmaa" }`: insert after anchored line
- `loc: { "prepend": "123wmaa" }`: insert before anchored line
- `loc: { "range": { "pos": "123wmaa", "end": "125nkgu" } }`: replace inclusive range
- `content`: literal file content as `string[]` or newline-split `string`; `null` deletes target range

Legacy request shapes remain accepted for compatibility:

- `replace(pos,end?,lines)`
- `append(pos?,lines)`
- `prepend(pos?,lines)`
- `replace_text(oldText,newText)`

Rules:

- Copy full current anchors exactly from `read` or prior successful `edit` result (`160heah`, not `heah`).
- `content` / `lines` must be literal file content: no `LINEID|` prefixes, no diff `+`/`-` prefixes.
- Anchors are strict. Any current line/hash mismatch rejects; anchors never relocate.
- Multiple anchor edits in one call validate against same pre-edit snapshot and apply bottom-up.
- Overlapping or adjacent edits reject; merge them into one edit.

On success, `edit` exposes host-visible diff/patch details and returns fresh anchors for changed region plus nearby context, letting follow-up edits chain without rereading whole file.

## Usage

```bash
pi -e ./extensions/pi-hashline
```

Or bundle via this flake with extension flag `hashline = true`.

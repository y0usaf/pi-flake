# pi-hashline

Strict hashline v2 read/edit tool override for Pi.

Inspired by Can Bölük's "harness problem" write-up and Oh My Pi's hashline v2 format. This extension replaces Pi's built-in `read` and `edit` tools with a line-anchor workflow:

```text
10ab|function hello() {
11th|  return "world";
12rd|}
```

Edits reference anchors copied from `read` output instead of reproducing old text exactly.

```json
{
  "path": "src/main.ts",
  "edits": [
    { "loc": { "range": { "pos": "11th", "end": "11th" } }, "content": ["  return \"hashline\";"] }
  ]
}
```

## Hashline v2

- Read output: `LINEID|content` (for example `160sr|const x = 1;`)
- Edit anchors: `LINEID` (for example `160sr`)
- IDs: two-letter BPE-friendly bigrams from the Oh My Pi stable 647-bigram set
- Hashing: `Bun.hash.xxHash32` over CR-stripped, trailing-whitespace-trimmed line text
- Brace/whitespace-only lines use ordinal suffix anchors (`1st`, `2nd`, `3rd`, `4th`, ...)

## Tools

### `read`

Reads UTF-8 text files and prefixes each returned line with `LINEID|content`.

Parameters:

- `path`: file path
- `offset`: first line to return, 1-indexed
- `limit`: max lines to return

Large output is capped using Pi's default truncation limits. Supported image extensions are delegated to Pi's built-in `read`; binary files and directories are rejected.

### `edit`

Patches a UTF-8 text file using anchors from the latest `read` output.

Preferred v2 edit entries use `{ loc, content }`:

- `loc: "append"` / `loc: "prepend"`: insert at EOF/BOF
- `loc: { "append": "123th" }`: insert after anchored line
- `loc: { "prepend": "123th" }`: insert before anchored line
- `loc: { "range": { "pos": "123th", "end": "125sr" } }`: replace inclusive range
- `content`: literal file content as `string[]` or newline-split `string`; `null` deletes the target range

Legacy entries remain accepted for compatibility:

- `replace(pos,end?,lines)`
- `append(pos?,lines)`
- `prepend(pos?,lines)`
- `replace_text(oldText,newText)`

Rules:

- Copy full anchors exactly from `read` or a prior successful `edit` result (`160sr`, not just `sr`).
- `content` / `lines` must be literal file content: no `LINEID|` prefixes, no diff `+`/`-` prefixes.
- Anchors are strict. If the line's current hash differs, the edit is rejected with fresh retry anchors.
- Multiple anchor edits in one call validate against the same pre-edit snapshot and are applied bottom-up.
- Overlapping or adjacent edits are rejected; merge them into one edit.

On success, `edit` returns fresh anchors for the changed region plus nearby context so follow-up edits can chain without rereading the whole file.

## Usage

```bash
pi -e ./extensions/pi-hashline
```

Or bundle via this flake with extension flag `hashline = true`.

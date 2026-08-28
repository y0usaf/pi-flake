// Incremental extractor for the `code` string field of a partially streamed
// fabric_exec tool-call argument blob. Model providers stream tool arguments as
// raw JSON string fragments; this class finds the "code" key and decodes the
// string content escape-by-escape as fragments arrive, without ever running a
// full JSON.parse on an unterminated document.

const CODE_KEY_PATTERN = /"code"\s*:\s*"/;

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export class PartialCodeFieldExtractor {
  #raw = "";
  #codeStart = -1;
  #cursor = 0;
  #decoded = "";
  #complete = false;
  #failed = false;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get complete(): boolean {
    return this.#complete;
  }

  /** Decoded `code` content so far, or undefined before the key appears. */
  get code(): string | undefined {
    return this.#codeStart === -1 ? undefined : this.#decoded;
  }

  push(delta: string): void {
    if (this.#complete || this.#failed) return;
    if (this.#raw.length + delta.length > this.#maxBytes) {
      // Cap hard: treat as failed so callers stop scanning this stream. A
      // truncated extractor could otherwise emit candidates from a program
      // prefix whose later bytes never arrived.
      this.#failed = true;
      return;
    }
    this.#raw += delta;
    if (this.#codeStart === -1) {
      const match = CODE_KEY_PATTERN.exec(this.#raw);
      if (!match) return;
      this.#codeStart = match.index + match[0].length;
      this.#cursor = this.#codeStart;
    }
    const raw = this.#raw;
    while (this.#cursor < raw.length) {
      const ch = raw[this.#cursor]!;
      if (ch === '"') {
        this.#complete = true;
        this.#cursor = raw.length;
        return;
      }
      if (ch === "\\") {
        if (this.#cursor + 1 >= raw.length) return; // dangling escape; await more
        const esc = raw[this.#cursor + 1]!;
        if (esc === "u") {
          if (this.#cursor + 5 >= raw.length) return; // incomplete \uXXXX
          const hex = raw.slice(this.#cursor + 2, this.#cursor + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.#failed = true;
            return;
          }
          this.#decoded += String.fromCharCode(parseInt(hex, 16));
          this.#cursor += 6;
          continue;
        }
        const mapped = ESCAPES[esc];
        if (mapped === undefined) {
          this.#failed = true;
          return;
        }
        this.#decoded += mapped;
        this.#cursor += 2;
        continue;
      }
      if (ch < " ") {
        // Bare control characters cannot appear inside a raw JSON string.
        this.#failed = true;
        return;
      }
      this.#decoded += ch;
      this.#cursor += 1;
    }
  }
}

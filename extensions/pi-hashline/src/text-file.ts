import { stat, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { TextDecoder } from "node:util";
import { IMAGE_EXTENSIONS } from "./constants";

export type LoadedTextFile = {
  bom: string;
  text: string;
  lineEnding: "\n" | "\r\n";
};

export function detectLineEnding(text: string): "\n" | "\r\n" {
  const crlf = text.indexOf("\r\n");
  const lf = text.indexOf("\n");
  if (crlf === -1 || lf === -1) return "\n";
  return crlf <= lf ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEnding(text: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(text: string): { bom: string; text: string } {
  return text.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: text.slice(1) }
    : { bom: "", text };
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function hasNullByte(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new Error("File is not valid UTF-8 text.");
    }
    throw error;
  }
}

export async function loadTextFile(path: string): Promise<LoadedTextFile> {
  const fileStat = await stat(path);
  if (fileStat.isDirectory()) {
    throw new Error("Path is a directory. Use ls to inspect directories.");
  }
  if (!fileStat.isFile()) {
    throw new Error("Path is not a regular file.");
  }

  const buffer = await readFile(path);
  if (hasNullByte(buffer)) {
    throw new Error("File appears to be binary (null bytes detected). Hashline tools only support UTF-8 text files.");
  }

  const decoded = decodeUtf8(buffer);
  const { bom, text } = stripBom(decoded);
  const lineEnding = detectLineEnding(text);
  return { bom, text: normalizeToLF(text), lineEnding };
}

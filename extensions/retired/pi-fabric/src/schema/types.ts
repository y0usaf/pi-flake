import type { StateHead } from "../state/store.js";

export type SchemaEvidence =
  | { kind: "file_exists"; path: string }
  | { kind: "file_absent"; path: string }
  | { kind: "file_contains"; path: string; literal: string }
  | { kind: "file_sha256"; path: string; sha256: string }
  | { kind: "trusted_command"; name: string };

export type SchemaFileOperation =
  | { kind: "write"; path: string; content: string; expected: { absent: true } | { sha256: string } }
  | { kind: "edit"; path: string; oldText: string; newText: string; expectedSha256: string }
  | { kind: "delete"; path: string; expectedSha256: string };

export interface SchemaStateBinding {
  transitionId: string;
  version: number;
  to: string;
}

export const stateBinding = (head: StateHead | null): SchemaStateBinding | null =>
  head
    ? { transitionId: head.transitionId, version: head.version, to: head.to }
    : null;

export interface SchemaHypothesisRecord {
  id: string;
  label: string;
  summary: string;
  evidence: SchemaEvidence[];
  complexityReduction: boolean;
  parentToolCallId: string;
  state: SchemaStateBinding | null;
  fingerprint: string;
  generation: number;
  status: "active" | "verified" | "committed" | "aborted" | "abandoned";
  createdAt: number;
  updatedAt: number;
}

export interface SchemaCertificateRecord {
  tokenHash: string;
  hypothesisId: string;
  parentToolCallId: string;
  state: SchemaStateBinding | null;
  fingerprint: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  status: "active" | "consumed" | "aborted" | "abandoned";
  consumedAt?: number;
}

export interface SchemaEvidenceResult {
  evidence: SchemaEvidence;
  status: "confirmed" | "nonconfirmed" | "error";
  detail: string;
  exitCode?: number | null;
  output?: string;
  observedSha256?: string;
}

export interface SchemaWorkspaceRecord {
  generation: number;
  lastOutcome?: "committed" | "rolled_back" | "quarantined";
  lastTransactionId?: string;
  updatedAt: number;
}

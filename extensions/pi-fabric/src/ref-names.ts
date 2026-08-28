// Identifier-safe shape used by the QuickJS `mcp.<server>.<tool>` proxy, the
// rendered advisory refs, and the generated guest type declarations. Shared so
// the provider, the advisory adapter, the declaration renderer, and the
// transcript ash-replay all agree on how a raw name appears in code. Kept
// dependency-free so runtime declaration builders and host providers can both
// import it without pulling in provider dependency graphs.
export const sanitizeMcpRefPart = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
};

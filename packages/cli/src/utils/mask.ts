/**
 * Printable form of a secret: at most its first four characters, then a
 * redaction marker. Values too short to spare four characters show nothing.
 */
export function maskSecret(value: string): string {
  return value.length < 12 ? '[redacted]' : `${value.slice(0, 4)}…[redacted]`;
}

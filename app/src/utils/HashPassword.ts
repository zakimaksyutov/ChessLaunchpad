// Deterministic client-side PBKDF2-SHA256.
//   final = "pbkdf2$<iterations>$<hex-digest>"
export async function derivePassword(
  password: string,
  username: string,
  iterations = 100_000
): Promise<string> {
  const enc = new TextEncoder();

  // 1. Import the raw password as a CryptoKey
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  // 2. Derive 256-bit key with username-based salt
  const salt = enc.encode(username.toLowerCase());
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    256
  );

  // 3. Convert to hex
  const hex = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2$${iterations}$${hex}`;
}
export async function hashPassword(password: string): Promise<string> {
    // Convert the string to a Uint8Array
    const encoder = new TextEncoder();
    const data = encoder.encode(password);

    // Use SubtleCrypto to digest the data
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    // Convert the hash buffer to a byte array
    const hashArray = Array.from(new Uint8Array(hashBuffer));

    // Convert bytes to hex string
    const hashHex = hashArray
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');

    return hashHex; // e.g. "9b74c9897bac770ffc029102a200c5de..."
}

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
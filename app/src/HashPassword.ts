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
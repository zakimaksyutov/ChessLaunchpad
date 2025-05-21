import { hashPassword } from './HashPassword';

describe('hashPassword', () => {
  test('should hash a simple password correctly', async () => {
    const hash = await hashPassword('password123');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // SHA-256 produces a 64-character hex string
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // Should be a valid hex string
  });

  test('should produce the same hash for the same input', async () => {
    const hash1 = await hashPassword('testPassword');
    const hash2 = await hashPassword('testPassword');
    expect(hash1).toBe(hash2);
  });

  test('should produce different hashes for different inputs', async () => {
    const hash1 = await hashPassword('password1');
    const hash2 = await hashPassword('password2');
    expect(hash1).not.toBe(hash2);
  });

  test('should handle empty string', async () => {
    const hash = await hashPassword('');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
  });

  test('should handle special characters', async () => {
    const hash = await hashPassword('!@#$%^&*()_+{}[]|\\:;"\'<>,.?/');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
  });
}); 
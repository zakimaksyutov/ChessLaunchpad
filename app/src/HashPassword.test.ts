import { hashPassword, derivePassword } from './HashPassword';

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

describe('derivePassword', () => {
  test('should derive password consistently for the same inputs', async () => {
    const password = 'MySecurePassword123';
    const username = 'testUser';
    
    const derived1 = await derivePassword(password, username);
    const derived2 = await derivePassword(password, username);
    
    expect(derived1).toBe(derived2);
    expect(derived1).toMatch(/^pbkdf2\$\d+\$[0-9a-f]+$/);
    
    // Verify format: pbkdf2$iterations$hexdigest
    const parts = derived1.split('$');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('pbkdf2');
    expect(Number(parts[1])).toBe(100000); // Default iterations
    expect(parts[2].length).toBe(64); // 256 bits = 32 bytes = 64 hex chars
  });
  
  test('should produce different results for different passwords', async () => {
    const username = 'testUser';
    const password1 = 'Password1';
    const password2 = 'Password2';
    
    const derived1 = await derivePassword(password1, username);
    const derived2 = await derivePassword(password2, username);
    
    expect(derived1).not.toBe(derived2);
  });
  
  test('should produce different results for different usernames', async () => {
    const password = 'SecurePassword';
    const username1 = 'user1';
    const username2 = 'user2';
    
    const derived1 = await derivePassword(password, username1);
    const derived2 = await derivePassword(password, username2);
    
    expect(derived1).not.toBe(derived2);
  });
  
  test('should be case-insensitive for username', async () => {
    const password = 'SecurePassword';
    const username1 = 'TestUser';
    const username2 = 'testuser';
    
    const derived1 = await derivePassword(password, username1);
    const derived2 = await derivePassword(password, username2);
    
    expect(derived1).toBe(derived2);
  });
  
  test('should use custom iterations when provided', async () => {
    const password = 'SecurePassword';
    const username = 'testuser';
    const customIterations = 50000; // Different from default 100,000
    
    const derived = await derivePassword(password, username, customIterations);
    const parts = derived.split('$');
    
    expect(Number(parts[1])).toBe(customIterations);
  });
  
  test('should handle special characters in password', async () => {
    const password = '!@#$%^&*()_+{}[]|\\:;"\'<>,.?/';
    const username = 'testuser';
    
    const derived = await derivePassword(password, username);
    expect(derived).toMatch(/^pbkdf2\$\d+\$[0-9a-f]+$/);
  });
  
  test('should handle special characters in username', async () => {
    const password = 'SecurePassword';
    const username = 'test.user@example.com';
    
    const derived = await derivePassword(password, username);
    expect(derived).toMatch(/^pbkdf2\$\d+\$[0-9a-f]+$/);
  });
}); 
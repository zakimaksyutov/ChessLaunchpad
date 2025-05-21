// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Mock TextEncoder and crypto.subtle for tests
class MockTextEncoder {
  // Add the required property from the TextEncoder interface
  encoding = 'utf-8';
  
  encode(input: string): Uint8Array {
    const encoder = require('util').TextEncoder
      ? new (require('util').TextEncoder)()
      : {
          encode: (str: string) => {
            const buf = Buffer.from(str, 'utf-8');
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          }
        };
    
    return encoder.encode(input);
  }
  
  // Implement the required encodeInto method
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    const buf = Buffer.from(source, 'utf-8');
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const length = Math.min(bytes.length, destination.length);
    
    for (let i = 0; i < length; i++) {
      destination[i] = bytes[i];
    }
    
    return {
      read: length,
      written: length
    };
  }
}

// Mock crypto.subtle.digest
const mockCrypto = {
  subtle: {
    digest: async (algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> => {
      const crypto = require('crypto');
      const hash = crypto.createHash(algorithm === 'SHA-256' ? 'sha256' : algorithm);
      hash.update(new Uint8Array(data));
      return Promise.resolve(new Uint8Array(hash.digest()).buffer);
    }
  }
};

// Assign mocks to global object - fix the TextEncoder assignment
global.TextEncoder = MockTextEncoder as any;
global.crypto = mockCrypto as unknown as Crypto;

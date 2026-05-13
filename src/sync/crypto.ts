/**
 * hmem-sync crypto layer
 *
 * Key derivation: scrypt (Node.js built-in crypto, memory-hard, no native deps)
 * Encryption:     AES-256-GCM (authenticated, per-blob random IV)
 * Recovery key:   Base58-encoded 16 random bytes (24 chars displayed as groups)
 *
 * Zero-knowledge design:
 *   - The server never sees plaintext content, IDs, or the passphrase.
 *   - Each blob has its own random 12-byte IV — reuse is impossible.
 *   - The salt is stored server-side (public) — it protects against rainbow tables
 *     but the server cannot derive the key without the passphrase.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// ---- Constants ----

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;       // 256 bits
const IV_LEN = 12;        // 96-bit IV for GCM
const TAG_LEN = 16;       // 128-bit auth tag
const SALT_LEN = 32;      // 256-bit salt
const SCRYPT_N = 16384;   // CPU/memory cost (2^14, safe for interactive use)
const SCRYPT_R = 8;
const SCRYPT_P = 1;

// Base58 alphabet (Bitcoin style, no 0/O/I/l ambiguity)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RECOVERY_KEY_BYTES = 16; // → 22 Base58 chars, displayed as 4 groups of ~5-6

// ---- Types ----

export interface EncryptedBlob {
  /** Base64-encoded: IV (12) + ciphertext + auth tag (16) */
  data: string;
  /** ISO timestamp of when this blob was encrypted (for delta sync) */
  updated_at: string;
}

export interface SyncKeyMaterial {
  /** Base64-encoded 32-byte salt — stored server-side, never secret */
  salt: string;
  /** Human-readable recovery key (Base58, grouped with dashes) */
  recoveryKey: string;
}

// ---- Key Derivation ----

/**
 * Derive a 256-bit AES key from a passphrase + salt using scrypt.
 * The salt must be stored server-side and retrieved before any crypto operation.
 */
export function deriveKey(passphrase: string, saltBase64: string): Buffer {
  const salt = Buffer.from(saltBase64, "base64");
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

// ---- Encryption ----

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns a single Base64 blob: IV + ciphertext + auth tag.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Layout: [IV 12 bytes][ciphertext][tag 16 bytes]
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt a blob produced by encrypt().
 * Throws if the auth tag doesn't match (tampered or wrong key).
 */
export function decrypt(blobBase64: string, key: Buffer): string {
  const buf = Buffer.from(blobBase64, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Invalid encrypted blob — too short.");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ---- Salt + Recovery Key Generation ----

/**
 * Generate a new random salt and recovery key for a fresh sync setup.
 * Call once per user — store salt server-side, give recovery key to user.
 */
export function generateKeyMaterial(): SyncKeyMaterial {
  const salt = randomBytes(SALT_LEN).toString("base64");
  const recoveryKey = generateRecoveryKey();
  return { salt, recoveryKey };
}

/**
 * Generate a random Base58 recovery key (grouped for readability).
 * Example: "3KmNp-Tz8Qx-wVrJh-fY2Lc"
 */
function generateRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_KEY_BYTES);
  const encoded = base58Encode(bytes);
  // Pad/split into groups of 5 for readability
  const grouped = encoded.match(/.{1,5}/g) ?? [encoded];
  return grouped.join("-");
}

function base58Encode(buf: Buffer): string {
  let num = BigInt("0x" + buf.toString("hex"));
  const zero = BigInt(0);
  const base = BigInt(58);
  let result = "";
  while (num > zero) {
    result = BASE58_ALPHABET[Number(num % base)] + result;
    num = num / base;
  }
  // Leading zero bytes → '1'
  for (const byte of buf) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

export function base58Decode(str: string): Buffer {
  // Strip grouping dashes
  str = str.replace(/-/g, "");
  let num = BigInt(0);
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid Base58 character: ${char}`);
    num = num * BigInt(58) + BigInt(idx);
  }
  const hex = num.toString(16).padStart(RECOVERY_KEY_BYTES * 2, "0");
  return Buffer.from(hex, "hex");
}

// ---- Entry-level helpers ----

/**
 * Encrypt a single hmem entry's content fields into a blob.
 * The entry_id_hash (SHA-256 of entry ID) is stored unencrypted server-side
 * for delta detection — no plaintext ID leaks to the server.
 */
export function encryptEntry(
  entryId: string,
  payload: Record<string, unknown>,
  key: Buffer,
  updatedAt: string
): EncryptedBlob {
  const plaintext = JSON.stringify(payload);
  return {
    data: encrypt(plaintext, key),
    updated_at: updatedAt,
  };
}

export function decryptEntry(blob: EncryptedBlob, key: Buffer): Record<string, unknown> {
  return JSON.parse(decrypt(blob.data, key)) as Record<string, unknown>;
}

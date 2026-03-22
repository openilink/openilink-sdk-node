import { createCipheriv, createDecipheriv } from "node:crypto";

export const UPLOAD_MAX_RETRIES = 3;

export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, fileKey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
}

export function parseAESKey(aesKeyBase64: string): Uint8Array {
  const decoded = decodeBase64Flexible(aesKeyBase64);

  if (decoded.byteLength === 16) {
    return decoded;
  }

  if (decoded.byteLength === 32 && /^[0-9a-fA-F]+$/.test(Buffer.from(decoded).toString("utf8"))) {
    return Buffer.from(Buffer.from(decoded).toString("utf8"), "hex");
  }

  throw new Error(`ilink: aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.byteLength} bytes`);
}

export function mediaAesKeyHex(hexKey: string): string {
  return Buffer.from(hexKey, "utf8").toString("base64");
}

function decodeBase64Flexible(value: string): Uint8Array {
  const candidates = [
    value,
    value.replace(/-/g, "+").replace(/_/g, "/"),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeBase64(candidate);

    try {
      return Buffer.from(normalized, "base64");
    } catch {
      continue;
    }
  }

  throw new Error(`ilink: invalid base64: ${value}`);
}

function normalizeBase64(value: string): string {
  const padding = value.length % 4;
  if (padding === 0) {
    return value;
  }

  return `${value}${"=".repeat(4 - padding)}`;
}

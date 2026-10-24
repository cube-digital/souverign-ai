import sodium from "libsodium-wrappers-sumo";

/** Await once before any other call. */
export async function cryptoReady(): Promise<void> {
  await sodium.ready;
}

const V = () => sodium.base64_variants.URLSAFE_NO_PADDING;
export const toB64 = (bytes: Uint8Array): string => sodium.to_base64(bytes, V());
export const fromB64 = (text: string): Uint8Array => sodium.from_base64(text, V());

/** A device's X25519 key pair, base64url. The secret key never leaves the device. */
export type DeviceKeys = { publicKey: string; secretKey: string };

export function newDeviceKeys(): DeviceKeys {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: toB64(kp.publicKey), secretKey: toB64(kp.privateKey) };
}

/** Stable 22-character id derived from the public key. */
export function deviceIdFor(publicKey: string): string {
  return toB64(sodium.crypto_generichash(16, fromB64(publicKey), null));
}

export function randomId(): string {
  return toB64(sodium.randombytes_buf(16));
}

export function newChatKey(): string {
  return toB64(sodium.crypto_aead_xchacha20poly1305_ietf_keygen());
}

/** Encrypt a chat key so only the holder of `recipientPublicKey` can open it. */
export function sealKey(chatKey: string, recipientPublicKey: string): string {
  return toB64(sodium.crypto_box_seal(fromB64(chatKey), fromB64(recipientPublicKey)));
}

/** Throws if the key was not sealed for this device. */
export function openKey(sealed: string, device: DeviceKeys): string {
  const key = sodium.crypto_box_seal_open(
    fromB64(sealed),
    fromB64(device.publicKey),
    fromB64(device.secretKey),
  );
  return toB64(key);
}

/** `aad` binds the ciphertext to its envelope (chat, epoch, id); decrypt must pass the same. */
export function encrypt(
  chatKey: string,
  plaintext: string,
  aad: string,
): { nonce: string; ciphertext: string } {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    sodium.from_string(aad),
    null,
    nonce,
    fromB64(chatKey),
  );
  return { nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
}

/** Throws on a wrong key, a tampered ciphertext or a different `aad`. */
export function decrypt(chatKey: string, nonce: string, ciphertext: string, aad: string): string {
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromB64(ciphertext),
    sodium.from_string(aad),
    fromB64(nonce),
    fromB64(chatKey),
  );
  return sodium.to_string(plaintext);
}

/** Attachments: a fresh key per file; the key travels inside the encrypted message. */
export function encryptBytes(data: Uint8Array): {
  key: string;
  nonce: string;
  ciphertext: Uint8Array;
} {
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    data,
    null,
    null,
    nonce,
    key,
  );
  return { key: toB64(key), nonce: toB64(nonce), ciphertext };
}

export function decryptBytes(key: string, nonce: string, ciphertext: Uint8Array): Uint8Array {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    fromB64(nonce),
    fromB64(key),
  );
}

/** The AAD every message uses. */
export const messageAad = (chatId: string, epoch: number, envelopeId: string): string =>
  `sa/v1|${chatId}|${epoch}|${envelopeId}`;

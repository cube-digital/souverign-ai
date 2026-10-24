import { beforeAll, describe, expect, it } from "vitest";
import {
  cryptoReady,
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  messageAad,
  newChatKey,
  newDeviceKeys,
  openKey,
  sealKey,
} from "../src/index.js";

beforeAll(async () => {
  await cryptoReady();
});

describe("crypto", () => {
  it("opens a sealed chat key only on its device and round-trips messages and files", () => {
    const a = newDeviceKeys();
    const b = newDeviceKeys();
    const chatKey = newChatKey();
    const sealed = sealKey(chatKey, a.publicKey);

    expect(openKey(sealed, a)).toBe(chatKey);
    expect(() => openKey(sealed, b)).toThrow();

    const aad = messageAad("chat1", 1, "env1");
    const { nonce, ciphertext } = encrypt(chatKey, "héllo wörld", aad);
    expect(decrypt(chatKey, nonce, ciphertext, aad)).toBe("héllo wörld");

    const data = new Uint8Array([0, 1, 2, 254, 255]);
    const file = encryptBytes(data);
    expect(Array.from(decryptBytes(file.key, file.nonce, file.ciphertext))).toEqual([
      0, 1, 2, 254, 255,
    ]);
  });

  it("rejects a tampered ciphertext and a different envelope binding", () => {
    const chatKey = newChatKey();
    const aad = messageAad("chat1", 1, "env1");
    const { nonce, ciphertext } = encrypt(chatKey, "secret", aad);
    const last = ciphertext.slice(-1);
    const tampered = ciphertext.slice(0, -1) + (last === "A" ? "B" : "A");

    expect(() => decrypt(chatKey, nonce, tampered, aad)).toThrow();
    expect(() => decrypt(chatKey, nonce, ciphertext, messageAad("chat1", 2, "env1"))).toThrow();
    expect(() => decrypt(chatKey, nonce, ciphertext, messageAad("chat1", 1, "env2"))).toThrow();
    expect(decrypt(chatKey, nonce, ciphertext, aad)).toBe("secret");
  });
});

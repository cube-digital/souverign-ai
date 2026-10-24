import { describe, expect, it } from "vitest";
import { signTicket, verifyTicket } from "../src/ticket.js";

describe("relay ticket", () => {
  it("verifies only for its device, before expiry, unaltered, with the right secret", () => {
    const secret = "test-secret-0123456789abcdef";
    const now = 1_000_000;
    const { ticket, expires_at } = signTicket(secret, "device-alpha-01", 60_000, now);

    expect(verifyTicket(secret, ticket, "device-alpha-01", now)).toBe(true);
    expect(verifyTicket(secret, ticket, "device-bravo-02", now)).toBe(false);
    expect(verifyTicket(secret, ticket, "device-alpha-01", expires_at)).toBe(false);
    const altered = (ticket[0] === "A" ? "B" : "A") + ticket.slice(1);
    expect(verifyTicket(secret, altered, "device-alpha-01", now)).toBe(false);
    expect(verifyTicket("another-secret-0123456789", ticket, "device-alpha-01", now)).toBe(false);
  });
});

import type { RelayMemberChange } from "@sa/protocol";

export type RelayAdmin = { setMember(change: RelayMemberChange): Promise<void> };

export function httpRelayAdmin(
  token: string | undefined = process.env.RELAY_ADMIN_TOKEN,
  baseUrl: string = process.env.RELAY_INTERNAL_URL || "http://127.0.0.1:8648",
): RelayAdmin {
  if (!token) {
    console.error(JSON.stringify({ level: "error", msg: "RELAY_ADMIN_TOKEN is required" }));
    process.exit(1);
  }
  return {
    async setMember(change) {
      const res = await fetch(`${baseUrl}/relay/admin/members`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(change),
      });
      if (!res.ok) throw new Error(`relay admin responded ${res.status}`);
    },
  };
}

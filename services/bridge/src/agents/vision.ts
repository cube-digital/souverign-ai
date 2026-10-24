import { llmTarget } from "./hermes.js";

const MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TIMEOUT_MS = 60_000;
const PROMPT =
  "Describe this image for a colleague who cannot see it. Transcribe all visible text exactly. Be factual; do not guess.";

/** Describes an image with the local multimodal model. Throws on unsupported types or errors. */
export async function describeImage(
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<string> {
  if (!MIMES.has(mime)) throw new Error(`unsupported image type for ${name}: ${mime}`);
  const { baseUrl, model } = llmTarget();
  const url = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision request failed: ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (data.choices?.[0]?.message?.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();
  if (!text) throw new Error("empty description");
  return text;
}

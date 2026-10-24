import sharp from "sharp";
import { llmTarget } from "./hermes.js";

const MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TIMEOUT_MS = 60_000;
const PROMPT =
  "Describe this image for a colleague who cannot see it. Transcribe all visible text exactly. Be factual; do not guess.";

export const MAX_SIDE = 1280;

/** Fits the image inside MAX_SIDE x MAX_SIDE; PNG stays PNG, everything else becomes JPEG. */
export async function downscale(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const img = sharp(Buffer.from(bytes), { animated: false });
  const { width = 0, height = 0 } = await img.metadata();
  if (Math.max(width, height) <= MAX_SIDE && mime !== "image/gif") return { bytes, mime };
  const resized = img
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
  const png = mime === "image/png";
  const out = await (png ? resized.png() : resized.jpeg({ quality: 85 })).toBuffer();
  return { bytes: new Uint8Array(out), mime: png ? "image/png" : "image/jpeg" };
}

/** Describes an image with the local multimodal model. Throws on unsupported types or errors. */
export async function describeImage(
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<string> {
  if (!MIMES.has(mime)) throw new Error(`unsupported image type for ${name}: ${mime}`);
  const small = await downscale(bytes, mime);
  const { baseUrl, model } = llmTarget();
  const url = `data:${small.mime};base64,${Buffer.from(small.bytes).toString("base64")}`;
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

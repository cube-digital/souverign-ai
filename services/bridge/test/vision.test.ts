import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let port = 0;
vi.mock("../src/agents/hermes.js", () => ({
  llmTarget: () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "test-vlm" }),
}));

const received: { url: string | undefined; body: any }[] = [];
const server = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    received.push({ url: req.url, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "<think>hmm</think>\n  A login screen.  " } }],
      }),
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

describe("describeImage", () => {
  it("sends the image as a data URI to the local model and strips think blocks", async () => {
    const { describeImage } = await import("../src/agents/vision.js");
    const tiny = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
        .png()
        .toBuffer(),
    );
    const text = await describeImage(tiny, "image/png", "a.png");
    expect(text).toBe("A login screen.");
    const req = received[0];
    expect(req?.url).toBe("/v1/chat/completions");
    expect(req?.body.model).toBe("test-vlm");
    expect(req?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const parts = req?.body.messages[0].content;
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from(tiny).toString("base64")}` },
    });
    await expect(describeImage(new Uint8Array([1]), "application/pdf", "a.pdf")).rejects.toThrow();
  });
});

describe("downscale", () => {
  const png = async (width: number, height: number) =>
    new Uint8Array(
      await sharp({ create: { width, height, channels: 3, background: "#336699" } })
        .png()
        .toBuffer(),
    );

  it("fits images larger than 1280 px into 1280 x 1280 as PNG and leaves smaller ones untouched", async () => {
    const { downscale } = await import("../src/agents/vision.js");
    const big = await downscale(await png(3000, 1000), "image/png");
    const meta = await sharp(Buffer.from(big.bytes)).metadata();
    expect({ w: meta.width, h: meta.height, format: meta.format, mime: big.mime }).toEqual({
      w: 1280,
      h: 427,
      format: "png",
      mime: "image/png",
    });

    const small = await png(800, 600);
    const kept = await downscale(small, "image/png");
    expect(kept.mime).toBe("image/png");
    expect(Buffer.from(kept.bytes).equals(Buffer.from(small))).toBe(true);
  });
});

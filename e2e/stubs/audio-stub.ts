// e2e audio service stand-in: fixed transcript and a short silent WAV, loopback only.
import { createServer } from "node:http";

const PORT = 8665;
const TOKEN = "e2e-audio";

function silentWav(ms: number, rate: number): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (req.headers["x-internal-token"] !== TOKEN) {
    res.writeHead(401).end();
    return;
  }
  // drain the body, then answer
  req.resume();
  req.on("end", () => {
    if (req.method === "POST" && url === "/v1/audio/transcriptions") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          text: "What is on the agenda today?",
          language: "en",
          duration: 1.5,
          segments: [],
        }),
      );
    } else if (req.method === "POST" && url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/wav" }).end(silentWav(300, 24000));
    } else {
      res.writeHead(404).end();
    }
  });
});

server.listen(PORT, "127.0.0.1");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));

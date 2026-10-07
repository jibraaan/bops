import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

/**
 * WhatsApp's way in: Meta's payloads read into messages, the webhook here refusing anything Meta didn't
 * sign, Meta's verification answered, and edge/ answering that check itself and relaying deliveries.
 * Runs in a temporary folder: no app state is written in the checkout, and nothing touches the Keychain.
 */

const SECRET = "test-app-secret";
const VERIFY = "test-verify-token";
process.env.BOPS_WHATSAPP_APP_SECRET = SECRET;
process.env.BOPS_WHATSAPP_VERIFY_TOKEN = VERIFY;
process.chdir(mkdtempSync(`${tmpdir()}/bops-wa-`));

const delivery = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
            contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
            messages: [
              { from: "16505551234", id: "wamid.1", timestamp: "1749416383", type: "text", text: { body: "Does it come in another color?" } },
              { from: "16505551234", id: "wamid.2", timestamp: "1749416384", type: "image", image: { id: "media_1", mime_type: "image/jpeg", caption: "This one" } },
            ],
          },
        },
        // Read receipts and other updates carry no messages.
        { field: "messages", value: { metadata: { phone_number_id: "106540352242922" }, statuses: [{ id: "wamid.0", status: "read" }] } },
      ],
    },
  ],
};

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("a delivery's messages: the number each went to, the message and the sender's name", async () => {
  const { whatsappMessages } = await import("@/lib/server/channels");
  const got = whatsappMessages(delivery);
  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((m) => [m.phoneNumberId, m.message.id, m.name]),
    [
      ["106540352242922", "wamid.1", "Sheena Nelson"],
      ["106540352242922", "wamid.2", "Sheena Nelson"],
    ],
  );
  assert.equal(got[1].message.image?.caption, "This one");
  for (const junk of [null, "x", {}, { entry: "x" }, { entry: [{ changes: [{ field: "messages", value: { messages: [{}] } }] }] }]) assert.deepEqual(whatsappMessages(junk), []);
});

test("the webhook takes only what Meta signed with the app's secret", async () => {
  const { POST } = await import("./route");
  const body = JSON.stringify(delivery);
  const call = (headers: Record<string, string>) => POST(new Request("http://localhost/api/channels/whatsapp/events", { method: "POST", body, headers }));
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ "x-hub-signature-256": sign(body, "another-secret") })).status, 401);
  assert.equal((await call({ "x-hub-signature-256": "sha256=00" })).status, 401);
  // Signed right, for a number no bot here has: taken, and left alone.
  assert.equal((await call({ "x-hub-signature-256": sign(body) })).status, 200);
  const bad = "not json";
  assert.equal((await POST(new Request("http://localhost/x", { method: "POST", body: bad, headers: { "x-hub-signature-256": sign(bad) } }))).status, 400);
});

test("Meta's check of the webhook is answered only with the verify token", async () => {
  const { GET } = await import("./route");
  const check = (token: string) => GET(new Request(`http://localhost/api/channels/whatsapp/events?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`));
  const ok = await check(VERIFY);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "1158201444");
  assert.equal((await check("wrong")).status, 403);
});

/* edge/: the public front door. */

let upstream: Server;
let edge: ChildProcess;
let edgeUrl = "";
const relayed: { path: string; signature?: string; body: string }[] = [];

before(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      relayed.push({ path: req.url ?? "", signature: req.headers["x-hub-signature-256"] as string | undefined, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  edgeUrl = `http://127.0.0.1:${port}`;
  edge = spawn(process.execPath, [fileURLToPath(new URL("../../../../../edge/server.mjs", import.meta.url))], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, PORT: String(port), BOPS_UPSTREAM: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, BOPS_WHATSAPP_VERIFY_TOKEN: VERIFY },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${edgeUrl}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("edge didn't start");
});

after(async () => {
  edge?.kill();
  await new Promise((r) => upstream.close(r));
});

test("edge/ answers Meta's check itself, and relays deliveries byte for byte with their signature", async () => {
  const ok = await fetch(`${edgeUrl}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "42");
  assert.equal((await fetch(`${edgeUrl}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403);
  assert.equal(relayed.length, 0);
  const body = JSON.stringify(delivery);
  const r = await fetch(`${edgeUrl}/hooks/whatsapp`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body), "content-type": "application/json" } });
  assert.equal(r.status, 200);
  assert.deepEqual(relayed, [{ path: "/api/channels/whatsapp/events", signature: sign(body), body }]);
});

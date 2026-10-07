import { createHmac, timingSafeEqual } from "node:crypto";
import { whatsappDelivery } from "@/lib/server/channels";

export const dynamic = "force-dynamic";

/**
 * Messages to the bots' WhatsApp numbers, from Meta's Cloud API webhook. The self-hoster's front door
 * (edge/, /hooks/whatsapp) relays them over the tailnet; Meta signs each with the app's secret
 * (BOPS_WHATSAPP_APP_SECRET), checked here: anything unsigned or forged is refused. The answer goes out
 * at once (Meta retries slow ones); the messages are handled after.
 */
export async function POST(request: Request) {
  const body = await request.text();
  const secret = process.env.BOPS_WHATSAPP_APP_SECRET;
  const sig = request.headers.get("x-hub-signature-256") ?? "";
  if (!secret) return new Response("WhatsApp isn't set up here", { status: 401 });
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return new Response("bad signature", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("not JSON", { status: 400 });
  }
  whatsappDelivery(payload);
  return new Response("ok");
}

/** Meta's check of the webhook, for a front door that passes it on (edge/ answers it itself). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const want = process.env.BOPS_WHATSAPP_VERIFY_TOKEN;
  const ok = !!want && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === want;
  return new Response(ok ? (url.searchParams.get("hub.challenge") ?? "") : "", { status: ok ? 200 : 403 });
}

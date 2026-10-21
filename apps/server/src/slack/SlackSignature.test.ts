import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test vectors need a direct HMAC implementation.
import * as NodeCrypto from "node:crypto";

import { verifySlackRequestSignature } from "./SlackSignature.ts";

const secret = "test-signing-secret";
const body = new TextEncoder().encode('{"type":"event_callback"}');

const signatureFor = (timestamp: string) =>
  `v0=${NodeCrypto.createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;

it("verifies Slack's v0 signature over the timestamp and exact raw body", () => {
  const timestamp = "1_792_510_000".replaceAll("_", "");
  assert.isTrue(
    verifySlackRequestSignature({
      timestamp,
      signature: signatureFor(timestamp),
      secret,
      body,
      nowSeconds: Number(timestamp),
    }),
  );
  assert.isFalse(
    verifySlackRequestSignature({
      timestamp,
      signature: signatureFor(timestamp),
      secret,
      body: new TextEncoder().encode("{}"),
      nowSeconds: Number(timestamp),
    }),
  );
});

it("rejects invalid, missing, stale, and future Slack signatures", () => {
  const timestamp = "1792510000";
  const input = {
    timestamp,
    signature: signatureFor(timestamp),
    secret,
    body,
    nowSeconds: Number(timestamp),
  };
  assert.isFalse(verifySlackRequestSignature({ ...input, signature: "v0=bad" }));
  assert.isFalse(verifySlackRequestSignature({ ...input, signature: "" }));
  assert.isFalse(verifySlackRequestSignature({ ...input, nowSeconds: Number(timestamp) + 301 }));
  assert.isFalse(verifySlackRequestSignature({ ...input, nowSeconds: Number(timestamp) - 301 }));
});

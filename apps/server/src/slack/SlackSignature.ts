// @effect-diagnostics-next-line nodeBuiltinImport:off -- Slack requires HMAC over the raw request bytes.
import * as NodeCrypto from "node:crypto";

const SIGNATURE_VERSION = "v0";
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export function verifySlackRequestSignature(input: {
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly secret: string;
  readonly body: Uint8Array;
  readonly nowSeconds: number;
}): boolean {
  const { timestamp, signature } = input;
  if (
    timestamp === undefined ||
    signature === undefined ||
    !/^\d{1,12}$/u.test(timestamp) ||
    !/^v0=[0-9a-f]{64}$/iu.test(signature)
  )
    return false;

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    !Number.isSafeInteger(input.nowSeconds) ||
    Math.abs(input.nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
  )
    return false;

  const expected = NodeCrypto.createHmac("sha256", input.secret)
    .update(`${SIGNATURE_VERSION}:${timestamp}:`)
    .update(input.body)
    .digest();
  const received = Buffer.from(signature.slice(3), "hex");
  return received.length === expected.length && NodeCrypto.timingSafeEqual(received, expected);
}

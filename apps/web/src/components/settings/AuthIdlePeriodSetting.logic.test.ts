import { describe, expect, it } from "vite-plus/test";
import { parseAuthIdlePeriodDays } from "./AuthIdlePeriodSetting.logic";

describe("parseAuthIdlePeriodDays", () => {
  it.each(["1", "90", "360"])("accepts %s days", (value) => {
    expect(parseAuthIdlePeriodDays(value)).toBe(Number(value));
  });

  it.each(["", "0", "361", "1.5", "abc"])("rejects %s", (value) => {
    expect(parseAuthIdlePeriodDays(value)).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { externalHref } from "./externalHref";

describe("externalHref", () => {
  it("keeps web links and drops script and malformed ones", () => {
    expect(externalHref("https://linear.app/ome/issue/OME-1")).toBe(
      "https://linear.app/ome/issue/OME-1",
    );
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("not a url")).toBeNull();
  });
});

import type { DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  canRevokeOtherClients,
  clientExpiryLabel,
  longLivedTokenAccessLabel,
  resolveTailscaleServeBaseUrl,
  selectQrEndpointOption,
  splitClientSessions,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

describe("resolveTailscaleServeBaseUrl", () => {
  it.each([
    ["https://host.tail.ts.net:441/", 443, "https://host.tail.ts.net"],
    ["https://host.tail.ts.net:441/", 444, "https://host.tail.ts.net:444"],
  ] as const)("previews %s on port %i", (httpBaseUrl, port, expected) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, true)).toBe(expected);
  });

  it("returns null without a pending endpoint", () => {
    expect(resolveTailscaleServeBaseUrl(null, 443, true)).toBeNull();
  });

  it.each([
    ["https://host.tail.ts.net:441/", 0, false],
    ["not a URL", 443, true],
  ] as const)("preserves %s when port %i cannot be previewed", (httpBaseUrl, port, isPortValid) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, isPortValid)).toBe(httpBaseUrl);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

const clientSession = (overrides: {
  kind?: "session" | "oauth-grant" | "long-lived-token";
  renewable?: boolean;
  expiresAt?: string;
}) => ({
  kind: "session" as const,
  renewable: false,
  expiresAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

describe("splitClientSessions", () => {
  it("splits long-lived tokens from other clients", () => {
    const { clients, longLivedTokens } = splitClientSessions([
      clientSession({ kind: "session" }),
      clientSession({ kind: "long-lived-token" }),
      clientSession({ kind: "oauth-grant" }),
    ]);
    expect(longLivedTokens.map((s) => s.kind)).toEqual(["long-lived-token"]);
    expect(clients.map((s) => s.kind)).toEqual(["session", "oauth-grant"]);
  });
});

describe("clientExpiryLabel", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

  it("labels renewable sessions as renewing on use", () => {
    expect(clientExpiryLabel(clientSession({ renewable: true }), nowMs)).toBe("Renews on use");
  });

  it("formats the remaining time for fixed-expiry sessions", () => {
    expect(clientExpiryLabel(clientSession({}), nowMs)).toBe("Expires in 1d");
  });
});

describe("longLivedTokenAccessLabel", () => {
  it.each([
    { access: "read-only", expected: "Read only" },
    { access: "approval-required", expected: "Approval required" },
    { access: "auto-accept-edits", expected: "Auto-accept edits" },
    { access: "auto", expected: "Auto" },
    { access: "full-access", expected: "Full access" },
    { access: null, expected: "Unknown" },
  ] as const)("maps $access to $expected", ({ access, expected }) => {
    expect(longLivedTokenAccessLabel(access)).toBe(expected);
  });
});

describe("canRevokeOtherClients with long-lived tokens", () => {
  it("ignores long-lived tokens", () => {
    expect(
      canRevokeOtherClients([
        { current: true, kind: "session" },
        { current: false, kind: "long-lived-token" },
      ]),
    ).toBe(false);
    expect(
      canRevokeOtherClients([
        { current: true, kind: "session" },
        { current: false, kind: "oauth-grant" },
      ]),
    ).toBe(true);
  });
});

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  idlePeriodDays: 90,
  update: vi.fn(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettings: (() => state.idlePeriodDays) as never,
  useUpdatePrimarySettings: () => state.update,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode | undefined;
    control?: ReactNode | undefined;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  )) as never,
}));
vi.mock(import("./settingsSearch"), async (original) => ({
  ...(await original()),
  searchableSetting: () => ({ id: "auth-idle-period", title: "Authentication idle period" }),
}));

import { AuthIdlePeriodSetting } from "./AuthIdlePeriodSetting";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  state.idlePeriodDays = 90;
  state.update.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows the current value and persists a valid change on blur", async () => {
  await act(async () => root.render(<AuthIdlePeriodSetting />));

  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Authentication idle period in days"]',
  );
  expect(input?.value).toBe("90");
  expect(input?.min).toBe("1");
  expect(input?.max).toBe("360");
  expect(container.textContent).toContain("does not shorten any existing session");

  await userEvent.fill(input!, "120");
  await userEvent.tab();

  expect(state.update).toHaveBeenCalledWith({ authIdlePeriodDays: 120 });
});

it("does not persist a value outside the supported range", async () => {
  await act(async () => root.render(<AuthIdlePeriodSetting />));
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Authentication idle period in days"]',
  )!;

  await userEvent.fill(input, "361");
  await userEvent.tab();

  expect(state.update).not.toHaveBeenCalled();
  expect(input.value).toBe("90");
});

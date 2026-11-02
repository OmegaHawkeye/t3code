import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId } from "@t3tools/contracts";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  idlePeriodDays: 90,
  update: vi.fn(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => state.idlePeriodDays) as never,
  useUpdateEnvironmentSettings: () => state.update,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
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

const environmentId = EnvironmentId.make("auth-idle-period-test");

function setup() {
  state.idlePeriodDays = 90;
  state.update.mockReset();
}

const renderSetting = () =>
  render(<AuthIdlePeriodSetting environmentId={environmentId} environmentLabel="Test machine" />, {
    router: false, // The setting renders no links.
  });

const idleInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Authentication idle period in days for Test machine"]',
  )!;

it("shows the current value and persists a valid change on blur", async () => {
  setup();
  await using screen = await renderSetting();
  const input = idleInput(screen.container);
  expect(input.value).toBe("90");
  expect(input.min).toBe("1");
  expect(input.max).toBe("360");
  expect(screen.container.textContent).toContain("does not shorten any existing session");

  await userEvent.fill(input, "120");
  await userEvent.tab();

  expect(state.update).toHaveBeenCalledWith({ authIdlePeriodDays: 120 });
});

it("does not persist a value outside the supported range", async () => {
  setup();
  await using screen = await renderSetting();
  const input = idleInput(screen.container);

  await userEvent.fill(input, "361");
  await userEvent.tab();

  expect(state.update).not.toHaveBeenCalled();
  expect(input.value).toBe("90");
});

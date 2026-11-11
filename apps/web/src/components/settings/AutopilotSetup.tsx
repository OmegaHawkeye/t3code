import type { AutopilotIntakeMode, AutopilotTicketSource } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, LockIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { autopilotSourceStatus, INTAKE_MODE_LABEL } from "./AutopilotSetup.logic";
import { SettingsPageContainer } from "./settingsLayout";
import { useScopedSettings } from "./useScopedSettings";

const SOURCES = [
  { id: "linear", name: "Linear", to: "/settings/linear-autopilot/linear" },
  { id: "github", name: "GitHub Issues", to: "/settings/linear-autopilot/github" },
  { id: "slack", name: "Slack", to: "/settings/linear-autopilot/slack" },
] as const satisfies readonly { id: AutopilotTicketSource; name: string; to: string }[];

export function AutopilotSourcesLayout({
  source,
  notices,
  children,
}: {
  readonly source: AutopilotTicketSource;
  readonly notices?: ReactNode;
  readonly children: ReactNode;
}) {
  const settings = useScopedSettings((value) => value.linearAutopilot);
  const current = SOURCES.find((item) => item.id === source)!;
  return (
    <SettingsPageContainer width="wide" className="gap-6">
      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Autopilot sources" className="space-y-1">
          <Button
            render={<Link to="/settings/linear-autopilot" />}
            variant="ghost-muted"
            size="compact"
          >
            <ArrowLeftIcon aria-hidden /> Autopilot
          </Button>
          <ul className="flex gap-1 md:flex-col">
            {SOURCES.map((item) => {
              const status = autopilotSourceStatus(settings, item.id);
              return (
                <li key={item.id} className="min-w-0 flex-1 md:flex-none">
                  <Link
                    to={item.to}
                    aria-current={item.id === source ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2.5 py-2",
                      item.id === source ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <span className="block truncate text-sm">{item.name}</span>
                    <span
                      className={cn(
                        "block truncate text-xs",
                        status.tone === "active"
                          ? "text-success-foreground"
                          : status.tone === "attention"
                            ? "text-warning-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {status.text}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 space-y-3">
          <h2 className="text-lg font-medium">{current.name}</h2>
          {notices}
          {children}
        </div>
      </div>
    </SettingsPageContainer>
  );
}

export function AutopilotIntegrationSettingsLoading() {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        Loading Autopilot integration settings…
      </p>
      <SettingsPageContainer width="wide" className="gap-6">
        <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
          <nav aria-label="Autopilot sources" className="space-y-2">
            <Skeleton className="h-8 w-28" />
            <div className="space-y-1">
              {["Linear", "GitHub Issues", "Slack"].map((source) => (
                <div key={source} className="space-y-2 rounded-md px-2.5 py-2">
                  <span className="sr-only">{source}</span>
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          </nav>
          <div className="min-w-0 space-y-4">
            <Skeleton className="h-6 w-40" />
            {[0, 1, 2, 3].map((step) => (
              <section key={step} className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center gap-3">
                  <Skeleton shape="pill" className="size-6" />
                  <Skeleton className="h-4 w-48" />
                </div>
                <Skeleton className="h-4 w-full max-w-md" />
                {step < 3 ? <Skeleton className="h-9 w-56" /> : null}
              </section>
            ))}
            <div className="flex justify-end">
              <Skeleton className="h-9 w-36" />
            </div>
          </div>
        </div>
      </SettingsPageContainer>
    </div>
  );
}

/**
 * A setup step stays open until it is complete, then collapses to its summary.
 * Locked steps wait on earlier ones so the page always shows the next thing to do.
 */
export function AutopilotSetupStep({
  step,
  title,
  done,
  locked = false,
  summary,
  children,
}: {
  readonly step: number;
  readonly title: string;
  readonly done: boolean;
  readonly locked?: boolean;
  readonly summary?: ReactNode;
  readonly children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const open = !locked && (!done || editing);
  return (
    <section
      aria-label={title}
      className={cn("rounded-xl border", open && "bg-card", locked && !done && "opacity-60")}
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
            done && "border-success bg-success text-white",
          )}
        >
          {done ? (
            <CheckIcon className="size-3.5" />
          ) : locked ? (
            <LockIcon className="size-3" />
          ) : (
            step
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {!open && done && summary ? (
            <p className="truncate text-xs text-muted-foreground">{summary}</p>
          ) : null}
        </div>
        {done && !locked ? (
          <Button variant="ghost" size="compact" onClick={() => setEditing((value) => !value)}>
            {editing ? "Done" : "Edit"}
          </Button>
        ) : null}
      </header>
      {open ? <div className="space-y-3 border-t px-4 py-4">{children}</div> : null}
    </section>
  );
}

const MODE_HINT: Record<AutopilotIntakeMode, string> = {
  disabled: "Ignore new issues.",
  shadow: "Evaluate issues and record decisions without queueing work.",
  queue: "Queue eligible issues for Autopilot.",
};

export function AutopilotIntakeModePicker({
  value,
  modes,
  onChange,
  disabled,
  hints,
}: {
  readonly value: AutopilotIntakeMode;
  readonly modes: readonly AutopilotIntakeMode[];
  readonly onChange: (mode: AutopilotIntakeMode) => void;
  readonly disabled?: boolean;
  readonly hints?: Partial<Record<AutopilotIntakeMode, string>>;
}) {
  return (
    <div role="radiogroup" aria-label="Intake mode" className="grid gap-2 sm:grid-cols-3">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={cn(
            "rounded-lg border p-3 text-left disabled:opacity-50",
            value === mode ? "border-primary bg-primary/5" : "hover:bg-accent/50",
          )}
        >
          <span className="block text-sm font-medium">{INTAKE_MODE_LABEL[mode]}</span>
          <span className="block text-xs text-muted-foreground">
            {hints?.[mode] ?? MODE_HINT[mode]}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Toggle chips for a short multi-select; saved IDs the catalog no longer knows stay removable. */
export function AutopilotChipSelect({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
}) {
  const known = new Set(options.map((option) => option.id));
  const all = [
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, name: `${id} (saved value)` })),
    ...options,
  ];
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {all.map((option) => {
        const on = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() =>
              onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])
            }
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs disabled:opacity-50",
              on
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-input text-muted-foreground hover:bg-accent",
            )}
          >
            {option.name}
            {on ? <CheckIcon className="size-3" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

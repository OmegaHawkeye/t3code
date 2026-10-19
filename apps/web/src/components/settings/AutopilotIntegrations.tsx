import { ArrowRightIcon, Clock3Icon, ListChecksIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export interface AutopilotIntegrationDefinition<Destination extends string = string> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly availability: "available" | "coming-soon";
  readonly destination?: Destination;
}

export const AUTOPILOT_INTEGRATIONS = [
  {
    id: "linear",
    name: "Linear",
    description: "Choose teams, workflow statuses, labels, and trusted project mappings.",
    availability: "available",
    destination: "/settings/linear-autopilot/linear",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Connect team conversations to Autopilot workflows.",
    availability: "coming-soon",
  },
  {
    id: "github-issues",
    name: "GitHub Issues",
    description: "Use GitHub issues as an additional work intake source.",
    availability: "coming-soon",
  },
] as const satisfies readonly AutopilotIntegrationDefinition[];

export function AutopilotIntegrationsPanel() {
  return (
    <SettingsPageContainer className="gap-6">
      <SettingsSection title="Autopilot integrations">
        {AUTOPILOT_INTEGRATIONS.map((integration) => (
          <SettingsRow
            key={integration.id}
            title={integration.name}
            description={integration.description}
            control={
              integration.availability === "available" && integration.destination ? (
                <div className="flex items-center gap-2">
                  <Button render={<Link to={integration.destination} />} variant="outline">
                    Configure <ArrowRightIcon />
                  </Button>
                </div>
              ) : (
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock3Icon className="size-4" /> Coming soon
                </span>
              )
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Plan approvals">
        <SettingsRow
          title="Review pending plans"
          description="Review saved plans and their independent reviews."
          control={
            <div className="flex items-center gap-2">
              <Button render={<Link to="/settings/linear-autopilot/approvals" />} variant="outline">
                Open approvals <ListChecksIcon />
              </Button>
            </div>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

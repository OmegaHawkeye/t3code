import { ArrowRightIcon, ListChecksIcon } from "lucide-react";
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

const AUTOPILOT_INTEGRATIONS = [
  {
    id: "linear",
    name: "Linear",
    description: "Choose teams, workflow statuses, labels, and trusted project mappings.",
    availability: "available",
    destination: "/settings/linear-autopilot/linear",
  },
  {
    id: "github",
    name: "GitHub Issues",
    description:
      "Create and install the GitHub App, then choose its issue trigger and trusted projects.",
    availability: "available",
    destination: "/settings/linear-autopilot/github",
  },
  {
    id: "slack",
    name: "Slack",
    description:
      "Create the Slack app, connect a workspace, and choose its signing secret, channels, and project.",
    availability: "available",
    destination: "/settings/linear-autopilot/slack",
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
              <Button render={<Link to={integration.destination} />} variant="outline">
                Configure <ArrowRightIcon />
              </Button>
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Approvals">
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

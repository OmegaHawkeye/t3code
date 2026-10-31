import {
  defaultLinearAutopilotWorkflow,
  ProjectId,
  type LinearAutopilotWorkflow,
  type LinearAutopilotWorkflowNode,
  type LinearAutopilotWorkflowNodeKind,
  type ModelSelection,
  type ProjectSnapshot,
} from "@t3tools/contracts";
import {
  linearAutopilotWorkflowIssues,
  type LinearAutopilotRoutableOutcome,
} from "@t3tools/shared/linearAutopilotWorkflow";
import { Link } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { AlertTriangleIcon, ArrowLeftIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../../environments/primary/httpClient";
import { cn } from "../../../lib/utils";
import { runPrimaryHttp } from "../../../lib/runtime";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { SettingsPageContainer } from "../../settings/settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "../../settings/useScopedSettings";
import { WorkflowCanvas, type WorkflowSelection } from "./WorkflowCanvas";
import { useWorkflowModelName, WorkflowPersonaModelPicker } from "./WorkflowPersonaModelPicker";
import { useProjectRuns, WorkflowRunDetails, WorkflowRunList } from "./WorkflowRuns";
import {
  addNode,
  canAddNode,
  customizeWorkflow,
  instructionsRevision,
  isBuiltInWorkflow,
  isLoopRoute,
  issueForRoute,
  issuesForNode,
  issueText,
  moveNode,
  outcomesOf,
  PHASE_LABEL,
  removeNode,
  routeTargets,
  setRoute,
  setRouteBudget,
  updateNode,
} from "./workflowEditor.logic";

const BUDGET_OPTIONS = [0, 1, 2, 3, 5, 10];

function phaseSubtitle(
  workflow: LinearAutopilotWorkflow,
  nodeId: string,
  modelName: (selection: ModelSelection) => string,
) {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return "";
  if (node.kind === "merge") return "Protected delivery";
  if (!node.persona) return "Project default model";
  return node.persona.instructions?.personaName ?? modelName(node.persona.modelSelection);
}
const selectClass = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export function WorkflowEditorPage() {
  const settings = useScopedSettings();
  const writeAllowed = useScopedSettingsWriteAllowed();
  const updateSettings = useUpdateScopedSettings();
  const [projects, setProjects] = useState<ProjectSnapshot["projects"] | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);

  useEffect(() => {
    let cancelled = false;
    void runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.projects.snapshot({ headers: {} })),
      ),
    ).then(
      (snapshot) => {
        if (!cancelled)
          setProjects(snapshot.projects.filter((project) => project.deletedAt === null));
      },
      () => {
        if (!cancelled) setProjectsFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const mappedProjectIds = new Set<string>([
    ...Object.values(settings.linearAutopilot.projectMappings),
    ...Object.values(settings.linearAutopilot.githubIssueProjectMappings),
    ...(settings.linearAutopilot.slackProjectId ? [settings.linearAutopilot.slackProjectId] : []),
  ]);
  const sortedProjects = [...(projects ?? [])].sort(
    (a, b) => Number(mappedProjectIds.has(b.id)) - Number(mappedProjectIds.has(a.id)),
  );
  const selectedProjectId = projectId ?? sortedProjects[0]?.id ?? null;

  return (
    <SettingsPageContainer width="wide" className="gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          render={<Link to="/settings/linear-autopilot" />}
          variant="ghost-muted"
          size="compact"
        >
          <ArrowLeftIcon aria-hidden /> Autopilot
        </Button>
        <h2 className="text-lg font-medium">Workflows</h2>
      </div>
      {projectsFailed ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load T3 projects. Reload the page to retry.
        </p>
      ) : projects === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading projects…
        </p>
      ) : selectedProjectId === null ? (
        <p className="text-sm text-muted-foreground">Add a T3 project to give it a workflow.</p>
      ) : (
        <ProjectWorkflowEditor
          key={selectedProjectId}
          projectId={selectedProjectId}
          projects={sortedProjects}
          mappedProjectIds={mappedProjectIds}
          onProjectChange={setProjectId}
          saved={
            settings.linearAutopilot.workflows[selectedProjectId] ?? defaultLinearAutopilotWorkflow
          }
          projectModel={
            sortedProjects.find((project) => project.id === selectedProjectId)
              ?.defaultModelSelection ?? settings.defaultModelSelection
          }
          readOnly={!writeAllowed}
          onSave={(workflow) => {
            const { [selectedProjectId]: _previous, ...others } =
              settings.linearAutopilot.workflows;
            updateSettings({
              linearAutopilot: {
                ...settings.linearAutopilot,
                // Absent means the built-in workflow, so saving it back stores nothing.
                workflows: isBuiltInWorkflow(workflow)
                  ? others
                  : { ...others, [selectedProjectId]: workflow },
              },
            });
          }}
        />
      )}
    </SettingsPageContainer>
  );
}

function ProjectWorkflowEditor({
  projectId,
  projects,
  mappedProjectIds,
  onProjectChange,
  saved,
  projectModel,
  readOnly: writeBlocked,
  onSave,
}: {
  readonly projectId: ProjectId;
  readonly projects: ProjectSnapshot["projects"];
  readonly mappedProjectIds: ReadonlySet<string>;
  readonly onProjectChange: (projectId: ProjectId) => void;
  readonly saved: LinearAutopilotWorkflow;
  readonly projectModel: ModelSelection | null;
  readonly readOnly: boolean;
  readonly onSave: (workflow: LinearAutopilotWorkflow) => void;
}) {
  const [draft, setDraft] = useState<LinearAutopilotWorkflow | null>(null);
  // The saved workflow the draft started from, to notice a save from another device or tab.
  const [draftBase, setDraftBase] = useState<string | null>(null);
  const [selection, setSelection] = useState<WorkflowSelection>({ kind: "node", id: saved.entry });
  const [adding, setAdding] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [mode, setMode] = useState<"edit" | "runs">("edit");
  const workflow = draft ?? saved;
  const builtIn = isBuiltInWorkflow(workflow);
  const editable = !writeBlocked && !builtIn;
  // Settings round-trip through JSON, so structural equality is what "saved" means here.
  const savedJson = JSON.stringify(saved);
  const dirty = draft !== null && JSON.stringify(draft) !== savedJson;
  const conflict = dirty && draftBase !== null && draftBase !== savedJson;
  const issues = linearAutopilotWorkflowIssues(workflow);
  const modelName = useWorkflowModelName();
  const edit = (next: LinearAutopilotWorkflow) => {
    if (draft === null) setDraftBase(savedJson);
    setDraft(next);
  };
  const replace = (next: LinearAutopilotWorkflow) => {
    edit(next);
    setSelection({ kind: "node", id: next.entry });
    setCanvasKey((key) => key + 1);
  };

  const selectedNodeId =
    selection?.kind === "node" ? selection.id : selection?.kind === "route" ? selection.from : null;
  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const personaLabel = (nodeId: string) => phaseSubtitle(workflow, nodeId, modelName);
  const globalIssues = issues.filter(
    (issue) => issue.nodeId === undefined && issue.edge === undefined,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Project"
          className={cn(selectClass, "w-64")}
          value={projectId}
          onChange={(event) => onProjectChange(ProjectId.make(event.target.value))}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
              {mappedProjectIds.has(project.id) ? "" : " (not used by Autopilot)"}
            </option>
          ))}
        </select>
        <ToggleGroup
          aria-label="View"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "edit" || value === "runs") setMode(value);
          }}
        >
          <Toggle value="edit">Workflow</Toggle>
          <Toggle value="runs">Runs</Toggle>
        </ToggleGroup>
        <Badge size="control" variant={builtIn ? "outline" : "info"}>
          {builtIn ? "Built-in workflow" : workflow.label}
        </Badge>
        {dirty ? (
          <Badge size="control" variant="warning">
            Unsaved changes
          </Badge>
        ) : null}
        <div className={cn("ml-auto flex items-center gap-2", mode === "runs" && "hidden")}>
          {builtIn ? (
            <Button
              variant="outline"
              disabled={writeBlocked}
              onClick={() => replace(customizeWorkflow(projectModel))}
            >
              <CopyIcon aria-hidden /> Customize
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={writeBlocked}
              onClick={() => replace(defaultLinearAutopilotWorkflow)}
            >
              Reset to built-in
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              replace(saved);
              setDraft(null);
            }}
          >
            Discard
          </Button>
          <Button
            disabled={writeBlocked || !dirty || conflict || issues.length > 0}
            onClick={() => {
              onSave(workflow);
              setDraft(null);
            }}
          >
            Save workflow
          </Button>
        </div>
      </div>
      {mode === "runs" ? (
        <ProjectRunsView projectId={projectId} modelName={modelName} />
      ) : (
        <>
          {conflict ? (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>Saved somewhere else while you were editing</AlertTitle>
              <AlertDescription>Saving now would replace that version.</AlertDescription>
              <AlertAction>
                <Button
                  variant="outline"
                  size="compact"
                  onClick={() => {
                    replace(saved);
                    setDraft(null);
                  }}
                >
                  Load saved version
                </Button>
                <Button variant="ghost" size="compact" onClick={() => setDraftBase(savedJson)}>
                  Keep my changes
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {builtIn
              ? "Runs in this project use the built-in plan → review → implement → merge workflow. Customize it to choose personas, retry budgets, and alternate phases."
              : "Saved changes apply to new runs. Runs already in progress keep the workflow they started with."}
            {writeBlocked
              ? " This environment needs settings write permission to change workflows."
              : ""}
          </p>

          <div className="relative">
            <WorkflowCanvas
              key={`${projectId}:${canvasKey}`}
              workflow={workflow}
              issues={issues}
              readOnly={!editable}
              selection={selection}
              onSelect={setSelection}
              onRoute={(from, on, to) => {
                edit(setRoute(workflow, from, on, to));
                setSelection({ kind: "route", from, on });
              }}
              onMove={(nodeId, position) => edit(moveNode(workflow, nodeId, position))}
              personaLabel={personaLabel}
            />
            {editable ? (
              <div className="absolute top-3 left-3 z-30">
                <Button
                  variant="outline"
                  size="compact"
                  disabled={!canAddNode(workflow)}
                  onClick={() => setAdding((value) => !value)}
                >
                  <PlusIcon aria-hidden /> Add phase
                </Button>
                {adding ? (
                  <div className="absolute left-0 z-40 mt-1 w-40 rounded-lg border bg-popover p-1 shadow-lg">
                    {(Object.keys(PHASE_LABEL) as LinearAutopilotWorkflowNodeKind[]).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                        onClick={() => {
                          const result = addNode(workflow, kind, projectModel);
                          edit(result.workflow);
                          setSelection({ kind: "node", id: result.nodeId });
                          setAdding(false);
                        }}
                      >
                        {PHASE_LABEL[kind]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="rounded-xl border">
              <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground uppercase">
                Phases &amp; routes
              </div>
              <ul>
                {workflow.nodes.map((node) => {
                  const nodeIssues = issuesForNode(issues, node.id);
                  return (
                    <li key={node.id}>
                      <button
                        type="button"
                        onClick={() => setSelection({ kind: "node", id: node.id })}
                        className={cn(
                          "flex w-full items-center gap-3 border-b px-4 py-2.5 text-left text-sm",
                          selectedNodeId === node.id ? "bg-accent" : "hover:bg-accent/50",
                        )}
                      >
                        <span className="w-28 shrink-0 font-medium">
                          {PHASE_LABEL[node.kind]}
                          {node.id !== node.kind ? (
                            <span className="font-normal text-muted-foreground"> · {node.id}</span>
                          ) : null}
                        </span>
                        <span className="w-40 shrink-0 truncate text-muted-foreground">
                          {personaLabel(node.id)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {workflow.edges
                            .filter((edge) => edge.from === node.id)
                            .map(
                              (edge) =>
                                `${edge.on} → ${edge.to}${edge.budget !== undefined ? ` ×${edge.budget}` : ""}`,
                            )
                            .join(" · ")}
                        </span>
                        {nodeIssues.length > 0 ? (
                          <AlertTriangleIcon
                            className="size-4 shrink-0 text-destructive"
                            aria-label={`${nodeIssues.length} issues`}
                          />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {issues.length > 0 ? (
                <div className="bg-destructive/4 px-4 py-3">
                  <div className="mb-1 text-sm font-medium text-destructive-foreground">
                    {issues.length} {issues.length === 1 ? "issue blocks" : "issues block"} saving
                  </div>
                  <ul className="space-y-1 text-sm">
                    {issues.map((issue) => (
                      <li
                        key={`${issue.nodeId ?? ""}:${issue.edge ? `${issue.edge.from}:${issue.edge.on}` : ""}:${issue.message}`}
                      >
                        {issue.nodeId !== undefined || issue.edge !== undefined ? (
                          <button
                            type="button"
                            className="text-left underline-offset-2 hover:underline"
                            onClick={() =>
                              setSelection(
                                issue.edge && issue.edge.on !== "blocked"
                                  ? { kind: "route", from: issue.edge.from, on: issue.edge.on }
                                  : { kind: "node", id: issue.nodeId ?? issue.edge!.from },
                              )
                            }
                          >
                            {issueText(issue)}
                          </button>
                        ) : (
                          issueText(issue)
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {globalIssues.length === 0 && issues.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  Every route passes planning, review, implementation, and the protected merge gate.
                </p>
              ) : null}
            </div>

            <aside className="rounded-xl border p-4" aria-label="Phase inspector">
              {selectedNode ? (
                <PhaseInspector
                  workflow={workflow}
                  node={selectedNode}
                  selectedOutcome={selection?.kind === "route" ? selection.on : null}
                  issues={issues}
                  editable={editable}
                  onChange={edit}
                  onRemove={() => {
                    edit(removeNode(workflow, selectedNode.id));
                    setSelection(null);
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a phase or a route on the canvas. Drag empty space to pan; scroll or use
                  the controls to zoom.
                </p>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function ProjectRunsView({
  projectId,
  modelName,
}: {
  readonly projectId: ProjectId;
  readonly modelName: (selection: ModelSelection) => string;
}) {
  const { runs, failed, loading, refresh } = useProjectRuns(projectId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const run = runs?.find((item) => item.runId === selectedRunId) ?? runs?.[0] ?? null;
  const execution = run?.workflow ?? null;

  return (
    <div className="space-y-4">
      {execution !== null && run !== null ? (
        <WorkflowCanvas
          key={run.runId}
          workflow={execution.definition}
          issues={[]}
          readOnly
          selection={null}
          onSelect={() => {}}
          onRoute={() => {}}
          onMove={() => {}}
          personaLabel={(nodeId) => phaseSubtitle(execution.definition, nodeId, modelName)}
          activeNodeId={execution.nodeId}
          traversals={execution.traversals}
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <WorkflowRunList
          runs={runs}
          failed={failed}
          loading={loading}
          selectedRunId={run?.runId ?? null}
          onSelect={setSelectedRunId}
          onRefresh={refresh}
        />
        <aside className="rounded-xl border p-4" aria-label="Run details">
          {run ? (
            <WorkflowRunDetails key={run.runId} run={run} onCancelled={refresh} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Runs appear here once Autopilot picks up a ticket for this project.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function PhaseInspector({
  workflow,
  node,
  selectedOutcome,
  issues,
  editable,
  onChange,
  onRemove,
}: {
  readonly workflow: LinearAutopilotWorkflow;
  readonly node: LinearAutopilotWorkflowNode;
  readonly selectedOutcome: LinearAutopilotRoutableOutcome | null;
  readonly issues: ReturnType<typeof linearAutopilotWorkflowIssues>;
  readonly editable: boolean;
  readonly onChange: (workflow: LinearAutopilotWorkflow) => void;
  readonly onRemove: () => void;
}) {
  const nodeLevelIssues = issues.filter(
    (issue) => issue.nodeId === node.id && issue.edge === undefined,
  );
  const instructions = node.persona?.instructions;
  const setInstructions = (personaName: string, text: string) =>
    onChange(
      updateNode(workflow, node.id, (current) => {
        if (!current.persona) return current;
        const { instructions: _previous, ...persona } = current.persona;
        return {
          ...current,
          persona:
            text.trim().length === 0
              ? persona
              : {
                  ...persona,
                  instructions: {
                    personaName: personaName.trim() || `${PHASE_LABEL[current.kind]} persona`,
                    revision: instructionsRevision(text),
                    text,
                  },
                },
        };
      }),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground uppercase">Phase</div>
          <div className="text-base font-medium">
            {PHASE_LABEL[node.kind]} <span className="text-muted-foreground">· {node.id}</span>
          </div>
        </div>
        {editable && workflow.entry !== node.id ? (
          <Button
            variant="ghost-destructive"
            size="icon-sm"
            aria-label={`Remove ${node.id}`}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>
      {nodeLevelIssues.map((issue) => (
        <p key={issue.message} className="text-sm text-destructive-foreground">
          {issueText(issue)}
        </p>
      ))}

      {node.kind === "merge" ? (
        <p className="text-sm text-muted-foreground">
          Merge opens the pull request and waits for CI using the protected delivery behavior. It
          never merges on its own, and it has no persona.
        </p>
      ) : node.persona || editable ? (
        <div className="space-y-2">
          <span className="block text-xs text-muted-foreground">Model</span>
          <WorkflowPersonaModelPicker
            ariaLabel={`Model for ${node.id}`}
            value={node.persona?.modelSelection ?? null}
            disabled={!editable}
            onChange={(modelSelection) =>
              onChange(
                updateNode(workflow, node.id, (current) => ({
                  ...current,
                  persona: { ...current.persona, modelSelection },
                })),
              )
            }
          />
          <label className="block space-y-1">
            <span className="block text-xs text-muted-foreground">Persona name</span>
            <Input
              value={instructions?.personaName ?? ""}
              placeholder={`${PHASE_LABEL[node.kind]} persona`}
              disabled={!editable || !instructions}
              onChange={(event) => setInstructions(event.target.value, instructions?.text ?? "")}
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-xs text-muted-foreground">
              Instructions, added to this phase&apos;s prompt
            </span>
            <Textarea
              value={instructions?.text ?? ""}
              placeholder="Optional. For example: keep plans to five steps and name the verification command."
              disabled={!editable || !node.persona}
              maxLength={8000}
              onChange={(event) =>
                setInstructions(instructions?.personaName ?? "", event.target.value)
              }
            />
          </label>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Uses the project&apos;s default model. Customize the workflow to choose a model and
          instructions for this phase.
        </p>
      )}

      <div className="space-y-2">
        <span className="block text-xs text-muted-foreground">Routes</span>
        {outcomesOf(node.kind).map((on) => {
          const edge = workflow.edges.find((item) => item.from === node.id && item.on === on);
          const targets = routeTargets(workflow, node.kind, on);
          const issue = issueForRoute(issues, node.id, on);
          const loop = edge !== undefined && isLoopRoute(workflow, node.id, on);
          return (
            <div
              key={on}
              className={cn(
                "space-y-2 rounded-lg border p-2.5",
                selectedOutcome === on && "border-primary",
                issue && "border-destructive",
              )}
            >
              <div className="flex items-center gap-2 text-sm">
                <code className="w-20 shrink-0 text-xs">{on}</code>
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <select
                  aria-label={`${node.id} ${on} goes to`}
                  className={cn(selectClass, "min-w-0 flex-1")}
                  disabled={!editable || targets.length <= 1}
                  value={edge?.to ?? ""}
                  onChange={(event) =>
                    onChange(setRoute(workflow, node.id, on, event.target.value))
                  }
                >
                  {edge === undefined ? (
                    <option value="" disabled>
                      Choose…
                    </option>
                  ) : null}
                  {edge !== undefined && !targets.includes(edge.to) ? (
                    <option value={edge.to}>{edge.to} (invalid)</option>
                  ) : null}
                  {targets.map((target) => (
                    <option key={target} value={target}>
                      {target === "end"
                        ? "End run"
                        : `${PHASE_LABEL[workflow.nodes.find((item) => item.id === target)!.kind]} · ${target}`}
                    </option>
                  ))}
                </select>
              </div>
              {loop ? (
                <label className="flex items-center gap-2 pl-24 text-xs text-muted-foreground">
                  Retry budget
                  <select
                    aria-label={`${node.id} ${on} retry budget`}
                    className={cn(selectClass, "h-7 w-24")}
                    disabled={!editable}
                    value={edge.budget ?? ""}
                    onChange={(event) =>
                      onChange(
                        setRouteBudget(
                          workflow,
                          node.id,
                          on,
                          event.target.value === "" ? undefined : Number(event.target.value),
                        ),
                      )
                    }
                  >
                    <option value="">Not set</option>
                    {[
                      ...new Set([
                        ...BUDGET_OPTIONS,
                        ...(edge.budget === undefined ? [] : [edge.budget]),
                      ]),
                    ]
                      .sort((a, b) => a - b)
                      .map((value) => (
                        <option key={value} value={value}>
                          {value === 0 ? "0 (block at once)" : value}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              {issue ? (
                <p className="text-xs text-destructive-foreground">{issueText(issue)}</p>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          When a loop runs out of retries, the run stops and asks a human.
        </p>
      </div>
    </div>
  );
}

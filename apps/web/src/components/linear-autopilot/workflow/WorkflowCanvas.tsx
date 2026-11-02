import type { LinearAutopilotWorkflow } from "@t3tools/contracts";
import type {
  LinearAutopilotRoutableOutcome,
  LinearAutopilotWorkflowIssue,
} from "@t3tools/shared/linearAutopilotWorkflow";
import { AlertTriangleIcon, MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  autoLayout,
  issueForRoute,
  issuesForNode,
  outcomesOf,
  PHASE_LABEL,
  routeKey,
  routeTargets,
  type Point,
} from "./workflowEditor.logic";

export type WorkflowSelection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "route"; readonly from: string; readonly on: LinearAutopilotRoutableOutcome }
  | null;

const NODE_W = 176;
const HEADER_H = 50;
const PORT_H = 22;
const END_W = 72;
const END_H = 32;
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.6;
const FIT_PADDING = 48;

const nodeHeight = (outcomeCount: number) => HEADER_H + outcomeCount * PORT_H + 8;
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Zooms while keeping the world point under `anchor` fixed on screen. */
function zoomView(view: View, factor: number, anchor: Point): View {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

type Gesture =
  | { readonly kind: "pan"; readonly start: Point; readonly origin: View }
  | { readonly kind: "move"; readonly id: string; readonly grab: Point }
  | {
      readonly kind: "wire";
      readonly from: string;
      readonly on: LinearAutopilotRoutableOutcome;
      readonly at: Point;
    };

export function WorkflowCanvas({
  workflow,
  issues,
  readOnly,
  selection,
  onSelect,
  onRoute,
  onMove,
  personaLabel,
  activeNodeId = null,
  traversals,
}: {
  readonly workflow: LinearAutopilotWorkflow;
  readonly issues: readonly LinearAutopilotWorkflowIssue[];
  readonly readOnly: boolean;
  readonly selection: WorkflowSelection;
  readonly onSelect: (selection: WorkflowSelection) => void;
  readonly onRoute: (from: string, on: LinearAutopilotRoutableOutcome, to: string) => void;
  readonly onMove: (nodeId: string, position: Point) => void;
  readonly personaLabel: (nodeId: string) => string;
  /** Phase a run is on now, when the canvas shows a run instead of the draft. */
  readonly activeNodeId?: string | null;
  /** A run's loop counts keyed `from:on:to`, shown against each route's budget. */
  readonly traversals?: Readonly<Record<string, number>>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  // Position of the phase being dragged; committed to the workflow when the drag ends.
  const [dragged, setDragged] = useState<{ readonly id: string; readonly at: Point } | null>(null);
  const [view, setView] = useState<View>({ x: FIT_PADDING, y: FIT_PADDING, scale: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);

  const layout = {
    ...autoLayout(workflow, { columnWidth: NODE_W + 88, rowHeight: 150 }),
    ...workflow.layout,
    ...(dragged ? { [dragged.id]: dragged.at } : {}),
  };
  const posOf = (id: string): Point => layout[id] ?? { x: 0, y: 0 };
  const nodeById = (id: string) => workflow.nodes.find((node) => node.id === id);

  const bounds = () => {
    const ids = [...workflow.nodes.map((node) => node.id), "end"];
    const boxes = ids.map((id) => {
      const p = posOf(id);
      const node = nodeById(id);
      return {
        x: p.x,
        y: p.y,
        right: p.x + (node ? NODE_W : END_W),
        bottom: p.y + (node ? nodeHeight(outcomesOf(node.kind).length) : END_H) + 90,
      };
    });
    return {
      x: Math.min(...boxes.map((box) => box.x)),
      y: Math.min(...boxes.map((box) => box.y)),
      right: Math.max(...boxes.map((box) => box.right)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
  };

  const fit = () => {
    const element = viewport.current;
    if (!element) return;
    const box = bounds();
    const width = element.clientWidth - FIT_PADDING * 2;
    const height = element.clientHeight - FIT_PADDING * 2;
    const scale = clampScale(
      Math.min(1, width / (box.right - box.x), height / (box.bottom - box.y)),
    );
    setView({
      scale,
      x: FIT_PADDING + (width - (box.right - box.x) * scale) / 2 - box.x * scale,
      y: FIT_PADDING + (height - (box.bottom - box.y) * scale) / 2 - box.y * scale,
    });
  };

  // Fit once on mount; the parent remounts the canvas when it shows a different workflow.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the mounted viewport to fit the graph.
  useLayoutEffect(fit, []);

  const zoomAround = (factor: number, anchor: Point) =>
    setView((current) => zoomView(current, factor, anchor));

  // Wheel must be a non-passive native listener so scrolling pans the canvas, not the page.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches a non-passive native wheel listener.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setView((current) => zoomView(current, Math.exp(-event.deltaY * 0.01), anchor));
        return;
      }
      setView((current) => ({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const toWorld = (point: Point): Point => ({
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  });

  const portPoint = (nodeId: string, on: LinearAutopilotRoutableOutcome): Point => {
    const node = nodeById(nodeId)!;
    const p = posOf(nodeId);
    const index = outcomesOf(node.kind).indexOf(on);
    return { x: p.x + NODE_W, y: p.y + HEADER_H + index * PORT_H + PORT_H / 2 };
  };
  const inputPoint = (id: string): Point => {
    const p = posOf(id);
    return { x: p.x, y: p.y + (id === "end" ? END_H / 2 : HEADER_H / 2) };
  };
  const curve = (a: Point, b: Point, selfLoop: boolean) => {
    if (selfLoop) {
      return `M${a.x},${a.y} C${a.x + 60},${a.y + 70} ${b.x - 60},${b.y + 120} ${b.x},${b.y}`;
    }
    if (b.x > a.x + 24) {
      const bend = Math.max(36, (b.x - a.x) / 2);
      return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`;
    }
    const drop = Math.max(a.y, b.y) + 110;
    return `M${a.x},${a.y} C${a.x + 110},${drop} ${b.x - 110},${drop} ${b.x},${b.y}`;
  };
  const midpoint = (a: Point, b: Point, selfLoop: boolean): Point => {
    if (selfLoop) return { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + 70 };
    if (b.x > a.x + 24) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + 82 };
  };

  const wireTargets =
    gesture?.kind === "wire"
      ? new Set(routeTargets(workflow, nodeById(gesture.from)!.kind, gesture.on))
      : null;

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!gesture) return;
    const point = local(event);
    if (gesture.kind === "pan") {
      setView({
        ...gesture.origin,
        x: gesture.origin.x + point.x - gesture.start.x,
        y: gesture.origin.y + point.y - gesture.start.y,
      });
    } else if (gesture.kind === "move") {
      const world = toWorld(point);
      setDragged({
        id: gesture.id,
        at: { x: Math.round(world.x - gesture.grab.x), y: Math.round(world.y - gesture.grab.y) },
      });
    } else {
      setGesture({ ...gesture, at: toWorld(point) });
    }
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    if (gesture?.kind === "pan") {
      const point = local(event);
      const distance = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
      if (distance < 4) onSelect(null);
    }
    if (gesture?.kind === "wire") {
      const target = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-workflow-node]"))
        .find((element) => element !== null)?.dataset.workflowNode;
      if (target !== undefined && wireTargets?.has(target))
        onRoute(gesture.from, gesture.on, target);
    }
    if (gesture?.kind === "move" && dragged?.id === gesture.id) onMove(dragged.id, dragged.at);
    setDragged(null);
    setGesture(null);
  };
  const startMove = (id: string, event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (id !== "end") onSelect({ kind: "node", id });
    if (readOnly) return;
    const world = toWorld(local(event));
    const origin = posOf(id);
    setGesture({ kind: "move", id, grab: { x: world.x - origin.x, y: world.y - origin.y } });
  };

  const routes = workflow.edges.flatMap((edge) => {
    if (edge.on === "blocked" || !nodeById(edge.from)) return [];
    if (edge.to !== "end" && !nodeById(edge.to)) return [];
    const on = edge.on;
    const a = portPoint(edge.from, on);
    const b = inputPoint(edge.to);
    const selfLoop = edge.from === edge.to;
    return [{ edge, on, d: curve(a, b, selfLoop), label: midpoint(a, b, selfLoop) }];
  });

  return (
    <div
      ref={viewport}
      className={cn(
        "relative h-[30rem] touch-none overflow-hidden rounded-xl border bg-muted/20 select-none",
        gesture?.kind === "pan" ? "cursor-grabbing" : "cursor-grab",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        viewport.current?.setPointerCapture(event.pointerId);
        setGesture({ kind: "pan", start: local(event), origin: view });
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDragged(null);
        setGesture(null);
      }}
      onPointerLeave={() => {
        if (gesture?.kind === "pan") return;
        setDragged(null);
        setGesture(null);
      }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        <svg
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          width={1}
          height={1}
        >
          <defs>
            {(["muted", "selected", "error"] as const).map((tone) => (
              <marker
                key={tone}
                id={`workflow-arrow-${tone}`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path
                  d="M0,0 L8,4 L0,8 z"
                  className={
                    tone === "error"
                      ? "fill-destructive"
                      : tone === "selected"
                        ? "fill-primary"
                        : "fill-muted-foreground"
                  }
                />
              </marker>
            ))}
          </defs>
          {routes.map(({ edge, on, d }) => {
            const error = issueForRoute(issues, edge.from, on) !== undefined;
            const selected =
              selection?.kind === "route" && selection.from === edge.from && selection.on === on;
            const tone = error ? "error" : selected ? "selected" : "muted";
            return (
              <path
                key={routeKey(edge)}
                d={d}
                fill="none"
                strokeWidth={selected ? 2.25 : 1.5}
                strokeDasharray={edge.budget !== undefined ? "5 4" : undefined}
                className={
                  error
                    ? "stroke-destructive"
                    : selected
                      ? "stroke-primary"
                      : "stroke-muted-foreground/60"
                }
                markerEnd={`url(#workflow-arrow-${tone})`}
              />
            );
          })}
          {gesture?.kind === "wire" ? (
            <path
              d={curve(portPoint(gesture.from, gesture.on), gesture.at, false)}
              fill="none"
              strokeWidth={2}
              strokeDasharray="4 3"
              className="stroke-primary"
            />
          ) : null}
        </svg>

        {routes.map(({ edge, on, label }) => {
          const error = issueForRoute(issues, edge.from, on) !== undefined;
          const selected =
            selection?.kind === "route" && selection.from === edge.from && selection.on === on;
          return (
            <button
              key={routeKey(edge)}
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelect({ kind: "route", from: edge.from, on })}
              className={cn(
                "absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-2xs whitespace-nowrap",
                error
                  ? "border-destructive text-destructive-foreground"
                  : selected
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border",
              )}
              style={{ left: label.x, top: label.y }}
            >
              {error ? <AlertTriangleIcon className="size-3" aria-hidden /> : null}
              {on}
              {edge.budget === undefined
                ? ""
                : traversals === undefined
                  ? ` ×${edge.budget}`
                  : ` ${traversals[`${edge.from}:${on}:${edge.to}`] ?? 0}/${edge.budget}`}
            </button>
          );
        })}

        {workflow.nodes.map((node) => {
          const p = posOf(node.id);
          const outcomes = outcomesOf(node.kind);
          const nodeIssues = issuesForNode(issues, node.id);
          const selected = selection?.kind === "node" && selection.id === node.id;
          const droppable = wireTargets?.has(node.id) ?? false;
          return (
            <div
              key={node.id}
              data-workflow-node={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${PHASE_LABEL[node.kind]} phase ${node.id}`}
              aria-pressed={selected}
              onPointerDown={(event) => startMove(node.id, event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect({ kind: "node", id: node.id });
                }
              }}
              className={cn(
                "absolute z-20 rounded-xl border bg-card text-left shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                !readOnly && "cursor-move",
                selected && "border-primary ring-1 ring-primary",
                activeNodeId === node.id && "border-info ring-2 ring-info/50",
                nodeIssues.length > 0 && !selected && "border-destructive",
                droppable && "ring-2 ring-primary/50",
                wireTargets !== null &&
                  !droppable &&
                  gesture?.kind === "wire" &&
                  gesture.from !== node.id &&
                  "opacity-50",
              )}
              style={{ left: p.x, top: p.y, width: NODE_W, height: nodeHeight(outcomes.length) }}
            >
              <div className="flex items-start gap-2 px-3 pt-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {PHASE_LABEL[node.kind]}
                    {node.id !== node.kind ? (
                      <span className="font-normal text-muted-foreground"> · {node.id}</span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {personaLabel(node.id)}
                  </div>
                </div>
                {activeNodeId === node.id ? (
                  <span className="rounded bg-info/16 px-1 text-3xs text-info-foreground">now</span>
                ) : null}
                {workflow.entry === node.id ? (
                  <span className="rounded bg-muted px-1 text-3xs text-muted-foreground">
                    start
                  </span>
                ) : null}
                {nodeIssues.length > 0 ? (
                  <AlertTriangleIcon
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label="Has issues"
                  />
                ) : null}
              </div>
              <div className="mt-1.5">
                {outcomes.map((on) => {
                  const routed = workflow.edges.some(
                    (edge) => edge.from === node.id && edge.on === on,
                  );
                  return (
                    <div
                      key={on}
                      className="relative flex items-center justify-end pr-4 text-2xs text-muted-foreground"
                      style={{ height: PORT_H }}
                    >
                      {on}
                      <span
                        aria-label={readOnly ? undefined : `Drag to route ${node.id} ${on}`}
                        onPointerDown={(event) => {
                          if (readOnly || event.button !== 0) return;
                          event.stopPropagation();
                          setGesture({
                            kind: "wire",
                            from: node.id,
                            on,
                            at: toWorld(local(event)),
                          });
                        }}
                        className={cn(
                          "absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 rounded-full border-2 bg-background",
                          routed ? "border-primary" : "border-destructive",
                          !readOnly && "cursor-crosshair",
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div
          data-workflow-node="end"
          onPointerDown={(event) => startMove("end", event)}
          className={cn(
            "absolute z-20 flex items-center justify-center rounded-full border bg-muted text-xs font-medium text-muted-foreground",
            !readOnly && "cursor-move",
            wireTargets?.has("end") && "ring-2 ring-primary/50",
            activeNodeId === "end" && "border-info ring-2 ring-info/50",
          )}
          style={{ left: posOf("end").x, top: posOf("end").y, width: END_W, height: END_H }}
        >
          End
        </div>
      </div>

      <div
        className="absolute right-3 bottom-3 z-30 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-sm"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() =>
            zoomAround(1 / 1.2, {
              x: viewport.current!.clientWidth / 2,
              y: viewport.current!.clientHeight / 2,
            })
          }
        >
          <MinusIcon />
        </Button>
        <span className="w-10 text-center text-xs text-muted-foreground tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          onClick={() =>
            zoomAround(1.2, {
              x: viewport.current!.clientWidth / 2,
              y: viewport.current!.clientHeight / 2,
            })
          }
        >
          <PlusIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Fit to view" onClick={fit}>
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  );
}

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { LinearAutopilotCatalog } from "@t3tools/contracts";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT = "30 seconds";

export const LinearAutopilotIssue = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  identifier: Schema.String.check(Schema.isMaxLength(64)),
  title: Schema.String.check(Schema.isMaxLength(500)),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_000))),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  updatedAt: Schema.DateTimeUtcFromString,
  team: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(128)) }),
  state: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(128)) }),
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(128)) })).check(
      Schema.isMaxLength(100),
    ),
  }),
  project: Schema.NullOr(Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(128)) })),
});
export type LinearAutopilotIssue = typeof LinearAutopilotIssue.Type;

const IssuePage = Schema.Struct({
  nodes: Schema.Array(LinearAutopilotIssue).check(Schema.isMaxLength(PAGE_SIZE)),
  pageInfo: Schema.Struct({
    endCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
    hasNextPage: Schema.Boolean,
  }),
});

const GraphqlResponse = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        issues: Schema.optional(IssuePage),
        teams: Schema.optional(
          Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                id: Schema.String.check(Schema.isMaxLength(128)),
                name: Schema.String.check(Schema.isMaxLength(256)),
                key: Schema.String.check(Schema.isMaxLength(64)),
                states: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({
                      id: Schema.String.check(Schema.isMaxLength(128)),
                      name: Schema.String.check(Schema.isMaxLength(256)),
                      type: Schema.String.check(Schema.isMaxLength(32)),
                    }),
                  ).check(Schema.isMaxLength(100)),
                }),
                labels: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({
                      id: Schema.String.check(Schema.isMaxLength(128)),
                      name: Schema.String.check(Schema.isMaxLength(256)),
                    }),
                  ).check(Schema.isMaxLength(100)),
                }),
                projects: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({
                      id: Schema.String.check(Schema.isMaxLength(128)),
                      name: Schema.String.check(Schema.isMaxLength(256)),
                    }),
                  ).check(Schema.isMaxLength(100)),
                }),
              }),
            ).check(Schema.isMaxLength(100)),
          }),
        ),
        issueUpdate: Schema.optional(
          Schema.Struct({
            success: Schema.Boolean,
            issue: Schema.NullOr(
              Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(128)) }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String.check(Schema.isMaxLength(512)) })).check(
      Schema.isMaxLength(20),
    ),
  ),
});

export interface LinearAutopilotIssuePage {
  readonly issues: ReadonlyArray<LinearAutopilotIssue>;
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

export class LinearAutopilotClientError extends Schema.TaggedError<LinearAutopilotClientError>()(
  "LinearAutopilotClientError",
  {
    reason: Schema.Literals(["request", "http", "decode", "graphql", "missing-data"]),
    status: Schema.optional(Schema.Int),
    errorCount: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    return `Linear intake request failed (${this.reason}${this.status === undefined ? "" : `, HTTP ${this.status}`}).`;
  }
}

export class LinearAutopilotClient extends Context.Service<
  LinearAutopilotClient,
  {
    /** Performs a read-only, bounded team issue query. The bearer token is never returned or logged. */
    readonly listIssues: (input: {
      readonly accessToken: string;
      readonly teamId: string;
      readonly updatedSince: string;
      readonly after?: string | null;
    }) => Effect.Effect<LinearAutopilotIssuePage, LinearAutopilotClientError>;
    readonly listCatalog: (input: {
      readonly accessToken: string;
    }) => Effect.Effect<LinearAutopilotCatalog, LinearAutopilotClientError>;
    /** Moves one configured issue to a configured state; callers choose the state ID. */
    readonly updateIssueState: (input: {
      readonly accessToken: string;
      readonly issueId: string;
      readonly stateId: string;
    }) => Effect.Effect<void, LinearAutopilotClientError>;
  }
>()("t3/linear/LinearAutopilotClient") {}

const issueQuery = `query LinearAutopilotIntakeIssues($teamId: ID!, $updatedSince: DateTime!, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: { team: { id: { eq: $teamId } }, updatedAt: { gte: $updatedSince } }, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      description
      url
      updatedAt
      team { id }
      state { id }
      labels(first: 100) { nodes { id } }
      project { id }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

const catalogQuery = `query LinearAutopilotSettingsCatalog {
  teams(first: 100) {
    nodes {
      id name key
      states(first: 100) { nodes { id name type } }
      labels(first: 100) { nodes { id name } }
      projects(first: 100) { nodes { id name } }
    }
  }
}`;

const updateIssueStateMutation = `mutation LinearAutopilotUpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id }
  }
}`;

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const listIssues: LinearAutopilotClient["Service"]["listIssues"] = (input) =>
    HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyJson({
        query: issueQuery,
        variables: {
          teamId: input.teamId,
          updatedSince: input.updatedSince,
          after: input.after ?? null,
        },
      }),
      Effect.mapError(() => new LinearAutopilotClientError({ reason: "request" })),
      Effect.flatMap(httpClient.execute),
      Effect.mapError(() => new LinearAutopilotClientError({ reason: "request" })),
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          "2xx": (response) =>
            HttpClientResponse.schemaBodyJson(GraphqlResponse)(response).pipe(
              Effect.mapError(() => new LinearAutopilotClientError({ reason: "decode" })),
            ),
          orElse: (response) =>
            Effect.fail(
              new LinearAutopilotClientError({ reason: "http", status: response.status }),
            ),
        }),
      ),
      Effect.flatMap((response) => {
        if (response.errors && response.errors.length > 0) {
          return Effect.fail(
            new LinearAutopilotClientError({
              reason: "graphql",
              errorCount: response.errors.length,
            }),
          );
        }
        const issues = response.data?.issues;
        if (issues === undefined) {
          return Effect.fail(new LinearAutopilotClientError({ reason: "missing-data" }));
        }
        return Effect.succeed({
          issues: issues.nodes,
          endCursor: issues.pageInfo.endCursor,
          hasNextPage: issues.pageInfo.hasNextPage,
        });
      }),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new LinearAutopilotClientError({ reason: "request" })),
      }),
      Effect.withSpan("LinearAutopilotClient.listIssues", {
        attributes: { pageSize: PAGE_SIZE },
      }),
    );

  const listCatalog: LinearAutopilotClient["Service"]["listCatalog"] = ({ accessToken }) =>
    HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.bodyJson({ query: catalogQuery }),
      Effect.mapError(() => new LinearAutopilotClientError({ reason: "request" })),
      Effect.flatMap(httpClient.execute),
      Effect.mapError(() => new LinearAutopilotClientError({ reason: "request" })),
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          "2xx": (response) =>
            HttpClientResponse.schemaBodyJson(GraphqlResponse)(response).pipe(
              Effect.mapError(() => new LinearAutopilotClientError({ reason: "decode" })),
            ),
          orElse: (response) =>
            Effect.fail(
              new LinearAutopilotClientError({ reason: "http", status: response.status }),
            ),
        }),
      ),
      Effect.flatMap((response) => {
        if (response.errors && response.errors.length > 0) {
          return Effect.fail(
            new LinearAutopilotClientError({
              reason: "graphql",
              errorCount: response.errors.length,
            }),
          );
        }
        const teams = response.data?.teams?.nodes;
        if (!teams) return Effect.fail(new LinearAutopilotClientError({ reason: "missing-data" }));
        return Effect.succeed({
          teams: teams.map((team) => ({
            id: team.id,
            name: team.name,
            key: team.key,
            states: team.states.nodes,
            labels: team.labels.nodes,
            projects: team.projects.nodes,
          })),
        });
      }),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new LinearAutopilotClientError({ reason: "request" })),
      }),
      Effect.withSpan("LinearAutopilotClient.listCatalog"),
    );

  const updateIssueState: LinearAutopilotClient["Service"]["updateIssueState"] = (input) =>
    HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyJson({
        query: updateIssueStateMutation,
        variables: { issueId: input.issueId, stateId: input.stateId },
      }),
      Effect.mapError(() => new LinearAutopilotClientError({ reason: "request" })),
      Effect.flatMap(httpClient.execute),
      Effect.mapError(() => new LinearAutopilotClientError({ reason: "request" })),
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          "2xx": (response) =>
            HttpClientResponse.schemaBodyJson(GraphqlResponse)(response).pipe(
              Effect.mapError(() => new LinearAutopilotClientError({ reason: "decode" })),
            ),
          orElse: (response) =>
            Effect.fail(
              new LinearAutopilotClientError({ reason: "http", status: response.status }),
            ),
        }),
      ),
      Effect.flatMap((response) => {
        if (response.errors && response.errors.length > 0) {
          return Effect.fail(
            new LinearAutopilotClientError({
              reason: "graphql",
              errorCount: response.errors.length,
            }),
          );
        }
        const result = response.data?.issueUpdate;
        if (result?.success === true && result.issue?.id === input.issueId) return Effect.void;
        return Effect.fail(new LinearAutopilotClientError({ reason: "missing-data" }));
      }),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new LinearAutopilotClientError({ reason: "request" })),
      }),
      Effect.withSpan("LinearAutopilotClient.updateIssueState"),
    );

  return LinearAutopilotClient.of({ listIssues, listCatalog, updateIssueState });
});

export const layer = Layer.effect(LinearAutopilotClient, make);

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT = "30 seconds";

export const LinearAutopilotIssue = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  identifier: Schema.String.check(Schema.isMaxLength(64)),
  title: Schema.String.check(Schema.isMaxLength(500)),
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
  data: Schema.optional(Schema.NullOr(Schema.Struct({ issues: IssuePage }))),
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
      readonly after?: string | null;
    }) => Effect.Effect<LinearAutopilotIssuePage, LinearAutopilotClientError>;
  }
>()("t3/linear/LinearAutopilotClient") {}

const issueQuery = `query LinearAutopilotIntakeIssues($teamId: ID!, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: { team: { id: { eq: $teamId } } }) {
    nodes {
      id
      identifier
      title
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

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const listIssues: LinearAutopilotClient["Service"]["listIssues"] = (input) =>
    HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyJson({
        query: issueQuery,
        variables: { teamId: input.teamId, after: input.after ?? null },
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
        if (response.data === undefined || response.data === null) {
          return Effect.fail(new LinearAutopilotClientError({ reason: "missing-data" }));
        }
        return Effect.succeed({
          issues: response.data.issues.nodes,
          endCursor: response.data.issues.pageInfo.endCursor,
          hasNextPage: response.data.issues.pageInfo.hasNextPage,
        });
      }),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new LinearAutopilotClientError({ reason: "request" })),
      ),
      Effect.withSpan("LinearAutopilotClient.listIssues", {
        attributes: { pageSize: PAGE_SIZE },
      }),
    );

  return LinearAutopilotClient.of({ listIssues });
});

export const layer = Layer.effect(LinearAutopilotClient, make);

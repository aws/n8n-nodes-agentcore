# Specification — @aws/n8n-nodes-agentcore

|                         |                                            |
|-------------------------|--------------------------------------------|
|**Status**               |v0.2 — pre-release, in private testing      |
|**Owner**                |Amazon Bedrock AgentCore team               |
|**Distribution**         |npm community node + AWS public GitHub org  |
|**License**              |Apache-2.0                                  |
|**Audience for this doc**|Engineers, PMs, partners, security reviewers|

-----

## 1. Overview

`@aws/n8n-nodes-agentcore` is an n8n community node that integrates Amazon Bedrock AgentCore harness into n8n workflows. It lets workflow developers run production-grade AI agents — with cross-session memory, real cloud browser, real microVM code execution, multi-provider model choice, skills, and long-running sessions — without writing infrastructure code or agent code.

The node auto-provisions a harness on first execution, reuses it on subsequent runs, and updates it when configuration drifts. AWS credentials are read from n8n’s encrypted credential vault per execution, never persisted. All risky execution (model inference, browser, code interpreter) happens inside AWS-managed Firecracker microVMs, not inside the n8n process.

## 2. Goals and non-goals

### In scope (v0.2 — current)

- One n8n node (`AgentCoreHarness`) with a single operation; the Harness ARN field selects between auto-provision and bring-your-own-ARN behavior
- One credential type (`AgentCoreApi`) reusing n8n’s standard AWS credential pattern, extended with optional VPC network config
- Inline tool configuration for AgentCore-native tools: Browser, Code Interpreter, Gateway (with optional OAuth outbound auth), remote MCP, **Web Search**, and **inline functions**
- **Multi-provider models** — Amazon Bedrock (native + Mantle), OpenAI, Google Gemini, LiteLLM — switchable per invocation
- **Managed memory auto-provisioning** (strategies + event expiry), with BYO-Memory-ARN and Disabled modes
- **Skills** from the AWS curated catalog, Git, S3, and filesystem paths
- **VPC networking, custom container images, and filesystem mounts** (session storage / EFS / S3 Files)
- **OAuth Bearer-token invoke** via a raw-HTTPS path (the AWS SDK cannot Bearer-auth InvokeHarness)
- **Harness versioning and named endpoints** (list versions, create/pin endpoints, invoke by qualifier)
- Streaming response handling with structured output (text, tool-use trace incl. parsed inline-function input, usage, latency) plus a provisioning summary (memory ARN, model, version)
- Auto-provisioned harness lifecycle with workflow-static-data caching, AWS-as-source-of-truth on cache miss
- BYO-ARN escape hatch for harnesses created outside n8n
- Importable example workflows (8) covering the major features

### Delivered in v0.1

- Single operation (auto-provision or BYO-ARN), MCP/Browser/Code Interpreter/Gateway tools, streaming, sessions, BYO Memory ARN

### Out of scope for v0.2, deferred to later versions

- Shell `ExecuteCommand` / `InvokeAgentRuntimeCommand` (root shell in the microVM, not scoped by `allowedTools`) — deliberately not exposed for security
- One-click CloudFormation execution-role provisioning
- Custom Browser / Code Interpreter resource ARNs (built-in only today)
- Export to Code (Strands), Step Functions integration, Trigger node, Evaluations integration

### Explicit non-goals

- This package does **not** wrap AgentCore Runtime (the container-hosting primitive). It targets AgentCore harness, the declarative-spec primitive.
- This package does **not** ship a separate harness consumer SDK. Harness consumer logic lives inside this node and may later land in `bedrock-agentcore` SDK as a subpath export.
- This package does **not** abstract away AWS account setup. n8n users need an AWS account, IAM credentials, and an execution role — same prerequisite as any AWS node in n8n.

## 3. Target users

Three audiences, in priority order:

1. **No-code automators** — marketing ops, support, founders. They configure the node by filling in fields. Never see AWS unless they want to.
1. **Developer-leaning n8n users** — small engineering teams self-hosting n8n. Use the BYO-ARN mode for harnesses they manage outside n8n. Want Git-friendly workflows.
1. **Enterprise teams** (anchor pattern: Swisscom on EKS) — n8n in their own AWS account, harness in their VPC. Real data-residency story.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  n8n Server (Node.js)                                           │
│                                                                 │
│   ┌─────────────────────────┐    ┌────────────────────────┐     │
│   │ AgentCoreHarness node   │◀───│ n8n credential vault   │     │
│   │                         │    │ (encrypted SQLite)     │     │
│   │  - resolves harness     │    └────────────────────────┘     │
│   │  - calls AWS SDK v3     │                                   │
│   │  - streams response     │                                   │
│   └────────────┬────────────┘                                   │
│                │                                                │
└────────────────┼────────────────────────────────────────────────┘
                 │ HTTPS + SigV4
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  AWS                                                            │
│  ┌──────────────────────┐    ┌──────────────────────────────┐   │
│  │ AgentCore Control    │    │ AgentCore Data plane         │   │
│  │ - CreateHarness      │    │ - InvokeHarness (streaming)  │   │
│  │ - UpdateHarness      │    └──────────────┬───────────────┘   │
│  │ - GetHarness         │                   │                   │
│  │ - ListHarnesses      │                   ▼                   │
│  │ - DeleteHarness      │     ┌─────────────────────────────┐   │
│  └──────────┬───────────┘     │  Harness microVM            │   │
│             │                 │  (Firecracker, isolated)    │   │
│             │ assumes         │                             │   │
│             ▼                 │  - Bedrock model inference  │   │
│  ┌──────────────────────┐     │  - Browser tool             │   │
│  │ Harness Execution    │     │  - Code Interpreter         │   │
│  │ Role (customer's)    │────▶│  - Gateway / MCP            │   │
│  └──────────────────────┘     └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Trust boundaries

1. n8n process ↔ credential vault — same process, OS-level isolation
1. n8n process ↔ AWS API — HTTPS + SigV4 signing
1. AWS IAM authorizes calls before AgentCore receives them
1. AgentCore assumes the execution role to act on customer’s behalf
1. Harness microVM is isolated from both n8n and AWS control plane

## 5. Components

### Node — `AgentCoreHarness`

A single operation. The **Harness ARN** field is the mode discriminator: blank → auto-provision and reuse (primary path); populated → invoke an externally-created harness directly.

|Field               |Type      |Required      |Visibility|Description                                                                                                    |
|--------------------|----------|--------------|----------|---------------------------------------------------------------------------------------------------------------|
|Harness ARN         |string    |no            |always    |Blank = Run Agent (auto-provision). Populated = invoke this harness directly.                                  |
|Agent Name          |string    |yes (run mode)|ARN blank |Logical name. Letters, numbers, underscores, max 40 chars. Cache key — one name = one harness.                 |
|Model Provider      |options   |no            |always    |Bedrock / OpenAI / Gemini / LiteLLM. Selects the model union member. Switchable per invocation.                |
|Model ID            |string    |no            |always    |Provider-specific model ID. Run mode: defaults to Claude Sonnet 4.6 on Bedrock if blank. Invoke mode: override.|
|Model Options       |collection|no            |always    |API Key ARN, API Base URL, API Format, temperature, topP/K, model max tokens, additionalParams (JSON).         |
|System Prompt       |string    |no            |always    |Agent instructions. Run mode: defaults if blank. Invoke mode: override if set.                                 |
|Prompt              |string    |no            |always    |User message (n8n expressions supported). Optional only when sending Tool Results back.                        |
|Tools               |collection|no            |always    |Browser, Code Interpreter, Gateway (+OAuth), remote MCP, Web Search, inline functions. Invoke mode: override.  |
|Skills              |collection|no            |always    |AWS catalog (globs) / Git / S3 / filesystem path. Run mode: baked in. Invoke mode: appended (invoke wins).     |
|Session ID          |string    |no            |always    |For multi-turn continuity. Auto-generated (random UUID) when blank; stable value continues a conversation.     |
|Authentication      |options   |no            |always    |AWS SigV4 (default) or OAuth Bearer Token. OAuth uses the raw-HTTPS invoke path.                                |
|Bearer Token        |string    |yes (OAuth)   |OAuth     |JWT for the OAuth invoke path; operation-level so it can be bound to an upstream node via expression.           |
|Additional Options  |collection|no            |always    |Actor ID, Endpoint (Qualifier), Max Iterations, Max Tokens, Timeout, Runtime User ID. Invoke mode: overrides.  |
|Tool Results        |collection|no            |always    |Inline-function round-trip: Tool Use ID, name, input, result content, status — replays assistant+user turn.    |
|Provisioning Options|collection|no            |ARN blank |Memory Mode/Strategies/Expiry, Memory ARN (BYO), Container URI, Filesystem Mounts, List Versions, Endpoint Name/Target Version/Description, Force Recreate — lifecycle-only, hidden in invoke mode.|

**Mode resolution:** at execution the node reads Harness ARN. If non-empty (after trim) it validates the ARN and calls `InvokeHarness` directly, applying any filled config field as a per-invocation override. If empty it runs the auto-provision lifecycle below.

**Run Agent lifecycle (ARN blank):**

1. Compute config hash from current field values (model union, system prompt, tools, skills, memory, environment, container, limits)
2. Look up existing harness in workflow static data
3. If absent, query AWS via `ListHarnesses` to find one matching the agent name (handles workflow imports, n8n restarts, lost local state)
4. If found: reuse if config hash matches; `UpdateHarness` if hash differs (each update mints a new immutable harness version)
5. If not found: `CreateHarness`, poll `GetHarness` until READY (~30s)
6. Optionally manage versions/endpoints (list versions, create/pin a named endpoint)
7. `GetHarness` to summarize what was provisioned (memory ARN, model, version) for the output
8. `InvokeHarness` (SigV4 SDK path) or raw-HTTPS Bearer path, streaming, accumulate response

### Credential — `AgentCoreApi`

|Field                 |Required|Notes                                                       |
|----------------------|--------|------------------------------------------------------------|
|Access Key ID         |yes     |IAM caller principal with the harness caller actions attached|
|Secret Access Key     |yes     |Stored encrypted in n8n credential vault                    |
|Session Token         |no      |For STS temporary credentials                               |
|Region                |yes     |AgentCore-supported AWS region                              |
|Execution Role ARN    |yes     |The role AgentCore assumes at runtime — non-secret          |
|Network Mode          |no      |Public (default) or VPC — applies to auto-provisioned harnesses|
|VPC Subnet IDs        |no (VPC)|Comma-separated; VPC mode only                              |
|VPC Security Group IDs|no (VPC)|Comma-separated; VPC mode only                              |

## 6. Output shape

```json
{
  "operation": "run",
  "agentName": "research_agent",
  "harnessId": "research_agent-a1b2c3d4e5",
  "harnessArn": "arn:aws:bedrock-agentcore:us-west-2:...",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "sessionSource": "generated",
  "actorId": "user-123",
  "harness": {
    "status": "READY",
    "version": "2",
    "memory": { "mode": "managed", "arn": "arn:aws:...:memory/harness_...", "strategies": ["SEMANTIC","SUMMARIZATION"], "eventExpiryDuration": 30 },
    "model": { "provider": "bedrock", "modelId": "global.anthropic.claude-sonnet-4-6", "apiFormat": "converse_stream" },
    "networkMode": "PUBLIC",
    "toolCount": 1,
    "skillCount": 0
  },
  "response": "Final accumulated text from the agent",
  "stopReason": "end_turn",
  "toolUses": [{ "name": "browser", "toolUseId": "...", "input": {} }],
  "usage": { "inputTokens": 234, "outputTokens": 567 },
  "latencyMs": 4123
}
```

`sessionSource` is `generated` (Session ID left blank → new conversation) or
`provided` (stable Session ID → continues). `harness` is a best-effort summary
read back via `GetHarness`; `versions` / `endpoint` / `endpoints` also appear when
those provisioning actions are enabled. In `invokeExisting` mode the output omits
the run-only fields (agentName, harnessId) but still includes `harness`.

## 7. Session ID handling

The session ID is the conversation-continuity key: reuse the same value across
executions to continue a conversation; a new value starts a fresh one.

- Empty input → random UUID (`sessionSource: "generated"`) — a NEW conversation each run
- Non-empty, valid chars, ≥ 33 chars → used as-is, capped at 128
- Non-empty, valid chars, < 33 chars → extended deterministically by appending an SHA-256 of the **original input** (same logical input → same session ID across executions)
- Non-empty with invalid chars → sanitized prefix + SHA-256 of the **original input** (hashing the original, not the sanitized value, prevents two different inputs that sanitize identically from colliding into one shared session — v0.1 security Finding #4)
- Sanitization replaces characters outside `[A-Za-z0-9_-]` with `_`

Memory recall is scoped by `sessionId` (short-term/continuity) and additionally by
`actorId` when provided (per-actor isolation for long-term memory). Memory Mode
governs whether anything is persisted at all.

## 8. IAM model

Two AWS principals, two policies. The most common confusion point for reviewers — keep them mentally separate.

**Source of truth.** AWS maintains the canonical, least-privilege harness IAM
policies in the [AgentCore harness security guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html).
This repo ships only `docs/iam-trust-policy.json`; permission policies are
documented as least-privilege guidance in `README.md` pointing at that guide,
rather than shipping copy-paste reference policies (per the v0.1 AppSec review).
Grant only the statements for features actually used.

### Principal A — IAM caller (calls AgentCore from n8n)

Attached to the IAM user/role whose access key/secret are stored in the n8n credential.

Base actions: `bedrock-agentcore:` CreateHarness, GetHarness, UpdateHarness, ListHarnesses, DeleteHarness, InvokeHarness, plus the paired runtime actions (CreateAgentRuntime, UpdateAgentRuntime, DeleteAgentRuntime, InvokeAgentRuntime) — harness APIs authorize against both the harness resource and the underlying AgentCore Runtime resource. v0.2 adds, per the callers table: `CreateMemory`/`UpdateMemory`/`DeleteMemory` (managed memory is the default), `ListHarnessVersions`, the `*HarnessEndpoint` actions, and the paired `*AgentRuntimeEndpoint` actions. All actions except ListHarnesses are scoped to `arn:aws:bedrock-agentcore:<region>:<account>:harness/*` (Runtime/Memory companions use `…:<account>:*` since those ARNs are service-generated); ListHarnesses requires `Resource: "*"`.

`iam:PassRole` is not required: the execution role ARN is passed to CreateHarness as a parameter and assumed by the AgentCore service, not passed by the caller.

### Principal B — Harness execution role (assumed by AgentCore at runtime)

Attached to a separate IAM role whose trust policy permits only `bedrock-agentcore.amazonaws.com` to assume it, with conditions on `aws:SourceAccount` and `aws:SourceArn` to prevent confused-deputy attacks.

Base permissions (the AWS guide's sample policy): `bedrock:InvokeModel(WithResponseStream)`, `ecr-public:GetAuthorizationToken` + `sts:GetServiceBearerToken` (default container pull), `xray:*` trace APIs, `logs:*` scoped to `/aws/bedrock-agentcore/runtimes/*`, `cloudwatch:PutMetricData` (namespace-conditioned), `GetWorkloadAccessToken(ForJWT)`, and the built-in Browser / Code Interpreter session actions scoped to `…:<region>:aws:browser/*` and `…:code-interpreter/*`.

v0.2 optional add-ons, each scoped to the specific resource and added only when the feature is used (mapped to the AWS guide's "Additional permissions for optional features" plus two additions the guide references in prose but does not ship as canned JSON):

- **Managed/BYO Memory** — `CreateEvent`/`GetEvent`/`ListEvents`/`DeleteEvent`/`RetrieveMemoryRecords` scoped to `memory/*`
- **OpenAI/Gemini/LiteLLM models, MCP credential refs** — `GetResourceApiKey` + `secretsmanager:GetSecretValue` on `…identity!default/apikey/…`
- **OpenAI via Bedrock Mantle (no key)** — `bedrock-mantle:CreateInference` scoped to `project/default` *(addition — separate IAM namespace, not in the canned sample)*
- **Gateway tool** — `InvokeGateway` on the gateway ARN; OAuth gateways also `GetResourceOauth2Token` + the secret
- **S3 skills / S3 Files** — `s3:GetObject`/`s3:ListBucket` on the bucket; private Git skills use an API key credential provider
- **Custom container** — `ecr:GetDownloadUrlForLayer`/`ecr:BatchGetImage` scoped to the repo ARN, plus `ecr:GetAuthorizationToken` on `*` (the only action that can't be resource-scoped)
- **EFS mount** — `elasticfilesystem:ClientMount`/`ClientWrite` scoped to the access-point ARN (`ClientRootAccess` deliberately omitted) *(addition — EFS mounts are GA but not in the canned sample)*

Because the node auto-provisions resources whose names it can't know in advance (managed-memory id, harness suffix), the documented defaults use resource-type wildcards within the account+region (`memory/*`, `gateway/*`, `harness_*`) rather than `Resource: "*"`; the README directs users to tighten these to exact ARNs for production.

## 9. Security properties

- **No local execution.** Zero `exec` / `spawn` / `eval` / file-system writes in the codebase (CI-enforced by the `no-eval` grep gate)
- **Credentials never persisted by the node.** Read from n8n vault per execution, used by AWS SDK, released. The OAuth Bearer token is read per-execution from a node field, never logged
- **TLS 1.2+ enforced** for all AWS communications (AWS SDK v3 default); the OAuth raw-HTTPS path uses the platform `fetch` over TLS
- **SigV4 request signing** for the SDK path; OAuth path uses a caller-supplied JWT to the documented data-plane endpoint
- **Two production dependencies** — only `@aws-sdk/client-bedrock-agentcore` and `@aws-sdk/client-bedrock-agentcore-control`, both Apache-2.0, AWS-maintained. v0.2 added no new production dependency: the OAuth event-stream decode reuses `@smithy/core/event-streams`, already transitive via the data-plane client
- **TypeScript strict mode** enforced
- **Confused-deputy mitigation** via `aws:SourceAccount` + `aws:SourceArn` conditions in trust policy
- **Shared-responsibility passthrough.** Per the AgentCore security model, `additionalParams`/`apiBase`/`modelId` and the `skills` field are caller-controllable and can redirect inference or load arbitrary instructions. The node does not sanitize them (consistent with the service trust model); workflow authors exposing the node to untrusted callers must validate these — documented in README and the migration notes

## 10. Dependencies

### Runtime

- `@aws-sdk/client-bedrock-agentcore` (^3.1071.0)
- `@aws-sdk/client-bedrock-agentcore-control` (^3.1071.0)

  v0.2 bumped these from the 3.1058.x line, which predated the GA harness
  endpoint/version commands, managed-memory union member, and AWS skills (and,
  being a schema-serde SDK, silently dropped unknown union members). The OAuth
  path's event-stream codec comes from `@smithy/core/event-streams`, a transitive
  dependency of the data-plane client — no new direct dependency.

### Peer

- `n8n-workflow` — supplied by n8n at runtime, not bundled

### Build / dev only

TypeScript, eslint with `eslint-plugin-n8n-nodes-base`, prettier, gulp (for icon copying)

## 11. Build & publish

- Source: TypeScript compiled to ES2019 CommonJS via `tsc -p tsconfig.build.json`
- Icons: SVG copied via gulp into `dist/`
- Output: `dist/` directory containing JS, type definitions, and icon
- npm package metadata in `package.json` `n8n` field points to compiled paths
- Distribution: published to public npm as `@aws/n8n-nodes-agentcore` (scoped, public access); n8n’s GUI installer downloads via npm
- Provenance: GitHub Actions OIDC trusted publishing with automatic npm provenance attestation
- 2FA enforced on maintainer npm accounts

## 12. Testing

### Local development

Local-only testing uses Verdaccio (private npm registry in Docker): build, `npm
publish` to a local Verdaccio, install into `~/.n8n/nodes`, then restart n8n and
verify in a fresh browser session. Detailed per-feature test matrices and the
AWS setup runbook are maintained by the team outside the published package.

### Smoke tests (manual, per release)

1. Create credential, save successfully (Test → "Connection successful")
2. Blank Harness ARN — completes, returns response, harness `READY`, output shows `harness.memory.mode: managed`
3. Re-run same workflow — fast reuse, same harness ID
4. Modify system prompt/model/tools — `UpdateHarness`, new version, response reflects update
5. Multi-turn with a stable session ID — second turn recalls the first (`sessionSource: provided`, higher inputTokens)
6. Tools: MCP, Code Interpreter, Browser, Web Search — agent uses the tool
7. Multi-provider: OpenAI/Gemini/LiteLLM, and a mid-session provider switch
8. Inline function — `stopReason: tool_use` then Tool Results round-trip
9. Skills (AWS catalog / Git / S3), VPC harness, custom container, filesystem mount
10. Versions + named endpoint pin; invoke by qualifier
11. OAuth Bearer invoke success; SigV4 against an OAuth-only harness fails (401)
12. Populated Harness ARN — invokes without auto-provision; filled fields are per-invocation overrides
13. Force Recreate — deletes and recreates (managed memory disassociated, not deleted)

### Automated tests

Offline verification for v0.2 validated every payload builder against the
installed SDK type defs and exercised the full `execute()` path with mocked
clients. Jest unit tests and CI integration tests against real AgentCore remain
planned.

## 13. Versioning and compatibility

Semantic versioning. v0.x is pre-1.0; minor versions may add fields but will not break existing workflow configurations. Breaking changes (if any) ship in major version bumps with a documented migration path.

v0.2 is additive over v0.1. Behavior changes for v0.1 users are limited (see the
migration note in `README.md`): memory now defaults to Managed (a populated
Memory ARN is still honored as BYO; set Disabled for the old no-memory behavior);
Force Recreate disassociates rather than deletes managed memory; the run-mode
default model is Claude Sonnet 4.6.

## 14. Open questions

- **Resource-ARN tightening for production** — the documented IAM defaults use resource-type wildcards (`memory/*`, `gateway/*`, `harness_*`) because the node auto-provisions resources with service-generated names. Production deployments should tighten to exact ARNs; AppSec to confirm the published default is acceptable.
- **Session-continuity default** — blank Session ID currently generates a random UUID (new conversation each run), matching the raw service contract. Whether to make persistence the default (deterministic per-node/per-actor id) is an open UX decision; v0.2 ships the visible `sessionSource` flag + docs as the safe interim step.
- **Harness lifecycle cost optimization** — `ListHarnesses` on every static-data cache miss may be slow for accounts with many harnesses; manual runs also re-version on each execution since static data isn't persisted. Fast-follow.
- **`ExecuteCommand` (shell)** — intentionally deferred (root shell, not scoped by `allowedTools`).

## 15. Glossary

|Term                  |Meaning                                                                                                      |
|----------------------|-------------------------------------------------------------------------------------------------------------|
|AgentCore harness     |Declarative agent primitive — config-driven, no container required                                           |
|AgentCore Runtime     |BYO-container agent hosting primitive (older, complementary to the harness)                                  |
|Harness execution role|IAM role AgentCore assumes when running the agent                                                            |
|Workload identity     |AgentCore’s internal auth mechanism between services                                                         |
|Inline function       |A tool whose schema is registered with the harness but whose execution happens client-side; the node surfaces `stopReason: tool_use` and round-trips the result via the Tool Results field|
|Workflow static data  |n8n’s per-workflow persistent key-value store, used here to cache harness ARNs                               |
|Verdaccio             |Private npm registry used for local testing                                                                  |
|Bedrock Mantle        |The OpenAI-compatible Bedrock inference endpoint (`bedrock-mantle` IAM namespace); reached via Bedrock provider + `apiFormat=responses/chat_completions`|
|Managed memory        |AgentCore Memory auto-provisioned and owned by the harness; the v0.2 default                                 |

## 16. Related documents

- `README.md` — user-facing setup, usage, per-feature IAM guidance, and the v0.1→v0.2 migration note
- `CHANGELOG.md` — semver release notes
- `examples/*.json` — importable example workflows (8)
- `docs/iam-trust-policy.json` — execution-role trust policy (the only IAM policy shipped in-repo; permission policies live in the AWS harness security guide, linked from README)

## 17. Change log

|Version|Date             |Notes                                                                                                               |
|-------|-----------------|--------------------------------------------------------------------------------------------------------------------|
|0.1.0  |TBD (pre-release)|Initial release: single operation (auto-provision or bring-your-own-ARN), MCP/Browser/Code Interpreter/Gateway tools|
|0.2.0  |TBD (pre-release)|Multi-provider models, managed memory, VPC, custom containers, filesystem mounts, skills, inline functions, web search, OAuth Bearer invoke, versions & endpoints. SDK bumped to ^3.1071.0.|
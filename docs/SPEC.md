# Specification — @aws/n8n-nodes-agentcore

|                         |                                            |
|-------------------------|--------------------------------------------|
|**Status**               |v0.1 — pre-release, in private testing      |
|**Owner**                |Amazon Bedrock AgentCore team               |
|**Distribution**         |npm community node + AWS public GitHub org  |
|**License**              |Apache-2.0                                  |
|**Audience for this doc**|Engineers, PMs, partners, security reviewers|

-----

## 1. Overview

`@aws/n8n-nodes-agentcore` is an n8n community node that integrates Amazon Bedrock AgentCore Harness into n8n workflows. It lets workflow developers run production-grade AI agents — with cross-session memory, real cloud browser, real microVM code execution, and long-running sessions — without writing infrastructure code or agent code.

The node auto-provisions a Harness on first execution, reuses it on subsequent runs, and updates it when configuration drifts. AWS credentials are read from n8n’s encrypted credential vault per execution, never persisted. All risky execution (model inference, browser, code interpreter) happens inside AWS-managed Firecracker microVMs, not inside the n8n process.

## 2. Goals and non-goals

### In scope (v0.1)

- One n8n node (`AgentCoreHarness`) with a single operation; the Harness ARN field selects between auto-provision and bring-your-own-ARN behavior
- One credential type (`AgentCoreApi`) reusing n8n’s standard AWS credential pattern
- Inline tool configuration for AgentCore-native tools (Browser, Code Interpreter, Gateway, remote MCP)
- Streaming response handling with structured output (text, tool-use trace, usage, latency)
- Auto-provisioned harness lifecycle with workflow-static-data caching, AWS-as-source-of-truth on cache miss
- BYO-ARN escape hatch for harnesses created outside n8n
- Three importable example workflows
- IAM policy reference documents (trust, execution role permissions, IAM user policy)

### Out of scope for v0.1, deferred to later versions

- Inline functions (n8n sub-nodes as harness tools) — **v0.2**
- Memory auto-provisioning — **v0.3** (BYO Memory ARN supported in v0.1)
- Custom container support — **v0.4**
- One-click CloudFormation execution role provisioning — **v0.5**
- Mid-session model switching, Skills, shell hooks, Trigger node, Evaluations integration — later

### Explicit non-goals

- This package does **not** wrap AgentCore Runtime (the container-hosting primitive). It targets AgentCore Harness, the declarative-spec primitive.
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
|Model ID            |string    |no            |always    |Bedrock model ID. Run mode: defaults to Claude Haiku 4.5 if blank. Invoke mode: per-invocation override if set.|
|System Prompt       |string    |no            |always    |Agent instructions. Run mode: defaults if blank. Invoke mode: override if set.                                 |
|Prompt              |string    |yes           |always    |User message (n8n expressions supported)                                                                       |
|Tools               |collection|no            |always    |Inline tool config: Browser, Code Interpreter, Gateway, remote MCP. Invoke mode: override.                     |
|Session ID          |string    |no            |always    |For multi-turn. Auto-generated when blank.                                                                     |
|Additional Options  |collection|no            |always    |Actor ID, Max Iterations, Max Tokens, Timeout. Invoke mode: overrides.                                         |
|Provisioning Options|collection|no            |ARN blank |Memory ARN (BYO) and Force Recreate — lifecycle-only, hidden in invoke mode.                                   |

**Mode resolution:** at execution the node reads Harness ARN. If non-empty (after trim) it validates the ARN and calls `InvokeHarness` directly, applying any filled config field as a per-invocation override. If empty it runs the auto-provision lifecycle below.

**Run Agent lifecycle (ARN blank):**

1. Compute config hash from current field values
2. Look up existing harness in workflow static data
3. If absent, query AWS via `ListHarnesses` to find one matching the agent name (handles workflow imports, n8n restarts, lost local state)
4. If found: reuse if config hash matches; `UpdateHarness` if hash differs
5. If not found: `CreateHarness`, poll `GetHarness` until READY (~30s)
6. `InvokeHarness` with streaming, accumulate response

### Credential — `AgentCoreApi`

|Field             |Required|Notes                                             |
|------------------|--------|--------------------------------------------------|
|Access Key ID     |yes     |IAM user with the AgentCore user policy attached  |
|Secret Access Key |yes     |Stored encrypted in n8n credential vault          |
|Session Token     |no      |For STS temporary credentials                     |
|Region            |yes     |AgentCore-supported AWS region                    |
|Execution Role ARN|yes     |The role AgentCore assumes at runtime — non-secret|

## 6. Output shape

```json
{
  "operation": "run",
  "agentName": "research_agent",
  "harnessId": "research_agent-a1b2c3d4e5",
  "harnessArn": "arn:aws:bedrock-agentcore:us-west-2:...",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "response": "Final accumulated text from the agent",
  "stopReason": "end_turn",
  "toolUses": [{ "name": "browser", "toolUseId": "..." }],
  "usage": { "inputTokens": 234, "outputTokens": 567 },
  "latencyMs": 4123
}
```

## 7. Session ID handling

- Empty input → random UUID
- Non-empty input < 33 chars → sanitized + extended deterministically with SHA-256 of the sanitized value (same logical input maps to same session ID across executions)
- Non-empty input ≥ 33 chars → sanitized, capped at 128 chars
- Sanitization replaces characters outside `[A-Za-z0-9_-]` with `_`

## 8. IAM model

Two AWS principals, two policies. The most common confusion point for reviewers — keep them mentally separate.

### Principal A — IAM user (calls AgentCore from n8n)

Attached to the IAM user whose access key/secret are stored in the n8n credential.

Required actions: `bedrock-agentcore:` CreateHarness, GetHarness, UpdateHarness, ListHarnesses, DeleteHarness, InvokeHarness, plus the paired runtime actions CreateAgentRuntime, UpdateAgentRuntime, DeleteAgentRuntime, InvokeAgentRuntime — harness APIs authorize against both the harness resource and the underlying AgentCore Runtime resource. All actions except ListHarnesses are scoped to `arn:aws:bedrock-agentcore:<region>:<account>:harness/*`; ListHarnesses requires `Resource: "*"`.

For testing, use the least-privilege scoped caller policy described above rather than the broad `BedrockAgentCoreFullAccess` managed policy. `iam:PassRole` is not required for this flow: the execution role ARN is passed to CreateHarness as a parameter and assumed by the AgentCore service, not passed by the caller.

### Principal B — Harness execution role (assumed by AgentCore at runtime)

Attached to a separate IAM role whose trust policy permits only `bedrock-agentcore.amazonaws.com` to assume it, with conditions on `aws:SourceAccount` and `aws:SourceArn` to prevent confused-deputy attacks.

Permissions cover what the harness does at runtime:

- `bedrock:InvokeModel` / `InvokeModelWithResponseStream` — model inference
- `ecr-public:GetAuthorizationToken` + `sts:GetServiceBearerToken` — pull default runtime container
- `xray:*` (trace APIs) — observability
- `logs:*` scoped to `/aws/bedrock-agentcore/runtimes/*` — execution logs
- `cloudwatch:PutMetricData` with namespace condition — metrics
- `bedrock-agentcore:GetWorkloadAccessToken` / `*ForJWT` — internal auth between AgentCore services
- (Conditional) `bedrock-agentcore:Start/Stop/Get/ListBrowserSession`, `UpdateBrowserStream`, `Connect*Stream` scoped to `arn:aws:bedrock-agentcore:REGION:aws:browser/*` — when Browser tool is configured
- (Conditional) `bedrock-agentcore:Start/Stop/Get/ListCodeInterpreterSession`, `InvokeCodeInterpreter` scoped to `arn:aws:bedrock-agentcore:REGION:aws:code-interpreter/*` — when Code Interpreter tool is configured

AWS maintains the canonical execution-role policy in the AgentCore developer guide; customers substitute `REGION` and `ACCOUNT_ID` for their environment and append the Memory and Gateway add-ons as needed.

## 9. Security properties

- **No local execution.** Zero `exec` / `spawn` / `eval` / file-system writes in the codebase
- **Credentials never persisted by the node.** Read from n8n vault per execution, used by AWS SDK, released
- **TLS 1.2+ enforced** for all AWS communications (AWS SDK v3 default)
- **SigV4 request signing** — integrity even under TLS compromise
- **Two production dependencies** — only `@aws-sdk/client-bedrock-agentcore` and `@aws-sdk/client-bedrock-agentcore-control`, both Apache-2.0, AWS-maintained
- **TypeScript strict mode** enforced
- **Confused-deputy mitigation** via `aws:SourceAccount` + `aws:SourceArn` conditions in trust policy

Full threat model lives in `docs/threat-model.md`.

## 10. Dependencies

### Runtime

- `@aws-sdk/client-bedrock-agentcore` (^3.700.0)
- `@aws-sdk/client-bedrock-agentcore-control` (^3.700.0)

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

Local-only testing uses Verdaccio (private npm registry in Docker). See `docs/local-testing.md` for the full Verdaccio + n8n install flow.

### Smoke tests (manual, per release)

1. Create credential, save successfully
2. Blank Harness ARN, no tools — completes, returns response, harness in `READY`
3. Re-run same workflow — fast (~2s), same harness ID
4. Modify system prompt, re-run — slower (~10–15s), same harness ID, response reflects update
5. Multi-turn with shared session ID — second node references first prompt
6. Run Agent with MCP tool — agent uses tool, response cites tool output
7. Run Agent with Code Interpreter — agent runs code, returns result
8. Run Agent with Browser — agent navigates, returns content
9. Populated Harness ARN (paste-in) — invokes without auto-provision; filled config fields apply as per-invocation overrides
10. Force Recreate (blank Harness ARN) — deletes and recreates with new ARN

### Automated tests

Unit tests planned for v0.2 (Jest). Integration tests against real AgentCore in CI planned for v0.3 once credentials handling for CI is approved.

## 13. Versioning and compatibility

Semantic versioning. v0.x is pre-1.0; minor versions may add fields but will not break existing workflow configurations. Breaking changes (if any) ship in major version bumps with a documented migration path.

Two-way doors — every deferred feature is additive when it ships:

- v0.2 inline functions: new optional sub-node connector — existing workflows unaffected
- v0.3 memory auto-provisioning: existing BYO-ARN configurations continue to work
- v0.4 custom containers: new optional field — default environment unchanged
- v0.5 CloudFormation quick-create: documentation/UX improvement, no API change

## 14. Open questions

- **CloudTrail-based policy narrowing** — execution-role permissions to be tightened from the working broad set to the scoped set (CDK construct from AppSec engineer is the source of truth for the scoped form). Tracked as P1 before public publish.
- **Harness lifecycle cost optimization** — `ListHarnesses` on every static-data cache miss may be slow for accounts with many harnesses. Fast-follow: optimistic `CreateHarness` with `ConflictException` fallback to `ListHarnesses`. Quality-of-life, not blocking.
- **n8n built-in promotion path** — engagement with the n8n partnership team to be opened after v0.1 demonstrates real adoption.
- **Inline-function tool-result round-trip contract** — verified via SDK type inspection (`HarnessInlineFunctionConfig$` exists); end-to-end implementation deferred to v0.2.

## 15. Glossary

|Term                  |Meaning                                                                                                      |
|----------------------|-------------------------------------------------------------------------------------------------------------|
|AgentCore Harness     |Declarative agent primitive — config-driven, no container required                                           |
|AgentCore Runtime     |BYO-container agent hosting primitive (older, complementary to Harness)                                      |
|Harness execution role|IAM role AgentCore assumes when running the agent                                                            |
|Workload identity     |AgentCore’s internal auth mechanism between services                                                         |
|Inline function       |A tool whose schema is registered with the harness but whose execution happens client-side (deferred to v0.2)|
|Workflow static data  |n8n’s per-workflow persistent key-value store, used here to cache harness ARNs                               |
|Verdaccio             |Private npm registry used for local testing                                                                  |

## 16. Related documents

- `README.md` — user-facing setup and usage
- `docs/threat-model.md` — full STRIDE threat model
- `examples/*.json` — three importable workflows
- `docs/local-testing.md` — local Verdaccio + n8n development setup

## 17. Change log

|Version|Date             |Notes                                                                                                               |
|-------|-----------------|--------------------------------------------------------------------------------------------------------------------|
|0.1.0  |TBD (pre-release)|Initial release: single operation (auto-provision or bring-your-own-ARN), MCP/Browser/Code Interpreter/Gateway tools|
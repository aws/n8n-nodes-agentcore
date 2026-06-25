# @aws/n8n-nodes-agentcore

An n8n community node for **Amazon Bedrock AgentCore harness**. Run production-grade AI agents with isolated microVMs, real browsers, real code execution, and persistent memory — directly from your n8n workflows.

> Supported in the AgentCore regions us-east-1, us-west-2, ap-southeast-2, and
> eu-central-1. Pin this package to a specific version in production and review
> release notes before upgrading.

## Why this node?

n8n’s native AI Agent node is great for simple agents, but hits walls fast: no cross-session memory, no real browser, no real code execution, and short execution timeouts. AgentCore harness solves all four. This node is the bridge.

|Capability    |Native n8n AI Agent|AgentCore Agent (this node)               |
|--------------|-------------------|------------------------------------------|
|Memory        |Per-execution only |Cross-session, semantic, summary, episodic|
|Code execution|Sandboxed JS only  |Full microVM with Python/Node/etc.        |
|Browser       |None               |Cloud browser with real navigation        |
|Session length|Workflow timeout   |Up to 8 hours per session                 |
|Isolation     |Shared process     |Firecracker microVM per session           |

## Features

- **Auto-provision & reuse** — Leave the Harness ARN blank: the node creates a harness on first run, reuses it across executions, and updates it when configuration changes
- **Bring your own harness** — Paste a harness ARN (deployed via CLI / CloudFormation / console / Terraform) to invoke it directly, with any config field acting as a per-invocation override
- **Multi-provider models** (v0.2) — Amazon Bedrock (native), OpenAI, Google Gemini, and LiteLLM, switchable per invocation
- **Managed memory** (v0.2) — auto-provisioned AgentCore Memory with configurable strategies, or bring your own Memory ARN, or disable it
- **Inline tool configuration** — AgentCore Browser, Code Interpreter, Gateway (with optional OAuth outbound auth), remote MCP servers, and inline functions
- **Skills** (v0.2) — AWS curated catalog, Git, S3, and filesystem-path sources
- **VPC, custom containers, and filesystem mounts** (v0.2) — run in your VPC, bring a linux/arm64 ECR image, mount session storage / EFS / S3 Files
- **OAuth Bearer invoke** (v0.2) — invoke inbound-OAuth harnesses with a JWT from an upstream node
- **Versions & endpoints** (v0.2) — list immutable versions, pin named endpoints, invoke by qualifier
- **Streaming responses** with structured tool-use trace, token usage, and latency metadata
- **Session persistence** — pass the same session ID across executions for multi-turn conversations
- **Execution limits** — max iterations, max tokens, timeout

## Quick start

New here? **[docs/QUICKSTART.md](./docs/QUICKSTART.md)** takes you from install to
a working agent reply in ~5 minutes (install → credential → one prompt → multi-turn).

## Installation

### Via n8n UI (recommended)

1. Open n8n
2. **Settings → Community Nodes → Install a community node**
3. Enter `@aws/n8n-nodes-agentcore`
4. Accept the warning, click **Install**

### Manually

```bash
cd ~/.n8n
npm install @aws/n8n-nodes-agentcore
# restart n8n
```

## Prerequisites

You need:

1. **An AWS account** with Amazon Bedrock and AgentCore access in a supported region (us-east-1, us-west-2, ap-southeast-2, eu-central-1)
2. **AWS credentials** (access key + secret key) with the IAM policy below attached
3. **An IAM execution role** that the harness assumes when running, with a trust policy and permissions described below
4. **An enabled foundation model** in the Amazon Bedrock console (Claude Haiku, Sonnet, etc.)

### IAM setup

> **Source of truth:** AWS maintains the canonical, least-privilege harness IAM
> policies in the
> [AgentCore harness security guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)
> and updates them as the service ships features. Grant **only** the statements
> for the features your workflow actually uses — do not paste a broad policy.
> This repo intentionally ships only the trust policy (`docs/iam-trust-policy.json`);
> the permission policies live in the AWS guide so they never drift.

Two separate IAM principals are involved — keep them distinct:

**1. Caller** — the IAM user/role whose access keys go in the n8n credential.
Grant the actions in the
[Required IAM permissions for callers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html#harness-iam-permissions)
table, **scoped to your harness ARN** (`arn:aws:bedrock-agentcore:<region>:<account>:harness/*`;
`ListHarnesses` requires `*`). That table already lists the paired
`*AgentRuntime*` / `*Memory` companion actions each harness API needs.

**2. Execution role** — the role AgentCore assumes at runtime. Use the
[Sample execution role policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html#_sample_execution_role_policy),
plus the trust policy in `docs/iam-trust-policy.json`.

#### Which permissions each feature needs

Add only the blocks for features you enable. Each maps to a named section in the
AWS guide's
[Additional permissions for optional features](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html#_additional_permissions_for_optional_features):

| If your workflow uses… | Add (least-privilege, scope to the named resource) |
|---|---|
| **Managed memory** (the v0.2 default) or BYO Memory | Caller: `CreateMemory`/`UpdateMemory`/`DeleteMemory` (per the callers table). Execution role: the *AgentCore Memory* block (`CreateEvent`/`GetEvent`/`ListEvents`/`DeleteEvent`/`RetrieveMemoryRecords`) scoped to your `memory/*`. |
| **OpenAI / Gemini / LiteLLM models, or MCP header credential refs** | Execution role: the *API key credential provider* block (`bedrock-agentcore:GetResourceApiKey` + the matching `secretsmanager:GetSecretValue` on `…identity!default/apikey/…`). |
| **OpenAI via Bedrock Mantle** (no API key) | Execution role: `bedrock-mantle:CreateInference`, scoped to `arn:aws:bedrock-mantle:<region>:<account>:project/default`. (Mantle is a separate IAM namespace from `bedrock:`; not in the canned sample — add it explicitly.) |
| **AgentCore Gateway tool** | Execution role: the *AgentCore Gateway* block (`bedrock-agentcore:InvokeGateway` on your `gateway/<id>`); for OAuth-protected gateways also the *OAuth2 credential provider* block. |
| **Skills from S3** (or S3 Files data) | Execution role: the *Skill sources in S3* block (`s3:GetObject`/`s3:ListBucket` on your bucket). Private **Git** skills: an API key credential provider holding the PAT. |
| **Custom container (private ECR)** | Execution role: the *Private ECR access* block — `ecr:GetDownloadUrlForLayer`/`ecr:BatchGetImage` scoped to your `repository/<name>`, and `ecr:GetAuthorizationToken` on `*` (that action can't be resource-scoped). |
| **EFS filesystem mount** (VPC) | Execution role: `elasticfilesystem:ClientMount`/`ClientWrite` scoped to your access-point ARN. (Session-storage mounts need no extra IAM; no `ClientRootAccess`.) |
| **Versions / named endpoints** | Caller: `ListHarnessVersions` and the `*HarnessEndpoint` actions, plus the paired `*AgentRuntimeEndpoint` actions (per the callers table). |
| **VPC networking** | No extra IAM — it's a `networkConfiguration` on the harness. Your VPC needs a NAT route to `public.ecr.aws` (see the guide's Network configuration section). |

`iam:PassRole` is **not** required: the execution-role ARN is passed to
CreateHarness as a parameter and assumed by the service, not passed by the caller.

> A future `agentcore iam create-execution-role` CLI command will generate the
> role automatically (separate workstream).

## Configuring credentials

In n8n, go to **Credentials → New → Amazon Bedrock AgentCore API** and fill in:

|Field             |Value                                         |
|------------------|----------------------------------------------|
|Access Key ID     |From your IAM user                            |
|Secret Access Key |From your IAM user                            |
|Session Token     |Optional. Only for temporary STS credentials. |
|Region            |The AgentCore-supported region you want to use|
|Execution Role ARN|The role ARN from Step 1                      |

Save.

## How it works

The node has a single operation. The **Harness ARN** field decides the mode.

### Leave Harness ARN blank — Run Agent

Type an Agent Name, set the system prompt and prompt, configure tools, and run. The node:

- Creates the harness on first execution (~30 seconds), stores the ARN in workflow static data
- Reuses the same harness on subsequent runs (~3 seconds)
- Updates the harness if you change the model, system prompt, tools, or limits
- Streams the response back

### Fill in Harness ARN — Invoke Existing

For a harness deployed outside n8n (CLI, console, CloudFormation, Terraform). The node calls `InvokeHarness` directly (~3 seconds). Any config field you fill in — Model, System Prompt, Tools, Max Iterations / Tokens, Timeout, Actor ID — is sent as a **per-invocation override**; leave a field blank to use the harness’s own configuration. The Agent Name, Memory ARN, and Force Recreate fields are hidden in this mode because they only apply when the node owns the harness lifecycle.

**Output shape** (the `operation` field reports the resolved mode, `run` or `invokeExisting`):

```json
{
  "operation": "run",
  "agentName": "research_agent",
  "harnessId": "research_agent-abc1234567",
  "harnessArn": "arn:aws:bedrock-agentcore:us-west-2:...",
  "sessionId": "a1b2c3d4-...",
  "response": "The top 3 quantum computing breakthroughs are ...",
  "stopReason": "end_turn",
  "toolUses": [{ "name": "exa", "toolUseId": "...", "input": { "query": "..." } }],
  "usage": { "inputTokens": 234, "outputTokens": 567 },
  "latencyMs": 4123
}
```

When versioning/endpoint actions are enabled, the output also carries
`versions` and/or `endpoint` (+ `endpoints`).

## v0.2 capabilities

### Models

Pick a **Model Provider** (Amazon Bedrock, OpenAI, Google Gemini, LiteLLM) and a
**Model ID**, and expand **Model Options** for API Key ARN, API Base URL, API
Format, temperature, top-p/k, and JSON additional params. OpenAI and Gemini
require an API Key ARN (an AgentCore Identity token-vault credential provider).
To call OpenAI-style models through **Bedrock Mantle without a key**, pick the
Bedrock provider and set API Format to `Responses` or `Chat Completions` with a
Mantle model id (e.g. `openai.gpt-4o`). You can switch providers between turns of
one session and the conversation continues.

### Memory & sessions

**Memory Mode** (Provisioning Options) chooses **Managed** (auto-provision, the
default — configurable strategies and event expiry), **Bring Your Own ARN**, or
**Disabled**. A populated **Memory ARN** is always treated as BYO so v0.1
workflows are unaffected.

Three related-but-distinct controls govern what the agent remembers — getting
these straight prevents the most common "it didn't remember" confusion:

- **Session ID** = *continuity of one conversation.* Reuse the same value across
  runs to continue a conversation; a new/blank value starts a fresh one. **Left
  blank, every run gets a new random session** and the agent won't recall prior
  turns — the output's `sessionSource` field reports `generated` (new) vs
  `provided` (continuing). For multi-turn, set a stable Session ID (e.g. bound to
  a user/thread id via an expression).
- **Memory Mode** = *whether anything is persisted/recalled at all.* Managed or
  BYO = on; Disabled = stateless. This is the on/off switch.
- **Actor ID** (Additional Options) = *whose memory, within enabled memory.*
  Memory is scoped by `actorId + sessionId`, so different actors on the same
  agent get isolated histories. It has no effect when memory is Disabled.

So: short-term continuity needs a stable **Session ID**; long-term recall needs
**Memory Mode** on; per-user isolation needs an **Actor ID**.

### Tools & skills

Tools now include **Gateway** with optional OAuth outbound auth and **Inline
Functions**, alongside Browser, Code Interpreter, and remote MCP. **Skills** load
domain knowledge on demand from the AWS catalog (glob patterns), Git, S3, or a
filesystem path. (Need web search? Point a Remote MCP tool at a search MCP
server — a managed `agentcore_web_search` type is documented by AgentCore but not
yet accepted by the harness API.)

#### Inline-function round-trip

Add an **Inline Function** tool (name, description, JSON input schema). When the
agent calls it, the invocation returns `stopReason: "tool_use"` and the output's
`toolUses[]` carries the `toolUseId`, `name`, and parsed `input`. Compute the
result in your workflow, then on a second node placement (same Session ID) fill
the **Tool Results** field (Tool Use ID, function name, original input, result
content). The node replays the assistant tool-use + your tool-result on the same
session and the agent resumes. The Prompt may be blank on that second call.

### VPC, containers, filesystems

Set **Network Mode = VPC** (plus subnets and security groups) on the credential
to run harnesses in your VPC. Provisioning Options add a **Container Image URI**
(linux/arm64 ECR) and **Filesystem Mounts** (session storage with no VPC; EFS and
S3 Files access points require VPC).

> **VPC requirements:** the subnets you provide must route `0.0.0.0/0` to a **NAT
> gateway** — the harness pulls its container from `public.ecr.aws` at session
> start, and ECR Public has no VPC endpoint, so a NAT-less/isolated subnet causes
> image-pull timeouts. **First creation of a VPC harness is slow** (network
> interface provisioning + container pull through the NAT can take several
> minutes); the node waits up to 10 minutes. Subsequent runs reuse the harness
> and return in seconds.

### OAuth Bearer invoke

For a harness with an inbound OAuth (JWT) authorizer, set **Authentication =
OAuth Bearer Token** and populate **Bearer Token** (an operation-level field, so
you can wire it from an upstream auth node via `={{ $json.id_token }}`). The node
makes a raw HTTPS request to InvokeHarness because the AWS SDK cannot attach a
Bearer token. Provisioning and other control-plane calls always use SigV4.

#### Bearer token security (bring-your-own JWT)

This path is for harnesses configured with an **inbound JWT (OIDC) authorizer**
only. The token is a **JWT issued by your identity provider** (e.g. Amazon
Cognito or any OIDC IdP), not an AWS SigV4 / Bedrock API key. The node does
**not** mint, exchange, or derive it — it is strictly **bring-your-own**: you
supply the JWT and the node passes it through verbatim as the
`Authorization: Bearer …` header. It is read per-execution from a
password-masked field and is never logged or persisted by the node. Because you
own the token, follow these practices:

- **Use short-lived JWTs from your IdP.** Obtain the token per workflow run from
  an upstream auth step (e.g. a Cognito/OIDC login node) rather than pasting a
  long-lived token into the field. Configure a short token TTL at the IdP so a
  leaked token has a small exposure window.
- **Constrain the authorizer.** The inbound JWT authorizer is IdP-agnostic and
  validates tokens against the discovery URL plus any of: allowed **audiences**
  (`aud`), allowed **clients** (`client_id`), allowed **scopes**, and required
  **custom claims** (e.g. `group == Developer`). At least one of these must be
  configured, and if you set several the authorizer enforces all of them — so
  scope it tightly so only tokens minted for this harness are accepted. See
  [inbound JWT authorizer](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html).
- **Plan for revocation and rotation.** Revoke at the IdP (rotate signing keys,
  revoke the session/refresh token, or disable the client) if a token is
  exposed. Don't hard-code tokens in saved workflows — bind them from an upstream
  auth node so they refresh automatically and never persist in the workflow JSON.
- **Treat the token as a secret in your workflow.** If it flows through other
  nodes, avoid logging it; the node itself masks and never persists it.

For the full inbound-OAuth setup and how end-user identity threads through to
downstream tools, see
[AgentCore Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html)
and the
[AgentCore harness security guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html).
If you don't need per-user identity propagation, the default **AWS SigV4** path
(IAM credentials from the n8n credential vault) is simpler and avoids handling
tokens entirely.

### Versions & endpoints

Enable **List Versions** to return all immutable versions. Set an **Endpoint
Name** (+ optional **Target Version**) to create or update a named endpoint
pinned to a version. Use **Additional Options ▸ Endpoint (Qualifier)** to invoke
a specific endpoint instead of the latest version.

> **Migrating from v0.1?** v0.2 is additive — existing workflows keep working.
> The one behavior change to know: memory now defaults to **Managed** for new
> placements (a populated Memory ARN is still honored as BYO; set Memory Mode =
> Disabled for the old no-memory behavior). Force Recreate now disassociates
> managed memory instead of deleting it, and the run-mode default model is
> Claude Sonnet 4.6.

## Examples

The `examples/` folder has importable workflows:

1. **`01-mcp-research-agent.json`** — Research agent using Exa search (remote MCP)
2. **`02-code-interpreter.json`** — Data analyst agent that writes and runs Python
3. **`03-multiturn-support.json`** — Webhook-triggered support agent with session persistence
4. **`04-multi-provider-switch.json`** — Bedrock on turn 1, Gemini via LiteLLM on turn 2, same session (v0.2)
5. **`05-oauth-invoke.json`** — Fetch a Cognito token, then invoke an OAuth-protected harness with the Bearer token (v0.2)
6. **`06-skills-agent.json`** — Agent loading AWS catalog + Git + S3 skills (v0.2)
7. **`07-inline-function-roundtrip.json`** — Inline function tool_use → compute result → send it back (v0.2)
8. **`08-vpc-filesystem.json`** — VPC harness with an EFS access-point mount (v0.2)

Import any of them via **Workflows → Import from File** in n8n. The v0.2 examples
contain placeholder ARNs / IDs — replace them with your own.

## Local development

### Step 1 — Clone and install

```bash
git clone https://github.com/aws/n8n-nodes-agentcore.git
cd n8n-nodes-agentcore
npm install
```

### Step 2 — Build

```bash
npm run build
```

This compiles TypeScript to `dist/` and copies the SVG icon.

### Step 3 — Link into a local n8n instance

```bash
# from the repo root
npm link

# in the n8n custom directory
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm init -y           # if package.json doesn't already exist
npm link @aws/n8n-nodes-agentcore
```

### Step 4 — Start n8n

```bash
npx n8n start
```

Open `http://localhost:5678`. The **Amazon Bedrock AgentCore** node should appear in the node palette under the AI / AWS categories.

### Step 5 — Configure credentials and run an example

1. Add an **Amazon Bedrock AgentCore API** credential with your IAM access keys, region, and execution role ARN
2. **Workflows → Import from File** → select `examples/01-mcp-research-agent.json`
3. Attach the credential to the agent node
4. Click **Execute Workflow**

First run takes ~30 seconds (harness creation). Subsequent runs are instant.

### Step 6 — Verify

Check that a harness was created in your AWS account:

```bash
aws bedrock-agentcore-control list-harnesses --region us-west-2
```

You should see `research_agent-<10 char id>` in `READY` state.

## Publishing

Releases are cut through the **Release** GitHub Actions workflow
(`.github/workflows/release.yml`), which publishes to npm via
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with
provenance) behind a manual approval gate — no tokens.

### Cutting a release

1. Ensure CI is green and `CHANGELOG.md` has an entry for the new version.
2. **Actions → Release → Run workflow**, and pick the bump type (patch / minor / major / prerelease). The workflow bumps the version and opens a 3release/vX.Y.Z` pull request.
4. Review and merge that release PR into `main`.
5. Approve the `npm-publish` environment on the waiting run. The publish job then verifies the version on `main`, builds, publishes `@aws/n8n-nodes-agentcore` with provenance, tags `vX.Y.Z`, and creates the GitHub Release.

The package name `@aws/n8n-nodes-agentcore` matches n8n’s required
`@scope/n8n-nodes-*` convention, so n8n’s community node scanner will discover it.

> **First publish only:** trusted publishing can’t create a package that doesn’t
> exist yet, so the initial `0.1.0` is published manually with a token. Every
> release after that uses the workflow above.

### Discovery on n8n

n8n has no per-node registry in its docs — community nodes are discovered as npm
packages. Once published, anyone can install this node via **Settings → Community
Nodes** (or `npm install`) by package name.

For in-editor discovery (the "More from the community" panel), submit the package
for verification at the [n8n Creator Portal](https://creators.n8n.io/nodes).
Verification has its own requirements (package-name prefix, the
`n8n-community-node-package` keyword, npm provenance, and constraints on runtime
dependencies and license) — review them before submitting; an AWS-SDK-backed,
Apache-2.0 package may need clarification with n8n on those constraints.

### Announce

- Post in the n8n community forum under **Show and Tell**
- Link to the GitHub repo, the npm package, and one of the example workflows

## Roadmap

|Version           |Capability                                                                                       |
|------------------|-------------------------------------------------------------------------------------------------|
|**v0.1**          |Run Agent, Invoke Existing, MCP / Browser / Code Interpreter / Gateway tools, streaming, sessions|
|**v0.2** (current)|Multi-provider models, managed memory, VPC, custom containers, filesystem mounts, skills, inline functions, OAuth Bearer invoke, versions & endpoints|
|**later**         |ExecuteCommand (shell) with Bearer, custom Browser/Code Interpreter resources, CloudFormation quick-create, Export to Code, Step Functions|

## Limitations (v0.2)

- **No shell ExecuteCommand.** `InvokeAgentRuntimeCommand` (root shell in the
  microVM, not scoped by `allowedTools`) is intentionally not exposed for
  security reasons.
- **OpenAI-via-Mantle without a key** uses the Bedrock provider with API Format
  `Responses`/`Chat Completions`; the SDK's `openAiModelConfig` requires an API
  key (Q1).
- **First run is slow.** ~30 seconds for harness creation; managed memory adds a
  little more. Subsequent runs are instant.
- **Workflow static data** holds the harness ARN. Renaming an agent creates a new
  harness; the old one remains in your account until manually deleted.
- **Inline functions are stateless across calls.** The tool-result round-trip is
  a two-node pattern (Tool Results field), not an in-node interactive pause.

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| **The agent doesn't remember previous turns** | The **Session ID** was left blank, so each run is a new conversation (output shows `sessionSource: "generated"`). Set a stable Session ID and reuse it across runs. See [Memory & sessions](#memory--sessions). |
| **`AccessDenied` / `not authorized to perform` on the first run** | Either the **Bedrock model isn't enabled** (Bedrock console → Model access), or the **execution role is missing a scoped action** for the feature you used (e.g. `bedrock-mantle:CreateInference` for Mantle models, token-vault read for OpenAI/Gemini keys, `InvokeGateway` for gateways). See [IAM setup](#iam-setup). |
| **First run hangs for ~30 seconds** | Expected — the node is creating the harness on first use. Subsequent runs reuse it and return in a few seconds. |
| **"Harness … did not reach READY within …" on a VPC harness** | VPC harness creation is slow (ENI provisioning + container pull through the NAT). The node now waits up to 10 minutes; if you still see this, the harness is often **still creating** — re-run the node shortly and it will find the now-READY harness and invoke it. A *persistent* failure (or `CREATE_FAILED`) points at egress: the subnet must route `0.0.0.0/0` to a **NAT gateway** (ECR Public has no VPC endpoint). Fix the route table or use a NAT-routed subnet. |
| **OpenAI / Gemini model errors about a missing key** | Direct OpenAI/Gemini require an **API Key ARN** (a token-vault credential provider) in Model Options. To use OpenAI-style models without a key, pick the **Bedrock** provider with API Format `Responses`/`Chat Completions` and a Mantle model id. |
| **Two "Amazon Bedrock AgentCore" nodes in the palette** | A leftover/older install. Remove the stale package from `~/.n8n/nodes` (or `~/.n8n/custom`), then fully restart n8n and open a fresh browser tab. |
| **OAuth invoke returns 401 / Unauthorized** | The harness needs an **inbound JWT authorizer** configured, and the Bearer Token must be a valid, unexpired JWT from that IdP whose `aud`/`client_id`/scopes satisfy the authorizer. See [OAuth Bearer invoke](#oauth-bearer-invoke). |
| **Changed config but the agent behaves the same** | The node updates the harness only when the config hash changes. Confirm the field actually changed; the output `harness.version` increments on each update. |
| **Node not in the palette after install** | Fully restart the n8n process (not just reload the browser) and open a fresh/incognito tab — n8n caches the node palette and icons. |

## Getting help and contributing

- **Bug reports and feature requests:** [open an issue](https://github.com/aws/n8n-nodes-agentcore/issues)
- **Security issues:** please do not open a public issue. See [SECURITY.md](./SECURITY.md) for the disclosure process.
- **Contributing:** see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines, development setup, and the Developer Certificate of Origin process.
- **Code of Conduct:** this project adheres to the [Amazon Open Source Code of Conduct](./CODE_OF_CONDUCT.md).

## Support

This is a community-maintained project. Maintainers respond to GitHub issues
on a best-effort basis. For production support of Amazon Bedrock AgentCore
itself, please use [AWS Support](https://aws.amazon.com/support).

## Trademarks

Amazon Web Services, AWS, and Amazon Bedrock are trademarks of Amazon.com, Inc.
or its affiliates. n8n is a trademark of n8n GmbH. All other trademarks are
the property of their respective owners. Use of these names does not imply
endorsement.

## License

Apache-2.0
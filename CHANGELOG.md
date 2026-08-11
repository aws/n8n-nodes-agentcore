# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`examples/templates/build-a-multi-agent-support-team-with-shared-customer-memory.json`**
  — a triage agent routes each question to one of three specialists. All four run
  on one harness with tools granted per invocation, and share one memory per
  customer scoped by Actor ID.
- **`scripts/check-sticky-fit.mjs`** — checks sticky notes against how current n8n
  renders them: content that clips, nodes covering sticky text, node name labels
  spilling outside their group, sticky overlaps, and unused empty space.

### Fixed

- **Sticky-note layout in every template.** Node name labels render wider than the
  node icon, so nodes near a sticky edge pushed their labels outside the group, and
  nodes placed too high covered the sticky's own text. n8n's template review
  reported both. Every workflow is relaid out with the node row below each sticky's
  measured text and margins wide enough for labels.
- **The chat templates returned an empty reply.** At `typeVersion` 1.1 with
  `public: false` the Chat Trigger has no `responseMode`, so it answered the browser
  as soon as the message arrived and the agent's reply never reached the chat panel.
  `add-long-term-memory-to-an-n8n-ai-agent` and
  `remember-each-customer-across-chat-sessions` now use `typeVersion` 1.4 with
  `responseMode: lastNode`, matching the multi-agent template.

### Added

- **End-to-end templates** in `examples/templates/`: a chat assistant with
  per-customer long-term memory, a webhook-driven statistics workflow that
  computes in the code interpreter and independently verifies the result in n8n,
  and n8n's own AI Agent with this node attached as a tool for memory that
  outlives the Simple Memory buffer.
- **`examples/09-memory-isolation-test.json`** — a three-step verification
  workflow for the memory guarantees: that memory persists across separate
  executions, and that one actor never sees another actor's memory. Uses only the
  `agentCoreApi` credential.
- **`scripts/check-template-export.mjs`** — pre-submission check for a workflow
  exported from the n8n editor. Reports real credential IDs and names, instance
  fingerprints, pinned run data, AWS account IDs, ARNs, access keys and secret
  keys, emails, JWTs, private keys, long hex secrets, and Slack, OpenAI,
  Anthropic, GitHub, GitLab and Google tokens, so none of it reaches a public
  template submission.

### Changed

- **VPC guidance corrected: VPC endpoints, not a NAT gateway.** AgentCore changed
  how a VPC-mode harness pulls its managed container. It now comes from a
  **private ECR repository in the harness Region** rather than ECR Public, so the
  subnets need **no internet access**. Create VPC endpoints instead: interface
  endpoints for `ecr.dkr` and `ecr.api`, a gateway endpoint for `s3`, and an
  interface endpoint for `bedrock-runtime` if the agent calls Bedrock. The
  execution role also needs private-ECR pull permissions on
  `repository/harness-*`. The previous guidance (route `0.0.0.0/0` to a NAT
  gateway because ECR Public has no VPC endpoint) is no longer correct and would
  produce a VPC that both costs more and still fails to start sessions. Updated
  the **VPC Subnet IDs** credential field description, the README VPC
  requirements and troubleshooting rows, the feature-to-IAM table, and
  `docs/SPEC.md`.
- **Install and discovery docs** now state that the node is verified and works on
  n8n Cloud as well as self-hosted, and link to the listing at
  [n8n.io/integrations/amazon-bedrock-agentcore](https://n8n.io/integrations/amazon-bedrock-agentcore/).
  The README and QUICKSTART previously said verification was in progress and that
  a self-hosted instance was required.
- **QUICKSTART** no longer hardcodes the supported Region list, which can drift;
  it links to the AgentCore Regions documentation instead.
- **AGENTS.md** repo layout, node version, and roadmap brought up to date. The
  layout omitted `examples/templates/`, `scripts/`, `docs/QUICKSTART.md`, and
  `examples/09`; the node version was documented as `1` when it is `2`; and the
  roadmap listed shipped v0.2 and v0.4 features as future work. Adds the n8n
  Creator hub conventions that workflows under `examples/templates/` must follow.
- **README roadmap** marked v0.2 as current at version 0.4.1; it now reflects
  v0.4.
- **npm package description** now says the node is verified, and `verified` was
  added to `keywords`. npm always publishes `README.md` regardless of the `files`
  field, so this release is what surfaces the verified status on the npm page.

## [0.4.0] - 2026-07-27

### Changed

- **OAuth Bearer Token moved to the credential.** The bearer JWT is now an
  optional password field on the Amazon Bedrock AgentCore API credential
  instead of a node input field, so the secret is stored in the credential
  vault and never appears in node input or the workflow execution log. Set
  Authentication to OAuth Bearer Token on the node and enter the JWT on the
  credential. **Breaking for OAuth workflows:** re-enter any bearer token on the
  credential; it can no longer be bound per-execution from an upstream node.
- **Node `typeVersion` bumped 1 → 2.** The Bearer Token node field was removed,
  so existing node placements keep their v1 field set; re-add or re-save the
  node to pick up v2 (Add Tools / Add Skills toggles, OAuth via credential).
- **AWS calls now go through n8n's HTTP request helper** (`this.helpers.httpRequest`)
  instead of the global `fetch`, so requests honor n8n's proxy, logging, and
  auditing. SigV4 signing is unchanged.

### Added

- **Add Tools / Add Skills toggles.** The Tools and Skills sections are hidden
  until you turn on the respective toggle, keeping the node compact.

### Removed

- **Node-level credential test.** The credential validates itself (its own
  `test` request + `authenticate` signer), so the duplicate node test method was
  removed.

## [0.2.0] - 2026-06-24

### Added

- **Multi-provider models** — Model Provider selector for Amazon Bedrock (native),
  OpenAI, Google Gemini, and LiteLLM, with per-invocation switching. New Model
  Options for API Key ARN, API Base URL, API Format, temperature, top-p, top-k,
  per-model max tokens, and JSON additional params.
- **Managed memory auto-provisioning** — Memory Mode selector (Managed / Bring
  Your Own ARN / Disabled). Managed memory exposes strategies (Semantic,
  Summarization, User Preference, Episodic) and event expiry. A populated Memory
  ARN is always honored as BYO for v0.1 compatibility.
- **VPC networking** — Network Mode, subnets, and security groups on the
  credential, threaded into the harness `environment` for auto-provisioned
  harnesses.
- **Custom containers** — Container Image URI (linux/arm64 ECR) wired to the
  harness `environmentArtifact`.
- **Filesystem mounts** — session storage (no VPC), EFS access point, and S3
  Files access point (both VPC-only, validated client-side).
- **Skills** — AWS curated catalog (glob patterns), Git (HTTPS, optional auth),
  S3, and filesystem-path sources, settable per-harness or per-invocation.
- **Inline functions** — new tool type; the node surfaces `stopReason: tool_use`
  with parsed tool inputs and a Tool Results field to send results back over the
  same session.
- **OAuth Bearer invoke** — Authentication selector with an operation-level
  Bearer Token field. Uses a raw HTTPS request and an event-stream decoder
  (`@smithy/core/event-streams`) because the AWS SDK cannot Bearer-auth
  InvokeHarness. Control-plane calls remain SigV4.
- **Versioning & endpoints** — opt-in List Versions, create/update a named
  endpoint pinned to a target version, and an Endpoint (Qualifier) field to
  invoke a specific endpoint.

### Changed

- Bumped `@aws-sdk/client-bedrock-agentcore` and
  `@aws-sdk/client-bedrock-agentcore-control` to `^3.1071.0` (adds GA harness
  endpoint/version commands, managed memory, and AWS skills). No new packages.
- Run-mode default model is now `global.anthropic.claude-sonnet-4-6`.
- Force Recreate disassociates managed memory (`deleteManagedMemory=false`)
  instead of cascade-deleting it.
- Config-drift hash extended to cover model union, memory, skills, environment,
  and container so changes to any of them trigger an UpdateHarness.
- Harness-ready polling timeout raised from 180s to 600s. VPC harness creation
  (network-interface provisioning + container pull through the NAT) can take
  several minutes; the shorter timeout reported a misleading "did not reach
  READY" error on harnesses that were still creating.

### Migration

- Memory now defaults to Managed for new placements and v0.1 workflows re-saved
  without a Memory ARN. A populated Memory ARN is still honored as BYO; set
  Memory Mode = Disabled for the old no-memory behavior. Force Recreate
  disassociates managed memory instead of deleting it. Run-mode default model is
  now Claude Sonnet 4.6.

## [0.1.0] - YYYY-MM-DD

### Added

- Initial release of `n8n-nodes-agentcore`
- `AgentCoreHarness` node with two operations:
  - **Run Agent**: auto-provisions an AgentCore harness on first execution,
    reuses it across subsequent runs, and updates it when configuration changes.
  - **Invoke Existing harness**: invokes a harness deployed outside n8n (CLI,
    CloudFormation, console).
- `AgentCoreApi` credential type with AWS access keys, region selector,
  execution role ARN, and optional session token for STS temporary credentials.
- Inline tool configuration for AgentCore Browser, Code Interpreter, Gateway,
  and remote MCP servers.
- Streaming response handling with tool-use trace, token usage, and latency
  metadata surfaced in node output.
- Session ID handling with deterministic extension for short user-supplied
  session keys, enabling multi-turn conversation support.
- Three importable example workflows: MCP research agent, Code Interpreter
  data analysis, webhook-triggered multi-turn support agent.

### Known limitations

- Supported regions are us-east-1, us-west-2, ap-southeast-2, eu-central-1.
- Inline n8n functions as tools are not supported in v0.1 (planned for v0.2).
- Memory is BYO-ARN; automatic memory provisioning is planned for v0.3.
- Custom container images are not supported in v0.1 (planned for v0.4).
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - YYYY-MM-DD

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
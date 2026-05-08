# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - YYYY-MM-DD

### Added

- Initial release of `n8n-nodes-bedrock-agentcore`
- `AgentCoreHarness` node with two operations:
  - **Run Agent**: auto-provisions an AgentCore Harness on first execution,
    reuses it across subsequent runs, and updates it when configuration changes.
  - **Invoke Existing Harness**: invokes a harness deployed outside n8n (CLI,
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

- Amazon Bedrock AgentCore Harness is in public preview; supported regions are
  us-east-1, us-west-2, ap-southeast-2, eu-central-1.
- Inline n8n functions as tools are not supported in v0.1 (planned for v0.2).
- Memory is BYO-ARN; automatic memory provisioning is planned for v0.3.
- Custom container images are not supported in v0.1 (planned for v0.4).
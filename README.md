# n8n-nodes-agentcore

An n8n community node for **Amazon Bedrock AgentCore Harness**. Run production-grade AI agents with isolated microVMs, real browsers, real code execution, and persistent memory — directly from your n8n workflows.

> **Public preview notice:** Amazon Bedrock AgentCore Harness is in public preview.
> This node targets the preview APIs and is supported in the four preview regions
> (us-east-1, us-west-2, ap-southeast-2, eu-central-1). APIs may evolve before GA.
> Pin this package to a specific version in production and review release notes
> before upgrading.

## Why this node?

n8n's native AI Agent node is great for simple agents, but hits walls fast: no cross-session memory, no real browser, no real code execution, and short execution timeouts. AgentCore Harness solves all four. This node is the bridge.

| Capability | Native n8n AI Agent | AgentCore Agent (this node) |
| ---------- | ------------------- | --------------------------- |
| Memory | Per-execution only | Cross-session, semantic, summary, episodic |
| Code execution | Sandboxed JS only | Full microVM with Python/Node/etc. |
| Browser | None | Cloud browser with real navigation |
| Session length | Workflow timeout | Up to 8 hours per session |
| Isolation | Shared process | Firecracker microVM per session |

## Features

- **Auto-provision & reuse** — Leave the Harness ARN blank: the node creates a harness on first run, reuses it across executions, and updates it when configuration changes
- **Bring your own harness** — Paste a Harness ARN (deployed via CLI / CloudFormation / console / Terraform) to invoke it directly, with any config field acting as a per-invocation override
- **Inline tool configuration** — AgentCore Browser, Code Interpreter, Gateway, and remote MCP servers
- **Streaming responses** with structured tool-use trace, token usage, and latency metadata
- **Session persistence** — pass the same session ID across executions for multi-turn conversations
- **Execution limits** — max iterations, max tokens, timeout

## Installation

### Via n8n UI (recommended)

1. Open n8n
2. **Settings → Community Nodes → Install a community node**
3. Enter `n8n-nodes-agentcore`
4. Accept the warning, click **Install**

### Manually

```bash
cd ~/.n8n
npm install n8n-nodes-agentcore
# restart n8n
```

## Prerequisites

You need:

1. **An AWS account** with Amazon Bedrock and AgentCore access in a supported region (us-east-1, us-west-2, ap-southeast-2, eu-central-1)
2. **AWS credentials** (access key + secret key) with the IAM policy below attached
3. **An IAM execution role** that the harness assumes when running, with a trust policy and permissions described below
4. **An enabled foundation model** in the Amazon Bedrock console (Claude Haiku, Sonnet, etc.)

### IAM setup

**1. Caller permissions** — the IAM user or role whose access keys go into the
n8n credential needs the actions listed in the [Required IAM permissions for
callers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html#harness-iam-callers)
table, scoped to your harness ARN(s).

**2. Trust policy** for the execution role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
```

**3. Permissions policy** for the execution role: use the
[Sample execution role policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html#harness-execution-role-policy)
maintained in the AgentCore developer guide. Append optional add-ons based on
what your workflow uses:

- BYO Memory ARN → AgentCore Memory add-on
- Gateway tool → AgentCore Gateway add-on
- (OpenAI / Gemini and OAuth-protected Gateway are v0.2 features — not needed for v0.1)

AWS maintains this policy and updates it as AgentCore ships new features —
single source of truth.

> v0.2 will replace this manual step with `agentcore iam create-execution-role`
> which generates the role automatically.

## Configuring credentials

In n8n, go to **Credentials → New → Amazon Bedrock AgentCore API** and fill in:

| Field | Value |
| ----- | ----- |
| Access Key ID | From your IAM user |
| Secret Access Key | From your IAM user |
| Session Token | Optional. Only for temporary STS credentials. |
| Region | The AgentCore-supported region you want to use |
| Execution Role ARN | The role ARN from Step 1 |

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

For a harness deployed outside n8n (CLI, console, CloudFormation, Terraform). The node calls `InvokeHarness` directly (~3 seconds). Any config field you fill in — Model, System Prompt, Tools, Max Iterations / Tokens, Timeout, Actor ID — is sent as a **per-invocation override**; leave a field blank to use the harness's own configuration. The Agent Name, Memory ARN, and Force Recreate fields are hidden in this mode because they only apply when the node owns the harness lifecycle.

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
  "toolUses": [{ "name": "exa", "toolUseId": "..." }],
  "usage": { "inputTokens": 234, "outputTokens": 567 },
  "latencyMs": 4123
}
```

## Examples

The `examples/` folder has three importable workflows:

1. **`01-mcp-research-agent.json`** — Research agent using Exa search (remote MCP)
2. **`02-code-interpreter.json`** — Data analyst agent that writes and runs Python
3. **`03-multiturn-support.json`** — Webhook-triggered support agent with session persistence

Import any of them via **Workflows → Import from File** in n8n.

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
npm link n8n-nodes-agentcore
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

### Step 1 — Final checks

```bash
npm run lint
npm run build
```

Make sure `dist/` contains `credentials/AgentCoreApi.credentials.js` and `nodes/AgentCoreHarness/AgentCoreHarness.node.js`.

### Step 2 — Bump version

```bash
npm version patch    # 0.1.0 → 0.1.1
# or
npm version minor    # 0.1.0 → 0.2.0
```

### Step 3 — Publish to npm

```bash
npm login            # if not already logged in
npm publish --access public
```

The package name `n8n-nodes-agentcore` matches n8n's required `n8n-nodes-*` convention, so n8n's community node scanner will discover it.

### Step 4 — Submit to n8n community nodes registry

1. Fork [`n8n-io/n8n-docs`](https://github.com/n8n-io/n8n-docs)
2. Add an entry in `docs/integrations/community-nodes/installation/`
3. Open a pull request referencing the npm package

### Step 5 — Announce

- Post in the n8n community forum under **Show and Tell**
- Link to the GitHub repo, the npm package, and one of the example workflows

## Roadmap

| Version | Capability |
| ------- | ---------- |
| **v0.1** (current) | Run Agent, Invoke Existing, MCP / Browser / Code Interpreter / Gateway tools, streaming, sessions |
| **v0.2** | n8n nodes as harness tools (inline functions). Sub-node-style tool wiring. |
| **v0.3** | Memory auto-provisioning. Today, BYO Memory ARN only. |
| **v0.4** | Custom container support (BYO Docker image) |
| **v0.5** | One-click CloudFormation quick-create for the IAM execution role |

## Limitations (v0.1)

- **Inline functions not yet supported.** v1 only supports AgentCore-native tools (MCP, Browser, Code Interpreter, Gateway). n8n nodes-as-tools wiring comes in v0.2.
- **No memory auto-provisioning.** Use the Memory ARN field to bring an existing memory.
- **No custom container support.** Default environment only.
- **First run is slow.** ~30 seconds for harness creation. Subsequent runs are instant.
- **Workflow static data** holds the harness ARN. Renaming an agent creates a new harness; the old one remains in your account until manually deleted.

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


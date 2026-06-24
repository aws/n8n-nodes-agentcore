# Quick Start — your first agent in ~5 minutes

This walks you from a fresh install to a working AI agent reply. No
infrastructure to set up — the node provisions the harness for you on the first
run. For the full feature reference see the [README](../README.md).

## Prerequisites (one-time)

1. **An AWS account** with Amazon Bedrock + AgentCore access in a supported
   region: `us-east-1`, `us-west-2`, `ap-southeast-2`, or `eu-central-1`.
2. **A Bedrock model enabled** — in the Bedrock console → **Model access**,
   enable an Anthropic Claude model (e.g. Claude Sonnet 4.6). *Skipping this is
   the #1 cause of "AccessDenied" on the first run.*
3. **AWS credentials** (access key + secret) for an IAM principal with the
   harness caller permissions, and an **execution role ARN** the harness assumes.
   See [IAM setup](../README.md#iam-setup). Trust policy:
   [`docs/iam-trust-policy.json`](./iam-trust-policy.json).

## Step 1 — Install the node

In n8n: **Settings → Community Nodes → Install**, enter
`@aws/n8n-nodes-agentcore`, accept, and install. Restart n8n if prompted.

## Step 2 — Add the credential

**Credentials → New → Amazon Bedrock AgentCore API**:

| Field | Value |
|---|---|
| Access Key ID | your IAM access key |
| Secret Access Key | your IAM secret |
| Region | e.g. `us-west-2` |
| Execution Role ARN | `arn:aws:iam::<account>:role/<your-harness-execution-role>` |

Click **Test** → you should see **"Connection successful"**. Save.

> Leave **Network Mode** = Public for the quick start. (VPC is for private
> resource access — see the README.)

## Step 3 — Add the node and run

1. In a new workflow, add a **Manual Trigger**, then add the **Amazon Bedrock
   AgentCore** node after it.
2. Attach the credential you just created.
3. Fill in:

| Field | Value |
|---|---|
| Harness ARN | *(leave blank — this is what makes the node provision & reuse a harness for you)* |
| Agent Name | `my_first_agent` |
| Model Provider | `Amazon Bedrock` |
| Model ID | `global.anthropic.claude-sonnet-4-6` |
| System Prompt | `You are a helpful assistant. Keep answers to 2-3 sentences.` |
| Prompt | `In one short paragraph, what is Amazon Bedrock AgentCore?` |

4. Click **Execute workflow** (or **Test step**).

**First run takes ~30 seconds** — the node is creating the harness. Subsequent
runs reuse it and return in a few seconds. That delay is expected, not a hang.

## Step 4 — Read the output

You'll get JSON like:

```json
{
  "operation": "run",
  "agentName": "my_first_agent",
  "harnessId": "my_first_agent-abc1234567",
  "sessionId": "…",
  "sessionSource": "generated",
  "harness": {
    "status": "READY",
    "memory": { "mode": "managed", "arn": "arn:aws:bedrock-agentcore:…:memory/…" },
    "model": { "provider": "bedrock", "modelId": "global.anthropic.claude-sonnet-4-6" }
  },
  "response": "Amazon Bedrock AgentCore is …",
  "usage": { "inputTokens": 812, "outputTokens": 41 },
  "latencyMs": 4123
}
```

- `response` is the agent's answer.
- `harness.memory.mode: "managed"` means memory was auto-provisioned for you.
- `sessionSource: "generated"` means this run started a **new** conversation.

## Step 5 — Make it remember (multi-turn)

To continue a conversation across runs, set a **stable Session ID** and reuse it:

1. Set **Session ID** = `quickstart-session-1`.
2. Run with prompt: `My favorite color is teal. Remember it.`
3. Change only the prompt to `What's my favorite color?` and run again — keep the
   same Session ID.

The second run answers "teal", and the output shows
`sessionSource: "provided"`. (Leaving Session ID blank starts a fresh
conversation every run — that's the most common "it didn't remember" surprise.
See [memory & sessions](../README.md#memory--sessions) in the README.)

## Where to go next

- **Tools** — add a Code Interpreter, Browser, or remote MCP tool to the node.
- **Other models** — switch Model Provider to OpenAI / Gemini / LiteLLM (needs an
  API key ARN), or use Bedrock Mantle without a key.
- **Examples** — import any workflow from [`examples/`](../examples).
- **Full reference + troubleshooting** — the [README](../README.md).

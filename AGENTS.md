# n8n-nodes-agentcore

n8n community node for **Amazon Bedrock AgentCore harness**. Lets n8n
workflow authors run config-driven AI agents on AgentCore from inside
their workflows without writing infrastructure code.

This file is read by AI coding agents (Claude, Cursor, GitHub Copilot
Workspace, Amazon Q) and by humans onboarding to the repo. Treat it as
authoritative for the conventions below.

## What this package is, and isn't

- It is an n8n community node distributed on npm as `@aws/n8n-nodes-agentcore`.
- It targets the **AgentCore harness** primitive (declarative spec),
  not AgentCore Runtime (the container-hosting primitive).
- It is **not** a general-purpose Bedrock client. It only speaks the
  Harness control plane (`bedrock-agentcore-control`) and data plane
  (`bedrock-agentcore`), called directly over HTTPS.
- It is **not** a wrapper around the AgentCore CLI, and (as of the SDK-free
  rewrite) **not** built on the AWS SDK. Harness-consumer logic calls the
  AgentCore REST APIs directly with `fetch` + an inline SigV4 signer.

## Repo layout

```
.
├── credentials/
│   └── AgentCoreApi.credentials.ts   # n8n credential type: AWS keys + region + execution role ARN
├── nodes/
│   └── AgentCoreHarness/
│       ├── AgentCoreHarness.node.ts          # Node entrypoint: describes UI, implements execute()
│       ├── AgentCoreHarness.node.json        # n8n codex metadata (categories, docs URLs)
│       ├── agentcore.svg                     # Node icon (copied to dist/ by gulp)
│       ├── descriptions/
│       │   ├── Common.ts                     # Shared `toolsField` (fixedCollection for all 6 tool types)
│       │   └── HarnessFields.ts              # Full single-operation field set (model, memory, skills, auth, provisioning)
│       └── helpers/
│           ├── client.ts                     # Credential resolution + VPC config + waitForHarnessReady polling
│           ├── model.ts                      # buildModelConfig() multi-provider union
│           ├── memory.ts                     # buildMemoryConfig()/Update() managed/BYO/disabled
│           ├── environment.ts                # VPC network + filesystem mounts + container artifact
│           ├── skills.ts                     # buildSkillsArray() aws/git/s3/path
│           ├── versioning.ts                 # list versions, upsert named endpoint
│           ├── oauth.ts                       # raw-HTTPS Bearer invoke + event-stream decode
│           ├── stream.ts                     # InvokeHarness streaming consumer (+ tool-use input)
│           └── tools.ts                      # buildToolsArray() + configHash() for drift detection
├── docs/
│   ├── QUICKSTART.md                 # Install to first agent reply in ~5 minutes
│   ├── SPEC.md                       # The canonical spec - source of truth for v0.x scope
│   └── iam-trust-policy.json         # Execution-role trust policy template (the only IAM policy shipped; permission policies live in the AWS harness security guide, linked from README)
├── examples/                         # Importable workflows: 01-08 are single-feature, 09 verifies the memory guarantees
│   ├── 01-mcp-research-agent.json
│   ├── 02-code-interpreter.json
│   ├── 03-multiturn-support.json
│   ├── 04-multi-provider-switch.json
│   ├── 05-oauth-invoke.json
│   ├── 06-skills-agent.json
│   ├── 07-inline-function-roundtrip.json
│   ├── 08-vpc-filesystem.json
│   ├── 09-memory-isolation-test.json
│   └── templates/                    # End-to-end workflows that pair the node with other n8n nodes; these are what get published to n8n's template library, so they follow n8n's sticky-note and naming guidelines
│       ├── calculate-campaign-statistics-from-a-webhook.json
│       ├── remember-each-customer-across-chat-sessions.json
│       └── add-long-term-memory-to-an-n8n-ai-agent.json
├── scripts/
│   └── check-template-export.mjs     # Pre-submission scan for a workflow exported from the n8n editor (credential IDs, instance fingerprint, pinned run data, secrets)
├── package.json
└── tsconfig.json
```

## Operations

The node exposes one resource (`AgentCoreHarness`) with two operations:

1. **Run Agent** (`run`) - auto-provisions a Harness on first execution
   keyed by the user-supplied **Agent Name**, reuses it on subsequent runs,
   and calls `UpdateHarness` when the configuration hash drifts. This is
   the primary path.
2. **Invoke Existing Harness** (`invokeExisting`) - BYO ARN. For Harnesses
   created via the AgentCore CLI, console, CloudFormation, or Terraform.

The Run Agent lifecycle lives in `runAgent()` in
`AgentCoreHarness.node.ts`. The cache is workflow static data; AWS is the
source of truth, so static-data misses fall back to `ListHarnesses` before
calling `CreateHarness`.

## Build, lint, type-check, test

```
npm run build         # tsc + icon/codex copy -> dist/
npm run dev           # tsc --watch
npm run lint          # eslint with eslint-plugin-n8n-nodes-base
npm run typecheck     # tsc --noEmit (strict mode)
npm test              # vitest run (unit tests under test/)
npm run test:watch    # vitest in watch mode
npm run format        # prettier --write
npm run format:check  # prettier --check (used in CI)
npm run security:audit  # npm audit --audit-level=high --omit=dev
npm run secrets:check   # secretlint
```

Unit tests live in `test/` and run with vitest. They are pure and offline
(mocked `fetch`, fixture bytes) — no AWS credentials or network required — so
they run in CI on every PR. The SigV4 signer (`helpers/sigv4.ts`), the
event-stream decoder (`helpers/eventstream.ts`), and the config builders are
directly unit-tested; keep them covered when changing behavior. vitest is a
**dev dependency only** — it must never move to `dependencies`, since verified
community nodes ship with zero runtime dependencies.

Local testing against a real n8n is done via `npm link` into
`~/.n8n/custom/`. See `README.md` "Local development" for the full flow.

## Runtime dependencies - keep this list at ZERO

The package ships with **zero** production dependencies. n8n's community-node
verification (and n8n Cloud) forbid runtime dependencies, so AWS calls are made
with the global `fetch`, an inline SigV4 signer (`helpers/sigv4.ts`, `node:crypto`
only), and an inline event-stream decoder (`helpers/eventstream.ts`). The AWS SDK
was removed for exactly this reason.

**Do not add a runtime dependency.** Any entry in `package.json` `dependencies`
breaks verification and will fail n8n's scanner (`@n8n/scan-community-package`).
If you think you need one:

- First try a small inline helper (the SigV4 signer and event-stream decoder are
  the precedent — both were reimplemented inline rather than pulled in).
- If it is genuinely unavoidable, it is a scope/verification decision, not a
  routine change - discuss before adding.

`n8n-workflow` is a peer dep, supplied by n8n at runtime. Never bundle it. The
AWS SDK and `@smithy/*` are retained only as **devDependencies** for the offline
signer-parity tests; they must never move to `dependencies`.

## Security invariants (enforced in CI)

These come directly from `docs/SPEC.md` §9 and are checked in
`.github/workflows/lint.yml` (the `no-eval` job):

- **No `eval`, `new Function(...)`, `child_process` import, `spawn`,
  `spawnSync`, `writeFile`, `writeFileSync`, or `appendFileSync` in
  `nodes/` or `credentials/`.** All risky execution happens inside AWS
  microVMs, not inside the n8n process.
- Credentials are read from the n8n credential vault per execution via
  `getCredentials('agentCoreApi')`. They are never persisted by the
  node and never logged.
- TLS 1.2+ comes from Node's `fetch` default (all endpoints are hardcoded
  `https://`, cert validation is never disabled). SigV4 signing is done inline
  in `helpers/sigv4.ts` using `node:crypto`; do not weaken either.
- TypeScript strict mode is non-negotiable (see `tsconfig.json`).

## n8n conventions specific to this repo

- The node version (`description.version`) is `2`. Bump it only on a
  **breaking change to the node's UI fields**, never on logic-only changes.
  Version bumps strand existing workflows on the old version - only the
  next version's typeVersion-aware fields apply to new placements. Any
  workflow JSON in `examples/` must carry `"typeVersion": 2` to match.
- The package.json `n8n` field points to compiled JS paths under `dist/`.
  Adding a new node or credential requires updating that field.
- The icon (`agentcore.svg`) must be referenced as `file:agentcore.svg`
  in the node description; gulp copies it next to the compiled JS.
- The codex metadata in `AgentCoreHarness.node.json` controls how the
  node surfaces in the n8n node-palette search and the
  Development/Utility category filters.
- Use `INodeProperties` types from `n8n-workflow` for all field
  definitions. Avoid `as any` casts in field definitions - they break
  n8n's UI validation.

### Workflows in `examples/templates/`

These get published to n8n's public template library, so they follow n8n's
Creator hub guidelines rather than our own preferences:

- **Exactly one overview sticky.** Omit the `color` field so it renders the
  default yellow; 100 to 300 words; must contain `### How it works` and
  `### Setup`.
- **Section stickies** use `color: 7` (white/grey), stay under 50 words, and are
  sized to cover a *group* of nodes. A node sitting outside every section sticky
  is a review comment waiting to happen.
- **Rename every node** to say what it does. Trigger and action nodes get
  descriptive names (`When Campaign Data Received`, not `Webhook`); the standard
  AI sub-nodes keep their default names (`AI Agent`, `OpenAI Chat Model`,
  `Simple Memory`), matching what n8n's own published partner templates do.
- **No real identifiers.** Credential IDs stay as `REPLACE_WITH_...` placeholders,
  `meta.instanceId` stays zeroed, and `pinData` stays empty. Run
  `node scripts/check-template-export.mjs <file>` before submitting anything
  exported from the editor; the editor bakes in your real credential IDs.
- **Turn on `addTools` whenever tools are configured** (same for `addSkills`).
  With the toggle off the section is ignored at runtime and the agent answers
  from the model alone, which still looks plausible.
- **Anything the workflow labels as verified must actually be checked.** If a
  Code node computes a `verified` flag, recompute every figure it vouches for.

## Versioning

Semantic versioning. v0.x is pre-1.0; minor versions may add fields but
will not break existing workflow configurations. Every deferred feature
is additive when it lands - see `docs/SPEC.md` §13 "Versioning and
compatibility" and the change-log in `CHANGELOG.md`.

The roadmap from `docs/SPEC.md`:

| Version | Adds                                                        |
|---------|-------------------------------------------------------------|
| v0.1    | Run Agent, Invoke Existing, MCP/Browser/CodeInterp/Gateway tools |
| v0.2    | Multi-provider models, managed memory, VPC, custom containers, filesystem mounts, skills, inline functions, versions & endpoints |
| v0.4    | OAuth Bearer Token on the credential, Add Tools / Add Skills toggles, AWS calls through n8n's HTTP helper, node `typeVersion` 2 (current) |
| later   | ExecuteCommand (shell) with Bearer, custom Browser / Code Interpreter resource ARNs, CloudFormation quick-create for the execution role, Export to Code, Step Functions |

Anything outside that list is "open question" - discuss before
implementing.

## Branch protection and review

The `main` branch is protected. No merges without PR review by
`@aws/bedrock-agentcore-moab`. No admin bypass. CI checks must pass:

- CodeQL / Analyze
- Quality and Safety Checks (lint, typecheck, format, security, secrets, no-eval)
- Build and Pack
- Validate PR Title
- Dependency Review

This applies equally to maintainers' own PRs.

## Conventional Commits

PR titles must match Conventional Commits format, enforced by
`.github/workflows/pr-title.yml`. Allowed types: `feat`, `fix`, `docs`,
`style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Subjects must start with a lowercase letter. Example:

    feat: add memory auto-provisioning for run agent

The squash-merge default means the PR title becomes the commit message
on `main`, which feeds the auto-generated release notes.

## Release process

Releases are gated by two human approvals: (1) the release-PR merge,
and (2) the `npm-publish` GitHub Environment approval. See
`.github/workflows/release.yml` for the full flow. npm publishing uses
OIDC trusted publishing - there is no `NPM_TOKEN` in this repo and there
should not be one.

## When in doubt

- Spec questions -> `docs/SPEC.md`.
- AgentCore API questions ->
  https://docs.aws.amazon.com/bedrock-agentcore/.
- n8n node API questions ->
  https://docs.n8n.io/integrations/creating-nodes/.
- Don't guess on AWS SDK shapes - read the type definitions in
  `node_modules/@aws-sdk/client-bedrock-agentcore-control/dist-types/`.

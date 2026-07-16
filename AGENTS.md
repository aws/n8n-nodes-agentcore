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
  Harness control plane (`@aws-sdk/client-bedrock-agentcore-control`)
  and data plane (`@aws-sdk/client-bedrock-agentcore`).
- It is **not** a wrapper around the AgentCore CLI. Harness-consumer
  logic is implemented directly on the AWS SDK v3 clients.

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
│   ├── SPEC.md                       # The canonical spec - source of truth for v0.x scope
│   └── iam-trust-policy.json         # Execution-role trust policy template (the only IAM policy shipped; permission policies live in the AWS harness security guide, linked from README)
├── examples/                         # Importable example workflows (01-08)
│   ├── 01-mcp-research-agent.json
│   ├── 02-code-interpreter.json
│   ├── 03-multiturn-support.json
│   ├── 04-multi-provider-switch.json
│   ├── 05-oauth-invoke.json
│   ├── 06-skills-agent.json
│   ├── 07-inline-function-roundtrip.json
│   └── 08-vpc-filesystem.json
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
npm run build         # tsc + gulp icon copy -> dist/
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

## Runtime dependencies - keep this list short

Today the package has **two** production deps:

- `@aws-sdk/client-bedrock-agentcore`
- `@aws-sdk/client-bedrock-agentcore-control`

Both are Apache-2.0 and AWS-maintained. **Adding a runtime dependency is
a security-review event** - it ships into every n8n install that adopts
this node. Before adding one, confirm:

- License is permissive (Apache-2.0, MIT, BSD, ISC). The
  `dependency-review` workflow enforces this.
- It is actively maintained.
- It does not pull in transitive deps with `exec`, `eval`, or native
  bindings unless absolutely necessary.
- It cannot be replaced by a small inline helper.

`n8n-workflow` is a peer dep, supplied by n8n at runtime. Never bundle it.

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
- TLS 1.2+ and SigV4 signing are inherited from `@aws-sdk` defaults;
  do not override them.
- TypeScript strict mode is non-negotiable (see `tsconfig.json`).

## n8n conventions specific to this repo

- The node version (`description.version`) is `1`. Bump it only on a
  **breaking change to the node's UI fields**, never on logic-only changes.
  Version bumps strand existing workflows on the old version - only the
  next version's typeVersion-aware fields apply to new placements.
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

## Versioning

Semantic versioning. v0.x is pre-1.0; minor versions may add fields but
will not break existing workflow configurations. Every deferred feature
is additive when it lands - see `docs/SPEC.md` §13 "Versioning and
compatibility" and the change-log in `CHANGELOG.md`.

The roadmap from `docs/SPEC.md`:

| Version | Adds                                                        |
|---------|-------------------------------------------------------------|
| v0.1    | Run Agent, Invoke Existing, MCP/Browser/CodeInterp/Gateway tools |
| v0.2    | Inline functions (n8n sub-nodes as harness tools)           |
| v0.3    | Memory auto-provisioning (BYO Memory ARN today)             |
| v0.4    | Custom container support                                    |
| v0.5    | CloudFormation quick-create for the execution role          |

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

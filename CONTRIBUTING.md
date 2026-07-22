# Contributing to n8n-nodes-agentcore

Thank you for your interest in contributing. This document describes the process
for bug reports, feature requests, and code contributions.

## Reporting bugs and requesting features

Use [GitHub Issues](https://github.com/aws/n8n-nodes-agentcore/issues).
Before opening an issue, please search existing issues to avoid duplicates.

A good bug report includes:

- Node version (`n8n-nodes-agentcore` version from `package.json`)
- n8n version and how you are running it (community, self-hosted, Docker, etc.)
- AWS region
- The operation you were performing (Run Agent or Invoke Existing Harness)
- Minimum reproducing workflow (export and attach if possible — **redact
  credentials first**)
- Expected vs. actual behavior
- Full error message and any relevant logs

For security issues, please see [SECURITY.md](./SECURITY.md) instead of opening
a public issue.

## Contributing code

### Developer Certificate of Origin (DCO)

By contributing, you certify that you wrote the code or have the right to
contribute it under this project's license (Apache-2.0). All commits must
include a sign-off line:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use `git commit -s` to add this automatically. Pull requests without sign-offs
will be asked to amend commits before merge.

### Development setup

Prerequisites:

- Node.js 20 or later
- npm 10 or later
- An n8n instance for local testing (any supported version)
- AWS credentials with AgentCore Harness access for end-to-end testing

Setup:

```bash
git clone https://github.com/aws/n8n-nodes-agentcore.git
cd n8n-nodes-agentcore
npm install
npm run build
npm test
```

To test against a local n8n instance, see the "Local development" section of
[README.md](./README.md).

### Running tests

Unit tests run with [vitest](https://vitest.dev/) and live under `test/`:

```bash
npm test          # run the suite once
npm run test:watch  # re-run on change while developing
```

Tests are pure and offline (no AWS credentials or network needed) — the AWS
request/response paths are exercised with mocked `fetch` and known-good fixtures.
`npm test` also runs in CI on every pull request and must pass before merge.

Please add or update tests for any behavior you change. Pure helpers (config
builders, the SigV4 signer, the event-stream decoder, the stream accumulator)
are directly unit-testable and should stay covered. For end-to-end behavior
against live AWS, include a manual test plan in the PR as well.

### Before submitting a pull request

- [ ] `npm run lint` passes with zero errors
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes, and new or changed behavior has unit tests
- [ ] `npm run build` completes cleanly
- [ ] End-to-end behavior is covered by a manual test plan in the PR description
- [ ] Documentation is updated (README, inline JSDoc, or example workflows
      as applicable)
- [ ] If adding a runtime dependency, explain why it is necessary — note that
      verified community nodes must ship with **zero** runtime dependencies, so
      new runtime deps are generally not accepted

### Pull request process

1. Fork the repository and create a feature branch from `main`
2. Make your changes with clear, descriptive commits
3. Ensure all commits are signed off (`git commit -s`)
4. Open a pull request with:
   - A description of the problem and solution
   - A manual test plan with reproduction steps
   - Links to any related issues
5. Address review feedback; we may ask for changes
6. Once approved, a maintainer will merge

We squash-merge by default, so commit history within a PR is not preserved —
but your sign-off must still be present on at least one commit.

### Style

- TypeScript, strict mode enabled (see `tsconfig.json`)
- Follow the existing code style enforced by ESLint and Prettier
- Run `npm run lintfix` and `npm run format` before submitting

### Scope of contributions

Contributions welcome in all of these areas:

- Bug fixes
- Documentation improvements (README, JSDoc, example workflows)
- New tool types as they become available in AgentCore Harness
- Additional example workflows demonstrating useful patterns
- Test coverage improvements

Contributions that expand the scope significantly (new operations, breaking
changes to the credential shape, restructured node architecture) should start
as an issue for design discussion before code is written.

## Code of Conduct

This project follows the [Amazon Open Source Code of Conduct](./CODE_OF_CONDUCT.md).
By participating, you agree to uphold this code.

## License

By contributing, you agree that your contributions will be licensed under the
project's [Apache-2.0 license](./LICENSE)
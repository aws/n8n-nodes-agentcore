# Reporting Security Issues

We take all security reports seriously. If you believe you have found a security
issue in this project, please report it as described below. **Do not create a
public GitHub issue** for security vulnerabilities.

## Reporting a vulnerability

Please report security issues to AWS Security via
**aws-security@amazon.com**, or directly via the
[AWS Vulnerability Reporting page](https://aws.amazon.com/security/vulnerability-reporting/).

Include the following in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept
- The version of `n8n-nodes-agentcore` affected
- Your n8n version and deployment environment (self-hosted, Docker, etc.)
- Any known mitigations or workarounds

Please do **not** include sensitive data (credentials, customer PII,
production URLs) in the report body. If you need to share sensitive
reproduction data, indicate that in your initial report and we will
coordinate a secure channel.

## Response process

- We will acknowledge receipt within **3 business days**
- We will provide an initial assessment within **7 business days**
- For confirmed issues, we will coordinate a fix and disclosure timeline with
  the reporter
- Fixes will be released as a patch version on npm with a corresponding
  GitHub Security Advisory

## Scope

In scope:

- Vulnerabilities in the `n8n-nodes-agentcore` package code, its
  credentials handler, or its interaction with the AWS SDK
- Credential leakage, improper session handling, insecure defaults in the node
- Supply chain concerns about the published npm artifact

Out of scope:

- Vulnerabilities in n8n itself — please report those to
  [n8n's security process](https://docs.n8n.io/reference/security/)
- Vulnerabilities in Amazon Bedrock AgentCore — please report via the
  [AWS Vulnerability Reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
- Vulnerabilities in third-party MCP servers, tool providers, or foundation
  models invoked through this node — please report to the respective vendors
- Issues in user-authored n8n workflows that happen to use this node

## Safe harbor

AWS considers good-faith security research to be authorized activity that is
protected. For details, see the
[AWS vulnerability disclosure policy](https://aws.amazon.com/security/vulnerability-reporting/).

## Thanks

We appreciate the security community's efforts. Reporters who follow this
process and help us ship a fix will be credited in the advisory (unless they
prefer to remain anonymous).
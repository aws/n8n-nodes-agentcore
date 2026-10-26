/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Client identification on AgentCore requests.
 *
 * Every request this node makes carries a product token naming the node, so
 * AgentCore usage that originates in n8n is distinguishable from usage by the
 * AWS SDK, the AgentCore CLI, or the console. Without it the node's traffic is
 * indistinguishable from any other hand-rolled SigV4 caller, because this
 * package is SDK-free and therefore sends none of the SDK's `aws-sdk-js/...`
 * identification.
 *
 * This is client identification, not telemetry. It adds two headers to requests
 * the workflow already sends to the user's own AWS account: no additional
 * request is made, no third party is contacted, and no workflow, prompt,
 * credential, or end-user data is included. The value is a fixed string.
 *
 * The two headers are signed differently, matching the AWS SDK
 * (`@smithy/signature-v4`):
 *
 *  - `x-amz-user-agent` is added BEFORE signing (`withAmzUserAgent`), so it is
 *    part of the SigV4 signed header set. The SDK signs it, and AWS expects
 *    `x-amz-*` headers that are sent to be signed.
 *  - `User-Agent` is added AFTER signing (`withUserAgent`). It is listed in the
 *    SDK's `ALWAYS_UNSIGNABLE_HEADERS`, and signing it would make the signature
 *    fragile if n8n's HTTP layer or an intermediate proxy rewrote the header.
 *
 * On the Bearer path nothing is signed, so both are simply added.
 *
 * No version is included in the token. The release workflow bumps
 * `package.json` in CI, so a version hardcoded here would be stale on every
 * release, and reading `package.json` at runtime is not an option: verified
 * community nodes must not read files.
 */

/** Product token identifying this node on the wire. */
export const USER_AGENT = 'n8n-nodes-agentcore';

/**
 * Returns a copy of `headers` with `x-amz-user-agent` added. Call this on the
 * headers passed INTO `signRequest()` so the header is signed. The input is not
 * mutated.
 *
 * `x-amz-user-agent` is sent alongside `User-Agent` because n8n's HTTP helper
 * owns the `User-Agent` header and may set its own value; the `x-amz-` form is
 * left alone by the HTTP layer and is the header the AWS SDK falls back to
 * wherever `User-Agent` is not settable by the caller.
 */
export function withAmzUserAgent(headers: Record<string, string>): Record<string, string> {
	return { ...headers, 'x-amz-user-agent': USER_AGENT };
}

/**
 * Returns a copy of `headers` with `User-Agent` added. Call this on the headers
 * RETURNED by `signRequest()`, so `User-Agent` stays out of the signed header
 * set. The input is not mutated.
 */
export function withUserAgent(headers: Record<string, string>): Record<string, string> {
	return { ...headers, 'User-Agent': USER_AGENT };
}

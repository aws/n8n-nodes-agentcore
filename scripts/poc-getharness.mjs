/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 *
 * POC: prove the SDK-free SigV4 + fetch path returns the same GetHarness result
 * as the AWS SDK. Run against live AWS with real (temporary) credentials.
 *
 * Usage:
 *   export AWS_ACCESS_KEY_ID=...
 *   export AWS_SECRET_ACCESS_KEY=...
 *   export AWS_SESSION_TOKEN=...          # if temporary creds
 *   export AWS_REGION=us-west-2
 *   export HARNESS_ID=<an existing harness id>
 *   node scripts/poc-getharness.mjs
 *
 * It prints both responses and whether the status/body match.
 */
import { signRequest } from '../nodes/AgentCoreHarness/helpers/sigv4.ts';

const region = process.env.AWS_REGION || 'us-west-2';
const harnessId = process.env.HARNESS_ID;
const credentials = {
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	sessionToken: process.env.AWS_SESSION_TOKEN,
};

if (!harnessId) {
	console.error('Set HARNESS_ID to an existing harness id.');
	process.exit(1);
}
if (!credentials.accessKeyId || !credentials.secretAccessKey) {
	console.error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
	process.exit(1);
}

// ---- Path A: new SDK-free SigV4 + fetch ----
async function getHarnessSdkFree() {
	const host = `bedrock-agentcore-control.${region}.amazonaws.com`;
	const url = `https://${host}/harnesses/${encodeURIComponent(harnessId)}`;
	const headers = signRequest(
		{ method: 'GET', url, headers: { 'content-type': 'application/json' }, body: '' },
		{ region, service: 'bedrock-agentcore', credentials },
	);
	const res = await fetch(url, { method: 'GET', headers });
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

// ---- Path B: AWS SDK (ground truth) ----
async function getHarnessSdk() {
	const { BedrockAgentCoreControlClient, GetHarnessCommand } = await import(
		'@aws-sdk/client-bedrock-agentcore-control'
	);
	const client = new BedrockAgentCoreControlClient({ region, credentials });
	const out = await client.send(new GetHarnessCommand({ harnessId }));
	// Strip SDK metadata for a clean compare.
	const { $metadata, ...rest } = out;
	return { status: $metadata.httpStatusCode, body: rest };
}

const a = await getHarnessSdkFree().catch((e) => ({ error: String(e) }));
const b = await getHarnessSdk().catch((e) => ({ error: String(e) }));

console.log('\n=== SDK-FREE (SigV4 + fetch) ===');
console.log(JSON.stringify(a, null, 2));
console.log('\n=== SDK (ground truth) ===');
console.log(JSON.stringify(b, null, 2));

// Compare the fields the node actually consumes.
const aStatus = a.status;
const bStatus = b.status;
const aName = a.body?.harness?.name ?? a.body?.name;
const bName = b.body?.harness?.name ?? b.body?.name;
const aArn = a.body?.harness?.harnessArn ?? a.body?.harnessArn;
const bArn = b.body?.harness?.harnessArn ?? b.body?.harnessArn;

console.log('\n=== COMPARISON ===');
console.log('status match:', aStatus === bStatus, `(${aStatus} vs ${bStatus})`);
console.log('name match:  ', aName === bName, `(${aName} vs ${bName})`);
console.log('arn match:   ', aArn === bArn);
console.log(
	'\nRESULT:',
	aStatus === 200 && aStatus === bStatus && aArn === bArn
		? 'PASS — SigV4 + fetch matches the SDK ✅'
		: 'CHECK the output above ❌',
);

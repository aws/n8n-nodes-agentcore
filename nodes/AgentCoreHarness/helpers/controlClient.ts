/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * SDK-free control-plane client for the AgentCore harness APIs.
 *
 * Each method maps to a REST-JSON operation (method/path taken from the service
 * model) and returns the parsed response envelope, matching the shapes the rest
 * of the node already consumes (e.g. `{ harness: {...} }`, `{ harnessVersions:
 * [...] }`). This replaces `@aws-sdk/client-bedrock-agentcore-control` so the
 * package ships with no runtime dependencies.
 *
 * A not-found lookup throws an Error whose `name` is `ResourceNotFoundException`
 * so existing callers (endpoint upsert) can branch on it exactly as they did
 * with the SDK.
 */
import { controlRequest, type AwsCallerConfig } from './httpClient';

/**
 * Path segments are passed through raw. The SigV4 signer (`sigv4.ts`,
 * `encodePath`) is the single place that URI-encodes the path, so segments are
 * encoded exactly once — matching how `@smithy/signature-v4` handles paths and
 * avoiding double-encoding (e.g. a space becoming `%2520`). Callers must pass
 * un-encoded identifiers.
 */
export class ControlClient {
	constructor(private readonly config: AwsCallerConfig) {}

	async createHarness(input: Record<string, unknown>): Promise<any> {
		return controlRequest(this.config, { method: 'POST', path: '/harnesses', body: input });
	}

	async getHarness(harnessId: string): Promise<any> {
		return controlRequest(this.config, {
			method: 'GET',
			path: `/harnesses/${harnessId}`,
		});
	}

	async updateHarness(harnessId: string, input: Record<string, unknown>): Promise<any> {
		// harnessId is a path label, not part of the body.
		const { harnessId: _omit, ...body } = input as Record<string, unknown>;
		void _omit;
		return controlRequest(this.config, {
			method: 'PATCH',
			path: `/harnesses/${harnessId}`,
			body,
		});
	}

	async deleteHarness(harnessId: string, deleteManagedMemory = false): Promise<any> {
		return controlRequest(this.config, {
			method: 'DELETE',
			path: `/harnesses/${harnessId}`,
			query: { deleteManagedMemory: String(deleteManagedMemory) },
		});
	}

	async listHarnesses(input: { maxResults?: number; nextToken?: string }): Promise<any> {
		return controlRequest(this.config, {
			method: 'GET',
			path: '/harnesses',
			query: { maxResults: input.maxResults, nextToken: input.nextToken },
		});
	}

	async listHarnessVersions(
		harnessId: string,
		input: { maxResults?: number; nextToken?: string },
	): Promise<any> {
		return controlRequest(this.config, {
			method: 'GET',
			path: `/harnesses/${harnessId}/versions`,
			query: { maxResults: input.maxResults, nextToken: input.nextToken },
		});
	}

	async listHarnessEndpoints(
		harnessId: string,
		input: { maxResults?: number; nextToken?: string },
	): Promise<any> {
		return controlRequest(this.config, {
			method: 'GET',
			path: `/harnesses/${harnessId}/endpoints`,
			query: { maxResults: input.maxResults, nextToken: input.nextToken },
		});
	}

	async getHarnessEndpoint(harnessId: string, endpointName: string): Promise<any> {
		return controlRequest(this.config, {
			method: 'GET',
			path: `/harnesses/${harnessId}/endpoints/${endpointName}`,
		});
	}

	async createHarnessEndpoint(harnessId: string, input: Record<string, unknown>): Promise<any> {
		const { harnessId: _omit, ...body } = input as Record<string, unknown>;
		void _omit;
		return controlRequest(this.config, {
			method: 'POST',
			path: `/harnesses/${harnessId}/endpoints`,
			body,
		});
	}

	async updateHarnessEndpoint(
		harnessId: string,
		endpointName: string,
		input: Record<string, unknown>,
	): Promise<any> {
		const { harnessId: _h, endpointName: _e, ...body } = input as Record<string, unknown>;
		void _h;
		void _e;
		return controlRequest(this.config, {
			method: 'PATCH',
			path: `/harnesses/${harnessId}/endpoints/${endpointName}`,
			body,
		});
	}
}

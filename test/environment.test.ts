/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	buildEnvironment,
	buildEnvironmentUpdate,
	buildEnvironmentArtifact,
	buildEnvironmentArtifactUpdate,
} from '../nodes/AgentCoreHarness/helpers/environment';

const VPC = { networkMode: 'VPC' as const, subnets: ['subnet-a'], securityGroups: ['sg-a'] };

describe('buildEnvironment (CreateHarness shape)', () => {
	it('returns undefined when there is nothing to configure', () => {
		// Omitting the field on create means "use the service default", which is
		// what we want: no VPC, no mounts, nothing to say.
		expect(buildEnvironment({})).toBeUndefined();
		expect(buildEnvironment({ vpc: undefined, mounts: [] })).toBeUndefined();
	});

	it('builds a VPC network configuration', () => {
		expect(buildEnvironment({ vpc: VPC })).toEqual({
			agentCoreRuntimeEnvironment: {
				networkConfiguration: {
					networkMode: 'VPC',
					networkModeConfig: { subnets: ['subnet-a'], securityGroups: ['sg-a'] },
				},
			},
		});
	});

	it('rejects VPC mode without a subnet', () => {
		expect(() => buildEnvironment({ vpc: { networkMode: 'VPC', subnets: [], securityGroups: [] } })).toThrow(
			/at least one subnet/i,
		);
	});

	it('rejects EFS and S3 Files mounts outside a VPC', () => {
		expect(() =>
			buildEnvironment({
				mounts: [{ type: 'efsAccessPoint', mountPath: '/data', accessPointArn: 'arn:efs' }],
			}),
		).toThrow(/require VPC network mode/i);
	});

	it('allows session storage without a VPC', () => {
		expect(buildEnvironment({ mounts: [{ type: 'sessionStorage', mountPath: '/scratch' }] })).toEqual({
			agentCoreRuntimeEnvironment: {
				filesystemConfigurations: [{ sessionStorage: { mountPath: '/scratch' } }],
			},
		});
	});
});

describe('buildEnvironmentUpdate (UpdateHarness shape)', () => {
	// Regression: an UpdateHarness call that omits `environment` leaves the stored
	// value untouched, so switching the credential from VPC back to Public used to
	// leave the harness running in the VPC indefinitely. The update payload must
	// always state the environment, including the default.
	it('never returns undefined, so an earlier environment is always replaced', () => {
		expect(buildEnvironmentUpdate({})).toBeDefined();
		expect(buildEnvironmentUpdate({ vpc: undefined, mounts: [] })).toBeDefined();
	});

	it('states PUBLIC explicitly when nothing is configured', () => {
		expect(buildEnvironmentUpdate({ vpc: undefined, mounts: [] })).toEqual({
			agentCoreRuntimeEnvironment: {
				networkConfiguration: { networkMode: 'PUBLIC' },
			},
		});
	});

	it('clears a VPC configuration when the credential no longer asks for one', () => {
		const asVpc = buildEnvironmentUpdate({ vpc: VPC });
		const asPublic = buildEnvironmentUpdate({ vpc: undefined });

		const vpcMode = (asVpc as any).agentCoreRuntimeEnvironment.networkConfiguration.networkMode;
		const publicMode = (asPublic as any).agentCoreRuntimeEnvironment.networkConfiguration
			.networkMode;

		expect(vpcMode).toBe('VPC');
		expect(publicMode).toBe('PUBLIC');
		// The two payloads must differ, otherwise the harness config hash would not
		// change and no UpdateHarness call would be made at all.
		expect(asPublic).not.toEqual(asVpc);
	});

	it('passes a configured environment through unchanged', () => {
		expect(buildEnvironmentUpdate({ vpc: VPC })).toEqual(buildEnvironment({ vpc: VPC }));
	});

	it('drops filesystem mounts that are no longer configured', () => {
		const withMount = buildEnvironmentUpdate({
			vpc: VPC,
			mounts: [{ type: 'efsAccessPoint', mountPath: '/data', accessPointArn: 'arn:efs' }],
		});
		const withoutMount = buildEnvironmentUpdate({ vpc: VPC });

		expect((withMount as any).agentCoreRuntimeEnvironment.filesystemConfigurations).toHaveLength(1);
		expect(
			(withoutMount as any).agentCoreRuntimeEnvironment.filesystemConfigurations,
		).toBeUndefined();
	});
});

describe('buildEnvironmentArtifact', () => {
	it('returns undefined without a container URI', () => {
		expect(buildEnvironmentArtifact(undefined)).toBeUndefined();
		expect(buildEnvironmentArtifact('   ')).toBeUndefined();
	});

	it('wraps a container URI, and wraps it again in optionalValue for updates', () => {
		expect(buildEnvironmentArtifact('123.dkr.ecr.us-west-2.amazonaws.com/x:1')).toEqual({
			containerConfiguration: { containerUri: '123.dkr.ecr.us-west-2.amazonaws.com/x:1' },
		});
		expect(buildEnvironmentArtifactUpdate('123.dkr.ecr.us-west-2.amazonaws.com/x:1')).toEqual({
			optionalValue: {
				containerConfiguration: { containerUri: '123.dkr.ecr.us-west-2.amazonaws.com/x:1' },
			},
		});
	});
});

describe('UpdateHarness wiring', () => {
	// The bug was not in the helper but in which value the update payload used, so
	// pin the two call sites: create sends the nullable value (omitted means "use
	// the default"), update sends the always-present one (omitted means "keep what
	// is stored", which is what stranded harnesses in a VPC).
	const src = readFileSync('nodes/AgentCoreHarness/AgentCoreHarness.node.ts', 'utf8');
	const createBody = src.slice(
		src.indexOf('async function createHarness'),
		src.indexOf('async function updateHarness'),
	);
	const updateBody = src.slice(src.indexOf('async function updateHarness'));

	it('createHarness sends the plain environment value', () => {
		expect(createBody).toMatch(/payload\.environment = input\.environment;/);
	});

	it('updateHarness sends the always-present environment value', () => {
		expect(updateBody).toMatch(/payload\.environment = input\.environmentUpdate;/);
		expect(updateBody).not.toMatch(/payload\.environment = input\.environment;/);
	});
});

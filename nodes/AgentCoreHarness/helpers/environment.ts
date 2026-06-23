/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { IDataObject } from 'n8n-workflow';

/**
 * Builds the compute-environment pieces of a harness: the `environment` union
 * (network + filesystem mounts) and the `environmentArtifact` union (custom
 * container image).
 *
 * Shapes verified against the installed SDK type definitions,
 * @aws-sdk/client-bedrock-agentcore-control@3.1071.0:
 *
 *   environment = { agentCoreRuntimeEnvironment: {
 *       networkConfiguration?: { networkMode, networkModeConfig?: VpcConfig },
 *       filesystemConfigurations?: FilesystemConfiguration[],
 *   }}
 *   VpcConfig = { subnets, securityGroups, requireServiceS3Endpoint? }
 *   FilesystemConfiguration union members:
 *       sessionStorage      { mountPath }
 *       efsAccessPoint      { accessPointArn, mountPath }
 *       s3FilesAccessPoint  { accessPointArn, mountPath }
 *
 *   environmentArtifact = { containerConfiguration: { containerUri } }
 *
 * TODO(v0.2-question-4): The dev guide is internally inconsistent (its network
 * section shows vpcConfig/subnetIds; its filesystem section shows
 * networkModeConfig/subnets). We follow the SDK: networkModeConfig + subnets +
 * securityGroups. See docs/v0.2-questions.md.
 */

export type NetworkMode = 'PUBLIC' | 'VPC';

export interface VpcInput {
	networkMode: NetworkMode;
	subnets: string[];
	securityGroups: string[];
}

export interface FilesystemMount {
	type: 'sessionStorage' | 'efsAccessPoint' | 's3FilesAccessPoint';
	mountPath: string;
	accessPointArn?: string;
}

export interface EnvironmentInput {
	vpc?: VpcInput;
	mounts?: FilesystemMount[];
}

/**
 * Builds the `environment` union. Returns undefined when neither VPC nor
 * filesystem mounts are configured, so the caller omits the field.
 *
 * Throws if EFS / S3 Files mounts are requested without VPC mode — those mount
 * types require the harness to run in a VPC (per the dev guide), and surfacing
 * the error here is friendlier than an opaque ValidationException from AWS.
 */
export function buildEnvironment(input: EnvironmentInput): IDataObject | undefined {
	const runtimeEnv: IDataObject = {};

	const isVpc = input.vpc?.networkMode === 'VPC';

	if (input.vpc) {
		if (isVpc) {
			const subnets = (input.vpc.subnets || []).filter(Boolean);
			const securityGroups = (input.vpc.securityGroups || []).filter(Boolean);
			if (subnets.length === 0) {
				throw new Error('VPC network mode requires at least one subnet ID.');
			}
			runtimeEnv.networkConfiguration = {
				networkMode: 'VPC',
				networkModeConfig: {
					subnets,
					securityGroups,
				},
			};
		} else {
			// Explicit PUBLIC is the service default; only send it if the user
			// also has nothing else in the environment, otherwise omit to avoid
			// churning the harness config hash unnecessarily.
			runtimeEnv.networkConfiguration = { networkMode: 'PUBLIC' };
		}
	}

	const mounts = (input.mounts || []).filter((m) => m && m.type && m.mountPath);
	if (mounts.length > 0) {
		const needsVpc = mounts.some(
			(m) => m.type === 'efsAccessPoint' || m.type === 's3FilesAccessPoint',
		);
		if (needsVpc && !isVpc) {
			throw new Error(
				'EFS and S3 Files mounts require VPC network mode. Set Network Mode to VPC (with subnets and security groups) on the credential, or use Session Storage which needs no VPC.',
			);
		}
		runtimeEnv.filesystemConfigurations = mounts.map((m) => {
			if (m.type === 'sessionStorage') {
				return { sessionStorage: { mountPath: m.mountPath } };
			}
			const arn = (m.accessPointArn || '').trim();
			if (!arn) {
				throw new Error(`Filesystem mount of type ${m.type} requires an Access Point ARN.`);
			}
			return { [m.type]: { accessPointArn: arn, mountPath: m.mountPath } };
		});
	}

	if (Object.keys(runtimeEnv).length === 0) return undefined;
	return { agentCoreRuntimeEnvironment: runtimeEnv };
}

/** Builds the `environmentArtifact` union for a custom container image. */
export function buildEnvironmentArtifact(
	containerUri: string | undefined,
): IDataObject | undefined {
	const uri = (containerUri || '').trim();
	if (!uri) return undefined;
	return { containerConfiguration: { containerUri: uri } };
}

/** Wraps the artifact union in the optionalValue envelope UpdateHarness requires. */
export function buildEnvironmentArtifactUpdate(
	containerUri: string | undefined,
): IDataObject | undefined {
	const value = buildEnvironmentArtifact(containerUri);
	if (value === undefined) return undefined;
	return { optionalValue: value };
}

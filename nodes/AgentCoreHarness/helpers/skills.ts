/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { IDataObject } from 'n8n-workflow';

/**
 * Builds the `skills` array (HarnessSkill[]) for CreateHarness, UpdateHarness,
 * and InvokeHarness.
 *
 * HarnessSkill union members (verified against the installed SDK type
 * definitions, @aws-sdk/client-bedrock-agentcore@3.1071.0):
 *   - awsSkills { paths?: string[] }            curated AWS skills catalog
 *   - git       { url, path?, auth? }           git repo (auth = { credentialArn, username? })
 *   - s3        { uri }                          s3:// source
 *   - path      string                           filesystem path
 *
 * Skills can be set per-harness (create/update) or per-invocation. Invoke-time
 * skills are appended after create-time skills; on a name collision the
 * invoke-time version wins (service behavior, documented in the dev guide).
 */

export interface SkillUiEntry {
	source: 'awsSkills' | 'git' | 's3' | 'path';
	/** awsSkills: comma/newline-separated glob patterns, e.g. core-skills/*. */
	paths?: string;
	/** git: HTTPS url. */
	gitUrl?: string;
	/** git: optional subdirectory within the repo. */
	gitPath?: string;
	/** git: optional credential provider ARN for private repos. */
	gitCredentialArn?: string;
	/** git: optional username (defaults to oauth2 service-side). */
	gitUsername?: string;
	/** s3: s3:// uri. */
	s3Uri?: string;
	/** path: filesystem path on the harness. */
	fsPath?: string;
}

export function buildSkillsArray(skillsUi: IDataObject | undefined): IDataObject[] {
	if (!skillsUi || !skillsUi.skill) return [];
	const entries = skillsUi.skill as SkillUiEntry[];
	const skills: IDataObject[] = [];

	for (const entry of entries) {
		switch (entry.source) {
			case 'awsSkills': {
				const paths = splitPaths(entry.paths);
				// awsSkills with no paths means "all AWS skills".
				skills.push({ awsSkills: paths.length > 0 ? { paths } : {} });
				break;
			}

			case 'git': {
				const url = (entry.gitUrl || '').trim();
				if (!url) throw new Error('Git skill requires an HTTPS URL.');
				if (!/^https:\/\//.test(url)) {
					throw new Error(`Git skill URL must be HTTPS: "${url}"`);
				}
				const git: IDataObject = { url };
				if ((entry.gitPath || '').trim()) git.path = entry.gitPath!.trim();
				const credArn = (entry.gitCredentialArn || '').trim();
				if (credArn) {
					const auth: IDataObject = { credentialArn: credArn };
					if ((entry.gitUsername || '').trim()) auth.username = entry.gitUsername!.trim();
					git.auth = auth;
				}
				skills.push({ git });
				break;
			}

			case 's3': {
				const uri = (entry.s3Uri || '').trim();
				if (!uri) throw new Error('S3 skill requires an s3:// URI.');
				if (!/^s3:\/\//.test(uri)) {
					throw new Error(`S3 skill URI must start with s3://: "${uri}"`);
				}
				skills.push({ s3: { uri } });
				break;
			}

			case 'path': {
				const p = (entry.fsPath || '').trim();
				if (!p) throw new Error('Filesystem-path skill requires a path.');
				skills.push({ path: p });
				break;
			}

			default:
				throw new Error(`Unsupported skill source: ${(entry as SkillUiEntry).source}`);
		}
	}

	return skills;
}

function splitPaths(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

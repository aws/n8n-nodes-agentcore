/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, it, expect } from 'vitest';
import { buildSkillsArray } from '../nodes/AgentCoreHarness/helpers/skills';

describe('buildSkillsArray', () => {
	it('returns an empty array when no skills are configured', () => {
		expect(buildSkillsArray(undefined)).toEqual([]);
		expect(buildSkillsArray({})).toEqual([]);
	});

	it('builds awsSkills with parsed glob paths', () => {
		const skills = buildSkillsArray({ skill: [{ source: 'awsSkills', paths: 'core-skills/*, extra/*' }] });
		expect(skills).toEqual([{ awsSkills: { paths: ['core-skills/*', 'extra/*'] } }]);
	});

	it('builds awsSkills with an empty object meaning "all" when no paths', () => {
		expect(buildSkillsArray({ skill: [{ source: 'awsSkills' }] })).toEqual([{ awsSkills: {} }]);
	});

	it('builds a git skill and requires an HTTPS url', () => {
		const skills = buildSkillsArray({
			skill: [{ source: 'git', gitUrl: 'https://github.com/org/repo', gitPath: 'skills' }],
		});
		expect(skills).toEqual([{ git: { url: 'https://github.com/org/repo', path: 'skills' } }]);

		expect(() => buildSkillsArray({ skill: [{ source: 'git', gitUrl: 'http://insecure' }] })).toThrow(
			/must be HTTPS/,
		);
	});

	it('builds a git skill with auth when a credential ARN is provided', () => {
		const skills = buildSkillsArray({
			skill: [{ source: 'git', gitUrl: 'https://x', gitCredentialArn: 'arn:cred', gitUsername: 'bot' }],
		});
		expect(skills[0]).toEqual({ git: { url: 'https://x', auth: { credentialArn: 'arn:cred', username: 'bot' } } });
	});

	it('builds an s3 skill and requires an s3:// uri', () => {
		expect(buildSkillsArray({ skill: [{ source: 's3', s3Uri: 's3://bucket/key' }] })).toEqual([
			{ s3: { uri: 's3://bucket/key' } },
		]);
		expect(() => buildSkillsArray({ skill: [{ source: 's3', s3Uri: 'https://bucket' }] })).toThrow(
			/must start with s3:\/\//,
		);
	});

	it('builds a filesystem path skill', () => {
		expect(buildSkillsArray({ skill: [{ source: 'path', fsPath: '/opt/skills' }] })).toEqual([
			{ path: '/opt/skills' },
		]);
	});

	it('throws for an unsupported skill source', () => {
		expect(() => buildSkillsArray({ skill: [{ source: 'ftp' } as any] })).toThrow(
			/Unsupported skill source/,
		);
	});
});

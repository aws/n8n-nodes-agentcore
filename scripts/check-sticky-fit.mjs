#!/usr/bin/env node
/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Check that every sticky note in a workflow is large enough for its rendered
 * content on current n8n, and that nothing overlaps.
 *
 * n8n changed sticky spacing and margins, so a sticky sized in an older version
 * clips its text in a newer one. The n8n template review rejects that. This
 * models the renderer from the values in n8n-editor-ui 2.33.x:
 *
 *   .sticky-textarea  height: calc(100% - 1.5rem)   -> 24px reserved
 *                     padding: 0.5rem sides/top     -> 8px
 *   h1  36px   h2  24px   h3/h4  16px    line-height 1.35, margin-bottom 8px
 *   p / li  14px (--font-size--sm)       line-height 1.35, margin-bottom 8px
 *   ul/ol   padding-left 1rem
 *   pre>code  padding 1rem, does not wrap (overflow-x auto)
 *
 * Usage:
 *   node scripts/check-sticky-fit.mjs <workflow.json> [...]
 *
 * Exit 1 if any sticky clips or overlaps, or a node sits on sticky text.
 */

import { readFileSync } from 'node:fs';

const RESERVED_V = 24 + 8; // calc(100% - 1.5rem) plus 8px top padding
const PAD_H = 16; // 8px left + 8px right
const MARGIN_BLOCK = 8; // --spacing--2xs after headings, paragraphs, lists
const LIST_INDENT = 16; // ul/ol padding-left 1rem
const CODE_PAD = 32; // pre>code padding 1rem top and bottom

// Average glyph width as a fraction of font size for the UI sans stack.
// 0.52 is a deliberately safe overestimate; real text averages ~0.48.
const GLYPH = 0.52;

function lineHeight(fontPx) {
	return Math.ceil(fontPx * 1.35);
}

/** Height in px of one markdown block once rendered inside a sticky. */
function blockHeight(line, usableWidth) {
	const h1 = /^#\s/.test(line);
	const h2 = /^##\s/.test(line);
	const h34 = /^#{3,6}\s/.test(line);
	const li = /^\s*([-*+]|\d+\.)\s/.test(line);

	let font = 14; // paragraph default
	if (h1) font = 36;
	else if (h2) font = 24;
	else if (h34) font = 16;

	// Strip markdown that does not occupy width when rendered.
	let text = line
		.replace(/^#{1,6}\s*/, '')
		.replace(/^\s*([-*+]|\d+\.)\s*/, '')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/\*(.+?)\*/g, '$1')
		.replace(/`(.+?)`/g, '$1')
		.replace(/\[(.+?)\]\((.+?)\)/g, '$1');

	const width = li ? usableWidth - LIST_INDENT : usableWidth;
	const cols = Math.max(1, Math.floor(width / (font * GLYPH)));
	const rows = Math.max(1, Math.ceil(text.length / cols));
	return rows * lineHeight(font) + MARGIN_BLOCK;
}

/** Total rendered height of a sticky's markdown at a given box width. */
export function contentHeight(content, boxWidth) {
	const usable = boxWidth - PAD_H;
	const lines = content.split('\n');
	let total = RESERVED_V;
	let inFence = false;
	let fenceLines = 0;

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, '');
		if (/^```/.test(line)) {
			if (inFence) {
				// close: code block does not wrap, height is line count
				total += fenceLines * lineHeight(14) + CODE_PAD + MARGIN_BLOCK;
				fenceLines = 0;
			}
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			fenceLines += 1;
			continue;
		}
		if (line === '') {
			total += MARGIN_BLOCK;
			continue;
		}
		total += blockHeight(line, usable);
	}
	if (inFence && fenceLines) total += fenceLines * lineHeight(14) + CODE_PAD;
	return Math.ceil(total);
}

function rect(n) {
	const [x, y] = n.position;
	return { x, y, w: n.parameters.width, h: n.parameters.height, x2: x + n.parameters.width, y2: y + n.parameters.height };
}

function overlaps(a, b) {
	return a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2;
}

// Importable as a module (contentHeight above); the report below runs only when
// this file is executed directly.
const isMain = process.argv[1] && process.argv[1].endsWith('check-sticky-fit.mjs');
let problems = 0;
const files = isMain ? process.argv.slice(2) : [];
if (isMain && !files.length) {
	console.error('usage: node scripts/check-sticky-fit.mjs <workflow.json> [...]');
	process.exit(2);
}

for (const file of files) {
	console.log(`\n=== ${file.split('/').pop()}`);
	const wf = JSON.parse(readFileSync(file, 'utf8'));
	const stickies = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
	const others = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');

	// 1. Does the content fit?
	for (const s of stickies) {
		const need = contentHeight(s.parameters.content, s.parameters.width);
		const have = s.parameters.height;
		const head = s.parameters.content.split('\n')[0].slice(0, 38);
		if (need > have) {
			console.log(`  CLIPS     ${head}`);
			console.log(`            w=${s.parameters.width} h=${have}, content needs ~${need}px (short by ${need - have}px)`);
			problems++;
		} else {
			const slack = Math.round(((have - need) / have) * 100);
			console.log(`  fits      ${head}  (h=${have}, needs ~${need}, ${slack}% slack)`);
			if (slack < 8) {
				console.log(`            NOTE: under 8% slack, a font change would clip this`);
			}
		}
	}

	// 2. Sticky-on-sticky overlap, ignoring a section sticky nested in nothing.
	for (let i = 0; i < stickies.length; i++) {
		for (let j = i + 1; j < stickies.length; j++) {
			if (overlaps(rect(stickies[i]), rect(stickies[j]))) {
				console.log(`  OVERLAP   "${stickies[i].name}" and "${stickies[j].name}" intersect`);
				problems++;
			}
		}
	}

	// 3. Node geometry against sticky bounds. An n8n node is ~100x100, but its
	//    NAME renders centred underneath and is wider than the icon, so a node
	//    near a sticky edge pushes its label outside the box. That is what looks
	//    broken on the canvas even when the icon is inside.
	const NODE = 100;
	const LABEL_PAD = 60; // label overhang each side of the 100px icon
	// The text band is not a guess: it is however tall this sticky's own rendered
	// content actually is. A node overlapping that band covers real text.

	for (const n of others) {
		const [nx, ny] = n.position;
		const icon = { x: nx, y: ny, x2: nx + NODE, y2: ny + NODE };
		// label box: centred under the icon, wider, plus ~34px of text height
		const label = {
			x: nx - LABEL_PAD,
			y: ny + NODE,
			x2: nx + NODE + LABEL_PAD,
			y2: ny + NODE + 34,
		};

		// Which section sticky is this node meant to live in? The one whose box
		// contains the icon centre.
		const cx = nx + NODE / 2, cy = ny + NODE / 2;
		const home = stickies
			.filter((s) => s.parameters.color === 7)
			.find((s) => {
				const r = rect(s);
				return r.x <= cx && cx <= r.x2 && r.y <= cy && cy <= r.y2;
			});

		if (!home) {
			console.log(`  NO GROUP  node "${n.name}" is not inside any section sticky`);
			problems++;
			continue;
		}

		const r = rect(home);
		const head = home.parameters.content.split('\n')[0].slice(0, 28);
		// icon fully inside?
		if (icon.x < r.x || icon.x2 > r.x2 || icon.y < r.y || icon.y2 > r.y2) {
			console.log(`  SPILLS    node "${n.name}" icon crosses the edge of "${head}"`);
			problems++;
		}
		// label fully inside?
		else if (label.x < r.x || label.x2 > r.x2 || label.y2 > r.y2) {
			console.log(`  LABEL OUT node "${n.name}" name renders outside "${head}"`);
			problems++;
		}
		// node over this sticky's rendered text?
		const textEnd = r.y + contentHeight(home.parameters.content, home.parameters.width);
		if (overlaps(icon, { x: r.x, y: r.y, x2: r.x2, y2: textEnd })) {
			console.log(`  ON TEXT   node "${n.name}" covers text of "${head}" (text runs to y=${textEnd}, node starts y=${ny})`);
			problems++;
		}
		// does this node's label reach into a DIFFERENT sticky?
		for (const other of stickies) {
			if (other === home) continue;
			if (overlaps(label, rect(other))) {
				console.log(`  BLEEDS    node "${n.name}" label reaches into "${other.parameters.content.split('\n')[0].slice(0, 26)}"`);
				problems++;
			}
		}
	}

	// 4. Wasted space: a sticky far taller than its content reads as unfinished.
	for (const s of stickies) {
		const need = contentHeight(s.parameters.content, s.parameters.width);
		const slack = (s.parameters.height - need) / s.parameters.height;
		if (slack > 0.35 && s.parameters.color !== 7) {
			console.log(`  EMPTY     overview sticky is ${Math.round(slack * 100)}% empty space (h=${s.parameters.height}, needs ~${need})`);
			problems++;
		}
	}
}

if (isMain) {
	console.log(
		problems === 0
			? '\nRESULT: every sticky fits its content, no overlaps, no nodes over text.'
			: `\nRESULT: ${problems} problem(s) to fix before submitting.`,
	);
	process.exit(problems === 0 ? 0 : 1);
}

/**
 * repoLink.test.ts — post-launch lock for the public-repo link.
 *
 * Successor to prelaunchRepoLink.test.ts (FC1.7 / F-003), which forbade any
 * live surface from hard-linking `github.com/kychee-com/kysigned` while the
 * repo still 404'd. The launch visibility flip (plan task 20.8) happened: the
 * repo is public, and the links were re-introduced — per that guard's own
 * retirement instruction — so the guard now flips to its inverse: the key
 * agent-discovery surface (`public/llms.txt`) must NAME the repo URL, so an
 * agent reading llms.txt can always find the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LLMS_TXT = join(HERE, '..', 'public', 'llms.txt');

describe('post-launch: agent discovery names the public repo', () => {
  it('public/llms.txt hard-links github.com/kychee-com/kysigned', () => {
    const text = readFileSync(LLMS_TXT, 'utf8');
    expect(text).toMatch(/https:\/\/github\.com\/kychee-com\/kysigned/);
  });
});

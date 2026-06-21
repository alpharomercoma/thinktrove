import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, type DocSnapshot } from './tools.ts';

/**
 * Regression test for the "AI can't see my file" bug: an extensionless document
 * (e.g. `speakerships/web-scrape`) must be visible to every read tool. Before the
 * fix, `searchFiles` skipped any path without a recognized text extension, so a
 * real user file was invisible to the agent even though it was in the snapshot.
 *
 * Run with Node >= 22.18 (native TypeScript stripping): `npm test`.
 */

const DOCS: DocSnapshot[] = [
  {
    path: 'speakerships/web-scrape',
    content:
      'Navigating the Grey: Scaling from Single Worker to Multi-VM Undetectable Scrapers.\n' +
      'Modern web scraping requires navigating strict bot defense systems like Akamai and ' +
      'reCAPTCHA. Extracting data reliably at scale demands an architecture that accurately ' +
      'mimics human behavior for automated problem resolution.',
  },
  { path: 'getting-started.md', content: '# Welcome\nThis is the onboarding doc.' },
  { path: 'asdasdas/asdasd', content: 'unrelated scratch note' },
];

const tools = buildTools({ docs: DOCS, openPath: 'speakerships/web-scrape' });

test('searchFiles finds an extensionless doc by its content', async () => {
  const out: any = await tools.searchFiles.execute(
    { query: 'web scraping talk', maxResults: 8 },
    {} as any,
  );
  assert.equal(out.scanned, 3, 'all docs are scanned, regardless of extension');
  assert.ok(out.matched >= 1, 'at least one doc matches');
  const paths = out.results.map((r: any) => r.path);
  assert.ok(
    paths.includes('speakerships/web-scrape'),
    `expected the extensionless talk doc in results, got: ${paths.join(', ')}`,
  );
});

test('listFiles lists an extensionless doc under its folder prefix', async () => {
  const out: any = await tools.listFiles.execute({ prefix: 'speakerships/' }, {} as any);
  const paths = out.files.map((f: any) => f.path);
  assert.deepEqual(paths, ['speakerships/web-scrape']);
});

test('readFile reads an extensionless doc (not "not_found")', async () => {
  const out: any = await tools.readFile.execute({ path: 'speakerships/web-scrape' }, {} as any);
  assert.equal(out.error, undefined, 'extensionless doc should be readable');
  assert.match(out.content, /Undetectable Scrapers/);
});

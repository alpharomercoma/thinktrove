import { tool } from 'ai';
import { z } from 'zod';

/**
 * Agent tools, backed by a SNAPSHOT of the user's local documents that the client
 * sends with each chat request (the documents live in the browser's IndexedDB).
 * This is the "file search via tool calling" approach — NO embedder, reranker, or
 * vector DB; `searchFiles` is a plain lexical scan.
 *
 * writeDocument does NOT persist here (there is no server store); it returns the
 * computed next content, and the client writes it to local storage + the editor.
 */

export type DocSnapshot = { path: string; content: string };

export type ToolContext = {
  openPath?: string;
  docs: DocSnapshot[];
};

function normalizePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

export function buildTools(ctx: ToolContext) {
  const byPath = new Map(ctx.docs.map((d) => [d.path, d.content]));

  const searchFiles = tool({
    description:
      "Search the user's documents (bios, proposals, grants, job answers, volunteering, notes, etc.) " +
      'for passages relevant to a query. Returns the most relevant documents with matching snippets ' +
      'and their paths. Use focused, narrow queries; make separate calls for separate angles. This is ' +
      "the primary way to ground new ideas in the user's real history.",
    inputSchema: z.object({
      query: z.string().describe('A focused keyword phrase or question to search for.'),
      maxResults: z.number().int().min(1).max(20).default(8).describe('Maximum documents to return.'),
    }),
    execute: async ({ query, maxResults }) => {
      const terms = tokenize(query);
      const scored: { path: string; score: number; snippets: string[] }[] = [];
      for (const d of ctx.docs) {
        // Every doc in the snapshot is searchable text; the client already excludes
        // `.keep` folder markers. (No extension allow-list — that hid real files.)
        const { score, snippets } = scoreDocument(d.content, terms, query);
        if (score > 0) scored.push({ path: d.path, score, snippets });
      }
      scored.sort((a, b) => b.score - a.score);
      return { query, matched: scored.length, scanned: ctx.docs.length, results: scored.slice(0, maxResults) };
    },
  });

  const readFile = tool({
    description:
      'Read the full text content of a single document by its path. Use after searchFiles to get ' +
      'complete context before writing or synthesizing ideas.',
    inputSchema: z.object({
      path: z.string().describe('The document path, e.g. "bios/pydata-2025.md".'),
    }),
    execute: async ({ path }) => {
      const clean = normalizePath(path);
      const content = byPath.get(clean);
      if (content == null) return { path: clean, error: 'not_found' };
      return { path: clean, content, truncated: false };
    },
  });

  const listFiles = tool({
    description:
      "List the user's documents and folders, optionally under a path prefix. Use to explore what " +
      'data exists before searching.',
    inputSchema: z.object({
      prefix: z.string().default('').describe('Folder prefix, e.g. "bios/". Empty lists everything.'),
    }),
    execute: async ({ prefix }) => {
      const pfx = normalizePath(prefix);
      const files = ctx.docs
        .filter((d) => !pfx || d.path === pfx || d.path.startsWith(pfx + '/'))
        .map((d) => ({ path: d.path, size: d.content.length }));
      return { prefix: pfx, files };
    },
  });

  const writeDocument = tool({
    description:
      'Write content into a document — this is how you put generated ideas/text into the editor. ' +
      "If `path` is omitted it targets the currently-open document. Modes: 'replace' (overwrite whole " +
      "doc), 'append' (add to the end), 'patch' (replace the first occurrence of `find` with `replace`). " +
      'Write finished prose, not narration about writing.',
    inputSchema: z.object({
      path: z.string().optional().describe('Target document path. Omit to write the currently-open document.'),
      mode: z.enum(['replace', 'append', 'patch']).default('replace'),
      content: z.string().optional().describe('Text to write (for replace/append).'),
      find: z.string().optional().describe('Substring to locate (mode=patch).'),
      replace: z.string().optional().describe('Replacement text (mode=patch).'),
    }),
    execute: async ({ path, mode, content, find, replace }) => {
      const target = normalizePath(path || ctx.openPath || '');
      if (!target) return { error: 'no_target_path' };
      const existing = byPath.get(target) ?? '';

      let next: string;
      if (mode === 'replace') {
        next = content ?? '';
      } else if (mode === 'append') {
        next = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + (content ?? '');
      } else {
        if (!find) return { error: 'patch_requires_find' };
        if (!existing.includes(find)) return { error: 'find_not_found', find };
        next = existing.replace(find, replace ?? '');
      }
      byPath.set(target, next); // so later steps in the same turn see the update
      // The client persists this to local storage + the editor when it sees the result.
      return { path: target, bytesWritten: next.length, mode, content: next };
    },
  });

  return { searchFiles, readFile, listFiles, writeDocument };
}

// --- lightweight lexical search ---

function tokenize(s: string): string[] {
  return Array.from(
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1),
    ),
  );
}

function scoreDocument(text: string, terms: string[], rawQuery: string): { score: number; snippets: string[] } {
  const lower = text.toLowerCase();
  let score = 0;
  const matched = new Set<string>();
  for (const term of terms) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      score += 1;
      matched.add(term);
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  if (rawQuery.length > 2 && lower.includes(rawQuery.toLowerCase())) score += 5;
  score += matched.size * 2;
  return { score, snippets: buildSnippets(text, lower, terms, 3) };
}

function buildSnippets(text: string, lower: string, terms: string[], max: number): string[] {
  const snippets: string[] = [];
  const seen = new Set<number>();
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + term.length + 120);
    const key = Math.floor(start / 100);
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push((start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : ''));
    if (snippets.length >= max) break;
  }
  return snippets;
}

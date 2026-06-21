'use client';

import { get, set, del, entries, keys, createStore } from 'idb-keyval';

/**
 * LOCAL-FIRST document store, in IndexedDB (via idb-keyval). Files and folders
 * ARE the documents: a "folder" is a `/`-delimited prefix in the path. Everything
 * here runs in the browser, so reads/writes are instant — no network. The cloud
 * Blob backend is gone; the chat receives a snapshot of these docs per request.
 */

export type DocEntry = {
  path: string;
  size: number;
  uploadedAt: string; // ISO; kept this name so existing UI code is unchanged
};

const store = createStore('thinktrove', 'docs');
const TEXT_EXT = /\.(md|markdown|txt|json|csv|yaml|yml|html?|rtf)$/i;

type Stored = { content: string; updatedAt: number };

export function normalizePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

export function isTextDoc(path: string): boolean {
  return TEXT_EXT.test(path);
}

export async function listDocs(prefix = ''): Promise<DocEntry[]> {
  const pfx = normalizePath(prefix);
  const all = (await entries(store)) as [string, Stored][];
  const out: DocEntry[] = [];
  for (const [path, v] of all) {
    if (pfx && path !== pfx && !path.startsWith(pfx + '/')) continue;
    out.push({ path, size: v?.content?.length ?? 0, uploadedAt: new Date(v?.updatedAt ?? 0).toISOString() });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function readDoc(
  path: string,
): Promise<{ path: string; content: string; truncated: boolean } | null> {
  const clean = normalizePath(path);
  const v = (await get(clean, store)) as Stored | undefined;
  if (!v) return null;
  return { path: clean, content: v.content, truncated: false };
}

export async function writeDoc(path: string, content: string): Promise<{ path: string; bytesWritten: number }> {
  const clean = normalizePath(path);
  await set(clean, { content, updatedAt: Date.now() } satisfies Stored, store);
  return { path: clean, bytesWritten: content.length };
}

export async function deleteDoc(path: string): Promise<{ path: string; deleted: boolean }> {
  const clean = normalizePath(path);
  await del(clean, store);
  return { path: clean, deleted: true };
}

export async function moveDoc(from: string, to: string): Promise<void> {
  const f = normalizePath(from);
  const t = normalizePath(to);
  if (!t || f === t) return;
  const v = (await get(f, store)) as Stored | undefined;
  if (!v) return;
  await set(t, v, store);
  await del(f, store);
}

export async function movePrefix(fromPrefix: string, toPrefix: string): Promise<void> {
  const from = normalizePath(fromPrefix);
  const to = normalizePath(toPrefix);
  if (!to || from === to) return;
  const all = (await keys(store)) as string[];
  for (const k of all) {
    if (k === from || k.startsWith(from + '/')) await moveDoc(k, to + k.slice(from.length));
  }
}

export async function deletePrefix(prefix: string): Promise<void> {
  const p = normalizePath(prefix);
  const all = (await keys(store)) as string[];
  for (const k of all) if (k === p || k.startsWith(p + '/')) await del(k, store);
}

/** Snapshot of the user's documents — sent to the chat route so the agent's tools
 *  can search/read them server-side without a cloud store. Every stored doc is
 *  text (the editor only writes strings; there is no binary upload path), so we
 *  include them ALL regardless of extension — excluding only `.keep` folder
 *  markers. Gating this on a text-extension allow-list previously hid legitimate
 *  user files (e.g. an extensionless `speakerships/web-scrape`) from the agent. */
export async function snapshotForChat(): Promise<{ path: string; content: string }[]> {
  const all = (await entries(store)) as [string, Stored][];
  return all
    .filter(([path]) => path.split('/').pop() !== '.keep')
    .map(([path, v]) => ({ path, content: v?.content ?? '' }));
}

const ONBOARDING_PATH = 'getting-started.md';
const ONBOARDING = `# Welcome to ThinkTrove 🧠

This is a **local-first** idea studio. Everything you write lives **on this device**
(in your browser's storage) — no account, no cloud. That makes it instant.

## How it works
- The **sidebar** on the left is your files. Create documents (**+**) and folders (**⊞**),
  rename them (✎), drag them around, and delete what you don't need.
- This middle area is the **editor**. Toggle **Edit / Preview** in the top bar (your docs are
  Markdown). The bar also has a **theme** switch and a button to **hide the sidebar**.
- The bar at the **bottom** is your assistant. Ask it to brainstorm new ideas grounded in your
  own work — it reads your files, shows its steps, and can write straight into the open document.

## A good way to organize
Keep a separate file per item, grouped in folders, e.g.:
- \`bios/\` — a short bio for each past speakership
- \`proposals/\` — speakership / talk proposals
- \`grants/\`, \`volunteering/\`, \`jobs/\` — applications and Q&A answers
- \`opportunities/\` — external opportunities you're tracking

The assistant searches across all of these, so the more you add, the better its ideas.

## Coming soon
Optional sign-in to sync across devices — end-to-end encrypted with a 6-digit code, so only you
can read it. For now, everything stays local.

Delete this file whenever you like. Happy thinking!
`;

/**
 * Schema version for the local stores. Bump when the on-disk shape changes and
 * add a migration step below; `migrate()` runs once on boot and is forward-safe
 * (unknown/new fields are tolerated by the readers, which default missing values).
 */
export const SCHEMA_VERSION = 1;
const SCHEMA_KEY = 'tt.schema';

export async function migrate(): Promise<void> {
  let from = 0;
  try {
    from = Number(localStorage.getItem(SCHEMA_KEY) || '0') || 0;
  } catch {}
  if (from >= SCHEMA_VERSION) return;

  // Future migrations go here, each guarded by version, e.g.:
  // if (from < 2) { /* transform every stored doc value */ }

  try {
    localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
  } catch {}
}

/** Seed a single onboarding document the first time the store is empty. */
export async function seedIfEmpty(): Promise<void> {
  const ks = (await keys(store)) as string[];
  if (ks.length === 0) await writeDoc(ONBOARDING_PATH, ONBOARDING);
}

export const ONBOARDING_FILE = ONBOARDING_PATH;

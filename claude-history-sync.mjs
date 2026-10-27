#!/usr/bin/env node
// Account-scoped index synchronization. This program never controls Claude,
// authentication, or transcripts. Its caller must keep Claude closed throughout.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {createReadStream, createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {isDeepStrictEqual} from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const HASH = /^[0-9a-f]{64}$/;
const runtimeFields = ['bridgeSessionIds', 'bridgeSessionId', 'bridgeSessionUrl', 'cloudSessionId',
  'remoteControlSpawn', 'remoteControlDescendant', 'remoteControlLiveAtUpdateQuit',
  'interruptedByQuitAt', 'armedWorkAtQuit', 'chromeTabGroupId'];
const referenceKeys = new Set(['sessionId', 'targetSessionId', 'sourceSessionId',
  'parentSessionId', 'forkedFromSessionId']);
const fail = message => { throw new Error(message); };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, file) => { const r = path.relative(path.resolve(root), path.resolve(file));
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
const cwdKey = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const shaBytes = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const uuid = (value, label) => { if (typeof value !== 'string' || !UUID.test(value)) fail(`Invalid ${label} UUID`); return value.toLowerCase(); };
async function stat(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function exists(file) { return (await stat(file)) !== null; }

// Reject junctions/symlinks rather than following a backup or mutation outside
// the selected roots. Only ordinary directories and files are supported.
async function ordinaryPath(file, allowMissing = false) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await stat(current);
    if (!info) { if (allowMissing) return; fail(`Missing path: ${current}`); }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail(`Unsupported linked or special path: ${current}`);
  }
}
async function treeFiles(root) {
  const result = [], info = await stat(root);
  if (!info) return result;
  await ordinaryPath(root);
  if (!info.isDirectory()) fail(`Expected a directory: ${root}`);
  async function walk(dir) {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`Unsupported linked backup path: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(file);
      else fail(`Unsupported special backup path: ${file}`);
    }
  }
  await walk(root);
  return result.sort();
}
async function fingerprint(file) {
  await ordinaryPath(file);
  const before = await fs.stat(file);
  if (!before.isFile()) fail(`Expected a file: ${file}`);
  const h = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  const after = await fs.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail(`File changed while reading: ${file}`);
  return {sha256: h.digest('hex'), bytes: after.size};
}
async function hashOrNull(file) { return await exists(file) ? (await fingerprint(file)).sha256 : null; }
async function json(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { fail(`Cannot read valid JSON: ${file}`); }
}
async function durableWrite(file, bytes) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { await durableWrite(temp, JSON.stringify(value, null, 2) + '\n'); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function verifiedCopy(source, destination, expected) {
  const h = crypto.createHash('sha256'); let bytes = 0;
  try {
    await pipeline(createReadStream(source), new Transform({transform(chunk, encoding, callback) {
      h.update(chunk); bytes += chunk.length; callback(null, chunk);
    }}), createWriteStream(destination, {flags: 'wx'}));
    if (h.digest('hex') !== expected.sha256 || bytes !== expected.bytes) fail(`File changed during backup: ${source}`);
    const handle = await fs.open(destination, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (e) { await fs.unlink(destination).catch(() => {}); throw e; }
}
function backupRoot(userRoot) { return path.join(userRoot, '.claude-profiles', '.history-backups'); }
function blobPath(userRoot, hash) { return path.join(backupRoot(userRoot), 'blobs', 'sha256', hash.slice(0, 2), hash); }
async function storeBlob(userRoot, original, fp, verified) {
  const blob = blobPath(userRoot, fp.sha256);
  if (verified.has(blob)) return blob;
  await ordinaryPath(blob, true);
  await fs.mkdir(path.dirname(blob), {recursive: true});
  if (await exists(blob)) {
    const actual = await fingerprint(blob);
    if (!isDeepStrictEqual(actual, fp)) fail(`Corrupt backup blob: ${blob}`);
  } else {
    const temporary = blob + '.' + crypto.randomUUID() + '.part';
    await verifiedCopy(original, temporary, fp);
    try {
      // link provides no-overwrite publication if another prepare created the
      // same blob concurrently. Both copies must have identical content.
      try { await fs.link(temporary, blob); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { await fs.unlink(temporary); }
    const actual = await fingerprint(blob);
    if (!isDeepStrictEqual(actual, fp)) fail(`Backup verification failed: ${blob}`);
  }
  verified.add(blob);
  return blob;
}

async function accountInventory(root) {
  const records = [], orgs = new Set();
  await ordinaryPath(root);
  for (const entry of await fs.readdir(root, {withFileTypes: true})) {
    if (!UUID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`Invalid organization directory: ${entry.name}`);
    const org = entry.name.toLowerCase();
    if (orgs.has(org)) fail('Duplicate organization directories');
    orgs.add(org);
    const dir = path.join(root, entry.name);
    for (const file of await fs.readdir(dir, {withFileTypes: true})) {
      if (!/^local_.*\.json$/i.test(file.name)) continue;
      if (!file.isFile() || file.isSymbolicLink()) fail(`Invalid session file: ${file.name}`);
      const original = path.join(dir, file.name), raw = await fs.readFile(original);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { fail(`Cannot read valid session JSON: ${original}`); }
      const fingerprint = {sha256: shaBytes(raw), bytes: raw.length};
      if (!data || typeof data !== 'object' || !LOCAL.test(data.sessionId ?? '') || file.name !== data.sessionId + '.json') fail(`Session ID and filename differ: ${original}`);
      if (typeof data.cwd !== 'string' || !data.cwd) fail(`Session has no workspace: ${original}`);
      uuid(data.cliSessionId, 'CLI session');
      if (data.priorCliSessionIds !== undefined && !Array.isArray(data.priorCliSessionIds)) fail(`Invalid prior session list: ${original}`);
      const chain = [data.cliSessionId, ...(data.priorCliSessionIds ?? [])].map(id => uuid(id, 'CLI history'));
      if (new Set(chain).size !== chain.length) fail(`Duplicate CLI history entries: ${original}`);
      if (data.lastAssistantUuid != null) uuid(data.lastAssistantUuid, 'assistant');
      if (data.rewindEdges !== undefined && !Array.isArray(data.rewindEdges)) fail(`Invalid rewind edges: ${original}`);
      for (const edge of data.rewindEdges ?? []) {
        if (!edge || typeof edge !== 'object') fail(`Invalid rewind edge: ${original}`);
        const parent = uuid(edge.parent, 'rewind parent'), child = uuid(edge.child, 'rewind child');
        uuid(edge.forkPoint, 'rewind fork point');
        if (!chain.includes(parent) || !chain.includes(child)) fail(`Rewind outside session history: ${original}`);
      }
      records.push({original, org, dir, data, chain, fingerprint});
    }
  }
  const keys = records.map(r => r.org + '/' + r.data.sessionId);
  if (new Set(keys).size !== keys.length) fail('Duplicate local session IDs');
  return {records, orgs};
}
async function transcriptInventory(projectsRoot, needed) {
  const found = new Map();
  if (!(await exists(projectsRoot))) { if (needed.size) fail('Shared Claude transcript directory is missing'); return found; }
  await ordinaryPath(projectsRoot);
  for (const project of await fs.readdir(projectsRoot, {withFileTypes: true})) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const dir = path.join(projectsRoot, project.name);
    for (const file of await fs.readdir(dir, {withFileTypes: true})) {
      if (!file.name.toLowerCase().endsWith('.jsonl')) continue;
      const id = file.name.slice(0, -6).toLowerCase();
      if (!needed.has(id)) continue;
      if (!file.isFile() || file.isSymbolicLink()) fail(`Invalid transcript: ${file.name}`);
      if (found.has(id)) fail(`Ambiguous shared transcript ${id}; found in more than one project`);
      found.set(id, path.join(dir, file.name));
    }
  }
  for (const id of needed) if (!found.has(id)) fail(`Missing shared transcript ${id}; history sync stopped`);
  return found;
}
async function readGraph(original) {
  const before = await fs.stat(original), h = crypto.createHash('sha256');
  const input = createReadStream(original); input.on('data', chunk => h.update(chunk));
  const nodes = new Map(); let records = 0;
  try {
    for await (const line of readline.createInterface({input, crlfDelay: Infinity})) {
      if (!line.trim()) continue;
      const value = JSON.parse(line); records++;
      if (!value || typeof value !== 'object') fail('JSONL record is not an object');
      if (value.uuid) {
        const node = {type: value.type, parent: value.parentUuid ?? null,
          logicalParent: value.subtype === 'compact_boundary' ? value.logicalParentUuid ?? null : null,
          // Compare the inherited assistant itself, not account/session fields,
          // usage accounting, or rewritten parent links. Content is never saved
          // in the manifest or printed; only its identity digest is held in RAM.
          assistantIdentity: value.type === 'assistant' && value.message?.content !== undefined
            ? shaBytes(JSON.stringify(canonical([value.message.role ?? 'assistant', value.message.content]))) : null};
        if (nodes.has(value.uuid) && !isDeepStrictEqual(nodes.get(value.uuid), node)) fail('Conflicting transcript UUID');
        nodes.set(value.uuid, node);
      }
    }
  } catch (e) { input.destroy(); fail(`Invalid transcript ${original}: ${e instanceof SyntaxError ? 'malformed JSON record' : e.message}`); }
  const after = await fs.stat(original);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail(`Transcript changed during validation: ${original}`);
  return {nodes, records, fingerprint: {sha256: h.digest('hex'), bytes: after.size}};
}
function ancestor(nodes, latest, older) {
  if (!older) return {steps: 0, compactions: 0};
  if (!latest) return null;
  const queue = [{id: latest, steps: 0, compactions: 0}], seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const step = queue[i];
    if (step.id === older) return {steps: step.steps, compactions: step.compactions};
    if (seen.has(step.id)) continue; seen.add(step.id);
    const node = nodes.get(step.id); if (!node) continue;
    for (const [id, extra] of [[node.parent, 0], [node.logicalParent, 1]]) if (id) queue.push({id, steps: step.steps + 1, compactions: step.compactions + extra});
  }
  return null;
}
function completeDescendant(newer, older, graphs) {
  if (!older.chain.every(id => newer.chain.includes(id))) return null;
  if (!(older.data.rewindEdges ?? []).every(edge => (newer.data.rewindEdges ?? []).some(candidate => isDeepStrictEqual(edge, candidate)))) return null;
  const current = graphs.get(newer.data.cliSessionId.toLowerCase()).nodes;
  if (older.data.lastAssistantUuid && newer.data.cliSessionId.toLowerCase() !== older.data.cliSessionId.toLowerCase()) {
    const inherited = current.get(older.data.lastAssistantUuid);
    const original = graphs.get(older.data.cliSessionId.toLowerCase()).nodes.get(older.data.lastAssistantUuid);
    if (!inherited?.assistantIdentity || inherited.assistantIdentity !== original?.assistantIdentity) return null;
  }
  // Forks can copy UUIDs while rewriting their parents. Combining the graphs
  // would invent paths through abandoned branches. Only the proposed current
  // transcript may prove ancestry; every prior transcript is still validated
  // separately and retained in the verified backup.
  return ancestor(current, newer.data.lastAssistantUuid, older.data.lastAssistantUuid);
}
function timestamp(record) {
  const value = record.lastActivityAt ?? record.updatedAt ?? record.createdAt ?? 0;
  const numeric = Number(value); return Number.isFinite(numeric) ? numeric : Date.parse(value) || 0;
}
function containsPending(newer, older) {
  if (older == null || older === '' || (Array.isArray(older) && !older.length)) return true;
  if (isDeepStrictEqual(newer, older)) return true;
  if (Array.isArray(newer) && Array.isArray(older)) return older.every(item => newer.some(candidate => isDeepStrictEqual(candidate, item)));
  if (older && newer && typeof older === 'object' && typeof newer === 'object' && !Array.isArray(older) && !Array.isArray(newer)) return Object.keys(older).every(key => containsPending(newer[key], older[key]));
  return false;
}
function checkPending(source, target) {
  for (const key of Object.keys(target)) if (/^(queued|pending)|^(sideSessionNotes|peerReceipts)$/.test(key) && !containsPending(source[key], target[key])) {
    fail(`Destination has distinct pending work (${key}) in ${target.sessionId}; review it before switching`);
  }
}
function remapReferences(value, remap, key = '') {
  if (typeof value === 'string' && referenceKeys.has(key) && remap.has(value)) return remap.get(value);
  if (Array.isArray(value)) return value.map(item => remapReferences(item, remap));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapReferences(v, remap, k)]));
  return value;
}
function sanitized(data, remap) {
  const copy = remapReferences(data, remap);
  for (const key of runtimeFields) delete copy[key];
  copy.remoteControlUserEnabled = false; copy.remoteControlAutoEligible = false;
  for (const key of ['remoteControlEnabled', 'remoteControlAutoReconnect']) if (key in copy) copy[key] = false;
  for (const key of ['cliSessionId', 'priorCliSessionIds', 'rewindEdges', 'transcriptModelStates', 'lastAssistantUuid', 'cwd', 'worktreePath']) {
    if (!isDeepStrictEqual(copy[key], data[key])) fail(`History or workspace changed unexpectedly: ${key}`);
  }
  return copy;
}

async function prepare(options) {
  const appRoot = path.resolve(options['app-root'] ?? fail('--app-root is required'));
  const userRoot = path.resolve(options['user-root'] ?? fail('--user-root is required'));
  const source = uuid(options.source, 'source account'), target = uuid(options.target, 'target account');
  if (source === target) fail('Source and destination accounts must differ');
  await ordinaryPath(appRoot); await ordinaryPath(userRoot);
  const sessionsRoot = path.join(appRoot, 'claude-code-sessions');
  const sourceRoot = path.join(sessionsRoot, source), targetRoot = path.join(sessionsRoot, target);
  const [sourceInventory, targetInventory] = await Promise.all([accountInventory(sourceRoot), accountInventory(targetRoot)]);
  const sources = sourceInventory.records, targets = targetInventory.records;
  for (const s of sources) if (!targetInventory.orgs.has(s.org)) fail(`Destination has no matching organization ${s.org}; sign into that organization once before switching`);
  for (const s of sources) {
    const deleted = path.join(s.dir, 'deleted_' + LOCAL.exec(s.data.sessionId)[1]);
    if (await exists(deleted) || await exists(deleted + '.json')) fail(`Source has a deleted-session marker alongside ${s.data.sessionId}; review it before switching`);
  }
  const relevantTargets = targets.filter(t => sourceInventory.orgs.has(t.org));
  const needed = new Set([...sources, ...relevantTargets].flatMap(r => r.chain));
  const projectsRoot = path.join(userRoot, '.claude', 'projects');
  const transcripts = await transcriptInventory(projectsRoot, needed), graphs = new Map();
  const fingerprints = new Map([...sources, ...targets].map(r => [r.original, r.fingerprint]));
  for (const [id, original] of transcripts) { const graph = await readGraph(original); graphs.set(id, graph); fingerprints.set(original, graph.fingerprint); }
  for (const record of [...sources, ...relevantTargets]) {
    if (record.data.lastAssistantUuid && graphs.get(record.data.cliSessionId.toLowerCase()).nodes.get(record.data.lastAssistantUuid)?.type !== 'assistant') fail(`Missing last assistant in ${record.data.sessionId}`);
    for (const edge of record.data.rewindEdges ?? []) if (!graphs.get(edge.parent.toLowerCase()).nodes.has(edge.forkPoint)) fail(`Missing rewind fork point in ${record.data.sessionId}`);
  }
  const mappings = [], used = new Set();
  for (const s of sources) {
    const orgTargets = relevantTargets.filter(t => t.org === s.org);
    let matches = orgTargets.filter(t => t.data.sessionId === s.data.sessionId);
    if (!matches.length) matches = orgTargets.filter(t => cwdKey(t.data.cwd) === cwdKey(s.data.cwd) && t.chain.some(id => s.chain.includes(id)));
    if (matches.length > 1) fail(`Ambiguous destination aliases for ${s.data.sessionId}`);
    const t = matches[0];
    let action = 'add', proof = null;
    if (t) {
      if (used.has(t.original) || cwdKey(t.data.cwd) !== cwdKey(s.data.cwd) || !t.chain.some(id => s.chain.includes(id))) fail(`Conflicting session mapping for ${s.data.sessionId}`);
      used.add(t.original);
      const forward = completeDescendant(s, t, graphs), reverse = completeDescendant(t, s, graphs);
      if (!forward && !reverse) fail(`Divergent history in ${s.data.sessionId}; both accounts were preserved. Resolve the branches before switching`);
      if (reverse && (!forward || timestamp(t.data) > timestamp(s.data))) { action = 'keep'; proof = reverse; }
      else { action = 'refresh'; proof = forward; }
    }
    const targetSessionId = t?.data.sessionId ?? s.data.sessionId;
    const targetPath = t?.original ?? path.join(targetRoot, s.org, targetSessionId + '.json');
    if (!t) {
      const deleted = path.join(path.dirname(targetPath), 'deleted_' + LOCAL.exec(targetSessionId)[1]);
      if (await exists(targetPath) || await exists(deleted) || await exists(deleted + '.json')) fail(`Destination deleted or conflicts with ${targetSessionId}; it will not be resurrected`);
    }
    mappings.push({org: s.org, source: s.original, target: targetPath, sourceSessionId: s.data.sessionId,
      targetSessionId, cliSessionId: s.data.cliSessionId, action, ancestry: proof});
  }
  const remaps = new Map();
  for (const m of mappings) { if (!remaps.has(m.org)) remaps.set(m.org, new Map()); remaps.get(m.org).set(m.sourceSessionId, m.targetSessionId); }
  for (const m of mappings.filter(m => m.action === 'keep')) {
    const source = remapReferences(sources.find(s => s.original === m.source).data, remaps.get(m.org));
    checkPending(targets.find(t => t.original === m.target).data, source);
  }
  const planned = mappings.filter(m => m.action !== 'keep').map(m => {
    const copy = sanitized(sources.find(s => s.original === m.source).data, remaps.get(m.org));
    if (m.action === 'refresh') checkPending(copy, targets.find(t => t.original === m.target).data);
    return {...m, copy};
  });

  // Validate and snapshot the complete index trees, referenced transcript roots,
  // their subagent directories, and shared project/session support files before
  // creating the transaction or changing any live index.
  const watches = new Map(), extraFiles = new Set(transcripts.values());
  async function watch(root) { if (!watches.has(root)) watches.set(root, await treeFiles(root)); }
  await watch(sourceRoot); await watch(targetRoot);
  const projectDirs = new Set();
  for (const [id, original] of transcripts) {
    const project = path.dirname(original); projectDirs.add(project);
    await watch(path.join(project, id));
    for (const dir of ['file-history', 'session-env', 'tasks', 'sessions']) await watch(path.join(userRoot, '.claude', dir, id));
  }
  for (const project of projectDirs) for (const entry of await fs.readdir(project, {withFileTypes: true})) {
    const original = path.join(project, entry.name);
    if (entry.isDirectory() && !UUID.test(entry.name)) await watch(original);
    else if (entry.isFile() && !entry.name.toLowerCase().endsWith('.jsonl')) extraFiles.add(original);
    else if (entry.isSymbolicLink() && !UUID.test(entry.name)) fail(`Linked project support path: ${original}`);
  }
  await watch(path.join(userRoot, '.claude', 'state'));
  const allFiles = [...new Set([...extraFiles, ...[...watches.values()].flat()])].sort();
  for (const original of allFiles) if (!fingerprints.has(original)) fingerprints.set(original, await fingerprint(original));
  const transactionPath = path.resolve(options.transaction ?? path.join(backupRoot(userRoot), 'transactions', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()));
  if (inside(sessionsRoot, transactionPath) || inside(path.join(userRoot, '.claude'), transactionPath) || inside(transactionPath, appRoot) || inside(transactionPath, userRoot)) fail('Transaction directory overlaps live data');
  await ordinaryPath(transactionPath, true);
  if (await exists(path.join(transactionPath, 'transaction.json'))) fail('Transaction already exists; use apply/rollback or a new transaction directory');
  const backups = [], verified = new Set();
  for (const original of allFiles) { const fp = fingerprints.get(original); backups.push({original, ...fp, blob: await storeBlob(userRoot, original, fp, verified)}); }
  await fs.mkdir(path.join(transactionPath, 'staged'), {recursive: true});
  const operations = [];
  for (const [i, m] of planned.entries()) {
    const {copy, ...operation} = m, bytes = JSON.stringify(copy, null, 2) + '\n';
    const staged = path.join(transactionPath, 'staged', String(i).padStart(4, '0') + '.json');
    await durableWrite(staged, bytes);
    operations.push({...operation, staged, stagedSha256: shaBytes(bytes), stagedBytes: Buffer.byteLength(bytes),
      temporary: path.join(path.dirname(m.target), '.history-sync-' + crypto.randomUUID() + '.tmp'),
      restoreTemporary: path.join(path.dirname(m.target), '.history-restore-' + crypto.randomUUID() + '.tmp'),
      originalSha256: m.action === 'refresh' ? fingerprints.get(m.target).sha256 : null, state: 'pending'});
  }
  const transaction = {version: 1, status: 'prepared', createdAt: new Date().toISOString(), transactionPath,
    appRoot, userRoot, source, target, sourceRoot, targetRoot,
    backups, watches: [...watches].map(([root, files]) => ({root, files})), transcriptPaths: [...transcripts].map(([id, original]) => ({id, original})),
    mappings, operations, counts: {added: mappings.filter(m => m.action === 'add').length, refreshed: mappings.filter(m => m.action === 'refresh').length, kept: mappings.filter(m => m.action === 'keep').length}};
  await validateInputs(transaction, new Set());
  await atomicJson(path.join(transactionPath, 'transaction.json'), transaction);
  return result(transaction, 'prepare');
}

function result(transaction, mode) { return {ok: true, mode, status: transaction.status, transactionPath: transaction.transactionPath,
  ...transaction.counts, backupFiles: transaction.backups.length, backupBytes: transaction.backups.reduce((n, b) => n + b.bytes, 0)}; }
async function loadTransaction(options) {
  if (!options.transaction) fail('--transaction is required for apply/rollback');
  const transactionPath = path.resolve(options.transaction);
  await ordinaryPath(transactionPath);
  const t = await json(path.join(transactionPath, 'transaction.json'));
  if (t.version !== 1 || !samePath(t.transactionPath, transactionPath)) fail('Invalid transaction identity');
  uuid(t.source, 'recorded source account'); uuid(t.target, 'recorded target account');
  if (t.source === t.target) fail('Invalid recorded accounts');
  for (const [arg, key] of [['app-root', 'appRoot'], ['user-root', 'userRoot']]) {
    if (typeof t[key] !== 'string' || !path.isAbsolute(t[key]) || (options[arg] && !samePath(options[arg], t[key]))) fail(`Recorded ${arg} does not match`);
    await ordinaryPath(t[key]);
  }
  for (const key of ['source', 'target']) if (options[key] && uuid(options[key], key) !== t[key]) fail(`Recorded ${key} account does not match`);
  const sessionsRoot = path.join(t.appRoot, 'claude-code-sessions');
  if (!samePath(t.sourceRoot, path.join(sessionsRoot, t.source)) || !samePath(t.targetRoot, path.join(sessionsRoot, t.target))) fail('Invalid recorded account roots');
  if (inside(sessionsRoot, transactionPath) || inside(path.join(t.userRoot, '.claude'), transactionPath)) fail('Transaction overlaps live data');
  if (!Array.isArray(t.backups) || !Array.isArray(t.operations) || !Array.isArray(t.watches) || !Array.isArray(t.transcriptPaths)) fail('Invalid transaction manifest');
  const allowedBackup = file => inside(t.sourceRoot, file) || inside(t.targetRoot, file) || inside(path.join(t.userRoot, '.claude'), file);
  const originals = new Set();
  for (const b of t.backups) {
    if (!allowedBackup(b.original) || !HASH.test(b.sha256) || !Number.isSafeInteger(b.bytes) || b.bytes < 0 || !samePath(b.blob, blobPath(t.userRoot, b.sha256)) || originals.has(b.original)) fail('Invalid backup entry');
    originals.add(b.original);
  }
  for (const w of t.watches) if (!allowedBackup(w.root) || !Array.isArray(w.files) || w.files.some(file => !inside(w.root, file) || !originals.has(file))) fail('Invalid watched inventory');
  const destinations = new Set();
  for (const op of t.operations) {
    uuid(op.org, 'recorded organization');
    if (!LOCAL.test(op.sourceSessionId ?? '') || !LOCAL.test(op.targetSessionId ?? '') || !samePath(op.target, path.join(t.targetRoot, op.org, op.targetSessionId + '.json')) || !samePath(op.source, path.join(t.sourceRoot, op.org, op.sourceSessionId + '.json'))) fail('Operation escaped its account or organization');
    if (!inside(path.join(transactionPath, 'staged'), op.staged) || !HASH.test(op.stagedSha256) || !Number.isSafeInteger(op.stagedBytes) || op.stagedBytes < 0 || destinations.has(op.target) || !['add', 'refresh'].includes(op.action) || !['pending', 'installing', 'installed', 'rolling-back', 'rolled-back'].includes(op.state)) fail('Invalid operation journal');
    for (const [key, prefix] of [['temporary', '.history-sync-'], ['restoreTemporary', '.history-restore-']]) {
      const name = path.basename(op[key] ?? '');
      if (!samePath(path.dirname(op[key] ?? ''), path.dirname(op.target)) || !name.startsWith(prefix) || !name.endsWith('.tmp') || !UUID.test(name.slice(prefix.length, -4))) fail('Invalid operation temporary path');
    }
    if ((op.action === 'add' && op.originalSha256 !== null) || (op.action === 'refresh' && !t.backups.some(b => samePath(b.original, op.target) && b.sha256 === op.originalSha256))) fail('Operation has no verified original backup');
    destinations.add(op.target);
    await ordinaryPath(path.dirname(op.target)); await ordinaryPath(op.target, true);
  }
  return t;
}
async function validateInputs(t, installed) {
  const byTarget = new Map(t.operations.map(op => [op.target, op]));
  for (const b of t.backups) {
    const expected = installed.has(b.original) ? byTarget.get(b.original).stagedSha256 : b.sha256;
    if (await hashOrNull(b.original) !== expected) fail(`Live data changed since prepare: ${b.original}`);
  }
  for (const op of t.operations) if (op.action === 'add') {
    if (await hashOrNull(op.target) !== (installed.has(op.target) ? op.stagedSha256 : null)) fail(`New destination appeared or changed: ${op.target}`);
    const deleted = path.join(path.dirname(op.target), 'deleted_' + LOCAL.exec(op.targetSessionId)[1]);
    if (await exists(deleted) || await exists(deleted + '.json')) fail(`Destination was deleted after prepare: ${op.targetSessionId}`);
  }
  for (const w of t.watches) {
    const expected = new Set(w.files);
    for (const op of t.operations) if (op.action === 'add' && installed.has(op.target) && inside(w.root, op.target)) expected.add(op.target);
    const ownedTemps = new Set(t.operations.filter(op => op.state !== 'pending').flatMap(op => [op.temporary, op.restoreTemporary]));
    const actual = (await treeFiles(w.root)).filter(file => !ownedTemps.has(file));
    if (!isDeepStrictEqual(actual, [...expected].sort())) fail(`File inventory changed since prepare: ${w.root}`);
  }
  const found = await transcriptInventory(path.join(t.userRoot, '.claude', 'projects'), new Set(t.transcriptPaths.map(p => p.id)));
  for (const p of t.transcriptPaths) if (!samePath(found.get(p.id), p.original)) fail('Transcript location changed since prepare');
}
async function validateRecoveryFiles(t, checkStaged = true) {
  const verified = new Set();
  for (const op of t.operations) {
    if (checkStaged) {
      const fp = await fingerprint(op.staged);
      if (fp.sha256 !== op.stagedSha256 || fp.bytes !== op.stagedBytes) fail(`Staged index changed: ${op.staged}`);
      const data = await json(op.staged);
      if (data.sessionId !== op.targetSessionId || data.cliSessionId !== op.cliSessionId) fail('Staged session identity changed');
    }
    if (op.originalSha256) {
      const b = t.backups.find(b => samePath(b.original, op.target));
      if (!verified.has(b.blob)) { const saved = await fingerprint(b.blob); if (saved.sha256 !== b.sha256 || saved.bytes !== b.bytes) fail('Original index backup is corrupt'); verified.add(b.blob); }
    }
  }
}
async function validateAllBlobs(t) {
  const seen = new Set();
  for (const b of t.backups) if (!seen.has(b.blob)) {
    const actual = await fingerprint(b.blob);
    if (actual.sha256 !== b.sha256 || actual.bytes !== b.bytes) fail(`Backup blob failed verification: ${b.blob}`);
    seen.add(b.blob);
  }
}
async function removeOwnedTemp(file, expectedHash) {
  if (!(await exists(file))) return;
  if (await hashOrNull(file) !== expectedHash) fail(`Interrupted temporary file differs from its expected contents: ${file}; preserved for review`);
  await fs.unlink(file);
}
async function apply(t) {
  if (!['prepared', 'applying', 'applied'].includes(t.status)) fail(`Cannot apply transaction in ${t.status} state`);
  await validateRecoveryFiles(t);
  await validateAllBlobs(t);
  const installed = new Set();
  for (const op of t.operations) {
    const current = await hashOrNull(op.target);
    if (['installing', 'installed'].includes(op.state) && current === op.stagedSha256) installed.add(op.target);
    else if (current !== op.originalSha256 || op.state === 'installed') fail(`Destination changed before apply: ${op.target}`);
  }
  await validateInputs(t, installed);
  t.status = 'applying'; await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
  for (const op of t.operations) {
    if (installed.has(op.target)) { op.state = 'installed'; continue; }
    // Recheck immediately before replacement, including recovery from a crash
    // after the journal update but before rename.
    if (await hashOrNull(op.target) !== op.originalSha256) fail(`Destination changed during apply: ${op.target}`);
    const temporary = op.temporary;
    // Journal the unique temporary name before creating it, so interrupted
    // installations can distinguish their own complete temporary file.
    op.state = 'installing'; await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
    if (await exists(temporary)) {
      if (await hashOrNull(temporary) !== op.stagedSha256) fail(`Incomplete interrupted temporary file: ${temporary}; roll back this transaction before retrying`);
    } else await verifiedCopy(op.staged, temporary, {sha256: op.stagedSha256, bytes: op.stagedBytes});
    try {
      if (await hashOrNull(op.target) !== op.originalSha256) fail(`Destination changed before replacement: ${op.target}`);
      await fs.rename(temporary, op.target);
      if (await hashOrNull(op.target) !== op.stagedSha256) fail(`Installed index verification failed: ${op.target}`);
      op.state = 'installed'; installed.add(op.target);
      await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
    } finally { await removeOwnedTemp(temporary, op.stagedSha256); }
  }
  await validateInputs(t, installed);
  t.status = 'applied'; t.appliedAt = new Date().toISOString();
  await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
  return result(t, 'apply');
}
async function rollback(t) {
  if (!['prepared', 'applying', 'applied', 'rolling-back', 'rolled-back'].includes(t.status)) fail(`Cannot roll back transaction in ${t.status} state`);
  await validateRecoveryFiles(t, false);
  const restore = [];
  for (const op of t.operations) {
    const current = await hashOrNull(op.target);
    if (current === op.originalSha256) continue;
    if (['installing', 'installed', 'rolling-back'].includes(op.state) && current === op.stagedSha256) restore.push(op);
    else fail(`Rollback would overwrite newer user changes: ${op.target}; original backup remains available`);
  }
  t.status = 'rolling-back'; await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
  for (const op of restore.reverse()) {
    if (await hashOrNull(op.target) !== op.stagedSha256) fail(`Destination changed during rollback: ${op.target}`);
    op.state = 'rolling-back'; await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
    if (op.originalSha256 === null) {
      if (await hashOrNull(op.target) !== op.stagedSha256) fail(`Destination changed before rollback removal: ${op.target}`);
      await fs.unlink(op.target);
    } else {
      const b = t.backups.find(b => samePath(b.original, op.target));
      const temporary = op.restoreTemporary;
      if (await exists(temporary)) {
        if (await hashOrNull(temporary) !== b.sha256) fail(`Incomplete interrupted restore file: ${temporary}; preserved for review`);
      } else await verifiedCopy(b.blob, temporary, b);
      try {
        if (await hashOrNull(op.target) !== op.stagedSha256) fail(`Destination changed before rollback replacement: ${op.target}`);
        await fs.rename(temporary, op.target);
      } finally { await removeOwnedTemp(temporary, b.sha256); }
    }
    if (await hashOrNull(op.target) !== op.originalSha256) fail(`Rollback verification failed: ${op.target}`);
    op.state = 'rolled-back'; await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
  }
  for (const op of t.operations) {
    // A partially written temp after process termination is not a live index.
    // Keep unmatched bytes for inspection, never remove a file merely by name.
    for (const [file, expected] of [[op.temporary, op.stagedSha256], [op.restoreTemporary, op.originalSha256]]) {
      if (expected && await exists(file) && await hashOrNull(file) === expected) await fs.unlink(file);
    }
    op.state = 'rolled-back';
  }
  t.status = 'rolled-back'; t.rolledBackAt = new Date().toISOString();
  await atomicJson(path.join(t.transactionPath, 'transaction.json'), t);
  return result(t, 'rollback');
}

try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!/^--(app-root|user-root|source|target|mode|transaction)$/.test(key) || process.argv[i + 1] == null || key.slice(2) in options) fail('Invalid or duplicate command arguments');
    options[key.slice(2)] = process.argv[i + 1];
  }
  if (!['prepare', 'apply', 'rollback'].includes(options.mode)) fail('--mode must be prepare, apply, or rollback');
  const output = options.mode === 'prepare' ? await prepare(options) : await (options.mode === 'apply' ? apply : rollback)(await loadTransaction(options));
  console.log(JSON.stringify(output));
} catch (error) {
  console.error(JSON.stringify({ok: false, error: error.message}));
  process.exitCode = 1;
}

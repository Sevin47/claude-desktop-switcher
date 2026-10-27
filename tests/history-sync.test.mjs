import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// These tests only construct disposable, explicitly supplied app/home roots.
// No default live paths or Claude processes are used by the test harness.
const engine = fileURLToPath(new URL('../claude-history-sync.mjs', import.meta.url));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = n => `local_${uuid(n)}`;
const SOURCE = uuid(1), TARGET = uuid(2), ORG = uuid(3), OTHER_ORG = uuid(4);
const CLI = uuid(100), OLD_CLI = uuid(101);
const A = uuid(201), B = uuid(202), C = uuid(203), D = uuid(204);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const files = root => !fs.existsSync(root) ? [] : fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(root, entry.name);
  return entry.isDirectory() ? files(file) : [file];
});
const snapshot = root => Object.fromEntries(files(root).sort().map(file => [path.relative(root, file), sha(fs.readFileSync(file))]));
const frame = (id, parent = null, extra = {}) => ({ type: 'assistant', uuid: id, parentUuid: parent, message: { role: 'assistant', content: 'Synthetic test history.' }, ...extra });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-sync-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('claude-history-sync-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appRoot = path.join(root, 'app');
  const userRoot = path.join(root, 'home');
  const sessionsRoot = path.join(appRoot, 'claude-code-sessions');
  const projectsRoot = path.join(userRoot, '.claude', 'projects');
  const transactionPath = path.join(userRoot, '.claude-profiles', '.history-backups', 'transactions', 'test');
  const sessionDir = (account, org = ORG) => path.join(sessionsRoot, account, org);
  const sessionPath = (account, id = local(10), org = ORG) => path.join(sessionDir(account, org), `${id}.json`);
  fs.mkdirSync(sessionDir(SOURCE), { recursive: true });
  fs.mkdirSync(sessionDir(TARGET), { recursive: true });
  const transcript = (id = CLI, rows = [frame(A), frame(B, A), frame(C, B)]) => put(path.join(projectsRoot, 'synthetic-project', `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const session = (account, extra = {}, org = ORG) => {
    const record = { sessionId: local(10), cliSessionId: CLI, title: 'Synthetic session', cwd: path.join(root, 'project'), lastAssistantUuid: B, lastActivityAt: 200, createdAt: 1, backend: { kind: 'local' }, ...extra };
    return put(sessionPath(account, record.sessionId, org), record);
  };
  transcript();
  const command = (mode, options = {}) => {
    const args = [...(options.nodeArgs ?? []), engine, '--app-root', appRoot, '--user-root', userRoot, '--source', options.source ?? SOURCE, '--target', options.target ?? TARGET, '--mode', mode, '--transaction', options.transactionPath ?? transactionPath];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.ifError(result.error);
    let output;
    try { output = JSON.parse((result.status === 0 ? result.stdout : result.stderr).trim()); }
    catch { assert.fail(`Engine did not return JSON (exit ${result.status}): ${result.stdout}\n${result.stderr}`); }
    return { ...result, output };
  };
  const success = (mode, options) => {
    const result = command(mode, options);
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.equal(result.output.ok, true);
    return result.output;
  };
  const failure = (mode, options) => {
    const result = command(mode, options);
    assert.notEqual(result.status, 0, `${mode} unexpectedly succeeded`);
    assert.equal(result.output.ok, false);
    assert.equal(typeof result.output.error, 'string');
    return result.output;
  };
  const manifestPath = path.join(transactionPath, 'transaction.json');
  return { root, appRoot, userRoot, sessionsRoot, projectsRoot, transactionPath, manifestPath, sessionDir, sessionPath, transcript, session, command, success, failure };
}

test('newer source refreshes existing history and sanitizes live associations without changing the source', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C, lastActivityAt: 300, bridgeSessionIds: [uuid(500)], remoteControlLiveAtUpdateQuit: { at: 1, accountId: SOURCE }, interruptedByQuitAt: 1, remoteControlUserEnabled: true, remoteControlAutoEligible: true });
  const target = f.session(TARGET, { lastAssistantUuid: A, lastActivityAt: 100, bridgeSessionIds: [uuid(501)] });
  const sourceBefore = snapshot(f.sessionDir(SOURCE)), transcriptBefore = snapshot(f.projectsRoot);
  f.success('prepare');
  assert.equal(read(target).lastAssistantUuid, A, 'prepare must not change destination');
  f.success('apply');
  const refreshed = read(target);
  assert.equal(refreshed.lastAssistantUuid, C);
  assert.equal(refreshed.sessionId, local(10));
  assert.deepEqual(refreshed.bridgeSessionIds ?? [], []);
  assert.equal(refreshed.remoteControlUserEnabled, false);
  assert.equal(refreshed.remoteControlAutoEligible, false);
  assert.equal(refreshed.interruptedByQuitAt, undefined);
  assert.equal(refreshed.remoteControlLiveAtUpdateQuit, undefined);
  assert.deepEqual(snapshot(f.sessionDir(SOURCE)), sourceBefore);
  assert.deepEqual(snapshot(f.projectsRoot), transcriptBefore);
});

test('newer destination is kept byte-for-byte instead of overwritten by older source', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: A, lastActivityAt: 100 });
  const target = f.session(TARGET, { lastAssistantUuid: C, lastActivityAt: 300, title: 'Destination newer' });
  const original = fs.readFileSync(target);
  f.success('prepare');
  f.success('apply');
  assert.deepEqual(fs.readFileSync(target), original);
});

test('an existing alias retains its destination ID and child references and queued notes follow the alias', t => {
  const f = fixture(t);
  const sourceId = local(134), targetId = local(687), childId = local(688);
  f.session(SOURCE, { sessionId: sourceId, lastAssistantUuid: C, lastActivityAt: 300 });
  f.session(TARGET, { sessionId: targetId, lastAssistantUuid: A, lastActivityAt: 100 });
  const childCli = uuid(102);
  f.transcript(childCli, [frame(D)]);
  const notes = [{ sessionId: sourceId, text: `Literal text ${sourceId} must remain unchanged.` }];
  f.session(SOURCE, { sessionId: childId, cliSessionId: childCli, lastAssistantUuid: D, spawnedFrom: { sessionId: sourceId }, forkedFromSessionId: sourceId, queuedSideSessionNotes: notes });
  f.success('prepare');
  f.success('apply');
  assert.equal(fs.existsSync(f.sessionPath(TARGET, sourceId)), false);
  assert.equal(read(f.sessionPath(TARGET, targetId)).lastAssistantUuid, C);
  const child = read(f.sessionPath(TARGET, childId));
  assert.equal(child.spawnedFrom.sessionId, targetId);
  assert.equal(child.forkedFromSessionId, targetId);
  assert.equal(child.queuedSideSessionNotes[0].sessionId, targetId);
  assert.equal(child.queuedSideSessionNotes[0].text, notes[0].text);
});

test('compaction ancestry and rewind/model lineage survive a refresh', t => {
  const f = fixture(t);
  f.transcript(OLD_CLI, [frame(A)]);
  f.transcript(CLI, [frame(A), frame(B, null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: A }), frame(C, B)]);
  const history = { priorCliSessionIds: [OLD_CLI], rewindEdges: [{ parent: OLD_CLI, child: CLI, forkPoint: A }], transcriptModelStates: { [OLD_CLI]: { model: 'synthetic-old' }, [CLI]: { model: 'synthetic-new' } } };
  f.session(SOURCE, { ...history, lastAssistantUuid: C, lastActivityAt: 300 });
  f.session(TARGET, { ...history, lastAssistantUuid: A, lastActivityAt: 100 });
  f.success('prepare');
  f.success('apply');
  const target = read(f.sessionPath(TARGET));
  assert.equal(target.lastAssistantUuid, C);
  for (const key of Object.keys(history)) assert.deepEqual(target[key], history[key]);
});

test('inherited messages reparented in the current transcript prove progress without merging prior graphs', t => {
  const f = fixture(t);
  f.transcript(OLD_CLI, [frame(A), frame(D, A), frame(B, D)]);
  f.transcript(CLI, [frame(A), frame(B, A), frame(C, B)]);
  f.session(SOURCE, { priorCliSessionIds: [OLD_CLI], lastAssistantUuid: C, lastActivityAt: 300 });
  f.session(TARGET, { cliSessionId: OLD_CLI, lastAssistantUuid: B, lastActivityAt: 100 });
  const transcriptsBefore = snapshot(f.projectsRoot), sourceBefore = snapshot(f.sessionDir(SOURCE));
  f.success('prepare');
  f.success('apply');
  const target = read(f.sessionPath(TARGET));
  assert.equal(target.cliSessionId, CLI);
  assert.equal(target.lastAssistantUuid, C);
  assert.deepEqual(target.priorCliSessionIds, [OLD_CLI]);
  assert.deepEqual(snapshot(f.projectsRoot), transcriptsBefore);
  assert.deepEqual(snapshot(f.sessionDir(SOURCE)), sourceBefore);
});

test('a parent edge present only in a prior transcript cannot prove current ancestry', t => {
  const f = fixture(t);
  f.transcript(OLD_CLI, [frame(A), frame(D, A), frame(B, D)]);
  // A is present but disconnected. Only the prior graph supplies D -> A.
  f.transcript(CLI, [frame(A), frame(B, D), frame(C, B)]);
  f.session(SOURCE, { priorCliSessionIds: [OLD_CLI], lastAssistantUuid: C, lastActivityAt: 300 });
  f.session(TARGET, { cliSessionId: OLD_CLI, lastAssistantUuid: A, lastActivityAt: 100 });
  const before = snapshot(f.sessionsRoot);
  f.failure('prepare');
  assert.deepEqual(snapshot(f.sessionsRoot), before);
});

test('reusing an inherited endpoint UUID with different message content does not prove ancestry', t => {
  const f = fixture(t);
  f.transcript(OLD_CLI, [frame(A), frame(B, A, { message: { role: 'assistant', content: 'Distinct older message content.' } })]);
  f.transcript(CLI, [frame(A), frame(B, A), frame(C, B)]);
  f.session(SOURCE, { priorCliSessionIds: [OLD_CLI], lastAssistantUuid: C, lastActivityAt: 300 });
  f.session(TARGET, { cliSessionId: OLD_CLI, lastAssistantUuid: B, lastActivityAt: 100 });
  const before = snapshot(f.sessionsRoot);
  f.failure('prepare');
  assert.deepEqual(snapshot(f.sessionsRoot), before);
});

test('new sessions are added and unrelated destination organizations remain untouched', t => {
  const f = fixture(t);
  f.session(SOURCE);
  f.session(TARGET, { title: 'Different organization', lastAssistantUuid: C }, OTHER_ORG);
  const unrelatedBefore = snapshot(f.sessionDir(TARGET, OTHER_ORG));
  f.success('prepare');
  f.success('apply');
  assert.equal(read(f.sessionPath(TARGET)).lastAssistantUuid, B);
  assert.deepEqual(snapshot(f.sessionDir(TARGET, OTHER_ORG)), unrelatedBefore);
});

test('missing matching destination organization fails without creating one', t => {
  const f = fixture(t);
  f.session(SOURCE, {}, OTHER_ORG);
  const before = snapshot(f.sessionDir(TARGET));
  f.failure('prepare');
  assert.equal(fs.existsSync(f.sessionDir(TARGET, OTHER_ORG)), false);
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('divergent branches reject the entire transaction without changing either account', t => {
  const f = fixture(t);
  f.transcript(CLI, [frame(A), frame(B, A), frame(C, A)]);
  f.session(SOURCE, { lastAssistantUuid: B });
  f.session(TARGET, { lastAssistantUuid: C });
  const before = snapshot(f.sessionsRoot);
  f.failure('prepare');
  assert.deepEqual(snapshot(f.sessionsRoot), before);
});

test('a deleted destination session is not resurrected', t => {
  const f = fixture(t);
  f.session(SOURCE);
  const tombstone = put(path.join(f.sessionDir(TARGET), `deleted_${uuid(10)}`), 'synthetic deletion marker');
  const before = snapshot(f.sessionDir(TARGET));
  f.failure('prepare');
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('a stale source index with a deletion marker is not propagated', t => {
  const f = fixture(t);
  f.session(SOURCE);
  put(path.join(f.sessionDir(SOURCE), `deleted_${uuid(10)}`), 'synthetic deletion marker');
  const before = snapshot(f.sessionsRoot);
  f.failure('prepare');
  assert.deepEqual(snapshot(f.sessionsRoot), before);
});

test('distinct destination queued notes are preserved by refusing a destructive refresh', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C, lastActivityAt: 300, queuedSideSessionNotes: [{ text: 'Source pending note' }] });
  const target = f.session(TARGET, { lastAssistantUuid: A, lastActivityAt: 100, queuedSideSessionNotes: [{ text: 'Destination pending note' }] });
  const before = fs.readFileSync(target);
  f.failure('prepare');
  assert.deepEqual(fs.readFileSync(target), before);
});

test('keeping newer destination history must not silently omit unsent source notes', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: A, lastActivityAt: 100, queuedSideSessionNotes: [{ text: 'Unsent source instruction' }] });
  f.session(TARGET, { lastAssistantUuid: C, lastActivityAt: 300 });
  const before = snapshot(f.sessionsRoot);
  f.failure('prepare');
  assert.deepEqual(snapshot(f.sessionsRoot), before);
});

test('equivalent pending notes using account aliases do not prevent a safe refresh', t => {
  const f = fixture(t);
  const sourceId = local(134), targetId = local(687);
  f.session(SOURCE, { sessionId: sourceId, lastAssistantUuid: C, lastActivityAt: 300, sideSessionNotes: [{ sessionId: sourceId, text: 'Identical pending note' }] });
  f.session(TARGET, { sessionId: targetId, lastAssistantUuid: A, lastActivityAt: 100, sideSessionNotes: [{ sessionId: targetId, text: 'Identical pending note' }] });
  f.success('prepare');
  f.success('apply');
  assert.deepEqual(read(f.sessionPath(TARGET, targetId)).sideSessionNotes, [{ sessionId: targetId, text: 'Identical pending note' }]);
});

test('source metadata changed between parsing and backup invalidates preparation', t => {
  const f = fixture(t);
  const source = f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  const before = snapshot(f.sessionDir(TARGET));
  // Deterministic fault injection: return the old read while an external writer
  // has already replaced that synthetic source. No wall-clock sleeps or races.
  const hook = put(path.join(f.root, 'source-race.mjs'), `
    import fs from 'node:fs/promises';
    const original = fs.readFile;
    let changed = false;
    fs.readFile = async function (file, ...args) {
      const bytes = await original.call(this, file, ...args);
      if (!changed && String(file) === ${JSON.stringify(source)}) {
        changed = true;
        const data = JSON.parse(String(bytes));
        data.title = 'Externally changed after metadata read';
        await fs.writeFile(file, JSON.stringify(data));
      }
      return bytes;
    };
  `);
  f.failure('prepare', { nodeArgs: ['--import', pathToFileURL(hook).href] });
  assert.equal(read(source).title, 'Externally changed after metadata read');
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('malformed and missing transcripts fail before destination writes', async t => {
  for (const condition of ['malformed', 'missing']) await t.test(condition, t => {
    const f = fixture(t);
    f.session(SOURCE, { lastAssistantUuid: C });
    f.session(TARGET, { lastAssistantUuid: A });
    const transcript = path.join(f.projectsRoot, 'synthetic-project', `${CLI}.jsonl`);
    if (condition === 'malformed') fs.appendFileSync(transcript, '{not-json}\n');
    else fs.unlinkSync(transcript);
    const before = snapshot(f.sessionsRoot);
    f.failure('prepare');
    assert.deepEqual(snapshot(f.sessionsRoot), before);
  });
});

test('verified backup blobs are checksummed and deduplicated across transactions', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  f.success('prepare');
  const manifest = read(f.manifestPath);
  assert.ok(manifest.backups.length >= 3, 'source, target, and shared transcript must be backed up');
  for (const backup of manifest.backups) {
    const blob = path.isAbsolute(backup.blob) ? backup.blob : path.resolve(f.transactionPath, backup.blob);
    assert.equal(sha(fs.readFileSync(blob)), backup.sha256);
    assert.equal(fs.statSync(blob).size, backup.bytes);
    assert.equal(sha(fs.readFileSync(backup.original)), backup.sha256);
  }
  const blobRoot = path.join(f.userRoot, '.claude-profiles', '.history-backups', 'blobs');
  const before = snapshot(blobRoot);
  f.success('prepare', { transactionPath: path.join(path.dirname(f.transactionPath), 'second') });
  assert.deepEqual(snapshot(blobRoot), before);
});

test('corruption of a shared transcript backup blocks apply before any destination writes', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  const before = snapshot(f.sessionDir(TARGET));
  f.success('prepare');
  const backup = read(f.manifestPath).backups.find(entry => entry.original.endsWith('.jsonl'));
  assert.ok(backup);
  const blob = path.isAbsolute(backup.blob) ? backup.blob : path.resolve(f.transactionPath, backup.blob);
  fs.appendFileSync(blob, '\nSynthetic corruption');
  f.failure('apply');
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('apply detects a changed destination before writing any operation', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  const otherCli = uuid(104);
  f.transcript(otherCli, [frame(D)]);
  f.session(SOURCE, { sessionId: local(11), cliSessionId: otherCli, lastAssistantUuid: D });
  f.success('prepare');
  const target = f.sessionPath(TARGET);
  put(target, { ...read(target), title: 'Changed after prepare' });
  const before = snapshot(f.sessionDir(TARGET));
  f.failure('apply');
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('rollback restores replaced metadata and removes newly added entries', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  const otherCli = uuid(104);
  f.transcript(otherCli, [frame(D)]);
  f.session(SOURCE, { sessionId: local(11), cliSessionId: otherCli, lastAssistantUuid: D });
  const before = snapshot(f.sessionDir(TARGET)), sourceBefore = snapshot(f.sessionDir(SOURCE));
  f.success('prepare');
  f.success('apply');
  f.success('rollback');
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
  assert.deepEqual(snapshot(f.sessionDir(SOURCE)), sourceBefore);
});

test('rollback recovers a rename interrupted between installing and installed journal states', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  const otherCli = uuid(104);
  f.transcript(otherCli, [frame(D)]);
  f.session(SOURCE, { sessionId: local(11), cliSessionId: otherCli, lastAssistantUuid: D });
  const before = snapshot(f.sessionDir(TARGET));
  f.success('prepare');
  const manifest = read(f.manifestPath), operation = manifest.operations[0];
  assert.ok(operation);
  assert.equal(manifest.operations.length, 2, 'the second operation must remain pending after the simulated crash');
  const staged = path.isAbsolute(operation.staged) ? operation.staged : path.resolve(f.transactionPath, operation.staged);
  fs.copyFileSync(staged, operation.target);
  operation.state = 'installing';
  manifest.status = 'applying';
  put(f.manifestPath, manifest);
  f.success('rollback');
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('apply recovers a completed temporary copy interrupted before its rename', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  f.success('prepare');
  const manifest = read(f.manifestPath), operation = manifest.operations[0];
  assert.ok(operation.temporary);
  fs.copyFileSync(operation.staged, operation.temporary);
  operation.state = 'installing';
  manifest.status = 'applying';
  put(f.manifestPath, manifest);
  f.success('apply');
  assert.equal(read(operation.target).lastAssistantUuid, C);
  assert.equal(fs.existsSync(operation.temporary), false);
  assert.equal(read(f.manifestPath).status, 'applied');
});

test('rollback restores original metadata even if the staged replacement is missing', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  const before = snapshot(f.sessionDir(TARGET));
  f.success('prepare');
  const manifest = read(f.manifestPath), operation = manifest.operations[0];
  fs.copyFileSync(operation.staged, operation.target);
  fs.unlinkSync(operation.staged);
  operation.state = 'installing';
  manifest.status = 'applying';
  put(f.manifestPath, manifest);
  f.success('rollback');
  assert.deepEqual(snapshot(f.sessionDir(TARGET)), before);
});

test('rollback refuses to overwrite changes made after apply', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  const target = f.session(TARGET, { lastAssistantUuid: A });
  f.success('prepare');
  f.success('apply');
  put(target, { ...read(target), title: 'New work after apply' });
  const after = fs.readFileSync(target);
  f.failure('rollback');
  assert.deepEqual(fs.readFileSync(target), after);
});

test('unsafe account and transcript IDs and mismatched session IDs are rejected', async t => {
  for (const condition of ['account', 'transcript', 'session']) await t.test(condition, t => {
    const f = fixture(t);
    const source = f.session(SOURCE);
    f.session(TARGET, { lastAssistantUuid: A });
    if (condition === 'transcript') put(source, { ...read(source), cliSessionId: '../../escape' });
    if (condition === 'session') put(source, { ...read(source), sessionId: 'local_../../escape' });
    const before = snapshot(f.sessionsRoot);
    f.failure('prepare', condition === 'account' ? { target: '../outside' } : {});
    assert.deepEqual(snapshot(f.sessionsRoot), before);
  });
});

test('a tampered transaction cannot write to a target outside its account root', t => {
  const f = fixture(t);
  f.session(SOURCE, { lastAssistantUuid: C });
  f.session(TARGET, { lastAssistantUuid: A });
  f.success('prepare');
  const outside = put(path.join(f.root, 'outside.json'), 'untouched');
  const manifest = read(f.manifestPath);
  manifest.operations[0].target = outside;
  manifest.operations[0].originalSha256 = sha(fs.readFileSync(outside));
  put(f.manifestPath, manifest);
  f.failure('apply');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

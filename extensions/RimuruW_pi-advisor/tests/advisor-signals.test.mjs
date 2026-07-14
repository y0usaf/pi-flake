import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutorSignals,
  countPatchChanges,
  detectStage,
  extractBashExitCode,
  isVerificationCommand,
  summarizeToolResult,
} from '../src/advisor-signals.ts';

// --- extractBashExitCode ---

test('extractBashExitCode: matches pi bash tool format "Command exited with code N"', () => {
  assert.equal(extractBashExitCode('output here\n\nCommand exited with code 2'), 2);
});

test('extractBashExitCode: matches legacy "exit code: N" format', () => {
  assert.equal(extractBashExitCode('something failed, exit code: 127'), 127);
});

test('extractBashExitCode: no match → undefined', () => {
  assert.equal(extractBashExitCode('all tests passed'), undefined);
});

// --- countPatchChanges ---

test('countPatchChanges: counts added and removed lines, ignores headers', () => {
  const patch = [
    '--- a/foo.ts',
    '+++ b/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' unchanged',
    '-removed line',
    '+added line',
    '+another added',
  ].join('\n');
  assert.deepEqual(countPatchChanges(patch), { added: 2, removed: 1 });
});

// --- summarizeToolResult ---

test('summarizeToolResult: bash failure carries exit code in summary and isError', () => {
  const event = summarizeToolResult({
    toolName: 'bash',
    input: { command: 'npm test' },
    content: [{ type: 'text', text: 'FAIL\n\nCommand exited with code 1' }],
    isError: true,
  });
  assert.equal(event.summary, '$ npm test (exit 1)');
  assert.equal(event.isError, true);
  assert.equal(event.command, 'npm test');
});

test('summarizeToolResult: bash success has no suffix', () => {
  const event = summarizeToolResult({
    toolName: 'bash',
    input: { command: 'ls -la' },
    content: [{ type: 'text', text: 'total 8' }],
    isError: false,
  });
  assert.equal(event.summary, '$ ls -la');
  assert.equal(event.isError, false);
});

test('summarizeToolResult: edit includes +/- stats when patch details exist', () => {
  const event = summarizeToolResult({
    toolName: 'edit',
    input: { path: 'src/foo.ts' },
    content: [],
    isError: false,
    details: { diff: '...', patch: '--- a\n+++ b\n+new\n+more\n-old' },
  });
  assert.equal(event.summary, 'edit src/foo.ts (+2/-1)');
});

test('summarizeToolResult: edit without details falls back to path only', () => {
  const event = summarizeToolResult({
    toolName: 'edit',
    input: { path: 'src/foo.ts' },
    content: [],
    isError: false,
  });
  assert.equal(event.summary, 'edit src/foo.ts');
});

test('summarizeToolResult: unknown tool uses one-line text preview', () => {
  const event = summarizeToolResult({
    toolName: 'grep',
    input: { pattern: 'foo' },
    content: [{ type: 'text', text: 'src/a.ts:1: foo\nsrc/b.ts:2: foo' }],
    isError: false,
  });
  assert.match(event.summary, /^grep: src\/a\.ts:1: foo/);
});

// --- isVerificationCommand ---

test('isVerificationCommand: matches common runners', () => {
  for (const cmd of [
    'npm test',
    'pnpm run check',
    'bun test',
    'yarn lint',
    'npx tsc --noEmit',
    'cargo test --workspace',
    'go test ./...',
    'pytest -x',
    'python -m pytest tests/',
    'node --test tests/',
    'make check',
    'CI=1 npm test',
  ]) {
    assert.equal(isVerificationCommand(cmd), true, `expected verification: ${cmd}`);
  }
});

test('isVerificationCommand: matches verification segment in compound commands', () => {
  assert.equal(isVerificationCommand('cd pkg && npm test'), true);
  assert.equal(isVerificationCommand('npm run build | tee build.log'), true);
});

test('isVerificationCommand: does not match paths or unrelated commands', () => {
  for (const cmd of [
    'cat tests/foo.test.ts',
    'ls tests',
    'rm -rf tests/fixtures',
    'git checkout main',
    'echo "run the tests later"',
    'fd -g "*.test.ts"',
  ]) {
    assert.equal(isVerificationCommand(cmd), false, `expected non-verification: ${cmd}`);
  }
});

test('isVerificationCommand: undefined → false', () => {
  assert.equal(isVerificationCommand(undefined), false);
});

// --- detectStage ---

function bashEvent(command, isError = false) {
  return { toolName: 'bash', summary: `$ ${command}`, command, isError, timestamp: 0 };
}
function readEvent(path) {
  return { toolName: 'read', summary: `read ${path}`, isError: false, timestamp: 0 };
}
function editEvent(path) {
  return { toolName: 'edit', summary: `edit ${path}`, isError: false, timestamp: 0 };
}

test('detectStage: mutation + verification → final-check', () => {
  const stage = detectStage([editEvent('a.ts'), bashEvent('npm test')], 1);
  assert.equal(stage.stage, 'final-check');
});

test('detectStage: recent failure → recovery', () => {
  const stage = detectStage([readEvent('a.ts'), bashEvent('npm start', true)], 1);
  assert.equal(stage.stage, 'recovery');
});

test('detectStage: exploration only → initial', () => {
  const stage = detectStage([readEvent('a.ts'), readEvent('b.ts')], 1);
  assert.equal(stage.stage, 'initial');
});

test('detectStage: mutation without verification on second call → recovery', () => {
  const stage = detectStage([editEvent('a.ts')], 2);
  assert.equal(stage.stage, 'recovery');
});

test('detectStage: empty events → initial', () => {
  const stage = detectStage([], 1);
  assert.equal(stage.stage, 'initial');
});

// --- buildExecutorSignals ---

test('buildExecutorSignals: mutations + verification → verifying phase', () => {
  const signals = buildExecutorSignals([editEvent('a.ts'), bashEvent('pnpm test')]);
  assert.equal(signals.phase, 'verifying');
  assert.equal(signals.mutationsCount, 1);
  assert.deepEqual(signals.verificationCommands, ['pnpm test']);
});

test('buildExecutorSignals: failures only → stuck phase', () => {
  const signals = buildExecutorSignals([bashEvent('npm start', true)]);
  assert.equal(signals.phase, 'stuck');
  assert.equal(signals.recentFailures.length, 1);
});

test('buildExecutorSignals: keeps only the last three failures', () => {
  const events = [1, 2, 3, 4, 5].map((i) => bashEvent(`cmd${i}`, true));
  const signals = buildExecutorSignals(events);
  assert.deepEqual(signals.recentFailures, ['$ cmd3', '$ cmd4', '$ cmd5']);
});

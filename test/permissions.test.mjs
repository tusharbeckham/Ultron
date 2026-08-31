// Permission profiles must constrain WHERE, not only WHAT.
//
// The original profiles answered "may this session read / write / shell?" and said nothing
// about which files. A `read-only` profile — the safest one, and the default — would
// therefore index `C:\Windows\System32` or a user's SSH keys quite happily. The permission
// bit was real; the boundary was missing. These tests are that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ultron-perm-'));

// The module reads the roots from the environment at profile-construction time, so the
// fixture is set up before importing.
const WORKSPACE = tmp();
process.env.ULTRON_WORKSPACE_ROOTS = WORKSPACE;
const { getPermissionProfile, requirePermission, resolveWithin, workspaceRoots, permissionProfiles } =
  await import('../src/permissions.mjs');

test('a path inside the workspace resolves', () => {
  const file = path.join(WORKSPACE, 'ok.txt');
  writeFileSync(file, 'x', 'utf8');
  const profile = getPermissionProfile('read-only');
  assert.equal(resolveWithin(profile, file, 'fileRead'), file);
});

test('a path outside the workspace is refused', () => {
  const profile = getPermissionProfile('read-only');
  assert.throws(() => resolveWithin(profile, path.join(os.tmpdir(), 'elsewhere.txt'), 'fileRead'),
    /outside the workspace/);
});

test('traversal out of the workspace is refused after resolution', () => {
  // path.resolve collapses "..", so the check has to happen on the resolved path.
  const profile = getPermissionProfile('read-only');
  assert.throws(() => resolveWithin(profile, path.join(WORKSPACE, '..', '..', 'etc'), 'fileRead'),
    /outside the workspace/);
});

test('the permission bit is still checked, before the path', () => {
  // Order matters for the message: "writing is not allowed" is more useful than
  // "that path is outside the workspace" when the profile forbids writing at all.
  const profile = getPermissionProfile('read-only');
  assert.throws(() => resolveWithin(profile, path.join(WORKSPACE, 'x'), 'fileWrite', 'index writing'),
    /denied by permission profile/);
});

test('balanced may write inside the workspace but not outside it', () => {
  const profile = getPermissionProfile('balanced');
  assert.equal(resolveWithin(profile, path.join(WORKSPACE, 'out.json'), 'fileWrite'),
    path.join(WORKSPACE, 'out.json'));
  assert.throws(() => resolveWithin(profile, path.join(os.tmpdir(), 'out.json'), 'fileWrite'),
    /outside the workspace/);
});

test('Windows path tricks are refused even inside the workspace', () => {
  // safeResolve runs before the confinement check, because every one of these exists to
  // make a path string differ from the file it opens.
  const profile = getPermissionProfile('read-only');
  for (const raw of [
    path.join(WORKSPACE, 'notes.txt:payload'),   // NTFS alternate data stream
    path.join(WORKSPACE, 'CON'),                 // DOS device
    path.join(WORKSPACE, 'nul.txt'),
    '\\\\server\\share\\f'                        // UNC
  ]) {
    assert.throws(() => resolveWithin(profile, raw, 'fileRead'), /refused/, raw);
  }
});

test('unrestricted deliberately has no path boundary', () => {
  // Otherwise there is no way to work on a second checkout, and someone "fixes" that by
  // reaching for a profile they need even less.
  const profile = getPermissionProfile('unrestricted');
  assert.equal(profile.roots, null);
  assert.doesNotThrow(() => resolveWithin(profile, os.tmpdir(), 'fileWrite'));
});

test('a subdirectory of the workspace is inside it', () => {
  const sub = path.join(WORKSPACE, 'nested', 'deep');
  mkdirSync(sub, { recursive: true });
  const profile = getPermissionProfile('read-only');
  assert.equal(resolveWithin(profile, sub, 'fileRead'), sub);
});

test('a sibling sharing a name prefix is not inside the workspace', () => {
  // "…/ultron-perm-abc" must not contain "…/ultron-perm-abcdef".
  const profile = getPermissionProfile('read-only');
  assert.throws(() => resolveWithin(profile, WORKSPACE + 'extra', 'fileRead'), /outside the workspace/);
});

test('an empty path is refused rather than defaulting to cwd', () => {
  const profile = getPermissionProfile('read-only');
  for (const raw of ['', '   ', null, undefined]) {
    assert.throws(() => resolveWithin(profile, raw, 'fileRead'), /a path is required|refused/);
  }
});

test('multiple workspace roots are all honoured', () => {
  const second = tmp();
  const previous = process.env.ULTRON_WORKSPACE_ROOTS;
  process.env.ULTRON_WORKSPACE_ROOTS = [WORKSPACE, second].join(path.delimiter);
  try {
    assert.equal(workspaceRoots().length, 2);
    const profile = getPermissionProfile('balanced');
    assert.equal(resolveWithin(profile, path.join(second, 'f.txt'), 'fileWrite'), path.join(second, 'f.txt'));
  } finally {
    process.env.ULTRON_WORKSPACE_ROOTS = previous;
  }
});

test('an unknown profile is refused', () => {
  assert.throws(() => getPermissionProfile('godmode'), /Unknown permission profile/);
});

test('the profile table itself is unchanged and frozen', () => {
  // The confinement is additive: the existing verbs must keep their meaning.
  assert.equal(permissionProfiles['read-only'].fileWrite, false);
  assert.equal(permissionProfiles.balanced.shell, false);
  assert.equal(permissionProfiles.unrestricted.shell, true);
  assert.equal(Object.isFrozen(permissionProfiles), true);
});

test('requirePermission still works standalone', () => {
  const profile = getPermissionProfile('read-only');
  assert.throws(() => requirePermission(profile, 'shell', 'MCP process launch'),
    /MCP process launch denied/);
});

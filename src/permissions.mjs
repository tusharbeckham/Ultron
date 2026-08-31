// Permission profiles — what a session is allowed to do, and WHERE.
//
// The profiles used to answer only the first half: `fileRead: true` meant "read", with no
// statement about what. So a `read-only` profile — the safest one, and the default —
// happily indexed `C:\Windows\System32` or the user's SSH keys, and `balanced` would apply
// a patch anywhere on the disk. The permission bit was real; the boundary was missing.
//
// So each profile now also carries `roots`, and `resolveWithin` is the only sanctioned way
// to turn a caller-supplied path into one a tool may touch. It runs three checks in a
// deliberate order:
//
//   1. the permission bit      — may this profile do this kind of thing at all?
//   2. `safeResolve`           — what file does this string ACTUALLY name? (Windows tricks)
//   3. `insideRoots`           — is that file inside the workspace?
//
// Step 2 has to precede step 3, because every Windows trick `safeResolve` refuses exists
// specifically to make a path string differ from the file it opens. Confining an
// unresolved string confines the spelling, not the target.

import path from 'node:path';
import { safeResolve, insideRoots, GuardError } from './guards.mjs';

/** Where a session may reach. `ULTRON_WORKSPACE_ROOTS` overrides (path-delimiter separated). */
export function workspaceRoots() {
  const configured = process.env.ULTRON_WORKSPACE_ROOTS;
  if (configured) return configured.split(path.delimiter).filter(Boolean).map(r => path.resolve(r));
  return [process.cwd()];
}

export const permissionProfiles = Object.freeze({
  'read-only': { fileRead: true, fileWrite: false, shell: false, web: false, notion: false },
  balanced: { fileRead: true, fileWrite: true, shell: false, web: true, notion: true },
  unrestricted: { fileRead: true, fileWrite: true, shell: true, web: true, notion: true }
});

export function getPermissionProfile(name = process.env.ULTRON_PERMISSION_PROFILE || 'read-only') {
  const profile = permissionProfiles[name];
  if (!profile) throw new Error(`Unknown permission profile: ${name}`);
  // `unrestricted` means unrestricted, including the path boundary — otherwise there
  // would be no way to work on a second checkout, and someone would "fix" that by
  // reaching for a profile they need even less.
  const roots = name === 'unrestricted' ? null : workspaceRoots();
  return { name, ...profile, roots };
}

export function requirePermission(profile, permission, action = permission) {
  if (!profile[permission]) throw new Error(`${action} denied by permission profile ${profile.name}`);
}

/**
 * Check the permission, resolve the path honestly, and confine it. Returns the resolved
 * absolute path.
 *
 * Use this instead of `path.resolve` anywhere a caller-supplied path reaches the
 * filesystem. `path.resolve` collapses `..` and nothing else: it will not notice an NTFS
 * alternate data stream, a DOS device name, an 8.3 short name, or a junction pointing out
 * of the workspace.
 */
export function resolveWithin(profile, rawPath, permission, action = permission) {
  requirePermission(profile, permission, action);
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error(`${action}: a path is required`);

  let resolved;
  try {
    resolved = safeResolve(rawPath, process.cwd());
  } catch (error) {
    if (error instanceof GuardError) throw new Error(`${action} refused: ${error.message}`);
    throw error;
  }

  if (profile.roots && !insideRoots(resolved, profile.roots)) {
    throw new Error(
      `${action} refused: ${resolved} is outside the workspace (${profile.roots.join(', ')}). ` +
      'Set ULTRON_WORKSPACE_ROOTS or use --profile unrestricted deliberately.'
    );
  }
  return resolved;
}

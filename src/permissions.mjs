export const permissionProfiles = Object.freeze({
  'read-only': { fileRead: true, fileWrite: false, shell: false, web: false, notion: false },
  balanced: { fileRead: true, fileWrite: true, shell: false, web: true, notion: true },
  unrestricted: { fileRead: true, fileWrite: true, shell: true, web: true, notion: true }
});
export function getPermissionProfile(name = process.env.ULTRON_PERMISSION_PROFILE || 'read-only') {
  const profile = permissionProfiles[name]; if (!profile) throw new Error(`Unknown permission profile: ${name}`); return { name, ...profile };
}
export function requirePermission(profile, permission, action = permission) { if (!profile[permission]) throw new Error(`${action} denied by permission profile ${profile.name}`); }

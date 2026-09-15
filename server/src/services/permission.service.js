const RolePermission = require('../models/rolePermission.model');
const ApiError = require('../utils/ApiError');
const { permissionCache } = require('../utils/ttlCache');
const {
    PERMISSIONS,
    PERMISSION_KEYS,
    READ_KEYS,
    ROLES,
    ADMIN_ONLY,
    READ_ONLY_ROLES,
    DEFAULT_GRANTS,
} = require('../utils/permissions');

// A role's grants, as a Set (can() does an O(1) lookup).
// Cache-first, otherwise every protected request costs an extra DB read.
const getGrants = async (role) => {
    if (role === 'Admin') return new Set(PERMISSION_KEYS); // Admin has everything

    const cached = permissionCache.get(role);
    if (cached) return cached;

    const doc = await RolePermission.findOne({ role }).select('permissions').lean();
    const grants = new Set(doc?.permissions || []);

    permissionCache.set(role, grants);
    return grants;
};

// For the Settings screen: the full catalogue plus each role's grants
const getCatalogue = async () => {
    const docs = await RolePermission.find().select('role permissions version updatedAt').lean();

    const grants = {};
    for (const role of ROLES) {
        if (role === 'Admin') {
            // Admin has no row — they always have everything. The UI shows this
            // read-only.
            grants[role] = { permissions: [...PERMISSION_KEYS], locked: true, version: null };
        } else {
            const doc = docs.find((d) => d.role === role);
            grants[role] = {
                permissions: doc?.permissions || [],
                locked: false,
                // A read-only role's write switches are not merely off, they are
                // unavailable — updateGrants refuses to save one. The screen needs
                // to say so, because a switch that silently refuses to stick is
                // worse than no switch at all.
                readOnly: READ_ONLY_ROLES.has(role),
                version: doc?.version || 0,
                updatedAt: doc?.updatedAt || null,
            };
        }
    }

    return {
        catalogue: PERMISSIONS,
        // The UI shows this locked
        adminOnly: [...ADMIN_ONLY],
        // Which keys a read-only role is allowed to hold at all.
        readKeys: [...READ_KEYS],
        readOnlyRoles: [...READ_ONLY_ROLES],
        grants,
    };
};

// ---------------------------------------------------------------------------
// Replace a role's grants. Only Admin can reach this (adminOnly is on
// the route).
// ---------------------------------------------------------------------------
const updateGrants = async (role, permissions, actorId) => {
    if (role === 'Admin') {
        throw new ApiError(400, 'Admin permissions cannot be changed');
    }
    if (!ROLES.includes(role)) {
        throw new ApiError(404, 'No such role');
    }

    // Never let unknown keys save quietly. A typo would create a permission
    // matching no route — and "I granted it and it still does not work" is
    // the hardest kind of bug to chase.
    const unknown = permissions.filter((p) => !PERMISSION_KEYS.has(p));
    if (unknown.length) {
        throw new ApiError(400, `Unknown permissions: ${unknown.join(', ')}`);
    }

    // The one switch that is not a switch. If it were grantable, the Principal
    // could hand themselves user management and nobody would know.
    const forbidden = permissions.filter((p) => ADMIN_ONLY.has(p));
    if (forbidden.length) {
        throw new ApiError(
            403,
            `This permission stays with Admin only: ${forbidden.join(', ')}`
        ).withCode('ADMIN_ONLY_PERMISSION');
    }

    // -----------------------------------------------------------------------
    // A read-only role cannot be handed a write key — not by mistake, not on
    // purpose, not by an Admin.
    //
    // The readOnly middleware would refuse the request anyway, so strictly this
    // is belt and braces. It is here because the alternative is worse than a
    // duplicate check: an Admin who could SAVE 'fee.collect' against the Watcher
    // would see a switch sitting on, believe the Watcher could collect fees, and
    // only find out otherwise when somebody tried. A permission screen that can
    // show a lie is not a permission screen.
    // -----------------------------------------------------------------------
    if (READ_ONLY_ROLES.has(role)) {
        const writes = permissions.filter((p) => !READ_KEYS.has(p));
        if (writes.length) {
            throw new ApiError(
                403,
                `${role} can only ever view — these cannot be granted: ${writes.join(', ')}`
            ).withCode('READ_ONLY_ROLE');
        }
    }

    const unique = [...new Set(permissions)];

    const updated = await RolePermission.findOneAndUpdate(
        { role },
        { $set: { permissions: unique, updatedBy: actorId }, $inc: { version: 1 } },
        { new: true, upsert: true }
    ).lean();

    // Effective immediately — no waiting for the TTL. The moment Admin saves,
    // the next request sees the new grants.
    permissionCache.invalidate(role);

    return updated;
};

// Seed the defaults at install (idempotent — existing rows are untouched)
const seedDefaults = async (actorId = null) => {
    const results = [];

    for (const [role, keys] of Object.entries(DEFAULT_GRANTS)) {
        const existing = await RolePermission.findOne({ role }).lean();
        if (existing) {
            results.push({ role, created: false });
            continue;
        }
        await RolePermission.create({ role, permissions: keys, updatedBy: actorId, version: 1 });
        results.push({ role, created: true, count: keys.length });
    }

    permissionCache.clear();
    return results;
};

module.exports = { getGrants, getCatalogue, updateGrants, seedDefaults };

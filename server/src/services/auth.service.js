const User = require('../models/user.model');
const RefreshToken = require('../models/refreshToken.model');
const ApiError = require('../utils/ApiError');
const { userCache } = require('../utils/ttlCache');
const permissionService = require('./permission.service');
const {
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    hashToken,
} = require('../utils/tokens');
const { config } = require('../config/env');
const { READ_ONLY_ROLES } = require('../utils/permissions');

// Create the refresh token row
const issueRefreshToken = async (user, meta = {}) => {
    const { token, jti } = signRefreshToken(user);
    const decoded = verifyRefreshToken(token);

    await RefreshToken.create({
        user: user._id,
        jti,
        tokenHash: hashToken(token),
        userAgent: (meta.userAgent || '').slice(0, 200),
        ip: meta.ip || '',
        expiresAt: new Date(decoded.exp * 1000),
    });

    return token;
};

// The safe user shape sent to the frontend, with permissions, so the UI
// knows which menus and buttons to show the moment login succeeds.
const buildAuthPayload = async (user) => {
    const grants = await permissionService.getGrants(user.role);

    return {
        user: {
            id: user._id,
            name: user.name,
            username: user.username,
            role: user.role,
            mustChangePassword: user.mustChangePassword,
            // This account can view everything and change nothing. Sent as a flag
            // rather than left for the browser to infer from the role name, so
            // the screens never carry a hardcoded list of role names — the same
            // reason every gate asks for a capability instead of a role.
            readOnly: READ_ONLY_ROLES.has(user.role),
        },
        permissions: [...grants],
        // What the deployment can actually do. Image upload is optional, and
        // the UI needs to know so it can leave the upload box out entirely
        // rather than offering a button that answers 503.
        features: {
            uploads: config.cloudinary.enabled,
        },
    };
};

const login = async ({ username, password }, meta = {}) => {
    // +password because the schema marks it select:false
    const user = await User.findOne({ username }).select('+password');

    // Whether the user does not exist or the password is wrong — one message.
    // Distinct messages would let someone enumerate valid usernames.
    const invalid = new ApiError(401, 'Incorrect username or password').withCode('BAD_CREDENTIALS');

    if (!user) {
        // A dummy compare could guard against timing attacks, but on a
        // three-user system that is over-engineering — the username enumeration
        // risk here is practically zero.
        throw invalid;
    }
    if (!user.isActive) {
        throw new ApiError(403, 'This account has been deactivated').withCode('DEACTIVATED');
    }

    const ok = await user.comparePassword(password);
    if (!ok) throw invalid;

    // lastLoginAt is best-effort — its failure must not block a login
    User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user, meta);

    return { accessToken, refreshToken, ...(await buildAuthPayload(user)) };
};

// ---------------------------------------------------------------------------
// Refresh with rotation + reuse detection.
//
// Every refresh revokes the old token and issues a new one. If a REVOKED
// token is used again, that token is in somebody else's hands (stolen) —
// in which case ALL of that user's sessions are revoked. The legitimate
// user simply signs in again; the thief is left with nothing.
// ---------------------------------------------------------------------------
const refresh = async (token, meta = {}) => {
    if (!token) throw new ApiError(401, 'Session not found — please sign in again').withCode('NO_REFRESH');

    let decoded;
    try {
        decoded = verifyRefreshToken(token);
    } catch {
        throw new ApiError(401, 'Session expired — please sign in again').withCode('REFRESH_EXPIRED');
    }

    const row = await RefreshToken.findOne({ jti: decoded.jti });

    if (!row) {
        throw new ApiError(401, 'Session is not valid').withCode('REFRESH_UNKNOWN');
    }

    if (row.revokedAt) {
        // Reuse detected — shut down the entire blast radius
        await RefreshToken.updateMany(
            { user: row.user, revokedAt: null },
            { $set: { revokedAt: new Date() } }
        );
        throw new ApiError(
            401,
            'All sessions were closed for security — please sign in again'
        ).withCode('REFRESH_REUSED');
    }

    if (row.tokenHash !== hashToken(token)) {
        throw new ApiError(401, 'Session is not valid').withCode('REFRESH_MISMATCH');
    }

    const user = await User.findById(row.user);
    if (!user || !user.isActive) {
        throw new ApiError(403, 'This account is no longer active').withCode('DEACTIVATED');
    }

    row.revokedAt = new Date();
    await row.save();

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user, meta);

    return { accessToken, refreshToken, ...(await buildAuthPayload(user)) };
};

// Closes the session for this device only
const logout = async (token) => {
    if (!token) return;
    try {
        const decoded = verifyRefreshToken(token);
        await RefreshToken.updateOne(
            { jti: decoded.jti, revokedAt: null },
            { $set: { revokedAt: new Date() } }
        );
    } catch {
        // Already expired or invalid — logout is treated as successful anyway
    }
};

const logoutAll = async (userId) => {
    await RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
};

const changePassword = async (userId, { currentPassword, newPassword }) => {
    const user = await User.findById(userId).select('+password');
    if (!user) throw new ApiError(404, 'User not found');

    const ok = await user.comparePassword(currentPassword);
    if (!ok) throw new ApiError(400, 'Current password is incorrect').withCode('BAD_PASSWORD');

    if (currentPassword === newPassword) {
        throw new ApiError(400, 'The new password must be different from the current one');
    }

    user.password = newPassword; // the pre-save hook hashes it
    user.mustChangePassword = false;
    await user.save();

    // Changing a password logs out every other device — if somebody changed
    // it because they were suspicious, leaving old sessions alive defeats it.
    await logoutAll(userId);
    userCache.invalidate(userId);

    return { changed: true };
};

const getMe = async (userId) => {
    const user = await User.findById(userId).lean();
    if (!user) throw new ApiError(404, 'User not found');
    return buildAuthPayload(user);
};

// Cookie options in one place — login, refresh and logout all use the same
// ones. On a mismatch the browser will not clear the old cookie and logout
// quietly stops working.
const refreshCookieOptions = () => ({
    httpOnly: true, // JS cannot read it — protects against XSS
    secure: config.isProd, // https-only in production
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
});

// clearCookie must not be given maxAge (Express 5 ignores it and currently
// warns) — every other option must match exactly, otherwise the browser
// never matches the cookie and logout fails silently.
const clearCookieOptions = () => {
    const { maxAge, ...rest } = refreshCookieOptions();
    return rest;
};

module.exports = {
    login,
    refresh,
    logout,
    logoutAll,
    changePassword,
    getMe,
    refreshCookieOptions,
    clearCookieOptions,
    buildAuthPayload,
};

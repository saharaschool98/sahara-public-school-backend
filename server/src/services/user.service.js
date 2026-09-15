const crypto = require('crypto');
const User = require('../models/user.model');
const RefreshToken = require('../models/refreshToken.model');
const ApiError = require('../utils/ApiError');
const { userCache } = require('../utils/ttlCache');
const { ROLES } = require('../utils/permissions');

// A temporary password that is easy to read and say aloud. Ambiguous
// characters (0/O, 1/l/I) are deliberately excluded — this password gets read
// over the phone or written down, and "was that 0 or O?" means a second phone
// call and a password reset.
const generateTempPassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(10);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

const list = async () =>
    User.find().select('name username email phone role isActive lastLoginAt createdAt').sort({ role: 1, name: 1 }).lean();

const create = async (payload, actorId) => {
    const { name, username, email, phone, role } = payload;

    if (!ROLES.includes(role)) throw new ApiError(400, 'No such role');

    const exists = await User.exists({ username });
    if (exists) throw new ApiError(409, 'This username is already taken');

    const tempPassword = generateTempPassword();

    const user = await User.create({
        name,
        username,
        email: email || '',
        phone: phone || '',
        password: tempPassword,
        role,
        mustChangePassword: true,
        createdBy: actorId,
    });

    // The temporary password is returned HERE and once only — it is stored
    // nowhere (the DB holds only a hash). The Admin should hand it over now.
    return {
        user: {
            id: user._id,
            name: user.name,
            username: user.username,
            role: user.role,
        },
        tempPassword,
    };
};

const update = async (id, updates, actorId) => {
    const user = await User.findById(id);
    if (!user) throw new ApiError(404, 'User not found');

    // An Admin cannot deactivate or demote themselves — otherwise the school
    // could end up with no Admin at all and be locked out of its own system.
    const selfEdit = user._id.toString() === actorId;

    if (selfEdit && updates.isActive === false) {
        throw new ApiError(400, 'You cannot deactivate your own account');
    }
    if (selfEdit && updates.role && updates.role !== user.role) {
        throw new ApiError(400, 'You cannot change your own role');
    }

    // Removing the last active Admin is not allowed either
    if (user.role === 'Admin' && (updates.isActive === false || (updates.role && updates.role !== 'Admin'))) {
        const otherAdmins = await User.countDocuments({
            role: 'Admin',
            isActive: true,
            _id: { $ne: user._id },
        });
        if (otherAdmins === 0) {
            throw new ApiError(400, 'This is the last active Admin — create another Admin first');
        }
    }

    Object.assign(user, updates);
    await user.save();

    // A role or status change clears the cache immediately — otherwise
    // requests would pass on stale permissions for up to 30 seconds.
    userCache.invalidate(id);

    if (updates.isActive === false) {
        await RefreshToken.updateMany({ user: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }

    return user;
};

// An Admin resets somebody's password — a new temporary password, and that
// closes all of that user's sessions.
const resetPassword = async (id) => {
    const user = await User.findById(id).select('+password');
    if (!user) throw new ApiError(404, 'User not found');

    const tempPassword = generateTempPassword();
    user.password = tempPassword;
    user.mustChangePassword = true;
    await user.save();

    await RefreshToken.updateMany({ user: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    userCache.invalidate(id);

    return { tempPassword };
};

module.exports = { list, create, update, resetPassword, generateTempPassword };

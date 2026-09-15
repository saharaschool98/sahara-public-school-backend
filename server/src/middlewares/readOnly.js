const ApiError = require('../utils/ApiError');
const { READ_ONLY_ROLES } = require('../utils/permissions');

// ---------------------------------------------------------------------------
// The read-only gate.
//
// A role in READ_ONLY_ROLES (today: Watcher) may issue GET requests and nothing
// else. This is not a permission check and it is not negotiable from Settings —
// it sits above the whole permission system, in one place, for the same reason
// isAuth does: a route file added tomorrow is covered automatically, with nobody
// having to remember to protect it.
//
// Granting is the second lock, not this one. permission.service.updateGrants
// refuses to save a write key against a read-only role, so the switch cannot be
// flipped either. Both exist on purpose — one makes the write impossible, the
// other makes it impossible to believe the write was allowed.
//
// WHY THE METHOD AND NOT A PERMISSION LIST
//
// Because a list has to be maintained. Every write in this app is a POST, PATCH
// or DELETE — there is no exception anywhere in the 132 routes — so the method
// IS the rule, and it stays the rule for routes nobody has written yet.
// ---------------------------------------------------------------------------

// GET requests that are not reads.
//
// /uploads/signature answers with a signed permission to write bytes into the
// school's Cloudinary account. It is a GET because that is the shape of the
// handshake, not because it reads anything, and a role that cannot save a
// record has no business holding one.
const NOT_REALLY_READS = [/^\/uploads(\/|$)/];

const readOnly = (req, _res, next) => {
    if (!READ_ONLY_ROLES.has(req.role)) return next();

    const isRead = req.method === 'GET' && !NOT_REALLY_READS.some((rx) => rx.test(req.path));

    if (!isRead) {
        throw new ApiError(
            403,
            'This account can view everything and change nothing'
        ).withCode('READ_ONLY_ROLE');
    }

    next();
};

module.exports = readOnly;

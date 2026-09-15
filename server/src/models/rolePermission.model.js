const mongoose = require('mongoose');
const { ROLES } = require('../utils/permissions');

// The data behind the whole permission system. Just two documents (Principal, Accountant) —
// Admin has no row because Admin always has everything — and a row would
// imply somebody could take it away.
const rolePermissionSchema = new mongoose.Schema(
    {
        role: {
            type: String,
            enum: ROLES.filter((r) => r !== 'Admin'),
            required: true,
        },
        permissions: { type: [String], default: [] },
        // Bumped on every save. Nothing reads it to decide freshness — the cache
        // is invalidated outright the moment an Admin saves — so this is purely a
        // record of how many times this role's grants have been rewritten, which
        // is a question the edit history gets asked.
        version: { type: Number, default: 1 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

rolePermissionSchema.index({ role: 1 }, { unique: true });

module.exports =
    mongoose.models.RolePermission || mongoose.model('RolePermission', rolePermissionSchema);

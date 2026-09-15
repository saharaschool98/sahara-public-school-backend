const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        phone: { type: String, default: '', trim: true },
        gstin: { type: String, default: '', trim: true, uppercase: true },
        address: { type: String, default: '', trim: true },

        // Denormalised — the "who do we owe" screen sorts on this.
        // Aggregating purchases minus payments would mean scanning two
        // collections on every read.
        outstanding: { type: Number, default: 0 },
        totalPurchased: { type: Number, default: 0 },
        totalPaid: { type: Number, default: 0 },

        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// Duplicate-vendor guard and search. The same vendor entered under two names is the
// reason an outstanding figure goes wrong.
vendorSchema.index({ nameLower: 1 }, { unique: true });
// "Who are we most in debt to" — one indexed read
vendorSchema.index({ isActive: 1, outstanding: -1 });

vendorSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);

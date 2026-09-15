const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// The school's own list of what it charges for beyond the monthly fee:
// Admission Fee, Exam Fee, Annual Function, Picnic, Late Fee...
//
// A list rather than free text on every charge, for the same reason expense
// categories are a list: "how much did we take on exam fees this year" is a
// question the school asks, and it cannot be answered by string-matching
// whatever somebody typed in March against whatever they typed in September.
//
// `defaultAmount` is the usual figure — the exam fee is the same every term —
// so raising one is a matter of confirming a number rather than remembering it.
// It is only a default: the amount is fixed on the CHARGE, not here, so
// changing it next year cannot rewrite what was already raised.
// ---------------------------------------------------------------------------
const chargeHeadSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        defaultAmount: { type: Number, default: 0, min: 0 },
        // Kept off the picker without disturbing anything already raised under
        // it — a head is retired, never deleted.
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

chargeHeadSchema.index({ nameLower: 1 }, { unique: true });
chargeHeadSchema.index({ isActive: 1, nameLower: 1 });

chargeHeadSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports = mongoose.models.ChargeHead || mongoose.model('ChargeHead', chargeHeadSchema);

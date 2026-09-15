const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// One student's share of one charge. The exact counterpart of FeeDemand, and
// deliberately the same shape — the office is doing the same thing at the same
// counter, so the two should not behave differently.
// ---------------------------------------------------------------------------
const chargeDemandSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },

        charge: { type: mongoose.Schema.Types.ObjectId, ref: 'Charge', required: true },
        // Denormalised so a student's own list reads without a $lookup — the
        // profile shows "Exam Fee · Term 1", not an id.
        headName: { type: String, required: true },
        title: { type: String, required: true },

        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        studentName: { type: String, required: true },
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
        className: { type: String, required: true },

        amount: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        paidAmount: { type: Number, default: 0, min: 0 },

        dueDate: { type: Date, default: null },
        status: { type: String, enum: ['Unpaid', 'Partial', 'Paid'], default: 'Unpaid' },

        discountReason: { type: String, default: '' },
        discountBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

// ---------------------------------------------------------------------------
// The same guarantee FeeDemand's { student, month } index gives, for the same
// reason: raising a charge is idempotent. Press the button twice, retry on a
// slow connection, or have two people raise the same charge at once, and no
// student is charged for it twice — the database refuses the second row
// whatever the application code does.
//
// It also makes re-raising USEFUL: a student admitted after the exam fee went
// out gets their row when the charge is topped up, and everybody else is
// untouched.
// ---------------------------------------------------------------------------
chargeDemandSchema.index({ charge: 1, student: 1 }, { unique: true });
// One student's outstanding charges — the collect screen and the profile
chargeDemandSchema.index({ student: 1, status: 1 });
// "Who has not paid the exam fee" — the working list
chargeDemandSchema.index({ charge: 1, status: 1, studentName: 1 });
// The session's whole picture, for recompute
chargeDemandSchema.index({ session: 1, status: 1 });

// Never stored — always derived, so it cannot fall out of step with the
// three numbers it comes from.
chargeDemandSchema.virtual('dueAmount').get(function dueAmount() {
    return Math.max(0, (this.amount || 0) - (this.discount || 0) - (this.paidAmount || 0));
});

chargeDemandSchema.set('toJSON', { virtuals: true });
chargeDemandSchema.set('toObject', { virtuals: true });

module.exports =
    mongoose.models.ChargeDemand || mongoose.model('ChargeDemand', chargeDemandSchema);

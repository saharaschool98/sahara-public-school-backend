const mongoose = require('mongoose');

// One student's fee for one month. This collection is what removes the need for cron
// because of the unique index below.
const feeDemandSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        month: { type: String, required: true }, // "2026-08"

        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
        studentName: { type: String, required: true }, // denormalised
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
        className: { type: String, required: true }, // denormalised

        amount: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        paidAmount: { type: Number, default: 0, min: 0 },
        // How much of paidAmount was settled out of an advance the parent had
        // already handed over, rather than money taken at the counter for this
        // month. Part of paidAmount, never added to it.
        //
        // It is stored because the answer to "which receipt paid October?" has
        // to exist. Without it the month simply reads Paid with no receipt
        // behind it, which looks like a bug to anybody checking. It is also
        // what lets an advance be taken back off the months it has already
        // settled when its receipt is voided.
        paidFromCredit: { type: Number, default: 0, min: 0 },

        dueDate: { type: Date, default: null },
        status: {
            type: String,
            enum: ['Unpaid', 'Partial', 'Paid'],
            default: 'Unpaid',
        },
        discountReason: { type: String, default: '' },
        discountBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// ---------------------------------------------------------------------------
// This one index is the backbone of the whole "no cron" design.
//
// Fee generation is idempotent because of it: if the Accountant presses the
// button twice, or a slow connection retries the request, or two people run
// it at the same moment, the database physically refuses the second row.
// No student can be charged twice, however wrong the application code
// happens to be.
//
// It also means re-running generation is safe: only students added in
// between get new rows.
// ---------------------------------------------------------------------------
feeDemandSchema.index({ student: 1, month: 1 }, { unique: true });

// "Class 6-B, August, who has not paid" — the fee screen's main query
feeDemandSchema.index({ session: 1, month: 1, class: 1, status: 1 });
// One student's fee ledger, newest first
feeDemandSchema.index({ student: 1, month: -1 });
// Month-wide summary and pending list
feeDemandSchema.index({ session: 1, month: 1, status: 1 });

// What is still due. Never stored — always derived, so it can never fall
// out of sync with amount/discount/paid.
feeDemandSchema.virtual('dueAmount').get(function dueAmount() {
    return Math.max(0, (this.amount || 0) - (this.discount || 0) - (this.paidAmount || 0));
});

feeDemandSchema.set('toJSON', { virtuals: true });
feeDemandSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.FeeDemand || mongoose.model('FeeDemand', feeDemandSchema);

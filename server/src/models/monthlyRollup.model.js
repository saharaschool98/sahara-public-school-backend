const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Pre-aggregated totals. The dashboard and class-wise report read these.
//
// Why: Solar4U's admin dashboard fires nine aggregations in parallel. On a
// dedicated VPS that is fine; on M0's shared CPU it would be the slowest
// screen in the app. Here every movement of money $incs this document, so
// the dashboard is one small find() — and stays just as fast after three years
// of data.
//
// The cost: if a new write path forgets to update the rollup, the number
// goes quietly wrong. That is why every money mutation goes through
// ledger.service ONLY, and the recompute script rebuilds these from the
// ledger and reports any drift.
// ---------------------------------------------------------------------------
const monthlyRollupSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        month: { type: String, required: true }, // "2026-08"
        // SCHOOL = the whole school's total; CLASS = one class
        scope: { type: String, enum: ['SCHOOL', 'CLASS'], required: true },
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', default: null },
        className: { type: String, default: '' },

        // Fee side
        feeExpected: { type: Number, default: 0 }, // set when demands are generated
        feeCollected: { type: Number, default: 0 },
        feeDiscount: { type: Number, default: 0 },

        // Other income
        stockSales: { type: Number, default: 0 },
        // Its own head rather than folded into otherIncome — the school asks
        // "how much came in from ID cards" as its own question, and a number
        // buried inside a bucket cannot answer it.
        idCardCollected: { type: Number, default: 0 },
        // Admission, exams, trips — raised through the Other Fees module.
        chargeCollected: { type: Number, default: 0 },
        otherIncome: { type: Number, default: 0 },

        // Spend
        expenses: { type: Number, default: 0 },
        salaries: { type: Number, default: 0 },
        vendorPaid: { type: Number, default: 0 },
        purchases: { type: Number, default: 0 }, // bill value, not cash

        // Advance handed back to a parent. Its own head for exactly the reason
        // ID cards and other fees have one: "how much did we give back this
        // year" is a question the school asks, and a number that only exists as
        // a deduction inside feeCollected cannot answer it.
        //
        // It is also what makes the cash book EXACT rather than derived. Money
        // out is expenses + salaries + vendor payments + this, and money in as
        // fees is feeCollected + this — both add up by construction instead of
        // by subtracting one total from another and hoping nothing else is in
        // there. See report.service.cashbook.
        feeRefunds: { type: Number, default: 0 },

        // Cash movement — the sum of the heads above, kept separately so the day
        // book and dashboard can read it directly.
        cashIn: { type: Number, default: 0 },
        cashOut: { type: Number, default: 0 },

        // ---- the same money, split by HOW it moved ----
        //
        // The cash box is counted, the UPI app is opened, the bank statement is
        // checked and the cheque book is flipped through — four separate
        // reconciliations, and one combined figure matches none of them. The day
        // book already splits a single DAY this way by reading its rows; this is
        // the same split maintained as a running total, so "what is in hand
        // right now" is a small find() over a session's months rather than a
        // scan of every transaction the school has ever written.
        //
        // SCHOOL SCOPE ONLY. A class does not have a cash box, and carrying
        // eight more numbers on every class's every month would be storage
        // spent on a question nobody asks. ledger.bumpRollup keeps them out of
        // the class documents deliberately — see `schoolOnly` there.
        inByMode: {
            Cash: { type: Number, default: 0 },
            UPI: { type: Number, default: 0 },
            Bank: { type: Number, default: 0 },
            Cheque: { type: Number, default: 0 },
            // Not a real movement of money, and so never part of what is in
            // hand. It is carried anyway, because a mode that exists and is
            // missing here would make the split stop adding up to cashIn —
            // and a cash book whose columns do not add up is worse than none.
            Adjustment: { type: Number, default: 0 },
        },
        outByMode: {
            Cash: { type: Number, default: 0 },
            UPI: { type: Number, default: 0 },
            Bank: { type: Number, default: 0 },
            Cheque: { type: Number, default: 0 },
            Adjustment: { type: Number, default: 0 },
        },

        lastRecomputedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// The upsert target for every $inc, and the dashboard's read key.
// class is null at SCHOOL scope — Mongo indexes null too, so the unique
// constraint holds correctly across both scopes.
monthlyRollupSchema.index({ session: 1, month: 1, scope: 1, class: 1 }, { unique: true });
// "Every month in this session" — the trend chart
monthlyRollupSchema.index({ session: 1, scope: 1, month: 1 });

module.exports =
    mongoose.models.MonthlyRollup || mongoose.model('MonthlyRollup', monthlyRollupSchema);

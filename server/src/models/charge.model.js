const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// ONE RAISING EVENT — "Exam Fee, ₹500, Classes 1 to 5, due 20 September".
//
// The office calls these OTHER FEES: everything a student is charged that is
// not the monthly fee — admission, exams twice a year, a trip, a late fee.
//
// WHY THIS IS NOT A FeeDemand
//
// FeeDemand carries a unique index on { student, month }, and that one index is
// the whole reason monthly generation is safe to press twice. A student can owe
// September's fee AND September's exam fee at the same time, so folding these
// into that collection would mean widening the index that makes the most
// important operation in the app idempotent. Not worth it, for a saving of one
// collection.
//
// So: a Charge is the event, and ChargeDemand is one student's share of it —
// the same parent/child shape, with its own unique index doing the same job.
//
// The AMOUNT LIVES HERE and is copied onto each demand at raise time. A trip
// that cost ₹1,200 in August stays ₹1,200 on every demand it raised, however
// the head's default is edited afterwards.
// ---------------------------------------------------------------------------

// Who it landed on. Recorded so the screen can say what was asked for, not just
// what the result happened to be — "all of Class 5" reads differently from a
// list of thirty-one names, even when they are the same thirty-one people.
const SCOPES = ['SCHOOL', 'CLASS', 'STUDENT'];

const chargeSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },

        head: { type: mongoose.Schema.Types.ObjectId, ref: 'ChargeHead', required: true },
        headName: { type: String, required: true }, // denormalised — every list shows it

        // What this particular raising was for: "Term 1 exam", "Jaipur trip".
        // The head says the kind, this says the occasion.
        title: { type: String, required: true, trim: true },

        amount: { type: Number, required: true, min: 0 },
        dueDate: { type: Date, default: null },

        scope: { type: String, enum: SCOPES, required: true },
        // Filled at CLASS scope. Empty at SCHOOL and STUDENT scope.
        classes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass' }],
        classNames: [{ type: String }],

        // Totals, maintained as money moves — the list screen reads these and
        // never counts demands. Same reasoning as MonthlyRollup.
        studentCount: { type: Number, default: 0 },
        totalRaised: { type: Number, default: 0 },
        totalCollected: { type: Number, default: 0 },
        totalDiscount: { type: Number, default: 0 },

        note: { type: String, default: '' },
        raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

        // ---- cancelling a whole charge ----
        //
        // A charge raised by mistake — the wrong amount, the wrong classes. It is
        // never deleted: the demands are withdrawn, the students' balances come
        // back down, and the row stays with a reason on it. A charge somebody can
        // make disappear is a charge nobody can be asked about.
        //
        // Refused once any money has been collected against it: that receipt
        // would be left pointing at nothing. Those are voided one at a time,
        // deliberately, by a person.
        cancelled: { type: Boolean, default: false },
        cancelledAt: { type: Date, default: null },
        cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        cancelReason: { type: String, default: '' },
    },
    { timestamps: true }
);

// The list screen: this session's charges, newest first
chargeSchema.index({ session: 1, createdAt: -1 });
// "Everything raised under Exam Fee" — the year-end question the head exists for
chargeSchema.index({ session: 1, head: 1, createdAt: -1 });

module.exports = mongoose.models.Charge || mongoose.model('Charge', chargeSchema);
module.exports.SCOPES = SCOPES;

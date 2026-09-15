const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        admissionNo: { type: String, required: true }, // ADM0412, from the counter
        name: { type: String, required: true, trim: true },
        // Search key. The anchored regex (^) runs on this so Mongo can walk the
        // index — see utils/search.js for why.
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        // The father, or whoever else stands as guardian. Kept as `guardianName`
        // rather than renamed to `fatherName`, because the guardian is not always
        // a parent — and every receipt, report and roster already reads this
        // field.
        guardianName: { type: String, default: '', trim: true },
        // The mother's name, separately. An admission form asks for both, a
        // transfer certificate prints both, and folding her into "guardian"
        // means the school simply does not have it when it is asked for.
        motherName: { type: String, default: '', trim: true },

        // Date of birth. Optional, because the office does not always have it on
        // admission day and refusing the admission over it would be absurd — but
        // a TRANSFER CERTIFICATE prints it, and a TC without a date of birth is
        // the one the receiving school hands straight back. So it is asked for on
        // the form, and the TC says plainly when it is missing rather than
        // printing a blank line nobody notices.
        dob: { type: Date, default: null },

        // The number the office rings first.
        phone: { type: String, required: true, trim: true },
        // A second number — the other parent, or a neighbour. Optional, and the
        // reason the first one being unreachable is not a dead end.
        altPhone: { type: String, default: '', trim: true },
        address: { type: String, default: '', trim: true },

        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
        // Denormalised — the student list, fee receipts and the defaulters report
        // all show the class name. Without it every list API would need a $lookup,
        // the most expensive step on a hot read path.
        className: { type: String, required: true },

        // Defaults from the class but can be overridden per student — the sibling
        // concession and staff-child cases, handled without a special feature.
        monthlyFee: { type: Number, required: true, min: 0 },

        status: { type: String, enum: ['Active', 'Left'], default: 'Active' },
        admissionDate: { type: Date, required: true },
        leftAt: { type: Date, default: null },
        // Why they went — moved city, shifted school, finished Class 8. Free
        // text, because the reasons do not form a list anybody could agree on,
        // and it is the line the TC prints.
        leftReason: { type: String, default: '', trim: true },
        photo: {
            publicId: { type: String, default: '' },
            width: Number,
            height: Number,
        },

        // ---- Denormalised balances ----
        // These two fields are why the whole fee module is fast. The student card,
        // the defaulters list and the dashboard's outstanding all read them and
        // never run an aggregation. They are $inc'd on every movement of money
        // (ledger.service), and the recompute script rebuilds them from the ledger
        // to check for drift.
        feeOutstanding: { type: Number, default: 0 },
        stockOutstanding: { type: Number, default: 0 },
        // Admission, exams, a trip — everything charged beyond the monthly fee.
        // Its own field rather than folded into feeOutstanding, because the
        // office chases them separately: "the fee is clear, the trip money is
        // not" is a real sentence at the counter.
        chargeOutstanding: { type: Number, default: 0 },

        // Fee money the school is holding that no month has claimed yet.
        //
        // A parent who pays the whole year in September has bought six months
        // that have not been raised, and there is nowhere to put that money:
        // the demands do not exist. It sits here instead, and each month's
        // generation settles the new demand out of it, oldest first.
        //
        // It is NOT negative feeOutstanding, deliberately. feeOutstanding is
        // summed across the school for "what is owed to us", and one parent
        // paying ahead must not quietly make another parent's dues look
        // smaller. This is the school's liability, not a receivable, and every
        // screen that shows it says so.
        creditBalance: { type: Number, default: 0 },

        // How much of that credit was CARRIED IN from last session.
        //
        // A parent paying in March for April's fee is paying for next year, so
        // an advance has to survive the rollover — it is the school's liability
        // and a session boundary does not settle it.
        //
        // It needs recording separately because creditBalance is REBUILT from
        // its sources when drift is checked: fee money no month claimed, less
        // what later months ate, less what was handed back — all within one
        // session. A balance carried in has none of those rows behind it, so
        // without this field recomputeBalances would call it drift and
        // `--fix` would quietly wipe money the school owes people.
        //
        // The same idea as AcademicSession.openingBalance for the cash book:
        // where the counting starts, written down.
        openingCredit: { type: Number, default: 0 },

        // ---- Siblings ----
        //
        // Brothers and sisters share a GROUP ID rather than each carrying a list
        // of the others.
        //
        // Siblinghood is an equivalence relation: if Aarav and Diya are siblings
        // and Diya and Kabir are siblings, then Aarav and Kabir are too, and
        // nobody should have to record that third link by hand. A list of pairs
        // makes the office maintain n(n-1)/2 links for one family and lets them
        // disagree; one id per family cannot.
        //
        // null = no sibling in the school. A group always has at least two
        // members — the moment it would drop to one, the service clears it,
        // because "a family of one" is just a student.
        siblingGroup: { type: mongoose.Schema.Types.ObjectId, default: null },

        // ---- ID card ----
        // A flag on the student rather than a collection of its own: there is at
        // most ONE card per student, the question asked is always "who has not
        // taken theirs" (a class-wise count), and a flag answers that from the
        // same index the roster already uses — no join, no aggregation over a
        // second collection.
        //
        // The money is NOT stored here as a balance. `amount` is a record of what
        // was taken at issue; the cash itself goes through ledger.service like
        // every other rupee, and `txn` points at that row.
        idCard: {
            issued: { type: Boolean, default: false },
            issuedAt: { type: Date, default: null },
            amount: { type: Number, default: 0, min: 0 },
            issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            // The ledger row this collection wrote. Cancelling reverses THIS row,
            // rather than guessing which transaction belonged to the card —
            // the same lesson as fee receipts and their covered months.
            txn: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
            note: { type: String, default: '' },
        },

        // ---- Transfer certificate ----
        //
        // A flag on the student, exactly like the ID card above and for exactly
        // the same reasons: there is at most ONE TC per student, the question the
        // office asks is always "who has left and not been given theirs", and a
        // flag answers that off the same index the roster already walks — no
        // second collection, no join, no aggregation.
        //
        // The number is generated from the counter (TC0001, per session) and is
        // unique across the school. It is the number the receiving school quotes
        // back, so it cannot be reused and it cannot be edited.
        //
        // `markedLeft` is the field that makes cancelling exact. Issuing a TC for
        // a student who is still on the roll ALSO marks them Left — that is one
        // act at the counter, not two. But a TC can equally be issued for a child
        // who was marked Left last month, and cancelling that one must not drag
        // them back onto the roster. So the issue records whether it was the thing
        // that moved the status, and the cancel reverses exactly that. Same
        // lesson as `covered` on a fee receipt: store what you did, so the inverse
        // is the inverse by construction rather than by guesswork.
        tc: {
            given: { type: Boolean, default: false },
            // Unique across the school — see the partial index below.
            no: { type: String, default: null },
            issuedAt: { type: Date, default: null },
            issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            // Why the child is leaving. Printed on the certificate.
            reason: { type: String, default: '' },
            conduct: { type: String, default: '' },
            // Did THIS issue mark them Left? See above.
            markedLeft: { type: Boolean, default: false },
            // What was still owed, and what the school was still holding, at the
            // moment the certificate was signed. Frozen figures, not live ones:
            // the whole point of writing them down is that somebody can be asked
            // about them a year later, when the balances have moved on. They are
            // also the record that an override happened — a TC issued over unpaid
            // dues shows the dues it was issued over.
            duesAtIssue: { type: Number, default: 0 },
            creditAtIssue: { type: Number, default: 0 },
            note: { type: String, default: '' },
        },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// Per-session admission numbers
studentSchema.index({ session: 1, admissionNo: 1 }, { unique: true });
// Class roster, alphabetically — filter AND sort both from the index, no
// in-memory sort (ESR: equality session+status+class, then sort nameLower)
studentSchema.index({ session: 1, status: 1, class: 1, nameLower: 1 });
// Search by name across the whole school
studentSchema.index({ session: 1, status: 1, nameLower: 1 });
// "The guardian is on the phone" — the office's most common lookup
studentSchema.index({ phone: 1 });
// Defaulters list with no aggregation
studentSchema.index({ session: 1, status: 1, feeOutstanding: -1 });
// "Class 5-B — who has not taken their ID card". Equality on session, status
// and the flag, then class: the count and the list both come off this index.
studentSchema.index({ session: 1, status: 1, 'idCard.issued': 1, class: 1 });
// "Who has left and not been given their TC yet" — the office's working list,
// and the only question this module is ever asked. Equality on session, status
// and the flag: the list and its count both come straight off this index, with
// no aggregation and no scan of the roster.
studentSchema.index({ session: 1, status: 1, 'tc.given': 1, nameLower: 1 });
// A TC number is quoted back by the receiving school, so it can never be
// reused. Partial rather than sparse, for the same reason receiptNo is: the
// schema stores `default: null`, and to a unique sparse index two nulls are
// duplicates — every student without a TC would collide with every other.
studentSchema.index(
    { 'tc.no': 1 },
    { unique: true, partialFilterExpression: { 'tc.no': { $type: 'string' } } }
);
// One family's members. Partial, so the hundreds of students with no sibling in
// the school never enter the index at all — only the ones actually in a group.
studentSchema.index(
    { siblingGroup: 1 },
    { partialFilterExpression: { siblingGroup: { $type: 'objectId' } } }
);

// so nameLower never has to be set by hand
studentSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports = mongoose.models.Student || mongoose.model('Student', studentSchema);

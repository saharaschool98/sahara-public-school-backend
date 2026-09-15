const Transaction = require('../models/transaction.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');
const ledger = require('./ledger.service');
// The four modules that own money a student hands over at the counter. None of
// them reaches back to this file, so there is no cycle — this is the screen
// that looks at all four, not a thing any of them needs to know about.
const feeService = require('./fee.service');
const chargeService = require('./charge.service');
const saleService = require('./sale.service');
const studentService = require('./student.service');
const withTransaction = require('../utils/withTransaction');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2 } = require('../utils/money');
const { startOfDayIST, endOfDayIST } = require('../utils/istDate');

// ---------------------------------------------------------------------------
// VERIFYING COLLECTED MONEY
//
// Somebody at the counter takes a fee, sells a uniform, issues an ID card. The
// receipt prints, the balance moves, the day book records it — all of that is
// already done and none of it waits for anybody's approval, because the parent
// is standing there and the money is in the drawer.
//
// What was missing is the second pair of eyes AFTERWARDS: the person in charge
// sitting down with the cash box, the UPI app and the bank statement and
// ticking off each entry as genuinely received. Until they do, an entry is
// simply unverified — that is a STATUS, not a hold.
//
// The one rule this module lives by: verifying changes nothing but the flag.
// No balance, no rollup, no fee demand, no ledger row. If ticking a box could
// move a number, it would be a second and much quieter way to edit the books,
// and the whole append-only design would be for nothing.
//
// The flag also decides how long an entry stays correctable. Unverified, the
// office can still fix what it wrote down; verified, the row is sealed against
// both editing and voiding. See `update` below, and transaction.model.js for
// the seal itself.
// ---------------------------------------------------------------------------

const { VERIFIABLE_FILTER } = Transaction;

const LIST_FIELDS =
    'receiptNo txnDate type amount mode party className note verified verifiedAt verifiedByName';

// Rows written before verification existed have no `verified` field at all, and
// `{ verified: false }` does not match a missing field. So "pending" is always
// asked as "not true" — that way the feature works on the day it ships, with no
// migration to remember and no back-dated payment quietly invisible.
const PENDING = { verified: { $ne: true } };
const VERIFIED = { verified: true };

const statusFilter = (status) =>
    status === 'pending' ? PENDING : status === 'verified' ? VERIFIED : {};

// ---------------------------------------------------------------------------
// One day's collections, with the day's own tally.
// ---------------------------------------------------------------------------
const listForDate = async (query = {}) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const date = startOfDayIST(query.date || new Date());
    const dayFilter = { session, ...VERIFIABLE_FILTER, txnDate: { $gte: date, $lte: endOfDayIST(date) } };

    const [listed, tally, pendingAll] = await Promise.all([
        fetchPage(
            Transaction.find({ ...dayFilter, ...statusFilter(query.status) })
                .select(LIST_FIELDS)
                // Oldest first: the day is worked through in the order the
                // money actually came in, which is the order the cash box and
                // the UPI history are read in.
                .sort({ txnDate: 1 }),
            { page, limit, withTotal: true }
        ),

        // The tally is for the WHOLE DAY, never for the current filter —
        // otherwise "3 still to check" would read as "0 still to check" the
        // moment somebody switched the view to Verified.
        //
        // Grouped on a computed boolean rather than on the raw field, so a
        // missing `verified` buckets with false instead of forming a third
        // group of its own.
        Transaction.aggregate([
            { $match: dayFilter },
            {
                $group: {
                    _id: { $eq: ['$verified', true] },
                    count: { $sum: 1 },
                    amount: { $sum: '$amount' },
                },
            },
        ]),

        // Without this the screen can only answer "is this date done?", and
        // finding the dates that are NOT done would mean clicking back through
        // the calendar one day at a time.
        oldestPending(session),
    ]);

    const verified = tally.find((t) => t._id === true) || { count: 0, amount: 0 };
    const pending = tally.find((t) => t._id === false) || { count: 0, amount: 0 };

    return {
        date,
        // Every row here is verifiable by construction — the filter says so. It
        // is still stamped explicitly, because the same VerifyMark component
        // renders these rows and the day book's, and it must not have to guess
        // which list it is looking at.
        items: listed.items.map((t) => ({ ...t, verifiable: true })),
        pagination: listed.pagination,
        summary: {
            count: verified.count + pending.count,
            amount: round2(verified.amount + pending.amount),
            verifiedCount: verified.count,
            verifiedAmount: round2(verified.amount),
            pendingCount: pending.count,
            pendingAmount: round2(pending.amount),
        },
        pendingAll,
    };
};

// How much of the session is still unchecked, and where to start. A count and
// one indexed read — cheap enough to send with every page of the list.
const oldestPending = async (session) => {
    const filter = { session, ...VERIFIABLE_FILTER, ...PENDING };

    const [count, oldest] = await Promise.all([
        Transaction.countDocuments(filter),
        Transaction.findOne(filter).select('txnDate').sort({ txnDate: 1 }).lean(),
    ]);

    return { count, oldestDate: oldest?.txnDate || null };
};

// ---------------------------------------------------------------------------
// Tick and untick.
//
// Both directions exist on purpose. A tick put on the wrong row has to be
// removable, or the only way to correct it is to edit the database by hand —
// and the audit trail records both, so nothing is lost by allowing it.
// ---------------------------------------------------------------------------
const setVerified = async (id, verified, actor) => {
    const txn = await Transaction.findById(id).select(`${LIST_FIELDS} direction voided`).lean();
    if (!txn) throw new ApiError(404, 'Payment not found');

    if (!Transaction.isVerifiable(txn)) {
        throw new ApiError(
            400,
            txn.voided
                ? 'This entry has been voided — there is nothing left to verify'
                : 'Only money collected from a student can be verified'
        ).withCode('NOT_VERIFIABLE');
    }

    const stamp = verified
        ? { verified: true, verifiedAt: new Date(), verifiedBy: actor.id, verifiedByName: actor.name || '' }
        : { verified: false, verifiedAt: null, verifiedBy: null, verifiedByName: '' };

    // Conditional, so two people clicking the same row in the same second
    // cannot both write. The loser is NOT an error: the row already holds the
    // state they asked for, which is the only thing they wanted.
    const updated = await Transaction.findOneAndUpdate(
        { _id: id, ...(verified ? PENDING : VERIFIED) },
        { $set: stamp },
        { new: true }
    )
        .select(LIST_FIELDS)
        .lean();

    if (!updated) {
        const current = await Transaction.findById(id).select(LIST_FIELDS).lean();
        return { payment: current, changed: false };
    }

    return { payment: updated, changed: true };
};

// ---------------------------------------------------------------------------
// CORRECTING AN ENTRY THAT HAS NOT BEEN CHECKED YET
//
// While a payment is unverified the office can still fix what it wrote down.
// Once it has been signed off against the cash box it is sealed — see
// transaction.model.js for why the two states exist.
//
// Three things can be corrected, and they are not the same kind of change:
//
//   mode — the one the reconciliation itself turns up. "Cash" was written and
//          the money arrived by UPI: the drawer is short by exactly that and
//          the app is over by it, and until the row is corrected neither will
//          tally. Moves no money.
//
//   note — the cheque number, the UPI reference, who handed the money over.
//          Moves no money either.
//
//   amount — this one DOES move money, and every record behind it has to move
//          with it: the months a fee receipt paid, the charges an other-fee
//          receipt cleared, the credit half of a stock bill, the figure a card
//          was issued for, the student's balance, and the month's rollup. It
//          is the reason the second half of this file exists.
//
// What still cannot be corrected is WHO paid and WHAT FOR. A receipt written
// against the wrong student, or a stock bill with the wrong items on it, is not
// a mistyped figure — it is the wrong document, and the way to fix a wrong
// document is to void it and write the right one.
//
// A reprint matters after an amount change. The slip in the parent's hand is
// now wrong, and the correction is only possible in the short window before
// anybody has reconciled the day, so handing over a fresh one is realistic.
// ---------------------------------------------------------------------------

// Which module owns the money behind each kind of counter slip.
//
// An amount is not a number sitting on a ledger row. It is what a fee demand
// shows as paid, what a bill shows as still owed, what a card was issued for.
// Only the module that wrote those can move them back, so this dispatches
// instead of reaching into four collections from here — the same reason
// nothing outside ledger.service writes a transaction.
//
// Every one of them is handed the mongoose session and returns the fields the
// ledger row should now carry.
const MONEY_OWNER = {
    FEE: (txn, amount, s) => feeService.reviseReceipt(txn, amount, s),
    CHARGE: (txn, amount, s) => chargeService.reviseReceipt(txn, amount, s),
    STOCK_SALE: (txn, amount, s) => saleService.revisePayment(txn, amount, s),
    ID_CARD: (txn, amount, s) => studentService.reviseIdCardAmount(txn, amount, s),
};

const update = async (id, changes, actor) => {
    // The whole document, not the list projection: an amount correction needs
    // the allocation this receipt recorded, and which document it points at.
    const txn = await Transaction.findById(id).lean();
    if (!txn) throw new ApiError(404, 'Payment not found');

    // The same test the tick uses. An expense or a salary is not somebody's
    // counter slip to correct, and a voided row has nothing left to correct.
    if (!Transaction.isVerifiable(txn)) {
        throw new ApiError(
            400,
            txn.voided
                ? 'This entry has been voided — write a fresh one instead of correcting it'
                : 'Only money collected from a student can be corrected here'
        ).withCode('NOT_VERIFIABLE');
    }

    if (Transaction.isSealed(txn)) {
        throw new ApiError(409, Transaction.SEALED_MESSAGE).withCode('PAYMENT_VERIFIED');
    }

    const set = {};
    if (changes.mode !== undefined) set.mode = changes.mode;
    if (changes.note !== undefined) set.note = changes.note;

    // The dialog sends every field it shows, so an amount that came back
    // unchanged is not a change — only a different figure is.
    const asked = changes.amount === undefined ? null : round2(changes.amount);
    const movesMoney = asked !== null && asked !== round2(txn.amount);

    if (!Object.keys(set).length && !movesMoney) throw new ApiError(400, 'Nothing to change');

    // A mode correction moves no balance and no total, but it DOES move the
    // money between drawers — ₹5,000 counted in the cash box that actually
    // arrived by UPI. The cash book is maintained per mode, so this is not free
    // any more, and it has to be atomic with the row's own update or the two
    // disagree permanently.
    const modeMoved = set.mode !== undefined && set.mode !== txn.mode;

    // ---- the cheap path: nothing here touches a balance, a rollup or a mode ----
    if (!movesMoney && !modeMoved) {
        // Conditional on STILL being unverified, so an edit cannot land in the
        // same second somebody signs the row off — otherwise the person
        // reconciling would tick a figure and it would change underneath them.
        const updated = await Transaction.findOneAndUpdate(
            { _id: id, ...PENDING, voided: { $ne: true } },
            { $set: set },
            { new: true }
        )
            .select(LIST_FIELDS)
            .lean();

        if (!updated) {
            throw new ApiError(409, Transaction.SEALED_MESSAGE).withCode('PAYMENT_VERIFIED');
        }

        return { before: txn, payment: updated };
    }

    // ---- the mode path: the row and its drawer, together or not at all ----
    if (!movesMoney) {
        await withTransaction(async (mongoSession) => {
            // Guarded on the mode that was READ, not just on the row being
            // unverified. Two people moving the same receipt between drawers in
            // the same second would otherwise each take it off a bucket it was
            // no longer in, and the cash book would end up short by one of them.
            const moved = await Transaction.findOneAndUpdate(
                { _id: id, mode: txn.mode, ...PENDING, voided: { $ne: true } },
                { $set: set },
                { new: true, session: mongoSession }
            ).lean();

            if (!moved) {
                throw new ApiError(
                    409,
                    'This payment changed while it was being corrected — open it again and check it'
                ).withCode('STALE_PAYMENT');
            }

            return ledger.moveMode({ original: txn, mode: set.mode }, mongoSession);
        });

        const payment = await Transaction.findById(id).select(LIST_FIELDS).lean();
        return { before: txn, payment };
    }

    // ---- the money path ----
    const revise = MONEY_OWNER[txn.type];
    if (!revise) {
        throw new ApiError(
            400,
            'The amount on this entry cannot be corrected — void it and enter it again'
        ).withCode('AMOUNT_LOCKED');
    }

    await withTransaction(async (mongoSession) => {
        // The owning module moves its own records first and says what the row
        // should now record as covered. If it refuses — more than the student
        // owes, a bill that has since taken money — nothing below runs and
        // nothing above it commits.
        const { set: owned = {} } = await revise(txn, asked, mongoSession);

        // The row and the rollups together, last, in the same session.
        return ledger.reviseAmount(
            { original: txn, amount: asked, set: { ...set, ...owned } },
            mongoSession
        );
    });

    // Read back through the list projection, so a correction that moved money
    // answers with exactly the same shape as one that did not.
    const payment = await Transaction.findById(id).select(LIST_FIELDS).lean();

    return { before: txn, payment };
};

module.exports = { listForDate, setVerified, update, oldestPending, LIST_FIELDS };

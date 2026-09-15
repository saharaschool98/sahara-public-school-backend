const Transaction = require('../models/transaction.model');
const MonthlyRollup = require('../models/monthlyRollup.model');
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const { monthKeyIST } = require('../utils/istDate');

// ---------------------------------------------------------------------------
// The ONLY door through which money moves in this school.
//
// No other service calls Transaction.create() directly. The reason is
// simple: writing a transaction row is half the job — the rollups must
// move with it, or the dashboard goes quietly wrong and nobody notices
// for months. Doing both in one place makes forgetting impossible.
//
// Entity balances (Student.feeOutstanding, Vendor.outstanding) stay the
// CALLER's responsibility, because they differ per type — but they must happen
// inside the same mongoose session that is passed in here.
// ---------------------------------------------------------------------------

// Which type moves which rollup field.
// Each entry: [rollup field, cash field]. A null cash field means it is
// not a cash movement (no such type today, but a case like a credit
// purchase could arrive later).
const ROLLUP_MAP = {
    FEE: ['feeCollected', 'cashIn'],
    STOCK_SALE: ['stockSales', 'cashIn'],
    ID_CARD: ['idCardCollected', 'cashIn'],
    // Admission, exam, trip — its own head, not folded into otherIncome, for
    // the same reason ID cards have one: "how much came in on exam fees" is a
    // question the school asks, and a number buried in a bucket cannot answer it.
    CHARGE: ['chargeCollected', 'cashIn'],
    OTHER_IN: ['otherIncome', 'cashIn'],
    EXPENSE: ['expenses', 'cashOut'],
    SALARY: ['salaries', 'cashOut'],
    VENDOR_PAY: ['vendorPaid', 'cashOut'],
    OTHER_OUT: [null, 'cashOut'],
    // The odd one out, and the last two slots exist for it: giving an advance
    // back takes the fee collection DOWN while the cash going out is counted
    // like any other payment out. Money handed back was never collected, and a
    // year whose collection figure includes refunds is overstated.
    //
    // The fourth slot is a SECOND head, moving with the cash rather than
    // against it — so the same rupee is subtracted from what was collected and
    // added to what was returned. Without it "how much did we hand back" exists
    // only as a hole in another number, and the cash book's money-out column
    // has to be built by subtraction instead of by addition. Same reasoning
    // that gives ID cards and other fees heads of their own.
    FEE_REFUND: ['feeCollected', 'cashOut', -1, 'feeRefunds'],
};

// The modes a rupee can move by. Fixed, and deliberately listed here rather
// than read off the Transaction enum: these are the keys of an $inc path, and a
// path a strict schema does not know is DROPPED SILENTLY — the row would be
// written, the mode total would not move, and nothing anywhere would say so.
// Listed, so an unknown one throws instead. See modeFieldsFor.
const MODES = ['Cash', 'UPI', 'Bank', 'Cheque', 'Adjustment'];

// What is genuinely in the school's hands. 'Adjustment' is tracked like any
// other mode so the split keeps adding up to cashIn — but it moves no real
// money, so it is not part of a balance anybody can spend or count.
const CASH_MODES = ['Cash', 'UPI', 'Bank', 'Cheque'];

// The one $inc path for a mode's side of the ledger. Direction, not type:
// what the money was FOR is already in the heads above; this only records
// which drawer it came out of or went into.
const modeFieldsFor = (direction, mode, signedAmount) => {
    if (!MODES.includes(mode)) {
        throw new ApiError(500, `Unknown payment mode: ${mode}`);
    }
    const bucket = direction === 'IN' ? 'inByMode' : 'outByMode';
    return { [`${bucket}.${mode}`]: round2(signedAmount) };
};

// The same $inc lands in two places: the school-wide rollup and (for fees)
// that class's rollup. Both are upserts — the first entry creates the
// document, so nothing needs seeding at the start of a month.
//
// `schoolOnly` is for figures that belong to the school and not to a class —
// today, the split by payment mode. A class does not have a cash box, so
// carrying its own Cash/UPI/Bank/Cheque totals would be eight numbers per class
// per month answering a question nobody asks.
const bumpRollup = async (
    { session, month, classId = null, className = '', fields = {}, schoolOnly = {} },
    mongoSession
) => {
    // Zeroes are dropped rather than written: an $inc of 0 is a pointless write
    // on every row that did not move.
    const clean = (obj) => {
        const inc = {};
        for (const [key, value] of Object.entries(obj)) {
            if (value) inc[key] = round2(value);
        }
        return inc;
    };

    const shared = clean(fields);
    const school = { ...shared, ...clean(schoolOnly) };

    const ops = [];

    if (Object.keys(school).length) {
        ops.push({
            updateOne: {
                filter: { session, month, scope: 'SCHOOL', class: null },
                update: { $inc: school, $setOnInsert: { session, month, scope: 'SCHOOL', class: null } },
                upsert: true,
            },
        });
    }

    // Deliberately `shared`, not `school`. A mode-only movement — correcting a
    // receipt from Cash to UPI — has nothing for a class to record, and this is
    // what stops it writing an empty class document for the privilege.
    if (classId && Object.keys(shared).length) {
        ops.push({
            updateOne: {
                filter: { session, month, scope: 'CLASS', class: classId },
                update: {
                    $inc: shared,
                    $setOnInsert: { session, month, scope: 'CLASS', class: classId, className },
                },
                upsert: true,
            },
        });
    }

    if (!ops.length) return;

    await MonthlyRollup.bulkWrite(ops, { session: mongoSession, ordered: false });
};

// The rollup fields this transaction type changes.
//
// `headSign` lets a type move its head in the opposite direction from its cash
// — only a refund does, and it defaults to +1 so every other entry reads the
// way it always did. A reversal still works out: it passes a negative amount,
// which flips both halves together.
const rollupFieldsFor = (type, signedAmount) => {
    const mapping = ROLLUP_MAP[type];
    if (!mapping) return {};

    const [head, cash, headSign = 1, alsoHead = null] = mapping;
    const fields = {};
    if (head) fields[head] = round2(signedAmount * headSign);
    if (cash) fields[cash] = signedAmount;
    // Moves WITH the cash, unlike `head` — see FEE_REFUND above.
    if (alsoHead) fields[alsoHead] = signedAmount;
    return fields;
};

// ---------------------------------------------------------------------------
// Record a transaction and update the rollups.
//
// mongoSession is optional but should almost always be passed — the
// caller's own balance updates belong in the same session so the whole
// operation stays atomic.
// ---------------------------------------------------------------------------
const record = async (payload, mongoSession = null) => {
    const {
        session,
        direction,
        type,
        amount,
        mode,
        txnDate = new Date(),
        party,
        classId = null,
        className = '',
        refModel = '',
        refId = null,
        receiptNo = null,
        // Fee receipts pass the per-month breakdown they allocated, so a void
        // can reverse exactly what this receipt paid. See transaction.model.js.
        covered = [],
        // The same, for an Other Fee receipt — see transaction.model.js.
        coveredCharges = [],
        // The part of a fee receipt that no month had a claim on, held as
        // credit on the student. Zero on everything else.
        advance = 0,
        note = '',
        attachments = [],
        recordedBy,
    } = payload;

    if (!ROLLUP_MAP[type] && type !== 'REVERSAL') {
        throw new ApiError(500, `Unknown transaction type: ${type}`);
    }
    const value = round2(amount);
    if (!(value > 0)) {
        throw new ApiError(400, 'Amount must be greater than zero');
    }

    const month = monthKeyIST(txnDate);

    const [txn] = await Transaction.create(
        [
            {
                session,
                direction,
                type,
                amount: value,
                mode,
                txnDate,
                month,
                party,
                class: classId,
                className,
                refModel,
                refId,
                receiptNo,
                covered,
                coveredCharges,
                advance,
                note,
                attachments,
                recordedBy,
            },
        ],
        { session: mongoSession }
    );

    await bumpRollup(
        {
            session,
            month,
            classId,
            className,
            fields: rollupFieldsFor(type, value),
            // Which drawer it moved through. School scope only — see bumpRollup.
            schoolOnly: modeFieldsFor(direction, mode, value),
        },
        mongoSession
    );

    return txn;
};

// ---------------------------------------------------------------------------
// Refuse to touch a payment somebody has already signed off.
//
// Exported because the callers check it BEFORE they start work. That is not
// belt-and-braces: without it, voiding a verified stock bill would put the
// stock back on the shelf and write the return movements before reaching the
// reversal and finding out — the right answer after the wrong amount of work.
// Inside a transaction none of it would commit, but the caller would still have
// paid for it, and a retry would pay again.
// ---------------------------------------------------------------------------
const assertUnsealed = (txn) => {
    if (Transaction.isSealed(txn)) {
        throw new ApiError(409, Transaction.SEALED_MESSAGE).withCode('PAYMENT_VERIFIED');
    }
};

// ---------------------------------------------------------------------------
// Correcting a mistake: mark the original void and write an OPPOSING row.
//
// The original is never edited or deleted. Both lines show in the day
// book — that is correct behaviour, not clutter. A cash book that can be
// silently edited is not a cash book.
//
// The rollups correct themselves because the reversal's $inc is negative.
// ---------------------------------------------------------------------------
const reverse = async ({ original, reason, actorId }, mongoSession = null) => {
    if (original.voided) {
        throw new ApiError(409, 'This entry has already been voided');
    }

    // The structural half of the verification lock. Every void in this app —
    // a fee receipt, an other-fee receipt, a stock bill, an ID card — has to
    // come through here, because this is the only function that writes an
    // opposing row. Checking the seal at the door means a void path added next
    // year is covered with nobody having to remember it, which is the same
    // fail-closed reasoning that puts the read-only gate in one middleware.
    assertUnsealed(original);

    const marked = await Transaction.updateOne(
        { _id: original._id, voided: false },
        {
            $set: {
                voided: true,
                voidedAt: new Date(),
                voidedBy: actorId,
                voidReason: reason,
            },
        },
        { session: mongoSession }
    );

    // The filter already said `voided: false`, and its result was being ignored —
    // so two people voiding the same receipt in the same second both sailed past
    // the check at the top of this function and both wrote a REVERSAL, taking the
    // money off twice. Whoever loses the race is told so.
    if (marked.matchedCount === 0) {
        throw new ApiError(409, 'This entry has already been voided').withCode('ALREADY_VOIDED');
    }

    const [reversal] = await Transaction.create(
        [
            {
                session: original.session,
                // Opposite direction — the cash book reads correctly on both sides
                direction: original.direction === 'IN' ? 'OUT' : 'IN',
                type: 'REVERSAL',
                amount: original.amount,
                mode: original.mode,
                txnDate: new Date(),
                month: monthKeyIST(new Date()),
                party: original.party,
                class: original.class,
                className: original.className,
                refModel: original.refModel,
                refId: original.refId,
                note: `Reversal of ${original.receiptNo || original._id}: ${reason}`,
                recordedBy: actorId,
                reversalOf: original._id,
            },
        ],
        { session: mongoSession }
    );

    // Subtract the same amount from the rollup. Note: from the ORIGINAL's
    // month, not today's — otherwise a July mistake would understate August's
    // collection and leave July's figure wrong forever.
    await bumpRollup(
        {
            session: original.session,
            month: original.month,
            classId: original.class,
            className: original.className,
            fields: rollupFieldsFor(original.type, -original.amount),
            // Out of the drawer it went into. The REVERSAL row carries the
            // original's mode and the opposite direction, so taking it off the
            // original's own bucket is what actually undoes the movement —
            // adding it to the opposite bucket instead would leave both sides
            // overstated by the same amount and the net looking correct.
            schoolOnly: modeFieldsFor(original.direction, original.mode, -original.amount),
        },
        mongoSession
    );

    return reversal;
};

// ---------------------------------------------------------------------------
// Correcting the AMOUNT on a row that has not been checked off yet.
//
// This is the one exception to "a transaction is never edited", and it is a
// narrow one: only while the entry is unverified, only through the module that
// owns what the money paid for, and never on a row somebody has signed off.
// Past that point the rule stands unchanged — a verified or voided entry is
// corrected the way it always was, by a reversal.
//
// The rollup moves by the DIFFERENCE, in the original's month rather than
// today's. Same reasoning as reverse(): a July receipt corrected in August
// must not make August's collection wrong and leave July's wrong forever.
//
// The caller passes the balance work in the same mongoose session — the
// demands, the bill, the student's outstanding. This function will not do that
// for them, because it differs per type and getting it wrong here would be
// silent. What it does guarantee is that the row and the rollups move together
// or not at all.
// ---------------------------------------------------------------------------
const reviseAmount = async ({ original, amount, set = {} }, mongoSession = null) => {
    assertUnsealed(original);
    if (original.voided) {
        throw new ApiError(409, 'This entry has been voided — there is nothing left to correct');
    }

    const value = round2(amount);
    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const delta = round2(value - original.amount);

    // A correction can change the MODE as well as the figure — ₹5,000 written
    // down as Cash that actually arrived by UPI. That is not a delta on one
    // bucket: the whole original amount has to leave the drawer it was never
    // in, and the whole new amount has to enter the one it was.
    const newMode = set.mode || original.mode;
    const modeMoved = newMode !== original.mode;

    // Conditional on the row still holding the amount AND the mode that were
    // read, and still being unverified. Two people correcting the same receipt
    // in the same second would otherwise both apply their own difference to the
    // rollup, leaving it out by whatever the loser's change was.
    const updated = await Transaction.findOneAndUpdate(
        {
            _id: original._id,
            amount: original.amount,
            mode: original.mode,
            voided: false,
            verified: { $ne: true },
        },
        { $set: { ...set, amount: value } },
        { new: true, session: mongoSession }
    ).lean();

    if (!updated) {
        throw new ApiError(
            409,
            'This payment changed while it was being corrected — open it again and check it'
        ).withCode('STALE_PAYMENT');
    }

    const modeFields = modeMoved
        ? {
            ...modeFieldsFor(original.direction, original.mode, -original.amount),
            ...modeFieldsFor(original.direction, newMode, value),
        }
        : modeFieldsFor(original.direction, original.mode, delta);

    // `delta !== 0` is no longer the whole test. A receipt corrected from Cash
    // to UPI for the SAME amount moves no head and no total, and skipping it on
    // that basis left the cash book saying Cash while the row itself said UPI —
    // two screens telling different stories about one receipt.
    if (delta !== 0 || modeMoved) {
        await bumpRollup(
            {
                session: original.session,
                month: original.month,
                classId: original.class,
                className: original.className,
                fields: rollupFieldsFor(original.type, delta),
                schoolOnly: modeFields,
            },
            mongoSession
        );
    }

    return updated;
};

// ---------------------------------------------------------------------------
// Correcting ONLY the mode — the amount is right, the drawer was not.
//
// Its own function because the caller's cheap path deliberately does not touch
// a balance, a head or a total, and this does not either: the money is the same
// money, it simply moved through UPI rather than the cash box. What it must do
// is take it off one bucket and put it on the other, or the cash book and the
// row itself disagree for ever.
//
// The caller owns the transaction and the row's own update, and must guard that
// update on the mode it read — otherwise two corrections in the same second
// would each move a bucket the row is no longer in.
// ---------------------------------------------------------------------------
const moveMode = async ({ original, mode }, mongoSession = null) => {
    if (!mode || mode === original.mode) return;

    await bumpRollup(
        {
            session: original.session,
            month: original.month,
            // No class. Mode totals are school scope only, and passing the class
            // here would create an empty class rollup for a movement a class
            // does not record.
            fields: {},
            schoolOnly: {
                ...modeFieldsFor(original.direction, original.mode, -original.amount),
                ...modeFieldsFor(original.direction, mode, original.amount),
            },
        },
        mongoSession
    );
};

module.exports = {
    record, reverse, reviseAmount, moveMode, bumpRollup, assertUnsealed,
    ROLLUP_MAP, MODES, CASH_MODES, modeFieldsFor,
    // Exported so a report can total a DATE RANGE into the very same heads the
    // monthly rollup is maintained with. "Which head does this type move" then
    // has one definition in the codebase rather than two that agree today and
    // drift the first time a type is added — which is exactly how a dashboard
    // and a report end up disagreeing about the same money.
    rollupFieldsFor,
};

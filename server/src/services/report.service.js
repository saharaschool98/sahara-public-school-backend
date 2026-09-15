const MonthlyRollup = require('../models/monthlyRollup.model');
const AcademicSession = require('../models/academicSession.model');
const Transaction = require('../models/transaction.model');
const Student = require('../models/student.model');
const Vendor = require('../models/vendor.model');
const SalarySlip = require('../models/salarySlip.model');
const Purchase = require('../models/purchase.model');
const sessionService = require('./session.service');
const stockService = require('./stock.service');
const vendorService = require('./vendor.service');
const ApiError = require('../utils/ApiError');
const { CASH_MODES, rollupFieldsFor } = require('./ledger.service');
const { round2 } = require('../utils/money');
const { monthKeyIST, startOfDayIST, endOfDayIST, daysBetweenIST, monthRangeIST } = require('../utils/istDate');

// The modes the office reconciles separately at the end of a day: the cash box
// is counted, the UPI app is opened, the bank statement is checked, the cheque
// book is flipped through. They are always shown, even at zero, so the row of
// tiles keeps a fixed shape somebody can read at a glance.
//
// 'Adjustment' is the fifth mode a Transaction can carry and is deliberately
// NOT in this list — it moves no real money and would read ₹0 every day. It is
// still added on any day it appears, because a mode that moved money and is
// missing from the tiles would make them stop adding up to Money in / Money out.
const RECONCILED_MODES = ['Cash', 'UPI', 'Bank', 'Cheque'];


// ---------------------------------------------------------------------------
// THE DASHBOARD'S PERIOD
//
// "This month" is the cheapest question in the app: MonthlyRollup already holds
// the answer in one document, and — more importantly — it is the SAME document
// the class-wise report and the cash book read. So the month keeps reading it,
// and the dashboard cannot disagree with the rest of the app about September.
//
// Today and the last seven days have no rollup to read, because a rollup is
// keyed by month. Those are totalled from the transactions in the range, which
// is bounded by the range itself and so does not get slower as the years pile
// up — the index is { session, txnDate }.
//
// The two paths total into the SAME FIELD NAMES because both go through
// ledger.rollupFieldsFor. That is the whole reason this is safe: "which head
// does a fee refund move, and in which direction" is answered once, by the
// function that maintains the rollup, rather than re-implemented here where it
// would agree today and drift later.
// ---------------------------------------------------------------------------
const PERIODS = ['today', 'week', 'month'];

const periodRange = (period) => {
    const now = new Date();

    if (period === 'today') {
        return { start: startOfDayIST(now), end: endOfDayIST(now) };
    }
    if (period === 'week') {
        // Seven days INCLUDING today, which is what "last 7 days" means to the
        // person reading it — six days back plus today.
        return {
            start: startOfDayIST(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)),
            end: endOfDayIST(now),
        };
    }

    const month = monthKeyIST(now);
    const { start, end } = monthRangeIST(month);
    // monthRangeIST's end is the first instant of the NEXT month; step back so
    // an entry at 23:59 on the last day is inside the range rather than the
    // boundary belonging to both months.
    return { start, end: new Date(end.getTime() - 1) };
};

// ---------------------------------------------------------------------------
// Every head that moved in a date range, in MonthlyRollup's own field names.
//
// TWO ROWS ARE LEFT OUT, and getting this wrong is the whole difficulty:
//
//   A VOIDED entry contributes NOTHING. It added to its month when it was
//   written and its reversal took the same amount straight back off — the
//   rollup nets it to zero, so a range covering it has to net it to zero too.
//
//   A REVERSAL ROW IS NEVER COUNTED ON ITS OWN DATE. ledger.reverse books it
//   against the ORIGINAL'S month, never the day somebody pressed void, and for
//   good reason: a July receipt voided in August must not make August's
//   collection read low while July's stays wrong for ever.
//
// Together those two rules make a range agree with the rollup EXACTLY, and they
// are the reason this is two filters rather than a lookup. The first attempt
// here counted reversals on the day they happened, which is a defensible thing
// for a "what moved today" view to do — and it made "today" disagree with "this
// month" by the size of every cross-month void. Two screens telling a school
// different stories about the same rupees is not a trade-off worth making.
// ---------------------------------------------------------------------------
const rangeHeads = async (session, start, end) => {
    const rows = await Transaction.find({
        session,
        txnDate: { $gte: start, $lte: end },
        voided: { $ne: true },
        type: { $ne: 'REVERSAL' },
    })
        .select('type amount')
        .lean();

    const heads = {};

    for (const t of rows) {
        // rollupFieldsFor, not a second copy of the mapping. A fee refund moving
        // its head against its cash is decided in exactly one place.
        for (const [field, value] of Object.entries(rollupFieldsFor(t.type, t.amount))) {
            heads[field] = round2((heads[field] || 0) + value);
        }
    }

    return heads;
};

// A bill's value is not cash and never passes through the ledger, so it has to
// be totalled from the bills themselves — the same thing the rollup's
// `purchases` head does, over a date range instead of a month.
const rangePurchases = async (session, start, end) => {
    const [row] = await Purchase.aggregate([
        { $match: { session, billDate: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    return round2(row?.total || 0);
};

// ---------------------------------------------------------------------------
// DASHBOARD
//
// The important point: not one aggregation here runs over transaction
// rows. Every monthly figure comes from a single MonthlyRollup document,
// and student and vendor outstanding from their own denormalised fields.
//
// So this screen is as fast after three years of data as it was on day
// one — which is what matters on M0's shared CPU.
// ---------------------------------------------------------------------------
const dashboard = async ({ period: wanted } = {}) => {
    const session = await sessionService.getActiveSessionName();
    const month = monthKeyIST();

    // Defaults to the month, so a caller that passes nothing gets exactly what
    // this screen has always shown.
    const period = PERIODS.includes(wanted) ? wanted : 'month';
    const { start, end } = periodRange(period);

    const [heads, purchaseBills, studentDues, vendorDues, unpaidSlips, low] = await Promise.all([
        // The month reads its rollup — one document, and the same one every
        // other screen reads. A shorter period is totalled from its own range.
        period === 'month'
            ? MonthlyRollup.findOne({ session, month, scope: 'SCHOOL', class: null }).lean()
            : rangeHeads(session, start, end),
        period === 'month' ? null : rangePurchases(session, start, end),

        // A small aggregation, but over the Student collection (a few hundred
        // rows) with both fields indexed — not over the transaction ledger.
        //
        // It matches on the SESSION, not on `status: 'Active'`, and that is a
        // deliberate correction rather than an oversight. Marking a child Left
        // used to take their dues off this figure entirely — so the school's
        // outstanding fell by exactly the amount it had just become hardest to
        // collect, and the one event that should raise a flag lowered a number
        // instead. student.service.markLeft has always SAID the dues survive;
        // this is where that stopped being true.
        //
        // The headcount is still Active-only, computed with $cond — a student
        // who has left is not on the roll, but what they owe is still owed.
        Student.aggregate([
            { $match: { session } },
            {
                $group: {
                    _id: null,
                    feeOutstanding: { $sum: '$feeOutstanding' },
                    stockOutstanding: { $sum: '$stockOutstanding' },
                    chargeOutstanding: { $sum: '$chargeOutstanding' },
                    // The other direction: fee paid ahead that no month has
                    // claimed yet. Summed here because it is the school's
                    // liability and belongs on the same screen as its
                    // receivables, never netted against them.
                    creditHeld: { $sum: '$creditBalance' },
                    withDues: { $sum: { $cond: [{ $gt: ['$feeOutstanding', 0] }, 1, 0] } },
                    active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
                    // How much of the receivable belongs to children who have
                    // already gone. Its own number because it is a different
                    // job: the rest is chased with a phone call, and this part
                    // is chased with a letter or written off deliberately.
                    fromLeft: {
                        $sum: {
                            $cond: [
                                { $eq: ['$status', 'Left'] },
                                { $add: ['$feeOutstanding', '$stockOutstanding', '$chargeOutstanding'] },
                                0,
                            ],
                        },
                    },
                },
            },
        ]),

        Vendor.aggregate([
            { $match: { isActive: true, outstanding: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: '$outstanding' }, count: { $sum: 1 } } },
        ]),

        SalarySlip.countDocuments({ session, month, status: { $in: ['Draft', 'Approved'] } }),

        stockService.lowStock(),
    ]);

    const s = studentDues[0] || {};
    const v = vendorDues[0] || {};
    const r = heads || {};

    const feeCollected = round2(r.feeCollected || 0);
    const feeDiscount = round2(r.feeDiscount || 0);

    // ---- what is EXPECTED only exists for a month ----
    //
    // feeExpected is the sum of the month's demands, and a demand is raised per
    // month — there is no such thing as "the fee expected today". Rather than
    // invent a denominator, these come back null and the screen leaves the
    // percentage off. A collection rate against a made-up target is worse than
    // no rate at all: it reads as a fact.
    const feeExpected = period === 'month' ? round2(r.feeExpected || 0) : null;
    const net = feeExpected === null ? 0 : round2(feeExpected - feeDiscount);

    return {
        session,
        month,
        // Which slice of time every money figure below covers, and what to call
        // it on screen. The balances further down are NOT in it — they are what
        // is owed right now, whatever period is showing.
        period,
        // The dates only. What to CALL this period is the screen's job — the
        // frontend already owns month naming, and a second list of month names
        // over here would be a second place for it to be wrong.
        from: start,
        to: end,
        fees: {
            expected: feeExpected,
            collected: feeCollected,
            discount: feeDiscount,
            rate: feeExpected === null ? null : net > 0 ? Math.round((feeCollected / net) * 100) : 0,
        },
        outstanding: {
            fee: round2(s.feeOutstanding || 0),
            stock: round2(s.stockOutstanding || 0),
            charges: round2(s.chargeOutstanding || 0),
            total: round2(
                (s.feeOutstanding || 0) + (s.stockOutstanding || 0) + (s.chargeOutstanding || 0)
            ),
            studentsWithDues: s.withDues || 0,
            activeStudents: s.active || 0,
            // Owed by students who have already left. Part of `total`, never
            // added on top of it.
            fromLeft: round2(s.fromLeft || 0),
        },
        vendors: { outstanding: round2(v.total || 0), count: v.count || 0 },
        // Fee collected for months that have not been billed yet. Money in the
        // bank that is not yet income — the office is asked "how much of this
        // is really ours" at the end of every term.
        advanceHeld: round2(s.creditHeld || 0),
        // Its own line, because "how much came in from ID cards" is a question
        // the school asks separately from fees.
        idCards: { collected: round2(r.idCardCollected || 0) },
        // Admission, exams, trips. Its own line for the same reason ID cards
        // have one — it is asked about separately.
        otherFees: { collected: round2(r.chargeCollected || 0) },
        spend: {
            expenses: round2(r.expenses || 0),
            salaries: round2(r.salaries || 0),
            vendorPaid: round2(r.vendorPaid || 0),
            // Bill value, not cash. The month has it on the rollup; a shorter
            // period totals the bills themselves.
            purchases: period === 'month' ? round2(r.purchases || 0) : purchaseBills,
        },
        cash: { in: round2(r.cashIn || 0), out: round2(r.cashOut || 0), net: round2((r.cashIn || 0) - (r.cashOut || 0)) },
        alerts: {
            unpaidSalarySlips: unpaidSlips,
            lowStock: low.slice(0, 10),
            lowStockCount: low.length,
        },
    };
};

// ---------------------------------------------------------------------------
// DAY BOOK — every cash movement for a day. The office reconciles the cash box with it.
// ---------------------------------------------------------------------------
// How far a day book may span in one request.
//
// This is the one report that returns the ENTRIES rather than a rollup — that
// is the whole point of it, because the cash box is reconciled against
// individual lines, not against a total. So the date range is the only thing
// bounding the response, and it has to actually bound it. A quarter covers
// "what happened this term" and still returns a listing somebody can read
// rather than a download.
const MAX_DAYBOOK_DAYS = 92;

const daybook = async ({ from, to } = {}) => {
    const session = await sessionService.getActiveSessionName();

    // No range at all means today. The dashboard's "Today" card asks for
    // exactly that and passes nothing, so this default is load-bearing.
    // One end given and not the other means that single day.
    const start = startOfDayIST(from || to || new Date());
    const end = endOfDayIST(to || from || new Date());

    if (end.getTime() < start.getTime()) {
        throw new ApiError(400, 'The end date is before the start date').withCode('BAD_RANGE');
    }

    const span = daysBetweenIST(start, end) + 1;
    if (span > MAX_DAYBOOK_DAYS) {
        throw new ApiError(
            400,
            `A day book can cover at most ${MAX_DAYBOOK_DAYS} days at a time, and this is ${span}. `
            + 'Narrow the dates — for a whole year use the Cash Book, which is built from totals.'
        ).withCode('RANGE_TOO_WIDE');
    }

    const raw = await Transaction.find({
        session,
        txnDate: { $gte: start, $lte: end },
    })
        .select(
            'type direction amount mode txnDate party note receiptNo voided reversalOf className ' +
                'verified verifiedAt verifiedByName'
        )
        .sort({ txnDate: 1 })
        .lean();

    // WHICH rows carry a verification tick is decided in one place — the model —
    // and sent down as a flag. Letting each screen re-derive "student money in,
    // not voided" is how the day book and a student's own ledger end up
    // disagreeing about the same receipt.
    const rows = raw.map((t) => ({ ...t, verifiable: Transaction.isVerifiable(t) }));

    // ONE pass produces both the day's totals and the same money split by
    // payment mode. Deriving the cash figures from the same buckets rather than
    // adding them up a second time is the point: two separate sums over the
    // same rows is how a cash line and a mode line start disagreeing.
    //
    // Voids and reversals both show in `rows` — that is correct behaviour. A
    // cash book that can be silently edited is not a cash book. But a VOIDED
    // row is skipped in the arithmetic, because its REVERSAL is a row of its
    // own carrying the opposite direction; counting both would double it.
    const modes = new Map(RECONCILED_MODES.map((m) => [m, { mode: m, in: 0, out: 0 }]));
    // Day by day, built in the SAME pass for the same reason the modes are:
    // a second sum over the same rows is how two figures on one screen start
    // disagreeing. Only days that actually moved money appear — a range of
    // empty rows is not a reconciliation, and the header already says the span.
    //
    // `rows` is sorted ascending, so a Map's insertion order gives the days in
    // order with no second sort.
    const days = new Map();
    let moneyIn = 0;
    let moneyOut = 0;

    for (const t of rows) {
        if (t.voided) continue;

        if (!modes.has(t.mode)) modes.set(t.mode, { mode: t.mode, in: 0, out: 0 });
        const bucket = modes.get(t.mode);

        // Keyed on the IST day, not the raw instant — an entry made at 00:30
        // IST belongs to that morning, and keying on the UTC date would file it
        // under the day before. Same reason every other boundary in this app
        // goes through istDate.
        const dayStart = startOfDayIST(t.txnDate);
        const dayKey = dayStart.toISOString();
        if (!days.has(dayKey)) days.set(dayKey, { date: dayStart, in: 0, out: 0 });
        const day = days.get(dayKey);

        if (t.direction === 'IN') {
            bucket.in = round2(bucket.in + t.amount);
            day.in = round2(day.in + t.amount);
            moneyIn = round2(moneyIn + t.amount);
        } else {
            bucket.out = round2(bucket.out + t.amount);
            day.out = round2(day.out + t.amount);
            moneyOut = round2(moneyOut + t.amount);
        }
    }

    // In RECONCILED_MODES order, with any other mode that actually moved money
    // appended after it.
    const byMode = [...modes.values()].map((m) => ({ ...m, net: round2(m.in - m.out) }));
    const cash = modes.get('Cash');

    return {
        from: start,
        to: end,
        // How many days the range covers, so the screen can say "one day" or
        // "seven days" without re-deriving it from two timestamps.
        span,
        rows,
        // Empty on a single-day book — there is nothing to break down.
        byDay: span > 1 ? [...days.values()].map((d) => ({ ...d, net: round2(d.in - d.out) })) : [],
        // Mode by mode, so the cash box, the UPI app, the bank statement and the
        // cheque book can each be reconciled on their own instead of against one
        // combined figure that none of them will ever match.
        byMode,
        totals: {
            in: moneyIn,
            out: moneyOut,
            net: round2(moneyIn - moneyOut),
            // Cash keeps its own named fields: it is the one total somebody
            // physically counts, and the dashboard's "cash today" line reads it.
            cashIn: cash.in,
            cashOut: cash.out,
            netCash: round2(cash.in - cash.out),
        },
    };
};


// ---------------------------------------------------------------------------
// THE CASH BOOK — what the school actually has in hand, for a whole session.
//
// The question this answers is the one nobody could answer before: open the
// drawer, open the UPI app, open the bank statement — how much should be there?
//
//   opening balance  +  everything collected  −  everything paid out
//
// PER MODE, because that is how it gets counted. Cash is counted by hand, UPI
// is read off a phone, the bank is a statement and cheques are a book — four
// separate reconciliations, and one combined figure matches none of them.
//
// WHAT MAKES IT FAST
//
// It reads ROLLUPS, never transactions. A session is at most a dozen SCHOOL
// rollup documents, so this is one small find() whether the school has run for
// a term or for a decade — the same reason the dashboard and the class-wise
// report are fast. Every rupee $inc'd those documents on its way through
// ledger.service, mode included.
//
// WHAT IS DELIBERATELY NOT HERE
//
// A PURCHASE BILL. Recording a bill is not spending money — the cash leaves
// when the vendor is actually paid, and that is a VENDOR_PAY row like any
// other. purchase.service writes exactly that for a bill paid on the spot, so
// bills already reach this screen through the payment, once. Counting the bill
// as well would subtract the same rupee twice and make the school look poorer
// than it is, every month, by the size of its credit purchases.
//
// A CHEQUE is shown as its own mode rather than folded into the bank. A cheque
// written is not money gone until it clears, and a cheque held is not money
// arrived — keeping the column separate is what lets the office see both
// without the app pretending to know which have cleared.
// ---------------------------------------------------------------------------

// Every head that money-in can arrive under, and every head it can leave
// under. Written out rather than derived, because the whole value of this
// screen is that the columns ADD UP: a head that exists in the rollup and is
// missing from one of these lists would quietly break that, and the gap would
// look like a rounding error rather than a missing kind of money.
const sumOf = (rows, field) => round2(rows.reduce((acc, r) => acc + (r[field] || 0), 0));
const sumMode = (rows, bucket, mode) =>
    round2(rows.reduce((acc, r) => acc + ((r[bucket] || {})[mode] || 0), 0));

const cashbook = async ({ session: wanted } = {}) => {
    // A named session, or the active one. Last year's cash book is a question
    // the school asks in April, and refusing to answer it because the session
    // has rolled over would be a strange kind of record-keeping.
    const meta = wanted
        ? await AcademicSession.findOne({ name: wanted })
            .select('name startDate endDate isActive openingBalance')
            .lean()
        : await sessionService.getActiveSession();

    if (!meta) throw new ApiError(404, `No session named ${wanted}`);

    const rows = await MonthlyRollup.find({ session: meta.name, scope: 'SCHOOL' })
        .select(
            'month cashIn cashOut inByMode outByMode '
            + 'feeCollected feeRefunds stockSales idCardCollected chargeCollected otherIncome '
            + 'expenses salaries vendorPaid purchases'
        )
        .sort({ month: 1 })
        .lean();

    const opening = meta.openingBalance || {};

    // ---- mode by mode ----
    const byMode = CASH_MODES.map((mode) => {
        const open = round2(opening[mode] || 0);
        const moneyIn = sumMode(rows, 'inByMode', mode);
        const moneyOut = sumMode(rows, 'outByMode', mode);
        return {
            mode,
            opening: open,
            in: moneyIn,
            out: moneyOut,
            balance: round2(open + moneyIn - moneyOut),
        };
    });

    // 'Adjustment' moves no real money, so it is never part of what is in hand
    // — but it is counted in cashIn/cashOut like every other mode. Reported on
    // its own so that if it is ever non-zero, the difference between
    // "in − out" and "in hand" has a name on the screen instead of looking like
    // a bug. Nothing writes it today; this is what keeps that true visibly.
    const adjustments = {
        in: sumMode(rows, 'inByMode', 'Adjustment'),
        out: sumMode(rows, 'outByMode', 'Adjustment'),
    };

    const openingTotal = round2(byMode.reduce((acc, m) => acc + m.opening, 0));
    const moneyIn = sumOf(rows, 'cashIn');
    const moneyOut = sumOf(rows, 'cashOut');
    const inHand = round2(byMode.reduce((acc, m) => acc + m.balance, 0));

    // ---- where it came from, where it went ----
    //
    // Both lists add up to the movement totals BY CONSTRUCTION, not by
    // subtracting one number from another:
    //
    //   fees is feeCollected + feeRefunds — the gross cash that came in as fee,
    //   because feeCollected is already net of what was handed back, and this
    //   column is about money that moved, not income earned.
    //
    //   refunds is that same feeRefunds head on the way out. One rupee returned
    //   appears once on each side, which is exactly what happened to it.
    const feeRefunds = sumOf(rows, 'feeRefunds');
    const stock = sumOf(rows, 'stockSales');
    const idCards = sumOf(rows, 'idCardCollected');
    const otherFees = sumOf(rows, 'chargeCollected');
    const otherIncome = sumOf(rows, 'otherIncome');
    const feeCollected = sumOf(rows, 'feeCollected');

    const expenses = sumOf(rows, 'expenses');
    const salaries = sumOf(rows, 'salaries');
    const vendorPaid = sumOf(rows, 'vendorPaid');

    // ---- month by month, with the balance carried forward ----
    let running = openingTotal;
    const months = rows.map((r) => {
        const rowIn = round2(r.cashIn || 0);
        const rowOut = round2(r.cashOut || 0);
        // The carried balance moves by REAL money only, so the last month's
        // closing is the same figure as `inHand` above.
        const cashModesIn = round2(CASH_MODES.reduce((acc, m) => acc + ((r.inByMode || {})[m] || 0), 0));
        const cashModesOut = round2(CASH_MODES.reduce((acc, m) => acc + ((r.outByMode || {})[m] || 0), 0));
        running = round2(running + cashModesIn - cashModesOut);

        return {
            month: r.month,
            in: rowIn,
            out: rowOut,
            net: round2(rowIn - rowOut),
            closing: running,
        };
    });

    return {
        session: meta.name,
        isActive: Boolean(meta.isActive),
        opening: { ...Object.fromEntries(CASH_MODES.map((m) => [m, round2(opening[m] || 0)])), total: openingTotal },
        byMode,
        adjustments,
        totals: {
            opening: openingTotal,
            in: moneyIn,
            out: moneyOut,
            net: round2(moneyIn - moneyOut),
            inHand,
        },
        income: {
            fees: round2(feeCollected + feeRefunds),
            stock,
            idCards,
            otherFees,
            other: otherIncome,
            total: moneyIn,
        },
        spend: {
            expenses,
            salaries,
            vendorPaid,
            refunds: feeRefunds,
            total: moneyOut,
        },
        // Fee income after what was handed back — the figure the dashboard and
        // the class-wise report show. Sent alongside the gross so the two
        // screens can never be read as contradicting each other.
        netFeeCollection: feeCollected,
        // Bill value, NOT cash — stated so the screen can say why it is not in
        // the arithmetic. See the note at the top of this function.
        purchaseBills: sumOf(rows, 'purchases'),
        months,
    };
};

// ---------------------------------------------------------------------------
// OUTSTANDING — both directions. "What is owed to us, what we owe"
// ---------------------------------------------------------------------------
const outstanding = async () => {
    const session = await sessionService.getActiveSessionName();

    const [byClass, vendorAgeing] = await Promise.all([
        // Status is deliberately NOT filtered here — see the dashboard above.
        // This report answers "what is owed to us", and a child leaving does not
        // pay their fees. Filtering to Active made the one event that puts money
        // at risk quietly reduce the figure that tracks it.
        Student.aggregate([
            {
                $match: {
                    session,
                    $or: [
                        { feeOutstanding: { $gt: 0 } },
                        { stockOutstanding: { $gt: 0 } },
                        { chargeOutstanding: { $gt: 0 } },
                    ],
                },
            },
            {
                $group: {
                    _id: '$class',
                    className: { $first: '$className' },
                    students: { $sum: 1 },
                    fee: { $sum: '$feeOutstanding' },
                    stock: { $sum: '$stockOutstanding' },
                    charges: { $sum: '$chargeOutstanding' },
                    // How many of those have gone. The class row reads very
                    // differently when four of its six debtors have left.
                    left: { $sum: { $cond: [{ $eq: ['$status', 'Left'] }, 1, 0] } },
                },
            },
            { $sort: { fee: -1 } },
        ]),
        vendorService.ageing(),
    ]);

    const students = byClass.map((c) => ({
        classId: c._id,
        className: c.className,
        students: c.students,
        left: c.left || 0,
        fee: round2(c.fee),
        stock: round2(c.stock),
        charges: round2(c.charges || 0),
        total: round2(c.fee + c.stock + (c.charges || 0)),
    }));

    const receivable = round2(students.reduce((s, c) => s + c.total, 0));
    const payable = vendorAgeing.totals.total;

    return {
        receivable: { total: receivable, byClass: students },
        payable: { total: payable, ...vendorAgeing },
        net: round2(receivable - payable),
    };
};

// ---------------------------------------------------------------------------
// INCOME vs EXPENSE — month by month across the session. Straight from rollups,
// so this is a small query.
// ---------------------------------------------------------------------------
const incomeVsExpense = async () => {
    const session = await sessionService.getActiveSessionName();

    const rows = await MonthlyRollup.find({ session, scope: 'SCHOOL' })
        .select('month feeCollected stockSales idCardCollected chargeCollected otherIncome expenses salaries vendorPaid cashIn cashOut')
        .sort({ month: 1 })
        .lean();

    const months = rows.map((r) => {
        // Every income head has to be named here. A head that exists in the
        // rollup but is left out of this sum makes the month's income quietly
        // too low — which is exactly the kind of wrong number nobody notices.
        const income = round2(
            (r.feeCollected || 0)
            + (r.stockSales || 0)
            + (r.idCardCollected || 0)
            + (r.chargeCollected || 0)
            + (r.otherIncome || 0)
        );
        const spend = round2((r.expenses || 0) + (r.salaries || 0) + (r.vendorPaid || 0));
        return {
            month: r.month,
            feeCollected: round2(r.feeCollected || 0),
            stockSales: round2(r.stockSales || 0),
            idCards: round2(r.idCardCollected || 0),
            otherFees: round2(r.chargeCollected || 0),
            otherIncome: round2(r.otherIncome || 0),
            totalIn: income,
            expenses: round2(r.expenses || 0),
            salaries: round2(r.salaries || 0),
            vendorPaid: round2(r.vendorPaid || 0),
            totalOut: spend,
            net: round2(income - spend),
        };
    });

    const totals = months.reduce(
        (acc, m) => ({
            totalIn: round2(acc.totalIn + m.totalIn),
            totalOut: round2(acc.totalOut + m.totalOut),
        }),
        { totalIn: 0, totalOut: 0 }
    );

    return { session, months, totals: { ...totals, net: round2(totals.totalIn - totals.totalOut) } };
};

// Fee collection trend — for the dashboard chart
const feeTrend = async () => {
    const session = await sessionService.getActiveSessionName();

    const rows = await MonthlyRollup.find({ session, scope: 'SCHOOL' })
        .select('month feeExpected feeCollected feeDiscount')
        .sort({ month: 1 })
        .lean();

    return rows.map((r) => ({
        month: r.month,
        expected: round2(r.feeExpected || 0),
        collected: round2(r.feeCollected || 0),
        discount: round2(r.feeDiscount || 0),
    }));
};

module.exports = {
    cashbook, dashboard, daybook, outstanding, incomeVsExpense, feeTrend };

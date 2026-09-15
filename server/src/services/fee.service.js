const mongoose = require('mongoose');
const FeeDemand = require('../models/feeDemand.model');
const Student = require('../models/student.model');
const Transaction = require('../models/transaction.model');
const MonthlyRollup = require('../models/monthlyRollup.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2, allocate } = require('../utils/money');
const { isDuplicateKey } = require('../utils/mongoErrors');
const { isValidMonthKey, monthKeyIST, monthRangeIST } = require('../utils/istDate');

// A demand's status is always derived from its own numbers, never set
// separately, so it can never contradict the amounts.
const statusFor = (d) => {
    const due = round2((d.amount || 0) - (d.discount || 0) - (d.paidAmount || 0));
    if (due <= 0) return 'Paid';
    return (d.paidAmount || 0) > 0 ? 'Partial' : 'Unpaid';
};

const dueOf = (d) => Math.max(0, round2((d.amount || 0) - (d.discount || 0) - (d.paidAmount || 0)));

// ---------------------------------------------------------------------------
// SETTLING A NEWLY RAISED MONTH OUT OF WHAT THE PARENT ALREADY PAID
//
// A parent who cleared the year in September bought months that did not exist
// yet. This is where those months get bought: raising October finds the credit
// sitting on the student and settles the new demand out of it, oldest month
// first like every other allocation in this app.
//
// It runs inside generation's own transaction, so a month is never raised
// without the advance behind it being applied — otherwise the parent would
// open the app and see a fresh bill for something they had already paid.
//
// Naturally idempotent, which matters because generation is re-run all the
// time: the credit is gone after the first pass, so the second finds nothing.
// No ledger row is written and no rollup moves. The money was recorded on the
// day it arrived; this only decides which month it belongs to, and counting it
// again here would collect the same rupee twice.
// ---------------------------------------------------------------------------
const settleFromCredit = async (studentIds, mongoSession) => {
    const holders = await Student.find({ _id: { $in: studentIds }, creditBalance: { $gt: 0 } })
        .select('creditBalance')
        .session(mongoSession)
        .lean();

    if (!holders.length) return { students: 0, amount: 0 };

    const demands = await FeeDemand.find({
        student: { $in: holders.map((h) => h._id) },
        status: { $ne: 'Paid' },
    })
        .sort({ month: 1 })
        .session(mongoSession)
        .lean();

    const byStudent = new Map();
    for (const d of demands) {
        const key = String(d.student);
        if (!byStudent.has(key)) byStudent.set(key, []);
        byStudent.get(key).push(d);
    }

    const demandOps = [];
    const studentOps = [];
    let total = 0;
    let touched = 0;

    for (const h of holders) {
        const rows = byStudent.get(String(h._id)) || [];
        if (!rows.length) continue;

        const splits = allocate(h.creditBalance, rows.map(dueOf));
        let used = 0;

        rows.forEach((d, i) => {
            const take = splits[i];
            if (take <= 0) return;

            used = round2(used + take);
            const next = { ...d, paidAmount: round2((d.paidAmount || 0) + take) };

            demandOps.push({
                updateOne: {
                    filter: { _id: d._id },
                    update: {
                        // paidFromCredit is part of paidAmount, not on top of
                        // it — it records where that share came from.
                        $inc: { paidAmount: take, paidFromCredit: take },
                        $set: { status: statusFor(next) },
                    },
                },
            });
        });

        if (used <= 0) continue;

        total = round2(total + used);
        touched += 1;
        studentOps.push({
            updateOne: {
                filter: { _id: h._id },
                update: { $inc: { creditBalance: -used, feeOutstanding: -used } },
            },
        });
    }

    if (demandOps.length) await FeeDemand.bulkWrite(demandOps, { session: mongoSession, ordered: true });
    if (studentOps.length) await Student.bulkWrite(studentOps, { session: mongoSession, ordered: false });

    return { students: touched, amount: total };
};

// ---------------------------------------------------------------------------
// Raise the month's fees.
//
// This is the heart of the whole "no cron" design. Running it twice is
// completely safe: the unique index on { student, month } physically
// prevents a second row. So the button can be pressed again, retried on a
// slow connection, or run by two people at once — no student is ever
// charged twice.
//
// Re-running is also useful, and is how a mid-session admission is billed for
// the months that were raised before they joined: press the button again on
// April and the student admitted in May gets April's row too. Everyone else
// already has theirs, so nothing about them changes.
// ---------------------------------------------------------------------------
const generateMonth = async ({ month, classId = null }, actorId) => {
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');

    const session = await sessionService.getActiveSession();

    if (session.feeMonths?.length && !session.feeMonths.includes(month)) {
        throw new ApiError(
            400,
            `${month} is not in this session's fee months — add it in Settings`
        );
    }

    const studentFilter = { session: session.name, status: 'Active' };
    if (classId) studentFilter.class = classId;

    const students = await Student.find(studentFilter)
        .select('name class className monthlyFee admissionDate')
        .lean();

    if (!students.length) {
        return { month, created: 0, skipped: 0, totalRaised: 0, message: 'No active students found' };
    }

    // Filter out demands that already exist. The unique index is the real
    // guard (for concurrent runs), but this pre-filter keeps the common case
    // off the error path — cleaner and faster.
    const existing = await FeeDemand.find({
        month,
        student: { $in: students.map((s) => s._id) },
    })
        .select('student')
        .lean();

    const already = new Set(existing.map((d) => d.student.toString()));
    const pending = students.filter((s) => !already.has(s._id.toString()));

    if (!pending.length) {
        return {
            month,
            created: 0,
            skipped: students.length,
            totalRaised: 0,
            message: 'Fees for this month have already been raised',
        };
    }

    const { end } = monthRangeIST(month);

    // -----------------------------------------------------------------------
    // The admission date does NOT gate this.
    //
    // It used to: a student admitted on 2 May got no April demand, however many
    // times April was raised. That is wrong for this school. The session runs
    // April to March and a child on the roll is billed for the SESSION, so
    // somebody who joins in May still owes April.
    //
    // Worse than the policy being wrong, the gap was unfixable from the app:
    // the office would raise April, silently watch that student be skipped, and
    // have no way left to charge them for it.
    //
    // So the OFFICE decides which months are raised and the system stops
    // second-guessing that from a date. It is still bounded on both sides:
    // only months in the session's feeMonths can be raised at all, and only
    // students who are Active right now are billed. Re-running a month is safe
    // — it adds exactly the students who were missing and touches nobody else.
    //
    // Where a back month genuinely should not be charged — a child who really
    // did join in December — the demand is raised and then WAIVED with a
    // reason. That leaves a record of the decision and of who made it; never
    // raising it left none.
    // -----------------------------------------------------------------------
    const docs = pending
        .map((s) => ({
            session: session.name,
            month,
            student: s._id,
            studentName: s.name,
            class: s.class,
            className: s.className,
            amount: round2(s.monthlyFee),
            dueDate: end,
            status: 'Unpaid',
            generatedBy: actorId,
        }));

    // -----------------------------------------------------------------------
    // The demands and the students' balances move together, or not at all.
    //
    // These used to be two independent writes. If the process died between
    // them — a cold start timing out, a dropped connection — the demands
    // existed while nobody's feeOutstanding had moved, and RE-RUNNING COULD
    // NOT REPAIR IT: the pre-filter sees those rows, finds nothing pending and
    // reports "already raised". Every balance stayed short until somebody
    // happened to run recompute:balances --fix, which nobody would think to do
    // because nothing on any screen looked wrong.
    //
    // Inside a transaction a duplicate key aborts the whole batch instead of
    // letting the rest through, and that is the safer half of the trade. The
    // unique index still makes a double charge impossible; the loser of a race
    // simply writes nothing and is told to press the button again — which
    // finishes the job, because generation is idempotent by design.
    //
    // Size: one month for one school is a few hundred rows, well inside a
    // transaction's limits and Vercel's 10s. A very large school can pass
    // classId and raise a class at a time. A timeout aborts cleanly, which is
    // exactly the failure mode this change is here to guarantee.
    // -----------------------------------------------------------------------
    let created;
    let settled = { students: 0, amount: 0 };

    try {
        const result = await withTransaction(async (mongoSession) => {
            const inserted = await FeeDemand.insertMany(docs, { session: mongoSession, ordered: true });

            // Raise each student's outstanding — one bulkWrite, not N updates
            await Student.bulkWrite(
                inserted.map((d) => ({
                    updateOne: { filter: { _id: d.student }, update: { $inc: { feeOutstanding: d.amount } } },
                })),
                { session: mongoSession, ordered: false }
            );

            // Anybody who paid ahead has just bought this month — see
            // settleFromCredit. In the same transaction as the raise, so the
            // bill and its payment are never visible apart.
            const applied = await settleFromCredit(
                inserted.map((d) => d.student),
                mongoSession
            );

            return { inserted, applied };
        });

        created = result.inserted;
        settled = result.applied;
    } catch (err) {
        // Somebody else raised this month in the gap between the pre-filter and
        // this write. Nothing was committed, so nothing is wrong — their rows
        // are in, and pressing the button again picks up whatever is genuinely
        // still missing.
        if (isDuplicateKey(err)) {
            return {
                month,
                created: 0,
                skipped: students.length,
                totalRaised: 0,
                message:
                    'These fees were being raised at the same moment from somewhere else — ' +
                    'press the button again to pick up anything still missing',
            };
        }
        throw err;
    }

    if (!created.length) {
        return { month, created: 0, skipped: students.length, totalRaised: 0 };
    }

    // feeExpected is SET from an aggregation rather than $inc'd.
    // Why: if generation half-ran, or rows arrived from elsewhere in a race,
    // an $inc could double count. Generation is not a hot path, so one
    // authoritative aggregation is affordable here — and it always tells
    // the truth.
    //
    // Deliberately OUTSIDE the transaction: it is an authoritative $set over
    // committed data and is safe to re-run at any time, so a failure here is
    // repaired by the next generate or by recompute:balances — it never needs
    // to hold the transaction open.
    await recomputeExpected(session.name, month);

    return {
        month,
        created: created.length,
        skipped: students.length - created.length,
        totalRaised: round2(created.reduce((sum, d) => sum + d.amount, 0)),
        // Said out loud, because "40 students billed ₹44,000" reads as ₹44,000
        // to go and collect when some of it was settled the moment it was
        // raised.
        settledFromAdvance: settled.amount,
        settledFor: settled.students,
    };
};

// Authoritatively write a month's feeExpected/feeDiscount into the rollups
const recomputeExpected = async (session, month) => {
    const rows = await FeeDemand.aggregate([
        { $match: { session, month } },
        {
            $group: {
                _id: '$class',
                className: { $first: '$className' },
                expected: { $sum: '$amount' },
                discount: { $sum: '$discount' },
            },
        },
    ]);

    const schoolTotal = rows.reduce(
        (acc, r) => ({ expected: acc.expected + r.expected, discount: acc.discount + r.discount }),
        { expected: 0, discount: 0 }
    );

    const ops = [
        {
            updateOne: {
                filter: { session, month, scope: 'SCHOOL', class: null },
                update: {
                    $set: { feeExpected: round2(schoolTotal.expected), feeDiscount: round2(schoolTotal.discount) },
                    $setOnInsert: { session, month, scope: 'SCHOOL', class: null },
                },
                upsert: true,
            },
        },
        ...rows.map((r) => ({
            updateOne: {
                filter: { session, month, scope: 'CLASS', class: r._id },
                update: {
                    $set: { feeExpected: round2(r.expected), feeDiscount: round2(r.discount) },
                    $setOnInsert: { session, month, scope: 'CLASS', class: r._id, className: r.className },
                },
                upsert: true,
            },
        })),
    ];

    await MonthlyRollup.bulkWrite(ops, { ordered: false });
};

const listDemands = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session };
    if (query.month) filter.month = query.month;
    if (query.class) filter.class = query.class;
    if (query.status) filter.status = query.status;
    if (query.student) filter.student = query.student;

    return fetchPage(
        FeeDemand.find(filter)
            .select('month studentName className amount discount paidAmount status dueDate student class')
            .sort({ month: -1, studentName: 1 }),
        { page, limit, withTotal: true }
    );
};

// A student's unpaid months, oldest first
// What the counter needs before it can take money: the months still open, what
// the school is already holding for this child, and how far ahead they are
// allowed to pay. All three together, because the screen cannot sensibly offer
// "pay for the year" without knowing what the year still costs.
const pendingForStudent = async (studentId) => {
    const student = await Student.findById(studentId)
        .select('name monthlyFee creditBalance feeOutstanding')
        .lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const [demands, room] = await Promise.all([
        FeeDemand.find({ student: studentId, status: { $ne: 'Paid' } }).sort({ month: 1 }).lean(),
        advanceRoom(student),
    ]);

    return {
        demands,
        credit: round2(student.creditBalance || 0),
        // "Six months still to be billed, ₹6,600" — the sentence the office
        // needs when a parent says "let me clear the whole year".
        advanceRoom: room,
    };
};

// ---------------------------------------------------------------------------
// Collecting a fee. Four writes inside one transaction — either all of
// them or none. Half-applying is the worst outcome: a receipt printed
// while the student's outstanding never moved.
// ---------------------------------------------------------------------------
// HOW MUCH ADVANCE THIS STUDENT CAN STILL HOLD
//
// A parent paying ahead is normal. A parent being charged ₹500,000 because
// somebody's finger slipped on the keypad is not, and the old "never more than
// is outstanding" rule was quietly doing that job as well as its own. Removing
// it without putting something in its place would turn every typo into a
// five-figure credit nobody notices until the year ends.
//
// So the limit is simply this: a student may hold at most ONE SESSION'S FEE in
// advance. An extra zero is caught; every real payment is not.
//
// It used to be "months of the session not yet billed, at their monthly fee",
// which sounds tighter and was wrong in the one case the office actually hits.
// Once every month of the session has been raised that figure is ZERO, so a
// parent who owed ₹5,000 and handed over ₹6,000 was refused outright — and the
// ₹1,000 does not stop existing because the software said no. It goes in a
// drawer, off the books, which is the exact outcome this whole system exists to
// prevent. A ceiling that makes the record LESS true than reality is not a
// safety rail.
//
// It is a guard rail, not accounting — if a class's fee changes in November the
// figure shifts with it, which is the right behaviour for a limit whose only
// job is to catch a mistyped number.
// ---------------------------------------------------------------------------
// The months this session bills.
//
// Normally the list the school declared in Settings. When that has not been
// filled in the session's own span is used instead — generateMonth already
// treats an empty list as "any month may be raised", so a ceiling built on it
// would be zero, and paying ahead would be impossible at exactly the schools
// that never opened Settings.
const sessionMonths = (session) => {
    if (session.feeMonths?.length) return session.feeMonths;

    const last = monthKeyIST(session.endDate);
    const out = [];
    let [year, month] = monthKeyIST(session.startDate).split('-').map(Number);

    // Bounded, so a session whose dates were entered the wrong way round
    // returns a short list instead of spinning.
    while (out.length < 24) {
        const key = `${year}-${String(month).padStart(2, '0')}`;
        out.push(key);
        if (key === last) break;
        month += 1;
        if (month > 12) { month = 1; year += 1; }
    }

    return out;
};

const advanceRoom = async (student, mongoSession = null) => {
    const session = await sessionService.getActiveSession();
    const months = sessionMonths(session);

    // One session's fee, at this student's rate. The whole ceiling.
    const ceiling = round2(months.length * round2(student.monthlyFee || 0));
    const held = round2(student.creditBalance || 0);

    // How much of the session is still to be billed. NOT the limit — it is the
    // sentence the counter needs when a parent says "let me clear the year",
    // and it is what tells them whether an advance has anywhere to land this
    // session or is carrying into the next one.
    const raised = await FeeDemand.find({ student: student._id })
        .select('month')
        .session(mongoSession)
        .lean();

    const billed = new Set(raised.map((r) => r.month));

    return {
        months: months.filter((m) => !billed.has(m)).length,
        ceiling,
        amount: round2(Math.max(0, ceiling - held)),
    };
};

// ---------------------------------------------------------------------------
// PUTTING MONEY AGAINST A STUDENT'S FEES
//
// Oldest month first, and whatever no month has a claim on is held as advance.
// Both halves move the student's own balances here, so a caller never has to
// remember which part went where.
//
// Shared by collection and by an amount correction, deliberately. The two must
// allocate identically or a corrected receipt would land somewhere a correctly
// typed one never would — and the difference would show up months later as a
// month marked paid against the wrong receipt.
// ---------------------------------------------------------------------------
const applyPayment = async (student, value, mongoSession) => {
    // Read INSIDE the transaction. Two counters collecting from the same
    // student in the same second would otherwise both see the same outstanding
    // and both allocate against it; reading here makes the second one a write
    // conflict, which withTransaction retries against the first one's result.
    const demands = await FeeDemand.find({ student: student._id, status: { $ne: 'Paid' } })
        .sort({ month: 1 })
        .session(mongoSession)
        .lean();

    const totalDue = round2(demands.reduce((sum, d) => sum + dueOf(d), 0));
    const advance = round2(Math.max(0, value - totalDue));

    if (advance > 0) {
        const room = await advanceRoom(student, mongoSession);

        // No monthly fee on the student at all, so there is no rate to build a
        // ceiling from and no sensible meaning to paying their fee ahead.
        if (room.ceiling <= 0) {
            throw new ApiError(
                400,
                'This student has no monthly fee set, so nothing can be held in advance for them'
            ).withCode('NO_ADVANCE_ROOM');
        }

        if (advance > room.amount) {
            throw new ApiError(
                400,
                `That would hold ₹${advance} in advance for this student, past the ₹${totalDue} they owe. ` +
                    `The most anyone can hold is ₹${room.ceiling} — one session's fee` +
                    `${room.amount < room.ceiling ? `, and ₹${round2(room.ceiling - room.amount)} of that is already held` : ''}. ` +
                    'Check the amount.'
            ).withCode('ADVANCE_TOO_LARGE');
        }
    }

    const splits = allocate(value, demands.map(dueOf));

    const ops = [];
    const covered = [];

    demands.forEach((d, i) => {
        const take = splits[i];
        if (take <= 0) return;

        const next = { ...d, paidAmount: round2((d.paidAmount || 0) + take) };
        ops.push({
            updateOne: {
                filter: { _id: d._id },
                update: { $inc: { paidAmount: take }, $set: { status: statusFor(next) } },
            },
        });
        covered.push({ demand: d._id, month: d.month, amount: take });
    });

    if (ops.length) await FeeDemand.bulkWrite(ops, { session: mongoSession, ordered: true });

    // Only the part a month actually claimed comes off what is owed. The rest
    // is a liability, and putting it on feeOutstanding would make the school's
    // receivable read low by exactly the amount it is holding for people.
    await Student.updateOne(
        { _id: student._id },
        { $inc: { feeOutstanding: -round2(value - advance), creditBalance: advance } },
        { session: mongoSession }
    );

    return { covered, advance, totalDue };
};

// ---------------------------------------------------------------------------
// Collecting a fee. Four writes inside one transaction — either all of
// them or none. Half-applying is the worst outcome: a receipt printed
// while the student's outstanding never moved.
//
// The amount is no longer capped at what is outstanding. A parent settling the
// whole year in one go, or two months at a time, is ordinary — and the months
// they are paying for have not been raised yet, so there is nothing for the
// money to land on. Whatever no month claims is held as advance and settles
// each new month as it is raised. See applyPayment and advanceRoom.
// ---------------------------------------------------------------------------
const collect = async ({ studentId, amount, mode, txnDate, note = '' }, actor) => {
    const session = await sessionService.getActiveSessionName();
    const value = round2(amount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    return withTransaction(async (mongoSession) => {
        // 1 + 2. The demands this settles, the advance it leaves, and both of
        //        the student's balances.
        const { covered, advance, totalDue } = await applyPayment(student, value, mongoSession);

        const seq = await getNextSequence('receiptNo', session, mongoSession);
        const receiptNo = formatCode('RCP', seq, 5);

        // 3 + 4. Ledger row + monthly/class rollups (ledger.service does both).
        //
        // The FULL amount reaches the day book and the month's collection, not
        // just the settled part. The money is physically in the drawer and the
        // cash box has to tally against it; an advance that only appeared once
        // it was consumed would leave the day short by exactly that figure.
        const txn = await ledger.record(
            {
                session,
                direction: 'IN',
                type: 'FEE',
                amount: value,
                mode,
                txnDate: txnDate || new Date(),
                party: { kind: 'Student', ref: student._id, name: student.name },
                classId: student.class,
                className: student.className,
                refModel: 'FeeDemand',
                refId: covered[0]?.demand || null,
                receiptNo,
                // The allocation this receipt made, so voidReceipt reverses
                // exactly these months rather than guessing. See
                // transaction.model.js.
                covered,
                // And what it left unclaimed, so a void knows how much of the
                // figure went to months and how much to the balance.
                advance,
                note,
                recordedBy: actor.id,
            },
            mongoSession
        );

        return {
            receiptNo,
            transactionId: txn._id,
            amount: value,
            mode,
            date: txn.txnDate,
            student: {
                id: student._id,
                name: student.name,
                admissionNo: student.admissionNo,
                className: student.className,
            },
            covered,
            advance,
            // What the student owes after this, and what the school is now
            // holding for them. Both, because a receipt that says "₹0 due" and
            // nothing else hides the ₹11,000 sitting on their head.
            balanceAfter: round2(Math.max(0, totalDue - value)),
            creditAfter: round2(round2(student.creditBalance || 0) + advance),
        };
    });
};

// ---------------------------------------------------------------------------
// Discount / waiver. Tracked separately so it never hides inside
// collections — "how much was waived" stays a number the Principal can see.
// ---------------------------------------------------------------------------
const applyDiscount = async (demandId, { amount, reason }, actor) => {
    const value = round2(amount);
    if (!(value > 0)) throw new ApiError(400, 'Discount must be greater than zero');
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required for the discount');

    return withTransaction(async (mongoSession) => {
        // Read inside the transaction, for the same reason collect() does: the
        // "cannot exceed the outstanding" check has to be made against the value
        // this write is about to change.
        const demand = await FeeDemand.findById(demandId).session(mongoSession).lean();
        if (!demand) throw new ApiError(404, 'Fee record not found');

        const due = dueOf(demand);
        if (value > due) {
            throw new ApiError(400, `Only ₹${due} is outstanding — the discount cannot exceed that`);
        }

        const next = { ...demand, discount: round2((demand.discount || 0) + value) };

        // The amount accumulates, so the reason must too. A $set left the second
        // discount's reason standing over a combined figure — ₹500 waived twice
        // for two different reasons read as one ₹1,000 waiver for whichever
        // reason was typed last, which is precisely the question an auditor asks.
        const trimmed = reason.trim();
        const nextReason = demand.discountReason
            ? `${demand.discountReason} · ${trimmed}`.slice(0, 500)
            : trimmed;

        await FeeDemand.updateOne(
            { _id: demandId },
            {
                $inc: { discount: value },
                $set: {
                    status: statusFor(next),
                    discountReason: nextReason,
                    discountBy: actor.id,
                },
            },
            { session: mongoSession }
        );

        await Student.updateOne(
            { _id: demand.student },
            { $inc: { feeOutstanding: -value } },
            { session: mongoSession }
        );

        // A discount is NOT a cash movement, so no Transaction row is written.
        // Only the rollup's discount head rises while expected stays put, so
        // "expected vs collected vs waived" all read separately.
        await ledger.bumpRollup(
            {
                session: demand.session,
                month: demand.month,
                classId: demand.class,
                className: demand.className,
                fields: { feeDiscount: value },
            },
            mongoSession
        );

        return { demandId, discount: value, reason: reason.trim() };
    });
};

// The part of a demand that was settled by a RECEIPT rather than out of an
// advance. Unwinding a receipt must never reach into money that came from
// credit: that money belongs to a different row and is taken back by
// unwindCredit, and touching it here would move paidAmount without moving
// paidFromCredit with it — leaving the two disagreeing and the student's
// credit underivable.
const receiptPaid = (d) => round2(Math.max(0, (d.paidAmount || 0) - (d.paidFromCredit || 0)));

// One demand giving money back. Status is recomputed from the demand's own
// numbers, so it can never contradict them.
const unwindOp = (demand, take) => {
    const next = { ...demand, paidAmount: round2((demand.paidAmount || 0) - take) };
    return {
        updateOne: {
            filter: { _id: demand._id },
            update: { $inc: { paidAmount: -take }, $set: { status: statusFor(next) } },
        },
    };
};

// ---------------------------------------------------------------------------
// Which demands give the money back when a receipt is voided.
//
// A receipt now records the allocation it made (Transaction.covered), so this
// is the exact inverse of that collection — the months THIS receipt paid, and
// nothing else.
//
// It used to unwind the student's newest paid months instead, on the reasoning
// that collection allocates oldest-first so a void should run newest-first.
// That is the exact inverse only while the student has ONE receipt. With two,
// voiding the older one took the money back off the months the NEWER one had
// paid: April/May stayed 'Paid' with their money gone, June/July flipped to
// 'Unpaid' with a valid receipt behind them. Every total still agreed — the
// student's outstanding, the rollups, recomputeBalances — because only the
// attribution was wrong, which is exactly why it could sit there unnoticed.
// ---------------------------------------------------------------------------
const unwindReceipt = async (txn, mongoSession) => {
    const ops = [];
    const done = [];
    let reversed = 0;

    if (txn.covered?.length) {
        const demands = await FeeDemand.find({ _id: { $in: txn.covered.map((c) => c.demand) } })
            .session(mongoSession)
            .lean();

        const byId = new Map(demands.map((d) => [String(d._id), d]));

        for (const line of txn.covered) {
            const demand = byId.get(String(line.demand));
            // The demand is gone — nothing to unwind here. The shortfall is
            // picked up below so the student's balance still adds up.
            if (!demand) continue;

            // Clamped: a demand cannot give back more receipt money than it is
            // currently holding. Normally that is the full line, but a receipt
            // voided under the old guess could have already moved money off
            // this demand, and a negative paidAmount is worse than a short
            // reversal.
            const take = round2(Math.min(line.amount, receiptPaid(demand)));
            if (take <= 0) continue;

            reversed = round2(reversed + take);
            done.push(demand._id);
            ops.push(unwindOp(demand, take));
        }
    }

    // Whatever the allocation could not account for. For a receipt written
    // before `covered` existed that is the entire amount, and this is the old
    // newest-first behaviour — kept so those receipts stay voidable at all.
    // For a newer one it is a shortfall from the cases above.
    //
    // It has to be covered somehow: Student.feeOutstanding goes up by the full
    // receipt amount below, so if the demands gave back less, the student's
    // balance and the sum of their dues would disagree — and that IS drift
    // recomputeBalances would report.
    let remaining = round2(txn.amount - reversed);

    if (remaining > 0) {
        const others = await FeeDemand.find({
            student: txn.party.ref,
            paidAmount: { $gt: 0 },
            _id: { $nin: done },
        })
            .sort({ month: -1 })
            .session(mongoSession)
            .lean();

        for (const demand of others) {
            if (remaining <= 0) break;

            const take = round2(Math.min(remaining, receiptPaid(demand)));
            if (take <= 0) continue;

            remaining = round2(remaining - take);
            ops.push(unwindOp(demand, take));
        }
    }

    return ops;
};

// ---------------------------------------------------------------------------
// Changing the AMOUNT on a receipt nobody has checked off yet.
//
// The counter typed ₹500 and took ₹5,000. Once anybody has signed the entry
// off the answer is still a void and a fresh collection — but while it is
// unchecked, correcting the figure in place is what the office means by
// "fix it", and a second receipt number for a slip that was mistyped seconds
// ago helps nobody.
//
// It is written as a FULL UNWIND followed by a fresh allocation, not as a
// difference applied to the months this receipt happens to name. That is the
// whole correctness argument: raising ₹500 to ₹5,000 has to reach months this
// receipt never touched, and lowering it has to give back the newest months
// first. Taking it all off and re-spreading the new figure oldest-first leaves
// the books in exactly the state they would have been in if the right amount
// had been collected in the first place, which is the only definition of
// correct available here.
//
// The caller owns the mongoose session and the ledger row — see
// payment.service.update. This function moves the demands and the student's
// balance, and hands back what the receipt now says it paid.
// ---------------------------------------------------------------------------
// TAKING ADVANCE BACK OFF A STUDENT, WHEREVER IT NOW SITS
//
// Credit is fungible — a rupee paid ahead in April is the same rupee whichever
// month it eventually settles — so this takes it from the unspent balance
// first and only then from the months it has already been applied to, newest
// month first. Newest, because it was applied oldest-first: that makes this
// the exact inverse, the same reasoning unwindReceipt is built on.
//
// `exclude` keeps it off the demands the receipt's own allocation is already
// giving back in the same breath. Those are fully paid months, which credit
// never lands on, so it should never match — but two $inc ops against one row
// in one bulkWrite would also write two statuses, and the second would be
// computed from a figure the first had already moved.
// ---------------------------------------------------------------------------
const unwindCredit = async (studentId, amount, exclude, mongoSession) => {
    const student = await Student.findById(studentId)
        .select('creditBalance')
        .session(mongoSession)
        .lean();

    let left = round2(amount);
    const fromBalance = round2(Math.min(left, student?.creditBalance || 0));
    left = round2(left - fromBalance);

    const ops = [];
    let fromMonths = 0;

    if (left > 0) {
        const rows = await FeeDemand.find({
            student: studentId,
            paidFromCredit: { $gt: 0 },
            _id: { $nin: exclude },
        })
            .sort({ month: -1 })
            .session(mongoSession)
            .lean();

        for (const d of rows) {
            if (left <= 0) break;

            const take = round2(Math.min(left, d.paidFromCredit || 0));
            if (take <= 0) continue;

            left = round2(left - take);
            fromMonths = round2(fromMonths + take);

            const next = { ...d, paidAmount: round2((d.paidAmount || 0) - take) };
            ops.push({
                updateOne: {
                    filter: { _id: d._id },
                    update: {
                        $inc: { paidAmount: -take, paidFromCredit: -take },
                        $set: { status: statusFor(next) },
                    },
                },
            });
        }
    }

    return { ops, fromBalance, fromMonths };
};

// ---------------------------------------------------------------------------
// TAKING A WHOLE RECEIPT BACK OFF — the months it settled and the advance it
// left, together.
//
// Shared by the void and by an amount correction, for the same reason
// applyPayment is shared by collection and correction: an edit has to undo
// exactly what a void would, or the two paths slowly disagree about the same
// receipt.
// ---------------------------------------------------------------------------
const rollbackPayment = async (txn, mongoSession) => {
    const advance = round2(txn.advance || 0);
    const settled = round2(txn.amount - advance);

    const ops = await unwindReceipt({ ...txn, amount: settled }, mongoSession);

    let fromBalance = 0;
    let fromMonths = 0;

    if (advance > 0) {
        const taken = await unwindCredit(
            txn.party.ref,
            advance,
            (txn.covered || []).map((c) => c.demand),
            mongoSession
        );
        ops.push(...taken.ops);
        fromBalance = taken.fromBalance;
        fromMonths = taken.fromMonths;
    }

    if (ops.length) await FeeDemand.bulkWrite(ops, { session: mongoSession, ordered: true });

    // What goes back on the student's dues is what a month had claimed: the
    // part this receipt settled outright, plus any advance that a later month
    // has since eaten. The advance still sitting unspent just leaves the
    // balance — no month ever counted it.
    await Student.updateOne(
        { _id: txn.party.ref },
        {
            $inc: {
                feeOutstanding: round2(settled + fromMonths),
                creditBalance: -fromBalance,
            },
        },
        { session: mongoSession }
    );

    return { settled, advance, fromBalance, fromMonths };
};

// ---------------------------------------------------------------------------
// Changing the AMOUNT on a receipt nobody has checked off yet.
//
// The counter typed ₹500 and took ₹5,000. Once anybody has signed the entry
// off the answer is still a void and a fresh collection — but while it is
// unchecked, correcting the figure in place is what the office means by
// "fix it", and a second receipt number for a slip that was mistyped seconds
// ago helps nobody.
//
// It is a FULL ROLLBACK followed by a fresh application, not a difference
// applied to the months this receipt happens to name. That is the whole
// correctness argument: raising ₹500 to ₹5,000 has to reach months this
// receipt never touched and may spill into advance, and lowering it has to
// give back the newest months first. Undoing it entirely and re-applying the
// new figure leaves the books in exactly the state they would have been in if
// the right amount had been collected in the first place, which is the only
// definition of correct available here.
//
// Both halves are the same functions collection and voiding use, so the three
// paths cannot drift apart.
//
// The caller owns the mongoose session and the ledger row — see
// payment.service.update.
// ---------------------------------------------------------------------------
const reviseReceipt = async (txn, newAmount, mongoSession) => {
    // Written before the allocation was recorded. Re-spreading a new figure
    // without knowing what the old one paid would be a guess, and a guess on an
    // edit is worse than a guess on a void — a void at least says so on its
    // face. Those receipts are voided and collected again.
    if (!txn.covered?.length && !round2(txn.advance || 0)) {
        throw new ApiError(
            409,
            'This receipt does not record which months it paid — void it and collect again instead'
        ).withCode('NO_ALLOCATION');
    }

    const undone = await rollbackPayment(txn, mongoSession);

    // The receipt's own allocation could not be taken back in full, so
    // something has happened to those months since it was written. Re-spreading
    // a new figure over what is left would quietly invent a balance. A void
    // states what it could and could not reverse, so that is the honest way out
    // — and nothing here has committed, because the caller holds the
    // transaction open around all of it.
    if (round2(undone.settled + undone.advance) !== round2(txn.amount)) {
        throw new ApiError(
            409,
            'The months this receipt paid have changed since — void it and collect again instead'
        ).withCode('NO_ALLOCATION');
    }

    const student = await Student.findById(txn.party.ref).session(mongoSession).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const { covered, advance } = await applyPayment(student, round2(newAmount), mongoSession);

    // What the row now says it paid and held, so a later void is still the
    // exact inverse of the receipt as it finally stands.
    return { set: { covered, advance, refId: covered[0]?.demand || null } };
};

// ---------------------------------------------------------------------------
// Voiding a wrong receipt. The original is never deleted — it is marked
// void and an opposing entry is written. The money goes back onto the
// student's outstanding, and any advance it left comes back off their credit.
// ---------------------------------------------------------------------------
const voidReceipt = async (transactionId, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to void this');

    const txn = await Transaction.findById(transactionId).lean();
    if (!txn) throw new ApiError(404, 'Receipt not found');
    if (txn.type !== 'FEE') throw new ApiError(400, 'This is not a fee receipt');
    if (txn.voided) throw new ApiError(409, 'This receipt has already been voided');
    // Checked off against the cash box already — see transaction.model.js.
    ledger.assertUnsealed(txn);

    return withTransaction(async (mongoSession) => {
        const undone = await rollbackPayment(txn, mongoSession);

        const reversal = await ledger.reverse(
            { original: txn, reason: reason.trim(), actorId: actor.id },
            mongoSession
        );

        return {
            voided: txn._id,
            reversalId: reversal._id,
            amount: txn.amount,
            // Spelled out because "₹13,200 voided" is not the whole story when
            // ₹11,000 of it was advance the parent had not used yet.
            advanceTakenBack: round2(undone.fromBalance + undone.fromMonths),
        };
    });
};


// ---------------------------------------------------------------------------
// GIVING AN ADVANCE BACK
//
// A child leaves in November with three months of fee still sitting on their
// head. The school owes that money back, and without this there is no way to
// hand it over: the credit would stay on a student who has gone, counted as a
// liability for ever. A balance with no way out is not a balance, it is a trap.
//
// It is money OUT, so it is a ledger row like any other payment out — and it
// takes the month's fee COLLECTION down with it (see ROLLUP_MAP in
// ledger.service), because a figure that was collected and then returned was
// not collected.
//
// The month it comes out of is the month it is handed over, not the month the
// advance arrived in. There is no single receipt to point at — credit is
// fungible and may have come from several — so there is no earlier month to
// put it back into. A month that gave back more than it took reads negative,
// which is the truth about that month.
// ---------------------------------------------------------------------------
const refundCredit = async (studentId, { amount, mode, reason }, actor) => {
    const value = round2(amount);
    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to refund this');

    const session = await sessionService.getActiveSessionName();

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    return withTransaction(async (mongoSession) => {
        // The balance is guarded in the FILTER, not read and then written. Two
        // people refunding the same credit in the same second would otherwise
        // both pass a check and both hand the money over.
        const updated = await Student.findOneAndUpdate(
            { _id: studentId, creditBalance: { $gte: value } },
            { $inc: { creditBalance: -value } },
            { new: true, session: mongoSession }
        )
            .select('creditBalance')
            .lean();

        if (!updated) {
            const held = round2(student.creditBalance || 0);
            throw new ApiError(
                400,
                held > 0
                    ? `Only ₹${held} is being held in advance for this student`
                    : 'Nothing is being held in advance for this student'
            ).withCode('NO_CREDIT');
        }

        const txn = await ledger.record(
            {
                session,
                direction: 'OUT',
                type: 'FEE_REFUND',
                amount: value,
                mode,
                txnDate: new Date(),
                party: { kind: 'Student', ref: student._id, name: student.name },
                classId: student.class,
                className: student.className,
                note: `Advance fee returned: ${reason.trim()}`,
                recordedBy: actor.id,
            },
            mongoSession
        );

        return {
            studentId,
            name: student.name,
            amount: value,
            mode,
            transactionId: txn._id,
            creditAfter: round2(updated.creditBalance),
        };
    });
};

// Receipt reprint
const getReceipt = async (transactionId) => {
    const txn = await Transaction.findById(transactionId).lean();
    if (!txn || txn.type !== 'FEE') throw new ApiError(404, 'Receipt not found');

    const student = await Student.findById(txn.party.ref)
        .select('name admissionNo className guardianName phone')
        .lean();

    return { receipt: txn, student };
};

// ---------------------------------------------------------------------------
// The class-wise monthly report — the screen the client asked for.
//
// This reads ONLY rollups. No $group, no $lookup, no collection scan.
// That is why the report still returns in single-digit milliseconds when
// the ledger holds half a million rows.
// ---------------------------------------------------------------------------
const summary = async ({ month }) => {
    const session = await sessionService.getActiveSessionName();
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');

    const rollups = await MonthlyRollup.find({ session, month })
        .select('scope class className feeExpected feeCollected feeDiscount')
        .lean();

    const school = rollups.find((r) => r.scope === 'SCHOOL') || {};
    const classes = rollups
        .filter((r) => r.scope === 'CLASS')
        .map((r) => {
            const expected = round2(r.feeExpected || 0);
            const collected = round2(r.feeCollected || 0);
            const discount = round2(r.feeDiscount || 0);
            return {
                classId: r.class,
                className: r.className,
                expected,
                collected,
                discount,
                outstanding: round2(Math.max(0, expected - discount - collected)),
                // Percentage is against the net demand after discount — otherwise
                // a class with waivers would show an artificially low collection rate.
                rate: expected - discount > 0 ? Math.round((collected / (expected - discount)) * 100) : 100,
            };
        })
        .sort((a, b) => a.className.localeCompare(b.className));

    const expected = round2(school.feeExpected || 0);
    const collected = round2(school.feeCollected || 0);
    const discount = round2(school.feeDiscount || 0);

    return {
        month,
        school: {
            expected,
            collected,
            discount,
            outstanding: round2(Math.max(0, expected - discount - collected)),
            rate: expected - discount > 0 ? Math.round((collected / (expected - discount)) * 100) : 100,
        },
        classes,
    };
};

module.exports = {
    generateMonth,
    listDemands,
    pendingForStudent,
    collect,
    applyDiscount,
    reviseReceipt,
    voidReceipt,
    refundCredit,
    advanceRoom,
    settleFromCredit,
    getReceipt,
    summary,
    recomputeExpected,
    statusFor,
    dueOf,
};

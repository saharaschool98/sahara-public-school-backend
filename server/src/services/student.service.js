const mongoose = require('mongoose');
const Student = require('../models/student.model');
const FeeDemand = require('../models/feeDemand.model');
const ChargeDemand = require('../models/chargeDemand.model');
const StockSale = require('../models/stockSale.model');
const Transaction = require('../models/transaction.model');
const SchoolClass = require('../models/schoolClass.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
// Only for recomputeExpected, after a class change moves a student's demands
// between two classes' rollups. No cycle: fee.service reaches for models and
// ledger, never back to this file.
const feeService = require('./fee.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { prefixMatch, isPhoneLike, normalisePhone } = require('../utils/search');
const { round2 } = require('../utils/money');

// These are the fields every list response returns — never the whole document.
// A small query and a small payload, so it parses quickly on the shared
// laptop in the school office.
const LIST_FIELDS =
    'admissionNo name className class phone altPhone guardianName motherName monthlyFee '
    + 'feeOutstanding stockOutstanding chargeOutstanding creditBalance status idCard '
    // The roster's Left tab is also the TC working list — the flag and the
    // leaving date ride along rather than costing a second request per row.
    + 'leftAt leftReason tc '
    // A transfer certificate prints all three, and it is printed straight from
    // the row it was issued on. Fetching them costs a few bytes per student;
    // not having them means the certificate comes out with blank lines where
    // the date of birth and the address should be.
    + 'dob address admissionDate';

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session, status: query.status || 'Active' };

    if (query.class) filter.class = query.class;
    if (query.hasDues === 'true') filter.feeOutstanding = { $gt: 0 };

    // "Who in 5-B has not taken their ID card yet." A flag, so this is an
    // indexed equality — the same read as the plain roster, not a second query.
    if (query.idCard === 'issued') filter['idCard.issued'] = true;
    if (query.idCard === 'pending') filter['idCard.issued'] = { $ne: true };

    // "Who has left and not been given their TC." The same shape, off its own
    // index — and with status=Left it is the office's entire working list,
    // count included, from one query. See the index in student.model.js.
    if (query.tc === 'given') filter['tc.given'] = true;
    if (query.tc === 'pending') filter['tc.given'] = { $ne: true };

    // A full phone number is an exact match (index hit); otherwise an anchored
    // name prefix — both use an index. See utils/search.js.
    const term = (query.search || '').trim();
    if (term) {
        if (isPhoneLike(term)) {
            filter.phone = normalisePhone(term);
        } else {
            const rx = prefixMatch(term);
            if (rx) filter.nameLower = rx;
        }
    }

    // The sort field is the last part of the index — filter and sort both come
    // from one index, with no in-memory sort.
    const sort = filter.feeOutstanding ? { feeOutstanding: -1 } : { nameLower: 1 };

    return fetchPage(Student.find(filter).select(LIST_FIELDS).sort(sort), { page, limit, withTotal: true });
};

const getById = async (id) => {
    const doc = await Student.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Student not found');
    return doc;
};

// ---------------------------------------------------------------------------
// A student's full ledger — fee demands, receipts and stock purchases
// together, in date order. This is the data behind "print statement".
// ---------------------------------------------------------------------------
const getLedger = async (studentId) => {
    const student = await getById(studentId);

    const [demands, charges, sales, payments, siblings] = await Promise.all([
        FeeDemand.find({ student: studentId })
            .select('month amount discount paidAmount status dueDate')
            .sort({ month: -1 })
            .lean(),
        // Admission, exams, trips — everything charged beyond the monthly fee.
        ChargeDemand.find({ student: studentId })
            .select('headName title amount discount paidAmount status dueDate createdAt')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean(),

        StockSale.find({ student: studentId, voided: false })
            .select('billNo date total paidAmount dueAmount lines')
            .sort({ date: -1 })
            .limit(50)
            .lean(),
        // VOIDED ROWS ARE INCLUDED.
        //
        // They were filtered out, so voiding a receipt made it vanish from the
        // student's own page entirely while the day book still showed it struck
        // through with its reversal beside it. Two screens telling different
        // stories about the same receipt is exactly what an append-only ledger
        // exists to prevent — and the parent asking "what happened to my
        // receipt" is asking on this screen, not the day book's.
        Transaction.find({
            'party.kind': 'Student',
            'party.ref': studentId,
        })
            .select(
                'type amount mode txnDate receiptNo note direction party voided ' +
                    'voidedAt voidReason reversalOf verified verifiedAt verifiedByName'
            )
            .sort({ txnDate: -1 })
            .limit(100)
            .lean(),

        // The rest of the family, if any. Sent with the profile rather than as a
        // request of its own — it is two or three documents off a partial index,
        // and the screen that wants it is this one.
        //
        // A sibling who has LEFT is still a sibling and stays on the list, with
        // their status showing. Leaving is not something that happens to a
        // family.
        student.siblingGroup
            ? Student.find({ siblingGroup: student.siblingGroup, _id: { $ne: student._id } })
                .select('name admissionNo className status feeOutstanding stockOutstanding phone')
                .sort({ nameLower: 1 })
                .lean()
            : [],
    ]);

    return {
        student,
        demands,
        charges,
        sales,
        siblings,
        // Same flag, same single source as the day book — see report.service.
        payments: payments.map((p) => ({ ...p, verifiable: Transaction.isVerifiable(p) })),
        // These two numbers are not counted from documents — they are maintained
        // on the Student. That is why this screen is as fast at 3,000 students as
        // it is at 30.
        summary: {
            feeOutstanding: student.feeOutstanding,
            stockOutstanding: student.stockOutstanding,
            chargeOutstanding: student.chargeOutstanding || 0,
            totalOutstanding: round2(
                (student.feeOutstanding || 0)
                + (student.stockOutstanding || 0)
                + (student.chargeOutstanding || 0)
            ),
            // Money the school is holding for this child, not money they owe.
            // Kept out of totalOutstanding on purpose — it is the other side of
            // the ledger, and netting the two would hide both.
            creditBalance: round2(student.creditBalance || 0),
        },
    };
};

const create = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();

    const cls = await SchoolClass.findOne({ _id: payload.class, session }).lean();
    if (!cls) throw new ApiError(404, 'Class not found');

    return withTransaction(async (mongoSession) => {
        const seq = await getNextSequence('admissionNo', session, mongoSession);

        const [student] = await Student.create(
            [
                {
                    ...payload,
                    session,
                    admissionNo: formatCode('ADM', seq),
                    nameLower: payload.name.toLowerCase().trim(),
                    className: `${cls.name} – ${cls.section}`,
                    // Falls back to the class default — override it for cases like a
                    // sibling concession.
                    monthlyFee: payload.monthlyFee ?? cls.monthlyFee,
                    createdBy: actorId,
                },
            ],
            { session: mongoSession }
        );

        await SchoolClass.updateOne(
            { _id: cls._id },
            { $inc: { studentCount: 1 } },
            { session: mongoSession }
        );

        return student;
    });
};

// ---------------------------------------------------------------------------
// Update. Changing class is the delicate case: both class counts move and
// the denormalised className has to be rewritten.
//
// Old receipts keep their className — they stay filed under the class they
// were issued in, otherwise last month's class-wise report would quietly
// change.
// ---------------------------------------------------------------------------
const update = async (id, updates, actorId) => {
    const student = await Student.findById(id);
    if (!student) throw new ApiError(404, 'Student not found');

    const changingClass = updates.class && updates.class.toString() !== student.class.toString();

    if (!changingClass) {
        Object.assign(student, updates);
        await student.save();
        return student;
    }

    const cls = await SchoolClass.findById(updates.class).lean();
    if (!cls) throw new ApiError(404, 'The new class was not found');

    const oldClassId = student.class;

    // The months whose demands are about to move. Read BEFORE the write, while
    // they still carry the old class — afterwards there is no way to tell which
    // months were touched.
    const moving = await FeeDemand.find({ student: id, status: { $ne: 'Paid' } })
        .select('month session')
        .lean();

    const affected = [...new Set(moving.map((d) => `${d.session}|${d.month}`))];

    const saved = await withTransaction(async (mongoSession) => {
        Object.assign(student, updates, { className: `${cls.name} – ${cls.section}` });
        await student.save({ session: mongoSession });

        await SchoolClass.bulkWrite(
            [
                { updateOne: { filter: { _id: oldClassId }, update: { $inc: { studentCount: -1 } } } },
                { updateOne: { filter: { _id: cls._id }, update: { $inc: { studentCount: 1 } } } },
            ],
            { session: mongoSession }
        );

        // Future unpaid demands move to the new class — otherwise the new class's
        // next month's class-wise report would still show the old class.
        await FeeDemand.updateMany(
            { student: id, status: { $ne: 'Paid' } },
            { $set: { class: cls._id, className: `${cls.name} – ${cls.section}` } },
            { session: mongoSession }
        );

        return student;
    });

    // -----------------------------------------------------------------------
    // The demands moved; the rollups they are counted in did not.
    //
    // A class-wise report reads MonthlyRollup.feeExpected, never the demands.
    // Moving a child from 5-A to 5-B rewrote the demand rows and left 5-A's
    // expected figure carrying a student it no longer has, while 5-B's was
    // short by the same amount — in opposite directions, so the school total
    // still agreed and nothing looked wrong.
    //
    // recomputeExpected rewrites a whole month authoritatively from the demands
    // themselves, so one call per affected month repairs BOTH classes at once.
    // Outside the transaction on purpose: it is an authoritative $set over
    // committed data, safe to re-run, and the next fee generation or
    // recompute:balances would redo it anyway.
    // -----------------------------------------------------------------------
    for (const key of affected) {
        const [sessionName, month] = key.split('|');
        await feeService.recomputeExpected(sessionName, month);
    }

    return saved;
};

// Everything a child still owes, and the one thing the school owes them back.
// In one place because three callers ask the same question — marking a student
// left, issuing their TC, and the audit line each of those writes — and a
// fourth reading of "what is outstanding" would eventually disagree with the
// other three.
//
// chargeOutstanding is in this sum. It used to be left out, so a child leaving
// with an unpaid exam fee was recorded as owing nothing of it.
const balancesOf = (student) => ({
    dues: round2(
        (student.feeOutstanding || 0)
        + (student.stockOutstanding || 0)
        + (student.chargeOutstanding || 0)
    ),
    credit: round2(student.creditBalance || 0),
});

// ---------------------------------------------------------------------------
// Taking a student OFF THE ROSTER — the status, the leaving date and the
// class's headcount, which must move together or the class list starts lying.
//
// One function, because two paths do it: marking a student left, and issuing a
// TC for a student who is still on the roll. Written as a CONDITIONAL update
// rather than read-then-save: the filter carries `status: 'Active'`, so two
// people doing this in the same second cannot both decrement the class count
// and leave the roster short by one for the rest of the year. The loser of the
// race matches nothing and is told so.
//
// Returns false when the student was already Left — not an error, because both
// callers have a sensible answer to that and they are not the same answer.
// ---------------------------------------------------------------------------
const leaveRoster = async (student, { leftAt, reason = '' }, mongoSession) => {
    const moved = await Student.updateOne(
        { _id: student._id, status: 'Active' },
        { $set: { status: 'Left', leftAt, leftReason: reason } },
        { session: mongoSession }
    );

    if (!moved.matchedCount) return false;

    await SchoolClass.updateOne(
        { _id: student.class },
        { $inc: { studentCount: -1 } },
        { session: mongoSession }
    );

    return true;
};

// Never deleted — status becomes Left. The full history is kept.
const markLeft = async (id, { reason = '', leftAt } = {}) => {
    const student = await Student.findById(id).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const { dues, credit } = balancesOf(student);

    // Already gone. This used to return the bare student document while the
    // normal path returned { student, outstandingCarried } — so the controller's
    // audit line read `data.student.name` and threw on the one call that was
    // supposed to be the harmless no-op.
    if (student.status === 'Left') {
        return { student, outstandingCarried: dues, creditHeld: credit, alreadyLeft: true };
    }

    return withTransaction(async (mongoSession) => {
        const moved = await leaveRoster(
            student,
            { leftAt: leftAt || new Date(), reason: reason.trim() },
            mongoSession
        );

        if (!moved) {
            return { student, outstandingCarried: dues, creditHeld: credit, alreadyLeft: true };
        }

        // The outstanding survives — a student leaving is not a way for dues to
        // disappear. They keep showing on the outstanding report and the
        // defaulters list, both of which count money owed rather than people on
        // the roll. And `creditHeld` is the other direction, which is easier to
        // forget and worse to get wrong: money the school is holding for a child
        // who has gone is money it owes.
        return {
            student: { ...student, status: 'Left', leftAt: leftAt || new Date(), leftReason: reason.trim() },
            outstandingCarried: dues,
            creditHeld: credit,
            alreadyLeft: false,
        };
    });
};

// Defaulters — no aggregation, just an indexed read
const defaulters = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    // Status is not filtered. A student who has left still owes what they owe,
    // and dropping them from this list was how the dues quietly stopped being
    // chased — see report.service for the same correction. `status` is selected
    // so the screen can say which of them have gone.
    const filter = { session, feeOutstanding: { $gt: 0 } };
    if (query.class) filter.class = query.class;
    if (query.status) filter.status = query.status;

    return fetchPage(
        Student.find(filter)
            .select('admissionNo name className phone altPhone guardianName motherName status leftAt tc feeOutstanding stockOutstanding chargeOutstanding')
            .sort({ feeOutstanding: -1 }),
        { page, limit, withTotal: true }
    );
};

// ---------------------------------------------------------------------------
// SIBLINGS
//
// Linking two students puts them in one family GROUP — see student.model.js for
// why it is a group id rather than a list of links on each record.
//
// The four cases this has to cover, and it covers them in one expression:
//
//   neither is in a group   -> a new group, both join it
//   one is                  -> the other joins theirs
//   both are, same group    -> already linked, say so
//   both are, DIFFERENT     -> the two families MERGE
//
// That last one is the case a pair-of-links model gets wrong. Two brothers are
// already linked, two sisters are already linked, and somebody then discovers
// all four are one family: linking any brother to any sister has to bring all
// four together, not create a fifth relationship nobody can see.
// ---------------------------------------------------------------------------
const linkSibling = async (studentId, siblingId) => {
    if (String(studentId) === String(siblingId)) {
        throw new ApiError(400, 'A student cannot be their own sibling');
    }

    const session = await sessionService.getActiveSessionName();

    // Same session on both sides. A student from last year is a different
    // record, and linking across sessions would put a name on this year's
    // family list that belongs to a roster nobody is looking at.
    const [student, sibling] = await Promise.all([
        Student.findOne({ _id: studentId, session }).select('name admissionNo siblingGroup').lean(),
        Student.findOne({ _id: siblingId, session }).select('name admissionNo siblingGroup').lean(),
    ]);

    if (!student) throw new ApiError(404, 'Student not found');
    if (!sibling) throw new ApiError(404, 'The student being linked was not found in this session');

    if (student.siblingGroup && String(student.siblingGroup) === String(sibling.siblingGroup)) {
        throw new ApiError(409, `${sibling.name} is already linked to ${student.name}`).withCode('ALREADY_SIBLINGS');
    }

    return withTransaction(async (mongoSession) => {
        // Whichever group already exists survives; a brand new one only when
        // neither side has a family yet.
        const group =
            student.siblingGroup || sibling.siblingGroup || new mongoose.Types.ObjectId();

        // Any OTHER group on either side is absorbed into it — this is the merge.
        const absorbed = [student.siblingGroup, sibling.siblingGroup].filter(
            (g) => g && String(g) !== String(group)
        );

        if (absorbed.length) {
            await Student.updateMany(
                { siblingGroup: { $in: absorbed } },
                { $set: { siblingGroup: group } },
                { session: mongoSession }
            );
        }

        await Student.updateMany(
            { _id: { $in: [studentId, siblingId] } },
            { $set: { siblingGroup: group } },
            { session: mongoSession }
        );

        const members = await Student.find({ siblingGroup: group })
            .select('name admissionNo className')
            .sort({ nameLower: 1 })
            .session(mongoSession)
            .lean();

        return {
            group,
            student: { id: student._id, name: student.name },
            sibling: { id: sibling._id, name: sibling.name, admissionNo: sibling.admissionNo },
            // >2 means two families were just merged, and the screen says so.
            merged: absorbed.length > 0,
            members,
        };
    });
};

// Taking one person out of the family — a mis-click, or two children with the
// same surname who turned out not to be related.
const unlinkSibling = async (studentId, siblingId) => {
    const student = await Student.findById(studentId).select('name siblingGroup').lean();
    if (!student) throw new ApiError(404, 'Student not found');
    if (!student.siblingGroup) throw new ApiError(409, 'This student has no siblings linked');

    const sibling = await Student.findById(siblingId).select('name siblingGroup').lean();
    if (!sibling || String(sibling.siblingGroup || '') !== String(student.siblingGroup)) {
        throw new ApiError(409, 'These two are not linked to each other').withCode('NOT_SIBLINGS');
    }

    const group = student.siblingGroup;

    return withTransaction(async (mongoSession) => {
        await Student.updateOne(
            { _id: siblingId },
            { $set: { siblingGroup: null } },
            { session: mongoSession }
        );

        // A group of one is not a group. Without this, removing the second of
        // two would leave the first flagged as being in a family whose only
        // other member had gone — and the next person linked to them would
        // silently join that stale group.
        const left = await Student.find({ siblingGroup: group })
            .select('_id name')
            .session(mongoSession)
            .lean();

        if (left.length === 1) {
            await Student.updateOne(
                { _id: left[0]._id },
                { $set: { siblingGroup: null } },
                { session: mongoSession }
            );
        }

        return {
            removed: { id: siblingId, name: sibling.name },
            from: student.name,
            remaining: left.length === 1 ? 0 : left.length,
        };
    });
};

// ---------------------------------------------------------------------------
// ID CARDS
//
// Issuing is one act at the counter: the card is handed over and the money is
// taken. So this sets the flag AND writes the ledger row, in one transaction —
// a card marked issued with no money recorded, or money recorded against no
// card, are both worse than the operation failing outright.
//
// A free card (staff child, replacement covered by the school) is `amount: 0`.
// That sets the flag and writes NO ledger row, because no cash moved — the same
// rule a discount follows.
// ---------------------------------------------------------------------------
const issueIdCard = async (studentId, { amount, mode = 'Cash', date, note = '' }, actor) => {
    const session = await sessionService.getActiveSession();

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    if (student.idCard?.issued) {
        throw new ApiError(409, `${student.name} has already been given an ID card`).withCode('IDCARD_ISSUED');
    }

    // Falls back to the school-wide fee for the year, so the counter types a
    // number only when this particular card is an exception.
    const value = round2(amount ?? session.idCardFee ?? 0);
    if (!(value >= 0)) throw new ApiError(400, 'Amount cannot be negative');

    const issuedAt = date || new Date();

    return withTransaction(async (mongoSession) => {
        let txn = null;

        if (value > 0) {
            txn = await ledger.record(
                {
                    session: session.name,
                    direction: 'IN',
                    type: 'ID_CARD',
                    amount: value,
                    mode,
                    txnDate: issuedAt,
                    party: { kind: 'Student', ref: student._id, name: student.name },
                    // Carried so the class-wise collection report works off the
                    // same rollup every other class figure comes from.
                    classId: student.class,
                    className: student.className,
                    refModel: 'Student',
                    refId: student._id,
                    note: note || 'ID card',
                    recordedBy: actor.id,
                },
                mongoSession
            );
        }

        const stamped = await Student.updateOne(
            { _id: studentId, 'idCard.issued': { $ne: true } },
            {
                $set: {
                    'idCard.issued': true,
                    'idCard.issuedAt': issuedAt,
                    'idCard.amount': value,
                    'idCard.issuedBy': actor.id,
                    'idCard.txn': txn?._id || null,
                    'idCard.note': note,
                },
            },
            { session: mongoSession }
        );

        // The guard matched nothing: somebody issued this card between the check
        // above and this write. Its result was being thrown away, so the ledger
        // row was already written and the transaction committed happily — money
        // recorded against a card the student is not marked as having.
        if (stamped.matchedCount === 0) {
            throw new ApiError(
                409,
                `${student.name} was given an ID card a moment ago from somewhere else`
            ).withCode('IDCARD_ISSUED');
        }

        return {
            studentId,
            name: student.name,
            admissionNo: student.admissionNo,
            className: student.className,
            amount: value,
            mode: value > 0 ? mode : 'Adjustment',
            issuedAt,
            transactionId: txn?._id || null,
        };
    });
};

// Changing what was charged for a card nobody has checked off yet.
//
// The card itself does not move — the student still holds one. Only the figure
// it was issued against, which lives in two places and has to stay the same in
// both: the flag on the student and the ledger row. The caller owns the session
// and the ledger row — see payment.service.update.
const reviseIdCardAmount = async (txn, newAmount, mongoSession) => {
    // Matched on the card's own transaction, not just the student — the same
    // reasoning cancelIdCard follows, so a fee receipt can never be mistaken
    // for this one.
    const updated = await Student.updateOne(
        { _id: txn.party.ref, 'idCard.txn': txn._id, 'idCard.issued': true },
        { $set: { 'idCard.amount': round2(newAmount) } },
        { session: mongoSession }
    );

    if (!updated.matchedCount) {
        throw new ApiError(
            409,
            'This ID card has since been cancelled — issue it again at the right amount'
        );
    }

    return {};
};

// Marked by mistake. The flag clears and, if money was taken, the ledger row is
// REVERSED — never deleted. Both lines stay in the day book, like every other
// correction in this app.
const cancelIdCard = async (studentId, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to cancel this');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');
    if (!student.idCard?.issued) throw new ApiError(409, 'No ID card has been issued to this student');

    // The exact row this issue wrote — not "a transaction that mentions this
    // student", which would pick up a fee receipt.
    const txn = student.idCard.txn
        ? await Transaction.findOne({ _id: student.idCard.txn, voided: false }).lean()
        : null;

    // A card whose payment has been checked off against the cash box stays
    // issued. A free card has no transaction and so no seal — it can always be
    // undone. See transaction.model.js.
    ledger.assertUnsealed(txn);

    return withTransaction(async (mongoSession) => {
        if (txn) {
            await ledger.reverse(
                { original: txn, reason: reason.trim(), actorId: actor.id },
                mongoSession
            );
        }

        await Student.updateOne(
            { _id: studentId },
            {
                $set: {
                    'idCard.issued': false,
                    'idCard.issuedAt': null,
                    'idCard.amount': 0,
                    'idCard.issuedBy': null,
                    'idCard.txn': null,
                    'idCard.note': '',
                },
            },
            { session: mongoSession }
        );

        return { studentId, name: student.name, refunded: txn ? txn.amount : 0 };
    });
};

// ---------------------------------------------------------------------------
// Class-wise: how many have taken theirs, how many have not, and what came in.
//
// One aggregation over Student — a few hundred documents with the flag on an
// index — not a scan of the ledger. Same reasoning as the outstanding report.
// ---------------------------------------------------------------------------
const idCardSummary = async () => {
    const session = await sessionService.getActiveSessionName();

    const [rows, classes] = await Promise.all([
        Student.aggregate([
            { $match: { session, status: 'Active' } },
            {
                $group: {
                    _id: '$class',
                    className: { $first: '$className' },
                    total: { $sum: 1 },
                    issued: { $sum: { $cond: [{ $eq: ['$idCard.issued', true] }, 1, 0] } },
                    collected: { $sum: { $cond: [{ $eq: ['$idCard.issued', true] }, '$idCard.amount', 0] } },
                },
            },
        ]),
        // Classes with no students still belong on the report — a class missing
        // from the list reads as "done", which is the opposite of the truth.
        SchoolClass.find({ session, isActive: true }).select('name section order').sort({ order: 1 }).lean(),
    ]);

    const byClass = new Map(rows.map((r) => [String(r._id), r]));

    const list = classes.map((c) => {
        const row = byClass.get(String(c._id)) || { total: 0, issued: 0, collected: 0 };
        const pending = row.total - row.issued;
        return {
            classId: c._id,
            className: `${c.name} – ${c.section}`,
            total: row.total,
            issued: row.issued,
            pending,
            collected: round2(row.collected),
            percent: row.total ? Math.round((row.issued / row.total) * 100) : 0,
        };
    });

    const school = list.reduce(
        (acc, c) => ({
            total: acc.total + c.total,
            issued: acc.issued + c.issued,
            pending: acc.pending + c.pending,
            collected: round2(acc.collected + c.collected),
        }),
        { total: 0, issued: 0, pending: 0, collected: 0 }
    );

    return {
        classes: list,
        school: { ...school, percent: school.total ? Math.round((school.issued / school.total) * 100) : 0 },
    };
};

// ---------------------------------------------------------------------------
// TRANSFER CERTIFICATES
//
// A child leaves, and the next school will not take them without a TC. So this
// is ONE act at the counter, not two: issuing the certificate also takes the
// student off the roster, in the same transaction, exactly the way issuing an
// ID card also takes the money. The office should not have to remember to do
// the second half — a student marked Left with no TC is a phone call next
// week, and a TC issued for a child still counted in their class is a roster
// that lies.
//
// It also works the other way round, because both orders genuinely happen: a
// student marked Left in November whose parents come for the certificate in
// January is the same operation with the roster step already done. `markedLeft`
// records which of the two it was, so cancelling is the exact inverse of this
// particular issue rather than a guess. Same lesson as `covered` on a fee
// receipt.
//
// WHAT UNPAID DUES DO
//
// They warn; they do not silently decide. Refusing outright would be the wrong
// call — a waiver still being argued about, a family that has genuinely gone,
// a child whose place at the next school will not wait — and the certificate
// does not stop being owed because the software said no. What it must never be
// is quiet: the dues are frozen onto the TC record, printed on the certificate
// itself, and named in the audit line with the signer's name against them. The
// override is a decision somebody makes and can be asked about, which is the
// most a piece of software can honestly do here.
// ---------------------------------------------------------------------------
const issueTC = async (
    studentId,
    { reason = '', conduct = 'Good', note = '', issuedAt, issueAnyway = false },
    actor
) => {
    const sessionName = await sessionService.getActiveSessionName();

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    if (student.tc?.given) {
        throw new ApiError(
            409,
            `${student.name} has already been given a transfer certificate (${student.tc.no})`
        ).withCode('TC_ISSUED');
    }

    // Both halves, when both apply. Told once and in full, rather than refusing
    // twice — the second refusal after clearing the first is how a warning
    // stops being read.
    const blocked = ({ dues, credit }) => {
        const lines = [];
        if (dues > 0) {
            lines.push(`₹${dues} is still outstanding for ${student.name}`);
        }
        if (credit > 0) {
            lines.push(
                `₹${credit} is being held in advance for ${student.name} — the school owes that back`
            );
        }

        return new ApiError(
            409,
            `${lines.join(', and ')}. Settle it, or issue the certificate anyway — `
            + 'the amount is printed on the TC and recorded against whoever signed it.'
        ).withCode('TC_BLOCKED');
    };

    // The pre-check, on the figures the office is looking at. The authoritative
    // one is inside the transaction below; this one exists to keep the ordinary
    // refusal off the transaction path entirely — the same reasoning behind the
    // pre-filter in fee generation.
    const preview = balancesOf(student);
    if (!issueAnyway && (preview.dues > 0 || preview.credit > 0)) throw blocked(preview);

    const when = issuedAt || new Date();

    return withTransaction(async (mongoSession) => {
        // Read INSIDE the transaction, and this is the read that counts.
        //
        // These two figures are printed on the face of the certificate, so they
        // have to be true at the moment it is signed rather than at the moment
        // the dialog was opened. Without this, a parent who cleared their dues
        // at the other counter while the office was typing would walk out
        // holding a legal document that says they still owe ₹5,000.
        const live = await Student.findById(studentId)
            .select('feeOutstanding stockOutstanding chargeOutstanding creditBalance')
            .session(mongoSession)
            .lean();

        const { dues, credit } = balancesOf(live || student);

        // And the refusal is made again on those same current figures — money
        // can move the other way too, and a TC must not slip through on a
        // balance that was already stale when it was read.
        if (!issueAnyway && (dues > 0 || credit > 0)) throw blocked({ dues, credit });

        // Off the roster FIRST, so the answer to "did this issue move them" is
        // known before it is written down. A student already Left returns false
        // and keeps their original leaving date — the TC records the leaving,
        // it does not redate it.
        const markedLeft = await leaveRoster(
            student,
            { leftAt: when, reason: reason.trim() },
            mongoSession
        );

        // Numbered from the counter, inside the transaction — so an aborted
        // issue burns no number, and two people issuing at once cannot be
        // handed the same one. Per session, like admission and receipt numbers.
        const seq = await getNextSequence('tcNo', sessionName, mongoSession);
        const no = formatCode('TC', seq, 4);

        const stamped = await Student.updateOne(
            { _id: studentId, 'tc.given': { $ne: true } },
            {
                $set: {
                    'tc.given': true,
                    'tc.no': no,
                    'tc.issuedAt': when,
                    'tc.issuedBy': actor.id,
                    'tc.reason': reason.trim(),
                    // A certificate always states conduct — a blank line there
                    // reads as an accusation rather than an omission.
                    'tc.conduct': conduct.trim() || 'Good',
                    'tc.markedLeft': markedLeft,
                    'tc.duesAtIssue': dues,
                    'tc.creditAtIssue': credit,
                    'tc.note': note.trim(),
                },
            },
            { session: mongoSession }
        );

        // Somebody issued one between the check at the top and this write. The
        // whole transaction aborts — including the roster change and the
        // counter — so there is no half-issued student and no burnt number.
        if (stamped.matchedCount === 0) {
            throw new ApiError(
                409,
                `${student.name} was given a transfer certificate a moment ago from somewhere else`
            ).withCode('TC_ISSUED');
        }

        return {
            studentId,
            tcNo: no,
            name: student.name,
            admissionNo: student.admissionNo,
            className: student.className,
            issuedAt: when,
            reason: reason.trim(),
            conduct: conduct.trim() || 'Good',
            // Said out loud in the response, because the toast and the printed
            // certificate both have to carry it — a TC handed over with ₹5,000
            // unpaid is a fact the school will want back later.
            duesAtIssue: dues,
            creditAtIssue: credit,
            // Whether this also took them off the roster, so the screen can say
            // "issued and marked as Left" rather than making the user check.
            markedLeft,
        };
    });
};

// ---------------------------------------------------------------------------
// Issued by mistake — the wrong child, the wrong day, a family that changed
// their mind before the certificate left the building.
//
// The exact inverse of THIS issue, which is what `markedLeft` is for: a TC that
// took the student off the roster puts them back on it, and a TC issued for a
// child who was already Left leaves their status exactly where it was. Getting
// that wrong in either direction is silent — a student quietly back in a class
// nobody teaches them in, or a roster short by one for the rest of the year.
//
// The NUMBER IS NOT REUSED. The counter never goes backwards, so the next
// certificate is the next number and TC0007 simply never existed as far as any
// receiving school is concerned. What it was, and who cancelled it, lives in
// the edit history — which is the part somebody actually gets asked about.
// ---------------------------------------------------------------------------
const cancelTC = async (studentId, reason) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to cancel this');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    if (!student.tc?.given) {
        throw new ApiError(409, `No transfer certificate has been issued to ${student.name}`)
            .withCode('TC_NOT_ISSUED');
    }

    const restore = student.tc.markedLeft === true;
    const tcNo = student.tc.no;

    return withTransaction(async (mongoSession) => {
        const cleared = {
            'tc.given': false,
            'tc.no': null,
            'tc.issuedAt': null,
            'tc.issuedBy': null,
            'tc.reason': '',
            'tc.conduct': '',
            'tc.markedLeft': false,
            'tc.duesAtIssue': 0,
            'tc.creditAtIssue': 0,
            'tc.note': '',
        };

        if (restore) {
            cleared.status = 'Active';
            cleared.leftAt = null;
            cleared.leftReason = '';
        }

        // Guarded on the flag still being set, for the same reason every other
        // reversal in this app is: two people cancelling at once would otherwise
        // both put the student back on the roll and leave the class counted one
        // too high.
        const undone = await Student.updateOne(
            { _id: studentId, 'tc.given': true },
            { $set: cleared },
            { session: mongoSession }
        );

        if (undone.matchedCount === 0) {
            throw new ApiError(409, 'This certificate has already been cancelled')
                .withCode('TC_NOT_ISSUED');
        }

        if (restore) {
            await SchoolClass.updateOne(
                { _id: student.class },
                { $inc: { studentCount: 1 } },
                { session: mongoSession }
            );
        }

        return {
            studentId,
            name: student.name,
            tcNo,
            // The screen says which of the two happened, because they look
            // identical until somebody opens the roster.
            restoredToRoster: restore,
        };
    });
};

module.exports = {
    list, getById, getLedger, create, update, markLeft, defaulters,
    linkSibling, unlinkSibling,
    issueIdCard, cancelIdCard, reviseIdCardAmount, idCardSummary,
    issueTC, cancelTC, balancesOf,
    LIST_FIELDS,
};

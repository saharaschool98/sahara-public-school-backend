const Charge = require('../models/charge.model');
const ChargeDemand = require('../models/chargeDemand.model');
const ChargeHead = require('../models/chargeHead.model');
const Student = require('../models/student.model');
const Transaction = require('../models/transaction.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { isDuplicateKey } = require('../utils/mongoErrors');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2, allocate } = require('../utils/money');

// ---------------------------------------------------------------------------
// OTHER FEES — admission, exams twice a year, a trip, a late fee.
//
// Everything a student is charged that is not the monthly fee. The module
// mirrors fee.service deliberately: same idempotent raising, same oldest-first
// allocation, same receipt series, same reversal on a void. The person at the
// counter is doing one job, so it should not feel like two systems.
// ---------------------------------------------------------------------------

// Status is always derived from the row's own numbers, never set separately, so
// it cannot contradict them.
const statusFor = (d) => {
    const due = round2((d.amount || 0) - (d.discount || 0) - (d.paidAmount || 0));
    if (due <= 0) return 'Paid';
    return (d.paidAmount || 0) > 0 ? 'Partial' : 'Unpaid';
};

const dueOf = (d) => Math.max(0, round2((d.amount || 0) - (d.discount || 0) - (d.paidAmount || 0)));

// ---- heads ----

const listHeads = ({ includeInactive } = {}) =>
    ChargeHead.find(includeInactive === 'true' || includeInactive === true ? {} : { isActive: true })
        .sort({ nameLower: 1 })
        .lean();

const createHead = async (payload, actorId) => {
    const nameLower = payload.name.toLowerCase().trim();
    const exists = await ChargeHead.findOne({ nameLower }).lean();
    if (exists) throw new ApiError(409, 'A head with this name already exists');

    return ChargeHead.create({ ...payload, nameLower, createdBy: actorId });
};

// Renaming a head does NOT rewrite the charges already raised under it — each
// one copied `headName` at raise time, so last term's exam fee keeps the name it
// was actually raised under.
const updateHead = async (id, updates) => {
    const head = await ChargeHead.findById(id);
    if (!head) throw new ApiError(404, 'Head not found');

    if (updates.name !== undefined) {
        const nameLower = updates.name.toLowerCase().trim();
        if (nameLower !== head.nameLower) {
            const clash = await ChargeHead.findOne({ nameLower, _id: { $ne: head._id } }).lean();
            if (clash) throw new ApiError(409, 'A head with this name already exists');
        }
        head.name = updates.name;
        head.nameLower = nameLower;
    }

    if (updates.defaultAmount !== undefined) head.defaultAmount = round2(updates.defaultAmount);
    if (updates.isActive !== undefined) head.isActive = updates.isActive;

    await head.save();
    return head;
};

// ---------------------------------------------------------------------------
// RAISING A CHARGE
//
// Idempotent, on the same principle monthly fee generation uses: the unique
// index on { charge, student } physically prevents a second row, so the button
// is safe to press twice and safe to retry.
//
// It is also safe to re-run ON PURPOSE, and that is how a student admitted
// after the exam fee went out gets charged for it — top the same charge up and
// they get their row while everybody else is untouched.
// ---------------------------------------------------------------------------
const raise = async (payload, actorId) => {
    const { headId, title, amount, dueDate = null, scope, classIds = [], studentIds = [], note = '' } = payload;

    const session = await sessionService.getActiveSession();
    const value = round2(amount);

    const head = await ChargeHead.findById(headId).lean();
    if (!head) throw new ApiError(404, 'Head not found');

    // Who it lands on. Only students who are ACTIVE right now — the same bound
    // fee generation uses, and for the same reason.
    const filter = { session: session.name, status: 'Active' };

    if (scope === 'CLASS') {
        if (!classIds.length) throw new ApiError(400, 'Choose at least one class');
        filter.class = { $in: classIds };
    } else if (scope === 'STUDENT') {
        if (!studentIds.length) throw new ApiError(400, 'Choose at least one student');
        filter._id = { $in: studentIds };
    }

    const students = await Student.find(filter).select('name class className').lean();

    if (!students.length) {
        throw new ApiError(400, 'No active students match this — nothing to raise').withCode('NO_STUDENTS');
    }

    const classNames = [...new Set(students.map((s) => s.className))].sort();

    return withTransaction(async (mongoSession) => {
        const [charge] = await Charge.create(
            [
                {
                    session: session.name,
                    head: head._id,
                    headName: head.name,
                    title: title.trim(),
                    amount: value,
                    dueDate,
                    scope,
                    classes: scope === 'CLASS' ? classIds : [],
                    classNames: scope === 'CLASS' ? classNames : [],
                    studentCount: students.length,
                    totalRaised: round2(value * students.length),
                    note,
                    raisedBy: actorId,
                },
            ],
            { session: mongoSession }
        );

        await ChargeDemand.insertMany(
            students.map((s) => ({
                session: session.name,
                charge: charge._id,
                headName: head.name,
                title: title.trim(),
                student: s._id,
                studentName: s.name,
                class: s.class,
                className: s.className,
                amount: value,
                dueDate,
                status: 'Unpaid',
            })),
            { session: mongoSession, ordered: true }
        );

        // The students' balances move with the demands, or neither does. The
        // lesson fee generation learned: demands existing while nobody's balance
        // had changed was a state re-running could not repair.
        if (value > 0) {
            await Student.updateMany(
                { _id: { $in: students.map((s) => s._id) } },
                { $inc: { chargeOutstanding: value } },
                { session: mongoSession }
            );
        }

        return {
            charge,
            raisedFor: students.length,
            totalRaised: round2(value * students.length),
        };
    });
};

// Adding the students who were missing — a later admission, or a class left out.
// The unique index makes this exactly "whoever does not have a row yet".
const topUp = async (chargeId, actorId) => {
    const charge = await Charge.findById(chargeId).lean();
    if (!charge) throw new ApiError(404, 'Charge not found');
    if (charge.cancelled) throw new ApiError(409, 'This charge has been cancelled');

    const filter = { session: charge.session, status: 'Active' };
    if (charge.scope === 'CLASS') filter.class = { $in: charge.classes };
    // A STUDENT-scope charge named its people explicitly; topping it up with
    // whoever happens to be on the roster now would charge people nobody chose.
    if (charge.scope === 'STUDENT') {
        throw new ApiError(
            400,
            'This charge was raised for named students — raise a new one for anybody else'
        ).withCode('SCOPE_IS_NAMED');
    }

    const [students, existing] = await Promise.all([
        Student.find(filter).select('name class className').lean(),
        ChargeDemand.find({ charge: chargeId }).select('student').lean(),
    ]);

    const already = new Set(existing.map((d) => d.student.toString()));
    const pending = students.filter((s) => !already.has(s._id.toString()));

    if (!pending.length) {
        return { added: 0, message: 'Everybody who should have this already has it' };
    }

    try {
        return await withTransaction(async (mongoSession) => {
            await ChargeDemand.insertMany(
                pending.map((s) => ({
                    session: charge.session,
                    charge: charge._id,
                    headName: charge.headName,
                    title: charge.title,
                    student: s._id,
                    studentName: s.name,
                    class: s.class,
                    className: s.className,
                    amount: charge.amount,
                    dueDate: charge.dueDate,
                    status: 'Unpaid',
                })),
                { session: mongoSession, ordered: true }
            );

            if (charge.amount > 0) {
                await Student.updateMany(
                    { _id: { $in: pending.map((s) => s._id) } },
                    { $inc: { chargeOutstanding: charge.amount } },
                    { session: mongoSession }
                );
            }

            await Charge.updateOne(
                { _id: chargeId },
                {
                    $inc: {
                        studentCount: pending.length,
                        totalRaised: round2(charge.amount * pending.length),
                    },
                },
                { session: mongoSession }
            );

            return { added: pending.length, totalRaised: round2(charge.amount * pending.length) };
        });
    } catch (err) {
        // Somebody topped the same charge up in the gap above. Nothing committed,
        // their rows are in, and pressing again picks up anything still missing.
        if (isDuplicateKey(err)) {
            return { added: 0, message: 'This was topped up from somewhere else a moment ago — press again to pick up anything still missing' };
        }
        throw err;
    }
};

// ---------------------------------------------------------------------------
// Cancelling a whole charge — the wrong amount, the wrong classes.
//
// Refused once any money has come in against it. Those receipts would be left
// pointing at a charge that no longer exists, and unpicking that is a decision
// for a person: void the receipts first, one at a time, then cancel.
// ---------------------------------------------------------------------------
const cancel = async (chargeId, reason, actorId) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to cancel this');

    const charge = await Charge.findById(chargeId).lean();
    if (!charge) throw new ApiError(404, 'Charge not found');
    if (charge.cancelled) throw new ApiError(409, 'This charge has already been cancelled');

    if (round2(charge.totalCollected) > 0) {
        throw new ApiError(
            409,
            `₹${charge.totalCollected} has already been collected against this — void those receipts first`
        ).withCode('ALREADY_COLLECTED');
    }

    return withTransaction(async (mongoSession) => {
        const demands = await ChargeDemand.find({ charge: chargeId })
            .select('student amount discount paidAmount')
            .session(mongoSession)
            .lean();

        // Each student's balance comes down by whatever they still owed on it —
        // not by the charge amount, because a waiver may already have reduced it.
        const ops = demands
            .map((d) => ({ student: d.student, due: dueOf(d) }))
            .filter((x) => x.due > 0)
            .map((x) => ({
                updateOne: {
                    filter: { _id: x.student },
                    update: { $inc: { chargeOutstanding: -x.due } },
                },
            }));

        if (ops.length) await Student.bulkWrite(ops, { session: mongoSession, ordered: false });

        await ChargeDemand.deleteMany({ charge: chargeId }, { session: mongoSession });

        await Charge.updateOne(
            { _id: chargeId },
            {
                $set: {
                    cancelled: true,
                    cancelledAt: new Date(),
                    cancelledBy: actorId,
                    cancelReason: reason.trim(),
                    studentCount: 0,
                    totalRaised: 0,
                },
            },
            { session: mongoSession }
        );

        return { cancelled: chargeId, withdrawn: demands.length, title: charge.title };
    });
};

// ---- reading ----

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session };
    if (query.head) filter.head = query.head;
    if (query.status === 'open') filter.cancelled = false;

    return fetchPage(
        Charge.find(filter).sort({ createdAt: -1 }),
        { page, limit, withTotal: true }
    );
};

const getById = async (id) => {
    const charge = await Charge.findById(id).lean();
    if (!charge) throw new ApiError(404, 'Charge not found');
    return charge;
};

// One charge's roll: who owes, who has paid.
const demandsFor = async (chargeId, query = {}) => {
    const { page, limit } = getPaginationParams(query);

    const filter = { charge: chargeId };
    if (query.status) filter.status = query.status;

    return fetchPage(
        ChargeDemand.find(filter)
            .select('studentName className amount discount paidAmount status student dueDate')
            .sort({ studentName: 1 }),
        { page, limit, withTotal: true }
    );
};

// A student's unpaid charges, oldest first — the shape the collect panel wants.
const pendingForStudent = (studentId) =>
    ChargeDemand.find({ student: studentId, status: { $ne: 'Paid' } })
        .select('headName title amount discount paidAmount status dueDate createdAt')
        .sort({ createdAt: 1 })
        .lean();

// ---------------------------------------------------------------------------
// COLLECTING
//
// Line for line the same shape as fee.service.collect: read inside the
// transaction, allocate oldest first, one receipt off the same series, one
// ledger row. The counter keeps ONE receipt book, so a charge receipt and a fee
// receipt must never share a number and must not behave differently.
// ---------------------------------------------------------------------------
const collect = async ({ studentId, amount, mode, txnDate, note = '' }, actor) => {
    const session = await sessionService.getActiveSessionName();
    const value = round2(amount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    return withTransaction(async (mongoSession) => {
        // Read INSIDE the transaction — the "not more than owed" check has to be
        // made against the rows this write is about to change.
        const demands = await ChargeDemand.find({ student: studentId, status: { $ne: 'Paid' } })
            .sort({ createdAt: 1 })
            .session(mongoSession)
            .lean();

        const totalDue = round2(demands.reduce((sum, d) => sum + dueOf(d), 0));

        if (totalDue <= 0) throw new ApiError(400, 'This student has no other fees outstanding');
        if (value > totalDue) {
            throw new ApiError(400, `Only ₹${totalDue} is outstanding — you cannot collect more than that`);
        }

        const splits = allocate(value, demands.map(dueOf));

        const seq = await getNextSequence('receiptNo', session, mongoSession);
        const receiptNo = formatCode('RCP', seq, 5);

        const demandOps = [];
        const chargeOps = [];
        const covered = [];

        demands.forEach((d, i) => {
            const take = splits[i];
            if (take <= 0) return;

            const next = { ...d, paidAmount: round2((d.paidAmount || 0) + take) };

            demandOps.push({
                updateOne: {
                    filter: { _id: d._id },
                    update: { $inc: { paidAmount: take }, $set: { status: statusFor(next) } },
                },
            });

            // The parent's running total, so the list screen never counts demands.
            chargeOps.push({
                updateOne: { filter: { _id: d.charge }, update: { $inc: { totalCollected: take } } },
            });

            covered.push({
                demand: d._id,
                title: `${d.headName} · ${d.title}`,
                amount: take,
            });
        });

        await ChargeDemand.bulkWrite(demandOps, { session: mongoSession, ordered: true });
        await Charge.bulkWrite(chargeOps, { session: mongoSession, ordered: false });

        await Student.updateOne(
            { _id: studentId },
            { $inc: { chargeOutstanding: -value } },
            { session: mongoSession }
        );

        const txn = await ledger.record(
            {
                session,
                direction: 'IN',
                type: 'CHARGE',
                amount: value,
                mode,
                txnDate: txnDate || new Date(),
                party: { kind: 'Student', ref: student._id, name: student.name },
                classId: student.class,
                className: student.className,
                refModel: 'ChargeDemand',
                refId: covered[0]?.demand || null,
                receiptNo,
                // What this receipt paid, so a void reverses exactly these.
                coveredCharges: covered,
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
            balanceAfter: round2(totalDue - value),
        };
    });
};

// ---------------------------------------------------------------------------
// Waiving one — a staff child's exam fee, a trip a family cannot afford.
//
// Tracked as a discount rather than quietly lowering the amount, so "what did
// we waive this year" stays a number the Principal can see.
// ---------------------------------------------------------------------------
const applyDiscount = async (demandId, { amount, reason }, actor) => {
    const value = round2(amount);
    if (!(value > 0)) throw new ApiError(400, 'Discount must be greater than zero');
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required for the discount');

    return withTransaction(async (mongoSession) => {
        const demand = await ChargeDemand.findById(demandId).session(mongoSession).lean();
        if (!demand) throw new ApiError(404, 'Charge not found for this student');

        const due = dueOf(demand);
        if (value > due) {
            throw new ApiError(400, `Only ₹${due} is outstanding — the discount cannot exceed that`);
        }

        const next = { ...demand, discount: round2((demand.discount || 0) + value) };
        const trimmed = reason.trim();
        // The amount accumulates, so the reason must too.
        const nextReason = demand.discountReason
            ? `${demand.discountReason} · ${trimmed}`.slice(0, 500)
            : trimmed;

        await ChargeDemand.updateOne(
            { _id: demandId },
            {
                $inc: { discount: value },
                $set: { status: statusFor(next), discountReason: nextReason, discountBy: actor.id },
            },
            { session: mongoSession }
        );

        await Student.updateOne(
            { _id: demand.student },
            { $inc: { chargeOutstanding: -value } },
            { session: mongoSession }
        );

        await Charge.updateOne(
            { _id: demand.charge },
            { $inc: { totalDiscount: value } },
            { session: mongoSession }
        );

        // No cash moved, so no Transaction row — the same rule a fee discount
        // follows.
        return { demandId, discount: value, reason: trimmed };
    });
};

// ---------------------------------------------------------------------------
// Changing the AMOUNT on an other-fee receipt nobody has checked off yet.
//
// The same shape as fee.service.reviseReceipt, and for the same reason: take
// the whole receipt back off the charges it paid, then spread the new figure
// over what the student owes, oldest charge first. The result is the books as
// they would read if the right amount had been collected at the counter.
//
// The caller owns the session and the ledger row — see payment.service.update.
// ---------------------------------------------------------------------------
const reviseReceipt = async (txn, newAmount, mongoSession) => {
    const value = round2(newAmount);
    const lines = txn.coveredCharges || [];

    if (!lines.length) {
        throw new ApiError(
            409,
            'This receipt does not record which charges it paid — void it and collect again instead'
        ).withCode('NO_ALLOCATION');
    }

    const demands = await ChargeDemand.find({ student: txn.party.ref })
        .sort({ createdAt: 1 })
        .session(mongoSession)
        .lean();

    const applied = new Map();
    for (const line of lines) {
        const key = String(line.demand);
        applied.set(key, round2((applied.get(key) || 0) + line.amount));
    }

    let givenBack = 0;
    const post = demands.map((d) => {
        const back = round2(Math.min(applied.get(String(d._id)) || 0, d.paidAmount || 0));
        givenBack = round2(givenBack + back);
        return { ...d, back, paidAmount: round2((d.paidAmount || 0) - back) };
    });

    // A charge was cancelled out from under this receipt. See fee.service for
    // why that is a void rather than an edit.
    if (givenBack !== round2(txn.amount)) {
        throw new ApiError(
            409,
            'The charges this receipt paid have changed since — void it and collect again instead'
        ).withCode('NO_ALLOCATION');
    }

    const totalDue = round2(post.reduce((sum, d) => sum + dueOf(d), 0));
    if (totalDue <= 0) throw new ApiError(400, 'This student has no other fees outstanding');
    if (value > totalDue) {
        throw new ApiError(
            400,
            `₹${totalDue} is all this student owes on other fees — a receipt cannot be raised past that`
        );
    }

    const splits = allocate(value, post.map(dueOf));

    const demandOps = [];
    const chargeOps = [];
    const covered = [];

    post.forEach((d, i) => {
        const take = splits[i];
        if (take > 0) covered.push({ demand: d._id, title: `${d.headName} · ${d.title}`, amount: take });

        const net = round2(take - d.back);
        if (net === 0) return;

        const next = { ...d, paidAmount: round2(d.paidAmount + take) };

        demandOps.push({
            updateOne: {
                filter: { _id: d._id },
                update: { $inc: { paidAmount: net }, $set: { status: statusFor(next) } },
            },
        });
        // The parent charge's running total moves by the same difference, so
        // the list screen never has to count demands.
        chargeOps.push({
            updateOne: { filter: { _id: d.charge }, update: { $inc: { totalCollected: net } } },
        });
    });

    if (demandOps.length) await ChargeDemand.bulkWrite(demandOps, { session: mongoSession, ordered: true });
    if (chargeOps.length) await Charge.bulkWrite(chargeOps, { session: mongoSession, ordered: false });

    await Student.updateOne(
        { _id: txn.party.ref },
        { $inc: { chargeOutstanding: round2(txn.amount - value) } },
        { session: mongoSession }
    );

    return { set: { coveredCharges: covered, refId: covered[0]?.demand || null } };
};

// ---------------------------------------------------------------------------
// Voiding a charge receipt.
//
// The exact inverse of the collection that wrote it, because the receipt
// recorded its own allocation. The original is never deleted — it is marked
// void and an opposing entry is written, like every other correction here.
// ---------------------------------------------------------------------------
const voidReceipt = async (transactionId, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to void this');

    const txn = await Transaction.findById(transactionId).lean();
    if (!txn) throw new ApiError(404, 'Receipt not found');
    if (txn.type !== 'CHARGE') throw new ApiError(400, 'This is not an other-fee receipt');
    if (txn.voided) throw new ApiError(409, 'This receipt has already been voided');
    // Checked off against the cash box already — see transaction.model.js.
    ledger.assertUnsealed(txn);

    return withTransaction(async (mongoSession) => {
        const lines = txn.coveredCharges || [];

        const demands = await ChargeDemand.find({ _id: { $in: lines.map((l) => l.demand) } })
            .session(mongoSession)
            .lean();
        const byId = new Map(demands.map((d) => [String(d._id), d]));

        const demandOps = [];
        const chargeOps = [];
        let reversed = 0;

        for (const line of lines) {
            const demand = byId.get(String(line.demand));
            // The charge was cancelled out from under this receipt. The shortfall
            // still goes back on the student's balance below, so the two agree.
            if (!demand) continue;

            // Clamped: a demand cannot give back more than it currently holds.
            const take = round2(Math.min(line.amount, demand.paidAmount || 0));
            if (take <= 0) continue;

            reversed = round2(reversed + take);
            const next = { ...demand, paidAmount: round2((demand.paidAmount || 0) - take) };

            demandOps.push({
                updateOne: {
                    filter: { _id: demand._id },
                    update: { $inc: { paidAmount: -take }, $set: { status: statusFor(next) } },
                },
            });
            chargeOps.push({
                updateOne: { filter: { _id: demand.charge }, update: { $inc: { totalCollected: -take } } },
            });
        }

        if (demandOps.length) await ChargeDemand.bulkWrite(demandOps, { session: mongoSession, ordered: true });
        if (chargeOps.length) await Charge.bulkWrite(chargeOps, { session: mongoSession, ordered: false });

        // The full receipt goes back on the student, whatever the demands could
        // absorb — otherwise their balance and the sum of their dues disagree,
        // and that IS drift recomputeBalances would report.
        await Student.updateOne(
            { _id: txn.party.ref },
            { $inc: { chargeOutstanding: txn.amount } },
            { session: mongoSession }
        );

        const reversal = await ledger.reverse(
            { original: txn, reason: reason.trim(), actorId: actor.id },
            mongoSession
        );

        return { voided: txn._id, reversalId: reversal._id, amount: txn.amount, reversed };
    });
};

module.exports = {
    listHeads,
    createHead,
    updateHead,
    raise,
    topUp,
    cancel,
    list,
    getById,
    demandsFor,
    pendingForStudent,
    collect,
    applyDiscount,
    reviseReceipt,
    voidReceipt,
    statusFor,
    dueOf,
};

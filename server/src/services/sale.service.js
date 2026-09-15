const StockSale = require('../models/stockSale.model');
const StockItem = require('../models/stockItem.model');
const Transaction = require('../models/transaction.model');
const StockMovement = require('../models/stockMovement.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const stockService = require('./stock.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2, allocate } = require('../utils/money');
const { startOfDayIST, endOfDayIST } = require('../utils/istDate');

// ---------------------------------------------------------------------------
// Selling uniform / books.
//
// The key decision here is `paidAmount`. Whatever was paid goes into the
// cash ledger; whatever was not goes onto the student's stockOutstanding
// and is collected along with the fees. One screen therefore handles both
// a cash sale and a credit sale.
// ---------------------------------------------------------------------------
const create = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const { studentId = null, lines, discount = 0, paidAmount = 0, mode, date, note = '' } = payload;

    if (!lines?.length) throw new ApiError(400, 'At least one item is required');

    // All items in one query — not N queries for N lines
    const itemIds = [...new Set(lines.map((l) => l.item))];
    const items = await StockItem.find({ _id: { $in: itemIds } }).lean();
    const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

    let student = null;
    if (studentId) {
        student = await Student.findById(studentId).select('name class className').lean();
        if (!student) throw new ApiError(404, 'Student not found');
    }

    // Validate every line AND price it — all of it before any write begins.
    // Nothing is worse than a half-completed sale.
    //
    // The stock CHECK is deliberately not here. It is re-made inside the
    // transaction below against the count at that moment, because this read is
    // already stale by the time the write runs: two counters selling the last
    // shirt both passed this check and the shelf went to -1. What this loop is
    // for is resolving the rate and the labels, which do not move.
    const resolved = [];
    for (const line of lines) {
        const item = itemMap.get(line.item.toString());
        if (!item) throw new ApiError(404, 'Item not found');

        const target = stockService.resolveStockTarget(item, line.variantId);

        if (line.qty > target.currentStock) {
            throw new ApiError(
                400,
                `${item.name}${target.variantLabel ? ` (${target.variantLabel})` : ''} has only ${target.currentStock} in stock`
            );
        }

        const rate = line.rate ?? target.sellPrice;
        resolved.push({
            item: item._id,
            itemName: item.name,
            variantId: line.variantId || null,
            variantLabel: target.variantLabel,
            qty: line.qty,
            rate: round2(rate),
            amount: round2(rate * line.qty),
        });
    }

    const subtotal = round2(resolved.reduce((s, l) => s + l.amount, 0));
    const total = round2(subtotal - discount);

    if (total < 0) throw new ApiError(400, 'Discount cannot exceed the total');
    if (paidAmount > total) throw new ApiError(400, 'Paid amount cannot exceed the total');

    const dueAmount = round2(total - paidAmount);

    if (dueAmount > 0 && !studentId) {
        // There is no way to carry credit for a walk-in — who would we chase?
        throw new ApiError(400, 'A walk-in sale must be paid in full');
    }

    return withTransaction(async (mongoSession) => {
        const seq = await getNextSequence('billNo', session, mongoSession);
        const billNo = formatCode('SAL', seq, 5);
        const saleDate = date || new Date();

        const [sale] = await StockSale.create(
            [
                {
                    session,
                    billNo,
                    student: studentId,
                    studentName: student?.name || 'Walk-in',
                    class: student?.class || null,
                    className: student?.className || '',
                    lines: resolved,
                    subtotal,
                    discount: round2(discount),
                    total,
                    paidAmount: round2(paidAmount),
                    dueAmount,
                    mode: dueAmount > 0 && paidAmount === 0 ? 'Credit' : mode,
                    date: saleDate,
                    note,
                    by: actorId,
                },
            ],
            { session: mongoSession }
        );

        // Reduce stock and write a movement for each line. The count is checked
        // HERE, inside the transaction, against the item as it stands right now —
        // a concurrent sale of the same size raises a write conflict, which
        // withTransaction retries, and the retry sees the other sale's effect.
        const movements = [];

        for (const line of resolved) {
            const fresh = await StockItem.findById(line.item).session(mongoSession).lean();
            const target = stockService.resolveStockTarget(fresh, line.variantId);

            if (line.qty > target.currentStock) {
                throw new ApiError(
                    400,
                    `${line.itemName}${line.variantLabel ? ` (${line.variantLabel})` : ''} has only ${target.currentStock} in stock`
                );
            }

            await stockService.applyStockDelta(
                { itemId: line.item, variantId: line.variantId, delta: -line.qty },
                mongoSession
            );

            movements.push({
                session,
                item: line.item,
                itemName: line.itemName,
                variantId: line.variantId,
                variantLabel: line.variantLabel,
                type: 'SALE_OUT',
                qty: -line.qty,
                rate: line.rate,
                balanceAfter: target.currentStock - line.qty,
                refModel: 'StockSale',
                refId: sale._id,
                date: saleDate,
                by: actorId,
            });
        }

        await StockMovement.insertMany(movements, { session: mongoSession });

        // Only what was paid enters the cash ledger. The credit portion writes
        // no transaction yet — that comes when the money does.
        if (paidAmount > 0) {
            await ledger.record(
                {
                    session,
                    direction: 'IN',
                    type: 'STOCK_SALE',
                    amount: round2(paidAmount),
                    mode,
                    txnDate: saleDate,
                    party: {
                        kind: 'Student',
                        ref: studentId,
                        name: student?.name || 'Walk-in',
                    },
                    classId: student?.class || null,
                    className: student?.className || '',
                    refModel: 'StockSale',
                    refId: sale._id,
                    note: `Bill ${billNo}`,
                    recordedBy: actorId,
                },
                mongoSession
            );
        }

        if (dueAmount > 0 && studentId) {
            await Student.updateOne(
                { _id: studentId },
                { $inc: { stockOutstanding: dueAmount } },
                { session: mongoSession }
            );
        }

        return sale;
    });
};

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session, voided: false };
    if (query.student) filter.student = query.student;
    if (query.date) {
        filter.date = { $gte: startOfDayIST(query.date), $lte: endOfDayIST(query.date) };
    } else if (query.from || query.to) {
        filter.date = {};
        if (query.from) filter.date.$gte = startOfDayIST(query.from);
        if (query.to) filter.date.$lte = endOfDayIST(query.to);
    }

    return fetchPage(
        StockSale.find(filter)
            .select('billNo studentName className total paidAmount dueAmount mode date lines')
            .sort({ date: -1 }),
        { page, limit, withTotal: true }
    );
};

const getById = async (id) => {
    const sale = await StockSale.findById(id).lean();
    if (!sale) throw new ApiError(404, 'Bill not found');
    return sale;
};

// ---------------------------------------------------------------------------
// Changing what was PAID at the counter on a bill nobody has checked off yet.
//
// Not the bill — the items, the rates and the total are untouched. Only the
// split between what was handed over and what the student still owes, which is
// the figure the payment screen is looking at.
//
// The caller owns the session and the ledger row — see payment.service.update.
// ---------------------------------------------------------------------------
const revisePayment = async (txn, newAmount, mongoSession) => {
    const value = round2(newAmount);

    const sale = await StockSale.findById(txn.refId).session(mongoSession).lean();
    if (!sale) throw new ApiError(404, 'The bill behind this payment no longer exists');
    if (sale.voided) throw new ApiError(409, 'This bill has been voided');

    // Money has come in against the credit half since. Moving the counter
    // payment now would leave that receipt sitting against a balance that no
    // longer adds up, and which of the two is wrong is a decision for a person.
    if ((sale.duesReceived || 0) > 0) {
        throw new ApiError(
            409,
            `₹${sale.duesReceived} has since been received against this bill — settle that receipt first`
        );
    }

    if (value > sale.total) {
        throw new ApiError(400, `The bill is ₹${sale.total} — the payment cannot be more than that`);
    }

    // The same rule create() enforces, for the same reason: there is nobody to
    // chase a walk-in for the rest.
    if (!sale.student && value < sale.total) {
        throw new ApiError(400, 'A walk-in sale must be paid in full');
    }

    const delta = round2(value - txn.amount);

    // Whatever was not handed over is what the student owes. Both halves move
    // together, so the bill always reads paid + due = total.
    await StockSale.updateOne(
        { _id: sale._id },
        { $inc: { paidAmount: delta, dueAmount: -delta } },
        { session: mongoSession }
    );

    if (sale.student) {
        await Student.updateOne(
            { _id: sale.student },
            { $inc: { stockOutstanding: -delta } },
            { session: mongoSession }
        );
    }

    return {};
};

// ---------------------------------------------------------------------------
// Voiding a sale — stock back, outstanding back, and the cash portion
// reversed in the ledger.
// ---------------------------------------------------------------------------
const voidSale = async (id, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to void this');

    const sale = await StockSale.findById(id).lean();
    if (!sale) throw new ApiError(404, 'Bill not found');
    if (sale.voided) throw new ApiError(409, 'This bill has already been voided');

    // Money has come in against this bill since it was raised. Voiding it now
    // would silently strand that receipt — the cash was counted, the ledger
    // says so, and no reversal covers it. The office has to deal with the
    // receipt first, which is a decision for a person, not for this function.
    if ((sale.duesReceived || 0) > 0) {
        throw new ApiError(
            409,
            `₹${sale.duesReceived} has already been received against this bill — it cannot be voided`
        );
    }

    // Read before any work starts, so a bill whose receipt has been signed off
    // is refused here rather than after the stock has gone back on the shelf.
    // The flag only; the row itself is re-read inside the transaction below.
    // Nothing found means the bill was pure credit — there is no seal to check.
    const signedOff = await Transaction.findOne({
        refModel: 'StockSale',
        refId: sale._id,
        receiptNo: null,
        voided: false,
    })
        .select('verified')
        .sort({ createdAt: 1 })
        .lean();

    ledger.assertUnsealed(signedOff);

    return withTransaction(async (mongoSession) => {
        await StockSale.updateOne(
            { _id: id, voided: false },
            { $set: { voided: true, voidedAt: new Date(), voidReason: reason.trim() } },
            { session: mongoSession }
        );

        // Stock goes back in. The balance AFTER each return is read back from
        // the item, not guessed — the movement history's most-read column was
        // being written as 0 on every void, so a voided sale looked like it had
        // emptied the shelf.
        const movements = [];

        for (const line of sale.lines) {
            await stockService.applyStockDelta(
                { itemId: line.item, variantId: line.variantId, delta: line.qty },
                mongoSession
            );

            const item = await StockItem.findById(line.item).session(mongoSession).lean();
            const target = stockService.resolveStockTarget(item, line.variantId);

            movements.push({
                session: sale.session,
                item: line.item,
                itemName: line.itemName,
                variantId: line.variantId,
                variantLabel: line.variantLabel,
                type: 'RETURN_IN',
                qty: line.qty,
                rate: line.rate,
                balanceAfter: target.currentStock,
                refModel: 'StockSale',
                refId: sale._id,
                note: `Void: ${reason.trim()}`,
                date: new Date(),
                by: actor.id,
            });
        }

        await StockMovement.insertMany(movements, { session: mongoSession });

        if (sale.dueAmount > 0 && sale.student) {
            await Student.updateOne(
                { _id: sale.student },
                { $inc: { stockOutstanding: -sale.dueAmount } },
                { session: mongoSession }
            );
        }

        // A dues receipt also carries refModel 'StockSale' and this same refId,
        // so the filter has to be narrower than "anything pointing at this
        // bill" — only the sale itself is written without a receipt number.
        const txn = await Transaction.findOne({
            refModel: 'StockSale',
            refId: sale._id,
            receiptNo: null,
            voided: false,
        })
            .sort({ createdAt: 1 })
            .lean();

        if (txn) {
            await ledger.reverse(
                { original: txn, reason: reason.trim(), actorId: actor.id },
                mongoSession
            );
        }

        return { voided: sale._id };
    });
};

// ---------------------------------------------------------------------------
// Stock dues — the other half of a credit sale.
//
// Selling on credit puts money on the student's head (Student.stockOutstanding).
// Until this existed that balance could only ever be CREATED — a uniform sold
// on credit stayed outstanding forever, because nothing but a void could
// bring it back down. This is the receiving side.
//
// It deliberately mirrors fee.service.collect() line for line: same oldest-
// first allocation, same receipt series, same single transaction. The office
// counter does one thing, so it should work one way.
// ---------------------------------------------------------------------------

// The unpaid bills behind a student's stock balance, oldest first.
const unpaidBills = (studentId) =>
    StockSale.find({ student: studentId, voided: false, dueAmount: { $gt: 0 } })
        .sort({ date: 1 })
        .lean();

const duesForStudent = async (studentId) => {
    const student = await Student.findById(studentId)
        .select('name admissionNo className stockOutstanding')
        .lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const bills = await unpaidBills(studentId);

    return {
        student: {
            id: student._id,
            name: student.name,
            admissionNo: student.admissionNo,
            className: student.className,
        },
        totalDue: round2(bills.reduce((acc, b) => acc + (b.dueAmount || 0), 0)),
        bills: bills.map((b) => ({
            id: b._id,
            billNo: b.billNo,
            date: b.date,
            total: b.total,
            paidAmount: b.paidAmount,
            dueAmount: b.dueAmount,
            items: b.lines
                .map((l) => `${l.itemName}${l.variantLabel ? ` (${l.variantLabel})` : ''} x ${l.qty}`)
                .join(', '),
        })),
    };
};

const collectDues = async ({ studentId, amount, mode, txnDate, note = '' }, actor) => {
    const session = await sessionService.getActiveSessionName();
    const value = round2(amount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    return withTransaction(async (mongoSession) => {
        // The bills are read INSIDE the transaction and the allocation is built
        // from what is read here — the same rule fee.service.collect follows, for
        // the same reason. Reading first and writing afterwards let two counters
        // allocate the same dueAmount twice and drive the balance negative.
        const bills = await StockSale.find({ student: studentId, voided: false, dueAmount: { $gt: 0 } })
            .sort({ date: 1 })
            .session(mongoSession)
            .lean();

        const totalDue = round2(bills.reduce((acc, b) => acc + (b.dueAmount || 0), 0));

        if (totalDue <= 0) throw new ApiError(400, 'This student has no stock dues outstanding');

        // Never take more than is owed — an extra zero would leave a negative
        // balance, and those only ever get fixed by hand afterwards.
        if (value > totalDue) {
            throw new ApiError(
                400,
                `Only ₹${totalDue} is outstanding — you cannot collect more than that`
            );
        }

        const splits = allocate(value, bills.map((b) => b.dueAmount || 0));

        // The same receipt series as fees on purpose: the counter keeps one
        // receipt book, so two receipts must never share a number.
        const seq = await getNextSequence('receiptNo', session, mongoSession);
        const receiptNo = formatCode('RCP', seq, 5);

        const ops = [];
        const covered = [];

        bills.forEach((b, i) => {
            const take = splits[i];
            if (take <= 0) return;

            ops.push({
                updateOne: {
                    filter: { _id: b._id },
                    update: { $inc: { paidAmount: take, dueAmount: -take, duesReceived: take } },
                },
            });
            covered.push({ billNo: b.billNo, amount: take });
        });

        await StockSale.bulkWrite(ops, { session: mongoSession, ordered: true });

        // The field the student card, the outstanding report and the
        // defaulters list all read directly.
        await Student.updateOne(
            { _id: studentId },
            { $inc: { stockOutstanding: -value } },
            { session: mongoSession }
        );

        const txn = await ledger.record(
            {
                session,
                direction: 'IN',
                type: 'STOCK_SALE',
                amount: value,
                mode,
                txnDate: txnDate || new Date(),
                party: { kind: 'Student', ref: student._id, name: student.name },
                classId: student.class,
                className: student.className,
                refModel: 'StockSale',
                refId: bills[0]?._id || null,
                receiptNo,
                note: note || `Stock dues: ${covered.map((c) => c.billNo).join(', ')}`,
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

module.exports = { create, list, getById, revisePayment, voidSale, duesForStudent, collectDues };


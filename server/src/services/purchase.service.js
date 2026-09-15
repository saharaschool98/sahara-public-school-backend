const Purchase = require('../models/purchase.model');
const Vendor = require('../models/vendor.model');
const VendorPayment = require('../models/vendorPayment.model');
const StockItem = require('../models/stockItem.model');
const StockMovement = require('../models/stockMovement.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const stockService = require('./stock.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2 } = require('../utils/money');
const { monthKeyIST, startOfDayIST, endOfDayIST } = require('../utils/istDate');
const { assertOwnedPublicId } = require('../config/cloudinary');

// ---------------------------------------------------------------------------
// A vendor's bill — brings stock in and creates the outstanding.
//
// Important: a credit purchase writes NO Transaction row. No cash has
// moved yet. The ledger row appears when the vendor is actually paid
// (vendor.service.pay). A bill and a payment are separate events, and the
// app never assumes one implies the other.
// ---------------------------------------------------------------------------
const create = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const {
        vendorId,
        billNo,
        billDate,
        lines,
        tax = 0,
        otherCharges = 0,
        paidAmount = 0,
        mode = 'Cash',
        billImage = null,
        note = '',
    } = payload;

    if (!lines?.length) throw new ApiError(400, 'At least one item is required');

    const vendor = await Vendor.findById(vendorId).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // This check only exists to give a good message ahead of the DB's unique
    // index — the index is the real guarantee (concurrent double-submit).
    const dupe = await Purchase.findOne({ vendor: vendorId, billNo }).lean();
    if (dupe) {
        throw new ApiError(409, `Bill ${billNo} has already been entered for this vendor`).withCode('DUPLICATE_BILL');
    }

    if (billImage?.publicId) assertOwnedPublicId(billImage.publicId);

    const itemIds = [...new Set(lines.map((l) => l.item))];
    const items = await StockItem.find({ _id: { $in: itemIds } }).lean();
    const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

    const resolved = lines.map((line) => {
        const item = itemMap.get(line.item.toString());
        if (!item) throw new ApiError(404, 'Item not found');

        const target = stockService.resolveStockTarget(item, line.variantId);

        return {
            item: item._id,
            itemName: item.name,
            variantId: line.variantId || null,
            variantLabel: target.variantLabel,
            qty: line.qty,
            rate: round2(line.rate),
            amount: round2(line.rate * line.qty),
        };
    });

    const subtotal = round2(resolved.reduce((s, l) => s + l.amount, 0));
    const total = round2(subtotal + tax + otherCharges);

    if (paidAmount > total) throw new ApiError(400, 'Paid amount cannot exceed the bill total');

    const dueAmount = round2(total - paidAmount);

    return withTransaction(async (mongoSession) => {
        const date = billDate || new Date();

        const [purchase] = await Purchase.create(
            [
                {
                    session,
                    vendor: vendorId,
                    vendorName: vendor.name,
                    billNo,
                    billDate: date,
                    lines: resolved,
                    subtotal,
                    tax: round2(tax),
                    otherCharges: round2(otherCharges),
                    total,
                    paidAmount: round2(paidAmount),
                    dueAmount,
                    status: dueAmount <= 0 ? 'Paid' : paidAmount > 0 ? 'Partial' : 'Unpaid',
                    billImage: billImage || undefined,
                    note,
                    by: actorId,
                },
            ],
            { session: mongoSession }
        );

        // Stock in. balanceAfter is read back from the item after the $inc rather
        // than computed from the count read before the transaction — with two
        // bills for the same item entered together, the pre-read figure was
        // simply wrong on whichever one committed second.
        const movements = [];

        for (const line of resolved) {
            await stockService.applyStockDelta(
                { itemId: line.item, variantId: line.variantId, delta: line.qty },
                mongoSession
            );

            const fresh = await StockItem.findById(line.item).session(mongoSession).lean();
            const target = stockService.resolveStockTarget(fresh, line.variantId);

            movements.push({
                session,
                item: line.item,
                itemName: line.itemName,
                variantId: line.variantId,
                variantLabel: line.variantLabel,
                type: 'PURCHASE_IN',
                qty: line.qty,
                rate: line.rate,
                balanceAfter: target.currentStock,
                refModel: 'Purchase',
                refId: purchase._id,
                date,
                by: actorId,
            });
        }

        await StockMovement.insertMany(movements, { session: mongoSession });

        // The vendor's balance: add the full bill to outstanding, then subtract
        // whatever was paid now. Two steps so totalPurchased always shows the
        // full bill — which is what matches the vendor's own ledger.
        await Vendor.updateOne(
            { _id: vendorId },
            {
                $inc: {
                    outstanding: dueAmount,
                    totalPurchased: total,
                    totalPaid: round2(paidAmount),
                },
            },
            { session: mongoSession }
        );

        // A bill's value is not cash — it goes into its own rollup head
        await ledger.bumpRollup(
            { session, month: monthKeyIST(date), fields: { purchases: total } },
            mongoSession
        );

        // ---------------------------------------------------------------------
        // Money handed over when the bill was entered.
        //
        // This used to write ONLY the ledger row. The vendor statement is built
        // from Purchase rows plus VendorPayment rows, so a bill entered at
        // ₹10,000 with ₹4,000 paid showed a closing balance of ₹10,000 while
        // Vendor.outstanding correctly said ₹6,000 — two screens of the same
        // module disagreeing, on the same page.
        //
        // A payment made at entry is a payment. It gets a VendorPayment row
        // allocated against this bill, exactly like one made from the Pay
        // dialog, and the ledger row points at it the same way.
        // ---------------------------------------------------------------------
        if (paidAmount > 0) {
            const paid = round2(paidAmount);

            const [payment] = await VendorPayment.create(
                [
                    {
                        session,
                        vendor: vendorId,
                        vendorName: vendor.name,
                        amount: paid,
                        mode,
                        refNo: '',
                        date,
                        // Allocated to the bill it was paid against — which is the
                        // whole reason allocations are not optional.
                        allocations: [{ purchase: purchase._id, billNo, amount: paid }],
                        note: `Paid when bill ${billNo} was entered`,
                        by: actorId,
                    },
                ],
                { session: mongoSession }
            );

            await ledger.record(
                {
                    session,
                    direction: 'OUT',
                    type: 'VENDOR_PAY',
                    amount: paid,
                    mode,
                    txnDate: date,
                    party: { kind: 'Vendor', ref: vendorId, name: vendor.name },
                    // Points at the payment, not the bill — the same shape
                    // vendor.service.pay writes, so a void or a statement never has
                    // to tell two kinds of vendor payment apart.
                    refModel: 'VendorPayment',
                    refId: payment._id,
                    note: `Bill ${billNo} — paid on entry`,
                    recordedBy: actorId,
                },
                mongoSession
            );
        }

        return purchase;
    });
};

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session };
    if (query.vendor) filter.vendor = query.vendor;
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
        filter.billDate = {};
        if (query.from) filter.billDate.$gte = startOfDayIST(query.from);
        if (query.to) filter.billDate.$lte = endOfDayIST(query.to);
    }

    return fetchPage(
        Purchase.find(filter)
            .select('billNo vendorName vendor billDate total paidAmount dueAmount status billImage')
            .sort({ billDate: -1 }),
        { page, limit, withTotal: true }
    );
};

const getById = async (id) => {
    const doc = await Purchase.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Bill not found');
    return doc;
};

// Metadata only — not the lines or amounts. Changing a bill's quantity
// would mean rewriting stock movements, which makes the audit trail lie.
// For a wrong bill, a correction entry is the right path.
//
// The DATE is editable, and that one is not free: a bill's value sits under the
// `purchases` head of its month's rollup. Moving the date from July to August
// used to leave the value in July, so both months were wrong and nothing on any
// screen said so. So a date change moves the value too, in the same transaction.
const update = async (id, updates) => {
    const purchase = await Purchase.findById(id);
    if (!purchase) throw new ApiError(404, 'Bill not found');

    const allowed = ['note', 'billImage', 'billDate'];
    for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
            throw new ApiError(
                400,
                "A bill's items and amounts are not editable — enter a correction bill instead"
            );
        }
    }

    if (updates.billImage?.publicId) assertOwnedPublicId(updates.billImage.publicId);

    const fromMonth = monthKeyIST(purchase.billDate);
    const toMonth = updates.billDate ? monthKeyIST(updates.billDate) : fromMonth;
    const monthChanged = toMonth !== fromMonth;
    const value = round2(purchase.total);

    if (!monthChanged) {
        Object.assign(purchase, updates);
        await purchase.save();
        return purchase;
    }

    return withTransaction(async (mongoSession) => {
        Object.assign(purchase, updates);
        await purchase.save({ session: mongoSession });

        // Out of the old month, into the new one. Both are plain $incs on the
        // same head, so the pair always nets to zero across the session.
        await ledger.bumpRollup(
            { session: purchase.session, month: fromMonth, fields: { purchases: -value } },
            mongoSession
        );
        await ledger.bumpRollup(
            { session: purchase.session, month: toMonth, fields: { purchases: value } },
            mongoSession
        );

        return purchase;
    });
};

module.exports = { create, list, getById, update };

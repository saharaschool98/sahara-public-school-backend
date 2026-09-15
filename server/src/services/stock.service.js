const StockItem = require('../models/stockItem.model');
const StockMovement = require('../models/stockMovement.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { prefixMatch } = require('../utils/search');

// Resolve the current stock and rate for an item or its variant. One place, so
// sale, purchase and adjust all behave identically.
const resolveStockTarget = (item, variantId) => {
    if (!item.hasVariants) {
        return {
            currentStock: item.currentStock,
            sellPrice: item.sellPrice,
            costPrice: item.costPrice,
            lowStockAt: item.lowStockAt,
            variantLabel: '',
        };
    }

    if (!variantId) {
        throw new ApiError(400, `${item.name} requires a size to be chosen`);
    }

    const variant = item.variants.find((v) => v._id.toString() === variantId.toString());
    if (!variant) throw new ApiError(404, `${item.name} does not have that size`);

    return {
        currentStock: variant.currentStock,
        sellPrice: variant.sellPrice,
        costPrice: variant.costPrice,
        lowStockAt: variant.lowStockAt,
        variantLabel: variant.label,
    };
};

// The only way stock changes. arrayFilters picks out the right variant and the
// write itself is an $inc — two people selling the same size at once still
// leave the count correct (read-modify-write would let one update eat the
// other).
const applyStockDelta = async ({ itemId, variantId, delta }, mongoSession) => {
    if (variantId) {
        await StockItem.updateOne(
            { _id: itemId },
            { $inc: { 'variants.$[v].currentStock': delta } },
            { arrayFilters: [{ 'v._id': variantId }], session: mongoSession }
        );
    } else {
        await StockItem.updateOne(
            { _id: itemId },
            { $inc: { currentStock: delta } },
            { session: mongoSession }
        );
    }
};

const listItems = async (query) => {
    const { page, limit } = getPaginationParams(query);

    const filter = {};
    filter.isActive = query.includeInactive === 'true' ? { $in: [true, false] } : true;
    if (query.category) filter.category = query.category;

    const rx = prefixMatch(query.search);
    if (rx) filter.nameLower = rx;

    return fetchPage(
        StockItem.find(filter)
            .select('name category unit hasVariants sellPrice costPrice currentStock lowStockAt variants isActive image')
            .sort({ nameLower: 1 }),
        { page, limit, withTotal: true }
    );
};

const getById = async (id) => {
    const item = await StockItem.findById(id).lean();
    if (!item) throw new ApiError(404, 'Item not found');
    return item;
};

// ---------------------------------------------------------------------------
// Opening stock is written as an OPENING movement when the item is
// created, rather than setting currentStock directly. That gives every
// quantity a source — when the year-end physical count disagrees, the
// history tells the whole story.
// ---------------------------------------------------------------------------
const createItem = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();

    const exists = await StockItem.findOne({ nameLower: payload.name.toLowerCase().trim() }).lean();
    if (exists) throw new ApiError(409, 'An item with this name already exists');

    return withTransaction(async (mongoSession) => {
        const [item] = await StockItem.create(
            [{ ...payload, nameLower: payload.name.toLowerCase().trim(), createdBy: actorId }],
            { session: mongoSession }
        );

        const movements = [];

        if (item.hasVariants) {
            for (const v of item.variants) {
                if (v.currentStock > 0) {
                    movements.push({
                        session,
                        item: item._id,
                        itemName: item.name,
                        variantId: v._id,
                        variantLabel: v.label,
                        type: 'OPENING',
                        qty: v.currentStock,
                        rate: v.costPrice,
                        balanceAfter: v.currentStock,
                        date: new Date(),
                        note: 'Opening stock',
                        by: actorId,
                    });
                }
            }
        } else if (item.currentStock > 0) {
            movements.push({
                session,
                item: item._id,
                itemName: item.name,
                type: 'OPENING',
                qty: item.currentStock,
                rate: item.costPrice,
                balanceAfter: item.currentStock,
                date: new Date(),
                note: 'Opening stock',
                by: actorId,
            });
        }

        if (movements.length) await StockMovement.insertMany(movements, { session: mongoSession });

        return item;
    });
};

// Quantity does NOT change here — it moves only through a purchase, a
// sale or an adjustment. Otherwise somebody would quietly fix a number
// and the movement history would start lying.
const updateItem = async (id, updates, actorId) => {
    const session = await sessionService.getActiveSessionName();

    const item = await StockItem.findById(id);
    if (!item) throw new ApiError(404, 'Item not found');

    delete updates.currentStock;

    // A size added while editing arrives with an opening count and no history —
    // the same situation a brand new item is in, and it needs the same OPENING
    // movement. Without one the quantity simply appeared, and the movement
    // history could not explain where it came from.
    const openingRows = [];

    if (updates.variants) {
        // Preserve existing variants' stock — only rate and label change
        const bySavedId = new Map(item.variants.map((v) => [v._id.toString(), v]));
        updates.variants = updates.variants.map((v) => {
            const existing = v._id && bySavedId.get(v._id.toString());
            if (existing) return { ...v, currentStock: existing.currentStock };
            return v;
        });
    }

    Object.assign(item, updates);

    // Read AFTER the assign, so a new variant already has the _id mongoose gave it.
    if (updates.variants) {
        const knownIds = new Set(
            (updates.variants || [])
                .filter((v) => v._id)
                .map((v) => v._id.toString())
        );

        for (const v of item.variants) {
            if (knownIds.has(v._id.toString()) || !(v.currentStock > 0)) continue;
            openingRows.push({
                session,
                item: item._id,
                itemName: item.name,
                variantId: v._id,
                variantLabel: v.label,
                type: 'OPENING',
                qty: v.currentStock,
                rate: v.costPrice,
                balanceAfter: v.currentStock,
                date: new Date(),
                note: 'Opening stock for a size added later',
                by: actorId,
            });
        }
    }

    if (!openingRows.length) {
        await item.save();
        return item;
    }

    return withTransaction(async (mongoSession) => {
        await item.save({ session: mongoSession });
        await StockMovement.insertMany(openingRows, { session: mongoSession });
        return item;
    });
};

// ---------------------------------------------------------------------------
// Adjustment — damage, miscount or return. A reason is mandatory.
// ---------------------------------------------------------------------------
const adjust = async ({ itemId, variantId = null, delta, reason }, actorId) => {
    const session = await sessionService.getActiveSessionName();

    if (!Number.isInteger(delta) || delta === 0) {
        throw new ApiError(400, 'Adjustment must be a whole number and cannot be zero');
    }
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required for the adjustment');

    return withTransaction(async (mongoSession) => {
        // Read inside the transaction: the "cannot go negative" check has to be
        // made against the count this write is about to change. Read outside it,
        // two adjustments started together both saw the same 3 in stock, both
        // passed a -3, and the shelf ended up at -3.
        const item = await StockItem.findById(itemId).session(mongoSession).lean();
        if (!item) throw new ApiError(404, 'Item not found');

        const target = resolveStockTarget(item, variantId);
        const after = target.currentStock + delta;

        if (after < 0) {
            throw new ApiError(
                400,
                `Stock cannot go negative — there are ${target.currentStock} right now`
            );
        }

        await applyStockDelta({ itemId, variantId, delta }, mongoSession);

        const [movement] = await StockMovement.create(
            [
                {
                    session,
                    item: item._id,
                    itemName: item.name,
                    variantId,
                    variantLabel: target.variantLabel,
                    type: 'ADJUST',
                    qty: delta,
                    rate: target.costPrice,
                    balanceAfter: after,
                    note: reason.trim(),
                    date: new Date(),
                    by: actorId,
                },
            ],
            { session: mongoSession }
        );

        return { movement, balanceAfter: after };
    });
};

const listMovements = async (itemId, query) => {
    const { page, limit } = getPaginationParams(query);
    return fetchPage(StockMovement.find({ item: itemId }).sort({ date: -1 }), { page, limit, withTotal: true });
};

// ---------------------------------------------------------------------------
// Low stock — the dashboard checks fresh every time. Nothing needs to run
// overnight (and on Vercel nothing could).
//
// Variants mean this filters in JS: one query cannot ask "any variant
// below its own threshold". Item counts run to a couple of hundred, so
// this is entirely fine — at thousands we would keep a denormalised
// `hasLowStock` flag instead.
// ---------------------------------------------------------------------------
const lowStock = async () => {
    const items = await StockItem.find({ isActive: true })
        .select('name category hasVariants currentStock lowStockAt variants')
        .lean();

    const low = [];

    for (const item of items) {
        if (item.hasVariants) {
            for (const v of item.variants) {
                if (v.isActive !== false && v.currentStock <= v.lowStockAt) {
                    low.push({
                        itemId: item._id,
                        name: item.name,
                        variantId: v._id,
                        variantLabel: v.label,
                        currentStock: v.currentStock,
                        lowStockAt: v.lowStockAt,
                    });
                }
            }
        } else if (item.currentStock <= item.lowStockAt) {
            low.push({
                itemId: item._id,
                name: item.name,
                variantLabel: '',
                currentStock: item.currentStock,
                lowStockAt: item.lowStockAt,
            });
        }
    }

    return low.sort((a, b) => a.currentStock - b.currentStock);
};

module.exports = {
    listItems,
    getById,
    createItem,
    updateItem,
    adjust,
    listMovements,
    lowStock,
    resolveStockTarget,
    applyStockDelta,
};

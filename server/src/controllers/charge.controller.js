const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const chargeService = require('../services/charge.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write stays in the service.
const ChargeHead = require('../models/chargeHead.model');

// ---------------------------------------------------------------------------
// OTHER FEES — admission, exams, trips, anything charged beyond the monthly fee.
//
// Every write here is audited. These are amounts a parent is asked for outside
// the fee they agreed at admission, which makes "who decided this, and why" the
// first question anybody asks about them.
// ---------------------------------------------------------------------------

// ---- heads ----

const listHeads = asyncHandler(async (req, res) => {
    const data = await chargeService.listHeads(req.query);
    // No Cache-Control here, deliberately.
    //
    // This list is EDITED from the same screen that reads it, and a browser's
    // HTTP cache cannot be invalidated: react-query would refetch on a save, the
    // browser would answer from its own 60-second copy, and the change would
    // simply not appear until it expired. TanStack Query already caches this
    // (staleTime), and that cache CAN be invalidated — which is the whole point.
    return res.status(200).json(new ApiResponse(200, data, 'Charge heads'));
});

const createHead = asyncHandler(async (req, res) => {
    const data = await chargeService.createHead(req.body, req.userId);

    audit.logCreate(req, {
        action: 'charge.headCreate',
        entity: 'ChargeHead',
        entityId: data._id,
        label: `${data.name} added${data.defaultAmount ? ` at ₹${data.defaultAmount}` : ''}`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Head created'));
});

const updateHead = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(ChargeHead, req.params.id, 'ChargeHead');
    const data = await chargeService.updateHead(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'charge.headUpdate',
        entity: 'ChargeHead',
        entityId: data._id,
        label: data.name,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Head updated'));
});

// ---- charges ----

// The decision itself: who is being asked for money, how much, and what for.
const raise = asyncHandler(async (req, res) => {
    const data = await chargeService.raise(req.body, req.userId);
    const c = data.charge;

    audit.log({
        ...audit.fromRequest(req),
        action: 'charge.raise',
        entity: 'Charge',
        entityId: c._id,
        summary: `${c.headName} · ${c.title} — ₹${c.amount} on ${data.raisedFor} students`
            + ` (${c.scope === 'CLASS' ? c.classNames.join(', ') : c.scope === 'SCHOOL' ? 'whole school' : 'named students'})`
            + ` · ₹${data.totalRaised} raised`,
        after: { amount: c.amount, scope: c.scope, students: data.raisedFor, totalRaised: data.totalRaised },
    });

    return res.status(201).json(new ApiResponse(201, data, `Raised on ${data.raisedFor} students`));
});

const topUp = asyncHandler(async (req, res) => {
    const data = await chargeService.topUp(req.params.id, req.userId);

    if (data.added > 0) {
        audit.log({
            ...audit.fromRequest(req),
            action: 'charge.topUp',
            entity: 'Charge',
            entityId: req.params.id,
            summary: `${data.added} students added to this charge (₹${data.totalRaised})`,
        });
    }

    return res.status(200).json(
        new ApiResponse(200, data, data.added ? `${data.added} students added` : data.message)
    );
});

const cancel = asyncHandler(async (req, res) => {
    const data = await chargeService.cancel(req.params.id, req.body.reason, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'charge.cancel',
        entity: 'Charge',
        entityId: req.params.id,
        summary: `${data.title} cancelled — ${data.withdrawn} students no longer charged: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Charge cancelled'));
});

const list = asyncHandler(async (req, res) => {
    const data = await chargeService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Charges'));
});

const getOne = asyncHandler(async (req, res) => {
    const data = await chargeService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Charge'));
});

const demands = asyncHandler(async (req, res) => {
    const data = await chargeService.demandsFor(req.params.id, req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Students on this charge'));
});

const pendingForStudent = asyncHandler(async (req, res) => {
    const data = await chargeService.pendingForStudent(req.params.studentId);
    return res.status(200).json(new ApiResponse(200, data, 'Pending other fees'));
});

// ---- money ----

const collect = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await chargeService.collect(req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'charge.collect',
        entity: 'Transaction',
        entityId: data.transactionId,
        summary: `${data.receiptNo}: ₹${data.amount} from ${data.student.name} (${data.mode})`
            + ` — ${data.covered.map((c) => c.title).join(', ')}`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Payment received'));
});

// A waiver is the first thing a trust or an auditor asks about, so it carries
// who, how much and why.
const applyDiscount = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await chargeService.applyDiscount(req.params.id, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'charge.discount',
        entity: 'ChargeDemand',
        entityId: req.params.id,
        summary: `₹${data.discount} waived: ${data.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Discount applied'));
});

const voidReceipt = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await chargeService.voidReceipt(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'charge.void',
        entity: 'Transaction',
        entityId: req.params.id,
        summary: `Receipt for ₹${data.amount} voided: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Receipt voided'));
});

module.exports = {
    listHeads,
    createHead,
    updateHead,
    raise,
    topUp,
    cancel,
    list,
    getOne,
    demands,
    pendingForStudent,
    collect,
    applyDiscount,
    voidReceipt,
};

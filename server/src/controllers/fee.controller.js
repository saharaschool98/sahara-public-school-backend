const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const feeService = require('../services/fee.service');
const audit = require('../services/audit.service');

const generate = asyncHandler(async (req, res) => {
    const data = await feeService.generateMonth(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'fee.generate',
        entity: 'FeeDemand',
        summary: `${data.month}: ${data.created} demands raised (₹${data.totalRaised})`,
    });

    return res.status(200).json(new ApiResponse(200, data, `${data.created} fee demands raised`));
});

const listDemands = asyncHandler(async (req, res) => {
    const data = await feeService.listDemands(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Fee demands'));
});

const pendingForStudent = asyncHandler(async (req, res) => {
    const data = await feeService.pendingForStudent(req.params.studentId);
    return res.status(200).json(new ApiResponse(200, data, 'Pending fees'));
});

const collect = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await feeService.collect(req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'fee.collect',
        entity: 'Transaction',
        entityId: data.transactionId,
        summary: `${data.receiptNo}: ₹${data.amount} from ${data.student.name} (${data.mode})`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Fee collected'));
});

const applyDiscount = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await feeService.applyDiscount(req.params.id, req.body, actor);

    // A discount is always audited — a trust or an auditor asks exactly this:
    // who, how much, and why.
    audit.log({
        ...audit.fromRequest(req),
        action: 'fee.discount',
        entity: 'FeeDemand',
        entityId: req.params.id,
        summary: `₹${data.discount} discount: ${data.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Discount applied'));
});

// Money going out of the drawer, so it is audited like a void rather than like
// a collection — who returned it, how much, and why.
const refundCredit = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await feeService.refundCredit(req.params.studentId, req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'fee.refund',
        entity: 'Transaction',
        entityId: data.transactionId,
        summary: `₹${data.amount} advance returned to ${data.name} (${data.mode}): ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Advance returned'));
});

const voidReceipt = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await feeService.voidReceipt(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'fee.void',
        entity: 'Transaction',
        entityId: req.params.id,
        summary: `Receipt for ₹${data.amount} voided: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Receipt voided'));
});

const getReceipt = asyncHandler(async (req, res) => {
    const data = await feeService.getReceipt(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Receipt'));
});

const summary = asyncHandler(async (req, res) => {
    const data = await feeService.summary(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Class-wise fee summary'));
});

module.exports = {
    generate,
    listDemands,
    pendingForStudent,
    collect,
    applyDiscount,
    voidReceipt,
    refundCredit,
    getReceipt,
    summary,
};

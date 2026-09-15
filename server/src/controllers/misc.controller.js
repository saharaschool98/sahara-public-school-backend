const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const expenseService = require('../services/expense.service');
const reportService = require('../services/report.service');
const uploadService = require('../services/upload.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write stays in the service.
const Expense = require('../models/expense.model');
const ExpenseCategory = require('../models/expenseCategory.model');

// ---- expenses ----

const listCategories = asyncHandler(async (req, res) => {
    const data = await expenseService.listCategories(req.query);
    // No Cache-Control here, deliberately.
    //
    // This list is EDITED from the same screen that reads it, and a browser's
    // HTTP cache cannot be invalidated: react-query would refetch on a save, the
    // browser would answer from its own 60-second copy, and the change would
    // simply not appear until it expired. TanStack Query already caches this
    // (staleTime), and that cache CAN be invalidated — which is the whole point.
    return res.status(200).json(new ApiResponse(200, data, 'Categories'));
});

const createCategory = asyncHandler(async (req, res) => {
    const data = await expenseService.createCategory(req.body, req.userId);

    audit.logCreate(req, {
        action: 'expense.categoryCreate',
        entity: 'ExpenseCategory',
        entityId: data._id,
        label: `${data.name} added`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Category created'));
});

const updateCategory = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(ExpenseCategory, req.params.id, 'ExpenseCategory');
    const data = await expenseService.updateCategory(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'expense.categoryUpdate',
        entity: 'ExpenseCategory',
        entityId: data._id,
        label: data.name,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Category updated'));
});

const createExpense = asyncHandler(async (req, res) => {
    const data = await expenseService.create(req.body, req.userId);

    audit.logCreate(req, {
        action: 'expense.create',
        entity: 'Expense',
        entityId: data._id,
        label: `${data.title} — ₹${data.amount} (${data.categoryName}, ${data.mode})`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Expense recorded'));
});

const listExpenses = asyncHandler(async (req, res) => {
    const data = await expenseService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Expenses'));
});

const getExpense = asyncHandler(async (req, res) => {
    const data = await expenseService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Expense'));
});

// The amount and the date are frozen (expense.service refuses them) — a wrong
// amount is deleted and re-entered, which writes a reversal. What is editable
// is the title, who it was paid to, the note and the photo.
const updateExpense = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(Expense, req.params.id, 'Expense');
    const data = await expenseService.update(req.params.id, req.body);

    audit.logEdit(req, {
        action: 'expense.update',
        entity: 'Expense',
        entityId: data._id,
        label: `${data.title} — ₹${data.amount}`,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Expense updated'));
});

const deleteExpense = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await expenseService.remove(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'expense.delete',
        entity: 'Expense',
        entityId: req.params.id,
        summary: `Delete: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Expense deleted'));
});

const expensesByCategory = asyncHandler(async (req, res) => {
    const data = await expenseService.byCategory(req.query.month);
    return res.status(200).json(new ApiResponse(200, data, 'Category-wise expenses'));
});

// ---- reports ----

const dashboard = asyncHandler(async (req, res) => {
    const data = await reportService.dashboard(req.query);
    // The dashboard may be 30 seconds stale — that is fine, and in an office
    // where four people refresh at once it saves a good number of queries.
    res.set('Cache-Control', 'private, max-age=30');
    return res.status(200).json(new ApiResponse(200, data, 'Dashboard'));
});

const daybook = asyncHandler(async (req, res) => {
    const data = await reportService.daybook(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Day book'));
});

const outstanding = asyncHandler(async (_req, res) => {
    const data = await reportService.outstanding();
    return res.status(200).json(new ApiResponse(200, data, 'Outstanding'));
});

// What the school has in hand — session-wise, mode by mode. Reads a dozen
// rollup documents, never the ledger.
const cashbook = asyncHandler(async (req, res) => {
    const data = await reportService.cashbook(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Cash book'));
});

const incomeVsExpense = asyncHandler(async (_req, res) => {
    const data = await reportService.incomeVsExpense();
    return res.status(200).json(new ApiResponse(200, data, 'Income vs expense'));
});

const feeTrend = asyncHandler(async (_req, res) => {
    const data = await reportService.feeTrend();
    return res.status(200).json(new ApiResponse(200, data, 'Fee trend'));
});

// ---- uploads ----

const uploadSignature = asyncHandler(async (req, res) => {
    const data = uploadService.getSignature(req.query.folder);
    return res.status(200).json(new ApiResponse(200, data, 'Upload signature'));
});

const destroyUpload = asyncHandler(async (req, res) => {
    const data = await uploadService.destroy(req.body.publicId);
    return res.status(200).json(new ApiResponse(200, data, 'Image deleted'));
});

module.exports = {
    listCategories,
    createCategory,
    updateCategory,
    createExpense,
    listExpenses,
    getExpense,
    updateExpense,
    deleteExpense,
    expensesByCategory,
    dashboard,
    daybook,
    outstanding,
    cashbook,
    incomeVsExpense,
    feeTrend,
    uploadSignature,
    destroyUpload,
};

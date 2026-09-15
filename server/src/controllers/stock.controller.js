const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const stockService = require('../services/stock.service');
const saleService = require('../services/sale.service');
const audit = require('../services/audit.service');
// Only for the BEFORE snapshot on an edit — the write stays in the service.
const StockItem = require('../models/stockItem.model');

// ---- items ----

const listItems = asyncHandler(async (req, res) => {
    const data = await stockService.listItems(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Stock items'));
});

const getItem = asyncHandler(async (req, res) => {
    const data = await stockService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Item'));
});

const createItem = asyncHandler(async (req, res) => {
    const data = await stockService.createItem(req.body, req.userId);

    audit.logCreate(req, {
        action: 'stock.itemCreate',
        entity: 'StockItem',
        entityId: data._id,
        label: `${data.name} (${data.category}) added`,
        after: data,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Item added'));
});

// A price change here decides what every future sale charges, and it leaves
// no other trace — a sale records the rate it used, not who set it.
const updateItem = asyncHandler(async (req, res) => {
    const before = await audit.snapshot(StockItem, req.params.id, 'StockItem');
    const data = await stockService.updateItem(req.params.id, req.body, req.userId);

    audit.logEdit(req, {
        action: 'stock.itemUpdate',
        entity: 'StockItem',
        entityId: data._id,
        label: data.name,
        before,
        after: data,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Item updated'));
});

const adjust = asyncHandler(async (req, res) => {
    const data = await stockService.adjust(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'stock.adjust',
        entity: 'StockItem',
        entityId: req.body.itemId,
        summary: `${req.body.delta > 0 ? '+' : ''}${req.body.delta}: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Stock adjusted'));
});

const movements = asyncHandler(async (req, res) => {
    const data = await stockService.listMovements(req.params.id, req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Movement history'));
});

const lowStock = asyncHandler(async (_req, res) => {
    const data = await stockService.lowStock();
    return res.status(200).json(new ApiResponse(200, data, 'Low stock'));
});

// ---- sales ----

const createSale = asyncHandler(async (req, res) => {
    const data = await saleService.create(req.body, req.userId);

    audit.logCreate(req, {
        action: 'sale.create',
        entity: 'StockSale',
        entityId: data._id,
        label: `Bill ${data.billNo} — ${data.studentName}, ₹${data.total}`
            + `${data.dueAmount > 0 ? ` (₹${data.dueAmount} on credit)` : ''}`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Bill created'));
});

const listSales = asyncHandler(async (req, res) => {
    const data = await saleService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Sales'));
});

const getSale = asyncHandler(async (req, res) => {
    const data = await saleService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Bill'));
});

const voidSale = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await saleService.voidSale(req.params.id, req.body.reason, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'sale.void',
        entity: 'StockSale',
        entityId: req.params.id,
        summary: `Bill void: ${req.body.reason}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Bill voided'));
});

// ---- stock dues (money owed on credit sales) ----

const studentStockDues = asyncHandler(async (req, res) => {
    const data = await saleService.duesForStudent(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Stock dues'));
});

const collectStockDues = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const data = await saleService.collectDues(req.body, actor);

    audit.log({
        ...audit.fromRequest(req),
        action: 'sale.collect',
        entity: 'Student',
        entityId: req.body.studentId,
        summary: `Stock dues received ₹${data.amount} (${data.receiptNo})`,
    });

    return res.status(201).json(new ApiResponse(201, data, 'Payment received'));
});

module.exports = {
    listItems,
    getItem,
    createItem,
    updateItem,
    adjust,
    movements,
    lowStock,
    createSale,
    listSales,
    getSale,
    voidSale,
    studentStockDues,
    collectStockDues,
};

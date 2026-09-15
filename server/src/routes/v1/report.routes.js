const router = require('express').Router();

const c = require('../../controllers/misc.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { dashboardSchema, daybookSchema, cashbookSchema } = require('../../validators/finance.validator');

// These endpoints all read pre-aggregated rollups or denormalised balances
// — no aggregation runs over the transaction ledger. That is why these
// stay just as fast after three years of data.
// `period` is today | week | month — the money figures follow it. The balances
// on the same screen do not: what is owed is owed whatever period is showing.
router.get('/dashboard', can('report.dashboard'), validate(dashboardSchema, 'query'), c.dashboard);
// A date RANGE, not a single day — `from` and `to` are both optional, and
// nothing at all means today.
router.get('/daybook', can('report.daybook'), validate(daybookSchema, 'query'), c.daybook);
router.get('/outstanding', can('report.outstanding'), c.outstanding);
// What is in hand, session-wise and mode by mode. `session` is optional — it
// defaults to the active one, and naming an older one opens last year's book.
router.get('/cashbook', can('report.cashbook'), validate(cashbookSchema, 'query'), c.cashbook);
router.get('/income-expense', can('report.dashboard'), c.incomeVsExpense);
router.get('/fee-trend', can('report.dashboard'), c.feeTrend);

module.exports = router;

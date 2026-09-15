const router = require('express').Router();

const c = require('../../controllers/fee.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { heavyLimiter } = require('../../middlewares/rateLimiter');
const {
    generateFeesSchema,
    collectFeeSchema,
    discountSchema,
    voidSchema,
    refundCreditSchema,
    listDemandsSchema,
    studentIdParamSchema,
} = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/demands', can('fee.view'), validate(listDemandsSchema, 'query'), c.listDemands);
router.get('/pending/:studentId', can('fee.view'), validate(studentIdParamSchema, 'params'), c.pendingForStudent);
router.get('/summary', can('report.fee'), c.summary);
router.get('/receipts/:id', can('fee.view'), validate(idParamSchema, 'params'), c.getReceipt);

// Generation runs across the whole school — heavyLimiter because there is
// no valid reason to repeat it (and being idempotent, a double-click is
// harmless anyway).
router.post('/generate', can('fee.generate'), heavyLimiter, validate(generateFeesSchema), c.generate);

router.post('/collect', can('fee.collect'), validate(collectFeeSchema), c.collect);
router.post('/demands/:id/discount', can('fee.discount'), validate(idParamSchema, 'params'), validate(discountSchema), c.applyDiscount);
router.post('/receipts/:id/void', can('fee.void'), validate(idParamSchema, 'params'), validate(voidSchema), c.voidReceipt);

// Handing back fee a parent paid ahead — a child leaving mid-session with money
// still on their head.
//
// Its own permission, not fee.collect. This is the one route in the fee module
// that takes money OUT of the drawer, and the people who take money in are not
// automatically the people who should be able to hand it back.
router.post(
    '/credit/:studentId/refund',
    can('fee.refund'),
    validate(studentIdParamSchema, 'params'),
    validate(refundCreditSchema),
    c.refundCredit
);

module.exports = router;

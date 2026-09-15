const router = require('express').Router();

const c = require('../../controllers/charge.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { heavyLimiter } = require('../../middlewares/rateLimiter');
const {
    createHeadSchema,
    updateHeadSchema,
    listHeadsSchema,
    raiseSchema,
    listChargesSchema,
    listDemandsSchema,
    collectSchema,
    discountSchema,
    cancelSchema,
    studentIdParamSchema,
} = require('../../validators/charge.validator');
const { idParamSchema } = require('../../validators/auth.validator');

// ---------------------------------------------------------------------------
// OTHER FEES — admission, exams, trips, anything beyond the monthly fee.
//
// Four permissions, because these are four different jobs done by different
// people: seeing them, DECIDING one (raising it on a class or the school),
// taking the money at the counter, and waiving it. The counter should be able
// to collect an exam fee without being able to invent one.
// ---------------------------------------------------------------------------

// ---- heads: the school's own list of what it charges for ----
router.get('/heads', can('charge.view'), validate(listHeadsSchema, 'query'), c.listHeads);
router.post('/heads', can('charge.manage'), validate(createHeadSchema), c.createHead);
router.patch('/heads/:id', can('charge.manage'), validate(idParamSchema, 'params'), validate(updateHeadSchema), c.updateHead);

// ---- two segments, so neither can be swallowed by '/:id' ----
router.get('/pending/:studentId', can('charge.view'), validate(studentIdParamSchema, 'params'), c.pendingForStudent);

// Taking money at the counter is the same act whichever fee it is, so this sits
// beside the others and behaves identically — same receipt series, same ledger.
router.post('/collect', can('charge.collect'), validate(collectSchema), c.collect);

// ---- charges ----
router.get('/', can('charge.view'), validate(listChargesSchema, 'query'), c.list);

// Raising runs across a class or the whole school. heavyLimiter because there
// is no valid reason to repeat it — and being idempotent, a double-click is
// harmless anyway.
router.post('/', can('charge.manage'), heavyLimiter, validate(raiseSchema), c.raise);

router.get('/:id', can('charge.view'), validate(idParamSchema, 'params'), c.getOne);
router.get('/:id/students', can('charge.view'), validate(idParamSchema, 'params'), validate(listDemandsSchema, 'query'), c.demands);

// Picking up whoever was admitted after this went out.
router.post('/:id/top-up', can('charge.manage'), validate(idParamSchema, 'params'), c.topUp);

// Withdrawing the whole thing. Refused once any money has come in — those
// receipts are voided one at a time first, deliberately.
router.post('/:id/cancel', can('charge.manage'), validate(idParamSchema, 'params'), validate(cancelSchema), c.cancel);

// ---- one student's line on one charge ----
router.post('/demands/:id/discount', can('charge.discount'), validate(idParamSchema, 'params'), validate(discountSchema), c.applyDiscount);

// ---- receipts ----
router.post('/receipts/:id/void', can('charge.collect'), validate(idParamSchema, 'params'), validate(cancelSchema), c.voidReceipt);

module.exports = router;

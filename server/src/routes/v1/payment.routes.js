const router = require('express').Router();

const c = require('../../controllers/payment.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { listPaymentsSchema, updatePaymentSchema } = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

// ---------------------------------------------------------------------------
// The second pair of eyes on money collected from students.
//
// One permission covers both reading and ticking: somebody who cannot sign a
// payment off has no reason to sit in front of the queue. `can('payment.verify')`
// rather than adminOnly, so a school where the Principal does the daily check
// can be set up from Settings with no code change — the same rule the edit
// history follows.
//
// The PATCH below corrects an entry nobody has checked off yet — the amount,
// the payment mode, the reference. It is the one place in this app where a
// ledger row is edited rather than reversed, and it is deliberately narrow:
// student money only, unverified only, its own permission, fully audited, and
// the money behind the figure is moved by the module that owns it rather than
// from here. See payment.service.js.
//
// There is no route here that changes WHO paid, WHAT FOR, or the receipt
// number, and there should not be one. A receipt against the wrong student is
// not a mistyped figure — it is the wrong document, and the answer to a wrong
// document is to void it and write the right one. That void writes a reversal,
// and the correction shows up in this queue as its own row.
// ---------------------------------------------------------------------------
router.get('/', can('payment.verify'), validate(listPaymentsSchema, 'query'), c.listPayments);

router.post('/:id/verify', can('payment.verify'), validate(idParamSchema, 'params'), c.verifyPayment);
// Undo, for a tick put on the wrong row. Audited exactly like the tick itself.
router.post('/:id/unverify', can('payment.verify'), validate(idParamSchema, 'params'), c.unverifyPayment);

// Correcting an entry nobody has checked off yet — amount, mode, reference.
//
// A DIFFERENT permission from the tick, deliberately. Verifying is oversight —
// the person with the cash box. Correcting is counter work — the people who
// took the money and know what actually happened. Handing both to one key
// would mean the office could only fix its own slip by also being allowed to
// sign money off, which is the separation this whole screen exists to create.
//
// It also means nobody can raise a figure and then sign off their own raise:
// the Accountant holds this and not the tick, and the person who ticks does not
// need this one. That is worth more here than anywhere else in the app, because
// this is the only route that edits a ledger row.
//
// The route is open only while the row is unverified; the service refuses once
// it is sealed, and so does every void path. See transaction.model.js.
router.patch(
    '/:id',
    can('payment.edit'),
    validate(idParamSchema, 'params'),
    validate(updatePaymentSchema),
    c.updatePayment
);

module.exports = router;

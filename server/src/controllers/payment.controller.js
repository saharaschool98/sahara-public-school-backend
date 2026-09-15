const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const paymentService = require('../services/payment.service');
const audit = require('../services/audit.service');

// ---------------------------------------------------------------------------
// The daily check on money collected from students.
//
// Read, flag, and correct what the counter wrote down. Nothing in this
// controller can move a rupee: not the tick, and not the edit, which reaches
// only the mode and the note. See payment.service.js for why that is the point
// rather than a limitation.
// ---------------------------------------------------------------------------

const listPayments = asyncHandler(async (req, res) => {
    const data = await paymentService.listForDate(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Payments'));
});

// Ticking a row is exactly the kind of thing somebody gets asked about later
// ("who signed this off?"), so both directions are audited — and un-ticking
// especially, since that is the one that removes an assurance.
const describe = (p) =>
    `${p?.receiptNo ? `${p.receiptNo} · ` : ''}₹${p?.amount ?? '?'} from ${p?.party?.name || 'a student'}`;

const applyVerification = (verified) =>
    asyncHandler(async (req, res) => {
        const actor = { id: req.userId, name: req.user.name, role: req.role };
        const { payment, changed } = await paymentService.setVerified(req.params.id, verified, actor);

        // A no-op writes no history row. Two people ticking the same payment in
        // the same second should leave one entry, not two identical ones.
        if (changed) {
            audit.log({
                ...audit.fromRequest(req),
                action: verified ? 'payment.verify' : 'payment.unverify',
                entity: 'Transaction',
                entityId: req.params.id,
                summary: `${verified ? 'Verified' : 'Verification removed'}: ${describe(payment)}`,
                before: { verified: !verified },
                after: { verified },
            });
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                { payment, changed },
                changed
                    ? verified
                        ? 'Payment verified'
                        : 'Verification removed'
                    : verified
                      ? 'This payment was already verified'
                      : 'This payment was already unverified'
            )
        );
    });

const verifyPayment = applyVerification(true);
const unverifyPayment = applyVerification(false);

// ---------------------------------------------------------------------------
// Correcting an entry nobody has signed off yet.
//
// Logged with before and after, like every other edit in the app. A payment
// recorded as Cash that is now UPI, and above all a figure that was ₹500 and
// is now ₹5,000, are precisely the changes somebody gets asked about at the end
// of the month — the history has to be able to answer, with a name on it.
// ---------------------------------------------------------------------------
const CORRECTABLE = ['amount', 'mode', 'note'];

// An amount reads as money in the history, not as a bare number — ₹500 → ₹5000
// is the line somebody scans for.
const shown = (key, value) =>
    key === 'amount' ? `₹${value ?? 0}` : value || '—';

const updatePayment = asyncHandler(async (req, res) => {
    const actor = { id: req.userId, name: req.user.name, role: req.role };
    const { before, payment } = await paymentService.update(req.params.id, req.body, actor);

    const moved = CORRECTABLE.filter(
        (key) => req.body[key] !== undefined && String(before[key] ?? '') !== String(payment[key] ?? '')
    );

    // A save that changed nothing writes no history row — the same rule
    // audit.logEdit follows everywhere else.
    if (moved.length) {
        audit.log({
            ...audit.fromRequest(req),
            action: 'payment.edit',
            entity: 'Transaction',
            entityId: req.params.id,
            summary: `${describe(payment)} — ${moved
                .map((key) => `${key}: ${shown(key, before[key])} → ${shown(key, payment[key])}`)
                .join(', ')}`,
            before: Object.fromEntries(moved.map((key) => [key, before[key] ?? null])),
            after: Object.fromEntries(moved.map((key) => [key, payment[key] ?? null])),
        });
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                // The browser reprints the receipt after an amount change, so it
                // is told which kind of correction this was rather than having to
                // compare the figures itself.
                { payment, changed: moved.length > 0, amountChanged: moved.includes('amount') },
                moved.length ? 'Payment corrected' : 'Nothing was different'
            )
        );
});

module.exports = { listPayments, verifyPayment, unverifyPayment, updatePayment };

// ---------------------------------------------------------------------------
// The safety net for the denormalised balances.
//
// The whole system is fast because outstanding balances and monthly totals
// are maintained in fields rather than aggregated. The price is that if a
// write path forgets to update them, the number goes quietly wrong and
// nobody notices for months.
//
// This script rebuilds every balance from its SOURCE data and reports the
// difference. Ideally it always prints "no drift".
//
//   node scripts/recomputeBalances.js          -> report only (safe)
//   node scripts/recomputeBalances.js --fix    -> repair as well
//
// Run it after a deploy, after any incident, and once a month.
// ---------------------------------------------------------------------------

require('dotenv').config();
const mongoose = require('mongoose');

const Student = require('../server/src/models/student.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const StockSale = require('../server/src/models/stockSale.model');
const ChargeDemand = require('../server/src/models/chargeDemand.model');
const Vendor = require('../server/src/models/vendor.model');
const Purchase = require('../server/src/models/purchase.model');
const StockItem = require('../server/src/models/stockItem.model');
const StockMovement = require('../server/src/models/stockMovement.model');
const Transaction = require('../server/src/models/transaction.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const AcademicSession = require('../server/src/models/academicSession.model');
const { ROLLUP_MAP, MODES } = require('../server/src/services/ledger.service');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const FIX = process.argv.includes('--fix');

let driftCount = 0;

const report = (label, id, stored, actual) => {
    if (round2(stored) === round2(actual)) return false;
    driftCount += 1;
    console.log(`  DRIFT  ${label} ${id}: stored ${round2(stored)} -> actual ${round2(actual)}`);
    return true;
};

// ---- students ----
const checkStudents = async (session) => {
    console.log('\nStudents (feeOutstanding, stockOutstanding, chargeOutstanding, creditBalance)');

    const [students, demands, sales, charges, advances, spentCredit, refunds] = await Promise.all([
        Student.find({ session })
            .select('name feeOutstanding stockOutstanding chargeOutstanding creditBalance openingCredit')
            .lean(),
        FeeDemand.aggregate([
            { $match: { session } },
            {
                $group: {
                    _id: '$student',
                    due: { $sum: { $subtract: ['$amount', { $add: ['$discount', '$paidAmount'] }] } },
                },
            },
        ]),
        StockSale.aggregate([
            { $match: { session, voided: false, student: { $ne: null } } },
            { $group: { _id: '$student', due: { $sum: '$dueAmount' } } },
        ]),
        // Admission, exams, trips — the same shape as the fee demands above.
        ChargeDemand.aggregate([
            { $match: { session } },
            {
                $group: {
                    _id: '$student',
                    due: { $sum: { $subtract: ['$amount', { $add: ['$discount', '$paidAmount'] }] } },
                },
            },
        ]),

        // ---- the three halves of an advance balance ----
        //
        // Credit cannot be read off the demands the way an outstanding can, so
        // it is rebuilt from where it came from and where it went: fee money no
        // month claimed, less what later months have since eaten, less what was
        // handed back. A voided receipt is out of the first sum and its share
        // is already out of the second, so the two stay in step.
        Transaction.aggregate([
            { $match: { session, type: 'FEE', voided: { $ne: true }, advance: { $gt: 0 } } },
            { $group: { _id: '$party.ref', total: { $sum: '$advance' } } },
        ]),
        FeeDemand.aggregate([
            { $match: { session, paidFromCredit: { $gt: 0 } } },
            { $group: { _id: '$student', total: { $sum: '$paidFromCredit' } } },
        ]),
        Transaction.aggregate([
            { $match: { session, type: 'FEE_REFUND', voided: { $ne: true } } },
            { $group: { _id: '$party.ref', total: { $sum: '$amount' } } },
        ]),
    ]);

    const feeMap = new Map(demands.map((d) => [d._id.toString(), Math.max(0, d.due)]));
    const stockMap = new Map(sales.map((s) => [s._id.toString(), s.due]));
    const chargeMap = new Map(charges.map((c) => [c._id.toString(), Math.max(0, c.due)]));

    const sumMap = (rows) => new Map(rows.filter((r) => r._id).map((r) => [r._id.toString(), r.total]));
    const paidAhead = sumMap(advances);
    const usedAhead = sumMap(spentCredit);
    const givenBack = sumMap(refunds);

    const ops = [];

    for (const s of students) {
        const key = s._id.toString();
        const fee = round2(feeMap.get(key) || 0);
        const stock = round2(stockMap.get(key) || 0);

        const charge = round2(chargeMap.get(key) || 0);
        // openingCredit is where the counting STARTS, not something derived —
        // an advance carried in from last session has none of the three source
        // rows below behind it, and without this term the rebuild would call it
        // drift and `--fix` would wipe money the school owes a parent.
        const credit = round2(
            (s.openingCredit || 0)
            + (paidAhead.get(key) || 0) - (usedAhead.get(key) || 0) - (givenBack.get(key) || 0)
        );

        const feeDrift = report('student.fee', s.name, s.feeOutstanding, fee);
        const stockDrift = report('student.stock', s.name, s.stockOutstanding, stock);
        const chargeDrift = report('student.charges', s.name, s.chargeOutstanding || 0, charge);
        const creditDrift = report('student.credit', s.name, s.creditBalance || 0, credit);

        if ((feeDrift || stockDrift || chargeDrift || creditDrift) && FIX) {
            ops.push({
                updateOne: {
                    filter: { _id: s._id },
                    update: {
                        $set: {
                            feeOutstanding: fee,
                            stockOutstanding: stock,
                            chargeOutstanding: charge,
                            creditBalance: credit,
                        },
                    },
                },
            });
        }
    }

    if (ops.length) {
        await Student.bulkWrite(ops, { ordered: false });
        console.log(`  FIXED  ${ops.length} students`);
    }
};

// ---- vendors ----
const checkVendors = async () => {
    console.log('\nVendors (outstanding)');

    const [vendors, bills] = await Promise.all([
        Vendor.find().select('name outstanding').lean(),
        Purchase.aggregate([{ $group: { _id: '$vendor', due: { $sum: '$dueAmount' } } }]),
    ]);

    const dueMap = new Map(bills.map((b) => [b._id.toString(), b.due]));
    const ops = [];

    for (const v of vendors) {
        const actual = round2(dueMap.get(v._id.toString()) || 0);
        if (report('vendor', v.name, v.outstanding, actual) && FIX) {
            ops.push({ updateOne: { filter: { _id: v._id }, update: { $set: { outstanding: actual } } } });
        }
    }

    if (ops.length) {
        await Vendor.bulkWrite(ops, { ordered: false });
        console.log(`  FIXED  ${ops.length} vendors`);
    }
};

// ---- stock ----
const checkStock = async () => {
    console.log('\nStock (currentStock)');

    const [items, moves] = await Promise.all([
        StockItem.find().select('name hasVariants currentStock variants').lean(),
        StockMovement.aggregate([
            { $group: { _id: { item: '$item', variant: '$variantId' }, qty: { $sum: '$qty' } } },
        ]),
    ]);

    const moveMap = new Map(
        moves.map((m) => [`${m._id.item}:${m._id.variant || 'base'}`, m.qty])
    );

    const ops = [];

    for (const item of items) {
        if (item.hasVariants) {
            for (const v of item.variants) {
                const actual = moveMap.get(`${item._id}:${v._id}`) || 0;
                if (report('stock', `${item.name} / ${v.label}`, v.currentStock, actual) && FIX) {
                    ops.push({
                        updateOne: {
                            filter: { _id: item._id },
                            update: { $set: { 'variants.$[v].currentStock': actual } },
                            arrayFilters: [{ 'v._id': v._id }],
                        },
                    });
                }
            }
        } else {
            const actual = moveMap.get(`${item._id}:base`) || 0;
            if (report('stock', item.name, item.currentStock, actual) && FIX) {
                ops.push({
                    updateOne: { filter: { _id: item._id }, update: { $set: { currentStock: actual } } },
                });
            }
        }
    }

    if (ops.length) {
        await StockItem.bulkWrite(ops, { ordered: false });
        console.log(`  FIXED  ${ops.length} stock rows`);
    }
};

// ---- rollups ----
// Rebuilt from the ledger. A voided row is NOT skipped: when it was written it
// raised the rollup, and its REVERSAL row lowered it again, so counting both is
// what actually reproduces the live state. A REVERSAL is applied inversely
// against its original's type — exactly the way ledger.service does it.
const checkRollups = async (session) => {
    console.log('\nMonthly rollups');

    const [txns, demands, purchases] = await Promise.all([
        Transaction.find({ session }).select('type direction mode month amount class className voided reversalOf').lean(),
        FeeDemand.aggregate([
            { $match: { session } },
            {
                $group: {
                    _id: { month: '$month', class: '$class' },
                    className: { $first: '$className' },
                    expected: { $sum: '$amount' },
                    discount: { $sum: '$discount' },
                },
            },
        ]),
        // The `purchases` head is bumped by purchase.service with
        // monthKeyIST(billDate). Purchase stores no month field of its own, so
        // the same IST bucket has to be derived here — Asia/Kolkata is a fixed
        // +05:30 with no DST, so $dateToString agrees with monthKeyIST exactly.
        Purchase.aggregate([
            { $match: { session } },
            {
                $group: {
                    _id: { $dateToString: { date: '$billDate', format: '%Y-%m', timezone: 'Asia/Kolkata' } },
                    total: { $sum: '$total' },
                },
            },
        ]),
    ]);

    // Lookup to resolve a reversal row's original type
    const byId = new Map(txns.map((t) => [t._id.toString(), t]));
    const buckets = new Map();

    const bump = (month, classId, className, field, amount) => {
        for (const scope of ['SCHOOL', 'CLASS']) {
            if (scope === 'CLASS' && !classId) continue;
            // The SCHOOL bucket covers the whole school — its key never includes a
            // class, otherwise every class would get its own "SCHOOL" total.
            const bucketClass = scope === 'SCHOOL' ? null : classId;
            const key = `${month}|${scope}|${bucketClass || 'null'}`;
            if (!buckets.has(key)) buckets.set(key, { month, scope, class: bucketClass, className: scope === 'CLASS' ? className : '' });
            const b = buckets.get(key);
            b[field] = round2((b[field] || 0) + amount);
        }
    };

    // The split by payment mode lives at SCHOOL scope only — a class does not
    // have a cash box. ledger.bumpRollup keeps it out of the class documents,
    // and rebuilding it into them here would invent drift that is not there.
    const bumpSchool = (month, field, amount) => {
        const key = `${month}|SCHOOL|null`;
        if (!buckets.has(key)) buckets.set(key, { month, scope: 'SCHOOL', class: null, className: '' });
        const b = buckets.get(key);
        b[field] = round2((b[field] || 0) + amount);
    };

    for (const t of txns) {
        // Voided rows are NOT skipped. When they were written they raised the
        // rollup, and their REVERSAL row lowered it again. Counting both is what
        // actually reproduces the live state.
        let effectiveType = t.type;
        let sign = 1;
        // -------------------------------------------------------------------
        // A reversal is booked against the ORIGINAL's month, never its own.
        //
        // ledger.reverse says so explicitly — "from the ORIGINAL's month, not
        // today's, otherwise a July mistake would understate August" — but the
        // REVERSAL ROW ITSELF stores today's month, and this loop was reading
        // that. So a July receipt voided in August rebuilt as a deduction from
        // AUGUST while the live rollup had correctly taken it off July: two
        // months reported as drifting when nothing had drifted, and `--fix`
        // would then have written that wrong answer into both of them.
        //
        // It never showed up because a void in the same month as its receipt —
        // which is every void a test makes, and most of the real ones — lands
        // on the same bucket either way.
        // -------------------------------------------------------------------
        let month = t.month;
        let classId = t.class;
        let className = t.className;
        let direction = t.direction;
        let mode = t.mode;

        if (t.type === 'REVERSAL') {
            const original = t.reversalOf && byId.get(t.reversalOf.toString());
            if (!original) continue;
            effectiveType = original.type;
            sign = -1;
            month = original.month;
            classId = original.class;
            className = original.className;
            // The reversal carries the opposite direction so the day book reads
            // correctly on both sides — but what it UNDOES is a movement
            // through the original's own drawer, so that is the bucket it comes
            // off. Same as ledger.reverse.
            direction = original.direction;
            mode = original.mode;
        }

        const mapping = ROLLUP_MAP[effectiveType];
        if (!mapping) continue;

        // `headSign` is the third slot in a mapping and is -1 for exactly one
        // type: a fee refund, whose cash goes OUT while the fee collection it
        // came from goes DOWN. Reading only the first two entries here rebuilt
        // a refund as if it had added to collection, and every school that ever
        // handed an advance back would have shown drift it did not have.
        //
        // The fourth slot is a second head that moves WITH the cash — today
        // only `feeRefunds`, so that money handed back is a number of its own
        // instead of a hole inside feeCollected.
        const [head, cash, headSign = 1, alsoHead = null] = mapping;
        if (head) bump(month, classId, className, head, sign * headSign * t.amount);
        if (cash) bump(month, classId, className, cash, sign * t.amount);
        if (alsoHead) bump(month, classId, className, alsoHead, sign * t.amount);

        // Which drawer it moved through.
        if (mode) {
            const bucket = direction === 'IN' ? 'inByMode' : 'outByMode';
            bumpSchool(month, `${bucket}.${mode}`, sign * t.amount);
        }
    }

    for (const d of demands) {
        bump(d._id.month, d._id.class, d.className, 'feeExpected', d.expected);
        bump(d._id.month, d._id.class, d.className, 'feeDiscount', d.discount);
    }

    // A bill's value is not cash, so it never passes through ledger.record — it
    // has its own head, bumped at SCHOOL scope only (purchase.service passes no
    // class). Rebuilt the same way.
    for (const p of purchases) {
        bump(p._id, null, '', 'purchases', p.total);
    }

    const stored = await MonthlyRollup.find({ session }).lean();
    const storedMap = new Map(
        stored.map((r) => [`${r.month}|${r.scope}|${r.class || 'null'}`, r])
    );

    // EVERY numeric field on MonthlyRollup has to be listed here. A field left
    // out is never compared, so drift in it is reported as "No drift" — and this
    // script is the one thing standing behind the denormalised design.
    // `idCardCollected` and `purchases` were both missing: ID card money still
    // showed up inside cashIn, so the totals looked right while its own head
    // could sit wrong indefinitely, and the bill-value head was never rebuilt
    // at all.
    const FIELDS = [
        'feeExpected', 'feeCollected', 'feeDiscount',
        // chargeCollected was missing. Admission, exam and trip money still
        // reached cashIn, so the totals looked right while its own head could
        // sit wrong indefinitely — exactly the failure the comment above
        // describes, repeated the next time a head was added.
        'stockSales', 'idCardCollected', 'chargeCollected', 'otherIncome',
        'feeRefunds',
        'expenses', 'salaries', 'vendorPaid', 'purchases',
        'cashIn', 'cashOut',
        // The split by drawer. Nested on the document, flat in the rebuilt
        // bucket — `get` below reads either.
        ...MODES.map((m) => `inByMode.${m}`),
        ...MODES.map((m) => `outByMode.${m}`),
    ];

    // A field name may be a dotted path now, and `stored[f]` does not follow
    // dots. The rebuilt buckets hold those paths as flat keys, so only the
    // stored side needs walking.
    const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

    const ops = [];

    for (const [key, actual] of buckets) {
        const current = storedMap.get(key) || {};
        let drifted = false;

        for (const f of FIELDS) {
            if (round2(get(current, f) || 0) !== round2(actual[f] || 0)) {
                console.log(
                    `  DRIFT  rollup ${key} ${f}: ${round2(get(current, f) || 0)} -> ${round2(actual[f] || 0)}`
                );
                driftCount += 1;
                drifted = true;
            }
        }

        if (drifted && FIX) {
            const set = { session, month: actual.month, scope: actual.scope, class: actual.class, lastRecomputedAt: new Date() };
            if (actual.className) set.className = actual.className;
            for (const f of FIELDS) set[f] = round2(actual[f] || 0);

            ops.push({
                updateOne: {
                    filter: { session, month: actual.month, scope: actual.scope, class: actual.class },
                    update: { $set: set },
                    upsert: true,
                },
            });
        }
    }

    if (ops.length) {
        await MonthlyRollup.bulkWrite(ops, { ordered: false });
        console.log(`  FIXED  ${ops.length} rollup rows`);
    }

};

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const active = await AcademicSession.findOne({ isActive: true }).lean();
    if (!active) {
        console.error('There is no active session.');
        process.exit(1);
    }

    console.log(`Session: ${active.name}   mode: ${FIX ? 'FIX' : 'REPORT ONLY'}`);

    await checkStudents(active.name);
    await checkVendors();
    await checkStock();
    await checkRollups(active.name);

    console.log(
        driftCount === 0
            ? '\nNo drift. Every balance matches the ledger.'
            : `\n${driftCount} drift${FIX ? ' repaired' : ' found — re-run with --fix to repair'}.`
    );

    process.exit(driftCount && !FIX ? 2 : 0);
};

run().catch((err) => {
    console.error('Recompute fail:', err.message);
    process.exit(1);
});

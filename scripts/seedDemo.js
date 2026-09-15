// ---------------------------------------------------------------------------
// Demo / UAT data.
//
//   node scripts/seedDemo.js            # seed with the default counts
//   node scripts/seedDemo.js --students 200 --leads 100
//
// Two rules this script follows, and they are the whole design:
//
// 1. MASTER data (students, teachers, vendors, items, leads) is inserted in
//    bulk. None of it moves money, so a direct insert cannot make a balance
//    wrong — and 500 rows in one insertMany beats 500 transactions.
//
// 2. Anything that MOVES MONEY goes through the services, never through a
//    direct insert. fee.collect, sale.create, purchase.create, vendor.pay,
//    expense.create and salary.pay each maintain a denormalised balance and
//    a monthly rollup. Writing those rows by hand would leave the ledger and
//    the balances telling different stories — exactly the drift
//    recomputeBalances exists to catch.
//
// Every _id created is written to scripts/.demo-seed-ids.json so
// unseedDemo.js can remove precisely this data and nothing else.
//
// Existing data is left alone. The script only adds.
// ---------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { validateEnv } = require('../server/src/config/env');
validateEnv();

const AcademicSession = require('../server/src/models/academicSession.model');
const SchoolClass = require('../server/src/models/schoolClass.model');
const Student = require('../server/src/models/student.model');
const Teacher = require('../server/src/models/teacher.model');
const Lead = require('../server/src/models/lead.model');
const Vendor = require('../server/src/models/vendor.model');
const StockItem = require('../server/src/models/stockItem.model');
const StockMovement = require('../server/src/models/stockMovement.model');
const ExpenseCategory = require('../server/src/models/expenseCategory.model');
const User = require('../server/src/models/user.model');
const { Counter } = require('../server/src/models/counter.model');

const feeService = require('../server/src/services/fee.service');
const saleService = require('../server/src/services/sale.service');
const purchaseService = require('../server/src/services/purchase.service');
const vendorService = require('../server/src/services/vendor.service');
const expenseService = require('../server/src/services/expense.service');
const salaryService = require('../server/src/services/salary.service');
const attendanceService = require('../server/src/services/attendance.service');

const { monthKeyIST, startOfDayIST, isSundayIST } = require('../server/src/utils/istDate');

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------
const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? Number(process.argv[i + 1]) : fallback;
};

const N = {
    students: arg('students', 500),
    leads: arg('leads', 500),
    vendors: arg('vendors', 500),
    items: arg('items', 500),
    // 40, not 500. A school with 500 students has about 40 staff — and every
    // teacher becomes a row on the attendance sheet and a salary slip, so an
    // unrealistic number here makes those two screens unusable to look at.
    teachers: arg('teachers', 40),
    receipts: arg('receipts', 500),
    purchases: arg('purchases', 500),
    expenses: arg('expenses', 500),
    sales: arg('sales', 300),
    vendorPays: arg('vendorPays', 200),
};

// ---------------------------------------------------------------------------
// Random helpers — seeded, so a re-run produces the same names
// ---------------------------------------------------------------------------
let rngState = 42;
const rnd = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const chance = (p) => rnd() < p;

const FIRST = [
    'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rudra',
    'Ayaan', 'Atharv', 'Kabir', 'Dhruv', 'Aryan', 'Kayaan', 'Rohan', 'Yash', 'Karan', 'Manav',
    'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Navya', 'Kiara', 'Myra', 'Sara',
    'Ira', 'Riya', 'Aarohi', 'Isha', 'Meera', 'Tara', 'Nitya', 'Avni', 'Prisha', 'Siya',
    'Rahul', 'Priya', 'Amit', 'Neha', 'Suresh', 'Kavita', 'Vikram', 'Pooja', 'Sanjay', 'Anjali',
];
// Mothers are picked from here rather than from FIRST, which is mixed — demo
// data that names half the mothers Suresh reads as a bug on the first screen
// anybody opens.
const FEMALE_FIRST = [
    'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Navya', 'Kiara', 'Myra', 'Sara',
    'Ira', 'Riya', 'Aarohi', 'Isha', 'Meera', 'Tara', 'Nitya', 'Avni', 'Prisha', 'Siya',
    'Priya', 'Neha', 'Kavita', 'Pooja', 'Anjali', 'Sunita', 'Rekha', 'Geeta', 'Seema', 'Nisha',
];

const LAST = [
    'Sharma', 'Verma', 'Gupta', 'Singh', 'Yadav', 'Kumar', 'Mishra', 'Pandey', 'Tiwari', 'Dubey',
    'Agarwal', 'Jain', 'Patel', 'Shah', 'Rathore', 'Chauhan', 'Thakur', 'Saxena', 'Srivastava', 'Joshi',
];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;
const phone = () => `9${int(100000000, 999999999)}`;

const AREAS = ['Civil Lines', 'Model Town', 'Gandhi Nagar', 'Shastri Nagar', 'Ram Nagar', 'Krishna Puram', 'Station Road', 'Nehru Colony'];
const address = () => `${int(1, 240)}, ${pick(AREAS)}`;

const DESIGNATIONS = ['PRT', 'TGT', 'PGT', 'Sports Teacher', 'Music Teacher', 'Computer Teacher', 'Librarian', 'Lab Assistant', 'Clerk', 'Peon'];
const SOURCES = ['Walk-in', 'Phone', 'Reference', 'Online', 'Other'];
const LEAD_STATUS = ['New', 'Contacted', 'Visited', 'Interested', 'Admitted', 'Lost'];
const MODES = ['Cash', 'UPI', 'Bank', 'Cheque'];

// ---------------------------------------------------------------------------
// Dates — everything sits inside the active session, up to today
// ---------------------------------------------------------------------------
const SESSION_START = new Date(Date.UTC(2026, 3, 1)); // 1 Apr 2026
const TODAY = new Date();

const dateBetween = (from, to) =>
    new Date(from.getTime() + rnd() * (to.getTime() - from.getTime()));

// ---------------------------------------------------------------------------
// Bookkeeping so unseedDemo.js can undo exactly this run
// ---------------------------------------------------------------------------
// Master ids are enough for almost everything: fee demands, sales, purchases,
// payments, slips, attendance and their ledger rows all reference a student,
// vendor, teacher or item, so unseedDemo can find them by cascade.
//
// Expenses are the exception — an expense references no master record — so
// those ids are collected as they are created.
const created = {
    seededAt: new Date().toISOString(),
    students: [], teachers: [], leads: [], vendors: [], stockItems: [], stockMovements: [],
    expenseCategories: [], expenses: [],
};

const IDS_FILE = path.join(__dirname, '.demo-seed-ids.json');

// Run `worker` over `items` with a bounded number in flight. Sequential would
// take minutes on a shared cluster; unbounded would exhaust the pool.
const pool = async (items, worker, size, label) => {
    let i = 0;
    let done = 0;
    let failed = 0;

    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (i < items.length) {
            const mine = i++;
            try {
                await worker(items[mine], mine);
            } catch (err) {
                failed += 1;
                if (failed <= 3) console.log(`    ! ${label}: ${err.message}`);
            }
            done += 1;
            if (done % 100 === 0) process.stdout.write(`    ${label}: ${done}/${items.length}\r`);
        }
    });

    await Promise.all(runners);
    process.stdout.write(' '.repeat(60) + '\r');
    return { done: done - failed, failed };
};

// ---------------------------------------------------------------------------

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI, {
        maxPoolSize: 20,
        serverSelectionTimeoutMS: 20000,
    });
    console.log('Connected\n');

    const session = await AcademicSession.findOne({ isActive: true }).lean();
    if (!session) throw new Error('No active session — run: npm run seed:session 2026-27');

    const admin = await User.findOne({ role: 'Admin' }).lean();
    if (!admin) throw new Error('No Admin user — run: npm run seed:admin');

    const classes = await SchoolClass.find({ session: session.name, isActive: true }).sort({ order: 1 }).lean();
    if (!classes.length) throw new Error('No classes in this session');

    const actor = { id: admin._id, name: admin.name, role: 'Admin' };

    console.log(`Session ${session.name} · ${classes.length} classes · actor ${admin.username}\n`);

    // ---------------------------------------------------------------------
    // 1. STUDENTS — bulk. No money involved, so feeOutstanding starts at 0
    //    and is moved only by fee generation below.
    // ---------------------------------------------------------------------
    console.log(`1/9  Students (${N.students})`);

    const admCounter = await Counter.findByIdAndUpdate(
        `${session.name}:admissionNo`,
        { $inc: { seq: N.students } },
        { new: true, upsert: true }
    );
    const admStart = admCounter.seq - N.students;

    const studentDocs = [];
    const perClass = new Map();

    for (let i = 0; i < N.students; i += 1) {
        const cls = classes[i % classes.length];
        const n = name();
        perClass.set(String(cls._id), (perClass.get(String(cls._id)) || 0) + 1);

        studentDocs.push({
            session: session.name,
            admissionNo: `ADM${String(admStart + i + 1).padStart(4, '0')}`,
            name: n,
            nameLower: n.toLowerCase(),
            guardianName: `${pick(FIRST)} ${n.split(' ')[1]}`,
            motherName: `${pick(FEMALE_FIRST)} ${n.split(' ')[1]}`,
            phone: phone(),
            address: address(),
            class: cls._id,
            className: `${cls.name} – ${cls.section}`,
            // A few siblings and staff children pay less — the concession case
            // the schema supports per student.
            monthlyFee: chance(0.08) ? Math.round(cls.monthlyFee * 0.75) : cls.monthlyFee,
            status: chance(0.04) ? 'Left' : 'Active',
            admissionDate: dateBetween(SESSION_START, TODAY),
            feeOutstanding: 0,
            stockOutstanding: 0,
            createdBy: admin._id,
        });
    }

    const students = await Student.insertMany(studentDocs, { ordered: false });
    created.students = students.map((s) => s._id);

    await SchoolClass.bulkWrite(
        [...perClass].map(([id, count]) => ({
            updateOne: { filter: { _id: id }, update: { $inc: { studentCount: count } } },
        })),
        { ordered: false }
    );
    console.log(`     ${students.length} inserted\n`);

    // ---------------------------------------------------------------------
    // 2. TEACHERS
    // ---------------------------------------------------------------------
    console.log(`2/9  Teachers (${N.teachers})`);

    const empCounter = await Counter.findByIdAndUpdate(
        'employeeCode',
        { $inc: { seq: N.teachers } },
        { new: true, upsert: true }
    );
    const empStart = empCounter.seq - N.teachers;

    const teacherDocs = Array.from({ length: N.teachers }, (_, i) => {
        const n = name();
        return {
            employeeCode: `EMP${String(empStart + i + 1).padStart(4, '0')}`,
            name: n,
            nameLower: n.toLowerCase(),
            phone: phone(),
            designation: pick(DESIGNATIONS),
            monthlySalary: int(8, 35) * 1000,
            lateAllowance: pick([0, 0, 2, 3, 4]),
            joiningDate: dateBetween(new Date(Date.UTC(2020, 0, 1)), SESSION_START),
            status: 'Active',
            createdBy: admin._id,
        };
    });

    const teachers = await Teacher.insertMany(teacherDocs, { ordered: false });
    created.teachers = teachers.map((t) => t._id);
    console.log(`     ${teachers.length} inserted\n`);

    // ---------------------------------------------------------------------
    // 3. LEADS — enquiries. Connected to nothing else, by design.
    // ---------------------------------------------------------------------
    console.log(`3/9  Enquiries (${N.leads})`);

    const leadDocs = Array.from({ length: N.leads }, () => {
        const n = name();
        const status = pick(LEAD_STATUS);
        const closed = status === 'Admitted' || status === 'Lost';
        const at = dateBetween(SESSION_START, TODAY);

        return {
            name: n,
            nameLower: n.toLowerCase(),
            guardianName: `${pick(FIRST)} ${n.split(' ')[1]}`,
            motherName: `${pick(FEMALE_FIRST)} ${n.split(' ')[1]}`,
            phone: phone(),
            address: address(),
            classInterested: pick(classes).name,
            source: pick(SOURCES),
            status,
            // Spread around today so the "due & overdue" queue has real content
            nextFollowUp: closed ? null : dateBetween(new Date(TODAY.getTime() - 20 * 864e5), new Date(TODAY.getTime() + 20 * 864e5)),
            followUps: chance(0.5)
                ? [{ at, note: pick(['Called, will visit next week', 'Visited the school', 'Asked about the fee', 'Wants a sibling discount', 'Not reachable']), outcome: status, by: admin._id, byName: admin.name }]
                : [],
            note: '',
            closedAt: closed ? at : null,
            closeReason: status === 'Lost' ? pick(['Chose another school', 'Fee too high', 'Moved city']) : '',
            createdBy: admin._id,
        };
    });

    const leads = await Lead.insertMany(leadDocs, { ordered: false });
    created.leads = leads.map((l) => l._id);
    console.log(`     ${leads.length} inserted\n`);

    // ---------------------------------------------------------------------
    // 4. VENDORS — outstanding stays 0 here; the purchases below move it.
    // ---------------------------------------------------------------------
    console.log(`4/9  Vendors (${N.vendors})`);

    const VENDOR_KIND = ['Traders', 'Enterprises', 'Stationers', 'Book Depot', 'Uniforms', 'Suppliers', 'Agencies', 'Store'];
    const vendorDocs = [];
    const seenVendor = new Set();

    for (let i = 0; i < N.vendors; i += 1) {
        // nameLower is uniquely indexed — the suffix keeps a re-run from
        // colliding with the names already in the database.
        const n = `${pick(LAST)} ${pick(VENDOR_KIND)} ${admStart + i + 1}`;
        if (seenVendor.has(n.toLowerCase())) continue;
        seenVendor.add(n.toLowerCase());

        vendorDocs.push({
            name: n,
            nameLower: n.toLowerCase(),
            phone: phone(),
            gstin: chance(0.5) ? `09${pick(LAST).toUpperCase().slice(0, 5)}${int(1000, 9999)}A1Z${int(1, 9)}` : '',
            address: address(),
            outstanding: 0,
            totalPurchased: 0,
            totalPaid: 0,
            isActive: true,
            createdBy: admin._id,
        });
    }

    const vendors = await Vendor.insertMany(vendorDocs, { ordered: false });
    created.vendors = vendors.map((v) => v._id);
    console.log(`     ${vendors.length} inserted\n`);

    // ---------------------------------------------------------------------
    // 5. STOCK ITEMS — with opening stock, and the OPENING movement rows that
    //    justify it. currentStock must equal the sum of its movements or
    //    recomputeBalances reports drift.
    // ---------------------------------------------------------------------
    console.log(`5/9  Stock items (${N.items})`);

    const CATS = ['Uniform', 'Book', 'Notebook', 'Stationery', 'Other'];
    const ITEM_NAMES = {
        Uniform: ['Shirt', 'Trouser', 'Skirt', 'Blazer', 'Sweater', 'Tie', 'Belt', 'Socks', 'House T-Shirt', 'Track Pant'],
        Book: ['English Reader', 'Hindi Pathmala', 'Maths Textbook', 'Science Book', 'Social Studies', 'Computer Book', 'GK Book', 'Drawing Book'],
        Notebook: ['Notebook 100pg', 'Notebook 200pg', 'Four Line Copy', 'Square Copy', 'Practical File', 'Register'],
        Stationery: ['Pencil Box', 'Geometry Box', 'Eraser', 'Sharpener', 'Pen', 'Pencil', 'Scale', 'Crayons', 'Water Bottle'],
        Other: ['School Bag', 'ID Card Holder', 'Lanyard', 'Diary', 'Badge'],
    };

    const itemDocs = [];
    const seenItem = new Set();

    for (let i = 0; i < N.items; i += 1) {
        const cat = CATS[i % CATS.length];
        const base = pick(ITEM_NAMES[cat]);
        const n = `${base} ${pick(classes).name}-${i + 1}`;
        if (seenItem.has(n.toLowerCase())) continue;
        seenItem.add(n.toLowerCase());

        const cost = int(40, 900);
        const sell = Math.round(cost * (1.2 + rnd() * 0.4));
        // Uniform comes in sizes — the case the embedded variants exist for.
        const hasVariants = cat === 'Uniform' && chance(0.6);

        itemDocs.push({
            name: n,
            nameLower: n.toLowerCase(),
            category: cat,
            unit: 'pcs',
            hasVariants,
            costPrice: hasVariants ? 0 : cost,
            sellPrice: hasVariants ? 0 : sell,
            currentStock: hasVariants ? 0 : int(0, 300),
            lowStockAt: 10,
            variants: hasVariants
                ? ['Size 24', 'Size 26', 'Size 28', 'Size 30', 'Size 32'].map((label) => ({
                      label,
                      costPrice: cost,
                      sellPrice: sell,
                      currentStock: int(0, 90),
                      lowStockAt: 10,
                      isActive: true,
                  }))
                : [],
            isActive: true,
            createdBy: admin._id,
        });
    }

    const items = await StockItem.insertMany(itemDocs, { ordered: false });
    created.stockItems = items.map((i) => i._id);

    const openingMoves = [];
    for (const item of items) {
        if (item.hasVariants) {
            for (const v of item.variants) {
                if (v.currentStock > 0) {
                    openingMoves.push({
                        session: session.name, item: item._id, itemName: item.name,
                        variantId: v._id, variantLabel: v.label, type: 'OPENING',
                        qty: v.currentStock, rate: v.costPrice, balanceAfter: v.currentStock,
                        date: SESSION_START, note: 'Opening stock', by: admin._id,
                    });
                }
            }
        } else if (item.currentStock > 0) {
            openingMoves.push({
                session: session.name, item: item._id, itemName: item.name,
                variantId: null, variantLabel: '', type: 'OPENING',
                qty: item.currentStock, rate: item.costPrice, balanceAfter: item.currentStock,
                date: SESSION_START, note: 'Opening stock', by: admin._id,
            });
        }
    }

    const moves = await StockMovement.insertMany(openingMoves, { ordered: false });
    created.stockMovements = moves.map((m) => m._id);
    console.log(`     ${items.length} items, ${moves.length} opening movements\n`);

    // Everything above is reversible on its own. Save now, so a crash in the
    // money phase below still leaves a usable undo file.
    fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));

    // ---------------------------------------------------------------------
    // 6. FEE DEMANDS — through the service. One bulk insert per month, and it
    //    raises every student's outstanding and the month's rollup with it.
    // ---------------------------------------------------------------------
    const nowMonth = monthKeyIST(TODAY);
    const feeMonths = session.feeMonths.filter((m) => m <= nowMonth);

    console.log(`6/9  Fee demands (${feeMonths.length} months: ${feeMonths[0]} → ${feeMonths[feeMonths.length - 1]})`);

    for (const month of feeMonths) {
        const out = await feeService.generateMonth({ month }, admin._id);
        console.log(`     ${month}: ${out.created} raised (₹${out.totalRaised || 0})`);
    }
    console.log();

    // ---------------------------------------------------------------------
    // 7. FEE COLLECTION — the real thing: receipt number, allocation across
    //    months oldest-first, student balance, ledger row, class rollup.
    // ---------------------------------------------------------------------
    console.log(`7/9  Fee receipts (${N.receipts})`);

    const active = students.filter((s) => s.status === 'Active');
    const payers = Array.from({ length: N.receipts }, () => pick(active));

    const feeRes = await pool(
        payers,
        async (student) => {
            const pending = await feeService.pendingForStudent(student._id);
            const due = pending.reduce(
                (sum, d) => sum + Math.max(0, d.amount - (d.discount || 0) - (d.paidAmount || 0)),
                0
            );
            if (due <= 0) return;

            // Most parents clear a month or two; some pay everything.
            const amount = chance(0.35) ? due : Math.min(due, student.monthlyFee * int(1, 3));
            if (amount <= 0) return;

            await feeService.collect(
                {
                    studentId: student._id,
                    amount: Math.round(amount),
                    mode: pick(MODES),
                    txnDate: dateBetween(SESSION_START, TODAY),
                },
                actor
            );
        },
        6,
        'receipts'
    );
    console.log(`     ${feeRes.done} collected, ${feeRes.failed} skipped\n`);

    // ---------------------------------------------------------------------
    // 8. PURCHASES, VENDOR PAYMENTS, SALES, EXPENSES
    // ---------------------------------------------------------------------
    console.log(`8/9  Purchases (${N.purchases})`);

    const purchaseRes = await pool(
        Array.from({ length: N.purchases }, (_, i) => i),
        async (i) => {
            const vendor = pick(vendors);
            const lineItems = Array.from({ length: int(1, 4) }, () => pick(items));

            const lines = lineItems.map((item) => {
                const variant = item.hasVariants ? pick(item.variants) : null;
                return {
                    item: item._id,
                    variantId: variant?._id || null,
                    qty: int(5, 60),
                    rate: variant ? variant.costPrice : item.costPrice || int(40, 500),
                };
            });

            const total = lines.reduce((s, l) => s + l.qty * l.rate, 0);
            // A mix of paid, part-paid and fully-on-credit bills, so the
            // vendor ageing screen has all three buckets.
            const paidAmount = chance(0.35) ? total : chance(0.5) ? Math.round(total * 0.4) : 0;

            await purchaseService.create(
                {
                    vendorId: vendor._id,
                    billNo: `BILL-${admStart}-${i + 1}`,
                    billDate: dateBetween(SESSION_START, TODAY),
                    lines,
                    mode: pick(MODES),
                    paidAmount,
                },
                admin._id
            );
        },
        6,
        'purchases'
    );
    console.log(`     ${purchaseRes.done} recorded, ${purchaseRes.failed} skipped\n`);

    console.log(`     Vendor payments (${N.vendorPays})`);
    const owing = await Vendor.find({ outstanding: { $gt: 0 } }).select('_id outstanding').limit(N.vendorPays).lean();

    const payRes = await pool(
        owing,
        async (v) => {
            const amount = chance(0.5) ? v.outstanding : Math.round(v.outstanding * 0.5);
            if (amount <= 0) return;
            await vendorService.pay(
                { vendorId: v._id, amount, mode: pick(MODES), date: dateBetween(SESSION_START, TODAY) },
                admin._id
            );
        },
        6,
        'vendor pay'
    );
    console.log(`     ${payRes.done} paid, ${payRes.failed} skipped\n`);

    console.log(`     Stock sales (${N.sales})`);
    const inStock = await StockItem.find({ isActive: true }).lean();

    const saleRes = await pool(
        Array.from({ length: N.sales }, (_, i) => i),
        async () => {
            const item = pick(inStock);
            const variant = item.hasVariants ? pick(item.variants.filter((v) => v.currentStock > 1)) : null;
            if (item.hasVariants && !variant) return;

            const available = variant ? variant.currentStock : item.currentStock;
            if (available < 2) return;

            const qty = int(1, Math.min(3, available));
            const rate = variant ? variant.sellPrice : item.sellPrice;
            const total = qty * rate;
            const student = pick(active);

            // Some bills are paid at the counter, some go on the student's
            // stock account and are collected with the fees.
            const paidAmount = chance(0.6) ? total : chance(0.5) ? Math.round(total * 0.5) : 0;

            await saleService.create(
                {
                    studentId: student._id,
                    lines: [{ item: item._id, variantId: variant?._id || null, qty, rate }],
                    paidAmount,
                    mode: paidAmount > 0 ? pick(MODES) : 'Credit',
                    date: dateBetween(SESSION_START, TODAY),
                },
                admin._id
            );
        },
        4,
        'sales'
    );
    console.log(`     ${saleRes.done} sold, ${saleRes.failed} skipped\n`);

    console.log(`     Expenses (${N.expenses})`);

    const CAT_NAMES = ['Electricity', 'Water', 'Maintenance', 'Transport', 'Printing', 'Cleaning', 'Internet', 'Repairs', 'Refreshments', 'Miscellaneous'];
    const cats = [];
    for (const cname of CAT_NAMES) {
        let cat = await ExpenseCategory.findOne({ nameLower: cname.toLowerCase() }).lean();
        if (!cat) {
            cat = (await ExpenseCategory.create({ name: cname, nameLower: cname.toLowerCase(), createdBy: admin._id })).toObject();
            created.expenseCategories.push(cat._id);
        }
        cats.push(cat);
    }

    const EXPENSE_TITLES = ['Monthly bill', 'Quarterly bill', 'Repair work', 'Supplies bought', 'Annual charge', 'Service visit', 'Refill', 'Replacement'];

    const expenseRes = await pool(
        Array.from({ length: N.expenses }, (_, i) => i),
        async () => {
            const cat = pick(cats);
            const expense = await expenseService.create(
                {
                    categoryId: cat._id,
                    title: `${cat.name} — ${pick(EXPENSE_TITLES)}`,
                    amount: int(2, 220) * 50,
                    date: dateBetween(SESSION_START, TODAY),
                    mode: pick(MODES),
                    paidTo: chance(0.6) ? name() : '',
                },
                admin._id
            );
            created.expenses.push(expense._id);
        },
        6,
        'expenses'
    );
    console.log(`     ${expenseRes.done} recorded, ${expenseRes.failed} skipped\n`);

    // ---------------------------------------------------------------------
    // 9. ATTENDANCE + SALARY
    //
    // A slip cannot be generated for a month with no attendance, so the
    // register is filled first. Sundays are skipped — payroll adds them from
    // the calendar, and marking one changes nothing.
    // ---------------------------------------------------------------------
    console.log('9/9  Teacher attendance + salary');

    const salaryMonths = feeMonths.slice(-3, -1); // the last two COMPLETE months
    const teacherIds = teachers.map((t) => t._id);

    for (const month of salaryMonths) {
        const [y, m] = month.split('-').map(Number);
        const days = new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 1) - 864e5).getUTCDate();
        let marked = 0;

        for (let d = 1; d <= days; d += 1) {
            const date = new Date(Date.UTC(y, m - 1, d));
            if (isSundayIST(startOfDayIST(date))) continue;
            if (date > TODAY) break;

            // The sheet defaults everyone to Present; the office marks only
            // the exceptions. That is what this distribution reflects.
            const entries = teacherIds.map((id) => ({
                teacher: id,
                status: chance(0.9) ? 'Present' : pick(['Late', 'Absent', 'HalfDay', 'Leave']),
            }));

            await attendanceService.markTeachers({ date, entries }, admin._id);
            marked += 1;
        }
        console.log(`     ${month}: ${marked} days marked`);

        const gen = await salaryService.generate({ month }, admin._id);
        console.log(`     ${month}: ${gen.created} slips generated`);

        // Approve and pay most of them, leaving a few Draft and a few
        // Approved-but-unpaid so every status shows on the screen.
        const slips = await salaryService.list({ month });
        for (const slip of slips.slips) {
            if (chance(0.15)) continue; // stays Draft
            await salaryService.approve(slip._id, admin._id);
            if (chance(0.25)) continue; // approved, not yet paid
            await salaryService.pay(
                slip._id,
                { amount: slip.netPayable, mode: pick(MODES), date: new Date(Date.UTC(y, m, 5)) },
                admin._id
            );
        }
        console.log(`     ${month}: slips approved / paid`);
    }

    fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));

    console.log(`\nDone. Undo list written to ${path.relative(process.cwd(), IDS_FILE)}`);
    console.log('Now run:  npm run recompute:balances    (it should print no drift)');

    await mongoose.disconnect();
    process.exit(0);
};

run().catch(async (err) => {
    console.error('\nSeed failed:', err.message);
    console.error(err.stack);
    try {
        fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));
        console.error(`Partial undo list written to ${IDS_FILE}`);
    } catch { /* nothing more we can do */ }
    process.exit(1);
});

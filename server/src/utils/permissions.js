// ---------------------------------------------------------------------------
// Permission catalogue.
//
// The keys are fixed in CODE, the grants live in the DATABASE. That split is
// deliberate: if the keys were data too, a typo would create a permission
// that matches no route — and "this permission doesn't work" is a miserable
// complaint to debug. Every grant is validated against this list instead, so
// an unknown key is never saved.
//
// Admin passes no check at all — they always have everything.
// ---------------------------------------------------------------------------

const PERMISSIONS = [
    // module, key, label (the label is what the Settings screen shows)
    { module: 'Students', key: 'student.view', read: true, label: 'View students' },
    { module: 'Students', key: 'student.create', label: 'Add a student' },
    { module: 'Students', key: 'student.edit', label: 'Edit student / change class' },
    { module: 'Students', key: 'student.delete', label: 'Mark student as left' },
    // Its own key because it takes money at the counter — the office staff who
    // hand cards out are not always the people allowed to edit a student.
    { module: 'Students', key: 'student.idcard', label: 'Issue / cancel ID card' },
    // A transfer certificate is a signed document the next school relies on, and
    // issuing one carries a decision with it: whether to hand it over while fees
    // are still unpaid. That decision is not the counter's to make by default,
    // so this is its own key rather than part of `student.delete` — and it sits
    // with the Principal, next to voiding and waiving, for the same reason.
    // Grantable, so a school where the office issues them needs no deploy.
    { module: 'Students', key: 'student.tc', label: 'Issue / cancel a transfer certificate' },

    // Enquiries that have not become admissions. A module of its own
    // because a lead is connected to nothing else in the app.
    { module: 'Leads', key: 'lead.view', read: true, label: 'View enquiries & follow-ups' },
    { module: 'Leads', key: 'lead.manage', label: 'Add / update an enquiry, log follow-ups' },

    { module: 'Classes', key: 'class.view', read: true, label: 'View classes' },
    { module: 'Classes', key: 'class.manage', label: 'Create / edit classes' },

    { module: 'Fees', key: 'fee.view', read: true, label: 'View fees & dues' },
    { module: 'Fees', key: 'fee.generate', label: "Raise the month's fees" },
    { module: 'Fees', key: 'fee.collect', label: 'Collect fee, issue receipt' },
    { module: 'Fees', key: 'fee.discount', label: 'Give discount or waiver' },
    { module: 'Fees', key: 'fee.void', label: 'Void a receipt' },
    // Returning fee a parent paid ahead. The only way money leaves the drawer
    // through this module, so it is a switch of its own rather than part of
    // collecting — and it sits with the Principal by default, next to voiding,
    // for the same reason.
    { module: 'Fees', key: 'fee.refund', label: 'Return advance fee' },

    // Admission, exams, trips — everything charged beyond the monthly fee.
    // Its own module because it is its own job: raising one is a decision
    // (who, how much), and collecting it is counter work, and the two are not
    // always the same person.
    { module: 'Other fees', key: 'charge.view', read: true, label: 'View other fees' },
    { module: 'Other fees', key: 'charge.manage', label: 'Raise / cancel a charge, manage heads' },
    { module: 'Other fees', key: 'charge.collect', label: 'Collect an other fee, issue receipt' },
    { module: 'Other fees', key: 'charge.discount', label: 'Give a discount or waiver on a charge' },

    { module: 'Stock', key: 'stock.view', read: true, label: 'View stock' },
    { module: 'Stock', key: 'stock.manage', label: 'Add / edit items & prices' },
    { module: 'Stock', key: 'stock.sell', label: 'Sell to a student' },
    { module: 'Stock', key: 'stock.adjust', label: 'Stock adjustment' },

    { module: 'Purchases', key: 'purchase.view', read: true, label: 'View purchase bills' },
    { module: 'Purchases', key: 'purchase.create', label: 'Record a purchase bill' },
    { module: 'Purchases', key: 'purchase.edit', label: 'Edit a purchase bill' },

    { module: 'Vendors', key: 'vendor.view', read: true, label: 'View vendors & outstanding' },
    { module: 'Vendors', key: 'vendor.manage', label: 'Add / edit a vendor' },
    { module: 'Vendors', key: 'vendor.pay', label: 'Pay a vendor' },

    { module: 'Teachers', key: 'teacher.view', read: true, label: 'View teachers' },
    { module: 'Teachers', key: 'teacher.manage', label: 'Add / edit teachers & salary' },

    { module: 'Attendance', key: 'attendance.teacher.view', read: true, label: 'View teacher attendance' },
    { module: 'Attendance', key: 'attendance.teacher.mark', label: 'Mark teacher attendance' },
    { module: 'Attendance', key: 'attendance.class.view', read: true, label: 'View class attendance' },
    { module: 'Attendance', key: 'attendance.class.mark', label: 'Mark class attendance' },

    { module: 'Salary', key: 'salary.view', read: true, label: 'View salary slips' },
    { module: 'Salary', key: 'salary.generate', label: 'Generate monthly slips' },
    { module: 'Salary', key: 'salary.approve', label: 'Approve a slip' },
    { module: 'Salary', key: 'salary.pay', label: 'Pay salary' },

    { module: 'Expenses', key: 'expense.view', read: true, label: 'View expenses' },
    { module: 'Expenses', key: 'expense.create', label: 'Record an expense' },
    { module: 'Expenses', key: 'expense.edit', label: 'Edit an expense' },
    { module: 'Expenses', key: 'expense.delete', label: 'Delete an expense' },

    // Checking collected money off against the cash box. Its own module because
    // it spans fees, stock and ID cards — every rupee a student hands over —
    // and because it is an oversight job, not a collection one: the person who
    // takes the money should not normally be the person who signs it off.
    //
    // Not in DEFAULT_GRANTS. Admin holds it because Admin holds everything, and
    // can pass it to the Principal from Settings. Deliberately grantable — a
    // school where the Principal does the daily check should not need a deploy.
    // `read: true` looks wrong on a key named "verify", and it is worth being
    // precise about why it is not. The permission covers two things: OPENING the
    // day's collection queue (a GET) and ticking a row off (a POST). A read-only
    // role holding this key gets the first and is refused the second by the
    // read-only guard, so what it actually grants them is the queue as a report.
    { module: 'Payments', key: 'payment.verify', read: true, label: 'Verify collected payments' },
    // Fixing what the counter wrote down — the amount, the payment mode, the
    // cheque or UPI reference — while the entry is still unchecked.
    //
    // The amount makes this the strongest key in the app after the Admin-only
    // ones: it is the only capability anywhere that edits a ledger row instead
    // of reversing it. It is narrow on purpose — student money only, unverified
    // only, every change in the edit history — and it is a SEPARATE key from
    // the tick above, granted the other way round: the office holds this one,
    // the person with the cash box holds that one. So nobody can raise a figure
    // and then sign off their own raise. Once an entry is verified this key
    // grants nothing at all, because the row is sealed.
    { module: 'Payments', key: 'payment.edit', label: 'Correct an unverified payment' },

    { module: 'Reports', key: 'report.dashboard', read: true, label: 'Dashboard' },
    { module: 'Reports', key: 'report.fee', read: true, label: 'Class-wise fee report' },
    { module: 'Reports', key: 'report.daybook', read: true, label: 'Day book' },
    { module: 'Reports', key: 'report.outstanding', read: true, label: 'Outstanding & ageing' },
    // What the school actually has in hand — cash box, UPI, bank and cheques,
    // for the whole session. Its own key rather than part of the day book: that
    // one shows a single day's entries, this one shows the school's liquid
    // position, and they are not the same thing to hand somebody.
    { module: 'Reports', key: 'report.cashbook', read: true, label: 'Cash book & balance in hand' },

    { module: 'System', key: 'user.manage', label: 'Create / deactivate users' },
    { module: 'System', key: 'session.manage', label: 'Manage academic session' },
    { module: 'System', key: 'permission.manage', label: 'Manage role permissions' },
    // Who changed what. Not in DEFAULT_GRANTS — Admin has it because Admin has
    // everything, and can hand it to the Principal from Settings if the school
    // wants that. It is deliberately grantable: the history is a management
    // tool, not a secret.
    { module: 'System', key: 'audit.view', read: true, label: 'View edit history' },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

// Every capability that only ever reads. Derived from the catalogue rather than
// listed again here, so adding a permission cannot forget to classify it.
const READ_KEYS = new Set(PERMISSIONS.filter((p) => p.read).map((p) => p.key));

const ROLES = ['Admin', 'Principal', 'Accountant', 'Watcher'];

// ---------------------------------------------------------------------------
// WATCHER — sees everything, changes nothing.
//
// For the trustee, the auditor, the owner who wants the numbers without a
// finger anywhere near them. The guarantee is NOT "we only granted them view
// permissions" — that would last exactly until somebody flipped a switch in
// Settings by mistake. It is structural, and it holds in two places:
//
//   1. middlewares/readOnly.js refuses every non-GET request from this role
//      before it reaches a controller. A route added tomorrow is covered
//      automatically, with nobody having to remember anything — the same
//      fail-closed reasoning that puts isAuth in one place.
//
//   2. permission.service.updateGrants refuses to SAVE a write key against this
//      role at all. So the switch cannot be flipped in the first place, and the
//      Settings screen shows those switches locked rather than merely off.
//
// Both, not either. The first makes a write impossible; the second makes it
// impossible to believe a write was granted.
// ---------------------------------------------------------------------------
const READ_ONLY_ROLES = new Set(['Watcher']);

// This permission stays with Admin — the UI shows it locked and the API
// refuses to grant it to any other role. A role that can widen its own
// permissions is not a permission system.
const ADMIN_ONLY = new Set(['permission.manage']);

// Defaults seeded at install. The Admin can change any of them from the UI —
// except a read-only role's, which can only ever hold read keys.
const DEFAULT_GRANTS = {
    Principal: [
        'student.view', 'student.create', 'student.edit', 'student.delete', 'student.idcard',
        'student.tc',
        'lead.view', 'lead.manage',
        'class.view', 'class.manage',
        'fee.view', 'fee.generate', 'fee.collect', 'fee.discount', 'fee.void', 'fee.refund',
        'charge.view', 'charge.manage', 'charge.collect', 'charge.discount',
        'payment.edit',
        // stock.manage is deliberately absent — the Accountant maintains
        // items and rates; the Principal views them and approves adjustments.
        'stock.view', 'stock.sell', 'stock.adjust',
        'purchase.view', 'purchase.create', 'purchase.edit',
        'vendor.view', 'vendor.manage', 'vendor.pay',
        'teacher.view', 'teacher.manage',
        'attendance.teacher.view', 'attendance.teacher.mark',
        'attendance.class.view', 'attendance.class.mark',
        'salary.view', 'salary.generate', 'salary.approve', 'salary.pay',
        'expense.view', 'expense.create', 'expense.edit', 'expense.delete',
        'report.dashboard', 'report.fee', 'report.daybook', 'report.outstanding', 'report.cashbook',
    ],
    Accountant: [
        'student.view', 'student.create', 'student.edit', 'student.idcard',
        'lead.view', 'lead.manage',
        'class.view',
        'fee.view', 'fee.generate', 'fee.collect',
        // The counter raises and collects these; waiving one is the Principal's
        // call, exactly as it is on the monthly fee.
        'charge.view', 'charge.manage', 'charge.collect',
        // Correcting their own slip before it is signed off. Not the tick —
        // the person who took the money does not check it off as well.
        'payment.edit',
        'stock.view', 'stock.manage', 'stock.sell',
        'purchase.view', 'purchase.create',
        'vendor.view', 'vendor.manage', 'vendor.pay',
        'teacher.view',
        'attendance.teacher.view', 'attendance.teacher.mark',
        'attendance.class.view', 'attendance.class.mark',
        'expense.view', 'expense.create', 'expense.edit',
        'report.dashboard', 'report.daybook', 'report.outstanding', 'report.cashbook',
    ],
    // Everything that reads, and by construction nothing else — written as a
    // filter over the catalogue rather than as a list, so a view permission
    // added next year reaches the Watcher without anyone editing this file.
    Watcher: [...READ_KEYS],
};

module.exports = {
    PERMISSIONS,
    PERMISSION_KEYS,
    READ_KEYS,
    ROLES,
    ADMIN_ONLY,
    READ_ONLY_ROLES,
    DEFAULT_GRANTS,
};

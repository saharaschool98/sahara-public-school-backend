const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Class totals, not per student — what the client asked for, and also the
// technically correct call.
//
// 400 students x 220 school days = 88,000 rows a year. At class level the same
// information is 20 rows a day = ~4,400 rows a year. Against M0's 512MB that gap
// alone decides whether the system lasts 3 years or 15.
//
// If per-student attendance is ever needed it becomes a NEW collection —
// this design would not have to change.
// ---------------------------------------------------------------------------
const classAttendanceSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
        className: { type: String, required: true },

        date: { type: Date, required: true }, // IST midnight
        month: { type: String, required: true },

        // That day's roll strength, as a snapshot. Today's number is used, not
        // whatever it happens to be when the report is opened three months later
        // (by then students will have joined and left).
        totalStudents: { type: Number, required: true, min: 0 },
        present: { type: Number, required: true, min: 0 },
        // Stored so reports can sum it, but the service always fills it from
        // total minus present — the two numbers can never contradict each
        // other.
        absent: { type: Number, required: true, min: 0 },

        markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        // When this class's day was sealed — the row is written once, never updated.
        markedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// One class, one day, one row — written ONCE and never rewritten. The service
// writes with `$setOnInsert`; this index enforces the same rule against a race.
classAttendanceSchema.index({ class: 1, date: 1 }, { unique: true });
// A whole-school view for one date
classAttendanceSchema.index({ session: 1, date: 1 });
// Monthly percentage per class
classAttendanceSchema.index({ class: 1, month: 1 });
classAttendanceSchema.index({ session: 1, month: 1 });

module.exports =
    mongoose.models.ClassAttendance || mongoose.model('ClassAttendance', classAttendanceSchema);

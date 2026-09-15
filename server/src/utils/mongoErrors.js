// ---------------------------------------------------------------------------
// Reading Mongo's write errors correctly.
//
// A duplicate key is the one error this app treats as a RESULT rather than a
// failure: it is what makes fee generation and salary generation idempotent,
// and what stops a bill number being used twice. Everything else must still
// blow up — which is exactly what got lost when this test was written inline.
// ---------------------------------------------------------------------------

// 11000 can arrive as the error's own code, or buried inside writeErrors when
// the driver took the bulk path. Both mean the same thing: a unique index did
// its job.
const isDuplicateKey = (err) =>
    err?.code === 11000 ||
    (Array.isArray(err?.writeErrors) &&
        err.writeErrors.length > 0 &&
        err.writeErrors.every((e) => (e?.code ?? e?.err?.code) === 11000));

module.exports = { isDuplicateKey };

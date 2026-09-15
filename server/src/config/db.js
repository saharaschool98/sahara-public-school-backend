const mongoose = require('mongoose');
const { config } = require('./env');

// ---------------------------------------------------------------------------
// The most important twenty lines in a serverless app.
//
// On Vercel every request is a function invocation. Without caching, each
// invocation would open its own connection — TLS handshake + auth + topology
// discovery = 200-400ms, BEFORE the first query even runs. Caching the promise
// lets a warm instance reuse the same socket, which brings that cost down to
// single-digit milliseconds.
//
// globalThis rather than a module-level variable: a module variable would
// work, but globalThis states the intent — "for the whole lifetime of this
// instance" — and it also survives hot-reload clearing the module cache in
// development, so connections do not leak.
// ---------------------------------------------------------------------------

let cached = globalThis.__spsMongoose;
if (!cached) {
    cached = globalThis.__spsMongoose = { conn: null, promise: null };
}

const connectDB = async () => {
    if (cached.conn) return cached.conn;

    if (!cached.promise) {
        // autoIndex is OFF in production. Building indexes is a deliberate
        // deploy step (npm run build:indexes) — running syncIndexes on every
        // cold start can lock a collection on a shared-CPU cluster.
        mongoose.set('autoIndex', !config.isProd);
        mongoose.set('strictQuery', true);
        // A safety net on every query — one pathological query must not eat the
        // whole 10s function budget. This is NOT a connection option (the driver
        // rejects it there) — it is a mongoose query default.
        mongoose.set('maxTimeMS', 8000);

        cached.promise = mongoose
            .connect(process.env.MONGODB_URI, {
                // Atlas M0 allows 500 connections in total. In serverless,
                // instances x poolSize grows very fast — hence a small pool.
                // 5 is plenty for one instance's concurrent queries.
                maxPoolSize: 5,
                minPoolSize: 0,

                // Defaults to true, which queues a query while there is no
                // connection and leaves the function hanging until it times
                // out at 10s. false = fail fast, clear error, quick retry.
                bufferCommands: false,

                serverSelectionTimeoutMS: 8000,
                socketTimeoutMS: 20000,
            })
            .then((m) => m);
    }

    try {
        cached.conn = await cached.promise;
    } catch (err) {
        // Clear the promise on failure, otherwise every later request keeps
        // awaiting the same rejected promise until the instance recycles.
        cached.promise = null;
        throw err;
    }

    return cached.conn;
};

module.exports = connectDB;

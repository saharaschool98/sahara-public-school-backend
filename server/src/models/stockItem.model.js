const mongoose = require('mongoose');

// Uniform sizes live INSIDE the item, not in a separate collection.
//
// A shirt has eight sizes and they are never queried apart from the shirt.
// Embedding means the sell screen loads the item and every size in one
// read, and a sale $incs the right size's stock atomically (via
// arrayFilters). A separate collection would add a join on the hottest
// read path in the stock module, buying flexibility nobody needs.
const variantSchema = new mongoose.Schema(
    {
        label: { type: String, required: true, trim: true }, // "Size 30"
        sku: { type: String, default: '' },
        costPrice: { type: Number, default: 0, min: 0 },
        sellPrice: { type: Number, required: true, min: 0 },
        currentStock: { type: Number, default: 0 },
        lowStockAt: { type: Number, default: 10, min: 0 },
        isActive: { type: Boolean, default: true },
    },
    { _id: true }
);

const stockItemSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        category: {
            type: String,
            enum: ['Uniform', 'Book', 'Notebook', 'Stationery', 'Other'],
            required: true,
        },
        unit: { type: String, default: 'pcs' },

        hasVariants: { type: Boolean, default: false },

        // these fields apply when hasVariants is false
        costPrice: { type: Number, default: 0, min: 0 },
        sellPrice: { type: Number, default: 0, min: 0 },
        currentStock: { type: Number, default: 0 },
        lowStockAt: { type: Number, default: 10, min: 0 },

        variants: { type: [variantSchema], default: [] },

        image: {
            publicId: { type: String, default: '' },
            width: Number,
            height: Number,
        },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// The item picker on the sell screen
stockItemSchema.index({ isActive: 1, category: 1, nameLower: 1 });
// Low-stock panel with no aggregation (the variant-level check lives in
// the service, but this pulls non-variant items directly)
stockItemSchema.index({ isActive: 1, currentStock: 1 });
stockItemSchema.index({ nameLower: 1 });

stockItemSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports = mongoose.models.StockItem || mongoose.model('StockItem', stockItemSchema);

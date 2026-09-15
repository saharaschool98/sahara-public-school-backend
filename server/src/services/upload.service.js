const { buildUploadSignature, destroyImage, assertOwnedPublicId, assertEnabled } = require('../config/cloudinary');
const ApiError = require('../utils/ApiError');

// Only these folders are allowed. What the client sends becomes part of
// the signature, so it must be validated — otherwise any authenticated
// user could upload anywhere in our Cloudinary account.
const FOLDERS = new Set(['bills', 'expenses', 'students', 'teachers', 'items', 'misc']);

const getSignature = (folder = 'misc') => {
    // Checked before the folder, so a school without Cloudinary gets
    // "not set up" rather than a confusing complaint about folder names.
    assertEnabled();

    if (!FOLDERS.has(folder)) {
        throw new ApiError(400, `That folder is not allowed. Options: ${[...FOLDERS].join(', ')}`);
    }

    // The signature is valid for an hour (Cloudinary's own rule). The API
    // secret never travels with it — only a hash bound to these exact
    // params. The client cannot change the transformation or folder and
    // reuse it, because both are part of the signature.
    return buildUploadSignature(folder);
};

// Remove an orphaned upload when a form is cancelled
const destroy = async (publicId) => {
    assertEnabled();
    assertOwnedPublicId(publicId);
    return destroyImage(publicId);
};

module.exports = { getSignature, destroy, FOLDERS };

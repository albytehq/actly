"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSyncStore = isSyncStore;
exports.isAsyncStore = isAsyncStore;
function isSyncStore(store) {
    return store._sync === true;
}
function isAsyncStore(store) {
    return store._sync === false;
}

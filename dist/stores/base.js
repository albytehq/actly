export function isSyncStore(store) {
    return store._sync === true;
}
export function isAsyncStore(store) {
    return store._sync === false;
}

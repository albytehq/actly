"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noopPolicy = noopPolicy;
function noopPolicy() {
    return (fn, _ctx) => fn;
}

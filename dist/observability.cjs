"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasObservers = hasObservers;
function hasObservers(ctx) {
    return ctx.observability != null;
}

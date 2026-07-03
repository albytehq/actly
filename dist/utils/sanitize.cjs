"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeErrorMessage = sanitizeErrorMessage;
exports.sanitizeError = sanitizeError;
const FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/g;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
function sanitizeErrorMessage(msg) {
    let str;
    if (msg instanceof Error) {
        str = msg.message;
    }
    else if (typeof msg === 'string') {
        str = msg;
    }
    else {
        str = String(msg ?? '');
    }
    str = str.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
    str = str.replace(FORBIDDEN_CHARS, '');
    return str;
}
function sanitizeError(err) {
    if (err instanceof Error) {
        const sanitized = new Error(sanitizeErrorMessage(err.message));
        sanitized.name = err.name;
        return sanitized;
    }
    return sanitizeErrorMessage(err);
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeErrorMessage = sanitizeErrorMessage;
exports.sanitizeError = sanitizeError;
const limits_js_1 = require("./limits.js");
const errors_js_1 = require("../errors.js");
const FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/g;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
function sanitizeErrorMessage(msg) {
    let str;
    if (msg instanceof Error) {
        str = String(msg.message ?? '');
    }
    else if (typeof msg === 'string') {
        str = msg;
    }
    else {
        str = String(msg ?? '');
    }
    str = str.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
    str = str.replace(FORBIDDEN_CHARS, '');
    if (str.length > limits_js_1.LIMITS.MAX_SANITIZED_ERROR_LENGTH) {
        str = str.slice(0, limits_js_1.LIMITS.MAX_SANITIZED_ERROR_LENGTH - 3) + '...';
    }
    return str;
}
function sanitizeError(err) {
    if (err instanceof Error) {
        const sanitized = new Error(sanitizeErrorMessage(err.message));
        sanitized.name = err.name;
        try {
            sanitized.stack = err.stack;
        }
        catch { }
        if (err instanceof errors_js_1.ActlyError) {
            const code = err.code;
            const key = err.key;
            Object.defineProperty(sanitized, 'code', { value: code, enumerable: true });
            if (key !== undefined) {
                Object.defineProperty(sanitized, 'key', { value: key, enumerable: true });
            }
        }
        try {
            Object.defineProperty(sanitized, 'cause', { value: err, enumerable: false });
        }
        catch { }
        return sanitized;
    }
    return sanitizeErrorMessage(err);
}

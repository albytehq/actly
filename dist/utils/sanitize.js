import { LIMITS } from './limits.js';
import { ActlyError } from '../errors.js';
const FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/g;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
export function sanitizeErrorMessage(msg) {
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
    if (str.length > LIMITS.MAX_SANITIZED_ERROR_LENGTH) {
        str = str.slice(0, LIMITS.MAX_SANITIZED_ERROR_LENGTH - 3) + '...';
    }
    return str;
}
export function sanitizeError(err) {
    if (err instanceof Error) {
        const sanitized = new Error(sanitizeErrorMessage(err.message));
        sanitized.name = err.name;
        try {
            sanitized.stack = err.stack;
        }
        catch { }
        if (err instanceof ActlyError) {
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

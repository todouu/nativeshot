// Bounds, hit-testing and translation of annotation ops (image-pixel
// coordinates). Ops are treated as immutable: translateOp returns a copy so
// undo snapshots that share op objects stay valid.

import {ARROW_HALF_ANGLE, arrowHeadLength, textSize} from './render.js';

export function opBounds(op) {
    switch (op.type) {
    case 'pencil': {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of op.points) {
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
        }
        const r = op.width / 2;
        return {x1: x1 - r, y1: y1 - r, x2: x2 + r, y2: y2 + r};
    }
    case 'rect':
    case 'arrow': {
        const pad = op.type === 'rect'
            ? op.width / 2
            : Math.max(op.width / 2, arrowHeadLength(op.width) * Math.sin(ARROW_HALF_ANGLE));
        return {
            x1: Math.min(op.x1, op.x2) - pad,
            y1: Math.min(op.y1, op.y2) - pad,
            x2: Math.max(op.x1, op.x2) + pad,
            y2: Math.max(op.y1, op.y2) + pad,
        };
    }
    case 'mosaic':
        return {
            x1: Math.min(op.x1, op.x2),
            y1: Math.min(op.y1, op.y2),
            x2: Math.max(op.x1, op.x2),
            y2: Math.max(op.y1, op.y2),
        };
    case 'text': {
        const [w, h] = textSize(op);
        return {x1: op.x, y1: op.y, x2: op.x + w, y2: op.y + h};
    }
    }
    throw new Error(`unknown op type: ${op.type}`);
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Whether (x, y) hits `op`. Strokes hit within max(tol, width / 2) of the
 * line; rectangles hit on their outline only, so a big frame never shadows
 * the layers inside it; mosaics and text hit anywhere inside their box.
 */
export function hitOp(op, x, y, tol) {
    switch (op.type) {
    case 'pencil': {
        const t = Math.max(tol, op.width / 2);
        const pts = op.points;
        if (pts.length === 1)
            return Math.hypot(x - pts[0][0], y - pts[0][1]) <= t;
        for (let i = 1; i < pts.length; i++) {
            if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= t)
                return true;
        }
        return false;
    }
    case 'arrow':
        return distToSegment(x, y, op.x1, op.y1, op.x2, op.y2) <= Math.max(tol, op.width / 2);
    case 'rect': {
        const t = Math.max(tol, op.width / 2);
        const left = Math.min(op.x1, op.x2);
        const right = Math.max(op.x1, op.x2);
        const top = Math.min(op.y1, op.y2);
        const bottom = Math.max(op.y1, op.y2);
        const inOuter = x >= left - t && x <= right + t && y >= top - t && y <= bottom + t;
        const inInner = x > left + t && x < right - t && y > top + t && y < bottom - t;
        return inOuter && !inInner;
    }
    case 'mosaic':
    case 'text': {
        const b = opBounds(op);
        return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
    }
    }
    return false;
}

/** Index of the topmost op hit at (x, y), or -1. `type` limits the search. */
export function hitTest(ops, x, y, tol, type = null) {
    for (let i = ops.length - 1; i >= 0; i--) {
        if ((type === null || ops[i].type === type) && hitOp(ops[i], x, y, tol))
            return i;
    }
    return -1;
}

export function translateOp(op, dx, dy) {
    switch (op.type) {
    case 'pencil':
        return {...op, points: op.points.map(([x, y]) => [x + dx, y + dy])};
    case 'rect':
    case 'arrow':
    case 'mosaic':
        return {...op, x1: op.x1 + dx, y1: op.y1 + dy, x2: op.x2 + dx, y2: op.y2 + dy};
    case 'text':
        return {...op, x: op.x + dx, y: op.y + dy};
    }
    throw new Error(`unknown op type: ${op.type}`);
}

/**
 * Limit a move so the op's bounds stay inside the image. Staying put is
 * always allowed, even if the bounds already overhang the edge (stroke pad).
 */
export function clampMove(op, dx, dy, imgW, imgH) {
    const b = opBounds(op);
    return [
        Math.min(Math.max(0, imgW - b.x2), Math.max(Math.min(0, -b.x1), dx)),
        Math.min(Math.max(0, imgH - b.y2), Math.max(Math.min(0, -b.y1), dy)),
    ];
}

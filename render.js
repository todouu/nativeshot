// Pure Cairo/Pango rendering of annotation operations (image-pixel coordinates).
// No Shell/St dependencies so it can be exercised with plain `gjs -m`.

import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

export const ARROW_HALF_ANGLE = Math.PI / 7.2; // 25 degrees

export function arrowHeadLength(width) {
    return Math.max(12, width * 4);
}

export function hexToRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

export function mosaicBlockSize(imgW, imgH) {
    return Math.max(8, Math.round(Math.min(imgW, imgH) / 80));
}

function drawPencil(cr, op) {
    cr.setSourceRGB(...op.color);
    cr.setLineWidth(op.width);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);

    const [first, ...rest] = op.points;
    if (rest.length === 0) {
        cr.arc(first[0], first[1], op.width / 2, 0, 2 * Math.PI);
        cr.fill();
        return;
    }
    cr.moveTo(first[0], first[1]);
    for (const [x, y] of rest)
        cr.lineTo(x, y);
    cr.stroke();
}

function drawRect(cr, op) {
    const x = Math.min(op.x1, op.x2);
    const y = Math.min(op.y1, op.y2);
    cr.setSourceRGB(...op.color);
    cr.setLineWidth(op.width);
    cr.setLineJoin(Cairo.LineJoin.MITER);
    cr.rectangle(x, y, Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
    cr.stroke();
}

function drawArrow(cr, op) {
    const dx = op.x2 - op.x1;
    const dy = op.y2 - op.y1;
    const length = Math.hypot(dx, dy);
    if (length < 2)
        return;

    const angle = Math.atan2(dy, dx);
    const headLen = arrowHeadLength(op.width);
    // Shaft ends at the centre of the head base so its width never pokes
    // through the triangle's slanted sides.
    const shaftLen = Math.max(0, length - headLen * Math.cos(ARROW_HALF_ANGLE));

    cr.setSourceRGB(...op.color);
    if (shaftLen > 0) {
        cr.setLineWidth(op.width);
        cr.setLineCap(Cairo.LineCap.BUTT);
        cr.moveTo(op.x1, op.y1);
        cr.lineTo(op.x1 + Math.cos(angle) * shaftLen, op.y1 + Math.sin(angle) * shaftLen);
        cr.stroke();
    }

    cr.moveTo(op.x2, op.y2);
    cr.lineTo(
        op.x2 - headLen * Math.cos(angle - ARROW_HALF_ANGLE),
        op.y2 - headLen * Math.sin(angle - ARROW_HALF_ANGLE));
    cr.lineTo(
        op.x2 - headLen * Math.cos(angle + ARROW_HALF_ANGLE),
        op.y2 - headLen * Math.sin(angle + ARROW_HALF_ANGLE));
    cr.closePath();
    cr.fill();
}

function drawMosaic(cr, op, surface, imgW, imgH) {
    const x = Math.max(0, Math.floor(Math.min(op.x1, op.x2)));
    const y = Math.max(0, Math.floor(Math.min(op.y1, op.y2)));
    const w = Math.min(imgW, Math.ceil(Math.max(op.x1, op.x2))) - x;
    const h = Math.min(imgH, Math.ceil(Math.max(op.y1, op.y2))) - y;
    if (w < 1 || h < 1)
        return;

    const block = op.block;

    // Copy the region currently under the mosaic (annotations included).
    const region = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
    let rcr = new Cairo.Context(region);
    rcr.setSourceSurface(surface, -x, -y);
    rcr.paint();
    rcr.$dispose();

    // Downsample to one pixel per block.
    const small = new Cairo.ImageSurface(
        Cairo.Format.ARGB32, Math.ceil(w / block), Math.ceil(h / block));
    rcr = new Cairo.Context(small);
    rcr.scale(1 / block, 1 / block);
    const down = new Cairo.SurfacePattern(region);
    down.setExtend(Cairo.Extend.PAD); // partial edge blocks must not fade to transparent
    rcr.setSource(down);
    rcr.paint();
    rcr.$dispose();

    // Upscale with nearest-neighbour into the mosaic rectangle.
    cr.rectangle(x, y, w, h);
    cr.clip();
    cr.translate(x, y);
    cr.scale(block, block);
    const up = new Cairo.SurfacePattern(small);
    up.setFilter(Cairo.Filter.NEAREST);
    cr.setSource(up);
    cr.paint();

    region.finish();
    small.finish();
}

function textLayout(cr, op) {
    const layout = PangoCairo.create_layout(cr);
    const font = Pango.FontDescription.from_string('Sans Bold');
    font.set_absolute_size(op.size * Pango.SCALE);
    layout.set_font_description(font);
    layout.set_text(op.text, -1);
    return layout;
}

function drawText(cr, op) {
    const layout = textLayout(cr, op);
    cr.setSourceRGB(...op.color);
    cr.moveTo(op.x, op.y);
    PangoCairo.show_layout(cr, layout);
}

let measureSurface = null;
let measureCr = null;

/** Laid-out pixel size [w, h] of a text op. */
export function textSize(op) {
    if (!measureCr) {
        measureSurface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
        measureCr = new Cairo.Context(measureSurface);
    }
    return textLayout(measureCr, op).get_pixel_size();
}

/** Free the shared measuring context; the extension calls this from disable(). */
export function releaseMeasureContext() {
    measureCr?.$dispose();
    measureSurface?.finish();
    measureCr = null;
    measureSurface = null;
}

/**
 * Draw one operation onto `cr`. `surface` is the surface `cr` draws on; the
 * mosaic reads from it, so it must contain everything beneath the operation.
 */
export function drawOp(cr, op, surface, imgW, imgH) {
    cr.save();
    switch (op.type) {
    case 'pencil':
        drawPencil(cr, op);
        break;
    case 'rect':
        drawRect(cr, op);
        break;
    case 'arrow':
        drawArrow(cr, op);
        break;
    case 'mosaic':
        drawMosaic(cr, op, surface, imgW, imgH);
        break;
    case 'text':
        drawText(cr, op);
        break;
    }
    cr.restore();
}

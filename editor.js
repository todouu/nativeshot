// Full-screen overlay editor shown after a GNOME screenshot has been saved.

import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {drawOp, hexToRgb, mosaicBlockSize} from './render.js';
import {clampMove, hitTest, opBounds, translateOp} from './geometry.js';

const TOOLBAR_RESERVE = 60;
const TOOLBAR_GAP = 8;
const MIN_DRAG = 2;
const HIT_TOLERANCE_PX = 6; // screen pixels
const DRAG_START_PX = 3; // screen pixels before a click becomes a move
const DOUBLE_CLICK_MS = 400;

const TOOLS = [
    ['select', 'input-mouse-symbolic', 'Select'],
    ['pencil', 'document-edit-symbolic', 'Pencil'],
    ['rect', 'checkbox-symbolic', 'Rectangle'],
    ['arrow', 'go-next-symbolic', 'Arrow'],
    ['mosaic', 'view-grid-symbolic', 'Mosaic'],
    ['text', 'insert-text-symbolic', 'Text'],
];

const COLORS = [
    ['#e01b24', 'Red'],
    ['#f6d32d', 'Yellow'],
    ['#33d17a', 'Green'],
    ['#3584e4', 'Blue'],
    ['#000000', 'Black'],
    ['#ffffff', 'White'],
];

const WIDTHS = [2, 4, 8];

function makeButton(child, name, toggle) {
    return new St.Button({
        style_class: 'button',
        toggle_mode: toggle,
        accessible_name: name,
        reactive: true,
        can_focus: true,
        child,
    });
}

function makeIconButton(iconName, name, toggle) {
    return makeButton(new St.Icon({icon_name: iconName, icon_size: 16}), name, toggle);
}

function makeSeparator() {
    return new St.Widget({style_class: 'nativeshot-separator'});
}

// Black + white dashed outline, visible on any background.
function dashedBox(cr, scale, x, y, w, h) {
    cr.setLineWidth(1 / scale);
    cr.setSourceRGB(0, 0, 0);
    cr.rectangle(x, y, w, h);
    cr.stroke();
    cr.setSourceRGB(1, 1, 1);
    cr.setDash([6 / scale, 4 / scale], 0);
    cr.rectangle(x, y, w, h);
    cr.stroke();
    cr.setDash([], 0);
}

// Mutually exclusive toggle buttons; clicking the active one keeps it active.
function radioGroup(buttons, values, initial, onChange) {
    buttons.forEach((button, i) => {
        button.connect('clicked', () => {
            buttons.forEach((b, j) => b.set_checked(j === i));
            onChange(values[i]);
        });
    });
    buttons[initial].set_checked(true);
}

export const Editor = GObject.registerClass({
    Signals: {'closed': {}},
}, class Editor extends St.Widget {
    _init(path) {
        super._init({
            reactive: true,
            can_focus: true,
            style_class: 'nativeshot-backdrop',
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this.connect('destroy', () => this._onDestroy());

        this._path = path;
        this._ops = [];
        this._undoStack = []; // earlier `_ops` arrays; ops are never mutated
        this._redoStack = [];
        this._pending = null;
        this._entry = null;
        this._entryInfo = null;
        this._grab = null;
        this._committed = null;
        this._sel = -1; // selected op index (select tool)
        this._drag = null;
        this._hideIdx = -1; // op hidden while its text is being edited
        this._lastClick = null; // for double-click detection on text layers

        this._tool = 'pencil';
        this._colorHex = COLORS[0][0];
        this._color = hexToRgb(this._colorHex);
        this._width = 4;

        try {
            this._base = Cairo.ImageSurface.createFromPNG(path);
            this._imgW = this._base.getWidth();
            this._imgH = this._base.getHeight();
            if (this._imgW < 1 || this._imgH < 1)
                throw new Error(`empty image: ${path}`);
        } catch (e) {
            logError(e, `NativeShot: failed to load ${path}`);
            this._base = null;
            return;
        }

        this._buildUi();
        this._rebuild();

        this.connect('motion-event', (_actor, event) => this._onMotion(event));
        this.connect('button-release-event', (_actor, event) => this._onRelease(event));
    }

    _buildUi() {
        const monitor = Main.layoutManager.primaryMonitor;
        const availW = monitor.width * 0.9;
        const availH = monitor.height * 0.9 - TOOLBAR_RESERVE;
        this._scale = Math.min(1, availW / this._imgW, availH / this._imgH);

        const areaW = Math.round(this._imgW * this._scale);
        const areaH = Math.round(this._imgH * this._scale);
        const areaX = monitor.x + Math.round((monitor.width - areaW) / 2);
        const areaY = monitor.y + Math.round((monitor.height - areaH - TOOLBAR_RESERVE) / 2);

        this._area = new St.DrawingArea({
            reactive: true,
            x: areaX,
            y: areaY,
            width: areaW,
            height: areaH,
        });
        this._area.connect('repaint', area => this._onRepaint(area));
        this._area.connect('button-press-event', (_actor, event) => this._onPress(event));
        this.add_child(this._area);

        this._toolbar = this._buildToolbar();
        this._toolbar.set_position(areaX, areaY + areaH + TOOLBAR_GAP);
        this._toolbar.add_constraint(new Clutter.AlignConstraint({
            source: this._area,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        this.add_child(this._toolbar);
    }

    _buildToolbar() {
        const toolbar = new St.BoxLayout({style_class: 'nativeshot-toolbar'});

        const toolButtons = TOOLS.map(([, icon, name]) => makeIconButton(icon, name, true));
        toolButtons.forEach(b => toolbar.add_child(b));
        const initialTool = TOOLS.findIndex(t => t[0] === this._tool);
        radioGroup(toolButtons, TOOLS.map(t => t[0]), initialTool, tool => {
            this._commitEntry();
            this._tool = tool;
            this._select(-1);
        });
        toolbar.add_child(makeSeparator());

        const swatches = COLORS.map(([hex, name]) => {
            const button = makeButton(null, name, true);
            button.add_style_class_name('nativeshot-swatch');
            button.set_style(`background-color: ${hex};`);
            return button;
        });
        swatches.forEach(b => toolbar.add_child(b));
        radioGroup(swatches, COLORS.map(c => c[0]), 0, hex => {
            this._commitEntry();
            this._colorHex = hex;
            this._color = hexToRgb(hex);
        });
        toolbar.add_child(makeSeparator());

        const widthButtons = WIDTHS.map(w => makeButton(
            new St.Label({
                text: String(w),
                style_class: 'nativeshot-width-label',
                y_align: Clutter.ActorAlign.CENTER,
            }),
            `Width ${w}`, true));
        widthButtons.forEach(b => toolbar.add_child(b));
        radioGroup(widthButtons, WIDTHS, 1, width => {
            this._commitEntry();
            this._width = width;
        });
        toolbar.add_child(makeSeparator());

        const undo = makeIconButton('edit-undo-symbolic', 'Undo', false);
        undo.connect('clicked', () => this._undo());
        const redo = makeIconButton('edit-redo-symbolic', 'Redo', false);
        redo.connect('clicked', () => this._redoOp());
        toolbar.add_child(undo);
        toolbar.add_child(redo);
        toolbar.add_child(makeSeparator());

        const cancel = makeIconButton('window-close-symbolic', 'Cancel', false);
        cancel.connect('clicked', () => this.close());
        const save = makeIconButton('document-save-symbolic', 'Save', false);
        save.connect('clicked', () => this._save());
        toolbar.add_child(cancel);
        toolbar.add_child(save);

        return toolbar;
    }

    open() {
        if (!this._base) {
            this.destroy();
            return;
        }

        Main.layoutManager.uiGroup.add_child(this);
        this._grab = Main.pushModal(this);
        if (this._grab.get_seat_state() === Clutter.GrabState.NONE) {
            log('NativeShot: could not acquire modal grab, not opening editor');
            this.destroy();
            return;
        }
        this.grab_key_focus();
    }

    close() {
        this.destroy();
    }

    _onDestroy() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._pending = null;
        this._entry = null;
        this._base?.finish();
        this._committed?.finish();
        this._base = null;
        this._committed = null;
        this.emit('closed');
    }

    // ---- operations -------------------------------------------------------

    _pushHistory(ops) {
        this._undoStack.push(this._ops);
        this._redoStack = [];
        this._ops = ops;
    }

    _commit(op) {
        this._pushHistory([...this._ops, op]);
        // Appending never changes earlier results, so paint just the new op.
        const cr = new Cairo.Context(this._committed);
        drawOp(cr, op, this._committed, this._imgW, this._imgH);
        cr.$dispose();
        this._area.queue_repaint();
    }

    _undo() {
        this._commitEntry();
        if (this._drag || this._undoStack.length === 0)
            return;
        this._redoStack.push(this._ops);
        this._ops = this._undoStack.pop();
        this._sel = -1;
        this._rebuild();
    }

    _redoOp() {
        this._commitEntry();
        if (this._drag || this._redoStack.length === 0)
            return;
        this._undoStack.push(this._ops);
        this._ops = this._redoStack.pop();
        this._sel = -1;
        this._rebuild();
    }

    _rebuild() {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, this._imgW, this._imgH);
        const cr = new Cairo.Context(surface);
        cr.setSourceSurface(this._base, 0, 0);
        cr.paint();
        this._ops.forEach((op, i) => {
            if (i !== this._hideIdx)
                drawOp(cr, op, surface, this._imgW, this._imgH);
        });
        cr.$dispose();

        const old = this._committed;
        this._committed = surface;
        old?.finish();
        this._area.queue_repaint();
    }

    // ---- painting ---------------------------------------------------------

    _onRepaint(area) {
        const cr = area.get_context();
        const s = this._scale;
        cr.scale(s, s);
        cr.setSourceSurface(this._committed, 0, 0);
        cr.paint();

        const p = this._pending;
        if (p && p.type === 'mosaic') {
            // Pixelation is applied on release; show the selection only.
            dashedBox(cr, s, Math.min(p.x1, p.x2), Math.min(p.y1, p.y2),
                Math.abs(p.x2 - p.x1), Math.abs(p.y2 - p.y1));
        } else if (p) {
            drawOp(cr, p, this._committed, this._imgW, this._imgH);
        }

        const sel = this._tool === 'select' ? this._ops[this._sel] : null;
        if (sel) {
            const b = opBounds(sel);
            dashedBox(cr, s, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        }
        cr.$dispose();
    }

    // ---- pointer ----------------------------------------------------------

    _toImage(sx, sy) {
        const [, ax, ay] = this._area.transform_stage_point(sx, sy);
        return [
            Math.min(this._imgW, Math.max(0, ax / this._scale)),
            Math.min(this._imgH, Math.max(0, ay / this._scale)),
        ];
    }

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const [sx, sy] = event.get_coords();
        this._commitEntry();
        const [x, y] = this._toImage(sx, sy);
        const base = {color: this._color, width: this._width};

        switch (this._tool) {
        case 'select':
            this._pressSelect(event, x, y);
            return Clutter.EVENT_STOP;
        case 'text': {
            const hit = hitTest(this._ops, x, y, 0, 'text');
            if (hit >= 0)
                this._editText(hit);
            else
                this._startText(sx, sy, x, y);
            return Clutter.EVENT_STOP;
        }
        case 'pencil':
            this._pending = {type: 'pencil', ...base, points: [[x, y]]};
            break;
        case 'rect':
        case 'arrow':
            this._pending = {type: this._tool, ...base, x1: x, y1: y, x2: x, y2: y};
            break;
        case 'mosaic':
            this._pending = {
                type: 'mosaic',
                block: mosaicBlockSize(this._imgW, this._imgH),
                x1: x, y1: y, x2: x, y2: y,
            };
            break;
        }
        this._area.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const d = this._drag;
        if (d) {
            const [x, y] = this._toImage(...event.get_coords());
            if (!d.started && Math.hypot(x - d.x, y - d.y) * this._scale < DRAG_START_PX)
                return Clutter.EVENT_STOP;
            d.started = true;
            const [dx, dy] = clampMove(d.orig, x - d.x, y - d.y, this._imgW, this._imgH);
            if (dx !== d.dx || dy !== d.dy) {
                d.dx = dx;
                d.dy = dy;
                this._ops = d.before.slice();
                this._ops[d.idx] = translateOp(d.orig, dx, dy);
                this._rebuild();
            }
            return Clutter.EVENT_STOP;
        }

        const p = this._pending;
        if (!p)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = this._toImage(...event.get_coords());
        if (p.type === 'pencil') {
            const last = p.points[p.points.length - 1];
            if (last[0] === x && last[1] === y)
                return Clutter.EVENT_STOP;
            p.points.push([x, y]);
        } else {
            p.x2 = x;
            p.y2 = y;
        }
        this._area.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (this._drag && event.get_button() === Clutter.BUTTON_PRIMARY) {
            const d = this._drag;
            this._drag = null;
            if (d.dx !== 0 || d.dy !== 0) {
                this._undoStack.push(d.before);
                this._redoStack = [];
            } else if (d.started) {
                this._ops = d.before;
                this._rebuild();
            }
            return Clutter.EVENT_STOP;
        }

        const p = this._pending;
        if (!p || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        this._pending = null;
        if (p.type !== 'pencil') {
            const [x, y] = this._toImage(...event.get_coords());
            p.x2 = x;
            p.y2 = y;
        }

        const dx = Math.abs(p.x2 - p.x1);
        const dy = Math.abs(p.y2 - p.y1);
        let keep = true;
        if (p.type === 'rect' || p.type === 'mosaic')
            keep = dx >= MIN_DRAG && dy >= MIN_DRAG;
        else if (p.type === 'arrow')
            keep = Math.hypot(dx, dy) >= MIN_DRAG;

        if (keep)
            this._commit(p);
        else
            this._area.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    // ---- selection --------------------------------------------------------

    _select(idx) {
        this._sel = idx;
        this._area.queue_repaint();
    }

    _pressSelect(event, x, y) {
        const idx = hitTest(this._ops, x, y, HIT_TOLERANCE_PX / this._scale);
        this._select(idx);
        if (idx < 0)
            return;

        const now = event.get_time();
        const last = this._lastClick;
        const isDouble = last !== null && last.idx === idx &&
            now - last.time <= DOUBLE_CLICK_MS &&
            Math.hypot(x - last.x, y - last.y) * this._scale <= DRAG_START_PX * 2;
        this._lastClick = {idx, time: now, x, y};
        if (isDouble && this._ops[idx].type === 'text') {
            this._lastClick = null;
            this._editText(idx);
            return;
        }
        this._drag = {
            idx, x, y, dx: 0, dy: 0, started: false,
            orig: this._ops[idx],
            before: this._ops,
        };
    }

    // ---- text input -------------------------------------------------------

    _startText(sx, sy, x, y) {
        const [, ex, ey] = this.transform_stage_point(sx, sy);
        this._openEntry(ex, ey, {
            x, y, size: this._width * 6, color: this._color, idx: -1,
        }, '');
    }

    // Re-edit the text op at `idx` in place; its layer keeps its stacking slot.
    _editText(idx) {
        const op = this._ops[idx];
        this._sel = -1;
        this._hideIdx = idx;
        this._rebuild();
        this._openEntry(
            this._area.x + op.x * this._scale,
            this._area.y + op.y * this._scale,
            {x: op.x, y: op.y, size: op.size, color: op.color, idx},
            op.text);
    }

    _openEntry(ex, ey, info, text) {
        const [r, g, b] = info.color.map(c => Math.round(c * 255));
        const entry = new St.Entry({
            x: ex,
            y: ey,
            text,
            style: `font-size: ${info.size * this._scale}px; font-weight: bold; ` +
                `color: rgb(${r}, ${g}, ${b}); background-color: rgba(0, 0, 0, 0.3); ` +
                'padding: 0; border-width: 0; min-width: 100px;',
        });
        entry.clutter_text.connect('activate', () => this._commitEntry());
        entry.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._removeEntry();
            return Clutter.EVENT_STOP;
        });

        this._entry = entry;
        this._entryInfo = info;
        this.add_child(entry);
        entry.grab_key_focus();
    }

    _removeEntry() {
        if (!this._entry)
            return;
        this._entry.destroy();
        this._entry = null;
        this._entryInfo = null;
        if (this._hideIdx >= 0) {
            this._hideIdx = -1;
            this._rebuild();
        }
        this.grab_key_focus();
    }

    _commitEntry() {
        if (!this._entry)
            return;
        const text = this._entry.get_text().trim();
        const {idx, ...info} = this._entryInfo;
        this._removeEntry();

        if (idx < 0) {
            if (text)
                this._commit({type: 'text', text, ...info});
            return;
        }

        const old = this._ops[idx];
        if (text === old.text)
            return;
        // Emptying the text removes the layer.
        const ops = this._ops.slice();
        if (text)
            ops[idx] = {...old, text};
        else
            ops.splice(idx, 1);
        this._pushHistory(ops);
        this._sel = text ? idx : -1;
        this._rebuild();
    }

    // ---- keyboard ---------------------------------------------------------

    vfunc_key_press_event(event) {
        // While the text entry is active it owns the keyboard.
        if (this._entry)
            return super.vfunc_key_press_event(event);

        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if ((sym === Clutter.KEY_Delete || sym === Clutter.KEY_KP_Delete) &&
            this._tool === 'select') {
            this._deleteSelected();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter ||
            (ctrl && (sym === Clutter.KEY_s || sym === Clutter.KEY_S))) {
            this._save();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_z || sym === Clutter.KEY_Z)) {
            if (shift)
                this._redoOp();
            else
                this._undo();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_y || sym === Clutter.KEY_Y)) {
            this._redoOp();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    _deleteSelected() {
        if (this._drag || !this._ops[this._sel])
            return;
        const ops = this._ops.slice();
        ops.splice(this._sel, 1);
        this._pushHistory(ops);
        this._sel = -1;
        this._rebuild();
    }

    // ---- save -------------------------------------------------------------

    _save() {
        this._commitEntry();
        if (this._ops.length === 0) {
            // File and clipboard already hold the untouched screenshot.
            this.close();
            return;
        }

        try {
            this._committed.writeToPNG(this._path);
            const [, contents] = Gio.File.new_for_path(this._path).load_contents(null);
            St.Clipboard.get_default().set_content(
                St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(contents));
        } catch (e) {
            logError(e, 'NativeShot: failed to save');
            Main.notifyError('NativeShot', `Failed to save edited screenshot: ${e.message}`);
            return;
        }
        this.close();
    }
});

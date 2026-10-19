import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Editor} from './editor.js';
import {releaseMeasureContext} from './render.js';

// ScreenshotUI.UIMode.SCREENSHOT_ONLY: interactive D-Bus/portal screenshot,
// the caller already received the URI, so editing would race with it.
const UI_MODE_SCREENSHOT_ONLY = 2;
const OPEN_DELAY_MS = 250;

export default class NativeShotExtension extends Extension {
    enable() {
        this._editor = null;
        this._openId = 0;
        this._captureId = 0;
        Main.screenshotUI.connectObject(
            'screenshot-taken', (_ui, file) => this._onShot(file), this);
        Main.screenshotUI._areaSelector.connectObject(
            'button-release-event', (selector, event) => this._onSelectorRelease(selector, event), this);
    }

    disable() {
        Main.screenshotUI.disconnectObject(this);
        Main.screenshotUI._areaSelector.disconnectObject(this);
        if (this._captureId) {
            GLib.source_remove(this._captureId);
            this._captureId = 0;
        }
        if (this._openId) {
            GLib.source_remove(this._openId);
            this._openId = 0;
        }
        this._editor?.destroy();
        this._editor = null;
        releaseMeasureContext();
    }

    // Right-button drag in the area selector captures on release, as Enter would.
    // Runs before the selector's own handler, so `_dragButton` is still set.
    _onSelectorRelease(selector, event) {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY ||
            selector._dragButton !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;

        // A click without movement only gets a made-up selection; leave it for Enter.
        if (selector._lastX === selector._startX && selector._lastY === selector._startY)
            return Clutter.EVENT_PROPAGATE;

        if (this._captureId)
            return Clutter.EVENT_PROPAGATE;

        // Defer until the selector has finished the drag so the geometry is final.
        this._captureId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._captureId = 0;
            const ui = Main.screenshotUI;
            // Screenshot mode only: Enter in screencast mode would start recording.
            if (ui.visible && ui._shotButton.checked && ui._selectionButton.checked)
                ui._onCaptureButtonClicked();
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    }

    _onShot(file) {
        if (Main.screenshotUI._currentMode === UI_MODE_SCREENSHOT_ONLY)
            return;
        if (this._editor || this._openId)
            return;

        const path = file?.get_path();
        if (!path)
            return;

        // Wait for the screenshot UI fade-out (200ms) so its modal grab is gone.
        this._openId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_DELAY_MS, () => {
            this._openId = 0;
            this._open(path);
            return GLib.SOURCE_REMOVE;
        });
    }

    _open(path) {
        const editor = new Editor(path);
        this._editor = editor;
        editor.connect('closed', () => {
            if (this._editor === editor)
                this._editor = null;
        });
        editor.open();
    }
}

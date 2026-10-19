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
        Main.screenshotUI.connectObject(
            'screenshot-taken', (_ui, file) => this._onShot(file), this);
    }

    disable() {
        Main.screenshotUI.disconnectObject(this);
        if (this._openId) {
            GLib.source_remove(this._openId);
            this._openId = 0;
        }
        this._editor?.destroy();
        this._editor = null;
        releaseMeasureContext();
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

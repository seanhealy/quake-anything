import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    computeQuakeRect,
    getPointerMonitorIndex,
    isValidRect,
    percentFromRect,
    sanitizeMonitorIndex,
    slideOffsetForSide,
} from './geometry.js';
import {formatMessage, type QuakeEntry} from './types.js';

const ANIM_MS = 180;
const CLAIM_TIMEOUT_MS = 8000;
const FIRST_FRAME_FALLBACK_MS = 750;

interface PendingClaim {
    entryId: string;
    appId: string;
    timeoutId: number;
}

interface FirstFrameWatch {
    actor: Clutter.Actor;
    signalId: number;
    fallbackId: number;
}

/** Shell 49+: unmaximize with no flags argument. */
function unmaximizeWindow(win: Meta.Window): void {
    if (win.get_maximize_flags() !== 0)
        win.unmaximize();
}

export class QuakeManager {
    private _entries = new Map<string, QuakeEntry>();
    private _windows = new Map<string, Meta.Window>();
    private _livePercent = new Map<string, number>();
    private _lastMonitor = new Map<string, number>();
    private _pending: PendingClaim | null = null;
    private _windowCreatedId = 0;
    private _enteredMonitorId = 0;
    private _animating = new Set<string>();
    private _applyingGeometry = new Set<string>();
    private _sourceIds = new Set<number>();
    private _unmanagedIds = new Map<string, number>();
    private _firstFrameWatches = new Map<string, FirstFrameWatch>();

    enable(): void {
        this._windowCreatedId = global.display.connect(
            'window-created',
            (_d, win) => this._onWindowCreated(win),
        );
        this._enteredMonitorId = global.display.connect(
            'window-entered-monitor',
            (_d, monitorIndex, win) => this._onEnteredMonitor(monitorIndex, win),
        );
    }

    disable(): void {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._enteredMonitorId) {
            global.display.disconnect(this._enteredMonitorId);
            this._enteredMonitorId = 0;
        }
        this._clearPending();
        this._clearSources();
        for (const id of [...this._windows.keys()])
            this._detachWindow(id, false);
        this._entries.clear();
        this._livePercent.clear();
        this._lastMonitor.clear();
        this._applyingGeometry.clear();
        this._animating.clear();
        this._unmanagedIds.clear();
        this._firstFrameWatches.clear();
    }

    setEntries(entries: QuakeEntry[]): void {
        const nextIds = new Set(entries.map(e => e.id));
        for (const id of [...this._entries.keys()]) {
            if (!nextIds.has(id)) {
                this._detachWindow(id, false);
                this._livePercent.delete(id);
                this._lastMonitor.delete(id);
            }
        }

        this._entries.clear();
        for (const entry of entries)
            this._entries.set(entry.id, entry);
    }

    getEntry(id: string): QuakeEntry | undefined {
        return this._entries.get(id);
    }

    toggle(entryId: string): void {
        const entry = this._entries.get(entryId);
        if (!entry)
            return;

        const win = this._windows.get(entryId);
        if (!win || !this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            this._spawn(entry);
            return;
        }

        if (this._isVisible(win))
            this._hide(entryId, win, entry);
        else
            this._show(entryId, win, entry);
    }

    private _isWindowAlive(win: Meta.Window | null | undefined): boolean {
        if (!win)
            return false;
        try {
            return win.get_compositor_private() != null;
        } catch {
            return false;
        }
    }

    private _spawn(entry: QuakeEntry): void {
        const app = this._resolveApp(entry.appId);
        if (!app) {
            Main.notify(
                _('Quake Anything'),
                formatMessage(_('Could not find app: %s'), entry.appId),
            );
            return;
        }

        this._clearPending();
        const timeoutId = this._timeoutAdd(GLib.PRIORITY_DEFAULT, CLAIM_TIMEOUT_MS, () => {
            if (this._pending?.entryId === entry.id) {
                Main.notify(
                    _('Quake Anything'),
                    formatMessage(_('Timed out waiting for %s'), entry.appId),
                );
                this._pending = null;
            }
            return GLib.SOURCE_REMOVE;
        });
        this._pending = {
            entryId: entry.id,
            appId: this._normalizeAppId(entry.appId),
            timeoutId,
        };

        try {
            if (app.can_open_new_window()) {
                app.open_new_window(-1);
            } else {
                const workspace = global.workspace_manager.get_active_workspace_index();
                app.launch(global.get_current_time(), workspace, Shell.AppLaunchGpu.APP_PREF);
            }
        } catch (e) {
            this._clearPending();
            Main.notify(
                _('Quake Anything'),
                formatMessage(_('Failed to launch %s'), entry.appId),
            );
            console.error('[quake-anything] launch failed', e);
        }
    }

    private _onWindowCreated(win: Meta.Window): void {
        const pending = this._pending;
        if (!pending)
            return;

        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._pending || this._pending.entryId !== pending.entryId)
                return GLib.SOURCE_REMOVE;
            if (!this._isWindowAlive(win))
                return GLib.SOURCE_REMOVE;

            if (!this._windowMatchesPending(win, pending.appId)) {
                this._timeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (!this._pending || this._pending.entryId !== pending.entryId)
                        return GLib.SOURCE_REMOVE;
                    if (!this._isWindowAlive(win))
                        return GLib.SOURCE_REMOVE;
                    if (this._windowMatchesPending(win, pending.appId))
                        this._claimWindow(pending.entryId, win);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }

            this._claimWindow(pending.entryId, win);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _windowMatchesPending(win: Meta.Window, appId: string): boolean {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app)
            return false;
        return this._normalizeAppId(app.get_id()) === this._normalizeAppId(appId);
    }

    private _claimWindow(entryId: string, win: Meta.Window): void {
        const entry = this._entries.get(entryId);
        if (!entry || !this._isWindowAlive(win))
            return;

        this._clearPending();

        const existing = this._windows.get(entryId);
        if (existing && existing !== win)
            this._detachWindow(entryId, false);

        this._windows.set(entryId, win);
        this._livePercent.delete(entryId);
        this._lastMonitor.delete(entryId);

        const unmanagedId = win.connect('unmanaged', () => {
            if (this._windows.get(entryId) === win)
                this._detachWindow(entryId, true);
        });
        this._unmanagedIds.set(entryId, unmanagedId);

        const place = () => {
            this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._windows.get(entryId) !== win || !this._isWindowAlive(win))
                    return GLib.SOURCE_REMOVE;
                this._applyQuakeGeometry(entryId, win, entry, true);
                this._show(entryId, win, entry);
                return GLib.SOURCE_REMOVE;
            });
        };

        const actor = this._isWindowAlive(win)
            ? win.get_compositor_private() as Clutter.Actor | null
            : null;

        if (actor) {
            this._clearFirstFrameWatch(entryId);
            const signalId = actor.connect('first-frame', () => {
                this._clearFirstFrameWatch(entryId);
                place();
            });
            const fallbackId = this._timeoutAdd(
                GLib.PRIORITY_DEFAULT,
                FIRST_FRAME_FALLBACK_MS,
                () => {
                    const watch = this._firstFrameWatches.get(entryId);
                    if (!watch || watch.fallbackId !== fallbackId)
                        return GLib.SOURCE_REMOVE;
                    this._clearFirstFrameWatch(entryId);
                    place();
                    return GLib.SOURCE_REMOVE;
                },
            );
            this._firstFrameWatches.set(entryId, { actor, signalId, fallbackId });
        } else {
            this._timeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                place();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _detachWindow(entryId: string, resetSessionState: boolean): void {
        const win = this._windows.get(entryId);
        this._disconnectUnmanaged(entryId, win);
        this._clearFirstFrameWatch(entryId);

        this._animating.delete(entryId);
        if (win && this._isWindowAlive(win)) {
            const actor = win.get_compositor_private() as Clutter.Actor | null;
            if (actor) {
                actor.remove_all_transitions();
                actor.set_translation(0, 0, 0);
            }
        }

        this._windows.delete(entryId);
        this._applyingGeometry.delete(entryId);
        if (resetSessionState) {
            this._livePercent.delete(entryId);
            this._lastMonitor.delete(entryId);
        }
    }

    private _disconnectUnmanaged(entryId: string, win?: Meta.Window): void {
        const signalId = this._unmanagedIds.get(entryId);
        this._unmanagedIds.delete(entryId);
        if (signalId == null || !win)
            return;
        win.disconnect(signalId);
    }

    private _clearFirstFrameWatch(entryId: string): void {
        const watch = this._firstFrameWatches.get(entryId);
        this._firstFrameWatches.delete(entryId);
        if (!watch)
            return;
        if (watch.fallbackId)
            this._removeSource(watch.fallbackId);
        watch.actor.disconnect(watch.signalId);
    }

    private _entryIdForWindow(win: Meta.Window): string | null {
        for (const [id, owned] of this._windows) {
            if (owned === win)
                return id;
        }
        return null;
    }

    private _onEnteredMonitor(monitorIndex: number, win: Meta.Window): void {
        const entryId = this._entryIdForWindow(win);
        if (!entryId)
            return;
        if (this._applyingGeometry.has(entryId) || this._animating.has(entryId))
            return;
        if (!this._isWindowAlive(win))
            return;

        const entry = this._entries.get(entryId);
        if (!entry)
            return;

        const safeIndex = sanitizeMonitorIndex(monitorIndex);
        if (win.minimized || !this._isVisible(win)) {
            this._lastMonitor.set(entryId, safeIndex);
            return;
        }

        const previous = this._lastMonitor.get(entryId);
        this._lastMonitor.set(entryId, safeIndex);
        if (previous === safeIndex)
            return;

        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._windows.get(entryId) !== win || !this._isWindowAlive(win))
                return GLib.SOURCE_REMOVE;
            this._applyQuakeGeometry(entryId, win, entry, false);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _effectivePercent(entryId: string, entry: QuakeEntry): number {
        return this._livePercent.get(entryId) ?? entry.sizePercent;
    }

    private _rememberQuakePercent(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (!this._isWindowAlive(win))
            return;

        const frame = win.get_frame_rect();
        const monitor = sanitizeMonitorIndex(win.get_monitor());
        const percent = percentFromRect(
            entry.side,
            { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
            monitor,
        );
        this._livePercent.set(entryId, percent);
        this._lastMonitor.set(entryId, monitor);
    }

    private _applyQuakeGeometry(
        entryId: string,
        win: Meta.Window,
        entry: QuakeEntry,
        usePointerMonitor: boolean,
    ): void {
        if (!this._isWindowAlive(win))
            return;

        const percent = this._effectivePercent(entryId, entry);
        const rawMonitor = usePointerMonitor
            ? getPointerMonitorIndex()
            : win.get_monitor();
        const monitor = sanitizeMonitorIndex(rawMonitor);
        const rect = computeQuakeRect(entry.side, percent, monitor);
        if (!isValidRect(rect)) {
            console.error('[quake-anything] refusing invalid quake rect', rect);
            return;
        }

        this._applyingGeometry.add(entryId);
        try {
            unmaximizeWindow(win);

            if (sanitizeMonitorIndex(win.get_monitor()) !== monitor)
                win.move_to_monitor(monitor);

            const workspace = global.workspace_manager.get_active_workspace();
            if (!win.located_on_workspace(workspace))
                win.change_workspace(workspace);

            win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            this._lastMonitor.set(entryId, monitor);
            if (!this._livePercent.has(entryId))
                this._livePercent.set(entryId, percent);
        } finally {
            this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._applyingGeometry.delete(entryId);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _isVisible(win: Meta.Window): boolean {
        if (!this._isWindowAlive(win))
            return false;
        if (win.minimized)
            return false;
        const actor = win.get_compositor_private() as Clutter.Actor | null;
        return !!(actor && actor.visible);
    }

    private _show(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (this._animating.has(entryId))
            return;
        if (!this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            return;
        }

        if (win.minimized)
            win.unminimize();

        this._applyQuakeGeometry(entryId, win, entry, false);

        if (!this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            return;
        }

        win.activate(global.get_current_time());

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (!actor)
            return;

        const rect = computeQuakeRect(
            entry.side,
            this._effectivePercent(entryId, entry),
            sanitizeMonitorIndex(win.get_monitor()),
        );
        if (!isValidRect(rect))
            return;

        const offset = slideOffsetForSide(entry.side, rect);
        actor.remove_all_transitions();
        actor.set_translation(offset.x, offset.y, 0);
        this._animating.add(entryId);
        actor.ease({
            translationX: 0,
            translationY: 0,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                this._animating.delete(entryId);
            },
        });
    }

    private _hide(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (this._animating.has(entryId))
            return;
        if (!this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            return;
        }

        this._rememberQuakePercent(entryId, win, entry);

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (actor) {
            actor.remove_all_transitions();
            actor.set_translation(0, 0, 0);
        }
        this._animating.delete(entryId);

        win.minimize();
    }

    private _resolveApp(appId: string): Shell.App | null {
        const context = Shell.AppSystem.get_default();
        const raw = appId.trim();
        const candidates = [
            raw,
            raw.endsWith('.desktop') ? raw : `${raw}.desktop`,
            raw.replace(/\.desktop$/i, ''),
        ];

        for (const id of candidates) {
            const app = context.lookup_app(id);
            if (app)
                return app;
        }

        const desktopId = raw.endsWith('.desktop') ? raw : `${raw}.desktop`;
        const info = GioUnix.DesktopAppInfo.new(desktopId);
        if (info) {
            const id = info.get_id();
            if (id) {
                const app = context.lookup_app(id);
                if (app)
                    return app;
            }
        }
        return null;
    }

    private _normalizeAppId(appId: string): string {
        return appId.trim().replace(/\.desktop$/i, '').toLowerCase();
    }

    private _idleAdd(priority: number, callback: () => boolean): number {
        let sourceId = 0;
        sourceId = GLib.idle_add(priority, () => {
            this._sourceIds.delete(sourceId);
            return callback();
        });
        this._sourceIds.add(sourceId);
        return sourceId;
    }

    private _timeoutAdd(priority: number, intervalMs: number, callback: () => boolean): number {
        let sourceId = 0;
        sourceId = GLib.timeout_add(priority, intervalMs, () => {
            this._sourceIds.delete(sourceId);
            return callback();
        });
        this._sourceIds.add(sourceId);
        return sourceId;
    }

    private _removeSource(sourceId: number): void {
        if (!this._sourceIds.has(sourceId))
            return;
        this._sourceIds.delete(sourceId);
        GLib.Source.remove(sourceId);
    }

    private _clearSources(): void {
        for (const sourceId of this._sourceIds)
            GLib.Source.remove(sourceId);
        this._sourceIds.clear();
    }

    private _clearPending(): void {
        if (this._pending?.timeoutId)
            this._removeSource(this._pending.timeoutId);
        this._pending = null;
    }
}

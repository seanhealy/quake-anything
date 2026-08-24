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
    app: Shell.App;
    /** Window ids the app already owned when we launched; the claimed
     *  window is the first NORMAL one that is not in this set. */
    before: Set<number>;
    timeoutId: number;
}

interface FirstFrameWatch {
    actor: Clutter.Actor;
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
    /** Stable Meta.Window id of the window we claimed for each entry, kept
     *  independently of _windows so a lost-but-still-alive window can be
     *  re-adopted instead of spawning a duplicate. */
    private _windowIds = new Map<string, number>();
    private _livePercent = new Map<string, number>();
    private _lastMonitor = new Map<string, number>();
    private _pending: PendingClaim | null = null;
    private _animating = new Set<string>();
    private _applyingGeometry = new Set<string>();
    private _sourceIds = new Set<number>();
    private _firstFrameWatches = new Map<string, FirstFrameWatch>();

    enable(): void {
        global.display.connectObject(
            'window-created',
            (_d: Meta.Display, win: Meta.Window) => this._onWindowCreated(win),
            'window-entered-monitor',
            (_d: Meta.Display, monitorIndex: number, win: Meta.Window) =>
                this._onEnteredMonitor(monitorIndex, win),
            this,
        );
    }

    disable(): void {
        global.display.disconnectObject(this);
        this._clearPending();
        this._clearSources();
        for (const id of [...this._windows.keys()])
            this._detachWindow(id, false);
        this._entries.clear();
        this._windowIds.clear();
        this._livePercent.clear();
        this._lastMonitor.clear();
        this._applyingGeometry.clear();
        this._animating.clear();
        this._firstFrameWatches.clear();
    }

    setEntries(entries: QuakeEntry[]): void {
        const nextIds = new Set(entries.map(e => e.id));
        for (const id of [...this._entries.keys()]) {
            if (!nextIds.has(id)) {
                this._detachWindow(id, false);
                this._windowIds.delete(id);
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

        let win = this._windows.get(entryId);
        if (!win || !this._isWindowAlive(win)) {
            // We lost the mapping but the window we spawned may still be
            // alive; re-adopt it before falling back to a fresh spawn so we
            // don't leave single-instance apps stuck or open duplicates.
            const readopted = this._tryReadopt(entryId, entry);
            if (!readopted) {
                this._detachWindow(entryId, true);
                this._spawn(entry);
                return;
            }
            win = readopted;
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

        // Single-instance apps can't open a second window, so app.launch()
        // would just refocus the running instance and never notify us. If the
        // app already has a usable window, adopt that one instead of a no-op
        // launch (this is what keeps single-window apps from "stopping").
        if (!app.can_open_new_window()) {
            const existing = this._firstNormalWindow(app);
            if (existing) {
                this._clearPending();
                this._attachWindow(entry.id, existing);
                this._livePercent.delete(entry.id);
                this._lastMonitor.delete(entry.id);
                this._show(entry.id, existing, entry);
                return;
            }
        }

        this._clearPending();
        const before = new Set(
            app.get_windows().map(w => w.get_id()),
        );
        const timeoutId = this._timeoutAdd(GLib.PRIORITY_DEFAULT, CLAIM_TIMEOUT_MS, () => {
            if (this._pending?.entryId === entry.id) {
                Main.notify(
                    _('Quake Anything'),
                    formatMessage(_('Timed out waiting for %s'), entry.appId),
                );
                this._clearPending();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._pending = { entryId: entry.id, app, before, timeoutId };

        // The app's own window list is authoritative; claim the first new
        // window it reports. window-created is kept as a secondary trigger for
        // apps whose windows-changed timing lags the compositor.
        app.connectObject(
            'windows-changed',
            () => this._tryClaimFromApp(entry.id),
            this,
        );

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

    private _onWindowCreated(_win: Meta.Window): void {
        const pending = this._pending;
        if (!pending)
            return;

        // Defer a tick so the shell can associate the new window with its app.
        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._tryClaimFromApp(pending.entryId);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Claim the first newly-appeared NORMAL window of the pending app. */
    private _tryClaimFromApp(entryId: string): void {
        const pending = this._pending;
        if (!pending || pending.entryId !== entryId)
            return;
        const win = this._findNewWindow(pending);
        if (win)
            this._claimWindow(entryId, win);
    }

    private _findNewWindow(pending: PendingClaim): Meta.Window | null {
        for (const win of pending.app.get_windows()) {
            if (!this._isWindowAlive(win))
                continue;
            if (win.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (pending.before.has(win.get_id()))
                continue;
            return win;
        }
        return null;
    }

    private _firstNormalWindow(app: Shell.App): Meta.Window | null {
        for (const win of app.get_windows()) {
            if (this._isWindowAlive(win) && win.get_window_type() === Meta.WindowType.NORMAL)
                return win;
        }
        return null;
    }

    /**
     * Re-adopt the exact window we previously spawned for this entry if it is
     * still alive. Matching on the remembered stable id (never an arbitrary
     * window of the app) keeps the "only control windows we spawned" contract.
     */
    private _tryReadopt(entryId: string, entry: QuakeEntry): Meta.Window | null {
        const rememberedId = this._windowIds.get(entryId);
        if (rememberedId == null)
            return null;

        const app = this._resolveApp(entry.appId);
        if (!app)
            return null;

        const match = app.get_windows().find(
            w => this._isWindowAlive(w) && w.get_id() === rememberedId,
        );
        if (!match)
            return null;

        this._attachWindow(entryId, match);
        return match;
    }

    /** Record a window as this entry's, wiring its destroy handler. */
    private _attachWindow(entryId: string, win: Meta.Window): void {
        const existing = this._windows.get(entryId);
        if (existing && existing !== win)
            this._detachWindow(entryId, false);

        this._windows.set(entryId, win);
        this._windowIds.set(entryId, win.get_id());

        win.connectObject('unmanaged', () => {
            if (this._windows.get(entryId) === win)
                this._detachWindow(entryId, true);
        }, this);
    }

    private _claimWindow(entryId: string, win: Meta.Window): void {
        const entry = this._entries.get(entryId);
        if (!entry || !this._isWindowAlive(win))
            return;

        this._clearPending();
        this._attachWindow(entryId, win);
        this._livePercent.delete(entryId);
        this._lastMonitor.delete(entryId);

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
            actor.connectObject('first-frame', () => {
                this._clearFirstFrameWatch(entryId);
                place();
            }, this);
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
            this._firstFrameWatches.set(entryId, { actor, fallbackId });
        } else {
            this._timeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                place();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _detachWindow(entryId: string, resetSessionState: boolean): void {
        const win = this._windows.get(entryId);
        win?.disconnectObject(this);
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

    private _clearFirstFrameWatch(entryId: string): void {
        const watch = this._firstFrameWatches.get(entryId);
        this._firstFrameWatches.delete(entryId);
        if (!watch)
            return;
        if (watch.fallbackId)
            this._removeSource(watch.fallbackId);
        watch.actor.disconnectObject(this);
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
        if (this._pending) {
            if (this._pending.timeoutId)
                this._removeSource(this._pending.timeoutId);
            this._pending.app.disconnectObject(this);
        }
        this._pending = null;
    }
}

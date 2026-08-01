// GNOME Shell's js/misc/signalTracker.js patches connectObject/disconnectObject
// onto GObject.Object at runtime (see resource:///org/gnome/shell/ui/environment.js).
// Declare it explicitly on the base class here so every GObject subclass we use
// (Gio.Settings, Meta.Display, Meta.Window, Clutter.Actor) is typed without
// needing `any` casts at call sites.
//
// @see https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/misc/signalTracker.js
declare module '@girs/gobject-2.0/gobject-2.0' {
    namespace GObject {
        interface Object {
            /**
             * Connect one or more signals, associating the handlers with a
             * tracked object. All handlers for that object can be disconnected
             * at once via `disconnectObject()`.
             *
             * @param args a sequence of signal-name/handler pairs, followed by
             * the object to track the connections under
             */
            connectObject(...args: any[]): void;

            /**
             * Disconnect all signals previously connected via `connectObject()`
             * for the given tracked object.
             */
            disconnectObject(obj: object): void;
        }
    }
}

export {};

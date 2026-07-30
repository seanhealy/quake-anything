import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Best-effort conflict scan of system keyboard shortcut schemas.
 * Prefs cannot use Meta/Shell; this only covers known GSettings keybindings.
 */
export function findShortcutConflict(
    accelerator: string,
    excludeOurShortcuts: string[] = [],
): string | null {
    if (!accelerator)
        return null;

    const normalized = normalizeAccel(accelerator);
    if (!normalized)
        return null;

    for (const ours of excludeOurShortcuts) {
        if (normalizeAccel(ours) === normalized)
            return _('another Quake Anything entry');
    }

    const schemaSources = [
        'org.gnome.desktop.wm.keybindings',
        'org.gnome.shell.keybindings',
        'org.gnome.mutter.keybindings',
        'org.gnome.mutter.wayland.keybindings',
        'org.gnome.settings-daemon.plugins.media-keys',
    ];

    for (const schemaId of schemaSources) {
        const conflict = scanSchema(schemaId, normalized);
        if (conflict)
            return conflict;
    }

    return scanCustomMediaKeys(normalized);
}

function schemaExists(schemaId: string): boolean {
    const source = Gio.SettingsSchemaSource.get_default();
    if (!source)
        return false;
    return source.lookup(schemaId, true) !== null;
}

function scanSchema(schemaId: string, normalized: string): string | null {
    if (!schemaExists(schemaId))
        return null;

    const settings = new Gio.Settings({schema_id: schemaId});
    for (const key of settings.list_keys()) {
        const value = settings.get_value(key);
        if (!value)
            continue;
        if (value.get_type_string() === 'as') {
            for (const b of value.get_strv()) {
                if (normalizeAccel(b) === normalized)
                    return `${schemaId}.${key}`;
            }
        } else if (value.get_type_string() === 's') {
            const b = value.get_string()[0];
            if (normalizeAccel(b) === normalized)
                return `${schemaId}.${key}`;
        }
    }
    return null;
}

function scanCustomMediaKeys(normalized: string): string | null {
    const schemaId = 'org.gnome.settings-daemon.plugins.media-keys';
    const customSchema = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
    if (!schemaExists(schemaId) || !schemaExists(customSchema))
        return null;

    const settings = new Gio.Settings({schema_id: schemaId});
    const paths = settings.get_strv('custom-keybindings');

    for (const path of paths) {
        const custom = Gio.Settings.new_with_path(customSchema, path);
        const binding = custom.get_string('binding');
        const name = custom.get_string('name') || path;
        if (normalizeAccel(binding) === normalized)
            return `custom:${name}`;
    }
    return null;
}

export function normalizeAccel(accel: string): string {
    if (!accel)
        return '';
    const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
    if (!ok || keyval === 0 || mods == null)
        return accel.toLowerCase();
    return Gtk.accelerator_name(keyval, mods)?.toLowerCase() ?? accel.toLowerCase();
}

export function acceleratorIsValid(accel: string): boolean {
    if (!accel)
        return false;
    const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
    if (!ok || keyval === 0 || mods == null)
        return false;
    return Gtk.accelerator_valid(keyval, mods);
}

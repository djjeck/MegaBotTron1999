/**
 * Runtime settings (docs/bot-os-api.md §2, P11): what the owner changes while the instance runs,
 * declared by each plugin's manifest as a zod object, one schema per key. A key's schema takes the
 * value in its text form (`on`, `1200`, `a,b`, as a chat command or the command line sends it) or
 * as a value, and says why not; its description is its help.
 *
 * The owner's settings are kept in each plugin's own store (the core's `_settings` document) and
 * survive a redeploy (P8). The values in force are the plugins' own: a plugin puts its own in force
 * (`serveFor`, from its instance's `settings`), and for settings that live in the wiring's own
 * objects the instance's wiring does (`serve`: `apply` and `read`).
 *
 * The registry is what the control surfaces use: a bare key names the one plugin that has it, and
 * `plugin.key` names it when two plugins share a key.
 */
import { type z } from 'zod';

export type SettingValue = number | boolean | string | string[];

/** How settings are put in force and read: the instance's wiring. */
export interface SettingsBackend {
  apply(plugin: string, key: string, value: SettingValue): void;
  read(plugin: string, key: string): SettingValue | undefined;
}

/** The core's document of a plugin's kept settings. */
export const SETTINGS_DOC = '_settings';

/** One plugin's settings: its schema, and the owner's values kept in its store. */
export class PluginSettings {
  readonly plugin: string;
  private readonly schema: z.ZodObject;
  private readonly store: { get(name: string): unknown; put(name: string, value: unknown): void };
  private readonly values: Record<string, SettingValue> = {};

  /** The values kept, each checked again against its schema; an unknown or bad one is dropped. */
  constructor(
    plugin: string,
    schema: z.ZodObject,
    store: { get(name: string): unknown; put(name: string, value: unknown): void }
  ) {
    this.plugin = plugin;
    this.schema = schema;
    this.store = store;
    const kept = (store.get(SETTINGS_DOC) ?? {}) as Record<string, unknown>;
    for (const [key, raw] of Object.entries(kept)) {
      const parsed = this.parse(key, raw);
      if ('value' in parsed) this.values[key] = parsed.value;
    }
  }

  keys(): string[] {
    return Object.keys(this.schema.shape);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.schema.shape, key);
  }

  /** A key's help: its schema's description. */
  help(key: string): string | undefined {
    return (this.schema.shape[key] as z.ZodType | undefined)?.description;
  }

  /** A value for `key`, from text or a value, or why not. */
  parse(key: string, raw: unknown): { value: SettingValue } | { error: string } {
    const field = this.schema.shape[key] as z.ZodType | undefined;
    if (field === undefined) return { error: `no setting ${key} in ${this.plugin}` };
    const result = field.safeParse(raw);
    if (result.success) return { value: result.data as SettingValue };
    return { error: result.error.issues[0]?.message ?? `${key}: not a value` };
  }

  /** Keeps the owner's value. */
  keep(key: string, value: SettingValue): void {
    this.values[key] = value;
    this.store.put(SETTINGS_DOC, { ...this.values });
  }

  /** The owner's values, as kept. */
  kept(): Record<string, SettingValue> {
    return { ...this.values };
  }
}

/** Every plugin's settings, for the control surfaces. */
export class SettingsRegistry {
  private readonly plugins: PluginSettings[] = [];
  private backend: SettingsBackend | undefined;
  /** The plugins that put their own settings in force, by id. */
  private readonly own = new Map<string, SettingsBackend>();
  private readonly changed: (plugin: string, key: string) => void;

  /** `changed` hears every setting the owner sets, once it is in force. */
  constructor(changed: (plugin: string, key: string) => void = () => {}) {
    this.changed = changed;
  }

  add(settings: PluginSettings): void {
    this.plugins.push(settings);
  }

  /** The settings of one plugin. */
  of(plugin: string): PluginSettings | undefined {
    return this.plugins.find((p) => p.plugin === plugin);
  }

  /** Where settings are put in force and read: given by the wiring once the app exists. */
  serve(backend: SettingsBackend): void {
    this.backend = backend;
  }

  /**
   * Where one plugin's settings are put in force and read: the plugin's own instance, in place of
   * the wiring's backend.
   */
  serveFor(
    plugin: string,
    backend: {
      apply(key: string, value: SettingValue): void;
      read(key: string): SettingValue | undefined;
    }
  ): void {
    this.own.set(plugin, {
      apply: (_plugin, key, value) => backend.apply(key, value),
      read: (_plugin, key) => backend.read(key),
    });
  }

  /** Puts every kept setting in force, plugin by plugin. */
  putInForce(): void {
    for (const p of this.plugins)
      for (const [key, value] of Object.entries(p.kept()))
        this.backendOf(p.plugin)?.apply(p.plugin, key, value);
  }

  private backendOf(plugin: string): SettingsBackend | undefined {
    return this.own.get(plugin) ?? this.backend;
  }

  /** Every key, as the surfaces name it: bare, or `plugin.key` when two plugins share it. */
  keys(): string[] {
    return this.plugins.flatMap((p) => p.keys().map((k) => this.nameOf(p, k)));
  }

  /** The plugin and the key a name stands for, or why none. */
  resolve(name: string): { settings: PluginSettings; key: string } | { error: string } {
    const dot = name.indexOf('.');
    if (dot > 0) {
      const settings = this.of(name.slice(0, dot));
      const key = name.slice(dot + 1);
      if (settings?.has(key) === true) return { settings, key };
    }
    const owners = this.plugins.filter((p) => p.has(name));
    const [only] = owners;
    if (owners.length === 1 && only !== undefined) return { settings: only, key: name };
    if (owners.length > 1)
      return {
        error: `${name} is a setting of ${owners.map((o) => o.plugin).join(' and ')}: name it plugin.${name}`,
      };
    return { error: `no setting ${name}: ${this.keys().join(', ')}` };
  }

  /** Sets one setting, kept and put in force; why not, or undefined. */
  set(name: string, raw: unknown): string | undefined {
    const found = this.resolve(name);
    if ('error' in found) return found.error;
    const parsed = found.settings.parse(found.key, raw);
    if ('error' in parsed) return parsed.error;
    found.settings.keep(found.key, parsed.value);
    this.backendOf(found.settings.plugin)?.apply(found.settings.plugin, found.key, parsed.value);
    this.changed(found.settings.plugin, found.key);
    return undefined;
  }

  /** Every setting with the value in force now, by the surfaces' names. */
  current(): Record<string, SettingValue | undefined> {
    const out: Record<string, SettingValue | undefined> = {};
    for (const p of this.plugins)
      for (const key of p.keys())
        out[this.nameOf(p, key)] = this.backendOf(p.plugin)?.read(p.plugin, key);
    return out;
  }

  /** The owner's settings, as kept, by the surfaces' names. */
  kept(): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const p of this.plugins)
      for (const [key, value] of Object.entries(p.kept())) out[this.nameOf(p, key)] = value;
    return out;
  }

  /** Which plugin has a bare key, if one does. */
  owner(key: string): string | undefined {
    const owners = this.plugins.filter((p) => p.has(key));
    return owners.length === 1 ? owners[0]?.plugin : undefined;
  }

  private nameOf(p: PluginSettings, key: string): string {
    return this.plugins.filter((x) => x.has(key)).length > 1 ? `${p.plugin}.${key}` : key;
  }
}

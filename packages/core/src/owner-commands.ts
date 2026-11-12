/**
 * The core's own chat commands (docs/bot-os-api.md §4.11, P11): the owner's controls that belong
 * to no plugin, answered by the chat surface as the plugins' are, to the owner only.
 *
 * - `/plugins`: the instance (on or off) and each plugin, its state (bot-os.md D64), with a button
 *   to turn the instance off or on and one for each plugin; `/plugins <id>` (a plugin's card): its
 *   state and why, settings, reads and actions, and, while it runs, the one action that changes a
 *   node's state here: **Stop** (`/plugins <id> stop`), its own safety stop then the core's stop,
 *   kept until the owner clears it in the editor. Nothing here starts a node again.
 * - `/kill`: the kill switch (`Controls.kill`), answered in a new message under a tapped notice.
 * - `/settings`: every setting, by plugin, with the value in force and a switch for each that is on
 *   or off; `/set <key> <value>` (or a tap's `set:<key>:<value>`) changes one.
 * - In no menu, a card's buttons: `plugins:<id>:stop`, `off`, `on`.
 *
 * Every card may end with a way back to the owner's main card (`home`, the wiring's). Nothing in
 * here knows of any game or any network.
 */
import { type Answer, type Buttons, type ChatCommand, type CommandButton } from './commands.ts';
import { type Controls, type PluginControl, STOPPED } from './controls.ts';
import { type SettingsRegistry, type SettingValue } from './settings.ts';

/** The names of the core's commands, which no plugin's may take. */
export const CORE_COMMANDS = ['plugins', 'kill', 'settings', 'set', 'off', 'on'];

/** A switch as the cards show it: 🟢 on, 🔴 off, ⚪ unknown. */
export const lamp = (v: unknown): string => (v === true ? '🟢' : v === false ? '🔴' : '⚪');

/** A plugin's state as the cards show it. */
const STATE_LAMP: Record<string, string> = {
  running: '🟢',
  stopped: '⛔',
  failed: '🔴',
  disabled: '⚫',
  inactive: '💤',
};

/** A setting's value as the cards show it. */
export function showValue(value: SettingValue | undefined): string {
  if (value === undefined) return '?';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.join(', ') || 'none';
  return String(value);
}

/** A card: its text and buttons. */
interface Card {
  text: string;
  buttons: CommandButton[][];
}

/** Text with why a change was refused above it. */
const withRefusal = (card: Card, refused: string | undefined): Card =>
  refused === undefined ? card : { ...card, text: `Refused: ${refused}\n${card.text}` };

/** `key value` as typed, or `key:value` as a tap carries it. */
function keyValue(args: string): [string, string] {
  const t = args.trim();
  const space = /^(\S+)\s+(.*)$/su.exec(t);
  if (space !== null) return [space[1] ?? '', space[2] ?? ''];
  const colon = t.indexOf(':');
  return colon < 0 ? [t, ''] : [t.slice(0, colon), t.slice(colon + 1)];
}

export interface CoreCommandsOptions {
  controls: Controls;
  settings: SettingsRegistry;
  /** The way back to the owner's main card, at the foot of every card here. */
  home?: CommandButton;
}

/** The core's commands, as the chat surface lists them (`core.commands()`). */
export function coreCommands(o: CoreCommandsOptions): ChatCommand[] {
  const { controls, settings } = o;
  const foot: CommandButton[][] = o.home === undefined ? [] : [[o.home]];

  const pluginsCard = (): Card => {
    const s = controls.status();
    const line = (p: PluginControl): string =>
      `${STATE_LAMP[p.state] ?? '⚪'} ${p.id}: ${p.state}${p.reason === undefined ? '' : ` (${p.reason})`}`;
    const buttons: CommandButton[][] = [
      [
        s.off
          ? { label: '🟢 Turn the bot on', action: 'on' }
          : { label: '🔴 Turn the bot off', action: 'off' },
      ],
    ];
    const ids = s.plugins.map((p) => p.id);
    for (let i = 0; i < ids.length; i += 2)
      buttons.push(ids.slice(i, i + 2).map((id) => ({ label: id, action: `plugins:${id}` })));
    return {
      text: [
        `The bot is ${s.off ? 'off' : 'on'}. Its plugins, with their states:`,
        ...s.plugins.map(line),
      ].join('\n'),
      buttons: [...buttons, ...foot],
    };
  };

  const pluginCard = (id: string): Card | undefined => {
    const p = controls.status().plugins.find((x) => x.id === id);
    if (p === undefined) return undefined;
    const text = [
      `${STATE_LAMP[p.state] ?? '⚪'} ${p.id}: ${p.description}`,
      `State: ${p.state}${p.reason === undefined ? '' : ` (${p.reason})`}`,
      ...(p.stop === undefined
        ? []
        : [`Stopped at ${p.stop.time.slice(0, 16).replace('T', ' ')} UTC (${p.stop.source})`]),
      ...(p.state === 'stopped' || p.state === 'disabled' || p.state === 'inactive'
        ? ['Started again only from the editor, then Apply.']
        : []),
      ...Object.entries(p.settings).map(([k, v]) => `${k}: ${showValue(v)}`),
      ...(p.reads.length === 0 ? [] : [`Reads: ${p.reads.join(', ')}`]),
      ...(p.actions.length === 0 ? [] : [`Actions: ${p.actions.join(', ')}`]),
    ].join('\n');
    const buttons: CommandButton[][] = [];
    if (p.state === 'running') buttons.push([{ label: '⛔ Stop', action: `plugins:${p.id}:stop` }]);
    buttons.push([{ label: '← Plugins', action: 'plugins' }]);
    return { text, buttons: [...buttons, ...foot] };
  };

  const settingsCard = (): Card => {
    const current = settings.current();
    const groups = new Map<string, string[]>();
    for (const name of settings.keys()) {
      const found = settings.resolve(name);
      const plugin = 'error' in found ? 'core' : found.settings.plugin;
      groups.set(plugin, [...(groups.get(plugin) ?? []), name]);
    }
    const text = [
      'The settings (/set <key> <value>), by plugin:',
      ...[...groups].flatMap(([plugin, names]) => [
        `${plugin}:`,
        ...names.map((n) => `  ${n}: ${showValue(current[n])}`),
      ]),
    ].join('\n');
    const switches = settings
      .keys()
      .filter((n) => typeof current[n] === 'boolean')
      .map((n) => ({
        label: `${lamp(current[n])} ${n}`,
        action: `set:${n}:${current[n] === true ? 'off' : 'on'}`,
      }));
    const buttons: CommandButton[][] = [];
    for (let i = 0; i < switches.length; i += 2) buttons.push(switches.slice(i, i + 2));
    return { text, buttons: [...buttons, ...foot] };
  };

  const show = (answer: Answer, card: Card, refused?: string): Promise<void> => {
    const c = withRefusal(card, refused);
    return answer.text(c.text, undefined, { buttons: c.buttons as Buttons });
  };

  const command = (
    name: string,
    help: string,
    run: ChatCommand['run'],
    extra: { args?: string; hidden?: boolean } = {}
  ): ChatCommand => ({
    plugin: 'core',
    name,
    help,
    aliases: [],
    owner: true,
    hidden: extra.hidden ?? false,
    ...(extra.args === undefined ? {} : { args: extra.args }),
    run,
  });

  return [
    command(
      'plugins',
      'The plugins: each one’s state, and the off switch',
      (answer, { args }) => {
        const [id, what] = keyValue(args);
        if (what === 'stop') {
          const r = controls.killNode(id, STOPPED);
          return show(answer, pluginCard(id) ?? pluginsCard(), 'error' in r ? r.error : undefined);
        }
        const card = id === '' ? pluginsCard() : pluginCard(id);
        return card === undefined
          ? show(answer, pluginsCard(), `no plugin ${id}`)
          : show(answer, card);
      },
      { args: '[plugin] [stop]' }
    ),
    command('kill', 'Kill switch: everything off, and no command sent', async (answer) => {
      if (controls.off) {
        await answer.text(`The bot is off: \`cli.ts on\` first`, undefined, { keep: true });
        return;
      }
      const k = controls.kill();
      await answer.text(k.text, undefined, { buttons: k.buttons, keep: true });
    }),
    command('settings', 'Every setting, with its switch', (answer) => show(answer, settingsCard())),
    command(
      'set',
      'Change a setting: /set iceReserve 2',
      (answer, { args }) => {
        const [key, value] = keyValue(args);
        const refused = settings.set(key, value);
        return show(answer, settingsCard(), refused);
      },
      { args: '<key> <value>' }
    ),
    command(
      'off',
      'The off switch: nothing sent, reviewed or told until on',
      (answer) => {
        const said = controls.turnOff();
        return show(answer, pluginsCard(), said === 'off' ? undefined : said);
      },
      { hidden: true }
    ),
    command(
      'on',
      'The bot back on',
      (answer) => {
        const said = controls.turnOn();
        const card = pluginsCard();
        return answer.text(`${said}\n${card.text}`, undefined, { buttons: card.buttons });
      },
      { hidden: true }
    ),
  ];
}

/** A ZNC login for the IRC connector's tests: invented, as all test data is. */
import { type IrcClientOptions } from '#src/transport/irc-client.ts';

export const IRC_OPTIONS: IrcClientOptions = {
  host: 'znc',
  port: 6501,
  tls: false,
  zncUser: 'alice',
  zncNetwork: 'ExampleNet',
  password: 'secret',
  nick: 'alice',
  channel: '#lobby',
};

/** The `irc` plugin's configuration, as the core hands it over. */
export const IRC_CONFIG = {
  host: 'znc',
  port: 6501,
  tls: false,
  zncUser: 'alice',
  zncNetwork: 'ExampleNet',
  nick: 'alice',
  channel: '#lobby',
  minIntervalS: 3,
  maxPerHour: 60,
};

/** The `irc` plugin's secret. */
export const IRC_SECRETS = { znc_password: 'secret-znc-password' };

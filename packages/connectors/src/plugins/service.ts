/**
 * The connector of a service connector: its plugin holds an account's secrets and makes an object
 * from them for the wiring (`Instance.service`, such as an API client), but has no chat of its own,
 * so the connector reads nothing and sends nothing.
 */
import { type Connector, ConnectorBase } from '@megabottron1999/core';

export class ServiceConnector extends ConnectorBase implements Connector {
  constructor(account: string, network: string) {
    super(account, network);
    this.changed({ state: 'connected', phase: 'service' });
  }

  send(): boolean {
    return false;
  }
}

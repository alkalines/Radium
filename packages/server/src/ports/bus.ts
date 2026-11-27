/** Receives one published message. Listeners must not throw; a throw is logged and skipped. */
export type BusListener = (message: string) => void;

/**
 * Process-wide publish/subscribe over Valkey channels, used to wake local subscribers (live log,
 * job runner, socket lifecycle). Delivery is at-most-once and only to processes connected at
 * publish time: durable data travels through Postgres or the live log, never through the bus.
 */
export interface Bus {
  publish(channel: string, message: string): Promise<void>;
  /**
   * Resolves once Valkey confirmed the subscription, so a publish issued afterwards is delivered.
   * Returns the function that removes this listener.
   */
  subscribe(channel: string, listener: BusListener): Promise<() => Promise<void>>;
}

/**
 * The runtime adapter: one publishing connection plus one dedicated subscriber connection.
 * `subscribe` is called once per channel while it has local listeners, `unsubscribe` when the last
 * one leaves.
 */
export interface PubSubConnection {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, deliver: BusListener): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
}

interface ChannelEntry {
  listeners: Set<BusListener>;
  subscribed: Promise<unknown>;
}

/** Multiplexes any number of local listeners onto one Valkey subscription per channel. */
export function createBus(connection: PubSubConnection): Bus {
  const channels = new Map<string, ChannelEntry>();

  function release(channel: string, entry: ChannelEntry, listener: BusListener) {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0 || channels.get(channel) !== entry) return;

    channels.delete(channel);
    // A re-subscribe issued meanwhile is ordered after this UNSUBSCRIBE on the same connection.
    return connection.unsubscribe(channel);
  }

  return {
    async publish(channel, message) {
      await connection.publish(channel, message);
    },

    async subscribe(channel, listener) {
      let entry = channels.get(channel);
      if (!entry) {
        const listeners = new Set<BusListener>();
        const deliver = (message: string) => {
          for (const each of listeners) {
            try {
              each(message);
            } catch (error) {
              console.error(`[bus] listener for ${channel} threw`, error);
            }
          }
        };
        entry = { listeners, subscribed: connection.subscribe(channel, deliver) };
        channels.set(channel, entry);
      }

      const current = entry;
      current.listeners.add(listener);
      try {
        await current.subscribed;
      } catch (error) {
        await release(channel, current, listener);
        throw error;
      }

      let active = true;
      return async () => {
        if (!active) return;
        active = false;
        await release(channel, current, listener);
      };
    },
  };
}

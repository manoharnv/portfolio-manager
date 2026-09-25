import { BrokerSessionSchema, type Config } from '@pm/core';
import * as logger from 'firebase-functions/logger';

import { sessionNeededPush } from '../catalogue.js';
import { sendToUser } from '../notify.js';
import type { Db, Messaging } from '../ports.js';

export interface SessionReminderResult {
  notifiedCount: number;
}

async function isActiveBrokerConnected(
  db: Db,
  uid: string,
  activeBroker: Config['activeBroker'],
): Promise<boolean> {
  const raw = await db.getDoc<unknown>(`brokerSessions/${uid}/brokers/${activeBroker}`);
  if (raw === undefined) {
    return false; // no session doc at all for today ⇒ never connected
  }

  const parsed = BrokerSessionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error(
      'sessionReminder: brokerSession doc failed schema validation, treating as disconnected',
      {
        uid,
        broker: activeBroker,
      },
    );
    return false;
  }

  return parsed.data.connected;
}

/**
 * docs/06 §6.5 "Session needed", scheduled 08:45 IST weekdays (index.ts). For
 * every user, pushes iff their *active* broker's session is not connected —
 * a connected session on a broker that is not currently active does not count.
 */
export async function sessionReminder(deps: {
  db: Db;
  messaging: Messaging;
}): Promise<SessionReminderResult> {
  const configs = await deps.db.queryCollection<Config>('config', []);
  let notifiedCount = 0;

  for (const doc of configs) {
    const connected = await isActiveBrokerConnected(deps.db, doc.data.uid, doc.data.activeBroker);
    if (connected) {
      continue;
    }

    const result = await sendToUser(deps, doc.data.uid, sessionNeededPush());
    if (result.sent > 0) {
      notifiedCount += 1;
    }
  }

  return { notifiedCount };
}

/**
 * File names of the cached instrument masters — the contract between the
 * execution backend, which downloads and writes them (`INSTRUMENTS_CACHE_DIR`),
 * and the strategy engine, which reads them (`PM_INSTRUMENTS_DIR`) and picks
 * the one for whichever broker its credentials name (docs/11 §11.4 #8, #9).
 */

import type { Broker } from './domain.js';

export const INSTRUMENT_MASTER_FILE: Readonly<Record<Broker, string>> = {
  dhan: 'dhan-scrip-master.csv',
  kite: 'kite-instruments.csv',
};

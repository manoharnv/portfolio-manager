/**
 * Ambient-capability ports. docs/00 §0.5: nothing outside the composition root
 * reads the wall clock or invents an id, so every tick is reproducible.
 */

export interface Clock {
  now(): Date;
}

export interface IdGen {
  /** Stable, collision-free document id. Tests inject a counter. */
  next(prefix: string): string;
}

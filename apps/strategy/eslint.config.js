// The strategy engine's hard boundary, enforced by lint (docs/05 §5.1).
//
// This process WRITES PROPOSALS ONLY. It may hold a `BrokerReadAdapter` and
// nothing else: no full-adapter factory, no registration call that would grant
// the process order capability, and no `placeOrder` / `modifyOrder` /
// `cancelOrder` member access anywhere in `src/`.
//
// Three independent mechanisms enforce this — types (`BrokerReadAdapter` only),
// these lint rules, and `src/policy.test.ts`, which greps every source file.
import base from '../../eslint.config.js';

/** Factory/registration functions that would grant order capability. */
const FORBIDDEN_FACTORIES = [
  'createAdapter',
  'registerAdapter',
  'createDhanAdapter',
  'createKiteAdapter',
  'registerDhanAdapter',
  'registerKiteAdapter',
];

/** Types whose surface includes order placement. */
const FORBIDDEN_TYPES = ['BrokerAdapter', 'AdapterFactory'];

const BOUNDARY =
  'The strategy engine writes proposals only (docs/05 §5.1): it may never import ' +
  'or reference anything that can place, modify or cancel an order. Use ' +
  'createReadAdapter / createDhanReadAdapter / createKiteReadAdapter and BrokerReadAdapter.';

export default [
  ...base,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pm/core',
              importNames: [...FORBIDDEN_FACTORIES, ...FORBIDDEN_TYPES],
              message: BOUNDARY,
            },
            {
              name: '@pm/broker-dhan',
              importNames: [...FORBIDDEN_FACTORIES, ...FORBIDDEN_TYPES, 'DhanAdapter'],
              message: BOUNDARY,
            },
            {
              name: '@pm/broker-kite',
              importNames: [...FORBIDDEN_FACTORIES, ...FORBIDDEN_TYPES, 'KiteAdapter'],
              message: BOUNDARY,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^(placeOrder|modifyOrder|cancelOrder)$/]',
          message: BOUNDARY,
        },
        {
          selector:
            'Identifier[name=/^(createAdapter|registerAdapter|createDhanAdapter|createKiteAdapter|registerDhanAdapter|registerKiteAdapter)$/]',
          message: BOUNDARY,
        },
      ],
    },
  },
];

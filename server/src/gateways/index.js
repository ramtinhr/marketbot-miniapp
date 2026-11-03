import { Kaino, KainoGateway } from '../kaino.js';
import { FakeGateway } from './fake.js';
import { PaymentIntentsGateway } from './payment-intents.js';

// Each adapter implements name, configured, request(), and verify().
// Add providers here; checkout and wallet accounting stay provider-independent.
const factories = {
  fake: (_config, { production }) => {
    if (production) throw new Error('PAYMENT_PROVIDER=fake is not allowed with NODE_ENV=production');
    return new FakeGateway();
  },
  kaino: ({ kaino }, { production, log }) => new KainoGateway(new Kaino({ ...kaino, allowHttp: !production, log })),
  payment_intents: ({ paymentIntents }) => new PaymentIntentsGateway(paymentIntents),
};

export function createGateway(config, options = {}) {
  const factory = Object.hasOwn(factories, config.provider) && factories[config.provider];
  if (!factory) throw new Error(`unknown PAYMENT_PROVIDER "${config.provider}" - use ${Object.keys(factories).join(', ')}`);
  return factory(config, options);
}

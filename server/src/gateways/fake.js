/** A stand-in gateway served by this app itself (see the routes), for demos. Never in production. */
export class FakeGateway {
  constructor() {
    this.name = 'fake';
  }

  get configured() {
    return true;
  }

  async request({ authority }) {
    // Relative: the app opens it against its own origin.
    return { ref: authority, url: `/api/v1/payments/fake/${authority}` };
  }

  async verify({ authority, params }) {
    if (params.Status !== 'OK') return { paid: false, cancelled: true, reason: 'cancelled on the demo gateway' };
    return { paid: true, refId: authority.slice(3, 13), cardPan: '603799******1234' };
  }
}


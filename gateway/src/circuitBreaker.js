// Circuit breaker: stops sending requests to a service that keeps failing.
//
// Think of the fuse box at home. Too many failures and the breaker "trips".
//
//   CLOSED     normal. Requests go through. Failures are counted.
//   OPEN       the service failed too many times in a row. Requests are rejected
//              immediately (no waiting, no load on the broken service).
//   HALF_OPEN  after resetTimeoutMs we let ONE test request through.
//              It works -> CLOSED again. It fails -> OPEN again.

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5; // failures in a row before opening
    this.resetTimeoutMs = options.resetTimeoutMs || 10000; // how long to stay OPEN
    this.now = options.now || (() => Date.now()); // replaceable clock, makes testing easy
    this.onChange = options.onChange || (() => {}); // called when the state changes (for logs)

    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
  }

  setState(next) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onChange(this.name, from, next);
  }

  // Ask this BEFORE calling the service. false = do not call it.
  canRequest() {
    if (this.state === 'CLOSED') return true;

    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.resetTimeoutMs) {
        this.setState('HALF_OPEN'); // time is up: allow one test request
        return true;
      }
      return false;
    }

    return false; // HALF_OPEN: the test request is already running, everyone else waits
  }

  recordSuccess() {
    if (this.state === 'OPEN') return; // a late answer from before the breaker opened: ignore
    this.failures = 0;
    this.setState('CLOSED');
  }

  recordFailure() {
    if (this.state === 'OPEN') return;
    if (this.state === 'HALF_OPEN') {
      this.open(); // the test request failed
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.open();
  }

  open() {
    this.openedAt = this.now();
    this.failures = 0;
    this.setState('OPEN');
  }

  // How long a client should wait before trying again
  retryAfterSeconds() {
    const left = this.openedAt + this.resetTimeoutMs - this.now();
    return Math.max(1, Math.ceil(left / 1000));
  }
}

module.exports = CircuitBreaker;

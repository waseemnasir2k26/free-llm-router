"use strict";

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Continuous-refill token bucket (used for RPM and TPM). */
class TokenBucket {
  constructor(capacity, windowMs, now) {
    this.capacity = capacity;
    this.perMs = capacity / windowMs;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }
  _refill() {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + (t - this.last) * this.perMs,
      );
    }
    this.last = t;
  }
  available() {
    this._refill();
    return this.tokens;
  }
  canTake(n) {
    return this.available() >= n;
  }
  take(n) {
    this._refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
  waitMs(n) {
    this._refill();
    if (this.tokens >= n) return 0;
    return Math.ceil((n - this.tokens) / this.perMs);
  }
}

/** Requests-per-day counter that resets at 00:00 UTC. Persistable. */
class DailyCounter {
  constructor(limit, now) {
    this.limit = limit;
    this.now = now;
    this.day = utcDay(now());
    this.count = 0;
  }
  _roll() {
    const d = utcDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
    }
  }
  canTake(n = 1) {
    this._roll();
    return this.count + n <= this.limit;
  }
  take(n = 1) {
    this._roll();
    if (this.count + n > this.limit) return false;
    this.count += n;
    return true;
  }
  remaining() {
    this._roll();
    return Math.max(0, this.limit - this.count);
  }
  /** ms until the next UTC midnight. */
  waitMs() {
    const t = this.now();
    const next = Date.parse(utcDay(t) + "T00:00:00Z") + 86400000;
    return next - t;
  }
  toJSON() {
    return { day: this.day, count: this.count };
  }
  load(saved) {
    if (saved && saved.day === this.day && Number.isFinite(saved.count))
      this.count = saved.count;
  }
}

module.exports = { TokenBucket, DailyCounter, utcDay };

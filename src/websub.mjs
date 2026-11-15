import { createHmac, timingSafeEqual } from 'node:crypto';

export function signature(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifySignature(body, header, secret) {
  const expected = Buffer.from(signature(body, secret));
  const actual = Buffer.from(header || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function subscribe(topic, callback, leaseSeconds = 86400) {
  return { topic, callback, leaseSeconds, verified: false };
}

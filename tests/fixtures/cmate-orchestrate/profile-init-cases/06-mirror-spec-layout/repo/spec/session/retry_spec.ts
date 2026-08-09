import { retry } from '../../src/session/retry';

it('retries', () => {
  if (retry(2) !== 2) throw new Error('bad');
});

import { retry } from '../../src/session/retry';

test('retry echoes its bound', () => {
  if (retry(3) !== 3) throw new Error('bad');
});

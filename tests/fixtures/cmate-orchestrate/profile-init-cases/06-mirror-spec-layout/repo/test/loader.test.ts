import { load } from '../src/loader';

it('loads', () => {
  if (load('a') !== 'a') throw new Error('bad');
});

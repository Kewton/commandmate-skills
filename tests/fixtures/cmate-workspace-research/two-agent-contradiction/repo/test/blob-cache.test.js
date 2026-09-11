'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Keep the test hermetic: stub the native binding and the encoder.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'pkg-x/native') {
    return { open: () => ({ read: () => Buffer.from('v') }) };
  }
  if (request === 'pkg-y') {
    return { encode: (key) => key };
  }
  return originalLoad.call(this, request, ...rest);
};

const { openCache } = require('../src/storage/blob-cache');

test('openCache reads through the native handle', () => {
  assert.strictEqual(openCache('/tmp/x').get('k'), 'v');
});

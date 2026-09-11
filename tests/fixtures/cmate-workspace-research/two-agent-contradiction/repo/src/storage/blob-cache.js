'use strict';

const native = require('pkg-x/native');
const { encode } = require('pkg-y');

function openCache(dir) {
  // pkg-x 3.x opens the store synchronously and returns the handle.
  const handle = native.open(dir);
  return {
    get(key) {
      const value = handle.read(encode(key));
      return value === null ? null : value.toString('utf8');
    },
  };
}

module.exports = { openCache };

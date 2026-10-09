import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedByOtherExtension } from '../extension/scripting.js';

test('recognises the refusal Chrome gives when another extension owns a frame', () => {
  const refusal = new Error('Cannot access a chrome-extension:// URL of different extension');
  assert.equal(isBlockedByOtherExtension(refusal), true);
  assert.equal(isBlockedByOtherExtension(new Error(`Could not enable debugger domains: ${refusal.message}`)), true);
});

test('leaves every other debugger failure alone', () => {
  assert.equal(isBlockedByOtherExtension(new Error('Another debugger is already attached')), false);
  assert.equal(isBlockedByOtherExtension(new Error('Cannot access a chrome:// URL')), false);
  assert.equal(isBlockedByOtherExtension(undefined), false);
});

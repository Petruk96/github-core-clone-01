import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeServer } from '../server-lifecycle.ts';

test('closeServer waits for the server close callback before resolving', async () => {
  let finishClose;
  let closed = false;
  const closing = closeServer({
    close(callback) {
      finishClose = (error) => {
        closed = true;
        callback(error);
      };
    },
  });
  let settled = false;
  closing.then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(settled, false);

  finishClose();
  await closing;
  assert.equal(closed, true);
  assert.equal(settled, true);
});

test('closeServer propagates a server close error', async () => {
  const error = new Error('close failed');
  await assert.rejects(closeServer({ close(callback) { callback(error); } }), error);
});

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// unmount + wipe the jsdom document between tests so renders don't accumulate
afterEach(cleanup);

// jsdom implements no layout, so Element.prototype.scrollIntoView does not
// exist. TurnChat calls it from a setTimeout that outlives the test, so the
// miss surfaces as an unhandled error after the run rather than a failed
// assertion — 167 green tests and a non-zero exit.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// unmount + wipe the jsdom document between tests so renders don't accumulate
afterEach(cleanup);

// Set the product boundary before importing the runtime graph. A few dormant
// playground catalogs intentionally prefetch in the full app; the dog product
// uses this marker to keep those module-level network side effects inert.
globalThis.__DREAMFALL_PRODUCT__ = 'dog-park';

import('./dog-bootstrap.jsx')
  .then(({ bootDogProduct }) => bootDogProduct())
  .catch((err) => {
    console.error('[dog-park] boot failed:', err);
  });

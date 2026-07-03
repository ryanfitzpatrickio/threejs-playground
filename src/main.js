import { bootDreamfall } from './bootstrap.jsx';

bootDreamfall().catch((err) => {
  console.error('[dreamfall] boot failed:', err);
});

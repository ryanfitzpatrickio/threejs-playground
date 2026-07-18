import { bootDogProduct } from './dog-bootstrap.jsx';

bootDogProduct().catch((err) => {
  console.error('[dog-park] boot failed:', err);
});

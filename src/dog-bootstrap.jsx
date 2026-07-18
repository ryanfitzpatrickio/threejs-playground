import { render } from 'solid-js/web';
import { DogProductApp } from './ui/DogProductApp.jsx';
// DogSimCanvas chrome (cut-test-shell / horde-viewer-shell / dog-sim-*) lives in the
// monolithic playground stylesheet — see docs/dog-park-standalone-deploy-plan.md K-none,
// §4.2 CSS note. Dual maintenance accepted until a dedicated dog-sim.css extract lands.
import './styles/base.css';

export async function bootDogProduct({ rootId = 'app' } = {}) {
  const root = document.getElementById(rootId);

  if (!root) {
    throw new Error(`Dog product mount node #${rootId} was not found.`);
  }

  render(() => <DogProductApp />, root);
}

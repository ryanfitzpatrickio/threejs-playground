import { DogSimCanvas } from './components/DogSimCanvas.jsx';

/**
 * Standalone dog product shell (docs/dog-park-standalone-deploy-plan.md).
 * Phase S (studio): the only screen is the procedural dog viewer — no
 * MainMenu, no App.jsx, no GameRuntime import. Phase P (outdoor park) adds a
 * `dog-park` levelMode branch here once the loader contract (plan §4.3.1
 * L1-L9) is green; until then this graph must stay studio-only so Phase S
 * verify (`verify-dog-bundle`) can assert GameRuntime never enters the bundle.
 */
export function DogProductApp() {
  return <DogSimCanvas />;
}

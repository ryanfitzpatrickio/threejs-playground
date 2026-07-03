import { render } from 'solid-js/web';
import { App } from './ui/App.jsx';
import { initFileStore } from './store/fileStore.js';
import './styles/base.css';

export async function bootDreamfall({ rootId = 'app' } = {}) {
  const root = document.getElementById(rootId);

  if (!root) {
    throw new Error(`Dreamfall mount node #${rootId} was not found.`);
  }

  root.textContent = 'Loading library…';
  await initFileStore();
  root.textContent = '';

  render(() => <App />, root);
}

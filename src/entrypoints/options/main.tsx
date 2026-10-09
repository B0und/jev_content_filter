import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../popup/App';

document.documentElement.classList.add('workspace-page');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App workspace />
  </StrictMode>,
);

// Owned by: integrator
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { createController } from './controller';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
const controller = createController();
createRoot(root).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);

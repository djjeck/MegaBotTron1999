// The app's entry point, Vite's (index.html): mounts the app. Glue, left out of coverage; the app
// is tested in App.test.tsx.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

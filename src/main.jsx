import React from 'react';
import { createRoot } from 'react-dom/client';
import PsycheDeep from './PsycheDeep.jsx';
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <main className="app-shell">
      <PsycheDeep />
    </main>
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}


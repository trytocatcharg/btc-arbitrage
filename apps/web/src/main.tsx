import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tailwind.css';
import { Dashboard } from './features/dashboard/Dashboard.js';

console.log('BTC Arbitrage web app starting');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);

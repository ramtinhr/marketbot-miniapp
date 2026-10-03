import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { webApp } from './telegram';
import './styles.css';

const tg = webApp();
if (tg) {
    tg.ready();
    tg.expand();
    document.documentElement.dataset.scheme = tg.colorScheme;
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);

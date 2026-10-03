import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { setUpChrome, webApp } from './telegram';
import './styles.css';

const tg = webApp();
if (tg) setUpChrome(tg);

function render() {
    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <App />
        </StrictMode>,
    );
}

if (import.meta.env.DEV && new URLSearchParams(location.search).has('preview')) {
    void import('./preview').then((m) => {
        m.installPreview();
        render();
    });
} else {
    render();
}

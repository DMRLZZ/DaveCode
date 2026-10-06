import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <main>DaveCode dashboard</main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import React, { ReactDOM } from './react.js';
import App from './App.jsx';
import { startAppHeight } from './lib/appHeight.js';
import './styles.css';

// Before the first render: the shell reads --app-height, and starting this
// afterwards would show one frame at whatever 100dvh came out to.
startAppHeight();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

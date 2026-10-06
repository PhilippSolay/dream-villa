// Entry point so `node --test harvest/test` works on Node 22, which resolves a directory
// argument to its index.js (Node 20 scans the directory instead and runs every file here,
// so the suites simply run twice there). `node --test harvest/test/*.test.js` works on both.
import './harvester.test.js';
import './bin.test.js';

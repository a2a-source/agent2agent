import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/config', { recursive: true });
mkdirSync('dist/contracts', { recursive: true });
cpSync('config/default.json', 'dist/config/default.json');
cpSync('contracts/A2A.sol', 'dist/contracts/A2A.sol');

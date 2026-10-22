import { register } from 'node:module';
import { loadEnv } from './env.mjs';

loadEnv();
register('./hooks.mjs', import.meta.url);

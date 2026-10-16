// The page: its styles, the old engine (dsp.js) as a classic script (the page also starts it as a Worker from that
// text), the Svelte parts (the splash, a song's progress, where songs are analysed), then the page's script
// (legacy.js: the print, the player and the Lab, still to be moved into components).
import './app.scss';
import dsp from '../dsp.js?raw';
import {mount} from 'svelte';
import Splash from './Splash.svelte';
import Progress from './Progress.svelte';
import Where from './Where.svelte';
import {start} from './legacy.js';

const s = document.createElement('script');
s.id = 'dsp';
s.textContent = dsp;
document.body.append(s);

mount(Splash, {target: document.querySelector('main.app')});
mount(Progress, {target: document.getElementById('plate')});
mount(Where, {target: document.getElementById('where-lab'), props: {id: 'where-lab'}});
start();

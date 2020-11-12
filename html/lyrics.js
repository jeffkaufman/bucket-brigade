import { start_hooks, stop_hooks, event_hooks, declare_event, init_events } from './app.js';
import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';


let lyrics = "Hands chip the |flint, light the |fire, skin the |kill\n|Feet move the |tribe track the |herd with a |will \nHuman-|kind |struggles, on the |edge of histo |ry\n|Time to settle |down, time to |grow, time to |bree|eed..\n|Plow tills the |soil, plants the |seed, pray for |rain\n|Scythe reaps the | wheat, to the |mill, to grind the |grain\n|Towns.. and.. |cities spread to |empire over-|night\n|Hands keep |building as we |chant the ancient |rite...".split('|');

let button = document.getElementById('lyricButton');
let holder = document.getElementById('lyricHolder');
let dbgbox = document.getElementById('lyricDbg');
let ctrlCb = document.getElementById('lyricCtrlCb');
let spans = {}
let lyricsCur = 0;

function dbg(txt) {
    let div = document.createElement('div');    
    div.innerText = txt
    dbgbox.appendChild(div);
}

document.lyric_dbg_cb = dbg;

function addSpan(lid, txt) {
    let span = document.createElement('span');
    span.innerText = txt;
    span.className = 'lyrics';
    holder.appendChild(span);
    spans[lid] = span;
}

start_hooks.push( ()=>{
    holder.innerHTML = '';
    spans = {};
    let aos = document.getElementById('audioOffset').value;
    let ctrl = ctrlCb.checked;
    if (ctrl) {
        button.style.display = 'block';
        lyricsCur = 0;
        init_events();
    } else {
        button.style.display = 'none';
        for (let i=-Math.floor(Math.min(aos,10)); i<0; i++) {
            addSpan(i, (-i)+'...'+(i==-1?'\n':''));
        }
    }
    for (let i=0; i<lyrics.length; i++) {
        addSpan(i,lyrics[i]);
    }
});

stop_hooks.push( ()=>{
        button.style.display = 'none';
});

button.addEventListener("mousedown", ()=>{
    console.log('mousedown');
    spans[lyricsCur].className = 'lyrics clicked';
    declare_event(lyricsCur);
    if (lyricsCur == 0) {
        for (let i=1; i<=10; i++) {
            declare_event(lyricsCur-i,i);
        }
    }
    lyricsCur++;
});

event_hooks.push( (lid)=>{
    lib.log(LOG_INFO, "event hook invoked "+lid);
    if (spans[lid]) {
        spans[lid].className='lyrics heard';
        lib.log(LOG_INFO, "colored span "+lid);
    } else {
        lib.log(LOG_INFO, "no span "+lid);
    }
});

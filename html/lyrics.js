let lyrics = "Hands chip the |flint, light the |fire, skin the |kill\n|Feet move the |tribe track the |herd with a |will \nHuman-|kind |struggles, on the |edge of histo |ry\n|Time to settle |down, time to |grow, time to |bree|eed..\n|Plow tills the |soil, plants the |seed, pray for |rain\n|Scythe reaps the | wheat, to the |mill, to grind the |grain\n|Towns.. and.. |cities spread to |empire over-|night\n|Hands keep |building as we |chant the ancient |rite...".split('|');

let button = document.getElementById('lyricButton');
let holder = document.getElementById('lyricHolder');
let dbgbox = document.getElementById('lyricDbg');
let spans = {}
let lyricsCur = 0;
let eventsToSend = [];

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

document.lyricsStartHook = ()=>{
    holder.innerHTML = '';
    spans = {};
    let aos = document.getElementById('audioOffset').value;
    if (aos == 0) {
        button.style.display = 'block';
        lyricsCur = 0;
        eventsToSend = [];
    } else {
        button.style.display = 'none';
        for (let i=-Math.floor(aos); i<0; i++) {
            addSpan(i, (-i)+'...'+(i==-1?'\n':''));
        }
    }
    for (let i=0; i<lyrics.length; i++) {
        addSpan(i,lyrics[i]);
    }
}

document.lyricsStopHook = ()=>{
        button.style.display = 'none';
}

button.addEventListener("mousedown", ()=>{
    console.log('mousedown');
    spans[lyricsCur].className = 'lyrics clicked';
    eventsToSend.push({lid:lyricsCur, t:Date.now()});
    lyricsCur += 1;
});

document.lyricsSendHook = (clock, sample_rate)=>{
    for (let ev of eventsToSend) {
        ev.t -= Date.now(); // delta in ms
        ev.t /= 1000; // delta in s
        ev.t *= sample_rate; // delta in samples
        ev.t += clock; // tick
    }
    let out = JSON.stringify(eventsToSend);
    //dbg("sent: "+out)
    eventsToSend = [];
    return out;
};

document.lyricsRecHook = (lid)=>{
    //dbg("rechook: "+lid);
    if (spans[lid]) {
        spans[lid].className='lyrics heard';
    }
};

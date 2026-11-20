'use strict';
// Development only. Node is NOT required on the user's Mac.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../core.js');
const pilot = require('../examples/french-five.json');
const clone = x => JSON.parse(JSON.stringify(x));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function snapshot() {
    const metadata = {};
    Object.entries(core.fields).forEach(([k,t]) => metadata[k] = t === 'string' ? '' : t === 'number' ? 0 : false);
    metadata.name = 'Mandalorian'; metadata.artist = 'Kaaris';
    return {metadata, path: '/music/one.mp3', sha256: 'a'.repeat(64), artwork_count: 0, duration: 209.711};
}
function plan() {
    return {version:1,kind:'music-mvp-plan',created_at:'2026-11-20',library_id:'1111111111111111',tracks:[{
        id:'2222222222222222',before:snapshot(),set:{genre:'French Hip-Hop',album:'2.7.0',year:2020,trackNumber:2,trackCount:20},artwork:null,sources:[]
    }]};
}
function mock(p, options={}) {
    let state = Object.fromEntries(p.tracks.map(t=>[t.id,clone(t.before)]));
    const calls = {writes:[],backups:[],logs:[],art:0};
    const io = {
        libraryID:()=>options.otherLibrary ? '3333333333333333' : p.library_id,
        snapshot:id=>clone(state[id]),
        checkArtwork:a=>{if(options.badArtwork) throw Error('asset changed');},
        record:log=>{calls.logs.push(clone(log));},
        backup:(path,index,hash)=>{calls.backups.push(path);if(options.backupFail)throw Error('disk full');return '/backup/'+index;},
        writeField:(id,k,v)=>{calls.writes.push([id,k,v]);if(options.failWrite===k) throw Error('write error');if(!options.ignoreWrite)state[id].metadata[k]=v;},
        readField:(id,k)=>state[id].metadata[k],
        addArtwork:(id,a)=>{calls.art++;state[id].artwork_count++;},
        verifyFile:(path,values,art)=>({ok:!options.badFile,fields:values})
    };
    return {io,calls,state};
}
test('pilot has five real IDs, custom genre and bounded request',()=>{
    core.validateRequest(pilot);assert.equal(pilot.tracks.length,5);assert.equal(pilot.defaults.genre,'French Hip-Hop');
});
test('custom genre overrides generic genre, individual override wins defaults',()=>{
    const b=snapshot().metadata;b.genre='Hip-Hop/Rap';b.composer='User credit';
    const t={id:'2222222222222222',expect:{name:b.name,artist:b.artist},fill:{composer:'Other'},set:{}};
    assert.deepEqual(core.changes(t,b,{genre:'French Hip-Hop'}),{genre:'French Hip-Hop'});
    t.set.genre='Russian-German Hip-Hop';assert.equal(core.changes(t,b,{genre:'French Hip-Hop'}).genre,'Russian-German Hip-Hop');
});
test('unchanged values produce empty patch',()=>{
    const b=snapshot().metadata;b.genre='French Hip-Hop';
    assert.deepEqual(core.changes({id:'2222222222222222',expect:{name:b.name,artist:b.artist},set:{}},b,{genre:b.genre}),{});
});
test('artist/title identity mismatch rejects request',()=>{
    assert.throws(()=>core.changes({id:'2222222222222222',expect:{name:'Different',artist:'Kaaris'},set:{}},snapshot().metadata,{}),/Identity/);
});
test('unsupported producer is rejected rather than put into composer',()=>{
    const r=clone(pilot);r.tracks[0].set.producer='Someone';assert.throws(()=>core.validateRequest(r),/unsupported field/);
});
test('duplicate IDs, prototype keys, invalid numbers and unknown options fail',()=>{
    const r=clone(pilot);r.tracks.push(r.tracks[0]);assert.throws(()=>core.validateRequest(r),/Duplicate/);
    const a=clone(pilot);a.tracks[0].set.year='2020';assert.throws(()=>core.validateRequest(a),/type/);
    const b=clone(pilot);b.tracks[0].set.trackNumber=-1;assert.throws(()=>core.validateRequest(b),/number/);
    const c=clone(pilot);c.defaults=JSON.parse('{"__proto__":{"polluted":true}}');assert.throws(()=>core.validateRequest(c),/unsupported/);
});
test('numbering checked against existing track totals',()=>{
    const b=snapshot().metadata;b.trackCount=10;
    assert.throws(()=>core.changes({id:'2222222222222222',expect:{name:b.name,artist:b.artist},set:{trackNumber:12}},b,{}),/exceeds/);
});
test('preview contains explicit diff without IO',()=>assert.match(core.preview(plan()),/Hip-Hop/));
test('successful execution backs up before writes and verifies file',()=>{
    const p=plan(),m=mock(p);const log=core.execute(p,m.io);
    assert.equal(log.status,'complete');assert.equal(m.calls.backups.length,1);assert.equal(log.tracks[0].file_verification.ok,true);
    assert.equal(m.calls.logs[0].tracks.length,0);assert.ok(m.calls.logs.some(l=>l.tracks[0]?.steps[0]?.status==='attempting'));
});
test('all tracks preflight before any Music write',()=>{
    const p=plan(),b=clone(p.tracks[0]);b.id='4444444444444444';b.before.path='/music/two.mp3';p.tracks.push(b);
    const m=mock(p);m.state[b.id].metadata.album='Already changed';
    assert.throws(()=>core.execute(p,m.io),/Stale/);assert.equal(m.calls.writes.length,0);assert.equal(m.calls.backups.length,0);
});
test('changed audio file checksum blocks apply',()=>{
    const p=plan(),m=mock(p);m.state[p.tracks[0].id].sha256='b'.repeat(64);
    assert.throws(()=>core.execute(p,m.io),/Stale/);assert.equal(m.calls.writes.length,0);
});
test('wrong Music library blocks apply',()=>{
    const p=plan(),m=mock(p,{otherLibrary:true});assert.throws(()=>core.execute(p,m.io),/Another/);assert.equal(m.calls.writes.length,0);
});
test('shared audio file is rejected to prevent two entries overwriting it',()=>{
    const p=plan(),b=clone(p.tracks[0]);b.id='4444444444444444';p.tracks.push(b);assert.throws(()=>core.validatePlan(p),/same file/);
});
test('backup failure prevents all writes and records failure',()=>{
    const p=plan(),m=mock(p,{backupFail:true});assert.throws(()=>core.execute(p,m.io),/disk full/);
    assert.equal(m.calls.writes.length,0);assert.equal(m.calls.logs.at(-1).status,'failed');
});
test('silently ignored Music write is detected',()=>{
    const p=plan(),m=mock(p,{ignoreWrite:true});assert.throws(()=>core.execute(p,m.io),/retain/);assert.equal(m.calls.logs.at(-1).status,'failed');
});
test('partial write failure retains actual attempted steps in journal',()=>{
    const p=plan(),m=mock(p,{failWrite:'album'});assert.throws(()=>core.execute(p,m.io),/write error/);
    const log=m.calls.logs.at(-1);assert.equal(log.status,'failed');assert.equal(log.tracks[0].steps.at(-1).status,'attempting');
    assert.equal(m.state[p.tracks[0].id].metadata.genre,'French Hip-Hop');
});
test('Music-only success is insufficient when file tags are not verified',()=>{
    const p=plan(),m=mock(p,{badFile:true});assert.throws(()=>core.execute(p,m.io),/File verification/);assert.equal(m.calls.logs.at(-1).status,'failed');
});
test('missing art can be added; existing art cannot be overwritten',()=>{
    const p=plan();p.tracks[0].artwork={path:'/cover.jpg',sha256:'b'.repeat(64),format:'jpg',source_url:'https://example.test/cover',catalog_id:1};
    const m=mock(p);assert.equal(core.execute(p,m.io).status,'complete');assert.equal(m.calls.art,1);
    p.tracks[0].before.artwork_count=1;assert.throws(()=>core.validatePlan(p),/only adds missing/);
});
test('artwork checksum failure stops before mutation',()=>{
    const p=plan();p.tracks[0].artwork={path:'/cover.png',sha256:'b'.repeat(64),format:'png',source_url:'https://example.test/cover',catalog_id:1};
    const m=mock(p,{badArtwork:true});assert.throws(()=>core.execute(p,m.io),/asset changed/);assert.equal(m.calls.writes.length,0);
});
test('unsupported files and malformed plans rejected',()=>{
    const p=plan();p.tracks[0].before.path='/music/protected.m4p';assert.throws(()=>core.validatePlan(p),/MP3/);
    const q=plan();delete q.tracks[0].before.metadata.genre;assert.throws(()=>core.validatePlan(q),/Incomplete/);
});
test('complete five-track simulated pilot',()=>{
    const p=plan();p.tracks=pilot.tracks.map((t,i)=>{const before=snapshot();before.path='/music/'+i+'.mp3';before.metadata.name=t.expect.name;before.metadata.artist=t.expect.artist;
        return {id:t.id,before,set:core.changes(t,before.metadata,pilot.defaults),artwork:null,sources:t.sources};});
    const m=mock(p);const log=core.execute(p,m.io);assert.equal(log.tracks.length,5);assert.equal(log.status,'complete');
    fs.writeFileSync(__dirname+'/pilot-simulation.json',JSON.stringify({kind:'simulation-only',uses_real_music:false,status:log.status,tracks:log.tracks.map(t=>({id:t.id,genre:t.after.metadata.genre,album:t.after.metadata.album,status:t.status}))},null,2)+'\n');
});
console.log('\n'+passed+' tests passed. No macOS/Music calls were made.');

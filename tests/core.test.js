'use strict';
// Development only. Node is NOT required on the user's Mac.
const assert = require('node:assert/strict');
const core = require('../core.js');
const pilot = {version:1,defaults:{genre:'Custom Genre'},tracks:Array.from({length:5},(_,i)=>({id:String(i+1).padStart(16,'0'),expect:{name:'Example '+i,artist:'Example Artist'},set:{album:'Example Album',year:2024}}))};
const clone = x => JSON.parse(JSON.stringify(x));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function snapshot() {
    const metadata = {};
    Object.entries(core.fields).forEach(([k,t]) => metadata[k] = t === 'string' ? '' : t === 'number' ? 0 : false);
    metadata.name = 'Example Song'; metadata.artist = 'Example Artist';
    return {metadata, path: '/music/one.mp3', sha256: 'a'.repeat(64), artwork_count: 0, file_artwork_present: false, duration: 209.711};
}
function plan() {
    return {version:1,kind:'music-tags-plan',created_at:'2026-11-20',library_id:'1111111111111111',tracks:[{
        id:'2222222222222222',before:snapshot(),set:{genre:'Custom Genre',album:'Example Album',year:2020,trackNumber:2,trackCount:20},artwork:null,sources:[]
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
test('sample request has five IDs and a custom genre',()=>{
    core.validateRequest(pilot);assert.equal(pilot.tracks.length,5);assert.equal(pilot.defaults.genre,'Custom Genre');
});
test('custom genre overrides generic genre, individual override wins defaults',()=>{
    const b=snapshot().metadata;b.genre='Hip-Hop/Rap';b.composer='User credit';
    const t={id:'2222222222222222',expect:{name:b.name,artist:b.artist},fill:{composer:'Other'},set:{}};
    assert.deepEqual(core.changes(t,b,{genre:'Custom Genre'}),{genre:'Custom Genre'});
    t.set.genre='Another Genre';assert.equal(core.changes(t,b,{genre:'Custom Genre'}).genre,'Another Genre');
});
test('unchanged values produce empty patch',()=>{
    const b=snapshot().metadata;b.genre='Custom Genre';
    assert.deepEqual(core.changes({id:'2222222222222222',expect:{name:b.name,artist:b.artist},set:{}},b,{genre:b.genre}),{});
});
test('artist/title identity mismatch rejects request',()=>{
    assert.throws(()=>core.changes({id:'2222222222222222',expect:{name:'Different',artist:'Example Artist'},set:{}},snapshot().metadata,{}),/Identity/);
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
test('preview contains explicit diff without IO',()=>assert.match(core.preview(plan()),/Custom Genre/));
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
    assert.equal(m.state[p.tracks[0].id].metadata.genre,'Custom Genre');
});
test('Music-only success is insufficient when file tags are not verified',()=>{
    const p=plan(),m=mock(p,{badFile:true});assert.throws(()=>core.execute(p,m.io),/File verification/);assert.equal(m.calls.logs.at(-1).status,'failed');
});
test('missing art can be added; existing art cannot be overwritten',()=>{
    const p=plan();p.tracks[0].artwork={path:'/cover.jpg',sha256:'b'.repeat(64),format:'jpg',source_url:'https://example.test/cover',policy:'embed_missing'};
    const m=mock(p);assert.equal(core.execute(p,m.io).status,'complete');assert.equal(m.calls.art,1);
    p.tracks[0].before.artwork_count=1;p.tracks[0].before.file_artwork_present=true;assert.throws(()=>core.validatePlan(p),/Embedded artwork|Only missing/);
});
test('artwork checksum failure stops before mutation',()=>{
    const p=plan();p.tracks[0].artwork={path:'/cover.png',sha256:'b'.repeat(64),format:'png',source_url:'https://example.test/cover',policy:'embed_missing'};
    const m=mock(p,{badArtwork:true});assert.throws(()=>core.execute(p,m.io),/asset changed/);assert.equal(m.calls.writes.length,0);
});
test('unsupported files and malformed plans rejected',()=>{
    const p=plan();p.tracks[0].before.path='/music/protected.m4p';assert.throws(()=>core.validatePlan(p),/MP3/);
    const q=plan();delete q.tracks[0].before.metadata.genre;assert.throws(()=>core.validatePlan(q),/Incomplete/);
});
test('canonical Unicode variants identify the same track',()=>{
    const b=snapshot().metadata;b.artist='Café Artist';
    assert.doesNotThrow(()=>core.changes({id:'2222222222222222',expect:{name:b.name,artist:b.artist.normalize('NFD')},set:{}},b,{}));
});
test('repeated preparation accepts an already completed requested rename',()=>{
    const b=snapshot().metadata;b.name='Corrected title';b.artist='Corrected artist';
    const t={id:'2222222222222222',expect:{name:'Old title',artist:'Original artist'},set:{name:b.name,artist:b.artist}};
    assert.deepEqual(core.changes(t,b,{}),{});
});
test('cached Music cover can be embedded when file has none',()=>{
    const p=plan();p.tracks[0].before.artwork_count=1;p.tracks[0].before.file_artwork_present=false;
    p.tracks[0].artwork={path:'/cover.jpg',sha256:'b'.repeat(64),format:'jpg',source_url:'https://example.test/cover',policy:'embed_missing'};
    const m=mock(p);m.io.addArtwork=(id,a)=>{m.calls.art++;m.state[id].file_artwork_present=true;};
    assert.equal(core.execute(p,m.io).status,'complete');assert.equal(m.calls.art,1);
});
test('embedding refuses to overwrite an existing file cover or multiple Music pictures',()=>{
    const p=plan();p.tracks[0].before.file_artwork_present=true;
    p.tracks[0].artwork={path:'/cover.jpg',sha256:'b'.repeat(64),format:'jpg',source_url:'https://example.test/cover',policy:'embed_missing'};
    assert.throws(()=>core.validatePlan(p),/already exists/);
    p.tracks[0].before.file_artwork_present=false;p.tracks[0].before.artwork_count=2;
    assert.throws(()=>core.validatePlan(p),/multiple/);
});
test('optional local artwork metadata is validated',()=>{
    const r=clone(pilot);r.tracks[0].artwork_file={path:'covers/x.jpg',sha256:'bad',format:'jpg',album:'Example Album',source_url:'https://example.test'};
    assert.throws(()=>core.validateRequest(r),/Invalid local/);
    r.tracks[0].artwork_file.sha256='b'.repeat(64);core.validateRequest(r);
});
test('embedded artwork state participates in stale-plan check',()=>{
    const p=plan();p.tracks[0].before.file_artwork_present=false;
    const m=mock(p);m.state[p.tracks[0].id].file_artwork_present=true;
    assert.throws(()=>core.execute(p,m.io),/Stale/);assert.equal(m.calls.writes.length,0);
});
test('complete five-track simulated pilot',()=>{
    const p=plan();p.tracks=pilot.tracks.map((t,i)=>{const before=snapshot();before.path='/music/'+i+'.mp3';before.metadata.name=t.expect.name;before.metadata.artist=t.expect.artist;
        return {id:t.id,before,set:core.changes(t,before.metadata,pilot.defaults),artwork:null,sources:t.sources};});
    const m=mock(p);const log=core.execute(p,m.io);assert.equal(log.tracks.length,5);assert.equal(log.status,'complete');

});
test('requests and plans accept one group larger than twenty tracks',()=>{
    const r=clone(pilot);r.tracks=Array.from({length:46},(_,i)=>({id:(i+1).toString(16).padStart(16,'0'),expect:{name:'Song '+i,artist:'Artist'}}));core.validateRequest(r);
    const p=plan();p.tracks=r.tracks.map((t,i)=>({...clone(p.tracks[0]),id:t.id,before:{...snapshot(),path:'/music/'+i+'.mp3'}}));core.validatePlan(p);
});
test('lyrics preserve line breaks and normalize BOM/CRLF',()=>{
    assert.equal(core.lyricsText('\ufeffFirst line\r\nSecond line\r\n'),'First line\nSecond line');
    const b=snapshot().metadata;
    const t={id:'2222222222222222',expect:{name:b.name,artist:b.artist},fill:{lyrics:'First\nSecond'}};
    assert.equal(core.changes(t,b,{}).lyrics,'First\nSecond');
    b.lyrics='Existing text';assert.deepEqual(core.changes(t,b,{}),{});
    t.set={lyrics:'Corrected text'};assert.equal(core.changes(t,b,{}).lyrics,'Corrected text');
});
test('HTML, binary, empty and oversized lyrics are rejected',()=>{
    for(const value of ['','   ','<!DOCTYPE html><html>Example</html>','A\u0000B','x'.repeat(100001)])assert.throws(()=>core.lyricsText(value));
});
test('lyrics sources are mutually exclusive and use HTTPS for URLs',()=>{
    const r=clone(pilot),t=r.tracks[0];t.lyrics_file='words.txt';t.lyrics_url='https://example.test/words.txt';assert.throws(()=>core.validateRequest(r),/one lyrics/);
    delete t.lyrics_file;t.lyrics_url='http://example.test/words.txt';assert.throws(()=>core.validateRequest(r),/HTTPS/);
    t.lyrics_url='https://example.test/words.txt';t.set.lyrics='inline';assert.throws(()=>core.validateRequest(r),/cannot be combined/);
    delete t.set.lyrics;t.lyrics_policy='replace';core.validateRequest(r);
});
test('inline lyrics use the same backup, write and file verification path',()=>{
    const p=plan();p.tracks[0].set={lyrics:'First\nSecond'};
    const m=mock(p);const log=core.execute(p,m.io);assert.equal(log.status,'complete');assert.equal(log.tracks[0].after.metadata.lyrics,'First\nSecond');
});
test('blank existing artist can be explicitly identified and corrected',()=>{
    const r=clone(pilot),t=r.tracks[0];t.expect.artist='';t.set.artist='Correct Artist';core.validateRequest(r);
    const b=snapshot().metadata;b.name=t.expect.name;b.artist='';assert.equal(core.changes(t,b,r.defaults).artist,'Correct Artist');
});
test('corrected global artist is accepted on a repeated preparation',()=>{
    const b=snapshot().metadata;b.artist='New Artist';
    const t={id:'2222222222222222',expect:{name:b.name,artist:'Old Artist'},set:{}};
    assert.deepEqual(core.changes(t,b,{artist:'New Artist'}),{});
});
console.log('\n'+passed+' core tests passed. No Music calls were made.');

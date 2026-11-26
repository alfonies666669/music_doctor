'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../core');
const sha='a'.repeat(64);
const request=()=>({version:2,tracks:[{path:'/music/song.mp3',sha256:sha,tags:{name:'Song',compilation:false},artwork:false,lyrics:null,music_ids:['1111111111111111']}]});
const actual={tags:{name:'Song',genre:'Rap',compilation:false,trackNumber:2,trackCount:12},has:{name:true,genre:true,compilation:true,composer:false,albumArtist:null,trackNumber:true,trackCount:true}};
test('v2 request validates nullable tags and false compilation without modifying data',()=>{
    const r=request();r.tracks[0].tags.album=null;
    const before=JSON.stringify(r);assert.equal(core.request(r),r);assert.equal(JSON.stringify(r),before);
    assert.equal(core.id('abcdef1234567890'),'ABCDEF1234567890');
});
test('unknown fields, control characters, empty values and invalid numbers fail',()=>{
    for(const tags of [{producer:'Someone'},{name:''},{artist:['Good','']},{genre:'Bad\nvalue'},{year:0},{year:2024.5},{compilation:1}]) {
        const r=request();r.tracks[0].tags=tags;assert.throws(()=>core.request(r));
    }
    const r=request();r.unrecognized=true;assert.throws(()=>core.request(r),/Unknown request/);
});
test('paths, hashes, duplicate files and duplicate case-insensitive Music IDs are validated',()=>{
    const r=request();r.tracks.push({...r.tracks[0]});assert.throws(()=>core.request(r),/Repeated file/);
    for(const update of [{path:'relative.mp3'},{sha256:'invalid'},{music_ids:['ABCDEF1234567890','abcdef1234567890']},{music_ids:['invalid']}]) {
        const input=request();Object.assign(input.tracks[0],update);assert.throws(()=>core.request(input));
    }
});
test('artwork and lyrics accept paths or presence; conflicting sources fail',()=>{
    for(const state of [true,false,null,'covers/one.jpg']) {
        const r=request();r.tracks[0].artwork=state;assert.doesNotThrow(()=>core.request(r));
    }
    const r=request();r.tracks[0].artwork_file='different.jpg';r.tracks[0].artwork='one.jpg';
    assert.throws(()=>core.request(r),/Conflicting/);
    delete r.tracks[0].artwork_file;r.tracks[0].lyrics='words.txt';r.tracks[0].lyrics_url='https://example.test/words.txt';
    assert.throws(()=>core.request(r),/single HTTPS/);
});
test('effective goals honor tag/default/fill priority and leave suggestions untouched',()=>{
    const row={tags:{genre:'Custom',name:null},fill:{composer:'Writer',genre:'Ignored'},music_suggestions:{album:'Unreviewed'}};
    assert.deepEqual(core.effective(row,{genre:'Default'},actual,false),{composer:'Writer',genre:'Custom'});
    assert.deepEqual(core.effective({tags:{genre:'Rap',compilation:false}},null,actual,false),{});
    assert.deepEqual(core.effective({tags:{genre:'Rap',compilation:false}},null,actual,true),{genre:'Rap',compilation:false});
    assert.throws(()=>core.effective({tags:{albumArtist:'Writer'}},null,actual,false),/ambiguous/);
    assert.throws(()=>core.effective({tags:{trackNumber:13}},null,actual,false),/exceeds/);
});
test('lyrics normalize line endings and reject HTML, binary and empty content',()=>{
    assert.equal(core.lyricsText('\ufeffFirst\r\nSecond\r\n'),'First\nSecond');
    for(const value of ['', '  ', '<html>words</html>', 'a\0b', 'x'.repeat(100001)]) assert.throws(()=>core.lyricsText(value));
});
test('plans freeze validated targets and reject duplicate physical files',()=>{
    const p={version:2,kind:'music-tags-file-plan',created_at:new Date().toISOString(),force:false,
        tracks:[{path:'/music/song.mp3',sha256:sha,identity:'1:2',before:{name:'Old'},tags:{name:'New'},
            artwork:{path:'/run/cover.jpg',sha256:sha,size:100}}]};
    assert.match(core.preview(p),/Old.*New/);assert.match(core.preview(p),/artwork:/);
    p.tracks.push({...p.tracks[0],path:'/music/alias.mp3'});assert.throws(()=>core.plan(p),/physical file/);
});
test('read-only v1 compatibility validates and audits without a writer',()=>{
    const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
    const context=vm.createContext({MusicCore:core});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../legacy.js'),'utf8'),context);
    const legacy=context.Legacy;
    const old={version:1,tracks:[{id:'1111111111111111',expect:{name:'Song',artist:'Artist'},set:{album:'Album'}}]};
    assert.equal(legacy.validateRequest(old),old);
    const audit=legacy.auditSnapshot(old);assert.equal(audit.missing.album,0);
    assert.match(legacy.auditPreview(audit),/Music Doctor audit/);
    assert.equal(legacy.execute,undefined);
});

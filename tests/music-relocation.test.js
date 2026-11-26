'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'), helper=path.join(root,'bin/music-tags-file');
const skip=process.platform!=='darwin'||!fs.existsSync(helper);
function run(bin,args) {return spawnSync(bin,args,{encoding:'utf8',maxBuffer:8*1024*1024});}
function ok(bin,args) {const r=run(bin,args);assert.equal(r.status,0,r.error||r.stderr||r.stdout);return r.stdout;}
function json(file,data) {if(data)fs.writeFileSync(file,JSON.stringify(data,null,2));else return JSON.parse(fs.readFileSync(file));}
function sha(file) {return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function fixture(t,mode) {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-relocation-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const runtime=path.join(dir,'runtime'),media=path.join(dir,'media');
    fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(media);
    const old=path.join(media,'Old.mp3'),moved=path.join(media,'organized','Новое название.mp3'),wrong=path.join(media,'wrong.mp3');
    fs.mkdirSync(path.dirname(moved));
    ok('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=500:duration=0.35',
        '-c:a','libmp3lame','-id3v2_version','3','-metadata','title=Old',old]);
    for(const name of ['music-tags','jxa.js','core.js','filters.js','file-commands.js'])
        fs.copyFileSync(path.join(root,name),path.join(runtime,name));
    fs.copyFileSync(helper,path.join(runtime,'bin/music-tags-file'));
    const fake=`function musicIO() {
        var old=${JSON.stringify(old)}, moved=${JSON.stringify(moved)}, wrong=${JSON.stringify(wrong)};
        var mode=${JSON.stringify(mode)}, current=exists(moved) ? moved : old;
        if ((mode==='before' || mode==='missing') && exists(old)) {task('/bin/mv',[old,moved]); current=moved;}
        if (mode==='wrong' && exists(old)) task('/bin/cp',['-p',old,wrong]);
        return {
            filePath:function() {return mode==='wrong' || mode==='missing' ? wrong : current;},
            refreshFile:function() {
                task('/usr/bin/touch',[${JSON.stringify(path.join(dir,'refreshed'))}]);
                if(mode==='during' && exists(old)) {task('/bin/mv',[old,moved]);current=moved;}
            },
            matchesFile:function() {return true;}
        };
    }`;
    const jxa=path.join(runtime,'jxa.js');
    fs.writeFileSync(jxa,fs.readFileSync(jxa,'utf8').replace('function run(argv) {',fake+'\nfunction run(argv) {'));
    if(mode==='early') {
        const coordinator=path.join(runtime,'file-commands.js');
        fs.writeFileSync(coordinator,fs.readFileSync(coordinator,'utf8').replace(
            'entry.file_written=true;',
            "task('/bin/mv',[row.path,"+JSON.stringify(moved)+"]); entry.file_written=true;"));
    }
    const cli=(...args)=>ok(path.join(runtime,'music-tags'),args);
    const request=path.join(dir,'request.json'),plan=path.join(dir,'plan.json');
    cli('snapshot','--folder',media,request);
    const draft=json(request);draft.tracks[0].music_ids=['1111111111111111'];draft.tracks[0].tags={name:'Новое название'};
    json(request,draft);cli('prepare',request,plan);
    return {dir,runtime,old,moved,wrong,plan,cli,before:sha(old)};
}
for(const mode of ['early','before','during']) {
    test('follow the verified file when Music moves it '+mode+' refresh',{skip},t=>{
        const f=fixture(t,mode);
        assert.match(f.cli('apply',f.plan),/Verified: 1/);
        assert.equal(fs.existsSync(f.old),false);
        const entry=json(f.plan+'.journal.json').tracks[0];
        assert.equal(entry.file_written,true);assert.equal(entry.file_status,'verified');
        assert.equal(fs.realpathSync(entry.resolved_path),f.moved);assert.equal(entry.music_status,'refreshed');
        assert.equal(entry.after_sha256,sha(f.moved));
        const st=fs.statSync(f.moved);assert.equal(entry.after_identity,`${st.dev}:${st.ino}`);
        assert.equal(fs.existsSync(entry.backup),false);
        const actual=JSON.parse(f.cli('inspect',f.plan)).tracks[0];
        assert.equal(fs.realpathSync(actual.path),f.moved);assert.equal(actual.tags.name,'Новое название');
        const status=JSON.parse(f.cli('status',f.plan)).tracks[0];
        assert.equal(fs.realpathSync(status.observed_path),f.moved);assert.equal(status.observed_state,'matches_verified_temp');
        assert.match(f.cli('apply',f.plan),/Already complete/);
        // Music can finish a move after the last recorded path check.
        const staleJournal=json(f.plan+'.journal.json');staleJournal.tracks[0].resolved_path=f.old;
        json(f.plan+'.journal.json',staleJournal);
        assert.equal(fs.realpathSync(JSON.parse(f.cli('inspect',f.plan)).tracks[0].path),f.moved);
        assert.equal(fs.realpathSync(JSON.parse(f.cli('status',f.plan)).tracks[0].observed_path),f.moved);
    });
}
test('a Music ID pointing at a byte-identical copy is not refreshed',{skip},t=>{
    const f=fixture(t,'wrong');
    assert.match(f.cli('apply',f.plan),/Verified: 1/);
    const entry=json(f.plan+'.journal.json').tracks[0];
    assert.equal(entry.file_status,'verified');assert.equal(entry.music_status,'unavailable_or_failed');
    assert.match(entry.music_error,/different file/);
    assert.equal(fs.existsSync(path.join(f.dir,'refreshed')),false);
    assert.equal(sha(f.wrong),sha(f.old));
    assert.notEqual(fs.statSync(f.wrong).ino,fs.statSync(f.old).ino);
});
test('unlocatable written files are journaled as written and retain recovery copies',{skip},t=>{
    const f=fixture(t,'missing');
    const result=run(path.join(f.runtime,'music-tags'),['apply',f.plan]);
    assert.notEqual(result.status,0);assert.match(result.stderr,/Cannot verify written file/);
    const entry=json(f.plan+'.journal.json').tracks[0];
    assert.equal(entry.file_written,true);assert.equal(entry.previous_stage,'verified');
    assert.equal(entry.after_sha256,sha(f.moved));assert.equal(sha(entry.backup),f.before);
    assert.equal(fs.existsSync(path.join(f.dir,'refreshed')),false);
});

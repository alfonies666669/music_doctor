'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../scripts/tidy.sh');
function run(command,args,options={}) {const r=spawnSync(command,args,{encoding:'utf8',...options});assert.equal(r.status,0,r.stderr);return r.stdout;}
test('tidy archives staged personal data intact, preserves sources and is repeatable',t=>{
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'music-doctor-tidy-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    fs.writeFileSync(path.join(dir,'music-tags'),'launcher');fs.writeFileSync(path.join(dir,'core.js'),'source');
    fs.writeFileSync(path.join(dir,'.gitignore'),'/runs/\n');
    const bundle=path.join(dir,'music-artwork-apply-20');fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle,'journal.json'),'recovery history');
    run('git',['init','-q',dir]);run('git',['-C',dir,'add','.']);
    run('sh',[script,dir]);
    assert.equal(fs.existsSync(bundle),false);assert.equal(fs.readFileSync(path.join(dir,'core.js'),'utf8'),'source');
    const archive=path.join(dir,'runs/archive');const children=fs.readdirSync(archive);assert.equal(children.length,1);
    assert.equal(fs.readFileSync(path.join(archive,children[0],'music-artwork-apply-20/journal.json'),'utf8'),'recovery history');
    assert.doesNotMatch(run('git',['-C',dir,'ls-files']),/music-artwork-apply/);
    assert.match(run('sh',[script,dir]),/No old experiment/);assert.equal(fs.readdirSync(archive).length,1);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const core=require('../core');
function audit(media) {
    const value={version:2,tracks:[{path:'/music/song.mp3',sha256:'a'.repeat(64),tags:{compilation:false},...media}]};
    const context=vm.createContext({MusicCore:core,absolute:v=>v,textFile:()=>JSON.stringify(value)});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../file-commands.js'),'utf8'),context);
    return JSON.parse(context.FileCommands.run('/tool','audit',['request.json'],core,null)).tracks[0];
}
test('audit counts confirmed presence and supplied assets as present',()=>{
    for(const media of [{artwork:true,lyrics:true},{artwork:'cover.jpg',lyrics:'words.txt'},{has:{artwork:true,lyrics:true}},{artwork:true,lyrics_url:'https://example.test/words.txt'}]) {
        const result=audit(media);assert.ok(!result.missing.includes('artwork'));assert.ok(!result.missing.includes('lyrics'));assert.deepEqual(result.unknown,[]);
        assert.ok(!result.missing.includes('compilation'));
    }
});
test('audit keeps unknown media distinct from missing media',()=>{
    const result=audit({artwork:false,lyrics:null});
    assert.ok(result.missing.includes('artwork'));assert.ok(!result.missing.includes('lyrics'));assert.deepEqual(result.unknown,['lyrics']);
});

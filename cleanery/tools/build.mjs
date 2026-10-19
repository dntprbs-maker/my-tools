import {cp,mkdir,readdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
for(const dir of ['public','tools','tests'])for(const file of await readdir(dir)){if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});}
execFileSync(process.execPath,['--check','server.mjs'],{stdio:'inherit'});
await mkdir('dist',{recursive:true});await cp('public','dist/public',{recursive:true});await cp('server.mjs','dist/server.mjs');await cp('package.json','dist/package.json');
for(const name of ['living','kitchen','bathroom','bedroom']){const data=await readFile(`dist/public/assets/${name}.jpg`);if(data.length<10000)throw new Error('Invalid asset '+name);}
console.log('Production bundle ready: dist/ (node dist/server.mjs)');

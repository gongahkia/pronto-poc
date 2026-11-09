import {mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export async function writeEvalArtifact(path:string,content:string){
 await mkdir(dirname(path),{recursive:true});
 const temporary=`${path}.${randomUUID()}.tmp`;
 try{await writeFile(temporary,content,{mode:0o600});await rename(temporary,path);}
 catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
